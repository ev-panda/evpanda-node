/** End to end: capture on one side, decoded records on the other. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startOCPI } from "../src/index.js";
import { BATCH_CAP } from "../src/worker.js";
import {
  CHARGER,
  PARTNER,
  exchange,
  ocpiClient,
  ocppClient,
  startMockUpstream,
} from "./helpers.js";

import type { MockUpstream } from "./helpers.js";

let mock: MockUpstream;

beforeEach(async () => {
  mock = await startMockUpstream();
});
afterEach(async () => {
  await mock.close();
});

/** A captured body as it arrives on the wire: UTF-8 text. */
const body = (v: unknown) => String(v);

describe("OCPI", () => {
  it("delivers an inbound exchange intact", async () => {
    const panda = ocpiClient(mock);
    panda.captureInboundMessage({
      identity: { ...PARTNER, tenantId: "t-1", tenantName: "Tenant One" },
      data: exchange(),
    });
    await panda.flush();
    await panda.close();

    const record = (await mock.waitFor(1))[0]!;
    expect(mock.received[0]!.path).toBe("/v1/ocpi");
    expect(mock.received[0]!.headers["x-api-key"]).toBe("test-key");
    expect(record).toMatchObject({
      direction: "IN",
      platform_id: "acme",
      platform_name: "Acme Mobility",
      tenant_id: "t-1",
      tenant_name: "Tenant One",
      http_method: "POST",
      url: "/ocpi/2.2/cdrs",
      response_status_code: 201,
    });
    expect(body(record.request_body)).toBe('{"id":"cdr-1"}');
    expect(record.request_body_encoding).toBe("utf8");
    expect(String(record.captured_at)).toMatch(/Z$/);
  });

  it("stamps the direction from the method you call", async () => {
    const panda = ocpiClient(mock);
    panda.captureInboundMessage({ identity: PARTNER, data: exchange() });
    panda.captureOutboundMessage({ identity: PARTNER, data: exchange() });
    await panda.flush();
    await panda.close();

    const records = await mock.waitFor(2);
    expect(records.map((r) => r.direction)).toEqual(["IN", "OUT"]);
  });

  it("never lets a secret reach the wire", async () => {
    const panda = ocpiClient(mock);
    panda.captureOutboundMessage({
      identity: PARTNER,
      data: exchange({
        url: "/ocpi/2.2/credentials",
        requestHeaders: { Authorization: "Token super-secret", accept: "*/*" },
        requestBody: Buffer.from(JSON.stringify({ token: "another-secret" })),
      }),
    });
    await panda.flush();
    await panda.close();

    const record = (await mock.waitFor(1))[0]!;
    expect(record.request_headers).toEqual({ accept: "*/*" });
    expect(JSON.parse(body(record.request_body))).toEqual({ token: "[redacted]" });
  });

  it("serializes absent values as null", async () => {
    const panda = ocpiClient(mock);
    panda.captureInboundMessage({
      identity: PARTNER,
      data: { method: "GET", url: "/ocpi/2.2/versions" },
    });
    await panda.flush();
    await panda.close();

    const record = (await mock.waitFor(1))[0]!;
    expect(record.response_status_code).toBeNull();
    expect(record.request_body).toBeNull();
    expect(record.response_headers).toBeNull();
    expect(record.tenant_id).toBeNull();
  });
});

describe("OCPP", () => {
  it("delivers a session as three events", async () => {
    const panda = ocppClient(mock);
    const session = panda.connection(CHARGER);
    session.message('[2,"1","Heartbeat",{}]', "FROM_CP");
    session.disconnect();
    await panda.flush();
    await panda.close();

    const records = await mock.waitFor(3);
    expect(mock.received[0]!.path).toBe("/v1/ocpp");
    expect(records.map((r) => r.event_type)).toEqual([1, 2, 0]);
    expect(records[1]!.direction).toBe("FROM_CP");
    expect(body(records[1]!.raw_frame)).toBe('[2,"1","Heartbeat",{}]');
    expect(records[1]!.raw_frame_encoding).toBe("utf8");
    expect(records[0]!.raw_frame_encoding).toBeNull();
    expect(records[0]!.raw_frame).toBeNull();
    expect(new Set(records.map((r) => r.connection_id)).size).toBe(1);
  });

  it("mints a fresh connection id per session", () => {
    const panda = ocppClient(mock);
    expect(panda.connection(CHARGER).connectionId).not.toBe(
      panda.connection(CHARGER).connectionId,
    );
    void panda.close();
  });
});

