/** Config resolution, the buffer, the counters, and the chokepoint. */

import { describe, expect, it, vi } from "vitest";

import { RingBuffer } from "../src/buffer.js";
import {
  ApiKeyError,
  ConfigError,
  DEFAULT_ENDPOINT,
  EndpointError,
  EVPandaError,
} from "../src/index.js";
import {
  DEFAULTS,
  resolveEndpoint,
  resolveLogMode,
  resolveOCPIConfig,
  resolveOCPPConfig,
} from "../src/config.js";
import { Counters, logLine, subtract, totalDropped } from "../src/stats.js";
import { makeOCPIRedactor } from "../src/ocpi/redact.js";
import { prepareOCPI, prepareOCPP } from "../src/worker.js";
import { OCPPEventType, sizeOf, validCharger, validPlatform } from "../src/types.js";

import type { OCPIMessage, OCPPMessage, Platform } from "../src/types.js";

const PARTNER: Platform = { id: "acme", name: "Acme Mobility" };
const CAP = 1024;

function ocpi(data: Record<string, unknown> = {}): OCPIMessage {
  return {
    direction: "IN",
    platform: PARTNER,
    data: { method: "POST", url: "/ocpi/2.2/cdrs", ...data },
  };
}

function ocpp(overrides: Partial<OCPPMessage> = {}): OCPPMessage {
  return {
    eventType: OCPPEventType.Message,
    charger: { id: "CP-001" },
    connectionId: "c-1",
    direction: "FROM_CP",
    payload: Buffer.from('[2,"1","Heartbeat",{}]'),
    ...overrides,
  };
}

describe("config", () => {
  it("applies every default", () => {
    const r = resolveOCPPConfig({ apiKey: "k" });
    expect(r.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(r.maxBufferBytes).toBe(DEFAULTS.maxBufferBytes);
    expect(r.maxCaptureBytes).toBe(DEFAULTS.maxCaptureBytes);
    expect(r.flushInterval).toBe(DEFAULTS.flushInterval);
    expect(r.drainTimeout).toBe(DEFAULTS.drainTimeout);
    expect(r.logMode).toBe("errors");
    expect(r.logger).toBeDefined();
  });

  it("defaults the endpoint to production and trims what it is given", () => {
    expect(resolveEndpoint(undefined)).toBe(DEFAULT_ENDPOINT);
    expect(resolveEndpoint("  ")).toBe(DEFAULT_ENDPOINT);
    expect(resolveEndpoint("http://localhost:8080/")).toBe("http://localhost:8080");
  });

  it.each(["not-a-url", "ftp://example.com", 42])(
    "rejects a malformed endpoint (%s)",
    (raw) => {
      expect(() => resolveEndpoint(raw)).toThrow(EndpointError);
    },
  );

  it("falls back to the environment for the api key", () => {
    vi.stubEnv("EVPANDA_API_KEY", "from-env");
    expect(resolveOCPPConfig({}).apiKey).toBe("from-env");
    expect(resolveOCPPConfig({ apiKey: "explicit" }).apiKey).toBe("explicit");
    vi.unstubAllEnvs();
  });

  it("makes every config fault matchable at the level you care about", () => {
    expect(() => resolveOCPPConfig({})).toThrow(ApiKeyError);
    expect(() => resolveOCPPConfig({})).toThrow(ConfigError);
    expect(() => resolveOCPPConfig({})).toThrow(EVPandaError);
    expect(() => resolveOCPPConfig({ apiKey: "k", endpoint: "nope" })).toThrow(
      EndpointError,
    );
  });

  it("falls back and warns on an out-of-range tunable", () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const r = resolveOCPPConfig({
      apiKey: "k",
      logger,
      maxBufferBytes: 10,
      flushInterval: -1,
      drainTimeout: 1_000,
    });
    expect(r.maxBufferBytes).toBe(DEFAULTS.maxBufferBytes);
    expect(r.flushInterval).toBe(DEFAULTS.flushInterval);
    expect(r.drainTimeout).toBe(DEFAULTS.drainTimeout);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("resolves the log mode from the config, then the environment", () => {
    expect(resolveLogMode(undefined).mode).toBe("errors");
    expect(resolveLogMode("debug").mode).toBe("debug");
    expect(resolveLogMode("nonsense").mode).toBe("errors");
    expect(resolveLogMode("nonsense").warning).toBeDefined();

    vi.stubEnv("EVPANDA_LOG", "silent");
    expect(resolveLogMode(undefined).mode).toBe("silent");
    // The config still wins over the environment.
    expect(resolveLogMode("debug").mode).toBe("debug");
    vi.unstubAllEnvs();
  });

  it("has no logger at all in silent mode", () => {
    expect(resolveOCPPConfig({ apiKey: "k", logMode: "silent" }).logger).toBeUndefined();
  });

  it("normalizes the extra header allowlist", () => {
    const r = resolveOCPIConfig({
      apiKey: "k",
      ocpiAllowedHeaders: [" X-Trace ", "x-trace", "", "X-Other"],
    });
    expect(r.allowedHeaders).toEqual(["x-trace", "x-other"]);
  });

  it("cannot be broken by a host logger that throws", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: () => {
        throw new Error("boom");
      },
    };
    expect(
      resolveOCPPConfig({ apiKey: "k", logger, flushInterval: -1 }).flushInterval,
    ).toBe(DEFAULTS.flushInterval);
  });
});

