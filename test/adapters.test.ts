/**
 * End-to-end tests for the OCPI adapters. Each test runs against built
 * artifacts (`dist/`), spins up a real mock ingestion server, and, where
 * relevant, a real mock partner server — no mocks of internals.
 *
 * Deliberately kept small: 2–3 tests per area, covering the primary path of
 * each adapter plus the behaviours with their own dedicated code. Regression
 * tests (pass-through after `close`, outbound header stripping) are pinned
 * here and should not be removed without replacing the coverage.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

import { decompress as zstdDecompress } from "@mongodb-js/zstd";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OCPIClient, OCPPClient, ocpi } from "../dist/index.js";
import type { OCPIResolver } from "../dist/index.js";

/**
 * Node 18 leaves idle keep-alive sockets open, so `server.close()` blocks for
 * `keepAliveTimeout` (5s) after any undici/global-fetch request — long enough
 * to blow a test's 5s budget. Node 19+ drops idle connections itself.
 */
function closeSockets(server: http.Server): void {
  server.closeAllConnections?.();
}


// ── Mock ingestion server (re-used pattern from e2e.test.ts) ─────────────

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  records: Record<string, unknown>[];
}

interface MockUpstream {
  url: string;
  received: Received[];
  close(): Promise<void>;
}

async function startMockUpstream(): Promise<MockUpstream> {
  const received: Received[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        let buf = Buffer.concat(chunks);
        const enc = req.headers["content-encoding"];
        if (enc === "gzip") buf = gunzipSync(buf);
        else if (enc === "zstd") buf = await zstdDecompress(buf);
        let records: Record<string, unknown>[] = [];
        try {
          const parsed: unknown = JSON.parse(buf.toString("utf8"));
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { messages?: unknown }).messages)
          ) {
            records = (parsed as { messages: Record<string, unknown>[] }).messages;
          }
        } catch {
          /* leave empty */
        }
        received.push({ path: req.url ?? "", headers: req.headers, records });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ captured: records.length, failed: 0 }));
      })();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise<void>((r) => { server.close(() => r()); closeSockets(server); }),
      });
    });
  });
}

// ── Mock partner server: stands in for an OCPI partner endpoint ──────────

interface MockPartner {
  url: string;
  /** Set this to fail the next response. */
  status: number;
  close(): Promise<void>;
}

