/**
 * Delivery counters.
 *
 * The SDK discards data in five places by design, and four of them are
 * otherwise invisible: a customer whose identity resolution is
 * misconfigured sees no traffic and no explanation. These counters are what
 * make the best-effort trade auditable.
 *
 * They are always on — there is no log mode that turns them off, because an
 * increment nobody reads costs nothing and the alternative is a support
 * conversation that cannot be answered.
 */

/**
 * The single taxonomy of why a message was lost. The capture chokepoint
 * returns one (and only ever uses the first two); the buffer, the transport
 * and the fault guard charge theirs directly.
 */
export type DropReason =
  | "none"
  | "invalidIdentity"
  | "oversize"
  | "evicted"
  | "undeliverable"
  | "fault";

/**
 * A point-in-time snapshot of one client's delivery counters.
 *
 * The `dropped*` fields are monotonic totals since the client started; the
 * `buffer*` fields are instantaneous. Each counter maps to exactly one root
 * cause, which is what makes them worth reading during an integration
 * problem:
 *
 * | Counter | What a high value means |
 * | --- | --- |
 * | `captured` is 0 | the capture path is not wired in |
 * | `droppedInvalid` | identity resolution is failing |
 * | `droppedOversize` | bodies exceed `maxCaptureBytes` |
 * | `droppedEvicted` | upstream can't keep up, or the buffer is undersized |
 * | `droppedUndeliverable` | network, API key, or ingestion fault |
 * | `droppedFault` | a bug in the SDK; please report it |
 */
export interface Stats {
  /** Messages that passed the chokepoint and entered the buffer. */
  readonly captured: number;
  /** Messages whose identity failed validation. */
  readonly droppedInvalid: number;
  /**
   * Messages whose body or frame exceeded `maxCaptureBytes`, or which
   * lacked a field the wire contract requires.
   */
  readonly droppedOversize: number;
  /** Messages evicted from the buffer under pressure, oldest first. */
  readonly droppedEvicted: number;
  /**
   * Messages in batches the transport could not deliver — retries
   * exhausted, or a permanent rejection.
   */
  readonly droppedUndeliverable: number;
  /**
   * Captures lost to a swallowed exception inside the SDK. Any value above
   * zero is a bug.
   */
  readonly droppedFault: number;

  /** How many messages are awaiting delivery now. */
  readonly bufferedMessages: number;
  /** Their accounted footprint, always at or below `maxBufferBytes`. */
  readonly bufferBytes: number;
}

/** The counter each drop reason charges. "none" charges nothing. */
const FIELD_FOR_REASON: Partial<Record<DropReason, CounterField>> = {
  invalidIdentity: "droppedInvalid",
  oversize: "droppedOversize",
  evicted: "droppedEvicted",
  undeliverable: "droppedUndeliverable",
  fault: "droppedFault",
};

type CounterField = Exclude<keyof Stats, "bufferedMessages" | "bufferBytes">;
type MutableCounts = Record<CounterField, number>;

/**
 * The live counter set, shared by the chokepoint, the buffer and the
 * transport. The event loop serializes access, so no lock is needed — the
 * one place Node's single-threaded model saves work the other SDKs have to
 * do.
 */
export class Counters {
  private _counts: MutableCounts = {
    captured: 0,
    droppedInvalid: 0,
    droppedOversize: 0,
    droppedEvicted: 0,
    droppedUndeliverable: 0,
    droppedFault: 0,
  };

  countCaptured(): void {
    this._counts.captured++;
  }

  /**
   * Charge `n` messages to the counter for `reason`. It takes a count
   * because the transport loses a whole batch at once.
   */
  countDrop(reason: DropReason, n = 1): void {
    if (n <= 0) return;
    const field = FIELD_FOR_REASON[reason];
    if (field !== undefined) this._counts[field] += n;
  }

  /** Read the counters, optionally alongside the live buffer gauges. */
  snapshot(bufferedMessages = 0, bufferBytes = 0): Stats {
    return { ...this._counts, bufferedMessages, bufferBytes };
  }
}

/** The sum of every `dropped*` counter. */
export function totalDropped(stats: Stats): number {
  return (
    stats.droppedInvalid +
    stats.droppedOversize +
    stats.droppedEvicted +
    stats.droppedUndeliverable +
    stats.droppedFault
  );
}

/**
 * The counters accumulated between two snapshots. Only the monotonic fields
 * are differenced; the buffer gauges are carried across, since a delta of
 * an instantaneous value is meaningless.
 */
export function subtract(current: Stats, previous: Stats): Stats {
  return {
    captured: current.captured - previous.captured,
    droppedInvalid: current.droppedInvalid - previous.droppedInvalid,
    droppedOversize: current.droppedOversize - previous.droppedOversize,
    droppedEvicted: current.droppedEvicted - previous.droppedEvicted,
    droppedUndeliverable:
      current.droppedUndeliverable - previous.droppedUndeliverable,
    droppedFault: current.droppedFault - previous.droppedFault,
    bufferedMessages: current.bufferedMessages,
    bufferBytes: current.bufferBytes,
  };
}

/**
 * The key each counter is logged under. Deliberately not the field names:
 * the health line is operator-facing, and an operator grepping a polyglot
 * fleet should see one vocabulary, not three. All three SDKs emit exactly
 * these keys.
 */
const LOG_KEYS: readonly (readonly [string, keyof Stats])[] = [
  ["captured", "captured"],
  ["invalid_identity", "droppedInvalid"],
  ["oversize", "droppedOversize"],
  ["evicted", "droppedEvicted"],
  ["undeliverable", "droppedUndeliverable"],
  ["fault", "droppedFault"],
];

/**
 * Render a snapshot as `key=value` pairs, omitting zero counters. Keeping
 * the line to what actually happened is what makes it readable at a glance
 * in a production log.
 */
export function logLine(stats: Stats): string {
  const parts: string[] = [];
  for (const [key, field] of LOG_KEYS) {
    const value = stats[field];
    if (value !== 0) parts.push(`${key}=${value}`);
  }
  parts.push(`buffered=${stats.bufferedMessages}`);
  parts.push(`buffer_bytes=${stats.bufferBytes}`);
  return parts.join(" ");
}
