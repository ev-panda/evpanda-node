/** OCPI adapter namespace — re-exported from the package root as `ocpi`. */

export { express } from "./express.js";
export type { OCPIExpressOptions } from "./express.js";

export { fetch } from "./fetch.js";
export type { OCPIFetchOptions } from "./fetch.js";

export { axios } from "./axios.js";
export type { OCPIAxiosOptions } from "./axios.js";

// Shipped default resolver — used when an adapter's `resolve` is omitted.
export { headerResolver, IDENTITY_HEADERS } from "./resolver.js";
