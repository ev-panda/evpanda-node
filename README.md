# @evpanda/sdk

[![Build](https://github.com/ev-panda/evpanda-node/actions/workflows/build.yml/badge.svg)](https://github.com/ev-panda/evpanda-node/actions/workflows/build.yml)

Passive OCPI / OCPP traffic capture for Node. Embed it in your OCPI server or
OCPP CSMS; it records protocol messages, buffers them in-process, and ships
them in batches to the EVPanda ingestion API.

- Dual **ESM + CommonJS**, typed.
- **Node ≥ 18.**
- **Zero hard runtime dependencies** — zstd compression is an optional peer.
- Separate `OCPIClient` and `OCPPClient` — pick the one your service speaks.
- Drop-in adapters for express, fetch, axios; a session handle for OCPP.

## Install

```sh
npm add @evpanda/sdk

pnpm add @evpanda/sdk

yarn add @evpanda/sdk

bun add @evpanda/sdk
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

## Identity Resolution

Every captured message must carry an identity; the SDK validates it and
silently drops messages it can't attribute (it never throws back at you).

- **OCPI →** `RoamingIdentity`: `platformId` + `platformName` required.
- **OCPP →** `ChargerIdentity`: `chargerId` required.
- `tenantId` + `tenantName` are optional but **all-or-nothing** — supply
  both or neither.

Identity is per message, not global config — one process can serve many
platforms, tenants and chargers.

## Quick start — OCPP

```ts
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { OCPPClient } from "@evpanda/sdk";

import type { IncomingMessage } from "node:http";
import type { ChargerIdentity } from "@evpanda/sdk";

// Picks up EVPANDA_API_KEY from the env vars
const client = OCPPClient.start();

/**
 * Your own charge-point identification — whatever your CSMS already does at
 * handshake time: parse the URL path, read Basic auth, check a client
 * certificate, hit your DB. Return undefined for a charger you don't know.
 */
function resolveChargerIdentity(req: IncomingMessage): ChargerIdentity | undefined {
  // Implement this as per your workflow. Identify chargerId from req
  // Add tenantId + tenantName if you're multi-tenant
  return { identity };   
}

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (socket, req) => {
  const identity = resolveChargerIdentity(req);
  if (!identity) {
    socket.close(1008, "unknown charge point");   // your policy, not the SDK's
    return;
  }

  // One id per socket, stable for its lifetime — it ties the connect, every
  // frame, and the disconnect together into one session on the EVPanda side.
  const connectionId = randomUUID();
  client.captureConnect({ identity, connectionId });

  // Outbound: capture whatever the CSMS sends back to the charge point.
  const send = (frame: string): void => {
    socket.send(frame);
    client.captureMessage({ identity, connectionId, data: frame, direction: "TO_CP" });
  };

  socket.on("message", (raw) => {
    const frame = raw.toString();
    client.captureMessage({ identity, connectionId, data: frame, direction: "FROM_CP" });

    send(handleFrame(frame));   // your CSMS logic → its CallResult
  });

  socket.on("close", () => {
    client.captureDisconnect({ identity, connectionId });
  });
});

process.on("SIGTERM", () => void client.close());
```

`direction` is from the charge point's perspective: **`FROM_CP`** for frames it
sent you, **`TO_CP`** for frames you send it. `identity` is a `ChargerIdentity`
literal — OCPP identity is known at connect time, so there is no resolver form.


## Quick start — OCPI

OCPI traffic flows both ways between roaming partners, and the SDK records
each direction separately:

- **Inbound** — a partner called *your* OCPI server. You are the server, so
  you capture the request they sent and the response you returned. Typically
  an eMSP pushing a CDR or session update to your endpoints.
- **Outbound** — *you* called a partner's OCPI server. You are the client, so
  you capture the request you sent and the response they returned. Typically
  you pulling their locations or posting a token authorization.

In both cases `identity` is the **partner** on the other side of the
exchange — never your own platform.

One method per direction, and the **method name sets the direction** — there
is no `direction` field to pass. Both take `{ identity, data }`, where `data`
is the HTTP exchange you want recorded:

```ts
import { OCPIClient } from "@evpanda/sdk";

// Picks up EVPANDA_API_KEY from the env vars
const client = OCPIClient.start();

const identity = { platformId: "acme", platformName: "Acme" };

// You received an OCPI request from a registered partner → Inbound
client.captureInboundMessage({
  identity,
  data: {
    method: "POST",
    url: "/ocpi/2.2/cdrs",
    statusCode: 201,
    requestHeaders: { "content-type": "application/json" },
    responseHeaders: { "content-type": "application/json" },
    requestBody: Buffer.from(JSON.stringify({ id: "cdr-1" })),
    responseBody: Buffer.from(JSON.stringify({ status_code: 1000 })),
  },
});

// You sent an OCPI request to a registered partner → Outbound
client.captureOutboundMessage({
  identity,
  data: {
    method: "GET",
    url: "https://partner.example/ocpi/2.2/locations",
    statusCode: 200,
    requestHeaders: { "content-type": "application/json" },
    responseHeaders: { "content-type": "application/json" },
    responseBody: Buffer.from(JSON.stringify({ status_code: 1000 })),
  },
});

process.on("SIGTERM", () => void client.close());
```

`requestHeaders` and `responseHeaders` are required — pass `{}` if you have
none. `statusCode` and both bodies are optional. Bodies are raw bytes
(`Uint8Array`), capped at `maxCaptureBytes`; an oversize body drops the whole
message rather than storing a truncated one.

Both calls are non-blocking and never throw back at you.

## OCPI adapters

The adapters do the assembly above for you — collect the headers and bodies
and call the right method. **Identity comes from request headers that you
stamp** (case-insensitive):

| Header | Field |
|---|---|
| `X-EVPanda-Platform-Id` | `platformId` (required) |
| `X-EVPanda-Platform-Name` | `platformName` (required) |
| `X-EVPanda-Tenant-Id` | `tenantId` (optional) |
| `X-EVPanda-Tenant-Name` | `tenantName` (optional) |

A request with no identity headers is simply **not captured** — no error, no
partial record, and the request itself is never blocked. Tenant is
**all-or-nothing**: set both tenant headers or neither, since a half-set pair
fails validation and drops that message.

**Outbound, the adapters strip these headers before dispatch**, so the partner
never receives them and `tenantId` / `tenantName` stay internal. (Stripping
happens only while capture is active; an inert client — bad config, or after
`close()` — passes the request through untouched.)

If you need identity from something other than headers, skip the adapters and
call `captureInboundMessage` / `captureOutboundMessage` directly — they take
the identity object, as shown above.

### `ocpi.express` — inbound

Connect-style `(req, res, next)` middleware, typed against `node:http`, so it
needs no express dependency and works on **connect** too. It tees
`res.write`/`res.end` for the response body and reads the request body from
`req.body` — so **mount a body parser first**, or there is nothing to capture.

Partners will not send `X-EVPanda-*` headers, so stamp them from whatever your
auth layer already resolved, in middleware mounted **before** this one:

```ts
import express from "express";
import { OCPIClient, ocpi } from "@evpanda/sdk";

const client = OCPIClient.start();
const app = express();

app.use(express.json());   // populates req.body — must come first

// Your auth / tenancy layer already knows who is calling — stamp it.
app.use((req, _res, next) => {
  const partner = lookupPartner(req.headers.authorization);
  if (partner) {
    req.headers["x-evpanda-platform-id"] = partner.platformId;
    req.headers["x-evpanda-platform-name"] = partner.platformName;
  }
  next();
});

app.use(ocpi.express(client));
```

### `ocpi.fetch` — outbound

Wraps a fetch implementation and returns a **new** one. `globalThis.fetch` is
left untouched, so you must call the returned function for calls to be
captured. Request and response are cloned and read in the background — your
caller gets the response without waiting on capture.

You have already looked the partner up to get its Token B, so identity is in
hand — stamp it alongside the auth header:

```ts
const fetch = ocpi.fetch(client, globalThis.fetch);

await fetch(`${partner.baseUrl}/ocpi/2.2/sessions`, {
  method: "POST",
  headers: {
    authorization: `Token ${partner.tokenB}`,
    "content-type": "application/json",
    "X-EVPanda-Platform-Id": partner.platformId,
    "X-EVPanda-Platform-Name": partner.platformName,
  },
  body: JSON.stringify({ id: "s1" }),
});
```

Because it is just a `fetch`, clients that accept one work too:

```ts
const api = ky.create({ fetch });        // ky
const $api = ofetch.create({ fetch });   // ofetch
```

### `ocpi.axios` — outbound

Installs a request/response interceptor pair on the **instance you pass**, and
returns that same instance — so the original variable is instrumented too. The
error interceptor captures non-2xx responses as well, since axios rejects on
those.

One partner per instance? Set the headers as instance defaults and every call
carries them:

```ts
import axiosLib from "axios";

const partner = ocpi.axios(client, axiosLib.create({
  baseURL: "https://partner.example",
  headers: {
    "X-EVPanda-Platform-Id": "acme",
    "X-EVPanda-Platform-Name": "Acme",
  },
}));

await partner.post("/ocpi/2.2/tokens", { id: "t1" });
```

Talking to many partners through one instance? Pass them per call instead:

```ts
await partner.post("/ocpi/2.2/tokens", { id: "t1" }, {
  headers: {
    "X-EVPanda-Platform-Id": p.platformId,
    "X-EVPanda-Platform-Name": p.platformName,
  },
});
```

Axios in Node goes through `node:http`, never `fetch` — so wrapping fetch
captures nothing from axios. Use this adapter if your outbound calls use it.

### Other Node frameworks

`ocpi.express` is connect-style `(req, res, next)`; it works on **express**
and **connect** directly. For koa / hono / fastify, drop the adapter and call
`captureInboundMessage` / `captureOutboundMessage` yourself. No headers are
involved on this path — you hand the identity over directly:

```ts
// koa / hono — build the identity, then ship the message after the handler.
app.use(async (ctx, next) => {
  const partner = lookupPartner(ctx.headers.authorization);
  await next();
  if (partner) {
    client.captureInboundMessage({
      identity: { platformId: partner.platformId, platformName: partner.platformName },
      data: { /* method, url, statusCode, headers, bodies */ },
    });
  }
});

// fastify — install on the `onResponse` lifecycle hook.
fastify.addHook("onResponse", async (req, reply) => {
  /* build identity + client.captureInboundMessage({ identity, data }) */
});
```

Both take an `OCPIMessageInput` (`{ identity, data }`) — the method name picks
the direction, so there is no `direction` field to set.


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
