import { bigint, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';

/**
 * The L2 cache table for the mysql2 dialect. `varchar(191)` key (indexable
 * under utf8mb4, the family convention). Column declaration order matters on
 * MySQL only when an upsert's SET expressions read other columns (the
 * ON DUPLICATE KEY UPDATE ordering trap) — this store's SETs are plain
 * values, so no ordering constraint applies here.
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
