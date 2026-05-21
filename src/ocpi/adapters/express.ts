/**
 * Adapter — OCPI inbound (partner → host), express/connect.
 *
 * Drop-in `(req, res, next)` middleware typed over `node:http`, so it needs
 * no peer dependency. Resolves identity, tees `res.write`/`res.end` for the
 * response body, and on `res 'finish'`/`'close'` ships a captured message.
 * No identity ⇒ pass through, no capture. Never throws into the host.
 *
 * Request body is read from `req.body` (whatever a body parser populated) —
 * the adapter never tees the raw request stream, since a `'data'` listener
 * would flip it to flowing mode and could starve the host's own parser.
 * `express.raw()` yields exact bytes; `express.json()` a re-serialized form.
 *
 * With `propagateIdentity: true` the resolved identity is set as the ambient
 * ALS value, so `ocpi.fetch` / `ocpi.axios` calls in the handler inherit it.
 */

import { readBridge } from "../../internal/bridge.js";
import {
  normalizeIncomingHeaders,
  normalizeOutgoingHeaders,
  safeResolve,
} from "./resolver.js";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../../config.js";
import type { OCPIResolver, RoamingIdentity } from "../../identity.js";
import type { OCPIClient } from "../client.js";
import type { CapturedHttp } from "../../types.js";

export interface OCPIExpressOptions {
  /** Identity resolver. Required — no default header reader is shipped. */
  resolve: OCPIResolver;
}

type Next = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

/** Express adds `originalUrl` (wire path) and `body` (parsed) onto the request. */
type ExpressRequest = IncomingMessage & {
  originalUrl?: string;
  body?: unknown;
};

/** The wire path: Express's `originalUrl`, falling back to `url`. */
function wirePath(req: IncomingMessage): string {
  return (req as ExpressRequest).originalUrl ?? req.url ?? "";
}

/** Returns an express/connect-compatible `(req, res, next)` middleware. */
export function express(sdk: OCPIClient, opts: OCPIExpressOptions): Middleware {
  const bridge = readBridge(sdk);
  // Inert SDK: cheapest possible pass-through. No resolver call, no patching.
  if (!bridge) return (_req, _res, next) => next();

  const { maxCaptureBytes, identityStore, logger } = bridge;
  const { resolve } = opts;

  return (req, res, next) => {
    let identity: RoamingIdentity | undefined;
    try {
      identity = safeResolve(resolve, {
        method: req.method ?? "",
        url: wirePath(req),
        headers: normalizeIncomingHeaders(req.headers),
      });
    } catch (err) {
      // safeResolve already guards; this is belt-and-braces.
      logger?.warn("@evpanda/sdk: OCPI express resolver failed", {
        error: String(err),
      });
      identity = undefined;
    }

    // No usable identity ⇒ pass through with no capture and no propagation.
    if (!identity) {
      next();
      return;
    }

    instrument(sdk, req, res, identity, maxCaptureBytes, logger);

    if (identityStore) {
      identityStore.run(identity, () => next());
    } else {
      next();
    }
  };
}

/**
 * Monkey-patch `res.write` / `res.end` to tee the response body, and
 * register the `finish` handler that ships the captured message. All steps
 * are isolated in a single try/catch so a wiring fault never blocks `next`.
 */
