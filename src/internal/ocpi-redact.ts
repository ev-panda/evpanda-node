/**
 * OCPI redaction, applied at the capture chokepoint. Two rules:
 *
 *   1. Header allowlist — only listed headers are kept; Authorization,
 *      Cookie, X-API-Key, etc. fall off the end. `ocpiAllowedHeaders`
 *      extends the list, never shrinks it.
 *   2. Credentials-endpoint token mask — on a `/credentials` URL the
 *      `token` field (root for requests, under `data` for the response
 *      envelope) is replaced with `[redacted]`.
 */

import type { CapturedHttp, OCPIMessage } from "../types.js";

/** Stock OCPI headers safe to capture — none of these can carry a secret. */
const DEFAULT_OCPI_HEADER_ALLOWLIST: readonly string[] = [
  // OCPI routing
  "ocpi-from-country-code",
  "ocpi-from-party-id",
  "ocpi-to-country-code",
  "ocpi-to-party-id",
  // Content negotiation + standard HTTP
  "content-type",
  "accept",
  "user-agent",
  // Tracing
  "x-correlation-id",
  "x-request-id",
  // Pagination
  "x-total-count",
  "x-limit",
  "link",
];

/** Placeholder string written in place of redacted token values. */
const TOKEN_PLACEHOLDER = "[redacted]";

/** Pure transform applied to an OCPI message right before enqueue. */
export type OCPIRedactor = (msg: OCPIMessage) => OCPIMessage;

/**
 * URL ends with `/credentials`, `/credentials/`, or `/credentials?...`.
 * Sub-paths like `/credentials/foo` don't match — no such OCPI route.
 */
const CREDENTIALS_URL = /\/credentials\/?(?:\?|$)/i;

/**
 * Build a redactor closure from the resolved config. Called once at SDK
 * construction; the allowlist `Set` is amortized across every message.
 */
export function makeOCPIRedactor(
  extraAllowedHeaders: readonly string[] = [],
): (msg: OCPIMessage) => OCPIMessage {
  const allow = new Set<string>(
    [...DEFAULT_OCPI_HEADER_ALLOWLIST, ...extraAllowedHeaders].map((h) =>
      h.toLowerCase(),
    ),
  );
  return (msg) => ({ ...msg, http: redactHttp(msg.http, allow) });
}

/** Apply the allowlist + credentials-token mask to a captured HTTP envelope. */
function redactHttp(http: CapturedHttp, allow: Set<string>): CapturedHttp {
  return {
    ...http,
    requestHeaders: filterHeaders(http.requestHeaders, allow),
    responseHeaders: filterHeaders(http.responseHeaders, allow),
    requestBody: maskCredentialsToken(http.requestBody, http.url),
    responseBody: maskCredentialsToken(http.responseBody, http.url),
  };
}

/** Keep only allowlisted headers; case-insensitive on the key. */
function filterHeaders(
  h: Record<string, string>,
  allow: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (allow.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Mask `token` in an OCPI credentials body. Returns original bytes on any
 * miss (non-credentials URL, non-JSON, no token at either known path,
 * re-encode error) — redaction never silently drops data it couldn't
 * safely rewrite.
 */
function maskCredentialsToken(
  body: Uint8Array | undefined,
  url: string,
): Uint8Array | undefined {
  if (!body?.length || !CREDENTIALS_URL.test(url)) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(body));
  } catch {
    return body;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return body;
  }

  // Token lives at the root (request) or under `data` (response envelope).
  // We own `parsed` — no external alias — so we mutate in place.
  const root = parsed as { token?: unknown; data?: unknown };
  if (typeof root.token === "string" && root.token.length > 0) {
    root.token = TOKEN_PLACEHOLDER;
  } else if (isCredentialsData(root.data)) {
    root.data.token = TOKEN_PLACEHOLDER;
  } else {
    return body;
  }

  try {
    return new TextEncoder().encode(JSON.stringify(parsed));
  } catch {
    return body;
  }
}

/** Narrowing guard: `data` is an object with a non-empty string `token`. */
function isCredentialsData(
  data: unknown,
): data is { token: string } & Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const token = (data as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0;
}
