---
sidebar_position: 6
title: API Reference
---

# API Reference

## `@stalefree/core`

### `StalefreeCache`

The engine: a read-through, tag-invalidated, two-tier cache.

| Method | Signature | Behaviour |
| --- | --- | --- |
| `get` | `get<T>(key): Promise<T \| undefined>` | fresh value or `undefined`; L1 first, then L2 (filling L1 on a hit) |
| `set` | `set<T>(key, value, options?): Promise<void>` | write to L1 and (when configured) L2; TTL required, tags validated |
| `delete` | `delete(key): Promise<void>` | remove one key everywhere — L1, L2, and every other instance's L1 via the bus |
| `invalidateTags` | `invalidateTags(tags): Promise<void>` | evict everything carrying any of the tags — locally, in L2, and on the bus |
| `wrap` | `wrap<T>(key, loader, options?): Promise<T>` | read-through with in-process single-flight; an `undefined` loader result is returned but not cached; loader errors propagate and cache nothing |
| `close` | `close(): void` | unsubscribe from the bus — the bus itself belongs to the app (close it there) |

### `StalefreeCacheOptions`

| Option | Meaning |
| --- | --- |
| `l1MaxEntries?` | L1 capacity in entries (LRU). Default `10_000`; a finite integer ≥ 1 |
| `store?` | optional shared L2 (`CacheStore`) |
| `bus?` | optional invalidation bus; omit for a purely local cache |
| `defaultTtlMs?` | fallback TTL applied when a `set`/`wrap` omits `ttlMs` |
| `onError?` | `(error, context) => void` — cache-infrastructure failures (fail-open); loader errors are NOT routed here |
| `clock?` | injected clock (epoch ms) — every TTL decision goes through it; great for tests |

### `SetOptions` (per `set`/`wrap`)

| Option | Meaning |
| --- | --- |
| `ttlMs?` | time-to-live in ms; finite and > 0 (falls back to `defaultTtlMs`; one of the two is required) |
| `tags?` | tags this entry is invalidated by, e.g. `['org:1', 'project:42']` |

### The two seams

```ts
interface CacheStore {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  invalidateTags(tags: readonly string[]): void | Promise<void>;
  prune(now: number): void | Promise<void>; // the app schedules this
}

interface InvalidationBus {
  publish(message: InvalidationMessage): void; // fire-and-forget, never throws
  subscribe(handler: (message: InvalidationMessage) => void): () => void;
  close?(): void | Promise<void>;
}
```

Store methods may be synchronous (better-sqlite3) or async (pg/mysql) — the
cache awaits whatever it gets. `InvalidationMessage` is either targeted
(`{tags?, keys?}`) or a full clear (`{clear: true}` — the documented
degradation when a message is too large for its transport).

### Other root exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `InProcessInvalidationBus` | class | the single-process bus: reference implementation of the seam and the test double for everything built on it |
| `L1Cache` | class | the Map-based LRU + reverse tag index the engine uses; exported for tooling |
| `CacheEntry` | type | `{value, expiresAt, tags}` — `expiresAt` is absolute epoch ms, so entries move between tiers without renegotiating their lifetime |
| `assertValidKey` / `assertValidTags` / `assertValidTtl` | functions | the validators (`[A-Za-z0-9_:.-]`; keys ≤ 256 chars, tags ≤ 128; TTL finite and > 0) |
| `VERSION` | const | the package version |

### Subpaths

| Import | Contents |
| --- | --- |
| `@stalefree/core/socket` | `SocketInvalidationBus` + `SocketBusOptions` — the same-machine hub/peer mesh |
| `@stalefree/core/postgres` | `PostgresInvalidationBus` (+ `PostgresBusOptions`, `assertValidChannel`, `chunkMessage`), `PostgresCacheStore`, `stalefreeCacheTable()` |
| `@stalefree/core/sqlite` | `SqliteCacheStore` + `stalefreeCacheTable()` |
| `@stalefree/core/mysql` | `MysqlCacheStore` + `stalefreeCacheTable()` |

The root import pulls no Drizzle and no driver — `drizzle-orm` is an optional
peer used only by the store subpaths, and `pg` only by the Postgres bus.

### `SocketInvalidationBus` (`./socket`)

