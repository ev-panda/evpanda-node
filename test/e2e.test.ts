import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// E2E against the built artifact — exactly what ships.
import { EVPanda } from "../dist/index.js";
import type { OCPIMessage } from "../dist/index.js";

// ── Mock upstream ────────────────────────────────────────────────────────

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  records: Record<string, unknown>[];
}

interface MockUpstream {
  url: string;
  received: Received[];
  /** Mutable: change to make the upstream reject (e.g. 400). */
  status: number;
  close(): Promise<void>;
}

const startMockUpstream = (): Promise<MockUpstream> => {
  const received: Received[] = [];
  const mock = { received, status: 200 } as MockUpstream;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let buf = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") buf = gunzipSync(buf);
      let records: Record<string, unknown>[] = [];
      try {
        const parsed: unknown = JSON.parse(buf.toString("utf8"));
        if (Array.isArray(parsed)) records = parsed;
      } catch {
        /* leave empty */
      }
      received.push({ path: req.url ?? "", headers: req.headers, records });
      res.writeHead(mock.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ captured: records.length, failed: 0 }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      mock.url = `http://127.0.0.1:${port}`;
      mock.close = () =>
        new Promise<void>((r) => server.close(() => r()));
      resolve(mock);
    });
  });
};

// ── Helpers ──────────────────────────────────────────────────────────────

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Valid OCPI message tagged with an index; carries a denylisted header. */
const makeOCPI = (i: number): OCPIMessage => {
  return {
    direction: "inbound",
    identity: {
      platformId: "acme",
      platformName: "Acme Mobility",
      tenantId: "t1",
      tenantName: "Tenant One",
    },
    http: {
      method: "POST",
      url: `/ocpi/2.2/cdrs/${i}`,
      statusCode: 200,
      requestHeaders: { Authorization: "Bearer SECRET", "X-Trace": String(i) },
      responseHeaders: { "content-type": "application/json" },
      requestBody: new TextEncoder().encode(`body-${i}`),
      truncated: false,
    },
  };
};

const ocpiRecords = (m: MockUpstream) =>
  m.received
    .filter((r) => r.path === "/v1/ocpi")
    .flatMap((r) => r.records);

// ── Tests ────────────────────────────────────────────────────────────────

