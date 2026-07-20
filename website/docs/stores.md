---
sidebar_position: 4
title: Stores (L2)
---

# The optional shared L2

By default stalefree is a pure in-memory L1 per instance. Adding a
Drizzle-backed **L2 table** gives you a shared tier: a fresh instance starts
warm (its first `get` fills L1 from L2), and instances share loader work
instead of each recomputing the same miss.

Each dialect subpath exports a table factory and a store:

| Import | Store | Driver |
| --- | --- | --- |
| `@stalefree/core/sqlite` | `SqliteCacheStore` | `better-sqlite3` (synchronous) |
| `@stalefree/core/postgres` | `PostgresCacheStore` | `pg` via `drizzle-orm/node-postgres` |
| `@stalefree/core/mysql` | `MysqlCacheStore` | `mysql2` |

`drizzle-orm` is an **optional peer** — the root `@stalefree/core` import
pulls no Drizzle at all and stays zero-dependency.

## Add the table to your schema

`stalefreeCacheTable()` returns a Drizzle table you add to **your** schema and
migrate with drizzle-kit — the store is constructed with that exact table
instance, so app and engine share byte-identical DDL:

```ts
import {PostgresCacheStore, stalefreeCacheTable} from '@stalefree/core/postgres';

// in your Drizzle schema file — drizzle-kit picks it up like any other table
export const cacheTable = stalefreeCacheTable(); // 'stalefree_cache' by default

const cache = new StalefreeCache({
  store: new PostgresCacheStore(db, cacheTable),
  bus,
  defaultTtlMs: 30_000,
});
```

Every dialect uses the same shape: `key` (primary key), `value`
(JSON-serialized), `expires_at` (absolute epoch milliseconds — an entry can
move between tiers without renegotiating its remaining lifetime), and `tags`
(a delimited list, matched with a dialect-safe `LIKE … ESCAPE '!'` — one
mechanism, identical behaviour on all three dialects).

Then generate the migration as usual:

```bash
npx drizzle-kit generate
```

## Postgres: make the table `UNLOGGED`

Cache rows are transient, so for write-heavy workloads consider hand-editing
the generated migration:

```sql
-- generated:            CREATE TABLE "stalefree_cache" (…)
-- edit it by hand to:   CREATE UNLOGGED TABLE "stalefree_cache" (…)
```

`UNLOGGED` skips WAL — roughly **2× write throughput** — at the cost of the
table being truncated on crash recovery, which for a cache is exactly right:
losing the contents costs a cold cache, never correctness. drizzle-kit cannot
emit `UNLOGGED`, hence the hand edit.

## MySQL: the `COLLATE utf8mb4_bin` edit is REQUIRED

MySQL 8's default collation (`utf8mb4_0900_ai_ci`) is case- and
accent-**insensitive**: `User:1` and `user:1` would collide on the primary
key, and the upsert would overwrite one entry with the other — a
**wrong-value serve**, not mere staleness. drizzle-kit cannot emit a
collation, so edit the generated migration by hand (the same convention as
the Postgres `UNLOGGED` edit):

```sql
`key` varchar(191) COLLATE utf8mb4_bin NOT NULL
```

Two MySQL-specific limits to know:

- The key column is `varchar(191)` — the indexable limit under `utf8mb4`.
  Keys longer than **191 characters** are rejected loudly by the store at
  runtime (the shared validator allows up to 256; MySQL's cap is lower). The
  cache reports the error via `onError` and fails open, rather than silently
  never persisting to L2.
- There is no MySQL invalidation bus in v1 — MySQL deployments use the L2
  plus the [socket bus](./coherence.md#same-machine-the-socket-bus) on one
  machine, or rely on the TTL backstop across machines.

## Pruning expired rows

Expiry is enforced by the cache on read (an expired L2 row is a miss), but
expired rows still occupy space until removed. Schedule `store.prune(now)` —
it deletes every row with `expires_at <= now`:

```ts
setInterval(() => {
  void store.prune(Date.now());
}, 60_000).unref();
```

Any scheduler works (a cron, `@nestjs/schedule`, your job runner) — the store
doesn't schedule itself.

## Transactional invalidation needs the store too

On Postgres, when you use the bus's `publishInTx`, you **must** also delete
the L2 rows in the same transaction with
`PostgresCacheStore.invalidateTagsInTx(tx, tags)` — the bus message only
evicts L1s, and without the paired delete every instance would refill its L1
from the stale L2 row on the next read:

```ts
await db.transaction(async (tx) => {
  await tx.update(projects)...;                          // the business write
  await store.invalidateTagsInTx(tx, tags);              // L2 dies with the commit
  await bus.publishInTx(tx, {tags});                     // L1s evict on commit
});
```

See [Coherence](./coherence.md#transactional-invalidation) for the full
recipe.

## Store semantics

- Stores are **dumb by design**: they return rows as stored and every method
  runs a single statement, so concurrent instances never race a
  read-modify-write. Freshness policy lives in the cache.
- The cache calls stores **fail-open**: a store error is reported to
  `onError` and the call proceeds (a broken L2 is a miss, not an outage).
- `SqliteCacheStore` is fully synchronous (better-sqlite3 is); the cache
  awaits whatever it gets, so the seam is identical either way.
- Tag invalidation in L2 is `O(rows)` per tag — the L2 is a warm-start tier,
  not the hot path. The hot path is L1's reverse tag index
  (`O(affected keys)`).
