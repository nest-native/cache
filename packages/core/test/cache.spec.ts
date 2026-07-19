import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { StalefreeCache } from '../cache';
import { InProcessInvalidationBus } from '../in-process-bus';
import type { CacheEntry, CacheStore } from '../interfaces';

/** A controllable fake clock. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** An in-memory CacheStore double that records calls and can be told to throw. */
class FakeStore implements CacheStore {
  rows = new Map<string, CacheEntry>();
  calls: string[] = [];
  failing = false;

  #maybeThrow(op: string): void {
    this.calls.push(op);
    if (this.failing) throw new Error(`store ${op} down`);
  }

  get(key: string): CacheEntry | undefined {
    this.#maybeThrow(`get:${key}`);
    return this.rows.get(key);
  }
  set(key: string, entry: CacheEntry): void {
    this.#maybeThrow(`set:${key}`);
    this.rows.set(key, entry);
  }
  delete(key: string): void {
    this.#maybeThrow(`delete:${key}`);
    this.rows.delete(key);
  }
  invalidateTags(tags: readonly string[]): void {
    this.#maybeThrow(`invalidateTags:${tags.join(',')}`);
    for (const [key, entry] of this.rows) {
      if (entry.tags.some((t) => tags.includes(t))) this.rows.delete(key);
    }
  }
  prune(now: number): void {
    this.#maybeThrow(`prune:${now}`);
  }
}

describe('StalefreeCache basics', () => {
  test('set/get round-trip; TTL expiry via the injected clock', async () => {
    const clock = fakeClock();
    const cache = new StalefreeCache({ clock: clock.now });
    await cache.set('k', { a: 1 }, { ttlMs: 1_000 });
    assert.deepEqual(await cache.get('k'), { a: 1 });
    clock.advance(999);
    assert.deepEqual(await cache.get('k'), { a: 1 }, 'still fresh at 999ms');
    clock.advance(1);
    assert.equal(await cache.get('k'), undefined, 'expired exactly at TTL');
  });

  test('defaultTtlMs fills in when a call omits ttlMs; absent both throws', async () => {
    const cache = new StalefreeCache({ defaultTtlMs: 500, clock: fakeClock().now });
    await cache.set('k', 1); // uses the default
    assert.equal(await cache.get('k'), 1);

    const strict = new StalefreeCache({ clock: fakeClock().now });
    await assert.rejects(() => strict.set('k', 1), /invalid ttlMs/);
  });

  test('an invalid defaultTtlMs is rejected at construction', () => {
    assert.throws(
      () => new StalefreeCache({ defaultTtlMs: 0 }),
      /invalid ttlMs/,
    );
  });

  test('key and tag validation guard every public method', async () => {
    const cache = new StalefreeCache({ defaultTtlMs: 500 });
    await assert.rejects(() => cache.get('bad key'), /invalid cache key/);
    await assert.rejects(() => cache.set('bad key', 1), /invalid cache key/);
    await assert.rejects(() => cache.delete('bad key'), /invalid cache key/);
    await assert.rejects(
      () => cache.set('k', 1, { tags: ['bad tag'] }),
      /invalid cache tag/,
    );
    await assert.rejects(
      () => cache.invalidateTags(['bad tag']),
      /invalid cache tag/,
    );
    await assert.rejects(
      () => cache.wrap('bad key', () => 1),
      /invalid cache key/,
    );
  });

  test('delete removes locally; invalidateTags([]) is a validated no-op', async () => {
    const bus = new InProcessInvalidationBus();
    const published: unknown[] = [];
    bus.subscribe((m) => published.push(m));
    const cache = new StalefreeCache({ defaultTtlMs: 500, bus });
    await cache.set('k', 1, { tags: ['t'] });
    await cache.delete('k');
    assert.equal(await cache.get('k'), undefined);
    const before = published.length;
    await cache.invalidateTags([]);
    assert.equal(published.length, before, 'empty invalidation publishes nothing');
  });

  test('uses the real clock by default (smoke)', async () => {
    const cache = new StalefreeCache();
    await cache.set('k', 'v', { ttlMs: 60_000 });
    assert.equal(await cache.get('k'), 'v');
  });
});

