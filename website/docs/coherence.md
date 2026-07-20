---
sidebar_position: 3
title: Coherence
---

# Coherence across instances

The bus is the coherence seam: `invalidateTags` / `delete` publish an
invalidation message, and every other instance evicts the matching entries
from its L1 on receipt. Pick the bus that matches your deployment:

| Deployment | Bus | Import |
| --- | --- | --- |
| One process | *(none needed — it's coherent by definition)* | `@stalefree/core` |
| Several processes, one machine (the classic app + worker split; also SQLite's whole story) | Unix-socket hub/peer mesh with crash re-election | `@stalefree/core/socket` |
| Several machines sharing Postgres | `LISTEN`/`NOTIFY`, with transactional publish | `@stalefree/core/postgres` |

Every bus honours the same contract: `publish` is **fire-and-forget** (it
never throws into your request path), delivery is **best-effort**, and the
mandatory TTL is the backstop — a missed notification (listener reconnecting,
worker down, re-election in flight) costs staleness *until TTL*, nothing more.
The publisher also receives its own message; eviction is idempotent, so
self-delivery is harmless.

## One process: no bus

A single process needs no configuration — the cache that evicted its own L1
is the only L1 there is. `InProcessInvalidationBus` still ships in the core:
it's the reference implementation of the `InvalidationBus` contract, the seam
for tests, and the coherence story for two `StalefreeCache` instances living
in one process.

## Same machine: the socket bus

For several processes on one machine — the classic app + worker split, and
the whole cross-process story for SQLite (processes sharing a SQLite file are
on one machine by definition):

```ts
import {StalefreeCache} from '@stalefree/core';
import {SocketInvalidationBus} from '@stalefree/core/socket';

const bus = new SocketInvalidationBus({
  path: '/run/myapp/stalefree.sock', // same value in every process
  onError: (error) => logger.warn({error}, 'cache bus'),
});
await bus.start(); // resolves once the first attach lands

const cache = new StalefreeCache({bus, defaultTtlMs: 30_000});
```

How it works: the first process to bind the socket path becomes the **hub**;
every other process connects as a **peer**. A message published anywhere is
dispatched locally, sent to the hub, and re-broadcast to every other
connection. If the hub dies, the peers re-run the bind-or-connect dance and
the first to bind is the new hub. A stale socket file from a crashed hub is
reclaimed only after two consecutive refused cycles (a live hub mid-`listen`
also refuses briefly), and the hub self-checks its socket file's inode and
resigns if the path was yanked from under it — nothing is ever stranded
silently. Messages lost during a re-election are not recovered: the TTL
bounds the staleness, the same contract as every stalefree bus.

A frame too large for the wire degrades **on the send side** to
`{clear: true}` — receivers evict everything. Colder cache, never staler
data.

:::warning Put the socket in a 0700 directory
Any local process that can reach the socket path can publish evictions (worst
case: a cold cache). Place the socket in a directory only your app's user can
access (e.g. mode `0700`), not a world-writable `/tmp`. On Windows, use a
`\\.\pipe\` name.
:::

## Cross-machine: Postgres `LISTEN`/`NOTIFY`

The flagship tier for several machines sharing a Postgres database:

```ts
import pg from 'pg';
import {StalefreeCache} from '@stalefree/core';
import {PostgresInvalidationBus} from '@stalefree/core/postgres';

const bus = new PostgresInvalidationBus({
  connect: () => new pg.Client({connectionString, keepAlive: true}),
  db,                       // your base drizzle handle (fire-and-forget publishes)
  onError: (error) => logger.warn({error}, 'cache bus'),
});
bus.start(); // launches the supervised LISTEN loop

const cache = new StalefreeCache({bus, defaultTtlMs: 30_000});
```

- **`connect` must return a fresh, dedicated client per attempt — never a
  pooled connection** — and should set **`keepAlive: true`**: a pure-receive
  socket never detects half-open TCP death without it, and a listener that
  doesn't know it's dead misses every notification until the TTL saves it.
- **`db`** is the base (non-transactional) drizzle handle used by
  fire-and-forget `publish`. A failed publish is reported to `onError` and
  costs staleness-until-TTL on other instances, nothing more.
- The listener is supervised: on error or disconnect it reconnects after
  `reconnectDelayMs` (default 5000 ms).
- The NOTIFY channel defaults to `stalefree_invalidation`; a custom `channel`
  must be identifier-safe and at most 63 characters (Postgres's identifier
  limit — beyond it `LISTEN` silently truncates while `pg_notify` raises, so
  the bus validates up front).

### Transactional invalidation

`publishInTx` is the flagship: run on your drizzle **transaction** handle,
`pg_notify` becomes part of the transaction — Postgres delivers the
notification on commit and drops it on rollback. The invalidation is atomic
with the data change.

```ts
await db.transaction(async (tx) => {
  await tx.update(projects)...;                            // the business write
  await store.invalidateTagsInTx(tx, [`project:${id}`]);   // L2 dies with the commit
  await bus.publishInTx(tx, {tags: [`project:${id}`]});    // L1s evict on commit
});
```

:::warning `publishInTx` and `invalidateTagsInTx` are a pair
With an L2 store configured, `PostgresCacheStore.invalidateTagsInTx` is
**mandatory** alongside `publishInTx`: the bus message only evicts L1s.
Without deleting the L2 rows in the same transaction, every instance's next
read would refill its L1 from the stale L2 row — turning your transactional
invalidation into a de-facto no-op. See [Stores](./stores.md).
:::

Unlike `publish`, `publishInTx` is awaited and **not** fail-open — atomicity
is the whole point, and with a validated channel and capped payloads,
`pg_notify` has no failure mode left that your transaction shouldn't hear
about.

### Payload limits: chunking and the full-clear degradation

`pg_notify` payloads are capped (~8000 bytes). The bus chunks large tag/key
batches into ≤7500-byte payloads automatically — and because keys and tags
are length-capped by validation, chunking always terminates. On the socket
bus the equivalent guard is the send-side degradation of an oversized frame
to `{clear: true}` (evict all). In both cases the degradation direction is
the same by design: a too-big invalidation can make the cache **colder**,
never **staler**.

## Wiring it into NestJS

Build the bus at bootstrap, pass it through `CacheModule.forRootAsync`, and
close it on shutdown where you built it — the module only detaches the cache
from the bus. See the [Quick Start](./quick-start.md#nestjs).
