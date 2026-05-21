/**
 * Adapter — OCPI outbound (host → partner), fetch / undici.
 *
 * Returns a drop-in replacement for `globalThis.fetch`. It resolves identity
 * (ambient ALS first, then the `resolve` callback), clones request and
 * response, and reads both bodies in the *background* — the caller gets the
 * response without waiting on capture. Bodies are capped at `maxCaptureBytes`.
 *
 * The wrapper never alters the request or response and never throws into the
 * caller; a `baseFetch` network error propagates unchanged, no capture.
 */

import { readBridge } from "../../internal/bridge.js";
import { safeResolve } from "./resolver.js";

import type { Logger } from "../../config.js";
import type { OCPIResolver, RoamingIdentity } from "../../identity.js";
import type { OCPIClient } from "../client.js";
import type { CapturedHttp } from "../../types.js";

export interface OCPIFetchOptions {
  /**
   * Identity resolver. Required as a fallback even when `propagateIdentity`
   * is on — calls made outside an inbound request (cron jobs, app startup,
   * tests) have no ambient identity for the wrapper to pick up.
   */
  resolve: OCPIResolver;
}

/**
 * Wrap a fetch implementation. Pass the host's preferred fetch (typically
 * `globalThis.fetch`) and use the returned function as a drop-in
 * replacement.
 */
export function fetch(
  sdk: OCPIClient,
  baseFetch: typeof globalThis.fetch,
  opts: OCPIFetchOptions,
): typeof globalThis.fetch {
  const bridge = readBridge(sdk);
  // Inert SDK: skip every code path that touches the request or response.
  if (!bridge) return baseFetch;

  const { maxCaptureBytes, identityStore, logger } = bridge;
  const { resolve } = opts;

  // The signature mirrors the platform's `fetch`; we keep it permissive so
  // both Node and DOM lib typings are accepted by callers.
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    let request: Request;
    try {
      request = new Request(input, init);
    } catch {
      // `new Request` rejecting means the args are malformed — let the
      // underlying fetch surface the same error, don't double-throw here.
      return baseFetch(input, init);
    }

    // Identity: ambient (ALS) first, resolver second.
    let identity: RoamingIdentity | undefined;
    try {
      identity = identityStore?.current();
      identity ??= safeResolve(resolve, {
        method: request.method,
        url: request.url,
        headers: headersToRecord(request.headers),
      });
    } catch (err) {
      logger?.warn("@evpanda/sdk: OCPI fetch resolver failed", {
        error: String(err),
      });
      identity = undefined;
    }

    if (!identity) return baseFetch(request);

    // Clone the request before sending so the original's body stream
    // remains intact for the network. Both branches can be read
    // concurrently — undici buffers across the split.
    const reqClone = safeClone(request);
    const response = await baseFetch(request);
    const respClone = safeClone(response);

    // Background capture: the caller has its response already; this work
    // happens off the hot path and is swallowed on any fault.
    void captureInBackground(
      sdk,
      identity,
      request,
      response,
      reqClone,
      respClone,
      maxCaptureBytes,
      logger,
    );

    return response;
  };

  return wrapped;
}

/**
 * Read both bodies (capped), assemble `CapturedHttp`, hand off to the SDK.
 * Best-effort — any failure is swallowed; an oversize body on either side
 * drops the whole capture.
 */
async function captureInBackground(
  sdk: OCPIClient,
  identity: RoamingIdentity,
  request: Request,
  response: Response,
  reqClone: Request | undefined,
  respClone: Response | undefined,
  maxCaptureBytes: number,
  logger: Logger | undefined,
): Promise<void> {
  try {
    const [req, resp] = await Promise.all([
      readBodyCapped(reqClone?.body ?? null, maxCaptureBytes),
      readBodyCapped(respClone?.body ?? null, maxCaptureBytes),
    ]);
    if (req.overflowed || resp.overflowed) return; // drop entire capture
    const http: CapturedHttp = {
      method: request.method,
      url: request.url,
      statusCode: response.status,
      requestHeaders: headersToRecord(request.headers),
      responseHeaders: headersToRecord(response.headers),
      requestBody: req.body,
      responseBody: resp.body,
    };
    sdk.captureOutboundMessage({ identity, http });
  } catch (err) {
    logger?.warn("@evpanda/sdk: OCPI fetch capture failed", {
      error: String(err),
    });
  }
}

/** Result of a capped read. `overflowed: true` signals "drop the message". */
interface CappedRead {
  body?: Uint8Array;
  overflowed: boolean;
}

/**
 * Read a body stream, capped at `max` — flags overflow before a chunk that
 * would exceed it, so no more than `max` bytes are held. Then cancels the
 * reader. `null` body ⇒ no body; a mid-read throw ⇒ what was read so far.
 */
async function readBodyCapped(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<CappedRead> {
  if (!stream || max <= 0) return { overflowed: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflowed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (total + value.length > max) {
        overflowed = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } catch {
    /* fall through, return what we have */
  } finally {
    // cancel() detaches from the upstream tee branch so undici can release
    // it; it is best-effort, so we ignore failures.
    try {
      await reader.cancel();
    } catch {
      /* swallow */
    }
    reader.releaseLock();
  }
  if (overflowed) return { overflowed: true };
  if (total === 0) return { overflowed: false };
  if (chunks.length === 1) return { body: chunks[0], overflowed: false };
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { body: out, overflowed: false };
}

/** `Headers` → record with lowercase keys; multi-values are comma-joined by spec. */
function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** `clone()` guarded — a clone failure yields `undefined`, never an escape. */
function safeClone<T extends { clone(): T }>(value: T): T | undefined {
  try {
    return value.clone();
  } catch {
    return undefined;
  }
}
