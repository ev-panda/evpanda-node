/**
 * Hand-rolled transport, zero runtime deps (Node 18+ global fetch). Body:
 * JSON; default gzip, optional zstd peer with gzip fallback; tiny payloads
 * sent uncompressed. Owns the bounded retry: 200 or 400/401/413 → done;
 * 5xx/network → backoff; the caller never retries. Never throws.
 */

import { gzip } from "node:zlib";
import { promisify } from "node:util";

import type { BufferedMessage } from "./buffer.js";
import type { ResolvedConfig } from "./config.js";
import type { Protocol } from "./types.js";

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

type CompressFn = (input: Uint8Array) => Promise<Uint8Array>;

/** Lazily + once load the optional zstd peer; null ⇒ caller uses gzip. */
let zstdLoader: Promise<CompressFn | null> | undefined;

export function getZstd(): Promise<CompressFn | null> {
  return (zstdLoader ??= (async () => {
    try {
      // Non-literal specifier: optional dep, not resolved at build/typecheck.
      const spec = "@mongodb-js/zstd";
      const mod = (await import(spec)) as {
        compress?: (buf: Buffer, level?: number) => Promise<Buffer>;
      };
      if (typeof mod.compress !== "function") return null;
      const compress = mod.compress;
      return (input: Uint8Array) => compress(Buffer.from(input));
    } catch {
      return null;
    }
  })());
}
/**
 * Envelope[] → JSON body (message + protocol + capturedAt; Uint8Array →
 * base64). Wire shape must match apispec/ingestion-api.yaml (fixture pack).
 */
export function serialize(batch: BufferedMessage[]): Uint8Array {
  const records = batch.map((e) => ({
    ...e.message,
    protocol: e.protocol,
    capturedAt: e.capturedAt,
  }));
  const json = JSON.stringify(records, (_k, v: unknown) =>
    v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v,
  );
  return new TextEncoder().encode(json);
}

export class Transport {
  private readonly _client: ApiClient;
  private readonly _compression: "gzip" | "zstd";

  constructor(config: ResolvedConfig) {
    this._client = new ApiClient({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
    });
    this._compression = config.compression;
  }

  /** Degrades zstd → gzip → identity on any miss/failure. Never throws. */
  private async compress(
    raw: Uint8Array,
  ): Promise<{ body: Uint8Array; encoding: ContentEncoding }> {
    if (raw.byteLength < COMPRESS_MIN_BYTES) {
      return { body: raw, encoding: "identity" };
    }
    const compressors: Record<string, (r: Uint8Array) => Promise<Uint8Array>> = {
      zstd: async r => {
        const z = await getZstd();
        if (!z) throw new Error("No zstd");
        return z(r);
      },
      gzip: gzipAsync
    };
    const order = this._compression === "zstd" ? ["zstd", "gzip"] : ["gzip"];
    for (const enc of order) {
      const fn = compressors[enc];
      if (!fn) continue;
      try {
        const body = await fn(raw);
        return { body, encoding: enc as ContentEncoding };
      } catch {
        continue;
      }
    }
    return { body: raw, encoding: "identity" };
  }

  /** Serialize → compress → POST with internal bounded retry. Never throws. */
  async send(protocol: Protocol, batch: BufferedMessage[]): Promise<void> {
    if (batch.length === 0) return;

    const { body, encoding } = await this.compress(serialize(batch));

    const permanentStatuses = new Set([200, 400, 401, 413]);

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
        continue; // network error / timeout → retryable
      }

      // 200 accepted; 400/401/413 permanent (drop, never retry — only these
      // three per the ingestion contract); any other non-2xx → retryable.
      if (permanentStatuses.has(status)) {
        return;
      }
    }
    // retries exhausted → batch dropped (loss acceptable by design)
  }
}
