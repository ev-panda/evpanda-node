/**
 * Customer-facing configuration.
 *
 * The protocol is the client — there is no network-type field. Common
 * fields live on `BaseConfig`; per-protocol configs add only what that
 * protocol's client cares about.
 *
 * `apiKey` is the one field with no usable default, so a missing key fails
 * `startOCPI` / `startOCPP` (which hand back an inert client carrying the
 * error). A malformed `endpoint` fails the same way — but an empty one is
 * not malformed, it just means production. Every other field is tunable: a
 * bad value falls back to its default and says so in the host's logs, so a
 * typo can never silence the SDK entirely.
 *
 * Durations are milliseconds, which is what `setTimeout` and every other
 * Node API speak.
 */

import type { Protocol } from "./types.js";

/** Optional injected logger. Never required. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * How much the SDK says for itself. Unset means the `EVPANDA_LOG`
 * environment variable decides, and failing that `"errors"`.
 *
 * The default is deliberately not silence. An SDK that captures nothing
 * because its identity resolution is misconfigured looks exactly like an
 * SDK on an idle system, and a customer should not have to redeploy with a
 * debug flag to tell those apart. What it will not do is log per event:
 * problems are summarized once a minute, so a fault that occurs on every
 * request still costs one line, and a healthy client says nothing at all.
 *
 * - `"silent"` — nothing, ever. `stats()` keeps working.
 * - `"errors"` — the default: config problems at startup, plus a
 *   once-a-minute summary whenever captures are being dropped.
 * - `"debug"` — adds per-batch delivery failures, swallowed capture faults,
 *   and a summary on close even when nothing went wrong.
 */
export type LogMode = "silent" | "errors" | "debug";

/**
 * Lets an operator change the setting without a code change — including
 * turning the SDK silent during an incident, which is the case that most
 * needs a restart-only escape hatch.
 */
export const LOG_MODE_ENV_VAR = "EVPANDA_LOG";

/** The fallback source for `apiKey` when the config field is empty. */
export const API_KEY_ENV_VAR = "EVPANDA_API_KEY";

/**
 * The production ingestion API. A host that never sets `endpoint` reaches
 * it, which is what almost every host wants; staging deployments set the
 * field.
 */
export const DEFAULT_ENDPOINT = "https://ingest.evpanda.io";

// ── Errors ───────────────────────────────────────────────────────────────
//
// startOCPI / startOCPP never throw: the client they return carries the
// failure on `.error`. The class hierarchy is what `errors.Is` gives the Go
// SDK — match ConfigError for any configuration fault, or one of the two
// subclasses to tell a deployment problem (no key) from a code one (bad
// endpoint).

/** Base class for every error this SDK produces. */
export class EVPandaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A configuration fault. Both specific config errors extend it. */
export class ConfigError extends EVPandaError {}

/** No API key was found in the config or `EVPANDA_API_KEY`. */
export class ApiKeyError extends ConfigError {}

/** `endpoint` is not a valid http(s) URL. An empty one is not an error. */
export class EndpointError extends ConfigError {}

// ── Configuration ────────────────────────────────────────────────────────

/** Fields shared by `OCPIConfig` and `OCPPConfig`. */
export interface BaseConfig {
  /**
   * Ingestion API base. Omitted uses the production default,
   * `https://ingest.evpanda.io`; set it to reach a different environment.
   * A non-empty value must be a valid http(s) URL.
   */
  endpoint?: string;
  /**
   * Sent as the `X-API-Key` header. If omitted it falls back to the
   * `EVPANDA_API_KEY` environment variable; one of the two must be set.
   */
  apiKey?: string;

  /**
   * The ceiling on everything held in memory awaiting delivery. Past it the
   * oldest captures are evicted, so this is the SDK's memory footprint, not
   * an estimate of it. Omitted uses the default (32 MiB); the buffer grows
   * on demand and idles far below it.
   */
  maxBufferBytes?: number;
  /**
   * The per-body / per-frame capture cap, enforced at capture: an oversize
   * body or frame drops the whole message. Omitted uses the default
   * (65536).
   */
  maxCaptureBytes?: number;
  /** Maximum milliseconds between flushes. Omitted uses the default (5000). */
  flushInterval?: number;
  /**
   * How many milliseconds `close()` waits to drain buffered messages.
   * Omitted uses the default (10000); an explicit value must be >= 5000.
   */
  drainTimeout?: number;
  /**
   * How much the SDK logs. Omitted consults `EVPANDA_LOG`, then falls back
   * to `"errors"`.
   */
  logMode?: LogMode;
  /** Receives the SDK's own logs. Omitted uses `console`. */
  logger?: Logger;
}

