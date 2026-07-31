/**
 * Hand-maintained message types; must match apispec/ingestion-api.yaml
 * (fixture pack). `protocol`/`capturedAt` are SDK-owned (internal envelope,
 * see buffer.ts) — deliberately not on these.
 */

import type { ChargerIdentity, RoamingIdentity } from "./identity.js";

export type Protocol = "ocpi" | "ocpp";

/** Direction of an OCPI message relative to the host. */
export type OCPIDirection = "IN" | "OUT";

/** Direction of an OCPP frame relative to the charge point. */
export type OCPPDirection = "TO_CP" | "FROM_CP";

/** OCPP WS lifecycle → ingestion event_type. */
export enum OCPPEventType {
  Disconnect = 0,
  Connect = 1,
  Message = 2,
}

export interface HttpExchange {
  method: string;
  url: string;
  statusCode?: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** Capped at `maxCaptureBytes`; an oversize body drops the whole message. */
  requestBody?: Uint8Array;
  responseBody?: Uint8Array;
}

export interface OCPIMessage {
  direction: OCPIDirection;
  identity: RoamingIdentity;
  data: HttpExchange;
}

/**
 * OCPI message as supplied to `OCPIClient.captureInboundMessage` /
 * `captureOutboundMessage`. `direction` is omitted — the chosen method
 * sets it.
 */
export interface OCPIMessageInput {
  identity: RoamingIdentity;
  data: HttpExchange;
}

export interface OCPPMessage {
  eventType: OCPPEventType;
  identity: ChargerIdentity;
  /** SDK-owned UUID, stable per connection, regenerated on reconnect. */
  connectionId: string;
  /** Optional for OCPP. */
  direction?: OCPPDirection;
  payload?: Uint8Array;
}

export type AnyMessage = OCPIMessage | OCPPMessage;
