import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { InvalidationMessage } from '../interfaces';
import {
  assertValidChannel,
  chunkMessage,
  type PgListenConnection,
  PostgresInvalidationBus,
} from '../postgres/postgres-bus';

// `any[]` (not `unknown[]`): the interface's notification listener takes a typed
// message param, which `unknown` cannot satisfy under strictFunctionTypes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

class FakeConnection implements PgListenConnection {
  queries: string[] = [];
  connectCalls = 0;
  failConnect = false;
  hangConnect = false;
  failQuery = false;
  failEnd = false;
  endCalls = 0;
  #listeners = new Map<string, Listener[]>();

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.failConnect) throw new Error('connect refused');
    if (this.hangConnect) return new Promise<void>(() => {});
  }
  async query(text: string): Promise<unknown> {
    this.queries.push(text);
    if (this.failQuery) throw new Error('query failed');
    return undefined;
  }
  async end(): Promise<void> {
    this.endCalls += 1;
    if (this.failEnd && this.endCalls === 1) throw new Error('end failed');
    this.emit('end');
  }
  on(event: string, listener: Listener): unknown {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}

function queue(...connections: FakeConnection[]): {
  factory: () => PgListenConnection;
  handedOut: () => number;
} {
  let index = 0;
  return {
    factory: () => {
      const connection = connections[index];
      assert.ok(connection, `factory exhausted after ${index}`);
      index += 1;
      return connection;
    },
    handedOut: () => index,
  };
}

/** Records execute() calls; optionally rejects. */
class FakeExecutor {
  calls: unknown[] = [];
  failing = false;
  async execute(query: unknown): Promise<unknown> {
    this.calls.push(query);
    if (this.failing) throw new Error('executor down');
    return undefined;
  }
}

