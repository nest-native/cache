import { eq, lte, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import type { CacheEntry, CacheStore } from '../interfaces';
import { parseTags, serializeTags, tagLikePattern } from '../store-util';
import type { StalefreeCacheTable } from './schema';

type Db = MySql2Database<Record<string, never>>;

// MySQL's indexable varchar key is 191 chars (utf8mb4) — narrower than the
// shared 256-char validator. A longer key must FAIL LOUDLY (the cache reports
// it via onError and falls open) instead of silently erroring on insert and
// never persisting to L2.
const MYSQL_MAX_KEY_LENGTH = 191;

function assertMysqlKeyLength(key: string): void {
  if (key.length > MYSQL_MAX_KEY_LENGTH) {
    throw new Error(
      `cache key exceeds MySQL's ${MYSQL_MAX_KEY_LENGTH}-char key column: ${JSON.stringify(key.slice(0, 40))}…`,
    );
  }
}

/**
 * mysql2 L2 store — fully asynchronous; single-statement methods (upsert via
 * ON DUPLICATE KEY UPDATE with plain-value SETs, so the MySQL column-order
 * trap does not apply). Freshness policy lives in the cache.
 *
 * REQUIRES the key column to use `COLLATE utf8mb4_bin` — see the schema
 * factory's doc for the mandatory migration edit (MySQL's default collation
 * is case-insensitive and would collide case-distinct keys).
 */
export class MysqlCacheStore implements CacheStore {
  constructor(
    private readonly db: unknown,
    private readonly table: StalefreeCacheTable,
  ) {}

  async get(key: string): Promise<CacheEntry | undefined> {
    assertMysqlKeyLength(key);
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
    assertMysqlKeyLength(key);
    await (this.db as Db)
      .insert(this.table)
      .values({
        key,
        value: JSON.stringify(entry.value),
        expiresAt: entry.expiresAt,
        tags: serializeTags(entry.tags),
      })
      .onDuplicateKeyUpdate({
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

  async prune(now: number): Promise<void> {
    await (this.db as Db).delete(this.table).where(lte(this.table.expiresAt, now));
  }
}
