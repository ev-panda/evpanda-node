/**
 * Single non-reentrant worker. Self-rescheduling timer (not setInterval) so
 * a slow flush never overlaps the next. Flushes on count ≥ BATCH_CAP or
 * flushInterval, drains, then POSTs via Transport (which owns retry). Also
 * owns bounded shutdown drain. flushOnce() swallows faults — never throws.
 */

import type { BufferedMessage, RingBuffer } from "./buffer.js";
import type { ResolvedConfig } from "./config.js";
import type { Transport } from "./transport.js";
import type { Protocol } from "./types.js";

/** Server batch cap — also the size-based flush trigger. */
export const BATCH_CAP = 1000;

/** Poll granularity for the size trigger (producers don't push). */
const POLL_MS = 200;

export class Worker {
  /** Single-flight: concurrent callers join this one promise. */
  private _inflight: Promise<void> | null = null;
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _stopped = false;
  private _lastFlushAt = 0;

  constructor(
    private readonly _buffer: RingBuffer,
    private readonly _transport: Transport,
    private readonly _config: ResolvedConfig,
  ) {}

  /** Arm the self-rescheduling, unref'd timer. */
  start(): void {
    if (this._stopped) return;
    this._lastFlushAt = Date.now();
    this._schedule();
  }

  /** Single-flight: a concurrent call joins the in-flight flush. */
  flushOnce(): Promise<void> {
    if (this._inflight) return this._inflight;
    const p = this._runFlush().finally(() => {
      if (this._inflight === p) this._inflight = null;
    });
    this._inflight = p;
    return p;
  }

  /** Stop the timer only. No drain — close() owns the final drain. */
  stop(): void {
    this._stopped = true;
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }

  /** One-shot, idempotent: await in-flight, bounded final drain, stop. */
  async close(deadlineMs?: number): Promise<void> {
    if (this._stopped) return;
    this.stop();
    const ms = deadlineMs ?? this._config.drainTimeout;
    const deadline = Date.now() + ms;
    // Cap timer cleared whichever side wins, so a fast drain leaves no
    // pending timer holding the host's event loop open.
    let cap: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<void>((resolve) => {
      cap = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([this._finalDrain(deadline), capped]);
    } finally {
      if (cap !== undefined) clearTimeout(cap);
    }
  }

  // ── internal ──────────────────────────────────────────────────────────

  private _schedule(): void {
    if (this._stopped) return;
    this._timer = setTimeout(() => void this._tick(), POLL_MS);
    this._timer.unref?.();
  }

  private async _tick(): Promise<void> {
    if (!this._stopped && this._shouldFlush()) {
      await this.flushOnce();
    }
    this._schedule(); // re-arm only AFTER the flush settles (non-reentrant)
  }

  private _shouldFlush(): boolean {
    const n = this._buffer.count;
    if (n === 0) return false;
    return (
      n >= BATCH_CAP ||
      Date.now() - this._lastFlushAt >= this._config.flushInterval
    );
  }

  private async _runFlush(): Promise<void> {
    try {
      this._lastFlushAt = Date.now();
      const batch = this._buffer.drain();
      if (batch.length === 0) return;

      const groups = batch.reduce<Map<Protocol, BufferedMessage[]>>((map, env) => {
        const msgs = map.get(env.protocol) ?? [];
        msgs.push(env);
        map.set(env.protocol, msgs);
        return map;
      }, new Map<Protocol, BufferedMessage[]>());

      for (const [protocol, msgs] of groups) {
        for (let i = 0; i < msgs.length; i += BATCH_CAP) {
          // Transport owns retry; the worker calls send once and moves on.
          await this._transport.send(protocol, msgs.slice(i, i + BATCH_CAP));
        }
      }
    } catch {
      // a failed cycle is swallowed — never an unhandledRejection
    }
  }

  private async _finalDrain(deadline: number): Promise<void> {
    if (this._inflight) {
      try {
        await this._inflight;
      } catch {
        // already swallowed in _runFlush
      }
    }
    while (this._buffer.count > 0 && Date.now() < deadline) {
      await this._runFlush();
    }
  }
}
