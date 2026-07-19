# @stalefree/core

<p align="center">Tag-based cache invalidation through the database you already have — an in-memory L1 kept coherent across instances by an invalidation bus (Postgres <code>LISTEN</code>/<code>NOTIFY</code> first), with an optional Drizzle L2. No Redis.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@stalefree/core"><img src="https://img.shields.io/npm/v/@stalefree/core.svg" alt="NPM Version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="Package License" /></a>
  <img src="https://img.shields.io/badge/coverage-100%25-brightgreen.svg" alt="Test Coverage" />
</p>

## The idea

Caching expensive reads is easy; **knowing when to throw them away is the hard
part** — especially across instances. The usual answer bolts on Redis for the
pub/sub. stalefree's answer: the invalidation travels through the **database
your instances already share**.

Two rules make it safe:

1. **Every entry has a TTL — no exceptions.** The bus is best-effort by
   contract, so the TTL is the delivery backstop: a lost invalidation message
   means *stale until TTL*, never *stale forever*. (The API rejects infinite
   TTLs; a cache whose correctness depends on a bus message arriving is a
   design bug.)
2. **On Postgres, invalidation can be transactional.** `publishInTx` runs
   `pg_notify` inside your business transaction: Postgres delivers it **on
   commit** and drops it on rollback. "Wrote the row, crashed before
   invalidating, stale forever" — the dual-write problem applied to caches —
   cannot happen.

## Usage

```bash
npm install @stalefree/core
# drizzle-orm only if you use the L2 stores (optional peer)
```

```ts
import { StalefreeCache } from '@stalefree/core';

const cache = new StalefreeCache({ defaultTtlMs: 30_000 });

// read-through with single-flight: concurrent misses share ONE loader run
const project = await cache.wrap(
  `project:${id}`,
  () => db.select()...,
  { tags: [`org:${orgId}`, `project:${id}`] },
);

// after a mutation: evict every entry carrying the tag — here and, with a
// bus configured, on every other instance
await cache.invalidateTags([`project:${id}`]);
```

## Coherence across instances: pick your bus

| Deployment | Bus | Import |
| --- | --- | --- |
| One process | *(none needed — it's coherent by definition)* | `@stalefree/core` |
| Several processes, one machine (the classic app + worker split; also SQLite's whole story) | Unix-socket hub/peer mesh with crash re-election | `@stalefree/core/socket` |
| Several machines sharing Postgres | `LISTEN`/`NOTIFY`, with transactional publish | `@stalefree/core/postgres` |

```ts
// Postgres, cross-machine — the flagship
import { PostgresInvalidationBus } from '@stalefree/core/postgres';

const bus = new PostgresInvalidationBus({
  connect: () => new pg.Client({ connectionString, keepAlive: true }),
  db,                       // your base drizzle handle (fire-and-forget publishes)
});
bus.start();
const cache = new StalefreeCache({ bus, defaultTtlMs: 30_000 });

// transactional invalidation: atomic with your write
await db.transaction(async (tx) => {
  await tx.update(projects)...;
  await bus.publishInTx(tx, { tags: [`project:${id}`] });
});
```

A missed notification (listener reconnecting, worker down) costs staleness
until TTL, nothing more — the same backstop philosophy on every tier.

## Optional shared L2

Add a Drizzle-backed shared tier so a fresh instance starts warm and instances
share loader work — `@stalefree/core/{sqlite,postgres,mysql}` export a
`stalefreeCacheTable()` factory (add it to your schema, generate a migration)
and a store:

```ts
import { PostgresCacheStore, stalefreeCacheTable } from '@stalefree/core/postgres';
export const cacheTable = stalefreeCacheTable();
const cache = new StalefreeCache({ store: new PostgresCacheStore(db, cacheTable), bus, ... });
```

On Postgres, consider hand-editing the generated migration to
`CREATE UNLOGGED TABLE` — cache rows are transient, and skipping WAL roughly
doubles write throughput at the cost of an empty (not wrong) table after a
crash. Schedule `store.prune(Date.now())` to clear expired rows.

## Semantics worth knowing

- **Fail-open**: store/bus failures are reported to `onError` and the call
  proceeds (a degraded cache is a slower app, never a broken one). Loader
  errors are yours: they propagate untouched and cache nothing.
- **Keys/tags** are allow-listed (`[A-Za-z0-9_:.-]`, length-capped) — they
  travel through SQL, NOTIFY payloads, and socket frames, so the charset is
  the injection defense. Put the tenant dimension IN the key
  (`org:7:project:42`), never secrets.
- **`undefined` is never cached** (indistinguishable from a miss); `null` is.
- Cross-instance stampede control is out of scope for v1 — single-flight is
  per-process.

MIT licensed. The [`@nest-native/cache`](https://www.npmjs.com/package/@nest-native/cache)
adapter wires this into NestJS. Part of the [nest-native](https://github.com/nest-native)
family; not affiliated with the NestJS core team.
