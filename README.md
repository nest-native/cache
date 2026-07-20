# stalefree

<p align="center">Tag-based cache invalidation through the database you already have — an in-memory L1 kept coherent across instances by an invalidation bus (Postgres <code>LISTEN</code>/<code>NOTIFY</code> first), with an optional Drizzle L2. No Redis.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@stalefree/core"><img src="https://img.shields.io/npm/v/@stalefree/core.svg?label=%40stalefree%2Fcore" alt="@stalefree/core on npm" /></a>
  <a href="https://www.npmjs.com/package/@nest-native/cache"><img src="https://img.shields.io/npm/v/@nest-native/cache.svg?label=%40nest-native%2Fcache" alt="@nest-native/cache on npm" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/coverage-100%25-brightgreen.svg" alt="Core test coverage" />
</p>

> [!NOTE]
> **Published and following semver.** Version history is in the
> [changelog](CHANGELOG.md); full documentation lives at
> [nest-native.dev/cache](https://nest-native.dev/cache/).

## The idea

Caching expensive reads is easy; knowing when to throw them away — on every
instance — is the hard part. The usual answer bolts on Redis for the pub/sub.
stalefree's answer: the invalidation travels through the **database your
instances already share**.

Two rules make it safe:

1. **Every entry has a TTL — no exceptions.** The bus is best-effort by
   contract, so the TTL is the delivery backstop: a lost invalidation message
   means *stale until TTL*, never *stale forever*. The API rejects infinite
   TTLs.
2. **On Postgres, invalidation is transactional.** `publishInTx` runs
   `pg_notify` inside your business transaction: delivered **on commit**,
   dropped on rollback. "Wrote the row, crashed before invalidating, stale
   forever" — the dual-write problem applied to caches — cannot happen.

```ts
import { StalefreeCache } from '@stalefree/core';

const cache = new StalefreeCache({ defaultTtlMs: 30_000 });

// read-through with single-flight; reads declare tags
const project = await cache.wrap(
  `org:${orgId}:project:${id}`,
  () => repo.findById(id),
  { tags: [`org:${orgId}:projects`, `project:${id}`] },
);

// mutations evict by tag — locally, in L2, and on every other instance
await cache.invalidateTags([`project:${id}`]);
```

## Packages

| Package | What it is |
| --- | --- |
| [`@stalefree/core`](packages/core) ([npm](https://www.npmjs.com/package/@stalefree/core)) | The framework-agnostic, zero-dependency engine: `StalefreeCache` (L1 LRU + reverse tag index, `wrap` single-flight, fail-open), the invalidation buses (`.`, `./socket`, `./postgres`), and the Drizzle L2 stores (`./sqlite`, `./postgres`, `./mysql`) |
| [`@nest-native/cache`](packages/nestjs) ([npm](https://www.npmjs.com/package/@nest-native/cache)) | The thin NestJS DI adapter: `CacheModule.forRoot/forRootAsync` + `CacheService`; NestJS 10, 11, and 12 |

## Coherence across instances: pick your bus

| Deployment | Bus | Import |
| --- | --- | --- |
| One process | *(none needed)* | `@stalefree/core` |
| Several processes, one machine (the app + worker split; SQLite's whole story) | unix-socket hub/peer mesh with crash re-election | `@stalefree/core/socket` |
| Several machines sharing Postgres | `LISTEN`/`NOTIFY` with transactional publish | `@stalefree/core/postgres` |

No tier requires infrastructure you don't already run. See the
[coherence docs](https://nest-native.dev/cache/) for the recipes — including
the mandatory `invalidateTagsInTx` + `publishInTx` pairing when an L2 store is
configured, and the MySQL `COLLATE utf8mb4_bin` migration note.

## See it running

The [nest-native reference app](https://github.com/nest-native/reference-app)
runs this as one of its nine chapters: reads cached at the API seam, mutations
invalidating by tag, and an e2e spec that proves freshness against a
deliberately long TTL — invalidation, provably not expiry. A two-process
bare-Express sample lives in [`sample/`](sample/00-express-two-instances)
(the framework-neutrality proof: no `@nestjs/*` anywhere).

## Development

- `npm test` / `npm run test:cov` — hermetic suite, 100% coverage gate on the core
- `npm run infra:up && npm run test:full` — adds gated round-trips against real Postgres + MySQL (Docker, local-only)
- `npm run sample` — the two-process invalidation smoke
- The binding constitution is [GUIDELINES_NEST_CACHE.md](GUIDELINES_NEST_CACHE.md); `main` is PR-only

MIT licensed. Part of the [nest-native](https://github.com/nest-native) family.
Not affiliated with the NestJS core team.
