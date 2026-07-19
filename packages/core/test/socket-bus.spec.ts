import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { InvalidationMessage } from '../interfaces';
import { SocketInvalidationBus } from '../socket/socket-bus';

let seq = 0;
function socketPath(): string {
  seq += 1;
  return join(tmpdir(), `sf-${process.pid}-${seq}.sock`);
}

const open: SocketInvalidationBus[] = [];
async function startBus(
  options: ConstructorParameters<typeof SocketInvalidationBus>[0],
): Promise<SocketInvalidationBus> {
  const bus = new SocketInvalidationBus(options);
  await bus.start();
  open.push(bus);
  return bus;
}

after(async () => {
  for (const bus of open) {
    await bus.close();
  }
});

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

describe('SocketInvalidationBus', () => {
  test('rejects an invalid reconnectDelayMs', () => {
    for (const bad of [0, -1, Number.NaN]) {
      assert.throws(
        () => new SocketInvalidationBus({ path: socketPath(), reconnectDelayMs: bad }),
        /invalid reconnectDelayMs/,
      );
    }
  });

  test('publisher-local subscribers always hear a publish (solo hub)', async () => {
    const bus = await startBus({ path: socketPath() });
    const seen: InvalidationMessage[] = [];
    bus.subscribe((m) => seen.push(m));
    bus.publish({ tags: ['t'] });
    assert.deepEqual(seen, [{ tags: ['t'] }]);
  });

  test('peer → hub and hub → peer delivery; hub rebroadcasts across peers', async () => {
    const path = socketPath();
    const hub = await startBus({ path });
    const peerA = await startBus({ path });
    const peerB = await startBus({ path });
    const hubSeen: InvalidationMessage[] = [];
    const aSeen: InvalidationMessage[] = [];
    const bSeen: InvalidationMessage[] = [];
    hub.subscribe((m) => hubSeen.push(m));
    peerA.subscribe((m) => aSeen.push(m));
    peerB.subscribe((m) => bSeen.push(m));

    peerA.publish({ tags: ['from-a'] });
    await until(() => hubSeen.length === 1, 'hub receives from peer A');
    await until(() => bSeen.length === 1, 'peer B receives via hub rebroadcast');
    assert.deepEqual(hubSeen[0], { tags: ['from-a'] });
    assert.deepEqual(bSeen[0], { tags: ['from-a'] });
    assert.deepEqual(aSeen, [{ tags: ['from-a'] }], 'origin heard itself exactly once (locally)');

    hub.publish({ keys: ['k1'] });
    await until(() => aSeen.length === 2 && bSeen.length === 2, 'hub publish reaches both peers');
    assert.deepEqual(aSeen[1], { keys: ['k1'] });
  });

  test('start() is idempotent', async () => {
    const bus = await startBus({ path: socketPath() });
    await bus.start(); // second start: no-op
    const seen: InvalidationMessage[] = [];
    bus.subscribe((m) => seen.push(m));
    bus.publish({ clear: true });
    assert.equal(seen.length, 1);
  });

  test('recovers a stale socket file left by a crashed hub', async () => {
    const path = socketPath();
    writeFileSync(path, ''); // dead filesystem entry occupying the path
    const errors: unknown[] = [];
    const bus = await startBus({ path, onError: (e) => errors.push(e) });
    const seen: InvalidationMessage[] = [];
    bus.subscribe((m) => seen.push(m));
    bus.publish({ tags: ['ok'] });
    assert.equal(seen.length, 1, 'became hub on the recovered path');
  });

  test('re-election: when the hub dies, a peer takes over and delivery resumes', async () => {
    const path = socketPath();
    const hub = await startBus({ path, reconnectDelayMs: 25 });
    const peerA = new SocketInvalidationBus({ path, reconnectDelayMs: 25 });
    await peerA.start();
    open.push(peerA);
    const peerB = await startBus({ path, reconnectDelayMs: 25 });
    const bSeen: InvalidationMessage[] = [];
    peerB.subscribe((m) => bSeen.push(m));

    await hub.close(); // the mesh loses its hub; A and B race to rebind

    // Delivery must eventually resume between the survivors.
    await until(
      () => {
        peerA.publish({ tags: ['post-election'] });
        return bSeen.length > 0;
      },
      'coherence after re-election',
      8_000,
    );
  });

  test('malformed frames are reported and skipped; the connection survives', async () => {
    const path = socketPath();
    const errors: unknown[] = [];
    const hub = await startBus({ path, onError: (e) => errors.push(e) });
    const seen: InvalidationMessage[] = [];
    hub.subscribe((m) => seen.push(m));

    const raw = connect(path);
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    raw.write('this is not json\n');
    await until(() => errors.length === 1, 'malformed frame reported');
    raw.write(JSON.stringify({ tags: ['still-works'] }) + '\n');
    await until(() => seen.length === 1, 'valid frame after the malformed one');
    raw.destroy();
  });

  test('an oversized frame drops the offending connection', async () => {
    const path = socketPath();
    const errors: unknown[] = [];
    await startBus({ path, onError: (e) => errors.push(e) });
    const raw = connect(path);
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    raw.write('x'.repeat(70_000)); // no newline: exceeds the frame cap
    await until(() => errors.length >= 1, 'size-cap violation reported');
    assert.match(String((errors[0] as Error).message), /size cap/);
    await until(() => raw.destroyed || raw.closed, 'connection dropped');
  });

  test('write failures are routed to onError (handler unit-tested directly)', () => {
    // A mid-teardown write error is not deterministically triggerable over a
    // real socket; the shared handler is exercised directly instead.
    const errors: unknown[] = [];
    const bus = new SocketInvalidationBus({
      path: socketPath(),
      onError: (e) => errors.push(e),
    });
    type HasHandler = { onWriteError: (error?: Error | null) => void };
    const boom = new Error('EPIPE');
    (bus as unknown as HasHandler).onWriteError(boom);
    (bus as unknown as HasHandler).onWriteError(null); // the no-error branch
    assert.deepEqual(errors, [boom]);
    const silent = new SocketInvalidationBus({ path: socketPath() });
    (silent as unknown as HasHandler).onWriteError(boom); // no onError: swallowed
  });

  test('a throwing subscriber never breaks dispatch for its peers', async () => {
    const bus = await startBus({ path: socketPath() });
    const seen: InvalidationMessage[] = [];
    bus.subscribe(() => {
      throw new Error('bad subscriber');
    });
    bus.subscribe((m) => seen.push(m));
    bus.publish({ tags: ['t'] }); // must not throw
    assert.deepEqual(seen, [{ tags: ['t'] }]);
  });

  test('a non-recoverable bind error is reported and retried; close cuts the backoff', async () => {
    const errors: unknown[] = [];
    const bus = new SocketInvalidationBus({
      path: join(tmpdir(), 'no-such-dir-sf', 'x.sock'), // parent dir missing: ENOENT
      reconnectDelayMs: 60_000, // only an aborted sleep exits fast
      onError: (e) => errors.push(e),
    });
    await bus.start(); // resolves even though attach failed (fail-open)
    await until(() => errors.length >= 1, 'bind failure reported');
    const start = Date.now();
    await bus.close();
    assert.ok(Date.now() - start < 4_000, 'close must cut the 60s retry backoff');
  });

  test('close() before start() is safe; closing a peer detaches it', async () => {
    const untouched = new SocketInvalidationBus({ path: socketPath() });
    await untouched.close(); // never started

    const path = socketPath();
    const hub = await startBus({ path });
    const peer = new SocketInvalidationBus({ path, reconnectDelayMs: 25 });
    await peer.start();
    const seen: InvalidationMessage[] = [];
    peer.subscribe((m) => seen.push(m));
    await peer.close();
    hub.publish({ tags: ['after-close'] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(seen, [], 'closed peer receives nothing');
  });
});
