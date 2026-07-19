# GUIDELINES_NEST_CACHE.md
## Core Philosophy — tag-based cache invalidation through the database you already have

`@stalefree/core` implements a **two-tier application cache whose invalidation
travels through the application's existing database** — no Redis, no extra
infrastructure. An in-memory L1 per instance (optionally backed by a shared
Drizzle L2 table) is kept coherent across instances by an **invalidation bus**
with database-native implementations, Postgres `LISTEN`/`NOTIFY` first. It is
**not** a distributed cache, **not** a cache-coherence protocol, and **not** a
Redis replacement for hot-path KV at massive scale — it is the honest 95% case:
"cache these expensive reads, and when the data changes, every instance finds
out through the database we already share."

The flagship correctness feature is **transactional invalidation**: an
invalidation that rides the caller's business transaction (`pg_notify` in-tx on
Postgres) is delivered **on commit** and dropped on rollback — closing the
"wrote the row, crashed before invalidating, stale forever" window, which is the
dual-write problem applied to caches. The `@nest-native/cache` package is a thin
NestJS DI adapter over the neutral core, exactly like `@nest-native/lockout`
over `@authlock/core`.

### 1. Architecture assumptions (never break these)

- **Framework-agnostic, zero-runtime-dependency core.** `@stalefree/core`
  contains no NestJS, no DI container, no decorators, and no Drizzle in its
  default surface. The published `packages/core/package.json` keeps an explicit
  empty `"dependencies": {}`. `drizzle-orm` is an OPTIONAL peer used only by the
  store subpaths; `pg` is an optional peer used only by the Postgres bus.
- **TTL is the delivery backstop — every entry has one.** The bus is
  best-effort by contract (exactly like polling backstops the outbox wakes): a
  lost invalidation message may serve stale data only until the TTL, never
  forever. Infinite-TTL entries are therefore FORBIDDEN by the API — a cache
  whose correctness depends on a bus message arriving is a design bug.
- **Fail-open.** A cache failure (store error, bus down) must never break the
  request path: fall through to the loader, log, keep serving. `failMode` knobs
  may harden specific paths later; the default is always "the app works with
  the cache degraded to a no-op."
- **Two seams, pluggable like the messaging/jobs stores:**
  - `CacheStore` — the optional shared L2 (get/set/delete/invalidateTags/prune),
    Drizzle-backed per dialect (`./sqlite`, `./postgres`, `./mysql`).
  - `InvalidationBus` — `publish(tags)` / `subscribe(handler)`. Implementations:
    in-process (single instance), unix-socket (multi-process, same machine —
    the WakeSocket pattern), Postgres `LISTEN`/`NOTIFY` (cross-machine). MySQL
    gets a poll-based bus only if demand appears; SQLite's same-machine story is
    the socket bus (processes sharing a SQLite file are on one machine by
    definition).
- **Tags are the invalidation model.** `set(key, value, { ttl, tags })` +
  `invalidateTags(tags)`; L1 keeps a reverse tag→keys index so a bus message
  evicts locally in O(affected). Key/tag charsets are allow-listed. Postgres
  NOTIFY payloads are limited (~8000 bytes): tag batches are chunked, and an
  over-threshold invalidation degrades to a documented **epoch bump** (evict
  all) — degraded means "colder cache," never "staler data."
- **Port the hardened listener pattern from messaging — do not import it.** The
  Postgres bus reuses the LESSONS (dedicated non-pooled client, park on
  `end`/`error` before racing `connect()` — pg never settles a connect once
  `end()` was called; 63-byte channel validation because `pg_notify` RAISES
  beyond it inside the caller's transaction; `keepAlive: true` documented on
  every factory; reconnect supervision with validated delay), but the core
  stays zero-dep: the code is written here, not imported from
  `@nest-native/messaging`.
- **Stampede protection is in-process single-flight** (concurrent `wrap()`
  calls for one key share one loader run). Cross-instance stampede control is
  OUT of scope for v1 — documented, not pretended.
- Support line: Node `>=20`; the adapter targets NestJS `10.x`/`11.x`/`12.x`;
  Drizzle stores target `0.44`/`0.45`.

