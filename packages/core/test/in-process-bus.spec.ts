import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { InProcessInvalidationBus } from '../in-process-bus';
import type { InvalidationMessage } from '../interfaces';

describe('InProcessInvalidationBus', () => {
  test('delivers each publish to every subscriber', () => {
    const bus = new InProcessInvalidationBus();
    const seenA: InvalidationMessage[] = [];
    const seenB: InvalidationMessage[] = [];
    bus.subscribe((m) => seenA.push(m));
    bus.subscribe((m) => seenB.push(m));
    bus.publish({ tags: ['t1'] });
    assert.deepEqual(seenA, [{ tags: ['t1'] }]);
    assert.deepEqual(seenB, [{ tags: ['t1'] }]);
  });

  test('a throwing subscriber never breaks publish or its peers', () => {
    const bus = new InProcessInvalidationBus();
    const seen: InvalidationMessage[] = [];
    bus.subscribe(() => {
      throw new Error('bad subscriber');
    });
    bus.subscribe((m) => seen.push(m));
    bus.publish({ clear: true }); // must not throw
    assert.deepEqual(seen, [{ clear: true }]);
  });

  test('unsubscribe stops delivery; close drops everyone', () => {
    const bus = new InProcessInvalidationBus();
    const seen: InvalidationMessage[] = [];
    const unsubscribe = bus.subscribe((m) => seen.push(m));
    unsubscribe();
    bus.publish({ tags: ['t'] });
    // Typed expected: a bare [] would narrow `seen` to never[] via the assert signature.
    assert.deepEqual(seen, [] as InvalidationMessage[]);

    bus.subscribe((m) => seen.push(m));
    bus.close();
    bus.publish({ tags: ['t'] });
    assert.deepEqual(seen, [], 'close cleared all subscribers');
  });
});
