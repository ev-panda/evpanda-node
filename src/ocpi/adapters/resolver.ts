/**
 * Shared utilities for the three OCPI adapters: header normalization, the
 * shipped `headerResolver`, and the guarded `safeResolve` wrapper, so the
 * adapters don't drift.
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

// ── Shipped default resolver ─────────────────────────────────────────────

/**
 * Headers the shipped resolver reads. Lowercase: every adapter normalizes
 * keys before the resolver runs, so `X-EVPanda-Platform-Id` and
 * `x-evpanda-platform-id` are equivalent on the wire.
 */
export const IDENTITY_HEADERS = {
  platformId: "x-evpanda-platform-id",
  platformName: "x-evpanda-platform-name",
  tenantId: "x-evpanda-tenant-id",
  tenantName: "x-evpanda-tenant-name",
} as const;

/**
 * The same names as a list, for the outbound adapters: they strip these
 * before dispatch so a partner never receives them — `tenantId` /
 * `tenantName` in particular describe the host's own tenant, not the
 * partner's.
 */
export const IDENTITY_HEADER_NAMES: readonly string[] =
  Object.values(IDENTITY_HEADERS);

/**
 * Default resolver — reads identity from the `X-EVPanda-*` headers, so a
 * host can stamp identity wherever it already knows it instead of writing a
 * resolver. Used by all three adapters when `resolve` is omitted.
 *
 * Missing headers yield empty strings, which `validateRoamingIdentity`
 * rejects, so an unstamped request is simply not captured. Tenant stays
 * all-or-nothing: set both tenant headers or neither — a half-set pair
 * fails validation and drops the message, same as a hand-written resolver.
 */
export const headerResolver: OCPIResolver = ({ requestHeaders }) => {
  const read = (key: string): string | undefined => {
    const v = requestHeaders[key]?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  const identity: RoamingIdentity = {
    platformId: read(IDENTITY_HEADERS.platformId) ?? "",
    platformName: read(IDENTITY_HEADERS.platformName) ?? "",
  };
  const tenantId = read(IDENTITY_HEADERS.tenantId);
  const tenantName = read(IDENTITY_HEADERS.tenantName);
  if (tenantId !== undefined) identity.tenantId = tenantId;
  if (tenantName !== undefined) identity.tenantName = tenantName;
  return identity;
};

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
