/** @evpanda/sdk — public entrypoint. Capture via the EVPanda methods. */

export { EVPanda } from "./sdk.js";

// Optional adapters (express/ws are optional peer deps, loaded only if used).
export { ocpiInbound } from "./adapters/express.js";
export { wrapFetch } from "./adapters/fetch.js";
export { recordConnection } from "./adapters/ws.js";

export type { ExpressMiddlewareOptions } from "./adapters/express.js";
export type { FetchWrapOptions } from "./adapters/fetch.js";
export type {
  OCPPRecorderOptions,
  ConnectionRecorder,
} from "./adapters/ws.js";

export type { EVPandaConfig, Logger } from "./config.js";

export type {
  RoamingIdentity,
  ChargerIdentity,
  IdentityInput,
} from "./identity.js";

export { OCPPEventType } from "./types.js";

export type { OCPIMessage, OCPPMessage } from "./types.js";
