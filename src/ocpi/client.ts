/**
 * OCPIClient — passive OCPI roaming capture, and the `startOCPI` that
 * builds one.
 */

import { RingBuffer } from "../buffer.js";
import { BaseClient } from "../client.js";
import { ConfigError, loggerFor, resolveOCPIConfig } from "../config.js";
import { Transport } from "../transport.js";
import { Worker } from "../worker.js";
import { makeOCPIRedactor } from "./redact.js";

import type { OCPIConfig } from "../config.js";
import type { HTTPExchange, OCPIDirection, Platform } from "../types.js";
import type { OCPIRedactor } from "./redact.js";

/**
 * The input to `captureInboundMessage` and `captureOutboundMessage`. There
 * is no direction field — the method you call stamps it.
 */
export interface OCPIMessageInput {
  /** The roaming partner on the other side. Invalid ⇒ message dropped. */
  identity: Platform;
  /** The captured HTTP exchange. */
  data: HTTPExchange;
}

/**
 * Captures and ships OCPI roaming traffic. Build it with `startOCPI`.
 *
 * OCPI traffic flows both ways between roaming partners and the SDK records
 * each direction separately. There is no direction argument — the method
 * you call stamps it:
 *
 * - `captureInboundMessage` — a partner called your OCPI server. You are
 *   the server, so you capture the request they sent and the response you
 *   returned.
 * - `captureOutboundMessage` — you called a partner's OCPI server. You are
 *   the client, so you capture the request you sent and the response they
 *   returned.
 *
 * In both cases `identity` is the partner on the other side of the
 * exchange, never your own platform.
 */
export class OCPIClient extends BaseClient {
  /**
   * The header allowlist and credentials mask. `startOCPI` always sets it
   * on a live client — the chokepoint reads undefined as "nothing to
   * redact".
   */
  #redact: OCPIRedactor | undefined;

  /** Internal — use `startOCPI`. */
  protected constructor() {
    super();
  }

  /**
   * Buffer an inbound OCPI message (partner → host) for delivery.
   *
   * Non-blocking and never throws; a message with an invalid identity or an
   * oversize body is silently dropped.
   */
  captureInboundMessage(msg: OCPIMessageInput): void {
    this.guard("captureInboundMessage", () => this.#capture(msg, "IN"));
  }

  /**
   * Buffer an outbound OCPI message (host → partner) for delivery.
   *
   * Non-blocking and never throws; a message with an invalid identity or an
   * oversize body is silently dropped.
   */
  captureOutboundMessage(msg: OCPIMessageInput): void {
    this.guard("captureOutboundMessage", () => this.#capture(msg, "OUT"));
  }

  /**
   * Stamp the direction and hand the message to the worker, which runs the
   * validate → cap → own → redact chokepoint.
   */
  #capture(msg: OCPIMessageInput, direction: OCPIDirection): void {
    this.worker?.captureOCPI(
      { direction, platform: msg.identity, data: msg.data },
      this.#redact,
    );
  }

  /** @internal Used by `startOCPI` only. */
  static _build(config: OCPIConfig): OCPIClient {
    const client = new OCPIClient();
    try {
      const resolved = resolveOCPIConfig(config);
      const counters = client.counters;
      client.#redact = makeOCPIRedactor(resolved.allowedHeaders);
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
 * It always returns a usable `OCPIClient` and never throws. `apiKey` is
 * hard-required and `endpoint` must parse: if either fails, the returned
 * client is an inert no-op carrying the fault on `.error`, so a config typo
 * can never stop the host booting. Every other field is tunable — a bad
 * value falls back to its default and is reported through `logMode`.
 *
 * ```ts
 * // endpoint defaults to production; apiKey comes from EVPANDA_API_KEY
 * const panda = startOCPI();
 * if (panda.error) log.warn(`${panda.error.message} (running inert)`);
 * ```
 */
export function startOCPI(config: OCPIConfig = {}): OCPIClient {
  return OCPIClient._build(config);
}
