/**
 * Fixed-size drop-oldest ring. No lock (Node event loop serializes). No I/O:
 * drain() copies out and resets; the worker does the POST. Internal.
 */

import type { AnyMessage, Protocol } from "./types.js";

/** Internal envelope: SDK-stamped `protocol` + `capturedAt` (receive time). */
export interface BufferedMessage {
  protocol: Protocol;
  capturedAt: string;
  message: AnyMessage;
}

export class RingBuffer {
  private readonly _buf: (BufferedMessage | undefined)[];
  private _head = 0;
  private _count = 0;

  constructor(private readonly _capacity: number) {
    if (!Number.isInteger(_capacity) || _capacity < 1) {
      throw new Error(
        "@evpanda/sdk: RingBuffer capacity must be a positive integer",
      );
    }
    this._buf = new Array<BufferedMessage | undefined>(_capacity);
  }

  /** Drop-oldest when full (advance head; old ref overwritten below). */
  enqueue(envelope: BufferedMessage): void {
    if (this._count === this._capacity) {
      this._head = (this._head + 1) % this._capacity;
    } else {
      this._count++;
    }
    const idx = (this._head + this._count - 1) % this._capacity;
    this._buf[idx] = envelope;
  }

  /** Return live slots oldest→newest; clear refs + reset. */
  drain(): BufferedMessage[] {
    const out: BufferedMessage[] = new Array<BufferedMessage>(this._count);
    for (let i = 0; i < this._count; i++) {
      const idx = (this._head + i) % this._capacity;
      out[i] = this._buf[idx]!; // live by invariant: [head, head+count)
      this._buf[idx] = undefined; // release ref
    }
    this._head = 0;
    this._count = 0;
    return out;
  }

  get count(): number {
    return this._count;
  }
}
