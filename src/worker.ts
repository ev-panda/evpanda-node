/**
 * The SDK's only background work.
 *
 * A self-rescheduling unref'd timer flushes on `flushInterval`, and a
 * producer that fills a batch triggers a flush immediately rather than
 * waiting for the next tick. An earlier revision polled every 200 ms
 * because it had no way to signal the timer; it did have one — Node runs
 * the producer and the worker on the same thread, so the producer can just
 * say so. An idle SDK now costs one sleeping timer and zero wakeups.
 *
 * The worker is also the producer chokepoint. `captureOCPI` and
 * `captureOCPP` run the pure `prepareOCPI` / `prepareOCPP` helpers at the
 * bottom of the file, which are the single place a message is validated,
 * capped, owned and redacted before it reaches the queue.
 */

import { nowISO } from "./buffer.js";
import { logLine, subtract, totalDropped } from "./stats.js";
import {
  OCPPEventType,
  isUTF8,
  ownBody,
  validCharger,
  validPlatform,
} from "./types.js";

import type { BufferedMessage, RingBuffer } from "./buffer.js";
import type { ResolvedConfig } from "./config.js";
import type { OCPIRedactor } from "./ocpi/redact.js";
import type { OCPPRedactor } from "./ocpp/redact.js";
import type { Counters, DropReason, Stats } from "./stats.js";
import type { Transport } from "./transport.js";
import type { OCPIMessage, OCPPMessage } from "./types.js";

/**
 * The ingestion API's per-request maximum and, equally, the size-based
 * flush trigger.
 */
export const BATCH_CAP = 1000;

/**
 * Bounds how often the health line can appear. It is a ceiling on log
 * volume, not a sampling rate: the line reports everything that happened in
 * the window, so nothing is hidden by the delay.
 *
 * This is why drops are summarized rather than logged per event. The common
 * integration fault — an adapter that resolves no identity — drops on every
 * single request, so per-event logging would emit at request rate and cost
 * the host real money in log ingestion.
 */
export const REPORT_INTERVAL_MS = 60_000;

export class Worker {
  /** Single-flight: concurrent callers join this one promise. */
  private _inflight: Promise<void> | null = null;
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _report: ReturnType<typeof setInterval> | undefined;
  private _stopped = false;
  private _closed = false;
  private _drained = true;
  /** The snapshot the previous health line reported. */
  private _lastReport: Stats;

  constructor(
    private readonly _buffer: RingBuffer,
    private readonly _transport: Transport,
    private readonly _config: ResolvedConfig,
    private readonly _counters: Counters,
  ) {
    this._lastReport = _counters.snapshot();
  }

  /** Arm the flush timer and the health reporter. Both are unref'd. */
  start(): void {
    if (this._stopped) return;
    this._schedule();
    this._report = setInterval(
      () => this._reportHealth(),
      REPORT_INTERVAL_MS,
    );
    this._report.unref?.();
  }

  // ── Capture ────────────────────────────────────────────────────────────

  /** The producer entry point for OCPI; see `prepareOCPI`. */
  captureOCPI(message: OCPIMessage, redact: OCPIRedactor | undefined): void {
    const [envelope, reason, bodiesDropped] = prepareOCPI(
      message,
      redact,
      this._config.maxCaptureBytes,
    );
    this._counters.countBodiesDropped(bodiesDropped);
    if (envelope === undefined) {
      this._counters.countDrop(reason);
      return;
    }
    this._enqueue(envelope);
  }

  /** The producer entry point for OCPP; see `prepareOCPP`. */
  captureOCPP(message: OCPPMessage, redact: OCPPRedactor | undefined): void {
    const [envelope, reason, bodiesDropped] = prepareOCPP(
      message,
      redact,
      this._config.maxCaptureBytes,
    );
    this._counters.countBodiesDropped(bodiesDropped);
    if (envelope === undefined) {
      this._counters.countDrop(reason);
      return;
    }
    this._enqueue(envelope);
  }

