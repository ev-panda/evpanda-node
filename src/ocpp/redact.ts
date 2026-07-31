/**
 * OCPP redaction. Currently a pass-through — frames are captured verbatim.
 * The seam exists so masking (e.g. `idTag` in `Authorize`) can be added in
 * `makeOCPPRedactor` later without touching `worker.ts` or `OCPPClient`.
 */

import type { OCPPMessage } from "../types.js";

/** Pure transform applied to an OCPP message right before enqueue. */
export type OCPPRedactor = (msg: OCPPMessage) => OCPPMessage;

/** Build the OCPP redactor. Today the identity transform — nothing redacted. */
export function makeOCPPRedactor(): OCPPRedactor {
  return (msg) => msg;
}
