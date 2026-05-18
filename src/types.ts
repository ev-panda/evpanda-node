/**
 * Hand-maintained message types; must match apispec/ingestion-api.yaml
 * (fixture pack). `protocol`/`capturedAt` are SDK-owned (internal envelope,
 * see buffer.ts) — deliberately not on these.
 */

import type { ChargerIdentity, RoamingIdentity } from "./identity.js";

export type Protocol = "ocpi" | "ocpp";

export type Direction = "inbound" | "outbound";

/** OCPP WS lifecycle → ingestion event_type. */
export enum OCPPEventType {
  Disconnect = 0,
  Connect = 1,
  Message = 2,
}

export interface CapturedHttp {
  method: string;
  url: string;
  statusCode?: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** Truncated to config.maxCaptureBytes before buffering. */
  requestBody?: Uint8Array;
  responseBody?: Uint8Array;
}

export interface OCPIMessage {
  direction: Direction;
  identity: RoamingIdentity;
  http: CapturedHttp;
}

export interface OCPPMessage {
  eventType: OCPPEventType;
  identity: ChargerIdentity;
  /** SDK-owned UUID, stable per connection, regenerated on reconnect. */
  connectionId: string;
  /** Optional for OCPP. */
  direction?: Direction;
  payload?: Uint8Array;
}

export type AnyMessage = OCPIMessage | OCPPMessage;
