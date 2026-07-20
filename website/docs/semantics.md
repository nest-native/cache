---
sidebar_position: 5
title: Semantics
---

# Semantics worth knowing

The contracts below are deliberate design decisions — knowing them is the
difference between a cache that quietly does the right thing and an afternoon
of debugging.

## Fail-open, and whose errors are whose

**Cache-infrastructure failures fail open.** A store or bus error is reported
to your `onError(error, context)` callback and the call proceeds — a miss
instead of an outage, a slower app instead of a broken one. The `context`
string tells you which seam failed (`store.get`, `store.set`,
`store.invalidateTags`, …).

**Loader errors are yours.** An error thrown by your `wrap` loader is *not*
routed to `onError`: it propagates untouched to the caller (and to every
concurrent caller joined on the same single-flight run) and caches nothing.
The cache never swallows or wraps your business errors.

## `undefined` is never cached — `null` is

A loader that returns `undefined` gets its value returned to the caller but
**not cached** — `undefined` is indistinguishable from a miss, so caching it
would be meaningless. If "known to be absent" is worth caching (it usually
is), return `null`: `null` is a value and caches normally.

## Values are held by reference — treat them as immutable

L1 stores your values **by reference**. Mutating an object returned from the
cache mutates the cache for every later hit — until an L2 round-trip
re-serializes it, at which point the corruption becomes tier-dependent
(mutated on the instance that wrote it, clean after an L2 refill) and
maddening to debug. **Clone before mutating.**

## Do not re-enter `wrap` for the same key

:::danger Re-entrant `wrap` deadlocks
Never call `wrap` for the **same key** from inside its own loader — even
transitively through other services. The inner call joins the outer in-flight
promise, and both deadlock waiting on each other. Single-flight has no
re-entrancy detection: structure loaders to read from the **source**, not
from the cache.
:::

## Single-flight is per-process only

`wrap`'s stampede protection is in-process: N concurrent misses for one key
in one process share a single loader run. **Cross-instance** stampede control
is out of scope for v1 — documented, not pretended. Ten instances going cold
on the same key at the same moment run ten loaders (the shared
[L2](./stores.md) softens this: the first instance to finish writes the row,
and the rest hit it afterwards).

## TTL is mandatory

Every entry needs a TTL, per call (`ttlMs`) or via the cache's
`defaultTtlMs`; a `set`/`wrap` with neither throws, and infinite TTLs are
rejected. This is the delivery backstop that makes best-effort buses safe: a
lost invalidation message means *stale until TTL*, never *stale forever*.
Validation runs **up front** in `wrap` — a bad TTL or tag fails fast and
deterministically instead of surfacing only after the loader ran (or passing
silently whenever the read happens to be a hit).

## Keys and tags

Keys and tags are allow-listed — `[A-Za-z0-9_:.-]`, keys 1–256 characters,
tags 1–128 (MySQL L2 caps keys at [191](./stores.md)) — because they travel
through SQL rows, `NOTIFY` payloads, socket frames, and log lines. The
charset **is** the injection defense: every transport stays simple and
injection-proof. Values are your business; keys and tags are the cache's to
constrain.

Two rules that follow:

- **Put the tenant dimension in the key** (`org:7:project:42`, not
  `project:42`) — cross-tenant isolation by construction, since a key is the
  only lookup handle there is.
- **Never put secrets in a key or tag.** They appear in bus payloads and are
  fair game for logs; nothing secret may ever be *required* to appear there.

## The bus contract, in one line

Best-effort delivery, fire-and-forget publish, idempotent eviction on
receipt, and the TTL as the backstop — every tier ([in-process, socket,
Postgres](./coherence.md)) honours the same contract, and every degradation
(missed frame, re-election, oversized message) lands on the same side: a
**colder** cache, never a **staler** one.
