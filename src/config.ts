/**
 * Customer-facing configuration — the COMPLETE surface.
 * Nothing outside this list is configurable in v1.
 */

/** Optional injected logger. Never required. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// Not configurable here (by design): identity & protocol are per-message;
// redaction is the internal always-on denylist (no customer hook).

export interface EVPandaConfig {
  /** Ingestion API base, e.g. https://ingest.evpanda.io */
  endpoint: string;
  /** Sent as X-API-Key. */
  apiKey: string;

  /** Ring buffer slots. Worst-case mem = bufferCapacity × maxCaptureBytes. */
  bufferCapacity?: number;
  /** Per-body truncation cap in bytes. */
  maxCaptureBytes?: number;
  /** Worker flush cadence in ms; ~5–10s. */
  flushInterval?: number;
  /** close() drain deadline in ms. */
  drainTimeout?: number;
  /** Default "gzip". "zstd" needs the optional peer (else gzip fallback). */
  compression?: "gzip" | "zstd";

  /** Master log switch; default false (totally silent). */
  debug?: boolean;
  logger?: Logger;
}

/** Resolved config with defaults applied. */
export type ResolvedConfig = Required<Omit<EVPandaConfig, "logger">> &
  Pick<EVPandaConfig, "logger">;

export const DEFAULTS = {
  /** ≤ 1000 server batch cap is the flush trigger; capacity is larger. */
  bufferCapacity: 10_000,
  maxCaptureBytes: 64 * 1024,
  flushInterval: 5_000,
  drainTimeout: 10_000,
  compression: "gzip",
  debug: false,
} as const;

const ERR = "@evpanda/sdk config";

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${ERR}: \`${field}\` is required and must be a non-empty string`,
    );
  }
  return value.trim();
}

/** undefined ⇒ fallback; otherwise must be an integer ≥ min. */
export function resolveInt(
  value: number | undefined,
  fallback: number,
  field: string,
  min: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${ERR}: \`${field}\` must be an integer >= ${min}`);
  }
  return value;
}

export function resolveEndpoint(raw: unknown): string {
  const s = requireNonEmptyString(raw, "endpoint");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`${ERR}: `endpoint` must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${ERR}: `endpoint` must use http or https`);
  }
  return s.replace(/\/+$/, ""); // transport appends /v1/{protocol}
}

/** undefined ⇒ "gzip"; otherwise must be exactly "gzip" or "zstd". */
export function resolveCompression(value: unknown): "gzip" | "zstd" {
  if (value === undefined) return DEFAULTS.compression;
  if (value === "gzip" || value === "zstd") return value;
  throw new Error(`${ERR}: \`compression\` must be "gzip" or "zstd"`);
}

/** Apply DEFAULTS and validate. The only place the SDK throws. */
export function resolveConfig(config: EVPandaConfig): ResolvedConfig {
  if (config === null || typeof config !== "object") {
    throw new Error(`${ERR}: a config object is required`);
  }
  return {
    endpoint: resolveEndpoint(config.endpoint),
    apiKey: requireNonEmptyString(config.apiKey, "apiKey"),
    bufferCapacity: resolveInt(
      config.bufferCapacity,
      DEFAULTS.bufferCapacity,
      "bufferCapacity",
      1,
    ),
    maxCaptureBytes: resolveInt(
      config.maxCaptureBytes,
      DEFAULTS.maxCaptureBytes,
      "maxCaptureBytes",
      1,
    ),
    flushInterval: resolveInt(
      config.flushInterval,
      DEFAULTS.flushInterval,
      "flushInterval",
      1,
    ),
    drainTimeout: resolveInt(
      config.drainTimeout,
      DEFAULTS.drainTimeout,
      "drainTimeout",
      0,
    ),
    compression: resolveCompression(config.compression),
    debug: config.debug === true,
    logger: config.logger,
  };
}
