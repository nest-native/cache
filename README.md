# stalefree

> [!NOTE]
> **Pre-release scaffold.** The engine lands milestone by milestone — see the
> committed constitution in
> [GUIDELINES_NEST_CACHE.md](GUIDELINES_NEST_CACHE.md). Nothing is published
> to npm yet.

**Tag-based cache invalidation through the database you already have.**

Two packages, one idea:

- **`@stalefree/core`** — a framework-agnostic, zero-dependency two-tier cache:
  an in-memory L1 per instance (optionally backed by a shared Drizzle L2 table),
  kept coherent across instances by an **invalidation bus** with
  database-native implementations — Postgres `LISTEN`/`NOTIFY` first, a unix
  domain socket for same-machine multi-process, in-process for a single node.
  No Redis, no extra infrastructure.
- **`@nest-native/cache`** — a thin NestJS DI adapter over the core, part of
  the [nest-native](https://github.com/nest-native) family.

The flagship guarantee is **transactional invalidation**: on Postgres the
invalidation rides your business transaction (`pg_notify` in-tx) — delivered
**on commit**, dropped on rollback. "Wrote the row, crashed before invalidating
the cache, stale forever" — the dual-write problem applied to caches — cannot
happen. And because every entry carries a TTL, a lost bus message means *stale
until TTL*, never *stale forever*: the bus is the freshness optimization, the
TTL is the backstop.

MIT licensed. Not affiliated with the NestJS core team.
