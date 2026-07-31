# @evpanda/sdk

[![Build](https://github.com/ev-panda/evpanda-node/actions/workflows/build.yml/badge.svg?branch=master)](https://github.com/ev-panda/evpanda-node/actions/workflows/build.yml)

Passive OCPI / OCPP traffic capture for Node. Embed it in your OCPI server or
OCPP CSMS; it records protocol messages, buffers them in-process, and ships
them in batches to the EVPanda ingestion API.

> **It never gets in your way.** The SDK will not block your request path,
> throw into your handlers, crash your process, or grow memory unbounded. If
> it's under stress or the network is down it drops data — it never degrades
> your application.

- Dual **ESM + CommonJS**, typed.
- **Node ≥ 18.**
- **Zero hard runtime dependencies** — zstd compression is an optional peer.
- Separate `OCPIClient` and `OCPPClient` — pick the one your service speaks.
- Drop-in adapters for express, fetch, axios; a session handle for OCPP.

## Install

```sh
npm add @evpanda/sdk
# pnpm add @evpanda/sdk · yarn add @evpanda/sdk · bun add @evpanda/sdk
```

**Optional — zstd compression.** `compression` defaults to `"zstd"`, which needs
this optional peer. Without it the SDK silently falls back to gzip, so install it
only if you want the smaller payloads:

```sh
npm add @mongodb-js/zstd
```

No load-order requirements — the SDK patches no globals, so import it wherever
you like. `express` and `axios` need no install on our account: the adapters
reference them as types only.

## Quick start — OCPI

```ts
import express from "express";
import { OCPIClient, ocpi } from "@evpanda/sdk";

const client = OCPIClient.start({
  endpoint: "https://ingest.evpanda.io",
  // apiKey omitted ⇒ read from EVPANDA_API_KEY
});

const app = express();
app.use(express.json());             // the adapter captures the request body
                                     // from `req.body` — run a body parser first

// Inbound capture. The resolver receives `{ method, url, requestHeaders }`
// and returns a `RoamingIdentity`; throwing or returning an invalid identity
// drops the capture for that request — the request itself is never blocked.
app.use(ocpi.express(client, {
  resolve: ({ requestHeaders }) => ({
    platformId: requestHeaders["x-platform-id"]!,
    platformName: requestHeaders["x-platform-name"]!,
  }),
}));

// Outbound capture. Drop-in for `globalThis.fetch`; use it for partner calls.
const fetch = ocpi.fetch(client, globalThis.fetch, {
  resolve: () => ({ platformId: "acme", platformName: "Acme" }),
});

// Or attach to axios:
import axiosLib from "axios";
const partner = ocpi.axios(client, axiosLib.create({ baseURL: "https://partner.example" }), {
  resolve: () => ({ platformId: "acme", platformName: "Acme" }),
});

app.post("/ocpi/2.2/cdrs", async (_req, res) => {
  // Both calls are auto-captured.
  await fetch("https://partner.example/ocpi/2.2/sessions", { method: "POST", body: "{}" });
  await partner.post("/ocpi/2.2/tokens", { id: "t1" });
  res.json({ ack: true });
});

process.on("SIGTERM", () => void client.close());
```

The adapter sets the message **direction** itself — `ocpi.express` captures
as `IN`, `ocpi.fetch` / `ocpi.axios` as `OUT`. You never pass it.

### Skipping the resolver: `X-EVPanda-*` headers

`resolve` is optional. Omit it and the adapter falls back to the shipped
`ocpi.headerResolver`, which reads identity from these headers (case-insensitive):

| Header | Field |
|---|---|
| `X-EVPanda-Platform-Id` | `platformId` (required) |
| `X-EVPanda-Platform-Name` | `platformName` (required) |
| `X-EVPanda-Tenant-Id` | `tenantId` (optional) |
| `X-EVPanda-Tenant-Name` | `tenantName` (optional) |

```ts
const fetch = ocpi.fetch(client, globalThis.fetch);   // no resolver needed
const partner = ocpi.axios(client, axiosLib.create({ baseURL: "…" }));
app.use(ocpi.express(client));

await fetch("https://partner.example/ocpi/2.2/sessions", {
  method: "POST",
  headers: {
    "X-EVPanda-Platform-Id": "acme",
    "X-EVPanda-Platform-Name": "Acme",
  },
  body: "{}",
});
```

Rules: a request with no identity headers is simply **not captured** (no error,
no partial record). Tenant is **all-or-nothing** — set both tenant headers or
neither; a half-set pair fails validation and drops that message.

Two things to know:

- **Outbound**, the adapter **strips these headers before dispatch** — the
  partner never receives them, so `tenantId` / `tenantName` stay internal.
  They are also excluded from the captured record by the header allowlist.
  (Stripping happens only while capture is active; an inert client — bad
  config, or after `close()` — passes the request through untouched.)
- **Inbound**, partners will not send these headers. `ocpi.express` with no
  resolver only works if earlier middleware (auth, tenancy) stamps them onto
  `req.headers` first — so mount that middleware **before** this one.

### Other Node frameworks

`ocpi.express` is connect-style `(req, res, next)`; it works on **express**
and **connect** directly. For koa / hono / fastify, drop the adapter and call
`captureInboundMessage` / `captureOutboundMessage` yourself — your resolver
logic stays the same:

```ts
// koa / hono — resolve identity, then ship the message after the handler.
app.use(async (ctx, next) => {
  const identity = myResolver({ method: ctx.method, url: ctx.url, headers: ctx.headers });
  await next();
  if (identity) {
    client.captureInboundMessage({
      identity,
      data: { /* method, url, statusCode, headers, bodies */ },
    });
  }
});

// fastify — install on the `onResponse` lifecycle hook.
fastify.addHook("onResponse", async (req, reply) => {
  /* resolve identity + client.captureInboundMessage({ identity, data }) */
});
```

`captureInboundMessage` / `captureOutboundMessage` take an `OCPIMessageInput`
(`{ identity, data }`) — the method name picks the direction, so there is no
`direction` field to set.

## Quick start — OCPP

```ts
import { WebSocketServer } from "ws";
import { OCPPClient } from "@evpanda/sdk";

const client = OCPPClient.start({
  endpoint: "https://ingest.evpanda.io",
});

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (socket, req) => {
  // connection() mints the connectionId, records the connect, and returns
  // a session handle. Keep it for the life of the socket.
  const session = client.connection({ chargerId: extractChargerId(req.url ?? "") });

  socket.on("message", (data) => session.message(data.toString(), "FROM_CP"));
  socket.on("close", () => session.disconnect());
});

process.on("SIGTERM", () => void client.close());
```

`client.connection(identity)` is the recommended path — every WS server has a
connection object to hang the returned `OCPPSession` on. The session owns the
`connectionId` (fresh per connection) and carries the identity, so per-frame
calls pass neither. It works the same for **uWebSockets.js**, **socket.io**,
or any WS library.

If you need finer control (a host whose inbound and outbound paths are
separate, like a CSMS that sends via its own method), use the flat
primitives the session is built on:

```ts
client.captureConnect({ identity, connectionId });
client.captureMessage({ identity, connectionId, data, direction });   // both required
client.captureDisconnect({ identity, connectionId });
```

`identity` is a `ChargerIdentity` literal — OCPP identity is known at connect
time, so there is no resolver form.

## Identity

Every captured message must carry an identity; the SDK validates it and
silently drops messages it can't attribute (it never throws back at you).

- **OCPI →** `RoamingIdentity`: `platformId` + `platformName` required.
- **OCPP →** `ChargerIdentity`: `chargerId` required.
- `tenantId` + `tenantName` are optional but **all-or-nothing** — supply
  both or neither.

Identity is per message, not global config — one process can serve many
platforms, tenants and chargers.

### Direction

- **OCPI** — `IN` (partner → host) or `OUT` (host → partner). Set by the
  capture method / adapter; you never pass it.
- **OCPP** — `TO_CP` (host → charge point) or `FROM_CP` (charge point →
  host). Passed to `captureMessage`.

## Configuration

Shared between `OCPIClient.start(config)` and `OCPPClient.start(config)`:

| Option            | Default     | Description                                                        |
|-------------------|-------------|--------------------------------------------------------------------|
| `endpoint`        | —           | Ingestion API base URL (`https://…`). **Required.**                |
| `apiKey`          | env         | Sent as `X-API-Key`; falls back to the `EVPANDA_API_KEY` env var.  |
| `bufferCapacity`  | `10000`     | Max buffered messages. Oldest are dropped when full.               |
| `maxCaptureBytes` | `65536`     | Per-body / per-frame capture cap (bytes).                          |
| `flushInterval`   | `5000`      | Max ms between flushes (also flushes early when the buffer fills). |
| `drainTimeout`    | `10000`     | Max ms `close()` waits to drain remaining messages.                |
| `compression`     | `"zstd"`    | `"zstd"` or `"gzip"`.                                              |
| `debug`           | `false`     | Master log switch. Silent unless `true`.                           |
| `logger`          | `console`   | Optional logger; only used when `debug` is `true`.                 |

`OCPIClient`-only:

| Option              | Default     | Description                                                                                    |
|---------------------|-------------|--------------------------------------------------------------------------------------------------|
| `ocpiAllowedHeaders`| `[]`        | Extra headers to capture, on top of the default OCPI allowlist. Cannot disable the defaults.     |

**Config errors never crash your boot.** `endpoint` and `apiKey` are
hard-required — a bad value makes `start()` return an inert no-op client.
Every other option is *tunable*: a bad value falls back to its default
(e.g. `drainTimeout: 3000` → `10000`), logged when `debug: true`.
