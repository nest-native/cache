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
  keeps testing that; (3) the `nestjs-compat` CI matrix gets an entry for the
  new end. That matrix is what makes every end of the range a tested claim:
  one entry per end installs it with `npm install --no-save --workspaces
  --include-workspace-root` on top of the lockfile (the workspace flags are
  load-bearing even though only the root declares `@nestjs/*`: a root-only
  `--workspace-root` install fails ERESOLVE because npm swaps the four
  peer-linked packages one at a time inside the 11 tree and trips over
  `platform-express@11` still peering on `core@^11`; declaring the specs
  from every workspace makes npm re-resolve the set as a whole), proves the
  tree, then runs the adapter typecheck, the core suite, and the adapter
  suite. The `10 floor` entry pins `10.3.2`, the `11 floor` entry `11.0.0`,
  exactly, with the reasons next to the pins; the `12` entry floats on
  `^12.0.0`. A floor is an install-graph fact, not a source fact: nothing
  the adapter uses was added by a later 10.x or 11.x, but `@nestjs/common`
  10.0.0–10.3.1 peer on `reflect-metadata ^0.1.12` and this repo pins
  `^0.2.2`, so 10.3.2 — the first 10.x whose peer admits 0.2 — is the oldest
  10 that installs here at all. Such floors are not peer-range corrections
  (a consumer on reflect-metadata 0.2 cannot reach 10.0–10.3.1 either), and
  the published range changes only if a suite actually fails at a floor.
  The matrix replaced two earlier lanes: a typecheck-only 10/11 matrix that
  pinned with `--legacy-peer-deps` — a leg that needs that flag is reporting
  an unsupported combination, not typechecking a supported one, and the
  10.3.2 floor installs cleanly without it — and the blocking 12 leg that
  had replaced the informational 12-alpha canary once 12 went stable
  (2026-08-27). Every leg runs without `continue-on-error`, so a breakage at
  any end fails the run — a red CI run, the same weight as any other job —
  on Node 22 (the newest 22.x, above NestJS 12's `>=22.12` floor, §1).
  Before a leg tests anything, `scripts/check-nestjs-resolution.mjs <spec>`
  proves the tree is the one it claims: it requires the *exact* pinned
  version from inside every workspace (a downgrade that silently no-ops
  leaves the lockfile's 11.x in place, and "still 11" passes a major check),
  fails on nested copies, and checks every peer range in the NestJS
  ecosystem — every installed package at any depth that is `@nestjs/*` or
  peers on one, the adapter's own published range included — against the
  tree the suite will run on. The same script runs with no argument in
  `release:check`, against the lockfile. It is the gate because npm gives
  you nothing better: a peer conflict npm can override is `npm warn ERESOLVE
  overriding peer dependency` plus exit 0, which neither `npm ls` nor
  `--strict-peer-deps` reports afterwards — and grepping the install log for
  that warning is not a gate either, because npm also prints it for
  transitional states that end coherent.
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
  name a file, and the `nestjs-compat` matrix's `12` leg is the enforcement
  here: a directory import fails its typecheck and suite on 12, which the
  11.x install would never notice. Do not reach for
  `@nestjs/common/interfaces/controllers/controller.interface` as a workaround
  — still an internal path, and 12 defines that type as plain `object` anyway.
- **The default major flips on a trigger, not per PR.** The devDependencies
  and the lockfile move from 11 to 12 when either NestJS 12 exceeds 50% of
  `@nestjs/core`'s weekly downloads or NestJS 11 stops receiving patches,
  whichever comes first. Read the split from
  `https://api.npmjs.org/versions/@nestjs%2Fcore/last-week` (on 2026-09-12:
  11 at 71%, 10 at 19%, 12 at 5%). NestJS has no LTS; the previous major has
  received patches for roughly a year after the next one shipped. Flipping
  means the `12` matrix entry becomes the default install, the `10 floor` and
  `11 floor` entries stay, and the standing grouped dependabot PR for the peer
  set is merged. Until then that PR stays open as the signal that the upgrade
  is one merge away — a green run is not a reason to merge it.
- **Dual CommonJS/ESM publishing is a dated non-goal; revisit in 2027.**
  Every community NestJS library that supports 12 today (nestjs-cls,
  nestjs-pino, the OpenTelemetry and throttler packages) publishes CommonJS
  and loads 12 through `require(esm)` exactly as this adapter does, and no
  consumer has asked for ESM output. An ESM or dual build is a breaking
  change with a real cost and no demonstrated benefit, so do not start one
  "while at it". Revisit when a consumer cannot load the package, or when
  those community libraries move.
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
  precedent), with the `nestjs-compat` matrix that runs it for real on every
  end of the peer range — 10.3.2, 11.0.0 and `^12` — and fails the run on a
  breakage at any of them (§3).
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