async function startMockPartner(): Promise<MockPartner> {
  const partner = { status: 200 } as MockPartner;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(partner.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: partner.status < 400, echo: body }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      partner.url = `http://127.0.0.1:${port}`;
      partner.close = () => new Promise<void>((r) => { server.close(() => r()); closeSockets(server); });
      resolve(partner);
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Test-local resolver reading `x-platform-*` — distinct from the SDK's
 *  shipped `ocpi.headerResolver`, which reads `X-EVPanda-*`. */
const testResolver: OCPIResolver = (ctx) => ({
  platformId: ctx.requestHeaders["x-platform-id"] ?? "",
  platformName: ctx.requestHeaders["x-platform-name"] ?? "",
});

const ocpiRecords = (m: MockUpstream) =>
  m.received.filter((r) => r.path === "/v1/ocpi").flatMap((r) => r.records);

/**
 * Wraps the node:http callback into a server bound on 127.0.0.1 with a
 * random port. Returns the URL and a close fn.
 */
async function listenOn(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => { server.close(() => r()); closeSockets(server); }),
      });
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ocpi.express", () => {
  let mock: MockUpstream;
  let sdk: ReturnType<typeof OCPIClient.start>;
  let appUrl: string;
  let appClose: () => Promise<void>;

  beforeEach(async () => {
    mock = await startMockUpstream();
  });

  afterEach(async () => {
    await sdk.close();
    await appClose();
    await mock.close();
  });

  it("captures inbound: identity, status, headers, response body", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });
    const mw = ocpi.express(sdk, { resolve: testResolver });

    const app = await listenOn((req, res) => {
      mw(req, res, () => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ack: true }));
      });
    });
    appUrl = app.url;
    appClose = app.close;

    const response = await fetch(`${appUrl}/ocpi/2.2/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-platform-id": "acme",
        "x-platform-name": "Acme",
      },
      body: JSON.stringify({ id: "s1" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ack: true });

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    expect(rec.platform_id).toBe("acme");
    expect(rec.platform_name).toBe("Acme");
    expect(rec.direction).toBe("IN");
    expect(rec.http_method).toBe("POST");
    expect(rec.url).toBe("/ocpi/2.2/sessions");
    expect(rec.response_status_code).toBe(201);

    // Response body captured (base64 on the wire).
    const respBody = Buffer.from(String(rec.response_body), "base64").toString("utf8");
    expect(JSON.parse(respBody)).toEqual({ ack: true });
  });

  it("captures the request body from a parser-populated req.body", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });
    const mw = ocpi.express(sdk, { resolve: testResolver });

    const app = await listenOn((req, res) => {
      // Stand in for express.json() — the adapter reads req.body, never
      // the raw request stream.
      (req as http.IncomingMessage & { body?: unknown }).body = { id: "s1" };
      mw(req, res, () => {
        res.writeHead(200);
        res.end("ok");
      });
    });
    appUrl = app.url;
    appClose = app.close;

    const response = await fetch(`${appUrl}/ocpi/2.2/sessions`, {
      method: "POST",
      headers: { "x-platform-id": "acme", "x-platform-name": "Acme" },
      body: "raw-stream-ignored",
    });
    expect(response.status).toBe(200);

    await waitFor(() => ocpiRecords(mock).length === 1);
    const reqBody = Buffer.from(
      String(ocpiRecords(mock)[0]!.request_body),
      "base64",
    ).toString("utf8");
    expect(JSON.parse(reqBody)).toEqual({ id: "s1" });
  });

});

describe("ocpi.fetch", () => {
  let mock: MockUpstream;
  let partner: MockPartner;
  let sdk: ReturnType<typeof OCPIClient.start>;

  beforeEach(async () => {
    mock = await startMockUpstream();
    partner = await startMockPartner();
  });

  afterEach(async () => {
    await sdk.close();
    await partner.close();
    await mock.close();
  });

  it("captures outbound, leaves the response untouched, and goes inert on close", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });
    let resolverCalls = 0;
    const wrapped = ocpi.fetch(sdk, globalThis.fetch, {
      resolve: () => {
        resolverCalls++;
        return { platformId: "acme", platformName: "Acme" };
      },
    });

    const response = await wrapped(`${partner.url}/ocpi/2.2/cdrs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "c1" }),
    });
    const json = (await response.json()) as { ok: boolean; echo: string };
    // Caller's view of the response is intact.
    expect(json.ok).toBe(true);
    expect(JSON.parse(json.echo)).toEqual({ id: "c1" });

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    expect(rec.platform_id).toBe("acme");
    expect(rec.direction).toBe("OUT");
    expect(rec.http_method).toBe("POST");
    expect(String(rec.url)).toContain("/ocpi/2.2/cdrs");
    expect(rec.response_status_code).toBe(200);

    // Both bodies round-tripped.
    const reqBody = Buffer.from(String(rec.request_body), "base64").toString("utf8");
    expect(JSON.parse(reqBody)).toEqual({ id: "c1" });

    // Regression: the adapter reads the capture channel once at wrap time, so
    // a wrapper built while live must still go inert once the client closes.
    await sdk.close();
    const callsBeforeClose = resolverCalls;

    const after = await wrapped(`${partner.url}/ocpi/2.2/cdrs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "c2" }),
    });
    expect(((await after.json()) as { ok: boolean }).ok).toBe(true);
    expect(resolverCalls).toBe(callsBeforeClose); // no resolver call
    expect(ocpiRecords(mock)).toHaveLength(1); // no new record
  });
});

describe("ocpi.axios", () => {
  let mock: MockUpstream;
  let partner: MockPartner;
  let sdk: ReturnType<typeof OCPIClient.start>;

  beforeEach(async () => {
    mock = await startMockUpstream();
    partner = await startMockPartner();
  });

  afterEach(async () => {
    await sdk.close();
    await partner.close();
    await mock.close();
  });

  it("captures outbound request/response on a 2xx", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });
    const instance = ocpi.axios(sdk, axios.create({ baseURL: partner.url }), {
      resolve: () => ({ platformId: "acme", platformName: "Acme" }),
    });

    const r = await instance.post("/ocpi/2.2/locations", { id: "l1" });
    expect(r.status).toBe(200);
    expect((r.data as { ok: boolean }).ok).toBe(true);

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    expect(rec.platform_id).toBe("acme");
    expect(rec.direction).toBe("OUT");
    expect(rec.http_method).toBe("POST");
    expect(String(rec.url)).toContain("/ocpi/2.2/locations");
    expect(rec.response_status_code).toBe(200);

    // axios serializes JS objects to JSON before sending; capture mirrors that.
    const reqBody = Buffer.from(String(rec.request_body), "base64").toString("utf8");
    expect(JSON.parse(reqBody)).toEqual({ id: "l1" });

    // A non-2xx rejects in axios, so it lands in the error interceptor arm —
    // a separate code path that must capture the response just the same.
    partner.status = 422;
    await expect(instance.post("/ocpi/2.2/tokens", { id: "t1" })).rejects.toMatchObject({
      response: { status: 422 },
    });

    await waitFor(() => ocpiRecords(mock).length === 2);
    expect(ocpiRecords(mock)[1]!.response_status_code).toBe(422);
  });
});

describe("shipped X-EVPanda-* header resolver", () => {
  let mock: MockUpstream;
  let partner: MockPartner;
  let sdk: ReturnType<typeof OCPIClient.start>;
  let appClose: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    mock = await startMockUpstream();
    partner = await startMockPartner();
    appClose = undefined;
  });

  afterEach(async () => {
    await sdk.close();
    if (appClose) await appClose();
    await partner.close();
    await mock.close();
  });

  it("ocpi.fetch strips the identity headers before they reach the partner", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });
    // Header-recording stand-in for the partner.
    const seen: http.IncomingHttpHeaders[] = [];
    const app = await listenOn((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    appClose = app.close;

    const wrapped = ocpi.fetch(sdk, globalThis.fetch);
    await wrapped(`${app.url}/ocpi/2.2/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-EVPanda-Platform-Id": "acme",
        "X-EVPanda-Platform-Name": "Acme",
        "X-EVPanda-Tenant-Id": "internal-tenant-1",
        "X-EVPanda-Tenant-Name": "Internal Tenant",
      },
      body: "{}",
    });

    // Partner saw a normal request — no SDK headers, other headers intact.
    expect(seen).toHaveLength(1);
    const partnerHeaders = Object.keys(seen[0]!).map((k) => k.toLowerCase());
    expect(partnerHeaders.filter((k) => k.startsWith("x-evpanda-"))).toEqual([]);
    expect(partnerHeaders).toContain("content-type");

    // Identity still resolved and captured from the stripped headers.
    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    expect(rec.platform_id).toBe("acme");
    expect(rec.tenant_id).toBe("internal-tenant-1");
  });

  it("ocpi.axios strips the identity headers before they reach the partner", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });
    const seen: http.IncomingHttpHeaders[] = [];
    const app = await listenOn((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    appClose = app.close;

    const client = ocpi.axios(
      sdk,
      axios.create({
        baseURL: app.url,
        headers: {
          "X-EVPanda-Platform-Id": "acme",
          "X-EVPanda-Platform-Name": "Acme",
          "X-EVPanda-Tenant-Id": "internal-tenant-1",
          "X-EVPanda-Tenant-Name": "Internal Tenant",
        },
      }),
    );
    await client.post("/ocpi/2.2/tokens", { id: "t1" });

    expect(seen).toHaveLength(1);
    const partnerHeaders = Object.keys(seen[0]!).map((k) => k.toLowerCase());
    expect(partnerHeaders.filter((k) => k.startsWith("x-evpanda-"))).toEqual([]);

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    expect(rec.platform_id).toBe("acme");
    expect(rec.tenant_id).toBe("internal-tenant-1");
  });

});