### 2. Public API

**Core (`@stalefree/core`):**
- `StalefreeCache` — `get`, `set(key, value, { ttl, tags })`, `delete`,
  `invalidateTags(tags)`, `wrap(key, loader, { ttl, tags })` (the primary API:
  read-through + single-flight), `close()`.
- `CacheStore` — the optional L2 seam. `InMemoryOnly` is the default (no L2).
- `InvalidationBus` — the coherence seam; `publishInTx(txHandle, tags)` on the
  Postgres bus for transactional invalidation.
- Subpaths: `.` (core + in-process bus), `./socket` (same-machine bus),
  `./postgres` (LISTEN/NOTIFY bus + Drizzle store), `./sqlite`, `./mysql`
  (Drizzle stores).

**NestJS adapter (`@nest-native/cache`):**
- `CacheModule.forRoot(...)` / `forRootAsync(...)` — `useFactory` typed
  `(...args: any[])` from day one (the lockout 0.3.1 lesson).
- `CacheService` — the injectable pass-through.
- `@Cacheable(...)` decorator and `invalidateOnCommit(tags)` via optional
  `@nestjs-cls/transactional` integration — N2, only if they stay thin.

### 3. Implementation rules

- Store rule: stores own persistence primitives; the manager owns policy (TTL
  math, tag index, single-flight, bus fan-out). Behaviour identical across
  stores.
- The bus is fire-and-forget on the publish side (never throws into the request
  path) and supervised on the subscribe side (reconnect with validated delay;
  failures to `onError`).
- Keys and tags: allow-listed charset, length-capped; hashing is NOT applied by
  default (unlike authlock — cache keys are not credentials), but nothing
  secret may ever be required to appear in a key/tag (document it).
- No `Date.now()` scattered: a single injected clock seam, mutation-testable.

### 4. Non-negotiable style

- 100% test coverage (branches/functions/lines/statements) on the **core**
  package; SonarJS cognitive complexity ≤ 15 per function on the core.
- The **adapter** is a thin DI shell, tested pragmatically (the lockout
  precedent), with Nest 10/11 lanes + a gated informational 12-canary.
- Tests cover: TTL expiry (fake clock), tag eviction incl. the reverse index,
  single-flight (N concurrent wraps → 1 loader call), bus round-trips over real
  sockets and real Postgres (gated), chunking + epoch-bump degradation, and the
  fail-open paths. A **bare-Express two-instance sample** is the neutrality
  acceptance test.
- A cold-consumer smoke against the packed tarball before any release.

### 5. Security Review Requirements (MANDATORY)

- Every PR reasons explicitly about: **stale-data windows** (what can serve
  stale, for how long — always bounded by TTL), **cache poisoning** (who can
  write keys/tags), **channel/identifier injection** (LISTEN cannot be
  parameterized — allow-list + quote + 63-byte cap), **cross-tenant leakage**
  (keys must include the tenant dimension; document loudly), and **DoS via
  invalidation storms** (bus messages coalesce; an attacker who can NOTIFY is
  already an authenticated DB user).
- Never log cached values or loader arguments; keys/tags only.
- The `security:audit` release gate audits the packed tarball's production
  closure (`"dependencies": {}` ⇒ exactly what consumers install).

### 6. Release version synchronization (MANDATORY)

- Version bumps update the adapter's `@stalefree/core` dep and every
  `sample/*/package.json` pin, then `npm install` + `npm run release:check`.
- Publish via `vX.Y.Z` tag → `release.yml` with npm **Trusted Publishing
  (OIDC)** once configured; the FIRST publish of each package is a manual token
  bootstrap (`NPM_CONFIG_USERCONFIG=~/.npmrc-oss-general`) because npm cannot
  OIDC-publish a brand-new package — the authlock lesson. The npm org
  **stalefree** must exist before C5.
- **Governance:** local-first (direct commits to `main`, no branch protection)
  until `@nest-native/cache` 0.1.0 is published AND dogfooded in the
  reference-app; then switch `main` to PR-only + branch protection, matching
  the family.
