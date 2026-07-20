import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import type { CacheEntry } from '../../interfaces';
import { MysqlCacheStore, stalefreeCacheTable as mysqlTable } from '../../mysql';
import {
  PostgresCacheStore,
  stalefreeCacheTable as pgTable,
} from '../../postgres';

// Gated round-trips against REAL services (compose: infra:up / test:full).
const POSTGRES_URL = process.env.STALEFREE_POSTGRES_URL;
const MYSQL_URL = process.env.STALEFREE_MYSQL_URL;

const entry = (
  value: unknown,
  expiresAt: number,
  tags: string[] = [],
): CacheEntry => ({ value, expiresAt, tags });

describe('Postgres store round-trip (real service)', { skip: !POSTGRES_URL }, () => {
  let pool: import('pg').Pool;
  let store: PostgresCacheStore;

  before(async () => {
    const pg = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    pool = new pg.Pool({ connectionString: POSTGRES_URL });
    await pool.query('DROP TABLE IF EXISTS stalefree_cache');
    await pool.query(
      'CREATE TABLE stalefree_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT NOT NULL, tags TEXT NOT NULL)',
    );
    store = new PostgresCacheStore(drizzle(pool as never), pgTable());
  });

  after(async () => {
    await pool?.end();
  });

  test('upsert, tag invalidation with escaped LIKE, prune', async () => {
    await store.set('k', entry({ n: 1 }, 5_000, ['a_b']));
    await store.set('k', entry({ n: 2 }, 6_000, ['a_b'])); // upsert
    await store.set('other', entry('keep', 6_000, ['aXb']));
    assert.deepEqual((await store.get('k'))?.value, { n: 2 });
    await store.invalidateTags(['a_b']);
    assert.equal(await store.get('k'), undefined);
    assert.equal((await store.get('other'))?.value, 'keep');
    await store.set('stale', entry('x', 1, []));
    await store.prune(2);
    assert.equal(await store.get('stale'), undefined);
  });
});

describe('MySQL store round-trip (real service)', { skip: !MYSQL_URL }, () => {
  let connection: Awaited<
    ReturnType<typeof import('mysql2/promise').createConnection>
  >;
  let store: MysqlCacheStore;

  before(async () => {
    const mysql = await import('mysql2/promise');
    const { drizzle } = await import('drizzle-orm/mysql2');
    connection = await mysql.createConnection(MYSQL_URL as string);
    await connection.query('DROP TABLE IF EXISTS stalefree_cache');
    // COLLATE utf8mb4_bin is the documented, REQUIRED migration edit: MySQL's
    // default collation is case-insensitive and would collide case-distinct
    // keys (a wrong-value serve, not staleness).
    await connection.query(
      'CREATE TABLE stalefree_cache (`key` VARCHAR(191) COLLATE utf8mb4_bin PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT NOT NULL, tags TEXT NOT NULL)',
    );
    store = new MysqlCacheStore(
      drizzle(connection as never, { mode: 'default' }),
      mysqlTable(),
    );
  });

  after(async () => {
    await connection?.end();
  });

  test('upsert, tag invalidation with escaped LIKE, prune', async () => {
    await store.set('k', entry({ n: 1 }, 5_000, ['a_b']));
    await store.set('k', entry({ n: 2 }, 6_000, ['a_b'])); // upsert
    await store.set('other', entry('keep', 6_000, ['aXb']));
    assert.deepEqual((await store.get('k'))?.value, { n: 2 });
    await store.invalidateTags(['a_b']);
    assert.equal(await store.get('k'), undefined);
    assert.equal((await store.get('other'))?.value, 'keep');
    await store.set('stale', entry('x', 1, []));
    await store.prune(2);
    assert.equal(await store.get('stale'), undefined);
  });
  test('case-distinct keys stay distinct under the documented binary collation', async () => {
    await store.set('Case:1', entry('upper', 5_000, []));
    await store.set('case:1', entry('lower', 5_000, []));
    assert.equal((await store.get('Case:1'))?.value, 'upper');
    assert.equal((await store.get('case:1'))?.value, 'lower');
    await store.delete('Case:1');
    assert.equal((await store.get('case:1'))?.value, 'lower', 'sibling untouched');
  });
});
