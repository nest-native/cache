import { bigint, pgTable, text } from 'drizzle-orm/pg-core';

/**
 * The L2 cache table for the Postgres dialect. Cache rows are transient, so
 * for write-heavy workloads consider making the table `UNLOGGED` (skips WAL;
 * ~2x write throughput; truncated on crash recovery — exactly right for a
 * cache). drizzle-kit cannot emit `UNLOGGED`, so edit the generated migration
 * by hand: `CREATE TABLE …` → `CREATE UNLOGGED TABLE …`. Losing the table's
 * contents on a crash costs a cold cache, never correctness.
 */
export function stalefreeCacheTable(name = 'stalefree_cache') {
  return pgTable(name, {
    key: text('key').primaryKey(),
    /** JSON-serialized value. */
    value: text('value').notNull(),
    /** Absolute expiry, epoch milliseconds. */
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    /** Delimited tag list (`|t1|t2|`), empty string when untagged. */
    tags: text('tags').notNull(),
  });
}

export type StalefreeCacheTable = ReturnType<typeof stalefreeCacheTable>;
