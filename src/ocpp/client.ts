/**
 * OCPPClient — passive OCPP CSMS traffic capture.
 *
 * Two ways to capture:
 *   - `connection(identity)` — the recommended path: a session handle that
 *     owns the `connectionId` and carries the identity. Attach it to your
 *     WebSocket and call `message` / `disconnect`.
 *   - `captureConnect` / `captureMessage` / `captureDisconnect` — the flat
 *     primitives the session is built on, for one-off capture.
 *
 * Identity is a `ChargerIdentity` literal; an invalid one is dropped.
 */

import { randomUUID } from "node:crypto";

import { RingBuffer } from "../buffer.js";
import { resolveOCPPConfig } from "../config.js";
import { validateChargerIdentity } from "../identity.js";
import { BaseClient } from "../internal/client-base.js";
import { makeOCPPRedactor } from "../internal/ocpp-redact.js";
import { Transport } from "../transport.js";
import { Worker } from "../worker.js";
import { OCPPEventType } from "../types.js";

import type { OCPPConfig, Logger } from "../config.js";
import type { ChargerIdentity } from "../identity.js";
import type { OCPPRedactor } from "../internal/ocpp-redact.js";
import type { OCPPDirection, OCPPMessage } from "../types.js";

/**
 * Input shape for all three OCPP capture methods. `data` / `direction` are
 * optional on the type because connect/disconnect don't carry a frame;
 * `captureMessage` requires both and drops the message if either is missing.
 */
export interface OCPPMessageInput {
  /** The charge point this event belongs to. Invalid ⇒ message dropped. */
  identity: ChargerIdentity;
  /** Stable for the lifetime of this connection; minted by the caller. */
  connectionId: string;
  /** Frame bytes (strings → UTF-8). Required by `captureMessage`. */
  data?: Uint8Array | string;
  /** Frame direction. Required by `captureMessage`. */
  direction?: OCPPDirection;
}

/**
 * A live capture handle for one OCPP WebSocket connection. Returned by
 * `OCPPClient.connection`; it owns the `connectionId` and the identity so
 * per-frame calls carry neither. Attach it to your connection object and
 * call `message` per frame, `disconnect` when the socket closes.
 */
export interface OCPPSession {
  /** SDK-minted id for this connection — fresh per `connection()` call. */
  readonly connectionId: string;
  /** Capture one OCPP frame. Oversize frames are dropped. */
  message(data: Uint8Array | string, direction: OCPPDirection): void;
  /** Capture the connection closing. */
  disconnect(): void;
}

interface Engine {
  enqueue(msg: OCPPMessage): void;
  maxCaptureBytes(): number;
  /** Effective logger (set only when `debug: true`); undefined ⇒ silent. */
  logger(): Logger | undefined;
  flush(): Promise<void>;
  close(deadlineMs?: number): Promise<void>;
}

class ActiveEngine implements Engine {
  readonly #worker: Worker;
  readonly #maxCaptureBytes: number;
  readonly #logger: Logger | undefined;
  readonly #redact: OCPPRedactor;

  constructor(config: OCPPConfig) {
    const resolved = resolveOCPPConfig(config);
    const buffer = new RingBuffer(resolved.bufferCapacity);
    this.#worker = new Worker(buffer, new Transport(resolved), resolved);
    this.#maxCaptureBytes = resolved.maxCaptureBytes;
    this.#logger = resolved.logger;
    this.#redact = makeOCPPRedactor();
  }

  arm(): void {
    this.#worker.start();
  }

  enqueue(msg: OCPPMessage): void {
    this.#worker.captureOCPP(msg, this.#redact);
  }

  maxCaptureBytes(): number {
    return this.#maxCaptureBytes;
  }

  logger(): Logger | undefined {
    return this.#logger;
  }

  flush(): Promise<void> {
    return this.#worker.flushOnce();
  }

  close(deadlineMs?: number): Promise<void> {
    return this.#worker.close(deadlineMs);
  }
}

class NoopEngine implements Engine {
  enqueue(): void {
    /* no-op */
  }
  maxCaptureBytes(): number {
    // Generous so the message-frame oversize check never short-circuits
    // here; the noop engine would drop the message anyway.
    return Number.POSITIVE_INFINITY;
  }
  logger(): Logger | undefined {
    return undefined;
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Captures and ships OCPP CSMS traffic. Build with [OCPPClient.start] —
 * a bad config never throws; it yields an inert no-op client.
 */
export class OCPPClient extends BaseClient<Engine> {
  private constructor(engine: Engine) {
    super(engine, () => new NoopEngine());
  }

  /** Build and start. Any fault yields an inert client; never throws to the host. */
  static start(config: OCPPConfig): OCPPClient {
    try {
      const engine = new ActiveEngine(config);
      engine.arm();
      return new OCPPClient(engine);
    } catch {
      return new OCPPClient(new NoopEngine());
    }
  }

  /**
   * Open a capture session for one OCPP connection: mints a `connectionId`,
   * records the connect, and returns an {@link OCPPSession}. Attach the
   * handle to your WebSocket.
   */
  connection(identity: ChargerIdentity): OCPPSession {
    const connectionId = randomUUID();
    this.captureConnect({ identity, connectionId });
    return {
      connectionId,
      message: (data, direction) =>
        this.captureMessage({ identity, connectionId, data, direction }),
      disconnect: () => this.captureDisconnect({ identity, connectionId }),
    };
  }

  /** Record a new OCPP connection. Uses `identity` + `connectionId` only. */
  captureConnect(input: OCPPMessageInput): void {
    try {
      if (!validateChargerIdentity(input.identity)) return;
      this.engine.enqueue({
        eventType: OCPPEventType.Connect,
        identity: input.identity,
        connectionId: input.connectionId,
      });
    } catch (err) {
      this.#logFault("captureConnect", err);
    }
  }

  /** Record one OCPP frame. Requires `data` + `direction`; oversize ⇒ dropped. */
  captureMessage(input: OCPPMessageInput): void {
    try {
      if (input.data == null || input.direction == null) return;
      if (!validateChargerIdentity(input.identity)) return;
      const encoded = encodeFrame(input.data, this.engine.maxCaptureBytes());
      if (encoded.overflowed) return;
      this.engine.enqueue({
        eventType: OCPPEventType.Message,
        identity: input.identity,
        connectionId: input.connectionId,
        direction: input.direction,
        payload: encoded.payload,
      });
    } catch (err) {
      this.#logFault("captureMessage", err);
    }
  }

  /** Record the connection closing. Uses `identity` + `connectionId` only. */
  captureDisconnect(input: OCPPMessageInput): void {
    try {
      if (!validateChargerIdentity(input.identity)) return;
      this.engine.enqueue({
        eventType: OCPPEventType.Disconnect,
        identity: input.identity,
        connectionId: input.connectionId,
      });
    } catch (err) {
      this.#logFault("captureDisconnect", err);
    }
  }

  /** Surface a swallowed capture fault when a debug logger is configured. */
  #logFault(op: string, err: unknown): void {
    this.engine.logger()?.warn(`@evpanda/sdk: OCPP ${op} failed`, {
      error: String(err),
    });
  }
}

/** Encode a frame to bytes and signal overflow against the configured cap. */
function encodeFrame(
  data: Uint8Array | string,
  max: number,
): { payload: Uint8Array; overflowed: boolean } {
  const buf =
    data instanceof Uint8Array ? data : Buffer.from(data, "utf8");
  if (buf.length > max) return { payload: new Uint8Array(0), overflowed: true };
  return { payload: buf, overflowed: false };
}
