import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import type { InvalidationMessage } from '../../interfaces';
import { PostgresInvalidationBus } from '../../postgres/postgres-bus';

// Gated end-to-end test against a REAL Postgres (LISTEN needs a real pg.Client;
// pglite covers the notify side hermetically but not the wire listener). Skips
// unless STALEFREE_POSTGRES_URL is set — `npm run infra:up && npm run test:full`.
const POSTGRES_URL = process.env.STALEFREE_POSTGRES_URL;

describe('Postgres bus round-trip (real service)', { skip: !POSTGRES_URL }, () => {
  let pool: import('pg').Pool;
  let db: { execute(query: unknown): Promise<unknown> };
  let publisher: PostgresInvalidationBus;
  let listenerBus: PostgresInvalidationBus;
  const received: InvalidationMessage[] = [];

  before(async () => {
    const pg = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    pool = new pg.Pool({ connectionString: POSTGRES_URL });
    db = drizzle(pool as never) as never;

    // Two independent bus instances — the publisher's app and a "second
    // machine" listener — sharing only the database.
    publisher = new PostgresInvalidationBus({
      connect: () => new pg.Client({ connectionString: POSTGRES_URL, keepAlive: true }),
      db,
      channel: 'stalefree_it',
    });
    listenerBus = new PostgresInvalidationBus({
      connect: () => new pg.Client({ connectionString: POSTGRES_URL, keepAlive: true }),
      db,
      channel: 'stalefree_it',
    });
    listenerBus.subscribe((m) => received.push(m));
    listenerBus.start();
    await new Promise((resolve) => setTimeout(resolve, 300)); // LISTEN settles
  });

  after(async () => {
    await publisher?.close();
    await listenerBus?.close();
    await pool?.end();
  });

  test('publish() crosses instances; publishInTx is delivered on commit and dropped on rollback', async () => {
    publisher.publish({ tags: ['plain'] });
    await waitFor(() => received.length === 1, 'fire-and-forget notify arrives');
    assert.deepEqual(received[0], { tags: ['plain'] });

    // Transactional: committed → delivered.
    await (db as never as {
      transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
    }).transaction(async (tx) => {
      await publisher.publishInTx(tx as never, { tags: ['committed'] });
    });
    await waitFor(() => received.length === 2, 'commit delivers the invalidation');
    assert.deepEqual(received[1], { tags: ['committed'] });

    // Transactional: rolled back → dropped by Postgres itself.
    await assert.rejects(
      (db as never as {
        transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
      }).transaction(async (tx) => {
        await publisher.publishInTx(tx as never, { tags: ['rolled-back'] });
        throw new Error('force rollback');
      }),
      /force rollback/,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(received.length, 2, 'a rolled-back invalidation never arrives');
  });
});

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
