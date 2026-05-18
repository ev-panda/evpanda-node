/**
 * SDK facade: a proxy forwarding to `ActiveSDK` or `NoopSDK`. The proxy is the
 * one customer-facing boundary — it never throws and never blocks the host.
 */

import { RingBuffer } from "./buffer.js";
import { resolveConfig } from "./config.js";
import {
  captureOCPI as captureOCPIImpl,
  captureOCPP as captureOCPPImpl,
} from "./instrumentation.js";
import { Transport } from "./transport.js";
import { Worker } from "./worker.js";

import type { EVPandaConfig } from "./config.js";
import type { OCPIMessage, OCPPMessage } from "./types.js";

export interface SdkImpl {
  captureOCPI(msg: OCPIMessage): void;
  captureOCPP(msg: OCPPMessage): void;
  flush(): Promise<void>;
  close(deadlineMs?: number): Promise<void>;
}

/** Construction is split from start() so a build failure leaks no timer. */
class ActiveSDK implements SdkImpl {
  readonly #worker: Worker;
  readonly #buffer: RingBuffer;

  /** Pure build, no side effects. resolveConfig() is the only throw site. */
  constructor(config: EVPandaConfig) {
    const resolved = resolveConfig(config);
    const buffer = new RingBuffer(resolved.bufferCapacity);
    this.#worker = new Worker(buffer, new Transport(resolved), resolved);
    this.#buffer = buffer;
  }

  /** Arm the worker. Called last by EVPanda.start(). */
  start(): void {
    this.#worker.start();
  }

  captureOCPI(msg: OCPIMessage): void {
    captureOCPIImpl(this.#buffer, msg);
  }

  captureOCPP(msg: OCPPMessage): void {
    captureOCPPImpl(this.#buffer, msg);
  }

  flush(): Promise<void> {
    return this.#worker.flushOnce();
  }

  close(deadlineMs?: number): Promise<void> {
    return this.#worker.close(deadlineMs);
  }
}

/** Inert twin: every method a no-op. #impl is this when the SDK is off. */
class NoopSDK implements SdkImpl {
  captureOCPI(): void {
    /* no-op: SDK disabled */
  }
  captureOCPP(): void {
    /* no-op: SDK disabled */
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class EVPanda implements SdkImpl {
  #impl: SdkImpl;

  private constructor(impl: SdkImpl) {
    this.#impl = impl;
  }

  /** Build then start; any fault yields an inert SDK (never throws to host). */
  static start(config: EVPandaConfig): EVPanda {
    try {
      const impl = new ActiveSDK(config); // build (may throw on bad config)
      impl.start(); // arm worker last
      return new EVPanda(impl);
    } catch {
      return new EVPanda(new NoopSDK());
    }
  }

  captureOCPI(msg: OCPIMessage): void {
    try {
      this.#impl.captureOCPI(msg);
    } catch {
      /* swallow */
    }
  }

  captureOCPP(msg: OCPPMessage): void {
    try {
      this.#impl.captureOCPP(msg);
    } catch {
      /* swallow */
    }
  }

  async flush(): Promise<void> {
    try {
      await this.#impl.flush(); // await catches a rejected promise too
    } catch {
      /* swallow */
    }
  }

  /** One-shot: swap to noop synchronously (captures inert at once), then drain. */
  async close(deadlineMs?: number): Promise<void> {
    const impl = this.#impl;
    this.#impl = new NoopSDK();
    try {
      await impl.close(deadlineMs);
    } catch {
      /* swallow */
    }
  }
}
