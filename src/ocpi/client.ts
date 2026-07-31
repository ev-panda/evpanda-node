/**
 * OCPIClient — passive OCPI traffic capture. Public surface: `start`,
 * `captureInboundMessage`, `captureOutboundMessage`, `flush`, `close`.
 * Adapters in `./adapters/` receive their capture settings from the client.
 */

import { RingBuffer } from "../buffer.js";
import { resolveOCPIConfig } from "../config.js";
import { BaseClient } from "../client.js";
import { makeOCPIRedactor } from "./redact.js";
import { Transport } from "../transport.js";
import { Worker } from "../worker.js";

import type { Logger, OCPIConfig } from "../config.js";
import type { OCPIRedactor } from "./redact.js";
import type { OCPIDirection, OCPIMessage, OCPIMessageInput } from "../types.js";

/**
 * Package-private channel from a client to its adapters, carried on the
 * client's `_internal` field. Marked `@internal` there and erased from the
 * published typings by `stripInternal`, so it is not part of the public API.
 */
export interface SdkInternal {
  /** Resolved per-body cap; adapters use it to bound streaming accumulation. */
  readonly maxCaptureBytes: number;
  /** Effective logger (set only when `debug: true`); adapters log faults here. */
  readonly logger?: Logger;
}

interface Engine {
  captureMessage(msg: OCPIMessage): void;
  flush(): Promise<void>;
  close(deadlineMs?: number): Promise<void>;
}

/** Live engine. Building it has no side effects; `start` arms the worker. */
class ActiveEngine implements Engine {
  readonly #worker: Worker;
  readonly #redact: OCPIRedactor;
  /** Snapshot of resolved fields adapters need; exposed via the bridge. */
  readonly bridge: SdkInternal;

  constructor(config: OCPIConfig) {
    const resolved = resolveOCPIConfig(config);
    this.#worker = new Worker(
      new RingBuffer(resolved.bufferCapacity),
      new Transport(resolved),
      resolved,
    );
    this.#redact = makeOCPIRedactor(resolved.ocpiAllowedHeaders);
    this.bridge = {
      maxCaptureBytes: resolved.maxCaptureBytes,
      logger: resolved.logger,
    };
  }

  arm(): void {
    this.#worker.start();
  }

  captureMessage(msg: OCPIMessage): void {
    this.#worker.captureOCPI(msg, this.#redact);
  }

  flush(): Promise<void> {
    return this.#worker.flushOnce();
  }

  close(deadlineMs?: number): Promise<void> {
    return this.#worker.close(deadlineMs);
  }
}

/** Inert twin used when construction failed or after `close`. */
class NoopEngine implements Engine {
  captureMessage(): void {
    /* no-op */
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Captures and ships OCPI roaming traffic. Build with [OCPIClient.start] —
 * a bad config never throws; it yields an inert no-op client.
 */
export class OCPIClient extends BaseClient<Engine> {
  /**
   * @internal Adapter-only snapshot; `undefined` on an inert client — which is
   * how adapters short-circuit to a pass-through — and cleared by `close` so a
   * closed client stops doing capture work. Stripped from the published
   * typings: not public API, and not to be read or written by consumers.
   */
  _internal?: SdkInternal;

  private constructor(engine: Engine, internal?: SdkInternal) {
    super(engine, () => new NoopEngine());
    this._internal = internal;
  }

  /**
   * Go inert, then drain. Dropping the channel first means adapters wrapped
   * around this client fall back to their zero-overhead pass-through instead
   * of resolving identities and buffering bodies into a no-op engine.
   * Idempotent; never throws.
   */
  override async close(deadlineMs?: number): Promise<void> {
    this._internal = undefined;
    await super.close(deadlineMs);
  }

  /** Build and start. Any fault yields an inert client; never throws to the host. */
  static start(config: OCPIConfig): OCPIClient {
    try {
      const engine = new ActiveEngine(config);
      engine.arm();
      return new OCPIClient(engine, engine.bridge);
    } catch {
      return new OCPIClient(new NoopEngine());
    }
  }

  /** Buffer an inbound OCPI message (partner → host). Non-blocking; never throws. */
  captureInboundMessage(msg: OCPIMessageInput): void {
    this.#capture(msg, "IN");
  }

  /** Buffer an outbound OCPI message (host → partner). Non-blocking; never throws. */
  captureOutboundMessage(msg: OCPIMessageInput): void {
    this.#capture(msg, "OUT");
  }

  /** Stamp the direction and hand the full message to the engine. */
  #capture(msg: OCPIMessageInput, direction: OCPIDirection): void {
    try {
      this.engine.captureMessage({ ...msg, direction });
    } catch {
      /* swallow */
    }
  }
}
