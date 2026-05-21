# @evpanda/sdk

[![Build](https://github.com/ev-panda/evpanda-node/actions/workflows/build.yml/badge.svg)](https://github.com/ev-panda/evpanda-node/actions/workflows/build.yml)

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
npm add @evpanda/sdk      # or: pnpm add @evpanda/sdk / bun add @evpanda/sdk
```

## Quick start — OCPI

```ts
import express from "express";
import { OCPIClient, ocpi } from "@evpanda/sdk";

const client = OCPIClient.start({
  endpoint: "https://ingest.evpanda.io",
  // apiKey omitted ⇒ read from EVPANDA_API_KEY
  propagateIdentity: true,           // inbound identity flows to outbound (see below)
});

const app = express();
app.use(express.json());             // the adapter captures the request body
                                     // from `req.body` — run a body parser first

// Inbound capture. The resolver receives `{ method, url, headers }` and
// returns a `RoamingIdentity`; throwing or returning an invalid identity
// drops the capture for that request — the request itself is never blocked.
app.use(ocpi.express(client, {
  resolve: ({ headers }) => ({
    platformId: headers["x-platform-id"]!,
    platformName: headers["x-platform-name"]!,
  }),
}));

// Outbound capture. Drop-in for `globalThis.fetch`; use it for partner calls.
const fetch = ocpi.fetch(client, globalThis.fetch, {
  // Required even with `propagateIdentity: true` — used when there is no
  // ambient inbound identity (cron jobs, startup, tests).
  resolve: () => ({ platformId: "acme", platformName: "Acme" }),
});

// Or attach to axios:
import axiosLib from "axios";
const partner = ocpi.axios(client, axiosLib.create({ baseURL: "https://partner.example" }), {
  resolve: () => ({ platformId: "acme", platformName: "Acme" }),
});

app.post("/ocpi/2.2/cdrs", async (_req, res) => {
  // Both calls are auto-captured. With `propagateIdentity: true` the outbound
  // calls reuse the identity the inbound resolver returned — no rewiring.
  await fetch("https://partner.example/ocpi/2.2/sessions", { method: "POST", body: "{}" });
  await partner.post("/ocpi/2.2/tokens", { id: "t1" });
  res.json({ ack: true });
});

process.on("SIGTERM", () => void client.close());
```

The adapter sets the message **direction** itself — `ocpi.express` captures
as `IN`, `ocpi.fetch` / `ocpi.axios` as `OUT`. You never pass it.

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
      http: { /* method, url, statusCode, headers, bodies */ },
    });
  }
});

// fastify — install on the `onResponse` lifecycle hook.
fastify.addHook("onResponse", async (req, reply) => {
  /* resolve identity + client.captureInboundMessage({ identity, http }) */
});
```

`captureInboundMessage` / `captureOutboundMessage` take an `OCPIMessageInput`
(`{ identity, http }`) — the method name picks the direction, so there is no
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

### Identity propagation (OCPI, opt-in)

With `propagateIdentity: true`, the inbound `ocpi.express` adapter puts the
resolved identity into `AsyncLocalStorage` for the handler's duration, so
`ocpi.fetch` / `ocpi.axios` calls inside that handler inherit it — resolve
once, on the inbound side. Calls outside a request fall back to the outbound
adapter's `resolve`. OCPP has no equivalent (identity is per-connection).

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

| Option              | Default     | Description                                                                                                       |
|---------------------|-------------|-------------------------------------------------------------------------------------------------------------------|
| `propagateIdentity` | `false`     | Set to `true` to share inbound-resolved identity with outbound `ocpi.fetch` / `ocpi.axios` via AsyncLocalStorage. |
| `ocpiAllowedHeaders`| `[]`        | Extra headers to capture, on top of the default OCPI allowlist. Cannot disable the defaults.                      |

**Config errors never crash your boot.** `endpoint` and `apiKey` are
hard-required — a bad value makes `start()` return an inert no-op client.
Every other option is *tunable*: a bad value falls back to its default
(e.g. `drainTimeout: 3000` → `10000`), logged when `debug: true`.

## Public API surface

```ts
// OCPI
OCPIClient.start(config): OCPIClient
ocpiClient.captureInboundMessage(msg: OCPIMessageInput): void   // direction = IN
ocpiClient.captureOutboundMessage(msg: OCPIMessageInput): void  // direction = OUT
ocpiClient.flush(): Promise<void>
ocpiClient.close(deadlineMs?: number): Promise<void>

// OCPP
OCPPClient.start(config): OCPPClient
ocppClient.connection(identity: ChargerIdentity): OCPPSession   // recommended
//   OCPPSession = { connectionId, message(data, direction), disconnect() }
ocppClient.captureConnect({ identity, connectionId }): void     // flat primitives
ocppClient.captureMessage({ identity, connectionId, data, direction }): void
ocppClient.captureDisconnect({ identity, connectionId }): void
ocppClient.flush(): Promise<void>
ocppClient.close(deadlineMs?: number): Promise<void>

// OCPI adapters — all three take a `resolve: (ctx) => RoamingIdentity`
ocpi.express(client, { resolve }): (req, res, next) => void
ocpi.fetch(client, baseFetch, { resolve }): typeof fetch
ocpi.axios(client, instance, { resolve }): AxiosInstance
```

- **OCPI** capture takes an `OCPIMessageInput` (`{ identity, http }`); the
  method name sets the direction. The adapters resolve identity per
  request via the `resolve` function you supply.
- **OCPP** capture takes a literal `ChargerIdentity` — no resolver, since
  the charge point is known when the connection opens.

The SDK validates every identity and silently drops a message it can't
attribute; a swallowed adapter fault is logged when `debug: true`.

## Behavior

- **Batched delivery** — flushes when the buffer fills or every `flushInterval`.
- **Backpressure = drop-oldest** — a slow/down upstream caps the buffer at
  `bufferCapacity`; the app is never blocked.
- **Body cap = drop, not truncate** — an OCPI body or OCPP frame over
  `maxCaptureBytes` drops the *whole* message; a half-body is never shipped
  (broken JSON, and it would defeat the redactor).
- **Request bodies, safely** — `ocpi.express` reads `req.body` (whatever a
  body parser populated), never tees the raw stream, so it can't disturb the
  host's own parsing.
- **Aborted requests captured** — `ocpi.express` records a request even when
  the client disconnects before the response completes.
- **OCPI redaction** — header allowlist (Authorization, Cookie, X-API-Key
  never captured); the credentials-endpoint `token` is always masked.
- **Resilient transport** — bounded retry with backoff on 5xx/network;
  400/401/413 dropped without retry storms.
- **Graceful shutdown** — `await client.close()` drains within `drainTimeout`,
  then stops. Idempotent.
- **Compression** — zstd via the optional `@mongodb-js/zstd` peer, gzip
  fallback if it's absent; no hard runtime dependency.
- **Adapter isolation** — the `ocpi.*` adapters never alter the request or
  response, never throw, and no-op when the client is inert.
