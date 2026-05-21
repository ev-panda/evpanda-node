/**
 * Shared engine lifecycle for OCPIClient and OCPPClient: hold one engine,
 * swap it for an inert twin on `close`, expose `flush` / `close`. The
 * protocol-specific capture methods stay in the subclasses.
 */

/** The minimum an engine must expose for the base to drive its lifecycle. */
interface ClientEngine {
  flush(): Promise<void>;
  close(deadlineMs?: number): Promise<void>;
}

export abstract class BaseClient<E extends ClientEngine> {
  #engine: E;
  /** Builds the inert engine `close` swaps in. Subclass supplies it. */
  readonly #makeNoop: () => E;

  protected constructor(engine: E, makeNoop: () => E) {
    this.#engine = engine;
    this.#makeNoop = makeNoop;
  }

  /** The live engine — subclass capture methods route through this. */
  protected get engine(): E {
    return this.#engine;
  }

  /** Force an immediate flush of buffered messages. Never throws. */
  async flush(): Promise<void> {
    try {
      await this.#engine.flush();
    } catch {
      /* swallow */
    }
  }

  /** Swap to inert then drain within the deadline. Idempotent. */
  async close(deadlineMs?: number): Promise<void> {
    const engine = this.#engine;
    this.#engine = this.#makeNoop();
    try {
      await engine.close(deadlineMs);
    } catch {
      /* swallow */
    }
  }
}
