/**
 * The two stable capture primitives — the single chokepoint for both the
 * adapter and exotic-stack paths. Order: stamp protocol+capturedAt → validate
 * identity (invalid ⇒ drop) → redact → enqueue. May throw; the proxy isolates.
 */

import {
  validateChargerIdentity,
  validateRoamingIdentity,
} from "./identity.js";

import type { BufferedMessage, RingBuffer } from "./buffer.js";
import type { AnyMessage, OCPIMessage, OCPPMessage } from "./types.js";

export function captureOCPI(buffer: RingBuffer, msg: OCPIMessage): void {
  const capturedAt = new Date().toISOString();
  if (!validateRoamingIdentity(msg.identity)) return; // drop, never throw
  const env: BufferedMessage = {
    protocol: "ocpi",
    capturedAt,
    message: redact(msg),
  };
  buffer.enqueue(env);
}

export function captureOCPP(buffer: RingBuffer, msg: OCPPMessage): void {
  const capturedAt = new Date().toISOString();
  if (!validateChargerIdentity(msg.identity)) return; // drop, never throw
  const env: BufferedMessage = {
    protocol: "ocpp",
    capturedAt,
    message: redact(msg),
  };
  buffer.enqueue(env);
}

// ── Redaction (internal, always-on header denylist; no customer hook) ────

/** Always stripped (lowercase; matched case-insensitively). */
export const DEFAULT_HEADER_DENYLIST = [
  "authorization",
  "x-api-key",
  "cookie",
] as const;

const DENY = new Set<string>(DEFAULT_HEADER_DENYLIST);

/** Copy headers minus the denylisted ones (case-insensitive). */
function stripHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (!DENY.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Strip denylisted headers. Non-mutating (shallow copy); OCPP unchanged. */
export function redact(msg: AnyMessage): AnyMessage {
  if (!("http" in msg)) return msg; // OCPP: nothing to strip
  return {
    ...msg,
    http: {
      ...msg.http,
      requestHeaders: stripHeaders(msg.http.requestHeaders),
      responseHeaders: stripHeaders(msg.http.responseHeaders),
    },
  };
}
