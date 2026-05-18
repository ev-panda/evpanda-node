/**
 * Customer-facing configuration — the COMPLETE surface.
 * Nothing outside this list is configurable in v1.
 */

import type { Protocol } from "./types.js";

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
  /**
   * Sent as X-API-Key. If empty, falls back to the EVPANDA_API_KEY env var;
   * one of the two must be set.
   */
  apiKey?: string;
  /**
   * The single protocol this client serves: "ocpi" or "ocpp". Required —
   * one agent runs for one network type; the other Capture* method is then
   * a no-op.
   */
  networkType: Protocol;

  /** Ring buffer slots. Worst-case mem = bufferCapacity × maxCaptureBytes. */
  bufferCapacity?: number;
  /** Per-body truncation cap in bytes. */
  maxCaptureBytes?: number;
  /** Worker flush cadence in ms; ~5–10s. */
  flushInterval?: number;
  /** close() drain deadline in ms. Default 10000; explicit value must be ≥ 5000. */
  drainTimeout?: number;
  /** Default "zstd". "zstd" needs the optional peer (else gzip fallback). */
  compression?: "gzip" | "zstd";

  /** Master log switch; default false (totally silent). */
  debug?: boolean;
  logger?: Logger;
}

/** Resolved config with defaults applied. */
export interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  networkType: Protocol;
  bufferCapacity: number;
  maxCaptureBytes: number;
  flushInterval: number;
  drainTimeout: number;
  compression: "gzip" | "zstd";
  debug: boolean;
  /**
   * Effective logger: undefined means silent (non-undefined only when
   * debug is true).
   */
  logger?: Logger;
}

export const DEFAULTS = {
  /** ≤ 1000 server batch cap is the flush trigger; capacity is larger. */
  bufferCapacity: 10_000,
  maxCaptureBytes: 64 * 1024,
  flushInterval: 5_000,
  drainTimeout: 10_000,
  compression: "zstd",
  debug: false,
} as const;

/** Fallback source for apiKey when config.apiKey is empty. */
const API_KEY_ENV_VAR = "EVPANDA_API_KEY";

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

export const resolveEndpoint = (raw: unknown): string => {
  const s = requireNonEmptyString(raw, "endpoint");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`${ERR}: 'endpoint' must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${ERR}: 'endpoint' must use http or https`);
  }
  return s.replace(/\/+$/, ""); // transport appends /v1/{protocol}
}

/**
 * config.apiKey, or the EVPANDA_API_KEY env var, or throws if neither is
 * set.
 */
export function resolveApiKey(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  const env = process.env[API_KEY_ENV_VAR];
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  throw new Error(
    `${ERR}: \`apiKey\` is required — set \`apiKey\` or the ${API_KEY_ENV_VAR} env var`,
  );
}

/** Required; exactly "ocpi" or "ocpp". */
export function resolveNetworkType(value: unknown): Protocol {
  if (value === "ocpi" || value === "ocpp") return value;
  throw new Error(
    `${ERR}: \`networkType\` is required and must be "ocpi" or "ocpp"`,
  );
}

/** undefined ⇒ "zstd"; otherwise must be exactly "gzip" or "zstd". */
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
  const debug = config.debug === true;
  // Effective logger: silent unless debug; debug without a logger uses
  // the console.
  const logger: Logger | undefined = debug
    ? (config.logger ?? console)
    : undefined;
  return {
    endpoint: resolveEndpoint(config.endpoint),
    apiKey: resolveApiKey(config.apiKey),
    networkType: resolveNetworkType(config.networkType),
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
      5_000,
    ),
    compression: resolveCompression(config.compression),
    debug,
    logger,
  };
}
