import type { CacheEntry } from './interfaces';

/**
 * The in-memory L1: a Map-based LRU (insertion order + move-on-get) with a
 * reverse tag→keys index so tag invalidation evicts in O(affected keys), not
 * O(cache size). Expiry is lazy — an expired entry is dropped when touched;
 * until then it merely occupies an LRU slot, and `maxEntries` bounds memory.
 * Zero dependencies, fully synchronous.
 */
export class L1Cache {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #keysByTag = new Map<string, Set<string>>();

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(
        `invalid l1MaxEntries ${String(maxEntries)}: must be an integer >= 1`,
      );
    }
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Fresh entry or undefined; touches LRU recency; drops an expired entry. */
  get(key: string, now: number): CacheEntry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.delete(key);
      return undefined;
    }
    // Move-on-get: re-insertion puts the key at the recent end of the Map.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    // Replacing re-indexes: the old entry's tags must not keep pointing here.
    if (this.#entries.has(key)) {
      this.delete(key);
    } else if (this.#entries.size >= this.#maxEntries) {
      // Evict the least-recently-used key (the Map's oldest insertion).
      const oldest = this.#entries.keys().next().value as string;
      this.delete(oldest);
    }
    this.#entries.set(key, entry);
    for (const tag of entry.tags) {
      let keys = this.#keysByTag.get(tag);
      if (!keys) {
        keys = new Set();
        this.#keysByTag.set(tag, keys);
      }
      keys.add(key);
    }
  }

  /** Remove one key, cleaning its tag-index references. Idempotent. */
  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) {
      return;
    }
    this.#entries.delete(key);
    for (const tag of entry.tags) {
      const keys = this.#keysByTag.get(tag);
      keys?.delete(key);
      if (keys?.size === 0) {
        this.#keysByTag.delete(tag);
      }
    }
  }

  /** Evict every key carrying any of the tags. Returns evicted count. */
  invalidateTags(tags: readonly string[]): number {
    let evicted = 0;
    for (const tag of tags) {
      const keys = this.#keysByTag.get(tag);
      if (!keys) {
        continue;
      }
      // Copy: delete() mutates the set we are iterating.
      for (const key of [...keys]) {
        this.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  clear(): void {
    this.#entries.clear();
    this.#keysByTag.clear();
  }
}
