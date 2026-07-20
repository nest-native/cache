import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InProcessInvalidationBus } from '@stalefree/core';
import {
  CACHE_OPTIONS,
  type CacheModuleOptions,
  CacheModule,
  CacheService,
  STALEFREE_CACHE,
  VERSION,
} from '../index';

describe('CacheModule.forRoot', () => {
  it('provides a CacheService wired to the engine (wrap, tags, invalidation)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ defaultTtlMs: 60_000 })],
    }).compile();

    const service = moduleRef.get(CacheService);
    let loads = 0;
    const load = () => {
      loads += 1;
      return 'value';
    };
    assert.equal(await service.wrap('k', load, { tags: ['t'] }), 'value');
    assert.equal(await service.wrap('k', load), 'value');
    assert.equal(loads, 1, 'second wrap is a hit');
    await service.invalidateTags(['t']);
    assert.equal(await service.get('k'), undefined);
    await service.set('k2', 42);
    assert.equal(await service.get('k2'), 42);
    await service.delete('k2');
    assert.equal(await service.get('k2'), undefined);

    assert.ok(moduleRef.get(STALEFREE_CACHE));
    assert.ok(moduleRef.get(CACHE_OPTIONS));
    await moduleRef.close(); // exercises onApplicationShutdown → cache.close()
  });

  it('shutdown detaches the cache from the bus', async () => {
    const bus = new InProcessInvalidationBus();
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ defaultTtlMs: 60_000, bus })],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const service = app.get(CacheService);
    await service.set('k', 'v');
    await app.close(); // shutdown hook runs
    bus.publish({ keys: ['k'] }); // must not reach the closed cache (no throw)
  });
});

describe('CacheModule.forRootAsync', () => {
  it('accepts a factory with a TYPED injected parameter (the lockout lesson)', async () => {
    // This test only COMPILES if useFactory is `(...args: any[])` — a typed
    // factory param fed by `inject` is not assignable to `unknown[]` under
    // strictFunctionTypes.
    const TTL = 'TTL_TOKEN';

    @Module({
      providers: [{ provide: TTL, useValue: 30_000 }],
      exports: [TTL],
    })
    class TtlModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        CacheModule.forRootAsync({
          imports: [TtlModule],
          inject: [TTL],
          useFactory: (ttl: number): CacheModuleOptions => ({
            defaultTtlMs: ttl,
          }),
        }),
      ],
    }).compile();

    const service = moduleRef.get(CacheService);
    await service.set('k', 'async-built');
    assert.equal(await service.get('k'), 'async-built');
    await moduleRef.close();
  });

  it('resolves CacheService from a consuming module (global default + full exports)', async () => {
    @Module({})
    class FeatureModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        CacheModule.forRootAsync({ useFactory: () => ({ defaultTtlMs: 1_000 }) }),
        FeatureModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init(); // would throw here if exports/global wiring were wrong
    assert.ok(app.get(CacheService));
    await app.close();
  });
});

describe('VERSION', () => {
  it('exports a semver-shaped string', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  });
});
