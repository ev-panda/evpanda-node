/**
 * Message types and per-message identity.
 *
 * The wire-facing shapes here must match `apispec/ingestion-api.yaml`.
 * `protocol` and the capture timestamp are SDK-owned — they live on the
 * internal envelope (see buffer.ts) and deliberately not on these.
 */

/** Routes a batch to `POST /v1/{protocol}`. One client, one protocol. */
export type Protocol = "ocpi" | "ocpp";

/**
 * An OCPI message's direction relative to the host.
 *
 * Internal: the capture method you call stamps it, so there is no field to
 * get backwards.
 */
export type OCPIDirection = "IN" | "OUT";

/**
 * An OCPP frame's direction relative to the charge point. `FROM_CP` is a
 * frame the charger sent you, `TO_CP` one you send it.
 */
export type OCPPDirection = "TO_CP" | "FROM_CP";

/** An OCPP WebSocket lifecycle event, mapped onto `event_type`. */
export enum OCPPEventType {
  Disconnect = 0,
  Connect = 1,
  Message = 2,
}

// ── Identity ─────────────────────────────────────────────────────────────
//
// Per-message identity: the two protocol shapes and their validation rules.
// `validPlatform` / `validCharger` are the single rule source — every
// capture path goes through them, and the adapters use them to decide
// whether instrumenting a request is worth the work. Nothing here throws;
// an invalid identity means the caller drops the message.

/**
 * The roaming partner an OCPI message was exchanged with.
 *
 * It is always the partner on the other side — never your own platform.
 *
 * `id` and `name` are required. `tenantId` and `tenantName` describe a
 * different subject: which of *your* tenants the exchange belongs to,
 * which is why they keep the prefix the platform's own fields do not need.
 * They are optional but all-or-nothing — supply both or neither.
 */
export interface Platform {
  id: string;
  name: string;
  tenantId?: string;
  tenantName?: string;
}

/**
 * The charge point an OCPP event belongs to.
 *
 * `id` is required. `tenantId` and `tenantName` say which of your tenants
 * the charger belongs to; they are optional but all-or-nothing.
 */
export interface Charger {
  id: string;
  tenantId?: string;
  tenantName?: string;
}

/** A usable string value: present, a string, not blank. */
function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Tenant is all-or-nothing: both `tenantId` and `tenantName`, or neither. */
function tenantPairValid(id: {
  tenantId?: string;
  tenantName?: string;
}): boolean {
  return isNonEmpty(id.tenantId) === isNonEmpty(id.tenantName);
}

/**
 * Whether a platform can attribute a message: `id` and `name` present, and
 * the tenant pair all-or-nothing. The SDK silently drops messages that
 * fail it.
 */
export function validPlatform(platform: Platform | undefined): boolean {
  return (
    platform != null &&
    typeof platform === "object" &&
    isNonEmpty(platform.id) &&
    isNonEmpty(platform.name) &&
    tenantPairValid(platform)
  );
}

/** Whether a charger can attribute a message: `id` present, tenant paired. */
export function validCharger(charger: Charger | undefined): boolean {
  return (
    charger != null &&
    typeof charger === "object" &&
    isNonEmpty(charger.id) &&
    tenantPairValid(charger)
  );
}

// ── Captured data ────────────────────────────────────────────────────────

/**
 * What a caller may hand us as a body or frame. A `string` is encoded as
 * UTF-8; a `Uint8Array` is copied at the capture chokepoint, so the SDK
 * never aliases a buffer the host reuses.
 */
export type BodyInput = Uint8Array | string;

/**
 * A captured HTTP request/response pair.
 *
 * A body larger than `maxCaptureBytes` drops the whole message at capture
 * rather than storing a truncated one. `statusCode` and both bodies are
 * optional; either header record may be left out.
 */
export interface HTTPExchange {
  method: string;
  url: string;
  statusCode?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: BodyInput;
  responseBody?: BodyInput;
}

/**
 * Normalize a caller's body to bytes the SDK owns, or undefined when empty.
 *
 * A capture is held until the next flush, so a body handed straight from a
 * pooled or reused buffer would be serialized after the host had already
 * overwritten it. Copying at the chokepoint is what makes the field safe to
 * hand over.
 */
/**
 * Whether `bytes` is valid UTF-8, which the wire contract requires of every
 * body and frame.
 *
 * A strict `TextDecoder` is the cheapest correct check: it walks the bytes
 * once in native code and throws on the first invalid sequence, where a
 * decode-and-re-encode comparison would allocate twice and still have to
 * compare.
 */
export function isUTF8(bytes: Uint8Array | undefined): boolean {
  if (bytes === undefined || bytes.length === 0) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function ownBody(value: BodyInput | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : Uint8Array.prototype.slice.call(value);
  return bytes.length === 0 ? undefined : bytes;
}

// ── Internal buffered forms ──────────────────────────────────────────────
//
// What the ring buffer holds: the caller's input plus whatever the capture
// method stamped. `sizeOf` is buffer bookkeeping; the wire mapping lives in
// transport.ts.

export interface OCPIMessage {
  direction: OCPIDirection;
  platform: Platform;
  data: HTTPExchange;
}

export interface OCPPMessage {
  eventType: OCPPEventType;
  charger: Charger;
  connectionId: string;
  direction?: OCPPDirection;
  payload?: Uint8Array;
}

/** What the ring buffer carries, without a tag to switch on. */
export type Message = OCPIMessage | OCPPMessage;

/**
 * Per-message accounting overhead, deliberately generous: the envelope, the
 * object header, its fields and the slot itself. Over-counting keeps the
 * configured budget a true ceiling — under-counting would quietly break it.
 * The numbers match the Go and Python SDKs, so all three report comparable
 * buffer footprints for the same traffic.
 */
const ENVELOPE_OVERHEAD = 256;
const HEADER_ENTRY_OVERHEAD = 48;

function headerSize(headers: Record<string, string> | undefined): number {
  if (!headers) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(headers)) {
    n += k.length + v.length + HEADER_ENTRY_OVERHEAD;
  }
  return n;
}

/** Whether this is an OCPI capture. One check, one call site (transport). */
export function isOCPI(message: Message): message is OCPIMessage {
  return "direction" in message && "platform" in message;
}

/** The accounted footprint of one capture, in bytes. */
export function sizeOf(message: Message): number {
  if (isOCPI(message)) {
    const { platform: p, data: d } = message;
    return (
      ENVELOPE_OVERHEAD +
      message.direction.length +
      p.id.length +
      p.name.length +
      (p.tenantId?.length ?? 0) +
      (p.tenantName?.length ?? 0) +
      d.method.length +
      d.url.length +
      byteLength(d.requestBody) +
      byteLength(d.responseBody) +
      headerSize(d.requestHeaders) +
      headerSize(d.responseHeaders)
    );
  }
  const { charger: c } = message;
  return (
    ENVELOPE_OVERHEAD +
    c.id.length +
    (c.tenantId?.length ?? 0) +
    (c.tenantName?.length ?? 0) +
    message.connectionId.length +
    (message.direction?.length ?? 0) +
    (message.payload?.length ?? 0)
  );
}

/**
 * The accounted length of a body. The chokepoint owns bodies as bytes
 * before anything is enqueued, so this only ever sees a Uint8Array in
 * practice; the string branch keeps it honest if that ever changes.
 */
function byteLength(body: BodyInput | undefined): number {
  return body === undefined ? 0 : body.length;
}
