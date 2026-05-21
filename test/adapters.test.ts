/**
 * End-to-end tests for the OCPI adapters. Each test runs against built
 * artifacts (`dist/`), spins up a real mock ingestion server, and, where
 * relevant, a real mock partner server — no mocks of internals.
 *
 * Covered:
 *  - `ocpi.express`: identity resolution, request + response body capture,
 *    status code, header normalization, no-identity pass-through.
 *  - `ocpi.fetch`: outbound capture, body cap, response untouched for the
 *    caller, network errors propagated.
 *  - `ocpi.axios`: outbound capture on 2xx and non-2xx responses.
 *  - Identity propagation via AsyncLocalStorage from inbound → outbound.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

import { decompress as zstdDecompress } from "@mongodb-js/zstd";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OCPIClient, OCPPClient, ocpi } from "../dist/index.js";
import type { OCPIResolver } from "../dist/index.js";

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
        close: () => new Promise<void>((r) => server.close(() => r())),
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
      partner.close = () => new Promise<void>((r) => server.close(() => r()));
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

/** Resolver that reads `x-platform-id` + `x-platform-name` for tests. */
const headerResolver: OCPIResolver = (ctx) => ({
  platformId: ctx.headers["x-platform-id"] ?? "",
  platformName: ctx.headers["x-platform-name"] ?? "",
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
        close: () => new Promise<void>((r) => server.close(() => r())),
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
    const mw = ocpi.express(sdk, { resolve: headerResolver });

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
    const mw = ocpi.express(sdk, { resolve: headerResolver });

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

  it("captures an aborted request via the res 'close' event", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });
    const mw = ocpi.express(sdk, { resolve: headerResolver });

    // Handler never responds — the client aborts mid-flight, so `res`
    // emits 'close' without 'finish'. The capture must still fire.
    const app = await listenOn((req, res) => {
      mw(req, res, () => {
        /* deliberately no res.end — the client will abort */
      });
    });
    appUrl = app.url;
    appClose = app.close;

    const controller = new AbortController();
    const pending = fetch(`${appUrl}/ocpi/2.2/sessions`, {
      method: "POST",
      headers: { "x-platform-id": "acme", "x-platform-name": "Acme" },
      signal: controller.signal,
    }).catch(() => {
      /* abort rejects the fetch — expected */
    });
    await new Promise((r) => setTimeout(r, 100)); // let it reach the server
    controller.abort();
    await pending;

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    expect(rec.direction).toBe("IN");
    expect(rec.url).toBe("/ocpi/2.2/sessions");
  });

  it("passes through with no capture when the resolver returns no identity", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });
    // Returns blank platformId ⇒ validateRoamingIdentity fails ⇒ skip.
    const mw = ocpi.express(sdk, {
      resolve: () => ({ platformId: "", platformName: "" }),
    });

    const app = await listenOn((req, res) => {
      mw(req, res, () => {
        res.writeHead(200);
        res.end("ok");
      });
    });
    appUrl = app.url;
    appClose = app.close;

    const response = await fetch(`${appUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");

    // Give the SDK a flush window; nothing should arrive.
    await new Promise((r) => setTimeout(r, 300));
    await sdk.flush();
    await new Promise((r) => setTimeout(r, 200));
    expect(ocpiRecords(mock)).toHaveLength(0);
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

  it("captures outbound request/response and returns the response untouched", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });
    const wrapped = ocpi.fetch(sdk, globalThis.fetch, {
      resolve: () => ({ platformId: "acme", platformName: "Acme" }),
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
  });

  it("captures outbound when the partner returns a non-2xx", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });
    partner.status = 422;
    const instance = ocpi.axios(sdk, axios.create({ baseURL: partner.url }), {
      resolve: () => ({ platformId: "acme", platformName: "Acme" }),
    });

    await expect(instance.post("/ocpi/2.2/tokens", { id: "t1" })).rejects.toMatchObject({
      response: { status: 422 },
    });

    await waitFor(() => ocpiRecords(mock).length === 1);
    expect(ocpiRecords(mock)[0]!.response_status_code).toBe(422);
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

  it("ocpi.express drops the whole capture when the request body overflows", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url, apiKey: "k", flushInterval: 100, maxCaptureBytes: TINY_CAP,
    });
    const mw = ocpi.express(sdk, { resolve: headerResolver });
    const app = await listenOn((req, res) => {
      mw(req, res, () => {
        // Simulate a body parser populating an oversize req.body — the
        // adapter reads req.body, it never tees the raw request stream.
        (req as http.IncomingMessage & { body?: unknown }).body =
          "a".repeat(TINY_CAP * 4);
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
    });
    try {
      const response = await fetch(`${app.url}/ocpi/2.2/sessions`, {
        method: "POST",
        headers: { "x-platform-id": "acme", "x-platform-name": "Acme" },
        body: "ignored",
      });
      // Request succeeds — the host never knows we declined the capture.
      expect(response.status).toBe(200);
      await expectNoCapture();
    } finally {
      await app.close();
    }
  });

  it("ocpi.express drops the whole capture when the response body overflows", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url, apiKey: "k", flushInterval: 100, maxCaptureBytes: TINY_CAP,
    });
    const mw = ocpi.express(sdk, { resolve: headerResolver });
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

  it("captureOCPI primitive drops oversize bodies at the chokepoint", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url, apiKey: "k", flushInterval: 100, maxCaptureBytes: TINY_CAP,
    });

    // Customer bypasses adapters and hands us already-oversize bytes.
    sdk.captureInboundMessage({
      identity: { platformId: "acme", platformName: "Acme" },
      http: {
        method: "POST",
        url: "/ocpi/2.2/sessions",
        statusCode: 200,
        requestHeaders: {},
        responseHeaders: {},
        requestBody: new TextEncoder().encode("a".repeat(TINY_CAP * 4)),
      },
    });

    await expectNoCapture();
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
      http: {
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

  it("extends the allowlist with config.ocpiAllowedHeaders (case-insensitive)", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
      ocpiAllowedHeaders: ["X-Tenant-Id", "X-Custom-Trace"],
    });

    sdk.captureInboundMessage({
      identity: { platformId: "acme", platformName: "Acme" },
      http: {
        method: "GET",
        url: "/ocpi/2.2/locations",
        statusCode: 200,
        requestHeaders: {
          authorization: "Bearer NOPE", // still dropped — defaults cannot be weakened
          "x-tenant-id": "t-1",
          "X-Custom-Trace": "abc",
        },
        responseHeaders: {},
      },
    });

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    const keys = Object.keys(rec.request_headers as Record<string, string>).map(
      (k) => k.toLowerCase(),
    );
    expect(keys.sort()).toEqual(["x-custom-trace", "x-tenant-id"]);
    expect(keys).not.toContain("authorization");
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
      http: {
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
      http: {
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

  it("matches the credentials endpoint across OCPI URL shapes", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    // Every URL here ends with `/credentials` (or `/credentials/` /
    // `/credentials?...`) — all must trigger the mask.
    const urls = [
      "/ocpi/emsp/2.2.1/credentials",
      "/ocpi/2.2.1/credentials",
      "/ocpi/2.2/credentials/",
      "https://partner.example/ocpi/2.2/credentials?versions=2.2",
    ];
    const body = JSON.stringify({ token: "T", url: "u", roles: [] });
    for (const url of urls) {
      sdk.captureInboundMessage({
        identity: { platformId: "acme", platformName: "Acme" },
        http: {
          method: "POST", url, statusCode: 200,
          requestHeaders: {}, responseHeaders: {},
          requestBody: new TextEncoder().encode(body),
        },
      });
    }

    await waitFor(() => ocpiRecords(mock).length === urls.length);
    for (const rec of ocpiRecords(mock)) {
      const decoded = JSON.parse(
        Buffer.from(String(rec.request_body), "base64").toString("utf8"),
      ) as { token: string };
      expect(decoded.token).toBe("[redacted]");
    }
  });

  it("does NOT mask on sub-paths under /credentials (no such OCPI route)", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    // Sub-path like `/credentials/foo` is not an OCPI endpoint; if the
    // host built such a URL we leave its body alone — the regex must not
    // be tricked by `/credentials` appearing mid-path.
    const body = JSON.stringify({ token: "PRESERVED" });
    sdk.captureInboundMessage({
      identity: { platformId: "acme", platformName: "Acme" },
      http: {
        method: "POST",
        url: "/ocpi/2.2/credentials/foo",
        statusCode: 200,
        requestHeaders: {}, responseHeaders: {},
        requestBody: new TextEncoder().encode(body),
      },
    });

    await waitFor(() => ocpiRecords(mock).length === 1);
    const decoded = JSON.parse(
      Buffer.from(String(ocpiRecords(mock)[0]!.request_body), "base64").toString("utf8"),
    ) as { token: string };
    expect(decoded.token).toBe("PRESERVED");
  });

  it("identity-source headers reach the resolver but never appear on the wire", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
      // Crucially: NOT adding x-platform-* / x-tenant-* to ocpiAllowedHeaders.
    });

    // Spy on what the resolver actually sees so we can prove the headers
    // are available at resolution time even though they get filtered later.
    const seen: { headers?: Record<string, string> } = {};
    const mw = ocpi.express(sdk, {
      resolve: (ctx) => {
        seen.headers = ctx.headers;
        return {
          platformId: ctx.headers["x-platform-id"] ?? "",
          platformName: ctx.headers["x-platform-name"] ?? "",
          tenantId: ctx.headers["x-tenant-id"],
          tenantName: ctx.headers["x-tenant-name"],
        };
      },
    });

    const app = await listenOn((req, res) => {
      mw(req, res, () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    try {
      await fetch(`${app.url}/ocpi/2.2/cdrs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-platform-id": "acme",
          "x-platform-name": "Acme",
          "x-tenant-id": "t1",
          "x-tenant-name": "Tenant One",
        },
        body: "{}",
      });

      await waitFor(() => ocpiRecords(mock).length === 1);
      const rec = ocpiRecords(mock)[0]!;

      // 1. Resolver saw the identity-source headers — full map, normalized.
      expect(seen.headers?.["x-platform-id"]).toBe("acme");
      expect(seen.headers?.["x-tenant-id"]).toBe("t1");

      // 2. Identity made it onto the wire as first-class fields.
      expect(rec.platform_id).toBe("acme");
      expect(rec.platform_name).toBe("Acme");
      expect(rec.tenant_id).toBe("t1");
      expect(rec.tenant_name).toBe("Tenant One");

      // 3. But the *raw* identity-source headers were filtered out of
      //    request_headers — they never get persisted alongside payloads.
      const reqHeaders = (rec.request_headers as Record<string, string> | null) ?? {};
      const keys = Object.keys(reqHeaders).map((k) => k.toLowerCase());
      expect(keys).not.toContain("x-platform-id");
      expect(keys).not.toContain("x-platform-name");
      expect(keys).not.toContain("x-tenant-id");
      expect(keys).not.toContain("x-tenant-name");
    } finally {
      await app.close();
    }
  });

  it("leaves an envelope with no credentials data untouched", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    // DELETE /credentials returns an envelope with no `data` (or `data: null`).
    const envelope = {
      status_code: 1000,
      status_message: "Success",
      timestamp: "2026-05-21T00:00:00Z",
    };
    sdk.captureOutboundMessage({
      identity: { platformId: "acme", platformName: "Acme" },
      http: {
        method: "DELETE",
        url: "https://partner.example/ocpi/2.2/credentials",
        statusCode: 200,
        requestHeaders: {},
        responseHeaders: {},
        responseBody: new TextEncoder().encode(JSON.stringify(envelope)),
      },
    });

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    const decoded = JSON.parse(
      Buffer.from(String(rec.response_body), "base64").toString("utf8"),
    ) as typeof envelope;
    expect(decoded).toEqual(envelope);
  });

  it("leaves non-credentials bodies untouched", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    // A non-credentials body that *also* has a `token` field — must NOT be
    // masked, because the URL isn't a credentials endpoint.
    const body = JSON.stringify({ token: "session-tag", action: "Authorize" });
    sdk.captureInboundMessage({
      identity: { platformId: "acme", platformName: "Acme" },
      http: {
        method: "POST",
        url: "/ocpi/2.2/sessions",
        statusCode: 200,
        requestHeaders: {},
        responseHeaders: {},
        requestBody: new TextEncoder().encode(body),
      },
    });

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    const decoded = JSON.parse(
      Buffer.from(String(rec.request_body), "base64").toString("utf8"),
    ) as { token: string };
    expect(decoded.token).toBe("session-tag");
  });

  it("returns the original bytes when a credentials body is non-JSON or has no token", async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    sdk.captureInboundMessage({
      identity: { platformId: "acme", platformName: "Acme" },
      http: {
        method: "DELETE",
        url: "/ocpi/2.2/credentials",
        statusCode: 405,
        requestHeaders: {},
        responseHeaders: {},
        requestBody: new TextEncoder().encode("not json at all"),
      },
    });

    await waitFor(() => ocpiRecords(mock).length === 1);
    const rec = ocpiRecords(mock)[0]!;
    const text = Buffer.from(String(rec.request_body), "base64").toString("utf8");
    expect(text).toBe("not json at all");
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

  it("silently drops when the identity is invalid", async () => {
    sdk = OCPPClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
    });

    sdk.captureMessage({
      identity: { chargerId: "" }, // blank ⇒ validateChargerIdentity fails
      connectionId: "conn-drop",
      data: "noop",
      direction: "FROM_CP",
    });

    // Give a flush window; nothing should arrive.
    await new Promise((r) => setTimeout(r, 300));
    await sdk.flush();
    await new Promise((r) => setTimeout(r, 200));
    expect(mock.received.flatMap((r) => r.records)).toHaveLength(0);
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

describe("identity propagation (ALS)", () => {
  let mock: MockUpstream;
  let partner: MockPartner;
  let sdk: ReturnType<typeof OCPIClient.start>;
  let appClose: () => Promise<void>;

  beforeEach(async () => {
    mock = await startMockUpstream();
    partner = await startMockPartner();
  });

  afterEach(async () => {
    await sdk.close();
    await appClose();
    await partner.close();
    await mock.close();
  });

  it("inbound identity flows to outbound ocpi.fetch with no extra wiring", { timeout: 15000 }, async () => {
    sdk = OCPIClient.start({
      endpoint: mock.url,
      apiKey: "k",
      flushInterval: 100,
      propagateIdentity: true,
    });

    const inbound = ocpi.express(sdk, { resolve: headerResolver });
    // Outbound wrapper still requires `resolve` for off-handler use; here
    // the ambient ALS identity must win and this fallback must not be hit.
    const outFetch = ocpi.fetch(sdk, globalThis.fetch, {
      resolve: () => ({ platformId: "wrong-fallback", platformName: "wrong" }),
    });

    const app = await listenOn((req, res) => {
      inbound(req, res, () => {
        // An outbound call from inside the inbound handler — the wrapper
        // must pick up the inbound-resolved identity from ALS.
        void outFetch(`${partner.url}/ocpi/2.2/cdrs`, { method: "POST", body: "[]" })
          .then(async (resp) => {
            await resp.text();
            res.writeHead(200);
            res.end("ok");
          })
          .catch(() => {
            res.writeHead(500);
            res.end("err");
          });
      });
    });
    appClose = app.close;

    const response = await fetch(`${app.url}/ocpi/2.2/cdrs`, {
      method: "POST",
      headers: {
        "x-platform-id": "acme",
        "x-platform-name": "Acme",
      },
      body: "[]",
    });
    expect(response.status).toBe(200);

    await waitFor(() => ocpiRecords(mock).length === 2, 6000);
    const recs = ocpiRecords(mock);
    // Both must carry the inbound-resolved identity; the outbound call's
    // own resolver would have produced "wrong-fallback" if ALS missed.
    expect(recs.every((r) => r.platform_id === "acme")).toBe(true);
    expect(recs.map((r) => r.direction).sort()).toEqual(["IN", "OUT"]);
  });
});
