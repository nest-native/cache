# Security Policy

Thank you for helping keep `@stalefree/core` and `@nest-native/cache` safe.
This is correctness-critical code — a cache invalidation engine guards data
freshness and isolation — so correctness reports are especially welcome.

## Supported Versions

Security fixes target the current published package line.

| Package | Supported |
| --- | --- |
| `@stalefree/core` latest minor | Yes |
| `@nest-native/cache` latest minor | Yes |
| Older unpublished branches | No |

## Reporting A Vulnerability

Please do not open a public issue for vulnerabilities or suspected secret
leakage.

Use GitHub's private vulnerability reporting for this repository when available:

<https://github.com/nest-native/cache/security/advisories/new>

If private reporting is unavailable, contact the maintainer through the GitHub
profile and include only the minimum information needed to establish a private
channel. Do not send exploit details, credentials, tokens, database URLs, or
user data in public comments.

## What To Include

Private reports are most useful when they include:

- Affected package version or commit.
- Node, NestJS, Drizzle ORM, and database driver versions (as applicable).
- The smallest reproduction or vulnerable code path.
- Expected impact, such as:
  - **Unbounded staleness** — an entry can serve stale data past its TTL (the
    TTL delivery backstop is violated), or a lost invalidation is never
    recovered within the TTL window.
  - **Transactional invalidation error** — an invalidation published inside a
    rolled-back transaction is delivered anyway, or one published in a
    committed transaction is silently dropped.
  - **Cache poisoning** — a caller can write or evict cache entries it should
    not control.
  - **Cross-tenant leakage** — cached data for one tenant can be served to
    another.
  - **Channel or identifier injection** — key, tag, or channel input reaching
    SQL or `LISTEN`/`NOTIFY` unvalidated.
  - **Invalidation-storm denial of service** — crafted invalidations that
    overwhelm subscribers, the bus, or the database.
  - **fail-open error** — a cache or bus failure breaking the request path
    instead of degrading to the loader.
  - Secret leakage, dependency confusion, or incorrect exception behavior.
- Whether the issue affects package code, samples, docs, CI, or release
  automation.

Please redact secrets, hostnames, tokens, connection strings, and private user
data.

## Project Security Boundaries

These packages implement tag-based cache invalidation through the
application's existing database. Applications still own:

- **What gets cached** — never cache secrets or credentials, and include the
  tenant dimension in cache keys for multi-tenant data; the library documents
  this but cannot enforce it.
- Authorization for the code paths that write cache entries and publish
  invalidations.
- Database credentials, pool sizing, TLS, and network access for the store and
  the invalidation bus (an attacker who can `NOTIFY` is already an
  authenticated database user).
- **TTL choices** — the TTL is the staleness backstop; pick one that bounds the
  staleness the application can tolerate.
- Rate limiting and request-level abuse controls (a distinct concern — use
  `@nestjs/throttler`).

Security fixes in this repository focus on package behavior, samples, docs,
release automation, and patterns that could encourage unsafe usage.

## Disclosure

The maintainer will acknowledge valid private reports as soon as practical,
coordinate a fix when the issue is in scope, and publish release notes or an
advisory when public disclosure is appropriate.
