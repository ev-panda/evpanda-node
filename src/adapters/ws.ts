/**
 * Adapter — OCPP WebSocket recorder.
 *
 * Optional convenience over the stable primitive. No universal WS middleware
 * exists, so this is a per-connection recorder + a documented ~10-line hook
 * per common WS lib. Maps the WS lifecycle to ingestion events and calls
 * `sdk.captureOCPP`:
 *   CONNECT → 1, MESSAGE → 2, DISCONNECT → 0.
 *
 * The SDK OWNS connectionId: a UUID minted per connection, regenerated on
 * every reconnect, so the server can group a session and tell reconnects
 * apart.
 *
 * `ws` is an OPTIONAL peer dependency — only loaded if this is used.
 */

import type { ChargerIdentity, IdentityInput } from "../identity.js";
import type { EVPanda } from "../sdk.js";

export interface OCPPRecorderOptions {
  identity?: IdentityInput<
    { url: string; headers: Record<string, string> },
    ChargerIdentity
  >;
}

export interface ConnectionRecorder {
  /** Stable for this connection; new UUID on each new recorder (reconnect). */
  readonly connectionId: string;
  onConnect(): void;
  onMessage(data: unknown): void;
  onDisconnect(): void;
}

/** Create a recorder for one accepted WS connection. */
export function recordConnection(
  _sdk: EVPanda,
  _ctx: { url: string; headers: Record<string, string> },
  _opts?: OCPPRecorderOptions,
): ConnectionRecorder {
  throw new Error("not implemented");
}
