/**
 * Hand-rolled transport over Node 18+ global fetch. Body: JSON; zstd by
 * default, gzip when configured, identity for tiny payloads. Owns the
 * bounded retry: 200 or 400/401/413 → done; 5xx/network → backoff; the
 * caller never retries. Never throws.
 */

import { gzip } from "node:zlib";
import { promisify } from "node:util";

import { compress as zstdCompress } from "@mongodb-js/zstd";

import type { BufferedMessage } from "./buffer.js";
import type { Logger, ResolvedConfig } from "./config.js";
import type { OCPIMessage, OCPPMessage, Protocol } from "./types.js";

const gzipAsync = promisify(gzip);

// ── Backoff (module-private, fixed by design — not configurable) ─────────

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MAX_ATTEMPTS = 5;

/**
 * Delay (ms) before attempt n (0-indexed). null ⇒ attempts exhausted.
 * Capped exponential with full jitter.
 */
export function nextDelay(attempt: number): number | null {
  if (attempt >= BACKOFF_MAX_ATTEMPTS) return null;
  const capped = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * capped);
}

// ── API client ───────────────────────────────────────────────
//
// The inner "client": a 1:1 wrapper over the two ingestion endpoints.
// TRANSPORT ONLY — no buffering, no retry policy, no telemetry. Hand-rolled
// over global fetch; no generated client (would pull heavy transitive deps
// into customer production for two endpoints).

export interface ApiClientOptions {
  endpoint: string;
  apiKey: string;
}

/** Per-attempt request cap so a hung connection still feeds the backoff. */
const REQUEST_TIMEOUT_MS = 30_000;

export class ApiClient {
  constructor(private readonly _opts: ApiClientOptions) {}

