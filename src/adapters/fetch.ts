/**
 * Adapter — OCPI outbound (customer → partner), fetch/undici.
 *
 * Optional convenience over the stable primitive. Returns a drop-in
 * replacement for the customer's `fetch`: performs the call normally and
 * tees a copy of the response (capped at maxCaptureBytes) into
 * `sdk.captureOCPI` with direction "outbound".
 *
 * Pass-through is exact — must not alter the request/response or throw into
 * the caller; the proxy boundary isolates any capture fault.
 */

import type { IdentityInput, RoamingIdentity } from "../identity.js";
import type { EVPanda } from "../sdk.js";

export interface FetchWrapOptions {
  identity?: IdentityInput<{ request: Request }, RoamingIdentity>;
}

/** Returns a fetch-compatible function that delegates to `baseFetch`. */
export function wrapFetch(
  _sdk: EVPanda,
  _baseFetch: typeof fetch,
  _opts?: FetchWrapOptions,
): typeof fetch {
  throw new Error("not implemented");
}
