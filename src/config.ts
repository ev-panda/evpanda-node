/**
 * Customer-facing configuration. The protocol is the class — there is no
 * `networkType` field. Common fields live on `BaseConfig`; per-protocol
 * extensions add fields only that protocol's client cares about.
 */

import type { Protocol } from "./types.js";

/** Optional injected logger. Never required. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Fields shared by every protocol's client. */
export interface BaseConfig {
  /** Ingestion API base, e.g. https://ingest.evpanda.io */
  endpoint: string;
  /**
   * Sent as X-API-Key. If empty, falls back to the EVPANDA_API_KEY env var;
   * one of the two must be set.
   */
  apiKey?: string;

  /** Ring buffer slots. Worst-case mem = bufferCapacity × maxCaptureBytes. */
  bufferCapacity?: number;
  /** Per-body / per-frame capture cap in bytes. */
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

/** Configuration for an OCPI roaming gateway client. */
export interface OCPIConfig extends BaseConfig {
  /** Opt-in: share the inbound-resolved identity with outbound adapters via ALS. */
  propagateIdentity?: boolean;
  /** Extra headers to capture on top of the default allowlist; can't disable defaults. */
  ocpiAllowedHeaders?: string[];
}

/** Configuration for an OCPP CSMS client. No protocol-specific fields today. */
export type OCPPConfig = BaseConfig;

// ── Resolved shapes — internal; clients build these from the user config ──

interface ResolvedBase {
  endpoint: string;
  apiKey: string;
  protocol: Protocol;
  bufferCapacity: number;
  maxCaptureBytes: number;
  flushInterval: number;
  drainTimeout: number;
  compression: "gzip" | "zstd";
  debug: boolean;
  /** Non-undefined only when debug is true. */
  logger?: Logger;
}

export interface ResolvedOCPIConfig extends ResolvedBase {
  protocol: "ocpi";
  propagateIdentity: boolean;
  ocpiAllowedHeaders: readonly string[];
}

export interface ResolvedOCPPConfig extends ResolvedBase {
  protocol: "ocpp";
}

/** Union the worker / transport accept — they only read the base fields. */
export type ResolvedConfig = ResolvedOCPIConfig | ResolvedOCPPConfig;

const DEFAULTS = {
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

/** Warn sink for the tunable-field resolvers; logs only when `debug: true`. */
type Warn = (msg: string) => void;

/** Build the warn sink — silent unless `debug` is on. */
function makeWarn(config: BaseConfig): Warn {
  const logger: Logger | undefined =
    config.debug === true ? (config.logger ?? console) : undefined;
  return (msg) => {
    // A malformed customer logger must not fail config resolution.
    try {
      logger?.warn(`${ERR}: ${msg}`);
    } catch {
      /* ignore */
    }
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${ERR}: \`${field}\` is required and must be a non-empty string`,
    );
  }
  return value.trim();
}

/** undefined or invalid (non-integer / below min) ⇒ fallback (+ warn). */
function resolveInt(
  value: number | undefined,
  fallback: number,
  field: string,
  min: number,
  warn: Warn,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    warn(`\`${field}\` must be an integer >= ${min}; using default ${fallback}`);
    return fallback;
  }
  return value;
}

const resolveEndpoint = (raw: unknown): string => {
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
};

/**
 * config.apiKey, or the EVPANDA_API_KEY env var, or throws if neither is
 * set.
 */
function resolveApiKey(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  const env = process.env[API_KEY_ENV_VAR];
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  throw new Error(
    `${ERR}: \`apiKey\` is required — set \`apiKey\` or the ${API_KEY_ENV_VAR} env var`,
  );
}

/** undefined or invalid ⇒ "zstd" default (+ warn); else the given codec. */
function resolveCompression(value: unknown, warn: Warn): "gzip" | "zstd" {
  if (value === undefined) return DEFAULTS.compression;
  if (value === "gzip" || value === "zstd") return value;
  warn(
    `\`compression\` must be "gzip" or "zstd"; using default ${DEFAULTS.compression}`,
  );
  return DEFAULTS.compression;
}

/**
 * Resolve the shared fields. `endpoint` / `apiKey` are hard-required — a bad
 * value throws (⇒ inert SDK); tunable fields fall back to their default.
 */
function resolveBase<P extends Protocol>(
  config: BaseConfig,
  protocol: P,
): ResolvedBase & { protocol: P } {
  if (config === null || typeof config !== "object") {
    throw new Error(`${ERR}: a config object is required`);
  }
  const debug = config.debug === true;
  const logger: Logger | undefined = debug
    ? (config.logger ?? console)
    : undefined;
  const warn = makeWarn(config);
  return {
    endpoint: resolveEndpoint(config.endpoint),
    apiKey: resolveApiKey(config.apiKey),
    protocol,
    bufferCapacity: resolveInt(
      config.bufferCapacity,
      DEFAULTS.bufferCapacity,
      "bufferCapacity",
      1,
      warn,
    ),
    maxCaptureBytes: resolveInt(
      config.maxCaptureBytes,
      DEFAULTS.maxCaptureBytes,
      "maxCaptureBytes",
      1,
      warn,
    ),
    flushInterval: resolveInt(
      config.flushInterval,
      DEFAULTS.flushInterval,
      "flushInterval",
      1,
      warn,
    ),
    drainTimeout: resolveInt(
      config.drainTimeout,
      DEFAULTS.drainTimeout,
      "drainTimeout",
      5_000,
      warn,
    ),
    compression: resolveCompression(config.compression, warn),
    debug,
    logger,
  };
}

export function resolveOCPIConfig(config: OCPIConfig): ResolvedOCPIConfig {
  return {
    ...resolveBase(config, "ocpi"),
    propagateIdentity: config.propagateIdentity === true,
    ocpiAllowedHeaders: resolveOCPIAllowedHeaders(
      config.ocpiAllowedHeaders,
      makeWarn(config),
    ),
  };
}

export function resolveOCPPConfig(config: OCPPConfig): ResolvedOCPPConfig {
  return resolveBase(config, "ocpp");
}

/**
 * Coerce to a trimmed, lowercased, deduplicated, immutable list. A
 * non-array value falls back to `[]` (+ warn); a non-string entry is
 * skipped (+ warn) so the good entries still apply.
 */
function resolveOCPIAllowedHeaders(
  value: unknown,
  warn: Warn,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warn("`ocpiAllowedHeaders` must be a string array; ignoring it");
    return [];
  }
  const out = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") {
      warn("`ocpiAllowedHeaders` entries must be strings; skipping one");
      continue;
    }
    const trimmed = v.trim().toLowerCase();
    if (trimmed) out.add(trimmed);
  }
  return Object.freeze([...out]);
}
