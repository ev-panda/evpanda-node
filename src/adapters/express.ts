/**
 * Adapter — OCPI inbound (partner → customer), express/connect.
 *
 * Optional convenience over the stable primitive. Dominant shape:
 * `(req, res, next)`. koa/fastify via a documented ~5-line shim, not a
 * per-framework matrix. Tees res.write/res.end to capture the response body,
 * stopping the copy at maxCaptureBytes, then calls `sdk.captureOCPI`.
 *
 * Pass-through is exact: the customer's handler and response are untouched;
 * the proxy boundary inside the SDK isolates any capture fault.
 *
 * `express` is an OPTIONAL peer dependency — only loaded if this is used.
 * Types stay loose to avoid a hard import.
 */

import type { IdentityInput, RoamingIdentity } from "../identity.js";
import type { EVPanda } from "../sdk.js";

export interface ExpressMiddlewareOptions {
  identity?: IdentityInput<{ req: unknown }, RoamingIdentity>;
}

/** Returns an express/connect-compatible `(req, res, next)` middleware. */
export function ocpiInbound(
  _sdk: EVPanda,
  _opts?: ExpressMiddlewareOptions,
): (req: unknown, res: unknown, next: () => void) => void {
  throw new Error("not implemented");
}
