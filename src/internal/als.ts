/**
 * Identity propagation over AsyncLocalStorage. Created per OCPIClient when
 * `propagateIdentity: true`: the inbound adapter wraps the handler in
 * `run(id, fn)`, outbound adapters read `current()`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { RoamingIdentity } from "../identity.js";

export class IdentityStore {
  readonly #als = new AsyncLocalStorage<RoamingIdentity>();

  /** Run `fn` with `id` as the ambient identity for any async work it spawns. */
  run<T>(id: RoamingIdentity, fn: () => T): T {
    return this.#als.run(id, fn);
  }

  /** The ambient identity, if `run` is currently on the stack. */
  current(): RoamingIdentity | undefined {
    return this.#als.getStore();
  }
}