/** Configuration for `startOCPI`. */
export interface OCPIConfig extends BaseConfig {
  /**
   * Extends the default capture allowlist with additional header names
   * (matched case-insensitively). It can only extend the list, never shrink
   * it.
   */
  ocpiAllowedHeaders?: string[];
}

/** Configuration for `startOCPP`. No protocol-specific fields today. */
export type OCPPConfig = BaseConfig;

/**
 * A config with defaults applied and validation passed. Internal: it is
 * what the worker and the transport read.
 */
export interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  protocol: Protocol;
  maxBufferBytes: number;
  maxCaptureBytes: number;
  flushInterval: number;
  drainTimeout: number;
  logMode: LogMode;
  /**
   * The effective logger: undefined exactly when `logMode` is `"silent"`,
   * so an undefined check is the only silence test callers need.
   */
  logger: Logger | undefined;
  /** The lowercased extra allowlist (OCPI only). */
  allowedHeaders: readonly string[];
}

// ── Defaults and bounds ──────────────────────────────────────────────────

/**
 * `maxBufferBytes` covers roughly one full retry window of a
 * 10 000-charger CSMS (~400 msg/s at ~500 B) — enough to ride out a blip,
 * small enough to sit inside an ordinary container limit.
 */
export const DEFAULTS = {
  maxBufferBytes: 32 * 1024 * 1024,
  maxCaptureBytes: 64 * 1024,
  flushInterval: 5_000,
  drainTimeout: 10_000,
} as const;

/** One default-sized capture; below it the buffer could not hold one message. */
export const MIN_MAX_BUFFER_BYTES = 64 * 1024;
export const MIN_FLUSH_INTERVAL = 1;
export const MIN_DRAIN_TIMEOUT = 5_000;

const ERR = "evpanda: config";

// ── Resolution ───────────────────────────────────────────────────────────

/**
 * The sink the tunable-field resolvers report to. A no-op when the resolved
 * logger is undefined (silent), which keeps the silence rule in one place.
 * A host logger that throws must not fail config resolution either.
 */
type Warn = (msg: string) => void;

function makeWarn(logger: Logger | undefined): Warn {
  return (msg) => {
    try {
      logger?.warn(`${ERR}: ${msg}`);
    } catch {
      /* a broken host logger is not our failure */
    }
  };
}

const LOG_MODES: readonly LogMode[] = ["silent", "errors", "debug"];

function isLogMode(value: unknown): value is LogMode {
  return (
    typeof value === "string" && LOG_MODES.includes(value.trim() as LogMode)
  );
}

/**
 * Apply the config field, then the environment, then the default. An
 * unrecognised value in either falls back to `"errors"` — a typo must not
 * silence the SDK, which is the whole point of the default.
 *
 * Config wins over the environment, matching how `apiKey` resolves. Since
 * most hosts never set the field, `EVPANDA_LOG` still reaches almost every
 * deployment, which is what makes it usable as an incident escape hatch.
 */
export function resolveLogMode(value: unknown): {
  mode: LogMode;
  warning?: string;
} {
  const quoted = LOG_MODES.map((m) => `"${m}"`).join(", ");
  if (value !== undefined) {
    if (isLogMode(value)) return { mode: value.trim() as LogMode };
    return {
      mode: "errors",
      warning: `\`logMode\` must be one of ${quoted}; using "errors"`,
    };
  }
  const env = process.env[LOG_MODE_ENV_VAR]?.trim().toLowerCase();
  if (env === undefined || env === "") return { mode: "errors" };
  if (isLogMode(env)) return { mode: env };
  return {
    mode: "errors",
    warning: `${LOG_MODE_ENV_VAR} must be one of ${quoted}; using "errors"`,
  };
}

/**
 * The logger to use, or undefined when the mode is silent. An undefined
 * logger is the single signal for "say nothing".
 */
export function effectiveLogger(
  logger: Logger | undefined,
  mode: LogMode,
): Logger | undefined {
  if (mode === "silent") return undefined;
  return logger ?? console;
}

/** The configured key, or `EVPANDA_API_KEY`, or throw. */
function resolveApiKey(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  const env = process.env[API_KEY_ENV_VAR];
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  throw new ApiKeyError(
    `${ERR}: no API key — set \`apiKey\` or the ${API_KEY_ENV_VAR} environment variable`,
  );
}