describe('StalefreeCache + L2 store', () => {
  test('fills L1 from a fresh L2 hit (store consulted once)', async () => {
    const clock = fakeClock();
    const store = new FakeStore();
    store.rows.set('k', { value: 'warm', expiresAt: clock.now() + 5_000, tags: [] });
    const cache = new StalefreeCache({ store, clock: clock.now });
    assert.equal(await cache.get('k'), 'warm');
    assert.equal(await cache.get('k'), 'warm');
    assert.equal(
      store.calls.filter((c) => c.startsWith('get:')).length,
      1,
      'second read served from L1',
    );
  });

  test('an expired L2 row is a miss', async () => {
    const clock = fakeClock();
    const store = new FakeStore();
    store.rows.set('k', { value: 'old', expiresAt: clock.now(), tags: [] });
    const cache = new StalefreeCache({ store, clock: clock.now });
    assert.equal(await cache.get('k'), undefined);
  });

  test('set/delete/invalidateTags write through to the store', async () => {
    const clock = fakeClock();
    const store = new FakeStore();
    const cache = new StalefreeCache({ store, clock: clock.now, defaultTtlMs: 500 });
    await cache.set('k', 1, { tags: ['t'] });
    assert.ok(store.rows.has('k'));
    await cache.invalidateTags(['t']);
    assert.ok(!store.rows.has('k'), 'tag invalidation reached L2');
    await cache.set('k2', 2);
    await cache.delete('k2');
    assert.ok(!store.rows.has('k2'));
  });

  test('fails OPEN on every store error, reporting to onError', async () => {
    const clock = fakeClock();
    const store = new FakeStore();
    const errors: string[] = [];
    const cache = new StalefreeCache({
      store,
      clock: clock.now,
      defaultTtlMs: 500,
      onError: (_e, context) => errors.push(context),
    });
    store.failing = true;
    await cache.set('k', 1); // L1 write survives the L2 failure
    assert.equal(await cache.get('k'), 1, 'L1 still serves');
    await cache.delete('k');
    await cache.invalidateTags(['t']);
    assert.equal(await cache.get('missing'), undefined, 'get fails open to miss');
    assert.deepEqual(errors, ['store.set', 'store.delete', 'store.invalidateTags', 'store.get']);
  });

  test('store errors without an onError handler are still swallowed', async () => {
    const store = new FakeStore();
    store.failing = true;
    const cache = new StalefreeCache({ store, defaultTtlMs: 500 });
    await cache.set('k', 1); // must not throw
    assert.equal(await cache.get('k'), 1);
  });
});

