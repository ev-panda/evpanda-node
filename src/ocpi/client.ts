/**
 * OCPIClient — passive OCPI traffic capture. Public surface: `start`,
 * `captureInboundMessage`, `captureOutboundMessage`, `flush`, `close`.
 * Adapters in `./adapters/` reach internal state via the bridge WeakMap.
 */

import { RingBuffer } from "../buffer.js";
import { resolveOCPIConfig } from "../config.js";
import { IdentityStore } from "../internal/als.js";
import { attachBridge } from "../internal/bridge.js";
import { BaseClient } from "../internal/client-base.js";
import { makeOCPIRedactor } from "../internal/ocpi-redact.js";
import { Transport } from "../transport.js";
import { Worker } from "../worker.js";

import type { OCPIConfig } from "../config.js";
import type { SdkInternal } from "../internal/bridge.js";
import type { OCPIRedactor } from "../internal/ocpi-redact.js";
import type { OCPIDirection, OCPIMessage, OCPIMessageInput } from "../types.js";

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
      identityStore: resolved.propagateIdentity ? new IdentityStore() : undefined,
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
  private constructor(engine: Engine) {
    super(engine, () => new NoopEngine());
  }

  /** Build and start. Any fault yields an inert client; never throws to the host. */
  static start(config: OCPIConfig): OCPIClient {
    try {
      const engine = new ActiveEngine(config);
      engine.arm();
      // Register the bridge so adapters can read it; inert clients have no
      // entry and adapters short-circuit to a pass-through.
      const client = new OCPIClient(engine);
      attachBridge(client, engine.bridge);
      return client;
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
