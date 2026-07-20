import { eq, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { CacheEntry, CacheStore } from '../interfaces';
import { parseTags, serializeTags, tagLikePattern } from '../store-util';
import type { StalefreeCacheTable } from './schema';

type Db = NodePgDatabase<Record<string, never>>;

/**
 * node-postgres L2 store — fully asynchronous. Dumb by design: returns rows
 * as stored (freshness policy lives in the cache), and every method runs a
 * single statement so concurrent instances never race a read-modify-write.
 */
export class PostgresCacheStore implements CacheStore {
  constructor(
    private readonly db: unknown,
    private readonly table: StalefreeCacheTable,
  ) {}

  async get(key: string): Promise<CacheEntry | undefined> {
    const [row] = await (this.db as Db)
      .select()
      .from(this.table)
      .where(eq(this.table.key, key));
    if (!row) {
      return undefined;
    }
    return {
      value: JSON.parse(row.value),
      expiresAt: row.expiresAt,
      tags: parseTags(row.tags),
    };
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    await (this.db as Db)
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
      });
  }

  async delete(key: string): Promise<void> {
    await (this.db as Db).delete(this.table).where(eq(this.table.key, key));
  }

  async invalidateTags(tags: readonly string[]): Promise<void> {
    for (const tag of tags) {
      await (this.db as Db)
        .delete(this.table)
        .where(sql`${this.table.tags} LIKE ${tagLikePattern(tag)} ESCAPE '!'`);
    }
  }

  /**
   * The transactional partner of `PostgresInvalidationBus.publishInTx` — and
   * MANDATORY alongside it when this L2 store is configured. The bus message
   * only evicts L1s; without deleting the L2 rows in the same transaction,
   * every instance's next read would refill its L1 from the stale L2 row and
   * the transactional invalidation would be a de-facto no-op:
   *
   * ```ts
   * await db.transaction(async (tx) => {
   *   await tx.update(projects)...;                       // the business write
   *   await store.invalidateTagsInTx(tx, tags);           // L2 dies with the commit
   *   await bus.publishInTx(tx, { tags });                // L1s evict on commit
   * });
   * ```
   */
  async invalidateTagsInTx(
    tx: { execute(query: unknown): Promise<unknown> },
    tags: readonly string[],
  ): Promise<void> {
    for (const tag of tags) {
      await tx.execute(
        sql`DELETE FROM ${this.table} WHERE ${this.table.tags} LIKE ${tagLikePattern(tag)} ESCAPE '!'`,
      );
    }
  }

  async prune(now: number): Promise<void> {
    await (this.db as Db).delete(this.table).where(lte(this.table.expiresAt, now));
  }
}
