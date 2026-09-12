---
sidebar_position: 7
title: Support Policy
---

# Support policy

| Runtime | Supported line |
| --- | --- |
| Node.js | `>=22` (`>=22.12` when paired with NestJS 12 — its own `require(esm)` floor) |
| NestJS (`@nest-native/cache` peer) | `^10.0.0 \|\| ^11.0.0 \|\| ^12.0.0` |
| `drizzle-orm` (`@stalefree/core` optional peer) | `^0.44.0 \|\| ^0.45.0` |

`@stalefree/core` has no runtime dependencies and no framework peer; only the
Drizzle-backed L2 stores (`@stalefree/core/{sqlite,postgres,mysql}`) need
`drizzle-orm`, which is why it is an optional peer. The Postgres bus takes the
client you construct and never imports `pg` itself.

The Node line is the packages' own `engines`. NestJS 12 raises the effective
floor to `>=22.12` when you pair the adapter with it: 12 ships ESM-only and
relies on `require(esm)`, which upstream states as Node 20.19+ / 22.12+ (Node
20 is outside this line). The `@nestjs/*` packages' `engines` field says only
`>= 20`, so npm will not warn you on Node 22.0–22.11 — check the runtime
yourself. With NestJS 10 or 11 the adapter runs on any Node 22.

## How a major is adopted

A new peer major is **widened into the range, never swapped in**:

1. the published `peerDependencies` range widens to include the new major;
2. the devDependencies — and therefore the lockfile every default CI job
   installs — stay on the older major, so the default suite keeps testing that
   end;
3. the `nestjs-compat` CI matrix gets an entry for the new end: each entry
   installs one end of the range with `--no-save` on top of that lockfile,
   proves every workspace resolves exactly it, and runs the typecheck and the
   suites.

Every end of the range is then a tested claim. The published range is
`^10.0.0 || ^11.0.0 || ^12.0.0`; the oldest installable graphs we run are
`10.3.2` and `11.0.0`, pinned exactly. 10.3.2 rather than 10.0.0 because
`@nestjs/common` 10.0.0–10.3.1 peer on `reflect-metadata ^0.1.12` while this
repo (like any consumer on reflect-metadata 0.2) pins `^0.2.2`, so 10.3.2 is
the oldest 10 that installs at all; nothing the adapter uses was added by a
later 10.x or 11.x. The `12` entry floats on `^12.0.0`. NestJS 12 (released
2026-08-27; ESM-only; Node `>=22.12` on this support line, see above) is the
live example of step 3: on Node 22 (the newest 22.x, above that floor) the
leg installs `@nestjs/*@^12` in every workspace (`--no-save`; a root-only
install cannot swap a peer-linked set in place), proves from inside every
workspace that each package resolved to 12 from the root `node_modules` with
every NestJS-ecosystem peer range satisfied, and re-runs the adapter typecheck
and both test suites. The bare-Express sample has no `@nestjs/*` anywhere — it
is the framework-neutrality proof — so it is not part of the matrix.

## What NestJS 12 changed, and what it means here

- **ESM-only, with an exports map.** A deep import that names a directory under
  `@nestjs/*` (for example `@nestjs/common/interfaces`) no longer resolves. The
  adapter imports only from the `@nestjs/common` and `@nestjs/testing` roots,
  and the 12 leg fails on any directory import that ever creeps in.
- **Lifecycle hooks are ordered by module-hierarchy level.** Two providers may
  see the same hook in a different order than on 11. The adapter's only hook
  is `onApplicationShutdown`, which detaches the cache from the bus — a
  synchronous local unsubscribe (every shipped bus implements it as a
  `Set.delete`, a no-op once the bus is closed), so it does not care whether
  your bus or database closed before or after it. Nothing here depends on
  cross-provider hook order.

## Dependabot

The `@nestjs/*` packages peer on each other, so a major that arrives as one
Dependabot PR per package cannot even install — `npm ci` fails with `ERESOLVE`
before a test runs. The peer group in `.github/dependabot.yml` therefore
groups majors as well as minors and patches, so the next major arrives as a
single PR whose CI result means something. That PR is input to the recipe
above, not a substitute for it.