| Member | Purpose |
| --- | --- |
| `new SocketInvalidationBus({path, reconnectDelayMs?, onError?})` | `path` is the unix-socket path (Windows: a `\\.\pipe\` name), same value in every process; `reconnectDelayMs` defaults to 1000 ms |
| `start(): Promise<void>` | join the mesh (bind as hub or connect as peer); idempotent; resolves once the first attach lands |
| `publish` / `subscribe` / `close` | the `InvalidationBus` contract |

Put the socket in a directory only your app's user can access (mode `0700`)
— see the [security note](./coherence.md#same-machine-the-socket-bus).

### `PostgresInvalidationBus` (`./postgres`)

| Member | Purpose |
| --- | --- |
| `new PostgresInvalidationBus({connect, db, channel?, reconnectDelayMs?, onError?})` | `connect` returns a fresh dedicated `pg.Client` (set `keepAlive: true`; never pooled); `db` is the base drizzle handle for fire-and-forget publishes; `channel` defaults to `stalefree_invalidation` (identifier-safe, ≤ 63 chars); `reconnectDelayMs` defaults to 5000 ms |
| `start(): void` | launch the supervised `LISTEN` loop (idempotent) |
| `publish(message): void` | fire-and-forget `pg_notify` on the base handle; never throws; chunked to fit the payload cap |
| `publishInTx(tx, message): Promise<void>` | **transactional publish** — run on the caller's drizzle transaction handle; delivered on commit, dropped on rollback; awaited and NOT fail-open |
| `subscribe` / `close` | the `InvalidationBus` contract |

### `PostgresCacheStore` (`./postgres`)

The `CacheStore` contract plus one extra method:

| Member | Purpose |
| --- | --- |
| `new PostgresCacheStore(db, table)` | `db` is your drizzle handle; `table` the `stalefreeCacheTable()` instance from your schema |
| `invalidateTagsInTx(tx, tags): Promise<void>` | the transactional partner of `publishInTx` — **mandatory** alongside it when this store is configured, so L2 rows die with the same commit that evicts the L1s ([why](./coherence.md#transactional-invalidation)) |

`SqliteCacheStore` and `MysqlCacheStore` follow the same constructor shape
(`(db, table)`). The stores never open a connection — you pass them your
Drizzle handle. MySQL requires the
[`COLLATE utf8mb4_bin` migration edit](./stores.md#mysql-the-collate-utf8mb4_bin-edit-is-required)
and rejects keys over 191 characters at runtime.

## `@nest-native/cache`

| Export | Kind | Purpose |
| --- | --- | --- |
| `CacheModule` | dynamic module | `forRoot(options)` / `forRootAsync({imports, inject, useFactory})`; global by default (`isGlobal: false` to opt out); closes the cache (detaching it from the bus) on application shutdown |
| `CacheService` | provider | the injectable pass-through: `get` / `set` / `delete` / `invalidateTags` / `wrap` — same signatures as the engine |
| `CACHE_OPTIONS` / `STALEFREE_CACHE` | tokens | `Symbol.for` DI tokens for the resolved options and the underlying `StalefreeCache` (the engine is injectable directly) |
| `CacheModuleOptions` | type | everything `StalefreeCacheOptions` takes, plus `isGlobal` |
| `CacheModuleAsyncOptions` | type | `imports` / `inject` / `useFactory` / `isGlobal` |
| `VERSION` | const | the adapter version |

Two deliberate details:

- **`useFactory` is typed `(...args: any[])`**, mirroring NestJS's own
  `FactoryProvider`: under `strictFunctionTypes` a factory with typed injected
  parameters — the common case, e.g. `(db: AppDatabase) => ({...})` fed by
  `inject` — is not assignable to `(...args: unknown[]) => ...`, so `any[]`
  is what lets your typed factory assign directly.
- **Everything is exported** (`CacheService`, `STALEFREE_CACHE`,
  `CACHE_OPTIONS`), so providers of consuming modules — guards, interceptors,
  other factories — resolve without surprise bootstrap failures in someone
  else's module.

The adapter builds only on stable Nest primitives and supports NestJS
**10, 11, and 12**. All caching logic lives in the framework-agnostic core.

## Operational notes

- **Schedule `store.prune(now)`** when using an L2 — expired rows are ignored
  by reads but occupy space until pruned ([Stores](./stores.md#pruning-expired-rows)).
- **Close order on shutdown:** `cache.close()` (or let the Nest adapter do
  it) detaches the cache from the bus; then close the bus and your database
  where you created them.
- **Everything degrades toward colder, never staler** — the design rule to
  remember when reasoning about failures ([Semantics](./semantics.md)).
