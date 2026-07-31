/**
 * Single non-reentrant worker: a self-rescheduling timer flushes the buffer
 * on count ≥ BATCH_CAP or `flushInterval`, drains, and POSTs via Transport
 * (which owns retry). Also owns the bounded shutdown drain. Never throws.
 *
 * Worker is also the producer chokepoint — `captureOCPI` / `captureOCPP`
 * delegate to the pure `prepareOCPI` / `prepareOCPP` helpers at the bottom
 * of the file, keeping the validate/cap/redact logic out of the class body.
 */

import {
  validateChargerIdentity,
  validateRoamingIdentity,
} from "./identity.js";

import type { BufferedMessage, RingBuffer } from "./buffer.js";
import type { ResolvedConfig } from "./config.js";
import type { OCPIRedactor } from "./ocpi/redact.js";
import type { OCPPRedactor } from "./ocpp/redact.js";
import type { Transport } from "./transport.js";
import type { OCPIMessage, OCPPMessage } from "./types.js";

/** Server batch cap — also the size-based flush trigger. */
const BATCH_CAP = 1000;

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

  /** Producer entry point for OCPI; see `prepareOCPI`. */
  captureOCPI(msg: OCPIMessage, redact: OCPIRedactor): void {
    const env = prepareOCPI(msg, redact, this._config.maxCaptureBytes);
    if (env !== null) this._buffer.enqueue(env);
  }

  /** Producer entry point for OCPP; see `prepareOCPP`. */
  captureOCPP(msg: OCPPMessage, redact: OCPPRedactor): void {
    const env = prepareOCPP(msg, redact, this._config.maxCaptureBytes);
    if (env !== null) this._buffer.enqueue(env);
  }

  /** Single-flight: a concurrent call joins the in-flight flush. */
  flushOnce(): Promise<void> {
    if (this._inflight) return this._inflight;
    // Safe to null unconditionally: while `p` is pending every caller gets
    // it back, so nothing can install a different promise before this runs.
    const p = this._runFlush().finally(() => {
      this._inflight = null;
    });
    this._inflight = p;
    return p;
  }

  /** One-shot, idempotent: await in-flight, bounded final drain, stop. */
  async close(deadlineMs?: number): Promise<void> {
    if (this._stopped) return;
    this._stop();
    const ms = deadlineMs ?? this._config.drainTimeout;
    // Cap timer cleared whichever side wins, so a fast drain leaves no
    // pending timer holding the host's event loop open.
    let cap: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this._finalDrain(Date.now() + ms),
        new Promise<void>((resolve) => {
          cap = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      clearTimeout(cap);
    }
  }

  // ── internal ──────────────────────────────────────────────────────────

  /** Stop the timer only. No drain — close() owns the final drain. */
  private _stop(): void {
    this._stopped = true;
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }

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
      const batch = this._buffer.flush();

      // A client serves one protocol, so the whole batch goes to one
      // endpoint, chunked at BATCH_CAP.
      const protocol = this._config.protocol;
      for (let i = 0; i < batch.length; i += BATCH_CAP) {
        // Transport owns retry; the worker calls send once and moves on.
        await this._transport.send(protocol, batch.slice(i, i + BATCH_CAP));
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

// ── Producer chokepoints (module-local, not exported) ────────────────────
//
// The one place messages are validated, capped, and redacted before the
// queue. Pure: they return the envelope to enqueue, or null to drop.
// Callers go through `Worker.captureOCPI` / `captureOCPP`.

/**
 * Validate, enforce the body cap, redact. An oversize body on either side
 * drops the whole message — a half-body is broken JSON and would defeat the
 * credentials redactor. Invalid identity ⇒ dropped.
 */
function prepareOCPI(
  msg: OCPIMessage,
  redact: OCPIRedactor,
  maxCaptureBytes: number,
): BufferedMessage | null {
  if (!validateRoamingIdentity(msg.identity)) return null;
  if ((msg.data.requestBody?.length ?? 0) > maxCaptureBytes) return null;
  if ((msg.data.responseBody?.length ?? 0) > maxCaptureBytes) return null;
  return { capturedAt: new Date().toISOString(), message: redact(msg) };
}

/** Validate, enforce the payload cap, redact. */
function prepareOCPP(
  msg: OCPPMessage,
  redact: OCPPRedactor,
  maxCaptureBytes: number,
): BufferedMessage | null {
  if (!validateChargerIdentity(msg.identity)) return null;
  if ((msg.payload?.length ?? 0) > maxCaptureBytes) return null;
  return { capturedAt: new Date().toISOString(), message: redact(msg) };
}
