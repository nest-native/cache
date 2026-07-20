# Changelog

All notable user-facing changes to `@stalefree/core` and `@nest-native/cache`
are tracked here.

## 0.1.0 - 2026-07-19

The first published release (both packages).

### `@stalefree/core`

- **The engine.** `StalefreeCache` with `get` / `set` / `delete` /
  `invalidateTags` / `wrap` (read-through with in-process **single-flight**) /
  `close`. **TTL is mandatory** on every entry — the delivery backstop that
  turns any lost invalidation into stale-until-TTL, never stale-forever.
  Tag-based invalidation via an L1 reverse index; **fail-open** on cache-infra
  errors (loader errors propagate untouched); injected clock; allow-listed
  keys/tags (they travel through SQL, NOTIFY payloads, and socket frames).
- **Invalidation buses** (the coherence seam): in-process (ships in `.`);
  `@stalefree/core/socket` — a same-machine hub/peer mesh over a unix domain
  socket with crash re-election, stale-path reclaim (two-strike + retry, so
  racing recoverers can't split the mesh), a stranded-hub inode self-check,
  and send-side degradation of oversized frames to `{clear: true}` (colder,
  never staler); `@stalefree/core/postgres` — `LISTEN`/`NOTIFY` with a
  supervised reconnecting listener (63-byte channel cap, park-then-race
  connect) and **transactional publish**: `publishInTx` rides the caller's
  transaction — delivered on commit, dropped on rollback.
- **Optional Drizzle L2 stores** + `stalefreeCacheTable()` factories at
  `@stalefree/core/{sqlite,postgres,mysql}`; one delimited-tags `LIKE`
  mechanism (`ESCAPE '!'` — dialect-literal-safe) across dialects; `prune()`
  for expiry; `PostgresCacheStore.invalidateTagsInTx` as the mandatory partner
  of `publishInTx` when an L2 is configured (L2 rows die with the commit).
  MySQL: the key column REQUIRES the documented `COLLATE utf8mb4_bin`
  migration edit (default collations are case-insensitive → cross-key
  overwrites), and keys beyond MySQL's 191-char column are rejected loudly.
- Pre-publish **adversarial review** (correctness + security lenses) surfaced
  and fixed two reproduced criticals (a `close()`-during-attach hang; a
  stranded-hub permanent mesh partition) and four real defects — all with
  regression tests. 100% coverage; verified against real Postgres (bus
  commit/rollback semantics, store) and real MySQL (incl. case-distinct keys).

### `@nest-native/cache`

- **The NestJS adapter.** `CacheModule.forRoot` / `forRootAsync` (`useFactory`
  typed `(...args: any[])` so typed injected factory params assign directly),
  `CacheService` (get/set/delete/wrap/invalidateTags), full provider exports,
  global by default, and a shutdown hook that detaches the cache from the bus.
  Built on stable Nest primitives; supports NestJS 10, 11, and 12.

### Samples

- A **two-process bare-Express** sample (the neutrality acceptance test — no
  `@nestjs/*` anywhere): instance A caches, instance B mutates + invalidates
  over the socket bus, instance A serves fresh.
