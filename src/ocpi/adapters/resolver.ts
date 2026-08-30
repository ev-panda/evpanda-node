/**
 * What every OCPI adapter shares: the client seam, identity resolution and
 * its carriers, header normalization, and the fault guard.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { validPlatform } from "../../types.js";

import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { HTTPExchange, Platform } from "../../types.js";

/**
 * What the adapters need from a live `OCPIClient`.
 *
 * Taking the structural type rather than the class keeps the seam explicit
 * and lets a test drive an adapter without a running pipeline.
 */
export interface Capturer {
  captureInboundMessage(msg: { identity: Platform; data: HTTPExchange }): void;
  captureOutboundMessage(msg: { identity: Platform; data: HTTPExchange }): void;
  capturing(): number | undefined;
}

/**
 * Ask the client what it can capture, tolerating one that misbehaves. A
 * missing client or a third-party implementation with a fault of its own
 * both mean "not capturing", which leaves the adapter a pass-through rather
 * than a broken host.
 */
export function capturing(client: Capturer | undefined): number | undefined {
  if (client == null) return undefined;
  try {
    return client.capturing();
  } catch {
    return undefined;
  }
}

/**
 * Run `fn`, swallowing anything it throws.
 *
 * A fault while assembling a capture can never reach the host. The capture
 * calls themselves are already guarded inside the SDK — that is where a
 * fault gets counted — so this covers only the adapter's own bookkeeping.
 */
export function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    /* see above */
  }
}

// ── Identity ─────────────────────────────────────────────────────────────
//
// Three carriers, tried in order, because Node's HTTP layers hand you three
// different places to put a value:
//
//   1. the request object — where an auth middleware already has the
//      partner in hand. It is the same object the adapter sees at the end
//      of the request, so *mount order does not matter*: a layer inside
//      this middleware can stamp it and still be seen.
//   2. an AsyncLocalStorage scope, for code with no request object to
//      stamp — an outgoing call, most obviously.
//   3. the X-EVPanda-* headers, which the outbound adapters strip before
//      dispatch so a partner never receives them.

/** The property both server-side carriers use on the request object. */
export const IDENTITY_KEY = "evpandaIdentity";

/**
 * Request headers the shipped resolver reads as a last fallback. Lowercase:
 * every adapter normalizes keys before the resolver runs, so
 * `X-EVPanda-Platform-Id` and `x-evpanda-platform-id` are equivalent on the
 * wire. The names carry `Platform.id`, `Platform.name`, `Platform.tenantId`
 * and `Platform.tenantName`.
 */
export const IDENTITY_HEADERS = {
  id: "x-evpanda-platform-id",
  name: "x-evpanda-platform-name",
  tenantId: "x-evpanda-tenant-id",
  tenantName: "x-evpanda-tenant-name",
} as const;

/**
 * The same names as a list. The outbound adapters strip these before
 * dispatch — `tenantId` and `tenantName` in particular describe your own
 * tenant, not the partner's.
 */
export const IDENTITY_HEADER_NAMES: readonly string[] =
  Object.values(IDENTITY_HEADERS);

const scope = new AsyncLocalStorage<Platform>();

/**
 * Stamp the partner's identity on a request object.
 *
 * Do it wherever you already look the partner up:
 *
 * ```ts
 * app.use((req, res, next) => {
 *   const partner = lookupPartner(req.headers.authorization);
 *   if (partner) setIdentity(req, { id: partner.id, name: partner.name });
 *   next();
 * });
 * ```
 *
 * The request is read when the response finishes, so this works whether
 * your auth layer runs outside the capture middleware or inside it.
 */
export function setIdentity(request: object, identity: Platform): void {
  (request as Record<string, unknown>)[IDENTITY_KEY] = identity;
}

/** The identity `setIdentity` stamped on a request object, if any. */
export function identityFrom(request: unknown): Platform | undefined {
  if (request == null || typeof request !== "object") return undefined;
  const value = (request as Record<string, unknown>)[IDENTITY_KEY];
  return isPlatform(value) ? value : undefined;
}

/**
 * Attribute every OCPI call made inside `fn` to `identity`.
 *
 * The natural way to attribute an outgoing call, where there is no request
 * object to stamp yet:
 *
 * ```ts
 * await useIdentity(partner, async () => {
 *   return client.post(`${partner.url}/sessions`, payload);
 * });
 * ```
 *
 * It is an `AsyncLocalStorage` underneath, so it follows the async call
 * chain rather than leaking to whatever else the event loop is running.
 */
export function useIdentity<T>(identity: Platform, fn: () => T): T {
  return scope.run(identity, fn);
}

/** The identity `useIdentity` is currently in scope for, if any. */
export function currentIdentity(): Platform | undefined {
  return scope.getStore();
}

/** The identity carried by the `X-EVPanda-*` headers, if any. */
export function identityFromHeaders(
  headers: Record<string, string>,
): Platform | undefined {
  const read = (key: string): string | undefined => {
    const v = headers[key]?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  const id = read(IDENTITY_HEADERS.id);
  const name = read(IDENTITY_HEADERS.name);
  if (id === undefined && name === undefined) return undefined;
  const platform: Platform = { id: id ?? "", name: name ?? "" };
  const tenantId = read(IDENTITY_HEADERS.tenantId);
  const tenantName = read(IDENTITY_HEADERS.tenantName);
  if (tenantId !== undefined) platform.tenantId = tenantId;
  if (tenantName !== undefined) platform.tenantName = tenantName;
  return platform;
}

function isPlatform(value: unknown): value is Platform {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as Platform).id === "string" &&
    typeof (value as Platform).name === "string"
  );
}

/** One request, as much of it as a resolver could want. */
export interface RequestInfo {
  /** The HTTP method, uppercased. */
  method: string;
  /**
   * The request URL as the host saw it — a path for inbound requests, an
   * absolute URL for outgoing ones.
   */
  url: string;
  /** Request headers, keys lowercased, repeats comma-joined. */
  requestHeaders: Record<string, string>;
  /**
   * Whatever the adapter's own carrier held: the value `setIdentity` put on
   * the request object, or an outbound adapter's per-call identity.
   */
  identity?: Platform;
  /**
   * The framework-native object, for a resolver that needs more than the
   * fields above.
   */
  context?: unknown;
}

/**
 * Derives the roaming partner's identity for one request. Returning
 * `undefined` — or an identity that fails validation — means the exchange
 * is not captured; the request itself is never blocked or altered because
 * of it.
 */
export type OCPIResolver = (info: RequestInfo) => Platform | undefined;

/**
 * What every adapter uses when no resolver is configured: the request
 * object first, then the `useIdentity` scope, then the `X-EVPanda-*`
 * headers. A request carrying none of the three is simply not captured —
 * no error, no partial record.
 */
export const defaultResolver: OCPIResolver = (info) =>
  info.identity ?? currentIdentity() ?? identityFromHeaders(info.requestHeaders);

/**
 * Run a resolver under a guard and validate what it returns. A resolver
 * that throws, returns undefined, or returns an invalid identity all mean
 * the same thing: skip capture for this request.
 */
export function resolve(
  resolver: OCPIResolver | undefined,
  info: RequestInfo,
): Platform | undefined {
  let identity: Platform | undefined;
  try {
    identity = (resolver ?? defaultResolver)(info);
  } catch {
    return undefined;
  }
  return validPlatform(identity) ? identity : undefined;
}

// ── Header normalization ─────────────────────────────────────────────────

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

/** The same normalization for outgoing (response) headers. */
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
