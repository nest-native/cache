# Changelog

All notable user-facing changes to `@stalefree/core` and `@nest-native/cache`
are tracked here.

## Unreleased

CI, docs, and Dependabot only — no package change; both packages remain at
0.1.0.

- **NestJS 12 support is now a tested claim, not a declared one.** The adapter
  already published `@nestjs/common` / `@nestjs/core` peers of
  `^10.0.0 || ^11.0.0 || ^12.0.0`, so nothing changes for consumers, and the
  devDependencies and the lockfile stay on 11.x. What changed: the
  informational 12-alpha canary (typecheck only, `continue-on-error`) is
  replaced by a `nestjs-latest-major` CI leg — no `continue-on-error`, so a
  12 breakage fails the run — that installs `@nestjs/*@^12` on top of the
  11.x lockfile (`--no-save`), proves from inside the adapter workspace that
  `@nestjs/core` resolved to 12, and runs the adapter typecheck and both
  suites. Nothing was broken on 12: the
  adapter has no deep `@nestjs/*` imports (NestJS 12 is ESM-only, so a
  directory import such as `@nestjs/common/interfaces` would not resolve),
  and its one lifecycle hook — `onApplicationShutdown` detaching the cache
  from the bus — does not depend on the cross-provider hook order that 12
  changed. Dependabot config added (there was none), with the peer group
  including majors so the next NestJS major arrives as one installable PR
  rather than one `ERESOLVE` per package. Docs gained a support-policy page
  with the compatibility table and the peer-major recipe.
- **The effective Node floor with NestJS 12 is stated.** NestJS 12 itself
  needs Node `>=22.12` (its `require(esm)` requirement, which its packages'
  `engines` field — `>= 20` — does not encode, so npm never warns); every
  compatibility table now says so. The packages' own `engines` stay `>=22`:
  with NestJS 10 or 11 the adapter runs on any Node 22.
- **Both supported Node majors run the suites.** The tests/coverage lane that
  still carried its `(Node 20)` name from before the Node 20 sunset now runs
  on Node 24; until now 24 only got the build/typecheck matrix.

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
