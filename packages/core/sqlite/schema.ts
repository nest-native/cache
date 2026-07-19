import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The L2 cache table for the better-sqlite3 dialect. Add it to your Drizzle
 * schema and generate a migration with drizzle-kit — the store is constructed
 * with this exact table instance, so app and engine share byte-identical DDL
 * (the nest-native family precedent).
 */
export function stalefreeCacheTable(name = 'stalefree_cache') {
  return sqliteTable(name, {
    key: text('key').primaryKey(),
    /** JSON-serialized value. */
    value: text('value').notNull(),
    /** Absolute expiry, epoch milliseconds. */
    expiresAt: integer('expires_at').notNull(),
    /** Delimited tag list (`|t1|t2|`), empty string when untagged. */
    tags: text('tags').notNull(),
  });
}

export type StalefreeCacheTable = ReturnType<typeof stalefreeCacheTable>;