/**
 * Default an empty value to production, else require a valid http(s) URL.
 * Trailing slashes are trimmed; the transport appends `/v1/{protocol}`.
 */
export function resolveEndpoint(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_ENDPOINT;
  if (typeof raw !== "string") {
    throw new EndpointError(`${ERR}: \`endpoint\` must be a string`);
  }
  const value = raw.trim();
  if (value === "") return DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EndpointError(`${ERR}: \`endpoint\` "${value}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EndpointError(
      `${ERR}: \`endpoint\` "${value}" must use http or https`,
    );
  }
  return value.replace(/\/+$/, "");
}

/**
 * Undefined, the wrong type, or below the minimum ⇒ the default (with a
 * warning on the last two).
 */
function resolveInt(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  warn: Warn,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    warn(`\`${field}\` must be an integer; using default ${fallback}`);
    return fallback;
  }
  if (value < min) {
    warn(`\`${field}\` must be >= ${min}; using default ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * Trim, lowercase and deduplicate (preserving order), skipping empties. A
 * non-array is ignored with a warning, so one mistyped field cannot take
 * the allowlist down with it.
 */
function resolveAllowedHeaders(value: unknown, warn: Warn): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warn("`ocpiAllowedHeaders` must be a string array; ignoring it");
    return [];
  }
  const out = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      warn("`ocpiAllowedHeaders` entries must be strings; skipping one");
      continue;
    }
    const name = entry.trim().toLowerCase();
    if (name) out.add(name);
  }
  return Object.freeze([...out]);
}

/**
 * Apply defaults and validate the shared fields. Only `endpoint` and
 * `apiKey` can fail.
 */
function resolveBase(config: BaseConfig, protocol: Protocol): ResolvedConfig {
  if (config === null || typeof config !== "object") {
    throw new ConfigError(`${ERR}: a config object is required`);
  }
  const { mode, warning } = resolveLogMode(config.logMode);
  const logger = effectiveLogger(config.logger, mode);
  const warn = makeWarn(logger);
  if (warning !== undefined) warn(warning);

  const resolved: ResolvedConfig = {
    endpoint: resolveEndpoint(config.endpoint),
    apiKey: resolveApiKey(config.apiKey),
    protocol,
    maxBufferBytes: resolveInt(
      config.maxBufferBytes,
      DEFAULTS.maxBufferBytes,
      "maxBufferBytes",
      MIN_MAX_BUFFER_BYTES,
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
      MIN_FLUSH_INTERVAL,
      warn,
    ),
    drainTimeout: resolveInt(
      config.drainTimeout,
      DEFAULTS.drainTimeout,
      "drainTimeout",
      MIN_DRAIN_TIMEOUT,
      warn,
    ),
    logMode: mode,
    logger,
    allowedHeaders: [],
  };

  // Both values are individually legal but nonsensical together: a capture
  // at the per-message cap would never fit in the buffer, so every large
  // message would be dropped after being redacted.
  if (resolved.maxBufferBytes < resolved.maxCaptureBytes) {
    warn(
      `\`maxBufferBytes\` (${resolved.maxBufferBytes}) is below \`maxCaptureBytes\` ` +
        `(${resolved.maxCaptureBytes}); a full-size capture can never be buffered`,
    );
  }
  return resolved;
}

/** Resolve an `OCPIConfig`. Throws a `ConfigError` on a hard fault. */
export function resolveOCPIConfig(config: OCPIConfig): ResolvedConfig {
  const base = resolveBase(config, "ocpi");
  return {
    ...base,
    allowedHeaders: resolveAllowedHeaders(
      config.ocpiAllowedHeaders,
      makeWarn(base.logger),
    ),
  };
}

/** Resolve an `OCPPConfig`. Throws a `ConfigError` on a hard fault. */
export function resolveOCPPConfig(config: OCPPConfig): ResolvedConfig {
  return resolveBase(config, "ocpp");
}

/**
 * The logger a config would use, without validating anything else.
 * `startOCPI` / `startOCPP` need it on the one path where there is no
 * resolved config to read it from: reporting the fault that stopped the
 * config from resolving at all.
 */
export function loggerFor(config: BaseConfig): Logger | undefined {
  const { mode } = resolveLogMode(config?.logMode);
  return effectiveLogger(config?.logger, mode);
}