describe("identity", () => {
  it("requires id and name, and pairs the tenant fields", () => {
    expect(validPlatform(PARTNER)).toBe(true);
    expect(validPlatform({ id: "", name: "Acme" })).toBe(false);
    expect(validPlatform({ id: "a", name: "  " })).toBe(false);
    expect(validPlatform({ ...PARTNER, tenantId: "t" })).toBe(false);
    expect(validPlatform({ ...PARTNER, tenantId: "t", tenantName: "T" })).toBe(true);
    expect(validCharger({ id: "CP-001" })).toBe(true);
    expect(validCharger({ id: " " })).toBe(false);
  });
});

describe("buffer", () => {
  const frame = (payload: Buffer, id = "c-1") => ({
    capturedAt: "2026-08-30T00:00:00.000Z",
    message: ocpp({ payload, connectionId: id }),
    size: 0,
  });

  it("rejects a non-positive budget", () => {
    expect(() => new RingBuffer(0, new Counters())).toThrow(/positive integer/);
  });

  it("drains oldest first, then empties", () => {
    const b = new RingBuffer(1 << 20, new Counters());
    for (let i = 0; i < 5; i++) b.enqueue(frame(Buffer.from(String(i))));
    const drained = b.drain();
    expect(drained.map((e) => (e.message as OCPPMessage).payload?.toString())).toEqual([
      "0", "1", "2", "3", "4",
    ]);
    expect(b.length).toBe(0);
    expect(b.byteLength).toBe(0);
    expect(b.drain()).toEqual([]);
  });

  it("evicts by bytes and never exceeds the budget", () => {
    const counters = new Counters();
    const b = new RingBuffer(4096, counters);
    for (let i = 0; i < 200; i++) {
      b.enqueue(frame(Buffer.alloc(i % 64, 0x78)));
      expect(b.byteLength).toBeLessThanOrEqual(4096);
    }
    expect(counters.snapshot().droppedEvicted).toBeGreaterThan(0);
  });

  it("drops a message larger than the whole budget outright", () => {
    const counters = new Counters();
    const b = new RingBuffer(64 * 1024, counters);
    b.enqueue(frame(Buffer.alloc(128)));
    b.enqueue(frame(Buffer.alloc(64 * 1024)));
    expect(b.length).toBe(1);
    expect(counters.snapshot().droppedOversize).toBe(1);
  });

  it("accounts a connect event as cheaper than a message", () => {
    const connect = ocpp({
      eventType: OCPPEventType.Connect,
      direction: undefined,
      payload: undefined,
    });
    expect(sizeOf(connect)).toBeLessThan(sizeOf(ocpp()));
  });
});

describe("counters", () => {
  it("charges each reason to its own counter", () => {
    const c = new Counters();
    c.countCaptured();
    for (const r of ["invalidIdentity", "oversize", "evicted", "undeliverable", "fault"] as const) {
      c.countDrop(r);
    }
    c.countDrop("none");
    c.countDrop("oversize", 0);
    const s = c.snapshot();
    expect(s.captured).toBe(1);
    expect(totalDropped(s)).toBe(5);
  });

  it("differences the monotonic fields and carries the gauges across", () => {
    const c = new Counters();
    c.countDrop("evicted", 3);
    const first = c.snapshot();
    c.countDrop("evicted", 2);
    const delta = subtract(c.snapshot(7, 99), first);
    expect(delta.droppedEvicted).toBe(2);
    expect(delta.bufferedMessages).toBe(7);
    expect(logLine(delta)).toBe("evicted=2 buffered=7 buffer_bytes=99");
  });
});

