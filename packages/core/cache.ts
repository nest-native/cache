import type {
  CacheEntry,
  CacheStore,
  InvalidationMessage,
  SetOptions,
  StalefreeCacheOptions,
} from './interfaces';
import { L1Cache } from './l1';
import { assertValidKey, assertValidTags, assertValidTtl } from './validate';

const NO_TAGS: readonly string[] = Object.freeze([]);

/**
 * The stalefree engine: a read-through, tag-invalidated, two-tier cache.
 *
 * - **L1** is a per-instance LRU; **L2** (optional, Drizzle-backed) is shared.
 * - **`wrap`** is the primary API: read-through with in-process single-flight
 *   (concurrent wraps of one key share one loader run).
 * - **Invalidation** evicts L1 via the reverse tag index, deletes in L2, and
 *   publishes on the bus; other instances evict their L1 on receipt. The
 *   publisher also receives its own message — eviction is idempotent, so
 *   self-delivery is harmless and keeps the bus contract sender-agnostic.
 * - **Fail-open**: store/bus failures are reported to `onError` and the call
 *   proceeds (a degraded cache is a slower app, never a broken one). Loader
 *   errors are the caller's business and propagate untouched.
 * - **TTL is mandatory** (per call or via `defaultTtlMs`) — the delivery
 *   backstop that turns any lost invalidation into stale-until-TTL.
 * - **Values are held BY REFERENCE in L1.** Treat cached values as immutable:
 *   mutating a returned object mutates the cache for every later hit (until
 *   an L2 round-trip re-serializes it — making the corruption tier-dependent
 *   and maddening to debug). Clone before mutating.
 */
export class StalefreeCache {
  readonly #l1: L1Cache;
  readonly #store?: CacheStore;
  readonly #defaultTtlMs?: number;
  readonly #onError?: (error: unknown, context: string) => void;
  readonly #clock: () => number;
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #publish: (message: InvalidationMessage) => void;
  readonly #unsubscribe: (() => void) | null;

  constructor(options: StalefreeCacheOptions = {}) {
    this.#l1 = new L1Cache(options.l1MaxEntries ?? 10_000);
    this.#store = options.store;
    if (options.defaultTtlMs !== undefined) {
      assertValidTtl(options.defaultTtlMs);
    }
    this.#defaultTtlMs = options.defaultTtlMs;
    this.#onError = options.onError;
    this.#clock = options.clock ?? Date.now;
    const bus = options.bus;
    this.#publish = bus
      ? (message) => bus.publish(message)
      : () => undefined;
    this.#unsubscribe = bus
      ? bus.subscribe((message) => this.#onBusMessage(message))
      : null;
  }

  /** Fresh value or `undefined`. L1 first, then L2 (filling L1 on a hit). */
  async get<T>(key: string): Promise<T | undefined> {
    assertValidKey(key);
    const now = this.#clock();
    const local = this.#l1.get(key, now);
    if (local) {
      return local.value as T;
    }
    const fetched = await this.#storeGet(key);
    if (fetched && fetched.expiresAt > now) {
      this.#l1.set(key, fetched);
      return fetched.value as T;
    }
    return undefined;
  }

  /** Write to L1 and (when configured) L2. TTL required; tags validated. */
  async set<T>(key: string, value: T, options: SetOptions = {}): Promise<void> {
    assertValidKey(key);
    const ttlMs = options.ttlMs ?? this.#defaultTtlMs;
    assertValidTtl(ttlMs);
    const tags = options.tags ?? NO_TAGS;
    assertValidTags(tags);
    const entry: CacheEntry = {
      value,
      expiresAt: this.#clock() + ttlMs,
      tags: [...tags],
    };
    this.#l1.set(key, entry);
    await this.#storeCall('set', () => this.#store?.set(key, entry));
  }

  /** Remove one key everywhere — L1, L2, and every other instance's L1. */
  async delete(key: string): Promise<void> {
    assertValidKey(key);
    this.#l1.delete(key);
    await this.#storeCall('delete', () => this.#store?.delete(key));
    this.#publish({ keys: [key] });
  }

  /** Evict everything carrying any of the tags — locally, in L2, and on the bus. */
  async invalidateTags(tags: readonly string[]): Promise<void> {
    assertValidTags(tags);
    if (tags.length === 0) {
      return;
    }
    this.#l1.invalidateTags(tags);
    await this.#storeCall('invalidateTags', () =>
      this.#store?.invalidateTags(tags),
    );
    this.#publish({ tags: [...tags] });
  }

  /**
   * Read-through with single-flight: a hit returns immediately; on a miss,
   * concurrent callers for the same key share ONE loader run. An `undefined`
   * loader result is returned but NOT cached (indistinguishable from a miss).
   * Loader errors propagate to every joined caller and cache nothing.
   *
   * ⚠ Do NOT call `wrap` for the SAME key from inside its own loader (even
   * transitively through other services): the inner call joins the outer
   * in-flight promise and both deadlock. Single-flight has no re-entrancy
   * detection — structure loaders to read from the source, not the cache.
   */
  async wrap<T>(
    key: string,
    loader: () => Promise<T> | T,
    options: SetOptions = {},
  ): Promise<T> {
    assertValidKey(key);
    // Validate policy UP FRONT: a bad TTL/tag must fail fast and
    // deterministically — not run the loader first and then reject with an
    // error the caller can't tell from a loader failure (and not pass
    // silently whenever the read happens to be a hit).
    assertValidTtl(options.ttlMs ?? this.#defaultTtlMs);
    assertValidTags(options.tags ?? NO_TAGS);
    const joined = this.#inflight.get(key);
    if (joined) {
      return joined as Promise<T>;
    }
    // Register the WHOLE check-then-load chain synchronously — registering
    // after an awaited cache check would let N concurrent misses each start a
    // loader (the awaits interleave before any registration lands).
    const run = this.#getOrLoad(key, loader, options);
    this.#inflight.set(key, run);
    return run as Promise<T>;
  }

  /** Unsubscribe from the bus. The bus itself belongs to the app (close it there). */
  close(): void {
    this.#unsubscribe?.();
  }

  async #getOrLoad<T>(
    key: string,
    loader: () => Promise<T> | T,
    options: SetOptions,
  ): Promise<T> {
    try {
      const cached = await this.get<T>(key);
      if (cached !== undefined) {
        return cached;
      }
      const value = await loader();
      if (value !== undefined) {
        await this.set(key, value, options);
      }
      return value;
    } finally {
      this.#inflight.delete(key);
    }
  }

  #onBusMessage(message: InvalidationMessage): void {
    // Receivers evict L1 only: the publisher already handled L2, and touching
    // it here would multiply one invalidation into N redundant store writes.
    if ('clear' in message) {
      this.#l1.clear();
      return;
    }
    if (message.keys) {
      for (const key of message.keys) {
        this.#l1.delete(key);
      }
    }
    if (message.tags) {
      this.#l1.invalidateTags(message.tags);
    }
  }

  async #storeGet(key: string): Promise<CacheEntry | undefined> {
    if (!this.#store) {
      return undefined;
    }
    try {
      return await this.#store.get(key);
    } catch (error) {
      this.#onError?.(error, 'store.get');
      return undefined; // fail open: a broken L2 is a miss, not an outage
    }
  }

  async #storeCall(
    context: string,
    call: () => void | Promise<void> | undefined,
  ): Promise<void> {
    try {
      await call();
    } catch (error) {
      this.#onError?.(error, `store.${context}`);
    }
  }
}
