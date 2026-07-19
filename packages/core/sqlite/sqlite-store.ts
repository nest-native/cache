import { eq, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { CacheEntry, CacheStore } from '../interfaces';
import { parseTags, serializeTags, tagLikePattern } from '../store-util';
import type { StalefreeCacheTable } from './schema';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * better-sqlite3 L2 store — fully **synchronous** (the driver is), which the
 * cache awaits transparently. The store is dumb on purpose: it returns rows
 * as stored (including expired ones) and the cache applies freshness policy.
 */
export class SqliteCacheStore implements CacheStore {
  constructor(
    private readonly db: unknown,
    private readonly table: StalefreeCacheTable,
  ) {}

  get(key: string): CacheEntry | undefined {
    const row = (this.db as Db)
      .select()
      .from(this.table)
      .where(eq(this.table.key, key))
      .get();
    if (!row) {
      return undefined;
    }
    return {
      value: JSON.parse(row.value),
      expiresAt: row.expiresAt,
      tags: parseTags(row.tags),
    };
  }

  set(key: string, entry: CacheEntry): void {
    (this.db as Db)
      .insert(this.table)
      .values({
        key,
        value: JSON.stringify(entry.value),
        expiresAt: entry.expiresAt,
        tags: serializeTags(entry.tags),
      })
      .onConflictDoUpdate({
        target: this.table.key,
        set: {
          value: JSON.stringify(entry.value),
          expiresAt: entry.expiresAt,
          tags: serializeTags(entry.tags),
        },
      })
      .run();
  }

  delete(key: string): void {
    (this.db as Db).delete(this.table).where(eq(this.table.key, key)).run();
  }

  invalidateTags(tags: readonly string[]): void {
    for (const tag of tags) {
      (this.db as Db)
        .delete(this.table)
        .where(sql`${this.table.tags} LIKE ${tagLikePattern(tag)} ESCAPE '!'`)
        .run();
    }
  }

  prune(now: number): void {
    (this.db as Db).delete(this.table).where(lte(this.table.expiresAt, now)).run();
  }
}
