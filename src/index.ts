/** @evpanda/sdk — public entrypoint. */

export { OCPIClient } from "./ocpi/client.js";
export { OCPPClient } from "./ocpp/client.js";

// OCPI adapters — `ocpi.express`, `ocpi.fetch`, `ocpi.axios`. Each takes an
// `OCPIClient` and shares the `OCPIResolver` contract.
export * as ocpi from "./ocpi/adapters/index.js";

export type { OCPIConfig, OCPPConfig, Logger } from "./config.js";

export type {
  RoamingIdentity,
  ChargerIdentity,
  OCPIResolver,
  OCPIResolverCtx,
} from "./identity.js";

export type { OCPPMessageInput, OCPPSession } from "./ocpp/client.js";

export { OCPPEventType } from "./types.js";

export type {
  OCPIDirection,
  OCPIMessage,
  OCPIMessageInput,
  OCPPDirection,
  OCPPMessage,
  Protocol,
} from "./types.js";
