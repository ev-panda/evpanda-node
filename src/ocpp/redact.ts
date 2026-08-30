/**
 * OCPP redaction.
 *
 * There is no OCPP redactor. Frames are captured verbatim, so the client's
 * redactor stays undefined and the chokepoint skips the step, rather than
 * paying a call per frame to run an identity transform. The undefined-able
 * argument is the seam: masking `idTag` in `Authorize`, say, arrives as a
 * `makeOCPPRedactor` here plus one line in `startOCPP`, with nothing in the
 * worker or the client to change.
 */

import type { OCPPMessage } from "../types.js";

/** The transform applied to an OCPP message right before it is enqueued. */
export type OCPPRedactor = (msg: OCPPMessage) => OCPPMessage;
