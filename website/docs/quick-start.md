---
sidebar_position: 2
title: Quick Start
---

# Quick Start

## Install

```bash
# framework-agnostic core
npm install @stalefree/core

# NestJS apps: the adapter + the core (buses, stores, and types live in the core)
npm install @nest-native/cache @stalefree/core
```

The Drizzle L2 stores are opt-in — install `drizzle-orm` and your driver only
if you use one (`pg` is also the driver for the Postgres bus):

```bash
npm install drizzle-orm pg        # or better-sqlite3 / mysql2
```

## The framework-agnostic core

Create one cache per process, then `wrap` your expensive reads and
`invalidateTags` after mutations:

```ts
import {StalefreeCache} from '@stalefree/core';

const cache = new StalefreeCache({defaultTtlMs: 30_000});

// read-through with single-flight: concurrent misses share ONE loader run
const project = await cache.wrap(
  `project:${id}`,
  () => db.select()..., // your expensive read
  {tags: [`org:${orgId}`, `project:${id}`]},
);

// after a mutation: evict every entry carrying the tag — here and, with a
// bus configured, on every other instance
await cache.invalidateTags([`project:${id}`]);
```

That's the whole primary API. TTL is **required** — per call via `ttlMs` or
via the cache-wide `defaultTtlMs` fallback; a `set`/`wrap` without either
throws. `get`, `set`, and `delete` exist for the cases `wrap` doesn't cover
(see the [API Reference](./api-reference.md)).

:::tip Put the tenant dimension in the key
Keys like `org:7:project:42` keep tenants apart by construction. Keys and tags
are allow-listed (`[A-Za-z0-9_:.-]`, length-capped) because they travel through
SQL, `NOTIFY` payloads, and socket frames — and they must never contain
secrets. See [Semantics](./semantics.md#keys-and-tags).
:::

## Going multi-instance

A single process needs no bus — its own L1 is coherent by definition. As soon
as two processes serve the same data, give each cache a bus so an invalidation
in one evicts in all:

```ts
// Postgres, cross-machine — the flagship
import pg from 'pg';
import {StalefreeCache} from '@stalefree/core';
import {PostgresInvalidationBus} from '@stalefree/core/postgres';

const bus = new PostgresInvalidationBus({
  connect: () => new pg.Client({connectionString, keepAlive: true}),
  db, // your base drizzle handle (fire-and-forget publishes)
});
bus.start();

const cache = new StalefreeCache({bus, defaultTtlMs: 30_000});
```

[Coherence](./coherence.md) covers all three tiers — in-process, unix-socket
(same machine), and Postgres `LISTEN`/`NOTIFY` — including **transactional
invalidation** with `publishInTx`. [Stores](./stores.md) adds the optional
shared L2 so fresh instances start warm.

## NestJS

Register the module once (global by default) and inject `CacheService`
anywhere:

```ts
import {Module} from '@nestjs/common';
import {CacheModule} from '@nest-native/cache';

@Module({
  imports: [
    CacheModule.forRoot({defaultTtlMs: 30_000}),
  ],
})
export class AppModule {}
```

Then use it (inject by explicit token if your toolchain is esbuild/tsx — they
emit no `design:paramtypes`):

```ts
import {Inject, Injectable} from '@nestjs/common';
import {CacheService} from '@nest-native/cache';

@Injectable()
export class ProjectsService {
  constructor(@Inject(CacheService) private readonly cache: CacheService) {}

  getProject(orgId: number, id: number) {
    return this.cache.wrap(
      `org:${orgId}:project:${id}`,
      () => this.repo.findById(id),
      {tags: [`org:${orgId}`, `project:${id}`]},
    );
  }

  async renameProject(orgId: number, id: number, name: string) {
    await this.repo.rename(id, name);
    await this.cache.invalidateTags([`project:${id}`]);
  }
}
```

For a store and a bus, build them at bootstrap and hand them over via
`forRootAsync`:

```ts
CacheModule.forRootAsync({
  inject: [getDrizzleClientToken()],
  useFactory: (db: AppDatabase) => ({
    defaultTtlMs: 30_000,
    store: new PostgresCacheStore(db, cacheTable), // optional shared L2
    bus,                                           // built at bootstrap
  }),
}),
```

`useFactory` is typed `(...args: any[])` — a factory with typed injected
parameters assigns directly (no widening dance), matching NestJS's own
`FactoryProvider`. The module detaches the cache from the bus on application
shutdown; the bus and store belong to your app — close the bus where you built
it.

## A runnable sample

The repository's
[`sample/00-express-two-instances`](https://github.com/nest-native/cache/tree/main/sample)
is a two-process bare-Express app (no `@nestjs/*` anywhere): instance A
caches, instance B mutates and invalidates over the socket bus, instance A
serves fresh. It doubles as the neutrality acceptance test that keeps the core
framework-agnostic.