async function until(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('assertValidChannel + chunkMessage', () => {
  test('channel: identifier charset and the 63-byte Postgres limit', () => {
    assertValidChannel('stalefree_invalidation');
    assertValidChannel('a'.repeat(63));
    assert.throws(() => assertValidChannel('a'.repeat(64)), /invalid channel/);
    assert.throws(() => assertValidChannel('bad-channel'), /invalid channel/);
    assert.throws(() => assertValidChannel(''), /invalid channel/);
  });

  test('small messages pass through as one chunk; clear untouched', () => {
    assert.deepEqual(chunkMessage({ clear: true }), [{ clear: true }]);
    assert.deepEqual(chunkMessage({ tags: ['a', 'b'] }), [{ tags: ['a', 'b'] }]);
    assert.deepEqual(chunkMessage({ keys: ['k'] }), [{ keys: ['k'] }]);
  });

  test('large tag sets split into payload-sized chunks preserving every tag', () => {
    const tags = Array.from({ length: 200 }, (_, i) => `tag:${'x'.repeat(100)}:${i}`);
    const chunks = chunkMessage({ tags });
    assert.ok(chunks.length > 1, 'must actually chunk');
    const rejoined: string[] = [];
    for (const chunk of chunks) {
      assert.ok('tags' in chunk && chunk.tags);
      assert.ok(
        JSON.stringify(chunk).length <= 7_500,
        'every chunk fits the payload budget',
      );
      rejoined.push(...(chunk.tags as string[]));
    }
    assert.deepEqual(rejoined, tags, 'no tag lost or reordered');
  });

  test('tags and keys chunk independently; empty fields are skipped', () => {
    const chunks = chunkMessage({ tags: ['t1'], keys: ['k1', 'k2'] });
    assert.deepEqual(chunks, [{ tags: ['t1'] }, { keys: ['k1', 'k2'] }]);
    assert.deepEqual(chunkMessage({ tags: [] }), []);
  });
});

describe('PostgresInvalidationBus construction', () => {
  test('rejects bad channels and bad reconnect delays', () => {
    const db = new FakeExecutor();
    assert.throws(
      () => new PostgresInvalidationBus({ connect: queue().factory, db, channel: 'x"; DROP' }),
      /invalid channel/,
    );
    assert.throws(
      () =>
        new PostgresInvalidationBus({
          connect: queue().factory,
          db,
          reconnectDelayMs: 0,
        }),
      /invalid reconnectDelayMs/,
    );
  });
});

describe('PostgresInvalidationBus publish paths', () => {
  test('publish() notifies per chunk on the base handle and never throws', async () => {
    const db = new FakeExecutor();
    const bus = new PostgresInvalidationBus({ connect: queue().factory, db });
    bus.publish({ tags: ['t1'], keys: ['k1'] }); // two chunks (tags, keys)
    await until(() => db.calls.length === 2, 'both chunks notified');
  });

  test('publish() failures go to onError, not the caller', async () => {
    const db = new FakeExecutor();
    db.failing = true;
    const errors: unknown[] = [];
    const bus = new PostgresInvalidationBus({
      connect: queue().factory,
      db,
      onError: (e) => errors.push(e),
    });
    bus.publish({ tags: ['t'] }); // must not throw
    await until(() => errors.length === 1, 'failure reported');
  });

  test('publishInTx awaits and propagates failures (atomicity is the point)', async () => {
    const tx = new FakeExecutor();
    const bus = new PostgresInvalidationBus({ connect: queue().factory, db: new FakeExecutor() });
    await bus.publishInTx(tx, { tags: ['t'] });
    assert.equal(tx.calls.length, 1);
    tx.failing = true;
    await assert.rejects(() => bus.publishInTx(tx, { tags: ['t'] }), /executor down/);
  });

  test('pg_notify actually fires on real SQL (pglite), delivering the JSON payload', async () => {
    const raw = new PGlite();
    const db = drizzle(raw);
    const received: string[] = [];
    await raw.listen('stalefree_invalidation', (payload) => {
      received.push(payload);
    });
    const bus = new PostgresInvalidationBus({
      connect: queue().factory,
      db: db as never,
    });
    await bus.publishInTx(db as never, { tags: ['org:1'] });
    await until(() => received.length === 1, 'pglite listener hears pg_notify');
    assert.deepEqual(JSON.parse(received[0]!), { tags: ['org:1'] });
    await raw.close();
  });
});

describe('PostgresInvalidationBus listener', () => {
  test('LISTENs on the quoted channel and dispatches parsed notifications', async () => {
    const connection = new FakeConnection();
    const bus = new PostgresInvalidationBus({
      connect: queue(connection).factory,
      db: new FakeExecutor(),
    });
    const seen: InvalidationMessage[] = [];
    bus.subscribe((m) => seen.push(m));
    bus.start();
    bus.start(); // idempotent
    await until(() => connection.queries.length === 1, 'LISTEN issued');
    assert.deepEqual(connection.queries, ['LISTEN "stalefree_invalidation"']);
    connection.emit('notification', { payload: JSON.stringify({ tags: ['t'] }) });
    assert.deepEqual(seen, [{ tags: ['t'] }]);
    await bus.close();
  });

  test('malformed payloads and throwing subscribers go to onError; listening continues', async () => {
    const connection = new FakeConnection();
    const errors: unknown[] = [];
    const bus = new PostgresInvalidationBus({
      connect: queue(connection).factory,
      db: new FakeExecutor(),
      onError: (e) => errors.push(e),
    });
    const seen: InvalidationMessage[] = [];
    bus.subscribe(() => {
      throw new Error('bad subscriber');
    });
    bus.subscribe((m) => seen.push(m));
    bus.start();
    await until(() => connection.queries.length === 1, 'LISTEN issued');
    connection.emit('notification', { payload: 'not json' });
    assert.equal(errors.length, 1, 'malformed payload reported');
    connection.emit('notification', {}); // absent payload: same drop path
    assert.equal(errors.length, 2, 'missing payload reported');
    connection.emit('notification', { payload: JSON.stringify({ clear: true }) });
    assert.equal(errors.length, 3, 'throwing subscriber reported');
    assert.deepEqual(seen, [{ clear: true }], 'healthy subscriber still delivered');
    await bus.close();
  });

  test('reconnects after error/end and re-LISTENs; unsubscribe stops delivery', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    const errors: unknown[] = [];
    const bus = new PostgresInvalidationBus({
      connect: queue(first, second).factory,
      db: new FakeExecutor(),
      reconnectDelayMs: 5,
      onError: (e) => errors.push(e),
    });
    const seen: InvalidationMessage[] = [];
    const unsubscribe = bus.subscribe((m) => seen.push(m));
    bus.start();
    await until(() => first.queries.length === 1, 'first LISTEN');
    first.emit('error', new Error('connection reset'));
    await until(() => second.queries.length === 1, 're-LISTEN on a fresh client');
    second.emit('notification', { payload: JSON.stringify({ keys: ['k'] }) });
    assert.deepEqual(seen, [{ keys: ['k'] }]);
    unsubscribe();
    second.emit('notification', { payload: JSON.stringify({ keys: ['k2'] }) });
    assert.equal(seen.length, 1, 'unsubscribed');
    await bus.close();
  });

  test('a refused connect and a failed LISTEN both retry; failures reported', async () => {
    const refusing = new FakeConnection();
    refusing.failConnect = true;
    const broken = new FakeConnection();
    broken.failQuery = true;
    const healthy = new FakeConnection();
    const errors: unknown[] = [];
    const bus = new PostgresInvalidationBus({
      connect: queue(refusing, broken, healthy).factory,
      db: new FakeExecutor(),
      reconnectDelayMs: 5,
      onError: (e) => errors.push(e),
    });
    bus.start();
    await until(() => healthy.queries.length === 1, 'third attempt LISTENs');
    assert.equal(errors.length >= 2, true, 'both failures reported');
    await bus.close();
  });

  test('close() during the reconnect backoff cuts the sleep short', async () => {
    const refusing = new FakeConnection();
    refusing.failConnect = true;
    const spare = new FakeConnection();
    const errors: unknown[] = [];
    const bus = new PostgresInvalidationBus({
      connect: queue(refusing, spare).factory,
      db: new FakeExecutor(),
      reconnectDelayMs: 60_000, // only an aborted sleep exits fast
      onError: (e) => errors.push(e),
    });
    bus.start();
    await until(() => errors.length === 1, 'refused connect reported');
    const start = Date.now();
    await bus.close();
    assert.ok(Date.now() - start < 4_000, 'close must cut the 60s backoff');
    assert.equal(spare.connectCalls, 0, 'no reconnect after close');
  });

  test('close() during a hung connect resolves promptly (end-during-connect race)', async () => {
    const connection = new FakeConnection();
    connection.hangConnect = true;
    const bus = new PostgresInvalidationBus({
      connect: queue(connection).factory,
      db: new FakeExecutor(),
    });
    bus.start();
    await until(() => connection.connectCalls === 1, 'connect in flight');
    const start = Date.now();
    await bus.close();
    assert.ok(Date.now() - start < 4_000, 'close must not await the dead connect');
    assert.equal(connection.queries.length, 0, 'LISTEN never issued');
  });

  test('server-side clean end reconnects; failing cleanup is reported; close before start is safe', async () => {
    const first = new FakeConnection();
    first.failEnd = true;
    const second = new FakeConnection();
    const errors: unknown[] = [];
    const bus = new PostgresInvalidationBus({
      connect: queue(first, second).factory,
      db: new FakeExecutor(),
      reconnectDelayMs: 5,
      onError: (e) => errors.push(e),
    });
    bus.start();
    await until(() => first.queries.length === 1, 'first LISTEN');
    first.emit('end'); // clean server hang-up
    await until(() => second.queries.length === 1, 'reconnected');
    assert.ok(
      errors.some((e) => /end failed/.test(String((e as Error).message))),
      'cleanup failure reported',
    );
    await bus.close();

    const untouched = new PostgresInvalidationBus({
      connect: queue().factory,
      db: new FakeExecutor(),
    });
    await untouched.close(); // never started
  });
});
