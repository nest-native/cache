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
- Support line: Node `>=22` (`engines` on both packages); the adapter targets
  NestJS `10.x`/`11.x`/`12.x` (published peer `^10.0.0 || ^11.0.0 || ^12.0.0`
  — both ends of the range are tested claims, see §3). NestJS 12 itself needs
  Node `>=22.12` — its `require(esm)` floor (upstream says 20.19+ / 22.12+;
  Node 20 is outside this line), which the `@nestjs/*` `engines` field
  (`>= 20`) does not encode, so npm never warns. That is the effective floor
  when the adapter is paired with 12; it is stated in every compatibility
  table and stays out of `engines`, which describe the adapter alone — with
  NestJS 10/11 it runs on any Node 22. Drizzle stores target `0.44`/`0.45`.

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
- **Version compatibility — the peer-major recipe, as applied to NestJS.** The
  adapter builds ONLY on stable Nest primitives (`DynamicModule`, plain
  injectable providers, `OnApplicationShutdown`) so the same code runs on
  NestJS 10, 11, and 12. A new peer major is **widened into the range, never
  swapped in**: (1) the published `peerDependencies` range widens; (2) the
  `@nestjs/*` devDependencies — and therefore the lockfile every default CI
  job installs — stay on the older major (11.x today) so the default suite
  keeps testing that end; (3) a dedicated CI leg installs the newer major
  with `--no-save` on top of that lockfile and runs the typecheck and both
  suites. That leg is `nestjs-latest-major`: it installs `@nestjs/*@^12`
  with `npm install --no-save --workspaces --include-workspace-root` (the
  workspace flags are load-bearing even though only the root declares
  `@nestjs/*`: a root-only `--workspace-root` install fails ERESOLVE because
  npm swaps the four peer-linked packages one at a time inside the 11 tree
  and trips over `platform-express@11` still peering on `core@^11`;
  declaring the specs from every workspace makes npm re-resolve the set as a
  whole), asserts from inside `packages/nestjs` that
  `@nestjs/core` resolved to 12 before running anything, then runs the
  adapter typecheck, the core suite, and the adapter suite. It runs without
  `continue-on-error`, so a 12 breakage fails the run — a red CI run, the
  same weight as any other job; it replaced the informational 12-alpha
  canary once 12 went stable (2026-08-27). It runs on Node 22 (the newest
  22.x, above NestJS 12's `>=22.12` floor, §1). A 10/11 matrix typechecks
  the adapter at the older end.
  Dependabot cannot deliver a NestJS major on its own: the `@nestjs/*`
  packages peer on each other, so one-package-per-PR bumps fail `npm ci`
  with ERESOLVE before a single test runs (NestJS 12 opened fifteen such PRs
  across the org). The peer group in `.github/dependabot.yml` therefore
  groups majors too, so the next major arrives as one PR whose result
  carries information — input to this recipe, not a replacement for it.
- **NestJS 12 is ESM-only: never import a directory index from `@nestjs/*`.**
  `@nestjs/common` and `@nestjs/core` 12 ship an exports map of
  `{".", "./internal", "./*.js", "./*": "./*.js"}`. A deep import that names a
  *file* (`@nestjs/core/injector/constants`) still resolves under it; one that
  names a *directory* (`@nestjs/common/interfaces`) does not, because there is
  no `<dir>.js` and ESM never completes a directory to its `index`. That one
  import was the whole NestJS 12 failure in `@nest-native/kafka` and
  `@nest-native/trpc`. This adapter has **no** deep imports at all — every
  import comes from the `@nestjs/common` / `@nestjs/testing` roots — and that
  is the intended state: the stable-primitives rule above already forbids
  reaching into internals. If a deep import ever becomes unavoidable it must
  name a file, and the `nestjs-latest-major` leg is the enforcement here: a
  directory import fails its typecheck and suite on 12, which the 11.x
  install would never notice. Do not reach for
  `@nestjs/common/interfaces/controllers/controller.interface` as a workaround
  — still an internal path, and 12 defines that type as plain `object` anyway.
- **Lifecycle-hook order across providers is not a contract.** NestJS 12
  reordered lifecycle hooks (`onModuleInit`, `onApplicationBootstrap`,
  `onModuleDestroy`, `beforeApplicationShutdown`, `onApplicationShutdown`) by
  the component's level in the module hierarchy, so the order in which two
  providers see the *same* hook differs between 11 and 12; the phase order is
  unchanged. This adapter's only hook is `CacheModule.onApplicationShutdown`,
  which calls `cache.close()` — a synchronous local unsubscribe from the bus
  (every shipped bus implements it as a `Set.delete`, a no-op once the bus is
  closed), so it is correct whether the application's bus or database closes
  before or after it (the bus and store belong to the app, §2). Any future
  hook may
  rely on the phase order only — never on where another provider's same-phase
  hook falls — and no test may assert a within-phase order.

### 4. Non-negotiable style

- 100% test coverage (branches/functions/lines/statements) on the **core**
  package; SonarJS cognitive complexity ≤ 15 per function on the core.
- The **adapter** is a thin DI shell, tested pragmatically (the lockout
  precedent), with Nest 10/11 typecheck lanes + the `nestjs-latest-major`
  leg that runs it for real on the newest major and fails the run on a
  breakage there (§3).
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
