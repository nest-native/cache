/**
 * A cached value with its absolute expiry and the tags it can be invalidated
 * by. `expiresAt` is epoch milliseconds — absolute, so an entry can move
 * between tiers (L2 → L1 fill) without renegotiating its remaining lifetime.
 */
export interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
  tags: readonly string[];
}

/** Options for a single `set`/`wrap`. TTL is REQUIRED (directly or via the cache's `defaultTtlMs`). */
export interface SetOptions {
  /**
   * Time-to-live in milliseconds; finite and > 0. TTL is the delivery
   * backstop: a lost invalidation message means stale-until-TTL, never
   * stale-forever — which is why infinite entries do not exist in this API.
   */
  ttlMs?: number;
  /** Tags this entry is invalidated by (e.g. `['org:1', 'project:42']`). */
  tags?: readonly string[];
}

/**
 * What travels on the invalidation bus. Either targeted (tags and/or exact
 * keys) or a full clear — the documented degradation when an invalidation is
 * too large for the transport (colder cache, never staler data).
 */
export type InvalidationMessage =
  | { tags?: readonly string[]; keys?: readonly string[] }
  | { clear: true };

/**
 * The optional shared L2 tier. Implementations own persistence only; all
 * policy (TTL math, single-flight, bus fan-out) lives in the cache. Methods
 * may be synchronous (better-sqlite3) or async (pg/mysql) — the cache awaits
 * whatever it gets, from outside any transaction.
 */
export interface CacheStore {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  invalidateTags(tags: readonly string[]): void | Promise<void>;
  /** Remove expired rows; the app schedules this (like a lockout `pruneExpired`). */
  prune(now: number): void | Promise<void>;
}

/**
 * The coherence seam. `publish` is fire-and-forget and must NEVER throw into
 * the caller's request path; `subscribe` returns an unsubscribe function.
 * Implementations: in-process (ships in the core), unix-socket (same machine),
 * Postgres LISTEN/NOTIFY (cross-machine, with in-transaction publish).
 */
export interface InvalidationBus {
  publish(message: InvalidationMessage): void;
  subscribe(handler: (message: InvalidationMessage) => void): () => void;
  close?(): void | Promise<void>;
}

/** Configuration for {@link StalefreeCache}. */
export interface StalefreeCacheOptions {
  /** L1 capacity (entries). Default 10_000. Must be a finite integer >= 1. */
  l1MaxEntries?: number;
  /** Optional shared L2 store. */
  store?: CacheStore;
  /** Optional invalidation bus; omit for a purely local cache. */
  bus?: InvalidationBus;
  /** Fallback TTL applied when a `set`/`wrap` omits `ttlMs`. */
  defaultTtlMs?: number;
  /**
   * Cache-infrastructure failures (store/bus errors) are reported here and the
   * cache fails OPEN — the request path falls through to the loader. Loader
   * errors are NOT routed here; they propagate to the caller.
   */
  onError?: (error: unknown, context: string) => void;
  /** Injected clock (epoch ms) — every TTL decision goes through it. */
  clock?: () => number;
}