describe('StalefreeCache.wrap', () => {
  test('caches the loaded value; hits skip the loader; sync loaders work', async () => {
    const cache = new StalefreeCache({ defaultTtlMs: 500, clock: fakeClock().now });
    let loads = 0;
    const load = () => {
      loads += 1;
      return 'value';
    };
    assert.equal(await cache.wrap('k', load), 'value');
    assert.equal(await cache.wrap('k', load), 'value');
    assert.equal(loads, 1);
  });

  test('single-flight: concurrent wraps share ONE loader run', async () => {
    const cache = new StalefreeCache({ defaultTtlMs: 500, clock: fakeClock().now });
    let loads = 0;
    let release!: (v: string) => void;
    const gate = new Promise<string>((resolve) => (release = resolve));
    const load = () => {
      loads += 1;
      return gate;
    };
    const racers = Promise.all([
      cache.wrap('k', load),
      cache.wrap('k', load),
      cache.wrap('k', load),
    ]);
    release('shared');
    assert.deepEqual(await racers, ['shared', 'shared', 'shared']);
    assert.equal(loads, 1);
  });

  test('a loader error propagates to every joiner, caches nothing, and clears the flight', async () => {
    const cache = new StalefreeCache({ defaultTtlMs: 500, clock: fakeClock().now });
    let calls = 0;
    let reject!: (e: Error) => void;
    const gate = new Promise<string>((_r, rej) => (reject = rej));
    const failing = () => {
      calls += 1;
      return gate;
    };
    const a = cache.wrap('k', failing);
    const b = cache.wrap('k', failing);
    reject(new Error('loader blew up'));
    await assert.rejects(() => a, /loader blew up/);
    await assert.rejects(() => b, /loader blew up/);
    assert.equal(calls, 1);
    // The flight is cleared: a later wrap retries the loader.
    assert.equal(await cache.wrap('k', () => 'recovered'), 'recovered');
  });

  test('an undefined loader result is returned but never cached', async () => {
    const cache = new StalefreeCache({ defaultTtlMs: 500, clock: fakeClock().now });
    let loads = 0;
    const load = () => {
      loads += 1;
      return undefined;
    };
    assert.equal(await cache.wrap('k', load), undefined);
    assert.equal(await cache.wrap('k', load), undefined);
    assert.equal(loads, 2, 'undefined is a miss, not a cached value');
  });
});

describe('StalefreeCache + bus coherence', () => {
  test('invalidateTags on one instance evicts the tag carriers on another', async () => {
    const clock = fakeClock();
    const bus = new InProcessInvalidationBus();
    const a = new StalefreeCache({ bus, clock: clock.now, defaultTtlMs: 5_000 });
    const b = new StalefreeCache({ bus, clock: clock.now, defaultTtlMs: 5_000 });
    await b.set('p', 'cached-on-b', { tags: ['project:1'] });
    await b.set('q', 'untagged');
    await a.invalidateTags(['project:1']);
    assert.equal(await b.get('p'), undefined, 'evicted via the bus');
    assert.equal(await b.get('q'), 'untagged', 'untagged entry untouched');
  });

  test('delete on one instance evicts the exact key on another', async () => {
    const clock = fakeClock();
    const bus = new InProcessInvalidationBus();
    const a = new StalefreeCache({ bus, clock: clock.now, defaultTtlMs: 5_000 });
    const b = new StalefreeCache({ bus, clock: clock.now, defaultTtlMs: 5_000 });
    await b.set('k', 'v');
    await a.delete('k');
    assert.equal(await b.get('k'), undefined);
  });

  test('a clear message flushes the whole L1; an empty message is a no-op', async () => {
    const clock = fakeClock();
    const bus = new InProcessInvalidationBus();
    const cache = new StalefreeCache({ bus, clock: clock.now, defaultTtlMs: 5_000 });
    await cache.set('k1', 1);
    await cache.set('k2', 2);
    bus.publish({}); // neither keys nor tags — nothing to do
    assert.equal(await cache.get('k1'), 1);
    bus.publish({ clear: true }); // the epoch-bump degradation path
    assert.equal(await cache.get('k1'), undefined);
    assert.equal(await cache.get('k2'), undefined);
  });

  test('close() detaches from the bus; the bus itself stays usable', async () => {
    const clock = fakeClock();
    const bus = new InProcessInvalidationBus();
    const cache = new StalefreeCache({ bus, clock: clock.now, defaultTtlMs: 5_000 });
    await cache.set('k', 'v');
    cache.close();
    bus.publish({ keys: ['k'] });
    assert.equal(await cache.get('k'), 'v', 'no longer subscribed');
  });

  test('a bus-less cache publishes nowhere and close() is a no-op', async () => {
    const cache = new StalefreeCache({ defaultTtlMs: 500, clock: fakeClock().now });
    await cache.set('k', 1, { tags: ['t'] });
    await cache.invalidateTags(['t']); // publish is the no-op branch
    assert.equal(await cache.get('k'), undefined);
    cache.close();
  });
});