  /**
   * Buffer the envelope and trigger a flush once a full batch is waiting.
   * The flush is scheduled rather than awaited, so a capture call returns
   * without ever touching the network.
   */
  private _enqueue(envelope: BufferedMessage): void {
    if (this._buffer.enqueue(envelope) < BATCH_CAP) return;
    if (this._stopped || this._inflight !== null) return;
    this._clearTimer();
    setImmediate(() => void this._tick());
  }

  // ── Delivery ───────────────────────────────────────────────────────────

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

  /**
   * Stop the timers and drain what is left, bounded by `timeoutMs`.
   * Resolves to whether the drain completed. Idempotent: later calls
   * resolve to the first call's result.
   */
  async close(timeoutMs?: number): Promise<boolean> {
    if (this._closed) return this._drained;
    this._closed = true;
    this._stop();

    const ms = timeoutMs ?? this._config.drainTimeout;
    const deadline = Date.now() + Math.max(0, ms);
    try {
      if (this._inflight) await this._inflight;
      while (this._buffer.length > 0) {
        if (Date.now() >= deadline) break;
        await this._runFlush(deadline);
      }
    } catch {
      /* already swallowed in _runFlush */
    }
    this._drained = this._buffer.length === 0;
    this._reportShutdown(this._drained);
    return this._drained;
  }

  /** A snapshot of the counters plus the live buffer gauges. */
  snapshot(): Stats {
    return this._counters.snapshot(
      this._buffer.length,
      this._buffer.byteLength,
    );
  }

