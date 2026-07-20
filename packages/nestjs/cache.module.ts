import {
  type DynamicModule,
  Module,
  type OnApplicationShutdown,
  Inject,
  type Provider,
} from '@nestjs/common';
import { StalefreeCache } from '@stalefree/core';
import { CacheService } from './cache.service';
import type { CacheModuleAsyncOptions, CacheModuleOptions } from './interfaces';
import { CACHE_OPTIONS, STALEFREE_CACHE } from './tokens';

/**
 * Wires `@stalefree/core` into NestJS DI. Register once with your policy (and
 * optionally an L2 store + an invalidation bus), then inject
 * {@link CacheService} anywhere.
 *
 * ```ts
 * CacheModule.forRoot({ defaultTtlMs: 30_000 });
 * ```
 *
 * The module closes the CACHE on shutdown (detaching it from the bus); the
 * bus and store belong to the application — close the bus where you built it.
 */
@Module({})
export class CacheModule implements OnApplicationShutdown {
  constructor(
    @Inject(STALEFREE_CACHE) private readonly cache: StalefreeCache,
  ) {}

  onApplicationShutdown(): void {
    this.cache.close();
  }

  static forRoot(options: CacheModuleOptions): DynamicModule {
    return assemble(options.isGlobal ?? true, [], [
      { provide: CACHE_OPTIONS, useValue: options },
    ]);
  }

  static forRootAsync(options: CacheModuleAsyncOptions): DynamicModule {
    return assemble(options.isGlobal ?? true, options.imports ?? [], [
      {
        provide: CACHE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
    ]);
  }
}

function assemble(
  global: boolean,
  imports: NonNullable<DynamicModule['imports']>,
  optionProviders: Provider[],
): DynamicModule {
  return {
    module: CacheModule,
    global,
    imports,
    providers: [
      ...optionProviders,
      {
        provide: STALEFREE_CACHE,
        useFactory: (resolved: CacheModuleOptions) =>
          new StalefreeCache(resolved),
        inject: [CACHE_OPTIONS],
      },
      CacheService,
    ],
    // Everything is exported so providers of consuming modules (guards,
    // interceptors, other factories) resolve — the lockout LOCKOUT_OPTIONS
    // lesson: an unexported dependency fails DI only at bootstrap, in
    // someone else's module.
    exports: [CacheService, STALEFREE_CACHE, CACHE_OPTIONS],
  };
}
