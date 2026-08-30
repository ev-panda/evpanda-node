/** The three OCPI adapters, and the identity carriers they share. */

import http from "node:http";

import axiosLib from "axios";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ocpi } from "../src/index.js";

import type { AddressInfo } from "node:net";
import type { Capturer } from "../src/ocpi/adapters/resolver.js";
import type { HTTPExchange, Platform } from "../src/types.js";

const PARTNER: Platform = { id: "acme", name: "Acme Mobility" };

/** A Capturer that records instead of buffering. */
class Fake implements Capturer {
  inbound: { identity: Platform; data: HTTPExchange }[] = [];
  outbound: { identity: Platform; data: HTTPExchange }[] = [];
  /** `null` stands for a closed client — `capturing()` reports undefined. */
  constructor(private readonly _max: number | null = 65_536) {}
  captureInboundMessage(msg: { identity: Platform; data: HTTPExchange }): void {
    this.inbound.push(msg);
  }
  captureOutboundMessage(msg: { identity: Platform; data: HTTPExchange }): void {
    this.outbound.push(msg);
  }
  capturing(): number | undefined {
    return this._max ?? undefined;
  }
}

/** A Capturer that throws from everything it has. */
class Exploding implements Capturer {
  capturing(): number | undefined {
    throw new Error("boom");
  }
  captureInboundMessage(): void {
    throw new Error("boom");
  }
  captureOutboundMessage(): void {
    throw new Error("boom");
  }
}

const text = (v: Uint8Array | string | undefined) =>
  v === undefined ? undefined : Buffer.from(v as Uint8Array).toString("utf8");

// ── A host server the express adapter is mounted on ──────────────────────

interface Host {
  url: string;
  close(): Promise<void>;
}

