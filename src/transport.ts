/**
 * Hand-rolled transport over global `fetch`.
 *
 * Body: JSON, zstd-compressed above a size floor. It owns the bounded
 * retry — 200 or 400/401/413 is terminal, 5xx and network errors back off;
 * the caller never retries. It never throws.
 *
 * The `POST /v1/{protocol}` call lives in `Transport._post`. No generated
 * client, which would pull heavy transitive dependencies into customer
 * production for two endpoints, and no HTTP library: `fetch` is global from
 * Node 18 on.
 */

import { zstdCompress } from "node:zlib";
import { promisify } from "node:util";

import { isOCPI } from "./types.js";

import type { BufferedMessage } from "./buffer.js";
import type { Logger, ResolvedConfig } from "./config.js";
import type { Counters } from "./stats.js";
import type { OCPIMessage, OCPPMessage, Protocol } from "./types.js";

// ── Compression ──────────────────────────────────────────────────────────
//
// zstd is the codec, and it is in the standard library: `node:zlib` gained
// zstd in Node 22.15, which is why the engines floor is what it is. Every
// EVPanda SDK compresses the same way, so a batch on the wire looks the
// same whichever language sent it, and the ingestion API's capacity
// planning holds across all of them. (It also accepts gzip and
// uncompressed bodies; neither is used.)
//
// An earlier revision reached for `@mongodb-js/zstd`, a native addon, as an
// optional peer with a gzip fallback. Node made both the dependency and the
// fallback unnecessary.

const zstd = promisify(zstdCompress);

type ContentEncoding = "identity" | "zstd";

/** Below this raw size compression is not worth the CPU; send as-is. */
const COMPRESS_MIN_BYTES = 1024;

/**
 * Encode the body with zstd, above the size floor. An uncompressed body is
 * always a safe answer — the ingestion API accepts one — so a codec fault
 * degrades to identity rather than costing us the batch.
 */
async function compress(
  raw: Uint8Array,
): Promise<[Uint8Array, ContentEncoding]> {
  if (raw.byteLength < COMPRESS_MIN_BYTES) return [raw, "identity"];
  try {
    return [await zstd(raw), "zstd"];
  } catch {
    return [raw, "identity"];
  }
}

// ── Backoff (module-private, fixed by design — not configurable) ─────────

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MAX_ATTEMPTS = 5;

/**
 * Delay (ms) before a retry attempt. Capped exponential with full jitter.
 * The retry count is bounded by the `send` loop, not here.
 */
function nextDelay(attempt: number): number {
  const capped = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * capped);
}

