/**
 * OCPPClient — passive OCPP CSMS capture, the session handle, and the
 * `startOCPP` that builds a client.
 */

import { randomUUID } from "node:crypto";

import { RingBuffer } from "../buffer.js";
import { BaseClient } from "../client.js";
import { ConfigError, loggerFor, resolveOCPPConfig } from "../config.js";
import { Transport } from "../transport.js";
import { OCPPEventType } from "../types.js";
import { Worker } from "../worker.js";

import type { OCPPConfig } from "../config.js";
import type { BodyInput, Charger, OCPPDirection } from "../types.js";
import type { OCPPRedactor } from "./redact.js";

/**
 * The input shape for the three flat OCPP capture primitives. `data` and
 * `direction` are only used by `captureMessage`, which requires both and
 * drops the message if either is missing; connect and disconnect carry no
 * frame.
 */
export interface OCPPMessageInput {
  /** The charge point this event belongs to. Invalid ⇒ message dropped. */
  identity: Charger;
  /**
   * Stable for the lifetime of this connection. The session handle returned
   * by `connection()` mints and carries it for you.
   */
  connectionId: string;
  /** The raw frame. Required by `captureMessage`. */
  data?: BodyInput;
  /** The frame direction. Required by `captureMessage`. */
  direction?: OCPPDirection;
}

/**
 * A live capture handle for one OCPP WebSocket connection.
 *
 * Returned by `OCPPClient.connection`, it owns the connection ID and the
 * identity so per-frame calls carry neither. Attach it to your connection
 * object and call `message` per frame, `disconnect` when the socket closes.
 */
export interface OCPPSession {
  /**
   * The SDK-minted ID for this connection — fresh per `connection()` call,
   * which is how the ingestion side separates one charger's sessions across
   * reconnects.
   */
  readonly connectionId: string;
  /** Capture one OCPP frame. Oversize frames are dropped. */
  message(data: BodyInput, direction: OCPPDirection): void;
  /** Capture the connection closing. */
  disconnect(): void;
}

/**
 * Captures and ships OCPP CSMS traffic. Build it with `startOCPP`.
 *
 * There are two ways to capture:
 *
 * - `connection()` — the recommended path: a session handle that owns the
 *   connection ID and carries the identity. Attach it to your WebSocket and
 *   call `message` per frame, `disconnect` on close.
 * - `captureConnect` / `captureMessage` / `captureDisconnect` — the flat
 *   primitives the session is built on, for one-off capture.
 *
 * `identity` is a `Charger` value, not a resolver: OCPP identity is known
 * at connect time. An invalid one drops the message.
 */
export class OCPPClient extends BaseClient {
  /**
   * undefined today: OCPP frames are captured verbatim, and the chokepoint
   * reads undefined as "nothing to redact". See ocpp/redact.ts.
   */
  #redact: OCPPRedactor | undefined;

  /** Internal — use `startOCPP`. */
  protected constructor() {
    super();
  }

  /**
   * Open a capture session for one OCPP connection: mint a connection ID,
   * record the connect, and hand back the session.
   *
   * Use one per socket — its connection ID ties the connect, every frame
   * and the disconnect into a single session, and a reconnect gets a fresh
   * one.
   */
  connection(identity: Charger): OCPPSession {
    const connectionId = randomUUID();
    this.captureConnect({ identity, connectionId });
    return {
      connectionId,
      message: (data, direction) => {
        this.captureMessage({ identity, connectionId, data, direction });
      },
      disconnect: () => {
        this.captureDisconnect({ identity, connectionId });
      },
    };
  }

  /** Record a new OCPP connection. Non-blocking and never throws. */
  captureConnect(msg: OCPPMessageInput): void {
    this.guard("captureConnect", () => {
      this.worker?.captureOCPP(
        {
          eventType: OCPPEventType.Connect,
          charger: msg.identity,
          connectionId: msg.connectionId,
        },
        this.#redact,
      );
    });
  }

  /**
   * Record one OCPP frame.
   *
   * It requires `data` and `direction` and drops the message if either is
   * missing; oversize frames are dropped too. Non-blocking and never
   * throws.
   */
  captureMessage(msg: OCPPMessageInput): void {
    this.guard("captureMessage", () => {
      this.worker?.captureOCPP(
        {
          eventType: OCPPEventType.Message,
          charger: msg.identity,
          connectionId: msg.connectionId,
          direction: msg.direction,
          payload: msg.data as Uint8Array | undefined,
        },
        this.#redact,
      );
    });
  }

  /** Record the connection closing. Non-blocking and never throws. */
  captureDisconnect(msg: OCPPMessageInput): void {
    this.guard("captureDisconnect", () => {
      this.worker?.captureOCPP(
        {
          eventType: OCPPEventType.Disconnect,
          charger: msg.identity,
          connectionId: msg.connectionId,
        },
        this.#redact,
      );
    });
  }

  /** @internal Used by `startOCPP` only. */
  static _build(config: OCPPConfig): OCPPClient {
    const client = new OCPPClient();
    try {
      const resolved = resolveOCPPConfig(config);
      const counters = client.counters;
      // #redact stays undefined: OCPP frames are captured verbatim today.
      const worker = new Worker(
        new RingBuffer(resolved.maxBufferBytes, counters),
        new Transport(resolved, counters),
        resolved,
        counters,
      );
      worker.start();
      client.begin(worker);
    } catch (err) {
      const error =
        err instanceof ConfigError
          ? err
          : new ConfigError(`evpanda: ${String(err)}`);
      client.fail(error, loggerFor(config));
    }
    return client;
  }
}

/**
 * Validate the config, build the client, and start its background worker.
 *
 * It always returns a usable `OCPPClient` and never throws; see `startOCPI`
 * for what can fail and what an inert client does.
 *
 * ```ts
 * const panda = startOCPP();
 * if (panda.error) log.warn(`${panda.error.message} (running inert)`);
 * ```
 */
export function startOCPP(config: OCPPConfig = {}): OCPPClient {
  return OCPPClient._build(config);
}