  get config(): ResolvedConfig {
    return this._config;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private _stop(): void {
    this._stopped = true;
    this._clearTimer();
    if (this._report !== undefined) {
      clearInterval(this._report);
      this._report = undefined;
    }
  }

  private _clearTimer(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }

  private _schedule(): void {
    if (this._stopped) return;
    this._timer = setTimeout(
      () => void this._tick(),
      this._config.flushInterval,
    );
    this._timer.unref?.();
  }

  private async _tick(): Promise<void> {
    if (!this._stopped && this._buffer.length > 0) {
      await this.flushOnce();
    }
    if (this._stopped) return;
    // A batch that filled while that flush was in flight raised no trigger
    // of its own — the producer saw one already running and returned. Go
    // holds that token in a one-slot wake channel and Python in an Event
    // that stays set; here the loop re-checks, so a full buffer never waits
    // out the flush interval.
    if (this._buffer.length >= BATCH_CAP) {
      setImmediate(() => void this._tick());
      return;
    }
    // Otherwise re-arm the interval. The worker is never re-entrant, and
    // every flush restarts the interval because the buffer is empty
    // afterwards whatever triggered it.
    this._schedule();
  }

  private async _runFlush(deadline?: number): Promise<void> {
    try {
      const batch = this._buffer.drain();
      if (batch.length === 0) return;
      // A client serves one protocol, so the whole batch goes to one route.
      // The transport owns retry; the worker sends and moves on.
      for (let i = 0; i < batch.length; i += BATCH_CAP) {
        await this._transport.send(
          this._config.protocol,
          batch.slice(i, i + BATCH_CAP),
          deadline,
        );
      }
    } catch {
      /* a failed cycle is swallowed — never an unhandledRejection */
    }
  }

  /**
   * Emit at most one line per report interval, and only when something was
   * dropped in that window. A healthy client is silent.
   */
  private _reportHealth(): void {
    const logger = this._config.logger;
    if (logger === undefined) return;
    const current = this.snapshot();
    const delta = subtract(current, this._lastReport);
    this._lastReport = current;
    if (totalDropped(delta) === 0) return;
    try {
      logger.warn(
        `evpanda: captures dropped window=${REPORT_INTERVAL_MS / 1000}s ${logLine(delta)}`,
      );
    } catch {
      /* a broken host logger is not our failure */
    }
  }

  /**
   * Log the client's lifetime totals as it closes. In debug it always logs;
   * otherwise only when something was dropped or the drain fell short, so a
   * clean run leaves no trace.
   */
  private _reportShutdown(drained: boolean): void {
    const logger = this._config.logger;
    if (logger === undefined) return;
    const total = this.snapshot();
    const lost = totalDropped(total);
    if (lost === 0 && drained && this._config.logMode !== "debug") return;
    const line = `${logLine(total)}${drained ? "" : " drain=incomplete"}`;
    try {
      if (lost === 0 && drained) logger.info(`evpanda: client closed ${line}`);
      else logger.warn(`evpanda: client closed ${line}`);
    } catch {
      /* a broken host logger is not our failure */
    }
  }
}

// ── Producer chokepoints ─────────────────────────────────────────────────
//
// The one place messages are validated, capped, owned and redacted before
// the queue. Pure: they return the envelope to enqueue, or undefined plus
// the reason the drop belongs to. Callers go through Worker.capture*.

type Prepared = readonly [
  BufferedMessage | undefined,
  DropReason,
  /** Bodies omitted because they were not valid UTF-8. */
  number,
];

/**
 * Validate the identity, enforce the body cap, take ownership, redact.
 *
 * An oversize body on either side drops the whole message — half a body is
 * broken JSON, and it would defeat the credentials redactor.
 */
export function prepareOCPI(
  message: OCPIMessage,
  redact: OCPIRedactor | undefined,
  maxCaptureBytes: number,
): Prepared {
  if (!validPlatform(message.platform))
    return [undefined, "invalidIdentity", 0];

  const source = message.data;
  let requestBody = ownBody(source.requestBody);
  let responseBody = ownBody(source.responseBody);
  if ((requestBody?.length ?? 0) > maxCaptureBytes) {
    return [undefined, "oversize", 0];
  }
  if ((responseBody?.length ?? 0) > maxCaptureBytes) {
    return [undefined, "oversize", 0];
  }

  // A body that is not valid UTF-8 cannot travel: the wire contract carries
  // it as text, and shipping it anyway would substitute U+FFFD for the
  // invalid bytes and store corruption. Drop the body, keep the exchange:
  // method, URL, status and headers are still worth having, and the counter
  // says the body went missing on purpose.
  let bodiesDropped = 0;
  if (!isUTF8(requestBody)) {
    requestBody = undefined;
    bodiesDropped++;
  }
  if (!isUTF8(responseBody)) {
    responseBody = undefined;
    bodiesDropped++;
  }

  // Take ownership before redacting. From here the exchange is the SDK's,
  // so the redactor may rewrite it in place, and the host may reuse or
  // mutate what it passed the moment the capture call returns.
  const owned: OCPIMessage = {
    direction: message.direction,
    platform: message.platform,
    data: {
      method: source.method,
      url: source.url,
      statusCode: source.statusCode,
      requestHeaders: { ...source.requestHeaders },
      responseHeaders: { ...source.responseHeaders },
      requestBody,
      responseBody,
    },
  };
  return [
    { capturedAt: nowISO(), message: redact ? redact(owned) : owned, size: 0 },
    "none",
    bodiesDropped,
  ];
}

/**
 * Validate the identity and enforce the frame cap.
 *
 * A message event with no frame or no direction is dropped: the ingestion
 * contract requires both on `event_type` 2.
 */
export function prepareOCPP(
  message: OCPPMessage,
  redact: OCPPRedactor | undefined,
  maxCaptureBytes: number,
): Prepared {
  if (!validCharger(message.charger))
    return [undefined, "invalidIdentity", 0];

  const payload = ownBody(message.payload);
  if ((payload?.length ?? 0) > maxCaptureBytes)
    return [undefined, "oversize", 0];
  if (
    message.eventType === OCPPEventType.Message &&
    (payload === undefined || message.direction === undefined)
  ) {
    return [undefined, "oversize", 0];
  }
  // Unlike an OCPI body, a frame is the whole message: `event_type` 2
  // requires one, so a frame that is not valid UTF-8 takes the message with
  // it. It is counted twice on purpose, once as the body that went missing
  // and once as the message that did.
  if (!isUTF8(payload)) return [undefined, "oversize", 1];

  const owned: OCPPMessage = { ...message, payload };
  // undefined is the normal case for OCPP: there is nothing to redact, so
  // there is no redactor rather than one that does nothing.
  return [
    { capturedAt: nowISO(), message: redact ? redact(owned) : owned, size: 0 },
    "none",
    0,
  ];
}