function instrument(
  sdk: OCPIClient,
  req: IncomingMessage,
  res: ServerResponse,
  identity: RoamingIdentity,
  maxCaptureBytes: number,
  logger: Logger | undefined,
): void {
  try {
    const resBody: CappedBody = { chunks: [], len: 0, overflowed: false };

    // Response body: tee write/end. We must call the originals with the
    // exact `this` and arguments so HTTP framing semantics are preserved.
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = function patchedWrite(
      this: ServerResponse,
      chunk: unknown,
      ...rest: unknown[]
    ): boolean {
      pushChunk(resBody, chunk, maxCaptureBytes, encodingFromArgs(rest));
      // The original signature is overloaded; the cast preserves it for callers.
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    } as ServerResponse["write"];

    res.end = function patchedEnd(
      this: ServerResponse,
      chunk?: unknown,
      ...rest: unknown[]
    ): ServerResponse {
      if (chunk != null && typeof chunk !== "function") {
        pushChunk(resBody, chunk, maxCaptureBytes, encodingFromArgs(rest));
      }
      return (origEnd as (...a: unknown[]) => ServerResponse)(chunk, ...rest);
    } as ServerResponse["end"];

    // `finish` fires on a clean response, `close` on every response (incl.
    // aborts). Listening to both captures aborted exchanges too; `shipped`
    // dedupes the case where both fire.
    let shipped = false;
    const ship = (): void => {
      if (shipped) return;
      shipped = true;
      try {
        const reqBody = requestBodyFrom(
          (req as ExpressRequest).body,
          maxCaptureBytes,
        );
        // Oversize either side ⇒ drop the whole message; a half-body is
        // broken JSON and would defeat the credentials redactor.
        if (reqBody.overflowed || resBody.overflowed) return;
        const http: CapturedHttp = {
          method: req.method ?? "",
          url: wirePath(req),
          // Omit the status when headers never went out — `res.statusCode`
          // would be Node's phantom default 200.
          statusCode: res.headersSent ? res.statusCode : undefined,
          requestHeaders: normalizeIncomingHeaders(req.headers),
          responseHeaders: normalizeOutgoingHeaders(res.getHeaders()),
          requestBody: reqBody.body,
          responseBody: bodyValue(resBody),
        };
        sdk.captureInboundMessage({ identity, http });
      } catch (err) {
        logger?.warn("@evpanda/sdk: OCPI inbound capture failed", {
          error: String(err),
        });
      }
    };
    res.on("finish", ship);
    res.on("close", ship);
  } catch (err) {
    logger?.warn("@evpanda/sdk: OCPI express instrumentation failed", {
      error: String(err),
    });
  }
}

/**
 * Captured request body from Express's parsed `req.body`: Buffer as-is,
 * string UTF-8 encoded, object re-serialized to JSON (an empty object is
 * "no body"). Oversize ⇒ `overflowed`, and the caller drops the message.
 */
function requestBodyFrom(
  body: unknown,
  max: number,
): { body?: Uint8Array; overflowed: boolean } {
  if (body == null) return { overflowed: false };
  let bytes: Uint8Array;
  if (body instanceof Uint8Array) {
    bytes = body;
  } else if (typeof body === "string") {
    bytes = Buffer.from(body, "utf8");
  } else if (typeof body === "object") {
    if (Object.keys(body).length === 0) return { overflowed: false };
    try {
      bytes = Buffer.from(JSON.stringify(body), "utf8");
    } catch {
      return { overflowed: false };
    }
  } else {
    return { overflowed: false };
  }
  if (bytes.length > max) return { overflowed: true };
  return { body: bytes, overflowed: false };
}

/** Bounded byte accumulator; flags overflow once the cap would be crossed. */
interface CappedBody {
  chunks: Uint8Array[];
  len: number;
  overflowed: boolean;
}

/**
 * Add a chunk; once a push would cross the cap, flag overflow and drop the
 * held chunks (the caller discards the whole capture anyway). No-op once
 * overflowed.
 */
function pushChunk(
  body: CappedBody,
  chunk: unknown,
  max: number,
  encoding?: BufferEncoding,
): void {
  if (body.overflowed || chunk == null) return;
  const buf = toBuffer(chunk, encoding);
  if (!buf || buf.length === 0) return;
  if (body.len + buf.length > max) {
    body.overflowed = true;
    body.chunks.length = 0;
    body.len = 0;
    return;
  }
  body.chunks.push(buf);
  body.len += buf.length;
}

/** Concatenate the accumulated chunks; undefined if nothing was captured. */
function bodyValue(body: CappedBody): Uint8Array | undefined {
  if (body.len === 0) return undefined;
  if (body.chunks.length === 1) return body.chunks[0];
  const out = new Uint8Array(body.len);
  let off = 0;
  for (const c of body.chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Coerce string/Buffer/Uint8Array into a Uint8Array; anything else ⇒ null. */
function toBuffer(
  chunk: unknown,
  encoding?: BufferEncoding,
): Uint8Array | null {
  if (chunk instanceof Uint8Array) return chunk; // Buffer extends Uint8Array
  if (typeof chunk === "string") {
    return Buffer.from(chunk, encoding ?? "utf8");
  }
  return null;
}

/** The encoding arg for write/end is the first trailing arg if it is a string. */
function encodingFromArgs(rest: unknown[]): BufferEncoding | undefined {
  return typeof rest[0] === "string" ? (rest[0] as BufferEncoding) : undefined;
}
