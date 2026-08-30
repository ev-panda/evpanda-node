/**
 * @evpanda/sdk — passive OCPI/OCPP traffic capture for Node.
 *
 * Embed it in your OCPI server or OCPP CSMS and it records protocol
 * messages, buffers them in-process, and ships them in batches to the
 * EVPanda ingestion API.
 *
 * The SDK stays out of the host's way: capture calls are non-blocking and
 * never throw, memory is bounded, and under stress or network failure it
 * drops data rather than degrading the application.
 *
 * The protocol is the client — `startOCPI` returns an `OCPIClient`,
 * `startOCPP` an `OCPPClient`. Both always hand back a usable client: on a
 * bad endpoint or API key the client is an inert no-op carrying the fault
 * on `.error`, so a config typo can never crash the host's boot.
 *
 * ```ts
 * import { startOCPI } from "@evpanda/sdk";
 *
 * // apiKey comes from EVPANDA_API_KEY; endpoint defaults to production.
 * const panda = startOCPI();
 * if (panda.error) log.warn(`${panda.error.message} (running inert)`);
 * ```
 */

export { OCPIClient, startOCPI } from "./ocpi/client.js";
export { OCPPClient, startOCPP } from "./ocpp/client.js";

/**
 * OCPI adapters — `ocpi.express`, `ocpi.fetch`, `ocpi.axios`, plus the
 * identity carriers they share.
 */
export * as ocpi from "./ocpi/adapters/index.js";

export {
  API_KEY_ENV_VAR,
  ApiKeyError,
  ConfigError,
  DEFAULT_ENDPOINT,
  EVPandaError,
  EndpointError,
  LOG_MODE_ENV_VAR,
} from "./config.js";

export type {
  BaseConfig,
  LogMode,
  Logger,
  OCPIConfig,
  OCPPConfig,
} from "./config.js";

export type { Stats } from "./stats.js";

export type { OCPIMessageInput } from "./ocpi/client.js";
export type { OCPPMessageInput, OCPPSession } from "./ocpp/client.js";

export { OCPPEventType } from "./types.js";

export type {
  BodyInput,
  Charger,
  HTTPExchange,
  OCPPDirection,
  Platform,
} from "./types.js";