describe("drop-on-oversize policy", () => {
  let mock: MockUpstream;
  let sdk: ReturnType<typeof OCPIClient.start>;

  // Tiny cap so we can blow past it with a few hundred bytes.
  const TINY_CAP = 64;

  beforeEach(async () => {
    mock = await startMockUpstream();
  });

  afterEach(async () => {
    await sdk.close();
    await mock.close();
  });

  /** Pause for a flush window + a manual flush so "nothing arrived" is reliable. */
  async function expectNoCapture() {
    await new Promise((r) => setTimeout(r, 300));
    await sdk.flush();
    await new Promise((r) => setTimeout(r, 200));
    expect(ocpiRecords(mock)).toHaveLength(0);
  }

  it("ocpi.express drops the whole capture when the response body overflows", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url, apiKey: "k", flushInterval: 100, maxCaptureBytes: TINY_CAP,
    });
    const mw = ocpi.express(sdk, { resolve: testResolver });
    const app = await listenOn((req, res) => {
      mw(req, res, () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("z".repeat(TINY_CAP * 4)); // oversize response
      });
    });
    try {
      const response = await fetch(`${app.url}/ocpi/2.2/cdrs`, {
        method: "POST",
        headers: { "x-platform-id": "acme", "x-platform-name": "Acme" },
        body: "small",
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toHaveLength(TINY_CAP * 4); // caller got full bytes
      await expectNoCapture();
    } finally {
      await app.close();
    }
  });

  it("ocpi.fetch drops the whole capture when a body overflows", async () => {
    const partner = await startMockPartner();
    try {
      sdk = OCPIClient.start({
        endpoint: mock.url, apiKey: "k", flushInterval: 100, maxCaptureBytes: TINY_CAP,
      });
      const wrapped = ocpi.fetch(sdk, globalThis.fetch, {
        resolve: () => ({ platformId: "acme", platformName: "Acme" }),
      });

      const oversize = "x".repeat(TINY_CAP * 4);
      const response = await wrapped(`${partner.url}/ocpi/2.2/cdrs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversize,
      });
      // Caller's response is untouched.
      const json = (await response.json()) as { echo: string };
      expect(json.echo).toBe(oversize);

      await expectNoCapture();
    } finally {
      await partner.close();
    }
  });

  it("ocpi.axios drops the whole capture when a body overflows", async () => {
    const partner = await startMockPartner();
    try {
      sdk = OCPIClient.start({
        endpoint: mock.url, apiKey: "k", flushInterval: 100, maxCaptureBytes: TINY_CAP,
      });
      const instance = ocpi.axios(sdk, axios.create({ baseURL: partner.url }), {
        resolve: () => ({ platformId: "acme", platformName: "Acme" }),
      });

      // Oversize request body — axios serializes the object to JSON,
      // which we then check against the cap.
      const big = { blob: "y".repeat(TINY_CAP * 4) };
      const r = await instance.post("/ocpi/2.2/cdrs", big);
      expect(r.status).toBe(200); // caller flow unaffected

      await expectNoCapture();
    } finally {
      await partner.close();
    }
  });

});

describe("OCPI redaction policy", () => {
  let mock: MockUpstream;
  let sdk: ReturnType<typeof OCPIClient.start>;

  beforeEach(async () => {
    mock = await startMockUpstream();
  });

  afterEach(async () => {
    await sdk.close();
    await mock.close();
  });

  it("drops any header not on the allowlist (no denylist, no escape hatch for auth)", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    sdk.captureInboundMessage({
      identity: { platformId: "acme", platformName: "Acme" },
      data: {
        method: "POST",
        url: "/ocpi/2.2/cdrs",
        statusCode: 200,
        requestHeaders: {
          Authorization: "Bearer SECRET", // not on allowlist ⇒ dropped
          Cookie: "session=abc", // ditto
          "X-Made-Up": "leak", // ditto
          "content-type": "application/json", // allowlist
          "x-correlation-id": "trace-1", // allowlist
        },
        responseHeaders: {
          "Set-Cookie": "id=xyz", // not on allowlist ⇒ dropped
          "content-type": "application/json",
        },
      },
    });

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;

    const reqKeys = Object.keys(rec.request_headers as Record<string, string>).map(
      (k) => k.toLowerCase(),
    );
    expect(reqKeys.sort()).toEqual(["content-type", "x-correlation-id"]);
    expect(reqKeys).not.toContain("authorization");
    expect(reqKeys).not.toContain("cookie");
    expect(reqKeys).not.toContain("x-made-up");

    const respKeys = Object.keys(rec.response_headers as Record<string, string>).map(
      (k) => k.toLowerCase(),
    );
    expect(respKeys).toEqual(["content-type"]);
    expect(respKeys).not.toContain("set-cookie");
  });

  it("masks `token` in credentials request body", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    const body = JSON.stringify({
      token: "01234567-89ab-cdef-0123-456789abcdef",
      url: "https://partner.example/ocpi/2.2/",
      roles: [{ role: "EMSP", country_code: "DE", party_id: "ABC" }],
    });

    sdk.captureInboundMessage({
      identity: { platformId: "acme", platformName: "Acme" },
      data: {
        method: "POST",
        url: "/ocpi/2.2/credentials",
        statusCode: 200,
        requestHeaders: { "content-type": "application/json" },
        responseHeaders: {},
        requestBody: new TextEncoder().encode(body),
      },
    });

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    const decoded = JSON.parse(
      Buffer.from(String(rec.request_body), "base64").toString("utf8"),
    ) as { token: string; url: string; roles: unknown[] };
    expect(decoded.token).toBe("[redacted]");
    // Everything else is preserved.
    expect(decoded.url).toBe("https://partner.example/ocpi/2.2/");
    expect(decoded.roles).toHaveLength(1);
  });

  it("masks `token` inside the OCPI response envelope's `data` field", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    // OCPI 2.2 response envelope — credentials object is nested under `data`.
    const envelope = {
      data: {
        token: "SECRET-VALUE",
        url: "https://partner.example/ocpi/2.2/",
        roles: [{ role: "EMSP", country_code: "DE", party_id: "ABC" }],
      },
      status_code: 1000,
      status_message: "Success",
      timestamp: "2026-05-21T00:00:00Z",
    };

    sdk.captureOutboundMessage({
      identity: { platformId: "acme", platformName: "Acme" },
      data: {
        method: "POST",
        url: "https://partner.example/ocpi/2.2/credentials",
        statusCode: 200,
        requestHeaders: {},
        responseHeaders: { "content-type": "application/json" },
        responseBody: new TextEncoder().encode(JSON.stringify(envelope)),
      },
    });

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    const decoded = JSON.parse(
      Buffer.from(String(rec.response_body), "base64").toString("utf8"),
    ) as typeof envelope;
    // Token under data is masked; the envelope is otherwise intact.
    expect(decoded.data.token).toBe("[redacted]");
    expect(decoded.data.url).toBe("https://partner.example/ocpi/2.2/");
    expect(decoded.data.roles).toHaveLength(1);
    expect(decoded.status_code).toBe(1000);
    expect(decoded.status_message).toBe("Success");
  });

});

describe("OCPP capture helpers", () => {
  let mock: MockUpstream;
  let sdk: ReturnType<typeof OCPPClient.start>;

  beforeEach(async () => {
    mock = await startMockUpstream();
  });

  afterEach(async () => {
    await sdk.close();
    await mock.close();
  });

  it("captureConnect / captureMessage / captureDisconnect ship the right event types and payload", async () => {
    sdk = OCPPClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    const connectionId = "conn-1";
    const identity = { chargerId: "CP-001" };

    sdk.captureConnect({ identity, connectionId });
    sdk.captureMessage({
      identity,
      connectionId,
      data: '{"action":"BootNotification"}',
      direction: "FROM_CP", // BootNotification is sent by the charge point
    });
    sdk.captureDisconnect({ identity, connectionId });

    const records = () =>
      mock.received
        .filter((r) => r.path === "/v1/ocpp")
        .flatMap((r) => r.records);
    await waitFor(() => records().length === 3);

    const sorted = records().sort(
      (a, b) => Number(a.event_type) - Number(b.event_type),
    );
    // Disconnect=0, Connect=1, Message=2 (OCPPEventType enum order).
    expect(sorted.map((r) => Number(r.event_type))).toEqual([0, 1, 2]);
    expect(sorted.every((r) => r.charger_id === "CP-001")).toBe(true);
    expect(sorted.every((r) => r.connection_id === connectionId)).toBe(true);

    const msgRec = sorted.find((r) => Number(r.event_type) === 2)!;
    // Wire field is `raw_frame` (see transport.ts), base64-encoded.
    const payload = Buffer.from(String(msgRec.raw_frame), "base64").toString("utf8");
    expect(JSON.parse(payload)).toEqual({ action: "BootNotification" });
    expect(msgRec.direction).toBe("FROM_CP");
  });

  it("connection() opens a session that owns the connectionId", async () => {
    sdk = OCPPClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    // The session mints the connectionId and carries the identity — the
    // per-frame call passes neither.
    const session = sdk.connection({ chargerId: "CP-SESSION" });
    session.message('{"action":"Heartbeat"}', "FROM_CP");
    session.disconnect();

    const records = () =>
      mock.received
        .filter((r) => r.path === "/v1/ocpp")
        .flatMap((r) => r.records);
    await waitFor(() => records().length === 3);

    const sorted = records().sort(
      (a, b) => Number(a.event_type) - Number(b.event_type),
    );
    // Disconnect=0, Connect=1, Message=2.
    expect(sorted.map((r) => Number(r.event_type))).toEqual([0, 1, 2]);
    // All three records carry the single SDK-minted connectionId.
    expect(sorted.every((r) => r.connection_id === session.connectionId)).toBe(true);
    expect(sorted.every((r) => r.charger_id === "CP-SESSION")).toBe(true);

    const msgRec = sorted.find((r) => Number(r.event_type) === 2)!;
    const frame = Buffer.from(String(msgRec.raw_frame), "base64").toString("utf8");
    expect(JSON.parse(frame)).toEqual({ action: "Heartbeat" });
  });

  it("drops the whole message when the payload overflows", async () => {
    const TINY_CAP = 64;
    sdk = OCPPClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
      maxCaptureBytes: TINY_CAP,
    });

    sdk.captureMessage({
      identity: { chargerId: "CP-001" },
      connectionId: "c1",
      data: "Q".repeat(TINY_CAP * 4),
      direction: "FROM_CP",
    });

    // Connect on the same connection is unaffected — the drop is
    // per-message, not per-connection.
    sdk.captureConnect({
      identity: { chargerId: "CP-001" },
      connectionId: "c1",
    });

    await waitFor(() => mock.received.flatMap((r) => r.records).length === 1);
    const recs = mock.received.flatMap((r) => r.records);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.event_type).toBe(1); // Connect only
  });
});
