/**
 * The lifecycle core the two protocol clients share.
 *
 * The protocol is the client — there is no network-type switch.
 * `startOCPI` returns an `OCPIClient`, `startOCPP` an `OCPPClient`, and a
 * client instance serves exactly one protocol for its whole life. Both
 * extend `BaseClient`, which owns the worker and the counters and supplies
 * `stats` / `capturing` / `flush` / `close`.
 */

import { Counters } from "./stats.js";

import type { ConfigError, Logger, ResolvedConfig } from "./config.js";
import type { Stats } from "./stats.js";
import type { Worker } from "./worker.js";

/**
 * Holds the running worker, drops it on close, and reports on itself.
 *
 * `startOCPI` and `startOCPP` never throw, so every method here has a live
 * receiver — including on an inert client (one built from a bad config),
 * whose worker is undefined but whose object is not.
 */
export abstract class BaseClient {
  #worker: Worker | undefined;
  /**
   * Held here rather than on the worker so the counters survive close —
   * the final tally is often the thing worth reading.
   */
  readonly #counters = new Counters();
  #error: ConfigError | undefined;

  /**
   * The configuration fault that made this client inert, if any.
   * `undefined` on a healthy client.
   *
   * Match `ApiKeyError` to tell a deployment problem (the key never reached
   * the process) from a code one:
   *
   * ```ts
   * const panda = startOCPI();
   * if (panda.error instanceof ApiKeyError) {
   *   throw new Error("EVPANDA_API_KEY is not set in this environment");
   * }
   * if (panda.error) log.warn(`${panda.error.message} (running inert)`);
   * ```
   */
  get error(): ConfigError | undefined {
    return this.#error;
  }

  /** The running worker, or undefined when the client is inert or closed. */
  protected get worker(): Worker | undefined {
    return this.#worker;
  }

  protected get counters(): Counters {
    return this.#counters;
  }

  /** Attach a live worker. Called once, by the start function. */
  protected begin(worker: Worker): void {
    this.#worker = worker;
  }

  /**
   * Leave the client inert, carrying the fault that got it there. The error
   * is logged as well as stored: a host that never looks at `error` still
   * has to be told that its SDK is not running.
   */
  protected fail(error: ConfigError, logger: Logger | undefined): void {
    this.#error = error;
    try {
      logger?.error(
        `${error.message} — the client is inert and will capture nothing`,
      );
    } catch {
      /* a broken host logger is not our failure */
    }
  }

  /**
   * A snapshot of this client's delivery counters.
   *
   * Always available: there is no log mode that turns the counters off, and
   * it is safe to call on an inert or closed client (a closed one reports
   * its final totals with an empty buffer).
   *
   * Use it to answer "why am I seeing no data?" without a redeploy — each
   * counter maps to one root cause, documented on `Stats` — or to feed your
   * own metrics system.
   */
  stats(): Stats {
    return this.#worker?.snapshot() ?? this.#counters.snapshot();
  }

  /**
   * The per-body byte cap while this client is capturing, else `undefined`.
   *
   * The cap and the fact of capturing come back together deliberately:
   * asked separately they could straddle a close and disagree. The shipped
   * adapters use it to bound what they accumulate from a streaming body and
   * to skip instrumentation entirely when there is nothing to capture into,
   * and it is public so an adapter for a framework the SDK does not ship
   * has the same two facts.
   */
  capturing(): number | undefined {
    return this.#worker?.config.maxCaptureBytes;
  }

  /**
   * Deliver everything currently buffered and wait for that delivery.
   *
   * It waits for as long as the transport's bounded retry takes, so it is a
   * diagnostic and shutdown tool rather than something to call on a hot
   * path — capture is already asynchronous. Never rejects.
   */
  async flush(): Promise<void> {
    const worker = this.#worker;
    if (worker === undefined) return;
    try {
      await worker.flushOnce();
    } catch {
      this.countFault();
    }
  }

  /**
   * Stop capture and drain what is buffered, then report whether it
   * drained.
   *
   * `timeoutMs` defaults to the configured `drainTimeout`. Resolves to
   * `false` if the deadline passed with messages still buffered, meaning
   * some captured data was dropped on shutdown.
   *
   * Idempotent, and never rejects. Captures made after it are safe no-ops.
   */
  async close(timeoutMs?: number): Promise<boolean> {
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker === undefined) return true;
    try {
      return await worker.close(timeoutMs);
    } catch {
      this.countFault();
      return false;
    }
  }

  /**
   * Run a capture path, swallowing and counting anything it throws. The SDK
   * never throws into the host, and a capture has no error to return.
   */
  protected guard(op: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.countFault(op, err);
    }
  }

  /**
   * Count a swallowed fault and, in debug, log it. In the default mode the
   * worker's health line reports it instead: a fault that repeats per
   * message would otherwise log at message rate.
   */
  protected countFault(op?: string, err?: unknown): void {
    this.#counters.countDrop("fault");
    const config = this.#worker?.config;
    if (config?.logger === undefined || config.logMode !== "debug") return;
    try {
      config.logger.warn("@evpanda/sdk: capture failed", { op, error: err });
    } catch {
      /* reporting must not throw either */
    }
  }

  /** Internal: the resolved config, for the start functions. */
  protected static configOf(worker: Worker): ResolvedConfig {
    return worker.config;
  }
}
