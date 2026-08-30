/**
 * Adapter — OCPI outbound (host → partner), axios.
 *
 * Attaches a request + response interceptor pair to the customer's
 * `AxiosInstance` (returned for fluent wiring). The request hook resolves
 * identity via `resolve` and stashes it + the request body on the config;
 * the response hook assembles and ships the message. The error hook
 * captures non-2xx responses; pure network errors are not captured.
 *
 * Body bytes: `config.data` / `response.data` are axios's pre-/post-
 * serializer forms — objects are re-serialized to JSON, since that is what
 * crosses the wire for `application/json`.
 *
 * `axios` is an optional peer dependency — `import type` only, so the
 * runtime bundle never references it.
 */

import {
  IDENTITY_HEADERS,
  capturing,
  currentIdentity,
  resolve as resolveIdentity,
} from "./resolver.js";

import type {
  AxiosError,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import type { Capturer, Resolver } from "./resolver.js";
import type { HTTPExchange, Platform } from "../../types.js";

export interface OCPIAxiosOptions {
  /**
   * Identity resolver, invoked for every outbound request. Omitted ⇒ the
   * shipped `X-EVPanda-*` header reader.
   */
  resolver?: Resolver;
}

/** Carried on `config` from request → response so capture can re-assemble. */
const STASH = Symbol("evpanda.axios.stash");
interface Stash {
  identity: Platform;
  requestBody?: Uint8Array;
  /** Set when `config.data` already exceeded the cap at request time. */
  reqOverflowed: boolean;
}
type ConfigWithStash = InternalAxiosRequestConfig & { [STASH]?: Stash };

/**
 * Install OCPI capture on `instance`. Returns the same instance so callers
 * can chain or assign. Calling twice is a no-op only if the customer has
 * not removed interceptors in between — we do not deduplicate.
 */
export function axios(
  sdk: Capturer,
  instance: AxiosInstance,
  opts: OCPIAxiosOptions = {},
): AxiosInstance {
  // An inert client skips both interceptors entirely — zero overhead per
  // call.
  if (capturing(sdk) === undefined) return instance;

  instance.interceptors.request.use((config) => {
    // Interceptors cannot be unregistered, so a closed client is skipped
    // here instead.
    const maxCaptureBytes = capturing(sdk);
    if (maxCaptureBytes !== undefined) {
      try {
        const identity = resolveIdentity(opts.resolver, {
          method: (config.method ?? "get").toUpperCase(),
          url: safeGetUri(instance, config),
          requestHeaders: axiosHeadersToRecord(config.headers),
          identity: currentIdentity(),
          context: config,
        });
        if (identity) {
          const r = bodyToBytes(config.data, maxCaptureBytes);
          (config as ConfigWithStash)[STASH] = {
            identity,
            requestBody: r.body,
            reqOverflowed: r.overflowed,
          };
        }
      } catch {
        /* never block the outgoing request */
      }
    }
    // Outside the guard: strip even when resolution failed, so the identity
    // headers can never reach the partner.
    stripIdentityHeaders(config.headers);
    return config;
  });

  instance.interceptors.response.use(
    (response) => {
      const maxCaptureBytes = capturing(sdk);
      if (maxCaptureBytes !== undefined) {
        tryEmit(sdk, instance, response.config, response, maxCaptureBytes);
      }
      return response;
    },
    (error: AxiosError) => {
      // Only capture when the partner responded (non-2xx). Pass
      // `error.config` explicitly — do not mutate the customer's error.
      const maxCaptureBytes = capturing(sdk);
      if (maxCaptureBytes !== undefined && error.response && error.config) {
        tryEmit(sdk, instance, error.config, error.response, maxCaptureBytes);
      }
      return Promise.reject(error);
    },
  );

  return instance;
}

/** Read stash + assemble + emit. Any fault is swallowed (logged in debug). */
function tryEmit(
  sdk: Capturer,
  instance: AxiosInstance,
  config: InternalAxiosRequestConfig,
  response: AxiosResponse,
  maxCaptureBytes: number,
): void {
  try {
    const stash = (config as ConfigWithStash)[STASH];
    if (!stash) return;
    // Oversize either side ⇒ drop the whole message.
    if (stash.reqOverflowed) return;
    const resp = bodyToBytes(response.data, maxCaptureBytes);
    if (resp.overflowed) return;
    const data: HTTPExchange = {
      method: (config.method ?? "get").toUpperCase(),
      url: safeGetUri(instance, config),
      statusCode: response.status,
      requestHeaders: axiosHeadersToRecord(config.headers),
      responseHeaders: axiosHeadersToRecord(response.headers),
      requestBody: stash.requestBody,
      responseBody: resp.body,
    };
    sdk.captureOutboundMessage({ identity: stash.identity, data });
  } catch {
    /* a capture fault never reaches the caller */
  }
}

/** Full URL via `instance.getUri` (resolves baseURL + params), or `config.url`. */
function safeGetUri(
  instance: AxiosInstance,
  config: InternalAxiosRequestConfig,
): string {
  try {
    return instance.getUri(config);
  } catch {
    return config.url ?? "";
  }
}

/**
 * Remove the SDK's identity headers from an axios header bag before the
 * request goes out. `AxiosHeaders` exposes a case-insensitive `delete()`;
 * a plain object is swept case-insensitively by key.
 */
function stripIdentityHeaders(h: unknown): void {
  if (h == null || typeof h !== "object") return;
  const bag = h as {
    delete?: (name: string) => void;
  } & Record<string, unknown>;
  if (typeof bag.delete === "function") {
    for (const name of IDENTITY_HEADERS) bag.delete(name);
    return;
  }
  for (const key of Object.keys(bag)) {
    if (IDENTITY_HEADERS.includes(key.toLowerCase())) delete bag[key];
  }
}

/** Axios headers → flat record, lowercase keys; scalars coerced, arrays joined. */
function axiosHeadersToRecord(h: unknown): Record<string, string> {
  if (h == null || typeof h !== "object") return {};
  // AxiosHeaders exposes toJSON(); plain objects don't, fall back to spread.
  const obj =
    typeof (h as { toJSON?: () => unknown }).toJSON === "function"
      ? (h as { toJSON: () => Record<string, unknown> }).toJSON()
      : (h as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const s = headerValueToString(v);
    if (s !== undefined) out[k.toLowerCase()] = s;
  }
  return out;
}

/** Coerce a header value to a string; arrays are joined, objects dropped. */
function headerValueToString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  if (Array.isArray(v)) {
    const parts = v.map(headerValueToString).filter((x): x is string => x !== undefined);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
}

/** Result of encoding an axios body. `overflowed: true` ⇒ drop the message. */
interface BodyResult {
  body?: Uint8Array;
  overflowed: boolean;
}

/**
 * Coerce an axios body to bytes and apply the cap. Objects → JSON (matching
 * axios's `application/json` transformer); strings / Uint8Arrays as-is;
 * unsupported shapes (Stream, FormData, …) ⇒ no body (not an overflow).
 */
function bodyToBytes(data: unknown, max: number): BodyResult {
  if (data == null || max <= 0) return { overflowed: false };
  let buf: Uint8Array;
  if (data instanceof Uint8Array) {
    buf = data;
  } else {
    let s: string;
    if (typeof data === "string") {
      s = data;
    } else if (
      typeof data === "number" ||
      typeof data === "boolean" ||
      typeof data === "bigint"
    ) {
      s = String(data);
    } else if (typeof data === "object") {
      try {
        s = JSON.stringify(data);
      } catch {
        return { overflowed: false };
      }
    } else {
      return { overflowed: false };
    }
    buf = Buffer.from(s, "utf8");
  }
  if (buf.length > max) return { overflowed: true };
  return { body: buf, overflowed: false };
}