/** Per-attempt request cap so a hung connection still feeds the backoff. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The statuses the ingestion contract defines as permanent. */
const PERMANENT_STATUSES = new Set([400, 401, 413]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Ingestion wire records ───────────────────────────────────────────────
//
// The exact request payload shapes the ingestion service accepts — keep in
// lock-step with that service and the Go SDK. Optional fields are `T | null`:
// an absent value serializes as JSON null, never a zero or omitted key.

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

/**
 * base64-encode a body/frame, or null when empty. Used for every byte
 * payload the SDK ships — OCPI HTTP bodies AND OCPP wire frames. The
 * ingest server decodes before persistence (so DB / consumers see plain
 * UTF-8 for OCPP, raw bytes for OCPI). Rationale: keeps the wire contract
 * uniform across protocols and binary-safe for any future payload.
 */
function bodyB64(b: Uint8Array | string | undefined): string | null {
  if (b === undefined || b.length === 0) return null;
  return Buffer.from(b as Uint8Array).toString("base64");
}

/** Non-empty string, or null. */
function optStr(s: string | undefined): string | null {
  return s === undefined || s === "" ? null : s;
}

/** Non-zero number, or null (0 is treated as absent, matching Go). */
function optInt(n: number | undefined): number | null {
  return n === undefined || n === 0 ? null : n;
}

function ocpiRecord(e: BufferedMessage, m: OCPIMessage): OcpiIngest {
  return {
    captured_at: e.capturedAt,
    platform_id: m.platform.id,
    platform_name: m.platform.name,
    tenant_id: optStr(m.platform.tenantId),
    tenant_name: optStr(m.platform.tenantName),
    direction: m.direction,
    http_method: m.data.method,
    url: m.data.url,
    response_status_code: optInt(m.data.statusCode),
    request_headers: headersJSON(m.data.requestHeaders),
    request_body: bodyB64(m.data.requestBody),
    response_headers: headersJSON(m.data.responseHeaders),
    response_body: bodyB64(m.data.responseBody),
  };
}

function ocppRecord(e: BufferedMessage, m: OCPPMessage): OcppIngest {
  return {
    charger_id: m.charger.id,
    connection_id: m.connectionId,
    tenant_id: optStr(m.charger.tenantId),
    tenant_name: optStr(m.charger.tenantName),
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
function serialize(batch: BufferedMessage[]): Uint8Array {
  const messages: (OcpiIngest | OcppIngest)[] = batch.map((e) =>
    isOCPI(e.message)
      ? ocpiRecord(e, e.message)
      : ocppRecord(e, e.message),
  );
  const body: IngestBody = { messages };
  return new TextEncoder().encode(JSON.stringify(body));
}

export class Transport {
  private readonly _endpoint: string;
  private readonly _apiKey: string;
  /** Records dropped batches; undefined means silent. */
  private readonly _logger: Logger | undefined;
  private readonly _debug: boolean;

  constructor(
    config: ResolvedConfig,
    private readonly _counters: Counters,
  ) {
    this._endpoint = config.endpoint;
    this._apiKey = config.apiKey;
    this._logger = config.logger;
    this._debug = config.logMode === "debug";
  }

  /**
   * Serialize, compress and POST the batch with bounded retry.
   *
   * 200 or 400/401/413 is terminal; 5xx and network errors back off and
   * retry. A batch that cannot be delivered is dropped — loss is acceptable
   * by design, and the alternative is unbounded memory in the host.
   *
   * `deadline` is a `Date.now()` value past which no further attempt is
   * started, so a shutdown drain cannot outlive the timeout the caller gave
   * it. Never throws.
   */
  async send(
    protocol: Protocol,
    batch: BufferedMessage[],
    deadline?: number,
  ): Promise<void> {
    if (batch.length === 0) return;
    const size = batch.length;

    let body: Uint8Array;
    let encoding: ContentEncoding;
    try {
      [body, encoding] = await compress(serialize(batch));
    } catch {
      this._logDrop(protocol, size, "batch could not be serialized");
      return;
    }

    let lastStatus = 0;
    for (let attempt = 0; attempt < BACKOFF_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = nextDelay(attempt);
        if (deadline !== undefined && Date.now() + delay >= deadline) {
          this._logDrop(protocol, size, "deadline passed before retry");
          return;
        }
        await sleep(delay);
      }

      const timeout = this._attemptTimeout(deadline);
      if (timeout <= 0) {
        this._logDrop(protocol, size, "deadline passed before delivery");
        return;
      }

      let status: number;
      try {
        status = await this._post(protocol, body, encoding, timeout);
      } catch {
        lastStatus = 0;
        continue; // network error or timeout: retryable
      }
      lastStatus = status;

      if (status === 200) return;
      if (PERMANENT_STATUSES.has(status)) {
        this._logDrop(protocol, size, `permanent rejection: HTTP ${status}`);
        return;
      }
    }

    this._logDrop(
      protocol,
      size,
      lastStatus !== 0
        ? `retries exhausted (last HTTP ${lastStatus})`
        : "retries exhausted (network error / timeout)",
    );
  }

  /** The per-attempt timeout, never past the caller's deadline. */
  private _attemptTimeout(deadline: number | undefined): number {
    if (deadline === undefined) return REQUEST_TIMEOUT_MS;
    return Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
  }

  /** Issue one POST, drain the response, and return the status code. */
  private async _post(
    protocol: Protocol,
    body: Uint8Array,
    encoding: ContentEncoding,
    timeout: number,
  ): Promise<number> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this._apiKey,
    };
    if (encoding !== "identity") headers["content-encoding"] = encoding;

    const res = await fetch(`${this._endpoint}/v1/${protocol}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeout),
    });
    await res.text(); // drain so the socket can be released; the body is unused
    return res.status;
  }

  /**
   * Count a dropped batch, and log it per-occurrence only in debug.
   *
   * In the default mode the worker's once-a-minute health line reports the
   * same loss with bounded volume — an outage would otherwise emit a line
   * every flush interval, for as long as it lasts, across every client at
   * once.
   */
  private _logDrop(protocol: Protocol, n: number, reason: string): void {
    this._counters.countDrop("undeliverable", n);
    if (this._logger === undefined || !this._debug) return;
    try {
      this._logger.warn("evpanda: dropped batch (delivery failed)", {
        protocol,
        messages: n,
        reason,
      });
    } catch {
      /* a broken host logger is not our failure */
    }
  }
}
