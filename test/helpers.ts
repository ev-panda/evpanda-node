/** Shared test rig: a stub ingestion API, and clients pointed at it. */

import http from "node:http";
import { zstdDecompressSync } from "node:zlib";

import { startOCPI, startOCPP } from "../src/index.js";

import type { AddressInfo } from "node:net";
import type { OCPIConfig, OCPPConfig, Platform, Charger } from "../src/index.js";

export const PARTNER: Platform = { id: "acme", name: "Acme Mobility" };
export const CHARGER: Charger = { id: "CP-001" };

export interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  records: Record<string, unknown>[];
}

export interface MockUpstream {
  url: string;
  received: Received[];
  /** Statuses to serve before falling back to 200, one per request. */
  statuses: number[];
  /** Milliseconds to hold each response, for testing an in-flight flush. */
  delayMs: number;
  /** Every record from every request, in order. */
  readonly records: Record<string, unknown>[];
  waitFor(count: number, timeoutMs?: number): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** A stub of the ingestion API, recording what the SDK sends it. */
export async function startMockUpstream(): Promise<MockUpstream> {
  const received: Received[] = [];
  const statuses: number[] = [];
  const state = { delayMs: 0 };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let buf = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "zstd") {
        buf = Buffer.from(zstdDecompressSync(buf));
      }
      const status = statuses.shift() ?? 200;
      const respond = (fn: () => void): void => {
        if (state.delayMs > 0) setTimeout(fn, state.delayMs);
        else fn();
      };
      if (status === 200) {
        let records: Record<string, unknown>[] = [];
        try {
          const parsed = JSON.parse(buf.toString("utf8")) as {
            messages?: Record<string, unknown>[];
          };
          records = parsed.messages ?? [];
        } catch {
          /* a malformed body shows up as zero records */
        }
        received.push({ path: req.url ?? "", headers: req.headers, records });
        respond(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ captured: records.length, failed: 0 }));
        });
        return;
      }
      respond(() => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "stub" }));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    statuses,
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(ms: number) {
      state.delayMs = ms;
    },
    get records() {
      return received.flatMap((r) => r.records);
    },
    async waitFor(count, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const all = received.flatMap((r) => r.records);
        if (all.length >= count) return all;
        if (Date.now() >= deadline) {
          throw new Error(`expected ${count} records, saw ${all.length}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close() {
      server.closeAllConnections?.();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** An OCPI client pointed at the stub, with the interval flush disabled. */
export function ocpiClient(mock: MockUpstream, overrides: OCPIConfig = {}) {
  const panda = startOCPI({
    endpoint: mock.url,
    apiKey: "test-key",
    flushInterval: 3_600_000,
    ...overrides,
  });
  if (panda.error) throw panda.error;
  return panda;
}

/** An OCPP client pointed at the stub. */
export function ocppClient(mock: MockUpstream, overrides: OCPPConfig = {}) {
  const panda = startOCPP({
    endpoint: mock.url,
    apiKey: "test-key",
    flushInterval: 3_600_000,
    ...overrides,
  });
  if (panda.error) throw panda.error;
  return panda;
}

/** A plausible OCPI exchange, overridable per test. */
export function exchange(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    url: "/ocpi/2.2/cdrs",
    statusCode: 201,
    requestHeaders: { "content-type": "application/json" },
    responseHeaders: { "content-type": "application/json" },
    requestBody: Buffer.from('{"id":"cdr-1"}'),
    responseBody: Buffer.from('{"status_code":1000}'),
    ...overrides,
  };
}

/** A Capturer that records instead of buffering. */
export class FakeCapturer {
  inbound: { identity: Platform; data: Record<string, unknown> }[] = [];
  outbound: { identity: Platform; data: Record<string, unknown> }[] = [];
  constructor(private readonly _max: number | undefined = 65536) {}
  captureInboundMessage(msg: never): void {
    this.inbound.push(msg);
  }
  captureOutboundMessage(msg: never): void {
    this.outbound.push(msg);
  }
  capturing(): number | undefined {
    return this._max;
  }
}