  /** Single POST /v1/{protocol}; drains the body, returns the status. */
  async post(
    protocol: Protocol,
    body: Uint8Array,
    encoding: ContentEncoding,
  ): Promise<number> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this._opts.apiKey,
    };
    if (encoding !== "identity") headers["content-encoding"] = encoding;

    const res = await fetch(`${this._opts.endpoint}/v1/${protocol}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await res.text(); // drain so the socket can be released; body unused
    return res.status;
  }
}

// ── Transport ────────────────────────────────────────────────

export type ContentEncoding = "identity" | "gzip" | "zstd";

/** Below this raw size, compression isn't worth the CPU; send identity. */
const COMPRESS_MIN_BYTES = 1024;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Ingestion wire records ───────────────────────────────────────────────
//
// ocpiIngest / ocppIngest are the exact request payload shapes the ingestion
// service accepts. Keep them in lock-step with that service (and the Go SDK).

// Optional fields are `T | null` (present, value null) — an absent value
// serializes as JSON null, never a zero value or an omitted key, matching
// the Go SDK's non-omitempty pointer fields.

interface OcpiIngest {
  captured_at: string;
  platform_id: string;
  platform_name: string;
  tenant_id: string | null;
  tenant_name: string | null;
  direction: string;
  http_method: string;
  url: string;
  response_status_code: number | null;
  request_headers: Record<string, string> | null;
  request_body: string | null;
  response_headers: Record<string, string> | null;
  response_body: string | null;
}

interface OcppIngest {
  charger_id: string;
  connection_id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  captured_at: string;
  event_type: number;
  direction: string | null;
  raw_frame: string | null;
}

interface IngestBody {
  messages: (OcpiIngest | OcppIngest)[];
}

/** Header map for the wire, or null when empty. */
function headersJSON(
  h: Record<string, string> | undefined,
): Record<string, string> | null {
  if (h === undefined || Object.keys(h).length === 0) return null;
  return h;
}

/** base64-encode a body/frame, or null when empty. */
function bodyB64(b: Uint8Array | undefined): string | null {
  if (b === undefined || b.byteLength === 0) return null;
  return Buffer.from(b).toString("base64");
}

/** Non-empty string, or null. */
function optStr(s: string | undefined): string | null {
  return s === undefined || s === "" ? null : s;
}

/** Non-zero number, or null (0 is treated as absent, matching Go). */
function optInt(n: number | undefined): number | null {
  return n === undefined || n === 0 ? null : n;
}

function isOCPI(m: OCPIMessage | OCPPMessage): m is OCPIMessage {
  return "http" in m;
}

function ocpiRecord(e: BufferedMessage, m: OCPIMessage): OcpiIngest {
  return {
    captured_at: e.capturedAt,
    platform_id: m.identity.platformId,
    platform_name: m.identity.platformName,
    tenant_id: optStr(m.identity.tenantId),
    tenant_name: optStr(m.identity.tenantName),
    direction: m.direction,
    http_method: m.http.method,
    url: m.http.url,
    response_status_code: optInt(m.http.statusCode),
    request_headers: headersJSON(m.http.requestHeaders),
    request_body: bodyB64(m.http.requestBody),
    response_headers: headersJSON(m.http.responseHeaders),
    response_body: bodyB64(m.http.responseBody),
  };
}

function ocppRecord(e: BufferedMessage, m: OCPPMessage): OcppIngest {
  return {
    charger_id: m.identity.chargerId,
    connection_id: m.connectionId,
    tenant_id: optStr(m.identity.tenantId),
    tenant_name: optStr(m.identity.tenantName),
    captured_at: e.capturedAt,
    event_type: m.eventType,
    direction: optStr(m.direction),
    raw_frame: bodyB64(m.payload),
  };
}

/**
 * Envelope[] → JSON request body `{"messages":[<record>,...]}`. Each
 * message is mapped to the flat snake_case ingestion record by kind; bodies
 * are base64 of the Uint8Array. Wire shape must match the ingestion service.
 */
export function serialize(batch: BufferedMessage[]): Uint8Array {
  const messages: (OcpiIngest | OcppIngest)[] = batch.map((e) =>
    isOCPI(e.message)
      ? ocpiRecord(e, e.message)
      : ocppRecord(e, e.message),
  );
  const body: IngestBody = { messages };
  // Optional fields are explicit null (never undefined), so every key is
  // present — matching the Go SDK's non-omitempty pointer fields.
  const json = JSON.stringify(body);
  return new TextEncoder().encode(json);
}

export class Transport {
  private readonly _client: ApiClient;
  private readonly _compression: "gzip" | "zstd";
  /** Records dropped batches; undefined means silent. */
  private readonly _logger: Logger | undefined;

  constructor(config: ResolvedConfig) {
    this._client = new ApiClient({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
    });
    this._compression = config.compression;
    this._logger = config.logger;
  }

  /** Records a dropped batch when the debug logger is configured. */
  private _logDrop(protocol: Protocol, n: number, reason: string): void {
    this._logger?.warn("@evpanda/sdk: dropped batch (delivery failed)", {
      protocol,
      messages: n,
      reason,
    });
  }

  /**
   * Encodes with the configured codec (zstd by default, gzip when
   * configured), degrading to identity for tiny payloads or on any
   * failure. Never throws.
   */
  private async compress(
    raw: Uint8Array,
  ): Promise<{ body: Uint8Array; encoding: ContentEncoding }> {
    if (raw.byteLength < COMPRESS_MIN_BYTES) {
      return { body: raw, encoding: "identity" };
    }
    try {
      if (this._compression === "zstd") {
        return { body: await zstdCompress(Buffer.from(raw)), encoding: "zstd" };
      }
      return { body: await gzipAsync(raw), encoding: "gzip" };
    } catch {
      return { body: raw, encoding: "identity" };
    }
  }

  /**
   * Serialize → compress → POST with internal bounded retry. 200 is
   * success; 400/401/413 is a permanent drop; 5xx/network errors back off
   * and retry; a batch that can't be delivered is dropped. Never throws.
   */
  async send(protocol: Protocol, batch: BufferedMessage[]): Promise<void> {
    if (batch.length === 0) return;

    let body: Uint8Array;
    let encoding: ContentEncoding;
    try {
      ({ body, encoding } = await this.compress(serialize(batch)));
    } catch {
      return; // unserializable batch is dropped
    }

    let lastStatus = 0;
    for (let attempt = 0; attempt < BACKOFF_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const d = nextDelay(attempt);
        if (d === null) break;
        await sleep(d);
      }

      let status: number;
      try {
        status = await this._client.post(protocol, body, encoding);
      } catch {
        lastStatus = 0;
        continue; // network error / timeout → retryable
      }
      lastStatus = status;

      // 200 accepted; 400/401/413 permanent (drop, never retry — only these
      // three per the ingestion contract); any other non-2xx → retryable.
      if (status === 200) {
        return;
      }
      if (status === 400 || status === 401 || status === 413) {
        this._logDrop(
          protocol,
          batch.length,
          `permanent rejection: HTTP ${status}`,
        );
        return;
      }
    }
    // retries exhausted → batch dropped (loss acceptable by design)
    if (lastStatus !== 0) {
      this._logDrop(
        protocol,
        batch.length,
        `retries exhausted (last HTTP ${lastStatus})`,
      );
    } else {
      this._logDrop(
        protocol,
        batch.length,
        "retries exhausted (network error / timeout)",
      );
    }
  }
}
