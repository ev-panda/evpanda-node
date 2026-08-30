/**
 * A byte-bounded, drop-oldest queue.
 *
 * It holds no I/O: `drain` takes the live messages out and resets; the
 * worker does the POST. No lock either — the event loop serializes access,
 * so producers and the worker can never interleave mid-operation.
 *
 * The bound is bytes rather than a slot count because captured messages
 * vary by two orders of magnitude — an OCPP heartbeat is a few hundred
 * bytes, an OCPI CDR batch can be tens of kilobytes. A slot count is a
 * proxy for the thing an operator actually has to provision, and a poor
 * one: the same 10 000 slots is ~3 MiB of OCPP heartbeats or 625 MiB of
 * capped bodies. `maxBufferBytes` is that number directly.
 */

import { sizeOf } from "./types.js";

import type { Counters } from "./stats.js";
import type { Message } from "./types.js";

/**
 * The internal envelope: the SDK-stamped receive time, the message, and its
 * accounted footprint.
 */
export interface BufferedMessage {
  capturedAt: string;
  message: Message;
  /** Filled in by `enqueue`; producers never set it. */
  size: number;
}

/**
 * The current time as a wire timestamp — RFC 3339, UTC, millisecond
 * precision, which is exactly what `Date.toISOString` produces and what the
 * `captured_at` example in the ingestion spec shows.
 */
export function nowISO(): string {
  return new Date().toISOString();
}

export class RingBuffer {
  /** Live messages, oldest first. */
  private _queue: BufferedMessage[] = [];
  private _bytes = 0;
  /** Where the live region starts; the prefix before it has been evicted. */
  private _head = 0;

  constructor(
    private readonly _maxBytes: number,
    /**
     * Counts evictions; eviction is otherwise invisible, and it is the one
     * drop that means data is being lost right now.
     */
    private readonly _counters: Counters,
  ) {
    if (!Number.isInteger(_maxBytes) || _maxBytes < 1) {
      throw new Error(
        "evpanda: buffer byte budget must be a positive integer",
      );
    }
  }

  /**
   * Append a message, evicting the oldest until it fits, and return the
   * resulting message count. It never blocks and never grows past the
   * budget.
   *
   * A message larger than the whole budget is dropped outright rather than
   * emptying the buffer for something that still would not fit. The
   * chokepoint's `maxCaptureBytes` cap makes that unreachable unless the
   * two are misconfigured relative to each other, which config resolution
   * warns about.
   */
  enqueue(envelope: BufferedMessage): number {
    envelope.size = sizeOf(envelope.message);

    if (envelope.size > this._maxBytes) {
      this._counters.countDrop("oversize");
      return this.length;
    }
    while (this._bytes + envelope.size > this._maxBytes) {
      this._evictOldest();
    }
    this._compact();
    this._queue.push(envelope);
    this._bytes += envelope.size;
    this._counters.countCaptured();
    return this.length;
  }

  /**
   * Drop the front message. Only called while the budget is still exceeded,
   * which cannot be true of an empty queue.
   */
  private _evictOldest(): void {
    const evicted = this._queue[this._head];
    if (evicted === undefined) return;
    this._bytes -= evicted.size;
    // Release the reference: a live array slot keeps the whole body alive.
    this._queue[this._head] = undefined as unknown as BufferedMessage;
    this._head++;
    this._counters.countDrop("evicted");
  }

  /**
   * Slide the live messages to the front once the evicted prefix is half
   * the array, so eviction-heavy traffic cannot grow it without bound.
   * `Array.shift` would be O(n) per eviction; this is amortized O(1).
   */
  private _compact(): void {
    if (this._head === 0 || this._head * 2 < this._queue.length) return;
    this._queue = this._queue.slice(this._head);
    this._head = 0;
  }

  /** Remove and return everything buffered, oldest first. */
  drain(): BufferedMessage[] {
    if (this.length === 0) return [];
    const out = this._queue.slice(this._head);
    this._queue = [];
    this._head = 0;
    this._bytes = 0;
    return out;
  }

  /** The number of messages awaiting delivery. */
  get length(): number {
    return this._queue.length - this._head;
  }

  /** Their accounted footprint, always at or below the budget. */
  get byteLength(): number {
    return this._bytes;
  }
}
