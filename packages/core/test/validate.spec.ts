import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { assertValidKey, assertValidTags, assertValidTtl } from '../validate';
import { VERSION } from '../version';

describe('VERSION', () => {
  test('exports a semver-shaped string', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  });
});

describe('assertValidKey', () => {
  test('accepts identifier-safe keys', () => {
    assertValidKey('project:42');
    assertValidKey('user_1.profile-v2');
    assertValidKey('a');
    assertValidKey('k'.repeat(256)); // exactly the cap
  });

  test('rejects empty, oversized, and out-of-charset keys', () => {
    assert.throws(() => assertValidKey(''), /invalid cache key/);
    assert.throws(() => assertValidKey('k'.repeat(257)), /invalid cache key/);
    assert.throws(() => assertValidKey('has space'), /invalid cache key/);
    assert.throws(() => assertValidKey('emoji💥'), /invalid cache key/);
    assert.throws(() => assertValidKey('semi;colon'), /invalid cache key/);
    assert.throws(
      () => assertValidKey(42 as unknown as string),
      /invalid cache key/,
    );
  });
});

describe('assertValidTags', () => {
  test('accepts valid tag arrays (including empty)', () => {
    assertValidTags([]);
    assertValidTags(['org:1', 'project:42', 'feed.main-v2']);
    assertValidTags(['t'.repeat(128)]); // exactly the cap
  });

  test('rejects any invalid member', () => {
    assert.throws(() => assertValidTags(['ok', '']), /invalid cache tag/);
    assert.throws(() => assertValidTags(['t'.repeat(129)]), /invalid cache tag/);
    assert.throws(() => assertValidTags(['has space']), /invalid cache tag/);
    assert.throws(
      () => assertValidTags([null as unknown as string]),
      /invalid cache tag/,
    );
  });
});

describe('assertValidTtl', () => {
  test('accepts finite positive milliseconds', () => {
    assertValidTtl(1);
    assertValidTtl(15 * 60_000);
  });

  test('rejects absent, non-finite, zero, and negative TTLs', () => {
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, '1000']) {
      assert.throws(() => assertValidTtl(bad), /invalid ttlMs/, String(bad));
    }
  });
});
