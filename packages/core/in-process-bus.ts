import type { InvalidationBus, InvalidationMessage } from './interfaces';

/**
 * The single-instance bus: dispatches synchronously to local subscribers.
 * It is the default coherence story for one process (where the publisher's
 * own L1 eviction already happened and re-delivery is an idempotent no-op),
 * the reference implementation of the {@link InvalidationBus} contract, and
 * the test double for everything built on the seam.
 */
export class InProcessInvalidationBus implements InvalidationBus {
  readonly #handlers = new Set<(message: InvalidationMessage) => void>();

  publish(message: InvalidationMessage): void {
    for (const handler of [...this.#handlers]) {
      try {
        handler(message);
      } catch {
        // publish() never throws into the request path — the contract. A
        // throwing subscriber loses only its own delivery; eviction handlers
        // are idempotent and the TTL backstop bounds any missed eviction.
      }
    }
  }

  subscribe(handler: (message: InvalidationMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  close(): void {
    this.#handlers.clear();
  }
}
