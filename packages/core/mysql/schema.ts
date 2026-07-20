import { bigint, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';

/**
 * The L2 cache table for the mysql2 dialect. `varchar(191)` key (indexable
 * under utf8mb4, the family convention).
 *
 * **REQUIRED migration edit — binary collation on the key.** MySQL 8's
 * default collation (`utf8mb4_0900_ai_ci`) is case/accent-INSENSITIVE, so
 * `User:1` and `user:1` would collide on the primary key and the upsert
 * would overwrite one with the other — a wrong-value serve, not mere
 * staleness. drizzle-kit cannot emit a collation, so edit the generated
 * migration by hand (the same convention as Postgres's UNLOGGED edit):
 *
 * ```sql
 * `key` varchar(191) COLLATE utf8mb4_bin NOT NULL
 * ```
 *
 * Keys longer than 191 characters are rejected by the store at runtime (the
 * shared validator allows up to 256; MySQL's indexable-key limit is lower).
 *
 * Column declaration order matters on MySQL only when an upsert's SET
 * expressions read other columns — this store's SETs are plain values, so no
 * ordering constraint applies here.
 */
export function stalefreeCacheTable(name = 'stalefree_cache') {
  return mysqlTable(name, {
    key: varchar('key', { length: 191 }).primaryKey(),
    /** JSON-serialized value. */
    value: text('value').notNull(),
    /** Absolute expiry, epoch milliseconds. */
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    /** Delimited tag list (`|t1|t2|`), empty string when untagged. */
    tags: text('tags').notNull(),
  });
}

export type StalefreeCacheTable = ReturnType<typeof stalefreeCacheTable>;
