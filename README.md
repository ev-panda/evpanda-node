# @evpanda/sdk

[![Build](https://github.com/ev-panda/evpanda-node/actions/workflows/build.yml/badge.svg)](https://github.com/ev-panda/evpanda-node/actions/workflows/build.yml)

Passive OCPI / OCPP traffic capture for Node. Embed it in your OCPI server or
OCPP CSMS; it records protocol messages, buffers them in-process, and ships
them in batches to the EVPanda ingestion API.

> **It never gets in your way.** The SDK will not block your request path,
> throw into your handlers, crash your process, or grow memory unbounded. If
> it's under stress or the network is down it drops data — it never degrades
> your application.

- Zero runtime dependencies. Dual **ESM + CommonJS**, typed.
- **Node ≥ 18.**

## Install

```sh
npm add @evpanda/sdk      # or: pnpm add @evpanda/sdk / bun add @evpanda/sdk
```

## Quick start

```ts
import { EVPanda, OCPPEventType } from "@evpanda/sdk";

const sdk = EVPanda.start({
  endpoint: "https://ingest.evpanda.io",
  apiKey: process.env.EVPANDA_API_KEY!,
});

// OCPI message (e.g. from your inbound/outbound HTTP layer)
sdk.captureOCPI({
  direction: "inbound",
  identity: {
    platformId: "acme",
    platformName: "Acme Mobility",
    tenantId: "cpo-42", // tenant is all-or-nothing: both fields or neither
    tenantName: "CPO 42",
  },
  http: {
    method: "POST",
    url: "/ocpi/2.2/cdrs",
    statusCode: 200,
    requestHeaders: { "content-type": "application/json" },
    responseHeaders: {},
    truncated: false,
  },
});

// OCPP message (e.g. from your WebSocket CSMS)
sdk.captureOCPP({
  eventType: OCPPEventType.Message,
  identity: { chargerId: "CP-001" },
  connectionId: "conn-abc",
  payload: new TextEncoder().encode('[2,"id","BootNotification",{}]'),
  truncated: false,
});

// On shutdown — flushes whatever is buffered, within the drain deadline.
process.on("SIGTERM", () => void sdk.close());
```

`captureOCPI` / `captureOCPP` are **non-blocking and never throw** — they
buffer and return immediately. Delivery happens in the background.

## Identity

Every message must carry an identity; the SDK validates it and silently
drops messages it can't attribute (it never throws back at you).

- **OCPI →** `RoamingIdentity`: `platformId` + `platformName` required.
- **OCPP →** `ChargerIdentity`: `chargerId` required.
- `tenantId` + `tenantName` are optional but **all-or-nothing** — supply
  both or neither.

Identity is per message, not global config — one process can serve many
platforms, tenants and chargers.

## Configuration

`EVPanda.start(config)` — only `endpoint` and `apiKey` are required.

| Option            | Default     | Description                                                        |
|-------------------|-------------|--------------------------------------------------------------------|
| `endpoint`        | —           | Ingestion API base URL (`https://…`).                              |
| `apiKey`          | —           | Sent as `X-API-Key`.                                               |
| `bufferCapacity`  | `10000`     | Max buffered messages. Oldest are dropped when full.               |
| `maxCaptureBytes` | `65536`     | Per-body capture cap (bytes).                                      |
| `flushInterval`   | `5000`      | Max ms between flushes (also flushes early when the buffer fills). |
| `drainTimeout`    | `10000`     | Max ms `close()` waits to drain remaining messages.                |
| `compression`     | `"gzip"`    | `"gzip"` or `"zstd"` (zstd needs the optional `@mongodb-js/zstd`).  |
| `debug`           | `false`     | Master log switch. Silent unless `true`.                           |
| `logger`          | `console`   | Optional logger; only used when `debug` is `true`.                 |

A bad config never crashes your boot — the SDK falls back to an inert
no-op instead of throwing.

## Behavior

- **Batched delivery.** Messages flush when the buffer fills or on
  `flushInterval`, whichever comes first.
- **Backpressure = drop-oldest.** If the upstream is slow/down, the buffer
  caps at `bufferCapacity` and discards the oldest messages. Your app is
  never blocked or back-pressured.
- **Secret redaction.** `Authorization`, `X-API-Key` and `Cookie` headers
  are stripped before anything is buffered.
- **Resilient transport.** Bounded retry with backoff on 5xx/network;
  permanent rejections (400/401/413) are dropped without retry storms.
- **Graceful shutdown.** `await sdk.close()` flushes what's buffered within
  `drainTimeout`, then stops. Idempotent.
- **Compression.** gzip by default; `"zstd"` if you install the optional
  `@mongodb-js/zstd` peer (transparent gzip fallback if absent).
