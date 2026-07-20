---
sidebar_position: 1
title: Introduction
---

# stalefree

**Tag-based cache invalidation through the database you already have** — an
in-memory L1 kept coherent across instances by an invalidation bus (Postgres
`LISTEN`/`NOTIFY` first), with an optional Drizzle-backed shared L2. No Redis.

:::info Released
`@stalefree/core` and `@nest-native/cache` are published at **0.1.0**. This is
a community project in the [nest-native](https://github.com/nest-native) family
and is **not** affiliated with the NestJS core team.
:::

## The idea

Caching expensive reads is easy; **knowing when to throw them away is the hard
part** — especially across instances. The usual answer bolts on Redis for the
pub/sub. stalefree's answer: the invalidation travels through the **database
your instances already share**.

Two rules make it safe:

1. **Every entry has a TTL — no exceptions.** The bus is best-effort by
   contract, so the TTL is the delivery backstop: a lost invalidation message
   means *stale until TTL*, never *stale forever*. The API rejects infinite
   TTLs — a cache whose correctness depends on a bus message arriving is a
   design bug.
2. **On Postgres, invalidation can be transactional.** `publishInTx` runs
   `pg_notify` inside your business transaction: Postgres delivers it **on
   commit** and drops it on rollback. "Wrote the row, crashed before
   invalidating, stale forever" — the dual-write problem applied to caches —
   cannot happen.

What that buys you in practice:

- **`wrap(key, loader, {tags})`** — read-through with in-process
  single-flight: concurrent misses for one key share a single loader run.
- **`invalidateTags(tags)`** after a mutation — evicts every entry carrying
  the tag locally, in the L2 (if configured), and on every other instance via
  the bus.
- **Three coherence tiers**, from a single process to a fleet of machines
  sharing Postgres — see [Coherence](./coherence.md).
- **Fail-open everywhere**: a store or bus failure degrades the cache to a
  slower app, never a broken one — see [Semantics](./semantics.md).

## Two packages

| Package | What it is |
| --- | --- |
| [`@stalefree/core`](https://www.npmjs.com/package/@stalefree/core) | the framework-agnostic, zero-dependency engine + buses + Drizzle L2 stores |
| [`@nest-native/cache`](https://www.npmjs.com/package/@nest-native/cache) | a thin NestJS DI adapter (`CacheModule` + `CacheService`) |

Use the core directly from Express, Fastify, or a bare script; use the adapter
when you're on NestJS (10, 11, or 12).

## What it is not

stalefree is **not** a distributed cache, **not** a cache-coherence protocol,
and **not** a Redis replacement for hot-path KV at massive scale. It is the
honest 95% case: "cache these expensive reads, and when the data changes,
every instance finds out through the database we already share."

## Relationship to other tools

- [`@nestjs/cache-manager`](https://docs.nestjs.com/techniques/caching) is the
  official NestJS wrapper over `cache-manager`: per-key TTL caching against
  pluggable stores. If per-key TTL expiry is all you need, it's the simplest
  path. stalefree exists for the next step — **tag-based invalidation that
  reaches every instance**, without adding Redis for the pub/sub, plus the
  transactional-invalidation guarantee on Postgres.
- [bentocache](https://bentocache.dev/) is a batteries-included multi-tier
  caching library (grace periods, timeouts, and more), typically paired with
  Redis for its cross-instance sync. If you already run Redis and want that
  feature set, it's a strong choice. stalefree's niche is deliberately
  narrower: **no new infrastructure** — the invalidation rides the database
  you already operate, and on Postgres it can be atomic with your write.

Continue with the [Quick Start](./quick-start.md).
