import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/pglite';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type { CacheEntry, CacheStore } from '../interfaces';
import { parseTags, serializeTags, tagLikePattern } from '../store-util';
import { MysqlCacheStore, stalefreeCacheTable as mysqlTable } from '../mysql';
import {
  PostgresCacheStore,
  stalefreeCacheTable as pgTable,
} from '../postgres';
import {
  SqliteCacheStore,
  stalefreeCacheTable as sqliteTable,
} from '../sqlite';

const entry = (
  value: unknown,
  expiresAt: number,
  tags: string[] = [],
): CacheEntry => ({ value, expiresAt, tags });

describe('store-util', () => {
  test('tag round-trip and the underscore-escaped LIKE pattern', () => {
    assert.equal(serializeTags([]), '');
    assert.equal(serializeTags(['a', 'b:1']), '|a|b:1|');
    assert.deepEqual(parseTags(''), []);
    assert.deepEqual(parseTags('|a|b:1|'), ['a', 'b:1']);
    assert.equal(tagLikePattern('org:1'), '%|org:1|%');
    assert.equal(tagLikePattern('a_b'), '%|a!_b|%', 'LIKE wildcard _ escaped');
  });
});

/** The one behavioural contract, run against each dialect's real engine. */
function storeContract(
  name: string,
  build: () => Promise<{ store: CacheStore; close?: () => Promise<void> }>,
): void {
  describe(`${name} store contract`, () => {
    test('set/get round-trip (JSON values, tags, upsert), delete, tags, prune', async () => {
      const { store, close } = await build();
      // round-trip + upsert
      await store.set('k1', entry({ deep: [1, 2] }, 5_000, ['org:1', 'p:2']));
      await store.set('k1', entry({ deep: [3] }, 6_000, ['org:1'])); // upsert wins
      const got = await store.get('k1');
      assert.deepEqual(got?.value, { deep: [3] });
      assert.equal(got?.expiresAt, 6_000);
      assert.deepEqual(got?.tags, ['org:1']);
      assert.equal(await store.get('missing'), undefined);

      // stores are dumb: expired rows come back; policy is the cache's job
      await store.set('old', entry('x', 1, []));
      assert.equal((await store.get('old'))?.value, 'x');

      // delete
      await store.delete('k1');
      assert.equal(await store.get('k1'), undefined);

      // tag invalidation incl. the _-wildcard hazard: 'a_b' must NOT match 'aXb'
      await store.set('t1', entry(1, 5_000, ['a_b']));
      await store.set('t2', entry(2, 5_000, ['aXb']));
      await store.set('t3', entry(3, 5_000, ['other', 'a_b']));
      await store.invalidateTags(['a_b']);
      assert.equal(await store.get('t1'), undefined);
      assert.equal((await store.get('t2'))?.value, 2, 'escaped LIKE left aXb alone');
      assert.equal(await store.get('t3'), undefined);
      await store.invalidateTags(['no-such-tag']); // harmless

      // prune drops only expired rows
      await store.set('fresh', entry('f', 10_000, []));
      await store.prune(2);
      assert.equal(await store.get('old'), undefined, 'expired pruned');
      assert.equal((await store.get('fresh'))?.value, 'f');
      await close?.();
    });
  });
}

storeContract('sqlite (real better-sqlite3)', async () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(
    'CREATE TABLE stalefree_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL, tags TEXT NOT NULL)',
  );
  const db = drizzleSqlite(sqlite);
  return { store: new SqliteCacheStore(db, sqliteTable()) };
});

storeContract('postgres (real pglite)', async () => {
  const raw = new PGlite();
  const db = drizzlePg(raw);
  await db.execute(
    'CREATE TABLE stalefree_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT NOT NULL, tags TEXT NOT NULL)',
  );
  return {
    store: new PostgresCacheStore(db, pgTable()),
    close: async () => {
      await raw.close();
    },
  };
});

describe('mysql store SQL shape (drizzle-mysql2 builder)', () => {
  // No in-process MySQL exists; the real round-trip is the gated integration
  // spec. Here the REAL drizzle mysql2 builder runs against a recording fake
  // client, proving the store emits the intended statements.
  function recordingDb(rows: unknown[][] = [[]]): {
    db: unknown;
    statements: string[];
  } {
    const statements: string[] = [];
    const fake = {
      query(options: { sql: string }): Promise<unknown> {
        statements.push(options.sql);
        return Promise.resolve([rows.shift() ?? [], []]);
      },
    };
    return { db: drizzleMysql(fake as never, { mode: 'default' }), statements };
  }

  test('emits upsert, escaped LIKE delete, and prune statements', async () => {
    const { db, statements } = recordingDb([[], [], [], []]);
    const store = new MysqlCacheStore(db, mysqlTable());
    await store.set('k', entry('v', 1_000, ['a_b']));
    await store.invalidateTags(['a_b']);
    await store.prune(500);
    await store.delete('k');
    assert.match(statements[0]!, /on duplicate key update/i);
    assert.match(statements[1]!, /like .+ escape/i);
    assert.match(statements[2]!, /`expires_at` <= /i);
    assert.match(statements[3]!, /delete from/i);
  });

  test('get maps a row and a miss', async () => {
    // drizzle-mysql2 selects with rowsAsArray and maps positionally — the
    // fake row is an ARRAY in column-declaration order (key, value,
    // expires_at, tags), the same reason messaging's mysql fake is positional.
    const row = ['k', JSON.stringify({ a: 1 }), 900, '|t|'];
    const { db } = recordingDb([[row], []]);
    const store = new MysqlCacheStore(db, mysqlTable());
    const hit = await store.get('k');
    assert.deepEqual(hit?.value, { a: 1 });
    assert.equal(hit?.expiresAt, 900);
    assert.deepEqual(hit?.tags, ['t']);
    assert.equal(await store.get('missing'), undefined);
  });
});