describe("EVPanda e2e", () => {
  let mock: MockUpstream;
  let sdk: ReturnType<typeof EVPanda.start> | undefined;

  beforeEach(async () => {
    mock = await startMockUpstream();
    sdk = undefined;
  });

  afterEach(async () => {
    if (sdk) await sdk.close(); // idempotent
    await mock.close();
  });

  it("captures, batches on the timer, and the upstream receives all data (redacted & routed)", async () => {
    sdk = EVPanda.start({
      endpoint: mock.url,
      apiKey: "test-key",
      flushInterval: 100,
    });

    for (let i = 0; i < 3; i++) sdk.captureOCPI(makeOCPI(i));

    await waitFor(() => ocpiRecords(mock).length === 3);

    const recs = ocpiRecords(mock).sort((a, b) =>
      String((a.http as { url: string }).url).localeCompare(
        String((b.http as { url: string }).url),
      ),
    );
    expect(recs).toHaveLength(3);

    // Routing: only /v1/ocpi was hit, with the configured api key.
    expect(mock.received.every((r) => r.path === "/v1/ocpi")).toBe(true);
    expect(mock.received[0]?.headers["x-api-key"]).toBe("test-key");

    recs.forEach((rec, i) => {
      // SDK-stamped envelope fields
      expect(rec.protocol).toBe("ocpi");
      expect(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          String(rec.capturedAt),
        ),
      ).toBe(true);

      const httpRec = rec.http as {
        url: string;
        requestHeaders: Record<string, string>;
        requestBody: string;
      };
      expect(httpRec.url).toBe(`/ocpi/2.2/cdrs/${i}`);

      // Redaction: Authorization stripped (case-insensitive), others kept.
      const keys = Object.keys(httpRec.requestHeaders).map((k) =>
        k.toLowerCase(),
      );
      expect(keys).not.toContain("authorization");
      expect(httpRec.requestHeaders["X-Trace"]).toBe(String(i));

      // Binary body round-trips as base64.
      expect(
        Buffer.from(httpRec.requestBody, "base64").toString("utf8"),
      ).toBe(`body-${i}`);
    });
  });

  it("compresses large batches with gzip and chunks at BATCH_CAP, in order", async () => {
    sdk = EVPanda.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
      bufferCapacity: 100_000,
    });

    const N = 2500;
    for (let i = 0; i < N; i++) sdk.captureOCPI(makeOCPI(i));

    await waitFor(() => ocpiRecords(mock).length === N, 8000);

    // Chunked at ≤1000 per POST → ceil(2500/1000) = 3 requests.
    const posts = mock.received.filter((r) => r.path === "/v1/ocpi");
    expect(posts).toHaveLength(3);
    expect(posts.every((p) => p.records.length <= 1000)).toBe(true);

    // Compression actually used (payload ≫ 1 KiB) and round-tripped.
    expect(posts.every((p) => p.headers["content-encoding"] === "gzip")).toBe(
      true,
    );

    // FIFO order preserved across the chunked POSTs.
    ocpiRecords(mock).forEach((rec, i) => {
      expect((rec.http as { url: string }).url).toBe(`/ocpi/2.2/cdrs/${i}`);
    });
  }, 15000);

  it("caps the buffer at config.bufferCapacity (drop-oldest)", async () => {
    sdk = EVPanda.start({
      endpoint: mock.url,
      apiKey: "k",
      bufferCapacity: 5,
      flushInterval: 60_000, // no auto flush during the test
    });

    for (let i = 0; i < 12; i++) sdk.captureOCPI(makeOCPI(i)); // 0..11
    await sdk.flush(); // force one drain

    await waitFor(() => ocpiRecords(mock).length === 5);
    const urls = ocpiRecords(mock)
      .map((r) => (r.http as { url: string }).url)
      .sort();
    // Only the newest 5 survive (7..11); the oldest 7 were dropped.
    expect(urls).toEqual([
      "/ocpi/2.2/cdrs/10",
      "/ocpi/2.2/cdrs/11",
      "/ocpi/2.2/cdrs/7",
      "/ocpi/2.2/cdrs/8",
      "/ocpi/2.2/cdrs/9",
    ]);
  });

  it("flushes all pending messages to the upstream on close()", async () => {
    sdk = EVPanda.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 60_000, // never auto-flushes within the test
    });

    for (let i = 0; i < 4; i++) sdk.captureOCPI(makeOCPI(i));
    expect(ocpiRecords(mock)).toHaveLength(0); // nothing sent yet

    await sdk.close(); // graceful drain

    await waitFor(() => ocpiRecords(mock).length === 4);
    expect(ocpiRecords(mock)).toHaveLength(4);
  });

  it("never throws into the caller when the upstream fails", async () => {
    mock.status = 400; // permanent reject → dropped, no retry storm
    sdk = EVPanda.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 60_000,
    });

    // Capture during a failing upstream — must not throw.
    for (let i = 0; i < 3; i++) {
      expect(() => sdk?.captureOCPI(makeOCPI(i))).not.toThrow();
    }
    // Malformed customer input — must not throw either (proxy swallows).
    expect(() => sdk?.captureOCPI(undefined as never)).not.toThrow();
    expect(() => sdk?.captureOCPI({} as never)).not.toThrow();

    // flush() resolves (never rejects) even though the upstream 400s.
    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(mock.received.length).toBeGreaterThan(0); // it did attempt

    // The SDK is still usable afterwards.
    expect(() => sdk?.captureOCPI(makeOCPI(99))).not.toThrow();
    await expect(sdk.flush()).resolves.toBeUndefined();
  });
});
