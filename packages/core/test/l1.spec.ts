import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { CacheEntry } from '../interfaces';
import { L1Cache } from '../l1';

const entry = (
  value: unknown,
  expiresAt: number,
  tags: string[] = [],
): CacheEntry => ({ value, expiresAt, tags });

describe('L1Cache', () => {
  test('rejects a non-integer or sub-1 capacity', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new L1Cache(bad), /invalid l1MaxEntries/, String(bad));
    }
  });

  test('get returns fresh entries, drops expired ones, misses unknown keys', () => {
    const l1 = new L1Cache(10);
    l1.set('fresh', entry('a', 100));
    l1.set('stale', entry('b', 50, ['t']));
    assert.equal(l1.get('fresh', 99)?.value, 'a');
    assert.equal(l1.get('stale', 50), undefined); // expiresAt <= now
    assert.equal(l1.size, 1, 'expired entry is dropped on touch');
    assert.equal(l1.invalidateTags(['t']), 0, 'tag index cleaned with the drop');
    assert.equal(l1.get('missing', 0), undefined);
  });

  test('evicts the least-recently-used key at capacity; get refreshes recency', () => {
    const l1 = new L1Cache(2);
    l1.set('a', entry(1, 1000));
    l1.set('b', entry(2, 1000));
    l1.get('a', 0); // a becomes most-recent → b is now oldest
    l1.set('c', entry(3, 1000));
    assert.equal(l1.get('b', 0), undefined, 'b was evicted');
    assert.equal(l1.get('a', 0)?.value, 1);
    assert.equal(l1.get('c', 0)?.value, 3);
  });

  test('replacing a key re-indexes its tags (no capacity eviction on replace)', () => {
    const l1 = new L1Cache(2);
    l1.set('a', entry(1, 1000, ['old']));
    l1.set('b', entry(2, 1000));
    l1.set('a', entry(9, 1000, ['new'])); // replace at capacity: b must survive
    assert.equal(l1.get('b', 0)?.value, 2);
    assert.equal(l1.invalidateTags(['old']), 0, 'old tag no longer points at a');
    assert.equal(l1.get('a', 0)?.value, 9);
    assert.equal(l1.invalidateTags(['new']), 1);
    assert.equal(l1.get('a', 0), undefined);
  });

  test('delete is idempotent and prunes tag sets (shared tags survive)', () => {
    const l1 = new L1Cache(10);
    l1.set('a', entry(1, 1000, ['shared', 'only-a']));
    l1.set('b', entry(2, 1000, ['shared']));
    l1.delete('a');
    l1.delete('a'); // idempotent
    assert.equal(l1.size, 1);
    assert.equal(l1.invalidateTags(['only-a']), 0, 'emptied tag set removed');
    assert.equal(l1.invalidateTags(['shared']), 1, 'shared tag still evicts b');
  });

  test('invalidateTags evicts every carrier across tags and counts them', () => {
    const l1 = new L1Cache(10);
    l1.set('a', entry(1, 1000, ['t1']));
    l1.set('b', entry(2, 1000, ['t1', 't2']));
    l1.set('c', entry(3, 1000, ['t2']));
    l1.set('d', entry(4, 1000));
    assert.equal(l1.invalidateTags(['t1', 't2', 'unknown']), 3);
    assert.equal(l1.size, 1);
    assert.equal(l1.get('d', 0)?.value, 4);
  });

  test('clear empties entries and the tag index', () => {
    const l1 = new L1Cache(10);
    l1.set('a', entry(1, 1000, ['t']));
    l1.clear();
    assert.equal(l1.size, 0);
    l1.set('b', entry(2, 1000, ['t']));
    assert.equal(l1.invalidateTags(['t']), 1, 'index rebuilt cleanly after clear');
  });
});
