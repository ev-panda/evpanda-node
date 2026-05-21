/**
 * Package-private bridge from a client to its adapters. Held in a
 * module-local WeakMap keyed by the client instance — so the fields stay
 * off the public class and are collected with the client.
 */

import type { Logger } from "../config.js";
import type { IdentityStore } from "./als.js";

export interface SdkInternal {
  /** Resolved per-body cap; adapters use it to bound streaming accumulation. */
  readonly maxCaptureBytes: number;
  /** Present only when `propagateIdentity: true`. */
  readonly identityStore?: IdentityStore;
  /** Effective logger (set only when `debug: true`); adapters log faults here. */
  readonly logger?: Logger;
}

const REGISTRY = new WeakMap<object, SdkInternal>();

/** Called by an active client constructor; no-op on inert clients. */
export function attachBridge(client: object, bridge: SdkInternal): void {
  REGISTRY.set(client, bridge);
}

/** Called by adapters. Returns undefined for inert clients. */
export function readBridge(client: object): SdkInternal | undefined {
  return REGISTRY.get(client);
}