async function startHost(
  handlers: ((req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void)[],
): Promise<Host> {
  const server = http.createServer((req, res) => {
    let i = 0;
    const next = (): void => {
      const handler = handlers[i++];
      if (handler) handler(req, res, next);
    };
    next();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close() {
      server.closeAllConnections?.();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** The application under the middleware: echoes a JSON body back. */
const echo = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  res.writeHead(201, { "content-type": "application/json" });
  res.end('{"status_code":1000}');
};

describe("the express adapter", () => {
  let host: Host | undefined;
  afterEach(async () => {
    await host?.close();
    host = undefined;
  });

  it("captures an exchange the auth layer stamped", async () => {
    const client = new Fake();
    host = await startHost([
      ocpi.express(client),
      (req, _res, next) => {
        // An auth layer *inside* the capture middleware: mount order does
        // not matter, because the request object is read at the end.
        ocpi.setIdentity(req, PARTNER);
        next();
      },
      echo,
    ]);

    const res = await fetch(`${host.url}/ocpi/2.2/cdrs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"id":"cdr-1"}',
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 50));

    expect(res.status).toBe(201);
    expect(client.inbound).toHaveLength(1);
    const { identity, data } = client.inbound[0];
    expect(identity).toEqual(PARTNER);
    expect(data.method).toBe("POST");
    expect(data.url).toBe("/ocpi/2.2/cdrs");
    expect(data.statusCode).toBe(201);
    expect(text(data.responseBody)).toBe('{"status_code":1000}');
  });

  it("falls back to the X-EVPanda-* headers", async () => {
    const client = new Fake();
    host = await startHost([ocpi.express(client), echo]);

    await (
      await fetch(`${host.url}/ocpi/2.2/cdrs`, {
        headers: {
          "x-evpanda-platform-id": "acme",
          "x-evpanda-platform-name": "Acme Mobility",
        },
      })
    ).text();
    await new Promise((r) => setTimeout(r, 50));

    expect(client.inbound[0]?.identity).toEqual(PARTNER);
  });

  it("serves an unidentified request without capturing it", async () => {
    const client = new Fake();
    host = await startHost([ocpi.express(client), echo]);

    const res = await fetch(`${host.url}/ocpi/2.2/cdrs`);
    expect(await res.text()).toBe('{"status_code":1000}');
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(client.inbound).toHaveLength(0);
  });

  it("takes a resolver of your own", async () => {
    const client = new Fake();
    const byPath: ocpi.OCPIResolver = (info) =>
      info.url.startsWith("/partners/")
        ? { id: info.url.split("/")[2], name: info.url.split("/")[2] }
        : undefined;
    host = await startHost([ocpi.express(client, { resolve: byPath }), echo]);

    await (await fetch(`${host.url}/partners/acme/cdrs`)).text();
    await (await fetch(`${host.url}/health`)).text();
    await new Promise((r) => setTimeout(r, 50));

    expect(client.inbound.map((c) => c.identity.id)).toEqual(["acme"]);
  });

  it.each([
    ["a closed client", new Fake(null)],
    ["a broken client", new Exploding()],
  ])("passes the request through untouched for %s", async (_label, client) => {
    host = await startHost([ocpi.express(client), echo]);
    const res = await fetch(`${host.url}/ocpi/2.2/cdrs`);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"status_code":1000}');
  });
});

describe("the fetch adapter", () => {
  let partner: Host | undefined;
  beforeEach(async () => {
    partner = await startHost([
      (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status_code: 1000, seen: req.headers }));
      },
    ]);
  });
  afterEach(async () => {
    await partner?.close();
    partner = undefined;
  });

  it("captures a call scoped by useIdentity", async () => {
    const client = new Fake();
    const wrapped = ocpi.fetch(client, globalThis.fetch);

    const res = await ocpi.useIdentity(PARTNER, () =>
      wrapped(`${partner!.url}/ocpi/2.2/sessions`, {
        method: "POST",
        body: '{"id":"s-1"}',
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 50));

    expect(client.outbound).toHaveLength(1);
    const { identity, data } = client.outbound[0];
    expect(identity).toEqual(PARTNER);
    expect(data.method).toBe("POST");
    expect(data.statusCode).toBe(200);
    expect(text(data.requestBody)).toBe('{"id":"s-1"}');
  });

  it("resolves the identity headers and strips them before dispatch", async () => {
    const client = new Fake();
    const wrapped = ocpi.fetch(client, globalThis.fetch);

    const res = await wrapped(`${partner!.url}/ocpi/2.2/locations`, {
      headers: {
        "x-evpanda-platform-id": "acme",
        "x-evpanda-platform-name": "Acme Mobility",
        authorization: "Token partner-secret",
      },
    });
    const seen = (await res.json()) as { seen: Record<string, string> };
    await new Promise((r) => setTimeout(r, 50));

    expect(client.outbound[0]?.identity).toEqual(PARTNER);
    expect(seen.seen["x-evpanda-platform-id"]).toBeUndefined();
    expect(seen.seen.authorization).toBe("Token partner-secret");
  });

  it("makes an unidentified call without capturing it", async () => {
    const client = new Fake();
    const wrapped = ocpi.fetch(client, globalThis.fetch);
    const res = await wrapped(`${partner!.url}/ocpi/2.2/locations`);
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.outbound).toHaveLength(0);
  });

  it("hands back the base fetch for a closed client", () => {
    const base = globalThis.fetch;
    expect(ocpi.fetch(new Fake(null), base)).toBe(base);
  });
});

describe("the axios adapter", () => {
  let partner: Host | undefined;
  beforeEach(async () => {
    partner = await startHost([
      (req, res) => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ status_code: 1000, seen: req.headers }));
      },
    ]);
  });
  afterEach(async () => {
    await partner?.close();
    partner = undefined;
  });

  it("captures a call scoped by useIdentity", async () => {
    const client = new Fake();
    const instance = ocpi.axios(client, axiosLib.create({ baseURL: partner!.url }));

    const res = await ocpi.useIdentity(PARTNER, () =>
      instance.post("/ocpi/2.2/sessions", { id: "s-1" }),
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(res.status).toBe(201);
    expect(client.outbound).toHaveLength(1);
    expect(client.outbound[0].identity).toEqual(PARTNER);
    expect(client.outbound[0].data.statusCode).toBe(201);
  });

  it("strips the identity headers before dispatch", async () => {
    const client = new Fake();
    const instance = ocpi.axios(client, axiosLib.create({ baseURL: partner!.url }));

    const res = await instance.get("/ocpi/2.2/locations", {
      headers: {
        "x-evpanda-platform-id": "acme",
        "x-evpanda-platform-name": "Acme Mobility",
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(client.outbound[0]?.identity).toEqual(PARTNER);
    expect((res.data as { seen: Record<string, string> }).seen["x-evpanda-platform-id"]).toBeUndefined();
  });

  it("returns the instance untouched for a closed client", () => {
    const instance = axiosLib.create();
    expect(ocpi.axios(new Fake(null), instance)).toBe(instance);
  });
});

describe("identity carriers", () => {
  it("round-trips through a request object", () => {
    const req = {};
    expect(ocpi.identityFrom(req)).toBeUndefined();
    ocpi.setIdentity(req, PARTNER);
    expect(ocpi.identityFrom(req)).toEqual(PARTNER);
  });

  it("scopes an identity to an async call chain", async () => {
    expect(ocpi.currentIdentity()).toBeUndefined();
    const inside = await ocpi.useIdentity(PARTNER, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return ocpi.currentIdentity();
    });
    expect(inside).toEqual(PARTNER);
    expect(ocpi.currentIdentity()).toBeUndefined();
  });

  it("reads the headers, tenant pair included", () => {
    expect(ocpi.identityFromHeaders({})).toBeUndefined();
    expect(
      ocpi.identityFromHeaders({
        "x-evpanda-platform-id": "acme",
        "x-evpanda-platform-name": "Acme Mobility",
        "x-evpanda-tenant-id": "t-1",
        "x-evpanda-tenant-name": "Tenant One",
      }),
    ).toEqual({ ...PARTNER, tenantId: "t-1", tenantName: "Tenant One" });
  });

  it("prefers the request object over the scope, and the scope over headers", () => {
    const fromHeaders = { "x-evpanda-platform-id": "h", "x-evpanda-platform-name": "H" };
    const scoped: Platform = { id: "s", name: "S" };
    const stamped: Platform = { id: "r", name: "R" };

    ocpi.useIdentity(scoped, () => {
      expect(
        ocpi.defaultResolver({
          method: "GET",
          url: "/x",
          requestHeaders: fromHeaders,
          identity: stamped,
        })?.id,
      ).toBe("r");
      expect(
        ocpi.defaultResolver({ method: "GET", url: "/x", requestHeaders: fromHeaders })?.id,
      ).toBe("s");
    });
    expect(
      ocpi.defaultResolver({ method: "GET", url: "/x", requestHeaders: fromHeaders })?.id,
    ).toBe("h");
  });
});