describe("the OCPI chokepoint", () => {
  it("accepts a good message", () => {
    const [env, reason] = prepareOCPI(ocpi(), undefined, CAP);
    expect(reason).toBe("none");
    expect(env?.capturedAt).toMatch(/Z$/);
  });

  it("drops an invalid identity", () => {
    const msg = ocpi();
    msg.platform = { id: "", name: "Acme" };
    expect(prepareOCPI(msg, undefined, CAP)).toEqual([
      undefined,
      "invalidIdentity",
      0,
    ]);
  });

  it.each(["requestBody", "responseBody"])("drops an oversize %s", (field) => {
    const [env, reason] = prepareOCPI(
      ocpi({ [field]: Buffer.alloc(CAP + 1) }),
      undefined,
      CAP,
    );
    expect(env).toBeUndefined();
    expect(reason).toBe("oversize");
  });

  it("takes ownership, so what the host mutates cannot reach the buffer", () => {
    const headers = { "content-type": "application/json" };
    const body = Buffer.from('{"id":"cdr-1"}');
    const [env] = prepareOCPI(
      ocpi({ requestHeaders: headers, requestBody: body }),
      undefined,
      CAP,
    );
    headers["content-type"] = "text/plain";
    (headers as Record<string, string>).authorization = "Token secret";
    body.write("tampered!!!!!!");

    const captured = (env!.message as OCPIMessage).data;
    expect(captured.requestHeaders).toEqual({ "content-type": "application/json" });
    expect(Buffer.from(captured.requestBody as Uint8Array).toString()).toBe(
      '{"id":"cdr-1"}',
    );
  });

  it("encodes a string body as UTF-8", () => {
    const [env] = prepareOCPI(ocpi({ requestBody: "héllo" }), undefined, CAP);
    const body = (env!.message as OCPIMessage).data.requestBody as Uint8Array;
    expect(Buffer.from(body).toString("utf8")).toBe("héllo");
  });

  it("runs the redactor, and skips a missing one", () => {
    const withSecret = ocpi({
      requestHeaders: { authorization: "Token secret", accept: "*/*" },
    });
    const [redacted] = prepareOCPI(withSecret, makeOCPIRedactor(), CAP);
    expect((redacted!.message as OCPIMessage).data.requestHeaders).toEqual({
      accept: "*/*",
    });

    const [raw] = prepareOCPI(
      ocpi({ requestHeaders: { authorization: "Token secret" } }),
      undefined,
      CAP,
    );
    expect((raw!.message as OCPIMessage).data.requestHeaders).toEqual({
      authorization: "Token secret",
    });
  });
});

describe("the OCPP chokepoint", () => {
  it("accepts a good frame", () => {
    expect(prepareOCPP(ocpp(), undefined, CAP)[1]).toBe("none");
  });

  it("drops an invalid identity and an oversize frame", () => {
    expect(prepareOCPP(ocpp({ charger: { id: "" } }), undefined, CAP)[1]).toBe(
      "invalidIdentity",
    );
    expect(
      prepareOCPP(ocpp({ payload: Buffer.alloc(CAP + 1) }), undefined, CAP)[1],
    ).toBe("oversize");
  });

  it("requires a frame and a direction on a message event", () => {
    expect(prepareOCPP(ocpp({ payload: undefined }), undefined, CAP)[1]).toBe(
      "oversize",
    );
    // A frame that is not valid UTF-8 takes the message with it, and is
    // counted both as the body that went missing and the message that did.
    const [envelope, reason, bodiesDropped] = prepareOCPP(
      ocpp({ payload: Uint8Array.from([0xff, 0xfe, 0x00, 0x01]) }),
      undefined,
      CAP,
    );
    expect(envelope).toBeUndefined();
    expect(reason).toBe("oversize");
    expect(bodiesDropped).toBe(1);
  });

  it("drops an OCPI body that is not valid UTF-8 but keeps the exchange", () => {
    const msg = ocpi();
    msg.data.requestBody = Uint8Array.from([0xff, 0xfe, 0x00, 0x01]);
    msg.data.responseBody = '{"status_code":1000}';

    const [envelope, reason, bodiesDropped] = prepareOCPI(msg, undefined, CAP);
    expect(reason).toBe("none");
    expect(bodiesDropped).toBe(1);
    expect(envelope!.message.data.requestBody).toBeUndefined();
    // The good half survives untouched.
    expect(new TextDecoder().decode(envelope!.message.data.responseBody)).toBe(
      '{"status_code":1000}',
    );
  });

  it("reports the OCPP frame direction", () => {
    expect(prepareOCPP(ocpp({ direction: undefined }), undefined, CAP)[1]).toBe(
      "oversize",
    );
  });

  it("lets connect and disconnect carry no frame", () => {
    for (const eventType of [OCPPEventType.Connect, OCPPEventType.Disconnect]) {
      const [env, reason] = prepareOCPP(
        ocpp({ eventType, payload: undefined, direction: undefined }),
        undefined,
        CAP,
      );
      expect(reason).toBe("none");
      expect(env).toBeDefined();
    }
  });

  it("accepts a string frame", () => {
    const [env] = prepareOCPP(
      { ...ocpp(), payload: '[2,"1","Heartbeat",{}]' as unknown as Uint8Array },
      undefined,
      CAP,
    );
    const payload = (env!.message as OCPPMessage).payload as Uint8Array;
    expect(Buffer.from(payload).toString()).toBe('[2,"1","Heartbeat",{}]');
  });
});