describe("delivery", () => {
  it("flushes a full batch without waiting for the interval", async () => {
    const panda = ocppClient(mock);
    const session = panda.connection(CHARGER);
    for (let i = 0; i < BATCH_CAP; i++) {
      session.message('[2,"1","Heartbeat",{}]', "FROM_CP");
    }
    // No flush() call: the size trigger alone must deliver it.
    expect((await mock.waitFor(BATCH_CAP)).length).toBeGreaterThanOrEqual(BATCH_CAP);
    await panda.close();
  });

  it("does not lose the size trigger raised during a flush", async () => {
    // A batch that fills while a flush is in flight has no trigger of its
    // own — the producer sees one already running. Go's wake channel holds
    // that token and Python's Event stays set; this pins the same
    // behaviour here, rather than falling back to the flush interval.
    mock.delayMs = 150;
    const panda = ocppClient(mock, { flushInterval: 3_600_000 });
    const session = panda.connection(CHARGER);

    const frame = '[2,"1","Heartbeat",{}]';
    for (let i = 0; i < BATCH_CAP; i++) session.message(frame, "FROM_CP");
    await new Promise((r) => setTimeout(r, 20)); // flush #1 is now in flight
    for (let i = 0; i < BATCH_CAP; i++) session.message(frame, "FROM_CP");

    // Both batches must land well inside the (disabled) flush interval.
    await mock.waitFor(2 * BATCH_CAP, 3_000);
    await panda.close();
  }, 20_000);

  it("chunks a large backlog at the batch cap", async () => {
    const panda = ocppClient(mock);
    const session = panda.connection(CHARGER);
    for (let i = 0; i < BATCH_CAP + 500; i++) {
      session.message('[2,"1","Heartbeat",{}]', "FROM_CP");
    }
    await panda.flush();
    await panda.close();

    await mock.waitFor(BATCH_CAP + 501);
    expect(mock.received.every((r) => r.records.length <= BATCH_CAP)).toBe(true);
  });

  it("delivers what was buffered on close", async () => {
    const panda = ocpiClient(mock);
    panda.captureInboundMessage({ identity: PARTNER, data: exchange() });
    expect(await panda.close()).toBe(true);
    expect(mock.records).toHaveLength(1);
  });

  it("flushes on the interval on its own", async () => {
    const panda = ocpiClient(mock, { flushInterval: 20 });
    panda.captureInboundMessage({ identity: PARTNER, data: exchange() });
    expect((await mock.waitFor(1)).length).toBe(1);
    await panda.close();
  });

  it("compresses a large body with zstd and leaves a small one alone", async () => {
    const big = ocpiClient(mock);
    for (let i = 0; i < 50; i++) {
      big.captureInboundMessage({ identity: PARTNER, data: exchange() });
    }
    await big.flush();
    await big.close();
    expect(mock.received[0]!.headers["content-encoding"]).toBe("zstd");

    const small = ocpiClient(mock);
    small.captureInboundMessage({
      identity: PARTNER,
      data: { method: "GET", url: "/v" },
    });
    await small.flush();
    await small.close();
    expect(mock.received[1]!.headers["content-encoding"]).toBeUndefined();
  });

  it("retries a transient failure", async () => {
    mock.statuses.push(500, 503);
    const panda = ocpiClient(mock);
    panda.captureInboundMessage({ identity: PARTNER, data: exchange() });
    await panda.flush();
    await panda.close();
    expect(mock.records).toHaveLength(1);
    expect(panda.stats().droppedUndeliverable).toBe(0);
  }, 20_000);

  it.each([400, 401, 413])("never retries a permanent %d", async (status) => {
    mock.statuses.push(status);
    const panda = ocpiClient(mock);
    panda.captureInboundMessage({ identity: PARTNER, data: exchange() });
    await panda.flush();
    await panda.close();
    expect(mock.records).toHaveLength(0);
    expect(panda.stats().droppedUndeliverable).toBe(1);
  });
});

describe("the client", () => {
  it("is inert, not broken, without an api key", async () => {
    const panda = startOCPI({ endpoint: mock.url, logMode: "silent" });
    expect(panda.error?.name).toBe("ApiKeyError");
    expect(panda.capturing()).toBeUndefined();
    panda.captureInboundMessage({ identity: PARTNER, data: exchange() });
    await panda.flush();
    expect(await panda.close()).toBe(true);
    expect(panda.stats().captured).toBe(0);
  });

  it("counts what it drops, and keeps the tally after close", async () => {
    const panda = ocpiClient(mock);
    panda.captureInboundMessage({ identity: PARTNER, data: exchange() });
    panda.captureInboundMessage({
      identity: { id: "", name: "" },
      data: exchange(),
    });
    panda.captureInboundMessage({
      identity: PARTNER,
      data: exchange({ requestBody: Buffer.alloc(70_000) }),
    });
    const live = panda.stats();
    expect(live).toMatchObject({ captured: 1, droppedInvalid: 1, droppedOversize: 1 });
    expect(live.bufferedMessages).toBe(1);

    await panda.close();
    const final = panda.stats();
    expect(final.captured).toBe(1);
    expect(final.droppedInvalid).toBe(1);
    expect(final.bufferedMessages).toBe(0);
  });

  it("stops capturing after close, and close is idempotent", async () => {
    const panda = ocpiClient(mock);
    panda.captureInboundMessage({ identity: PARTNER, data: exchange() });
    expect(await panda.close()).toBe(true);
    panda.captureInboundMessage({ identity: PARTNER, data: exchange() });
    expect(panda.capturing()).toBeUndefined();
    expect(panda.stats().captured).toBe(1);
    expect(await panda.close()).toBe(true);
  });

  it("survives an upstream that is simply not there", async () => {
    const panda = startOCPI({
      endpoint: "http://127.0.0.1:1",
      apiKey: "k",
      flushInterval: 3_600_000,
      logMode: "silent",
      drainTimeout: 5_000,
    });
    for (let i = 0; i < 10; i++) {
      panda.captureInboundMessage({ identity: PARTNER, data: exchange() });
    }
    await panda.close(5_000);
    expect(panda.stats().droppedUndeliverable).toBeGreaterThan(0);
  }, 20_000);

  it("evicts rather than growing past the buffer budget", async () => {
    const panda = ocpiClient(mock, {
      maxBufferBytes: 64 * 1024,
      maxCaptureBytes: 1024,
    });
    for (let i = 0; i < 500; i++) {
      panda.captureInboundMessage({
        identity: PARTNER,
        data: exchange({ requestBody: Buffer.alloc(512) }),
      });
    }
    const stats = panda.stats();
    expect(stats.bufferBytes).toBeLessThanOrEqual(64 * 1024);
    expect(stats.droppedEvicted).toBeGreaterThan(0);
    await panda.close();
  });
});
