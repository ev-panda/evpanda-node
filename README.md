# evpanda-node

[![Build](https://github.com/evpanda-labs/evpanda-node/actions/workflows/build.yml/badge.svg)](https://github.com/evpanda-labs/evpanda-node/actions/workflows/build.yml)
[![npm](https://img.shields.io/npm/v/@evpanda/sdk.svg)](https://www.npmjs.com/package/@evpanda/sdk)

Passive OCPI / OCPP traffic capture for Node. Embed it in your OCPI server or
OCPP CSMS and it records protocol messages, buffers them in memory, and ships
them in batches to the EVPanda ingestion API.

- **Non-blocking.** Capture calls never wait on the network and never throw
  into your process.
- **Bounded.** Undelivered captures are capped by a byte budget you set; under
  pressure the SDK drops its own data rather than yours.
- **Safe by default.** Secrets are stripped before anything is buffered.
- **Small.** No runtime dependencies, one timer per client.

## Requirements

Node 22.15 or later. That is where `node:zlib` gained zstd, which is the codec
every EVPanda SDK ships batches with — and why this package needs no
dependencies at all. Node 18 and 20 are both past end-of-life.

## Installation

```sh
npm install @evpanda/sdk
```

`express`, `axios` and `ws` are optional peers, needed only if you use the
adapter built for them.

## Quick start

Pick the client for the protocol your service speaks. `startOCPI` and
`startOCPP` always return a usable client — if the config is bad you get an
inert one carrying the reason on `.error`, so a typo can't stop your service
from booting.

**The only thing you must supply is an API key.** Set `EVPANDA_API_KEY` in the
environment, or pass `apiKey` in the config. `endpoint` defaults to the
production ingestion API, so leave it unset unless you're pointing at another
environment.

### OCPP

`connection()` returns a session handle that mints the connection ID and
carries the charger identity, so per-frame calls need neither.

```ts
import { startOCPP } from "@evpanda/sdk";

// endpoint defaults to production; apiKey comes from EVPANDA_API_KEY
const panda = startOCPP();
if (panda.error) log.warn(`${panda.error.message} (running inert)`);

wss.on("connection", (socket, req) => {
  const charger = resolveCharger(req); // however your CSMS does it
  if (!charger) return socket.close(1008);

  const session = panda.connection(charger); // records the connect

  socket.on("message", (frame) => {
    session.message(frame.toString(), "FROM_CP");

    const reply = handleFrame(frame); // your CSMS logic
    socket.send(reply);
    session.message(reply, "TO_CP");
  });

  socket.on("close", () => session.disconnect()); // records the close
});
```

`direction` is from the charge point's perspective: `"FROM_CP"` for frames it
sent you, `"TO_CP"` for frames you send it. Use one session per socket — its
connection ID ties the connect, every frame and the disconnect into a single
session, and a reconnect gets a fresh one.

`captureConnect` / `captureMessage` / `captureDisconnect` are the flat
primitives underneath, for cases a session handle doesn't fit.

### OCPI

Two methods, one per direction. The method name sets the direction — there's no
field to get backwards.

| Method | You are the… | Typical case |
|---|---|---|
| `captureInboundMessage` | server | A partner pushes a CDR to your endpoint |
| `captureOutboundMessage` | client | You pull a partner's locations |

`identity` is always the **partner on the other side** — never your own
platform.

```ts
import { startOCPI } from "@evpanda/sdk";

const panda = startOCPI();
if (panda.error) log.warn(`${panda.error.message} (running inert)`);

panda.captureInboundMessage({
  identity: { id: "acme", name: "Acme Mobility" },
  data: {
    method: "POST",
    url: "/ocpi/2.2/cdrs",
    statusCode: 201,
    requestHeaders: { "content-type": "application/json" },
    responseHeaders: { "content-type": "application/json" },
    requestBody,   // Uint8Array or string
    responseBody,
  },
});
```

`statusCode` and both bodies are optional; the header records may be left out.
Bodies are copied at capture, so you can reuse your own buffer the moment the
call returns.

## HTTP adapters

`ocpi` wraps the HTTP layers your service already speaks, so you don't have to
assemble exchanges yourself.

| Adapter | Direction | For |
|---|---|---|
| `ocpi.express(client)` | inbound | express, connect, or a bare `node:http` server |
| `ocpi.fetch(client, fetch)` | outbound | global `fetch`, or any implementation you pass |
| `ocpi.axios(client, instance)` | outbound | an axios instance |

```ts
import { ocpi, startOCPI } from "@evpanda/sdk";

const panda = startOCPI();

app.use(ocpi.express(panda));                        // inbound
const fetch = ocpi.fetch(panda, globalThis.fetch);   // outbound
const http = ocpi.axios(panda, axios.create());      // outbound
```

A request with no resolvable identity is served exactly as it would have
been — it just isn't captured.

### Telling the adapters who the partner is

Stamp the identity wherever you already look the partner up. Inbound, that is
the request object:

```ts
import { ocpi } from "@evpanda/sdk";

app.use((req, res, next) => {
  const partner = lookupPartner(req.headers.authorization);
  if (!partner) return res.status(401).json({ status_code: 2001 });
  ocpi.setIdentity(req, { id: partner.id, name: partner.name });
  next();
});
```

The request is read when the response finishes, so **mount order doesn't
matter**: your auth layer can sit inside or outside the capture middleware and
either way the identity is seen.

Outbound, scope the call — you have already looked the partner up to get their
token:

```ts
const response = await ocpi.useIdentity({ id: partner.id, name: partner.name }, () =>
  fetch(`${partner.url}/ocpi/2.2/sessions`, {
    method: "POST",
    headers: { authorization: `Token ${partner.tokenB}` },
    body: JSON.stringify(payload),
  }),
);
```

It is an `AsyncLocalStorage` underneath, so it follows the async call chain
rather than leaking to whatever else the event loop is running.

Failing both, all three adapters read the `X-EVPanda-Platform-Id` /
`X-EVPanda-Platform-Name` headers (plus optional `-Tenant-Id` / `-Tenant-Name`).
The outbound adapters strip them before dispatch, so partners never see them.

If identity lives somewhere else entirely — a client certificate, a path prefix
— pass your own resolver:

```ts
const byPath: ocpi.OCPIResolver = (info) => {
  if (!info.url.startsWith("/partners/")) return undefined; // not captured
  const name = info.url.split("/")[2];
  return { id: name, name };
};

app.use(ocpi.express(panda, { resolve: byPath }));
```

## Identity

Every message carries its own identity; messages the SDK can't attribute are
dropped rather than shipped as orphans.

| Protocol | Type | Required fields |
|---|---|---|
| OCPI | `Platform` | `id`, `name` |
| OCPP | `Charger` | `id` |

`tenantId` and `tenantName` are optional but **all-or-nothing** — set both or
neither. They keep their prefix because they describe a different subject:
which of *your* tenants an exchange belongs to, not a property of the partner
or the charger.

## Configuration

`apiKey` is the only required field; it falls back to `$EVPANDA_API_KEY`.
Everything else takes its default when omitted, and an out-of-range value falls
back to that default with a warning rather than failing.

A missing key and a malformed `endpoint` are the only things `start*` reports,
and both are matchable — useful because a missing key is usually a deployment
problem while a bad endpoint is a code one:

```ts
import { ApiKeyError, startOCPI } from "@evpanda/sdk";

const panda = startOCPI(config);
if (panda.error instanceof ApiKeyError) {
  throw new Error("EVPANDA_API_KEY is not set in this environment");
}
if (panda.error) log.warn(`${panda.error.message} (running inert)`);
```

| Field | Default | Description |
|---|---|---|
| `endpoint` | `https://ingest.evpanda.io` | Ingestion API base URL. Set only to reach another environment |
| `apiKey` | `$EVPANDA_API_KEY` | Sent as `X-API-Key`. **Required** |
| `maxBufferBytes` | `32 MiB` | Memory ceiling for undelivered captures; oldest are evicted past it |
| `maxCaptureBytes` | `65536` | Per body / per frame cap; an oversize body drops the whole message. Also bounds what the adapters hold per in-flight request |
| `flushInterval` | `5000` | Maximum milliseconds between deliveries |
| `drainTimeout` | `10000` | How long `close()` waits to drain, in ms (minimum `5000`) |
| `logMode` | `"errors"` | `"silent"`, `"errors"`, `"debug"` |
| `logger` | `console` | Where the SDK's own logs go |
| `ocpiAllowedHeaders` | `[]` | *(OCPI only)* Extra headers to capture, on top of the defaults |

## Memory

`maxBufferBytes` caps everything waiting to be delivered — that is the number
to provision against, and the SDK evicts rather than exceed it.

The HTTP adapters add a second, smaller cost: while a request is in flight they
hold a copy of its bodies, bounded per request by `maxCaptureBytes` and released
as soon as the exchange is captured. That cost scales with concurrency rather
than with the buffer, and with the bodies that actually pass rather than with
the cap. Calling `captureInboundMessage` yourself instead of using an adapter
avoids it, since you already hold the bytes.

It is deliberately not bounded in aggregate. Doing that would mean making a
request wait on a capture budget, and capture never blocks the host.

## Logging

The SDK reports problems to your logger by default, at a bounded rate: at most
one summary line per minute, and nothing at all while it's healthy.

```
@evpanda/sdk: captures dropped window=60s captured=12 droppedInvalid=148302 buffered=0 bufferBytes=0
```

Set `logMode` to change that, or `EVPANDA_LOG=silent|errors|debug` to change it
without touching code:

| Mode | Output |
|---|---|
| `"silent"` | Nothing. Counters still work. |
| `"errors"` | Default. Config problems at startup, plus the per-minute summary. |
| `"debug"` | Adds per-batch delivery failures and a summary on close. |

## Is it working?

`stats()` is a snapshot of the client's delivery counters, always available and
safe on an inert or closed client. Each counter maps to one root cause:

```ts
const stats = panda.stats();
// { captured: 40120, droppedInvalid: 0, droppedOversize: 0, droppedEvicted: 9402,
//   droppedUndeliverable: 0, droppedFault: 0, bufferedMessages: 2, bufferBytes: 528 }
```

| Counter | What a high value means |
|---|---|
| `captured` is 0 | The capture path is not wired in |
| `droppedInvalid` | Identity resolution is failing |
| `droppedOversize` | Bodies exceed `maxCaptureBytes` |
| `droppedEvicted` | Upstream can't keep up, or the buffer is undersized |
| `droppedUndeliverable` | Network, API key, or ingestion fault |
| `droppedFault` | A bug in the SDK — please report it |

It is a pull-based snapshot, so it feeds Prometheus, OpenTelemetry or a log line
without the SDK depending on any of them.

## Shutdown

```ts
await server.close();               // stop accepting first…
if (!(await panda.close())) {       // …then drain what was captured
  log.warn("evpanda: shut down with messages still buffered");
}
```

`close(timeoutMs?)` drains within `drainTimeout` (or the milliseconds you pass)
and resolves to whether it managed to. It is idempotent, never rejects, and
captures after it are safe no-ops.

The flush timer is `unref`'d, so it never holds your process open on its own —
which also means an unclosed client can lose what it captured since the last
flush. Close it in your shutdown path.

`flush()` forces an immediate delivery and waits for it. It waits for as long as
the transport's retries take, so use it at shutdown or while debugging — not on
a request path.

## Documentation

- [Architecture and design notes](https://claude.ai/code/artifact/f214c278-cafd-409e-b1ab-b6a7fb8e7ece)
  — how it works, and why. The source lives at [`docs/design.html`](docs/design.html)
- [evpanda-go](https://github.com/evpanda-labs/evpanda-go) — the reference
  implementation this SDK tracks
- [evpanda-py](https://github.com/evpanda-labs/evpanda-py) — the Python SDK,
  same pipeline and the same wire records
