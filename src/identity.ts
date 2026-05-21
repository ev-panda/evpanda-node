/**
 * Per-message identity: the two protocol shapes, the OCPI resolver
 * contract, and the validation rules. `validate*` is the single rule
 * source — every capture path (adapter and primitive) goes through it.
 * Nothing here throws; an absent/invalid identity ⇒ the caller drops the
 * message.
 */

/** OCPI roaming context. platform required; tenant all-or-nothing. */
export interface RoamingIdentity {
  platformId: string;
  platformName: string;
  tenantId?: string;
  tenantName?: string;
}

/** OCPP charger context. chargerId required; tenant all-or-nothing. */
export interface ChargerIdentity {
  chargerId: string;
  tenantId?: string;
  tenantName?: string;
}

// ── OCPI resolver contract ───────────────────────────────────────────────
//
// OCPI identity is per-request (it's in the partner's headers), so the
// adapters take a resolver function, not a fixed value. OCPP needs none —
// charger identity is known at connect time.

/** HTTP-shaped envelope passed to an OCPI resolver. */
export interface OCPIResolverCtx {
  method: string;
  url: string;
  /** Normalized to lowercase keys, single-string values. */
  headers: Record<string, string>;
}

/** Function the OCPI adapters accept: request context → roaming identity. */
export type OCPIResolver = (ctx: OCPIResolverCtx) => RoamingIdentity;

// ── Validators — the single rule source ──────────────────────────────────

/** A usable string value: present, a string, not blank. */
function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Tenant is all-or-nothing: both tenantId & tenantName, or neither. */
function isTenantPairValid(id: {
  tenantId?: string;
  tenantName?: string;
}): boolean {
  return isNonEmpty(id.tenantId) === isNonEmpty(id.tenantName);
}

/** True iff platformId + platformName non-empty and tenant all-or-nothing. */
export function validateRoamingIdentity(id: RoamingIdentity): boolean {
  return (
    id != null &&
    typeof id === "object" &&
    isNonEmpty(id.platformId) &&
    isNonEmpty(id.platformName) &&
    isTenantPairValid(id)
  );
}

/** True iff chargerId non-empty and tenant all-or-nothing. */
export function validateChargerIdentity(id: ChargerIdentity): boolean {
  return (
    id != null &&
    typeof id === "object" &&
    isNonEmpty(id.chargerId) &&
    isTenantPairValid(id)
  );
}
