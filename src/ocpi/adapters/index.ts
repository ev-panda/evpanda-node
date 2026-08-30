/**
 * The OCPI adapter namespace, re-exported from the package root as `ocpi`.
 *
 * Three adapters, one per HTTP layer a Node service is likely to speak:
 * `express` for inbound requests, `fetch` and `axios` for outbound ones.
 * They assemble the exchange, resolve the partner, and call the right
 * capture method, so a host needs no capture code of its own.
 */

export { express } from "./express.js";
export type { OCPIExpressOptions } from "./express.js";

export { fetch } from "./fetch.js";
export type { OCPIFetchOptions } from "./fetch.js";

export { axios } from "./axios.js";
export type { OCPIAxiosOptions } from "./axios.js";

// Identity: the carriers the adapters read, and the resolver contract.
export {
  HEADER_PLATFORM_ID,
  HEADER_PLATFORM_NAME,
  HEADER_TENANT_ID,
  HEADER_TENANT_NAME,
  IDENTITY_HEADERS,
  currentIdentity,
  defaultResolver,
  identityFrom,
  identityFromHeaders,
  setIdentity,
  useIdentity,
} from "./resolver.js";

export type { Capturer, RequestInfo, Resolver } from "./resolver.js";
