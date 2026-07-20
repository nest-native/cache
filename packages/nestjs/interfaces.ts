import type { StalefreeCacheOptions } from '@stalefree/core';
import type { ModuleMetadata, Type } from '@nestjs/common';

/**
 * Options for {@link CacheModule.forRoot} — everything `StalefreeCache` takes
 * (L1 size, optional store/bus, defaultTtlMs, onError, clock), plus module
 * scope.
 */
export interface CacheModuleOptions extends StalefreeCacheOptions {
  /** Register as a global module so `CacheService` resolves app-wide. Default `true`. */
  isGlobal?: boolean;
}

/** Options for {@link CacheModule.forRootAsync}. */
export interface CacheModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  // `any[]` (not `unknown[]`) mirrors NestJS's own `FactoryProvider.useFactory`:
  // under `strictFunctionTypes` a factory declared with typed injected params —
  // the common case, e.g. `(db: MyDatabase) => (...)` fed by `inject` — is NOT
  // assignable to `(...args: unknown[]) => ...`. The lockout 0.3.1 lesson,
  // baked in from day one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (
    ...args: any[]
  ) => CacheModuleOptions | Promise<CacheModuleOptions>;
  inject?: Array<Type<unknown> | string | symbol>;
  isGlobal?: boolean;
}
