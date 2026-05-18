/**
 * Per-message identity: shapes, input forms, validation/resolution. Two
 * independent shapes (no shared base). validate* is the single rule; both
 * the adapter path (via resolve*) and the primitive path go through it.
 * Nothing here throws; absent/invalid ⇒ caller drops the message.
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

/** Either identity — used where the protocol is not statically known. */
export type AnyIdentity = RoamingIdentity | ChargerIdentity;

/** Pull form: derive the identity from the adapter's framework context. */
export type IdentityResolver<Ctx, I extends AnyIdentity> = (ctx: Ctx) => I;

/** What an adapter accepts: a fixed object or a per-ctx resolver. */
export type IdentityInput<Ctx, I extends AnyIdentity> =
  | I
  | IdentityResolver<Ctx, I>;

// ── Validators — the single rule source, shared by both paths ────────────

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

// ── Adapter-path resolution (delegates to the validators above) ──────────

/** Input → raw identity, or null (resolver throw/nullish ⇒ null). */
function resolveInput<Ctx, I extends AnyIdentity>(
  input: IdentityInput<Ctx, I> | undefined,
  ctx: Ctx,
): I | null {
  if (input === undefined) return null;
  if (typeof input === "function") {
    try {
      // Narrow the value|callback union: only the resolver is callable.
      return (input as IdentityResolver<Ctx, I>)(ctx) ?? null;
    } catch {
      return null;
    }
  }
  return input;
}

/** Resolve + validate an OCPI identity input; null if absent/invalid. */
export function resolveRoamingIdentity<Ctx>(
  input: IdentityInput<Ctx, RoamingIdentity> | undefined,
  ctx: Ctx,
): RoamingIdentity | null {
  const id = resolveInput(input, ctx);
  return id !== null && validateRoamingIdentity(id) ? id : null;
}

/** Resolve + validate an OCPP identity input; null if absent/invalid. */
export function resolveChargerIdentity<Ctx>(
  input: IdentityInput<Ctx, ChargerIdentity> | undefined,
  ctx: Ctx,
): ChargerIdentity | null {
  const id = resolveInput(input, ctx);
  return id !== null && validateChargerIdentity(id) ? id : null;
}
