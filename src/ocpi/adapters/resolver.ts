/**
 * Shared utilities for the three OCPI adapters: header normalization and
 * the guarded `safeResolve` wrapper, so the adapters don't drift.
 */

import { validateRoamingIdentity } from "../../identity.js";

import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type {
  OCPIResolver,
  OCPIResolverCtx,
  RoamingIdentity,
} from "../../identity.js";

/** Lowercase keys, single-string values, undefined dropped. */
export function normalizeIncomingHeaders(
  h: IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/** Same normalization for outgoing headers (used to capture response headers). */
export function normalizeOutgoingHeaders(
  h: OutgoingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v)
      ? v.map(String).join(", ")
      : String(v);
  }
  return out;
}

/**
 * Run the customer's resolver under try/catch, then validate. A thrown
 * resolver or an invalid identity yields `undefined` — the adapter then
 * skips capture for that request.
 */
export function safeResolve(
  resolve: OCPIResolver,
  ctx: OCPIResolverCtx,
): RoamingIdentity | undefined {
  try {
    const id = resolve(ctx);
    return validateRoamingIdentity(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
