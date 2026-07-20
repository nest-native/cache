import { Inject, Injectable } from '@nestjs/common';
import type { SetOptions, StalefreeCache } from '@stalefree/core';
import { STALEFREE_CACHE } from './tokens';

/**
 * The injectable pass-through over the `StalefreeCache` engine. All policy
 * (TTL backstop, single-flight, tag eviction, fail-open) lives in
 * `@stalefree/core` — this service only carries the engine through NestJS DI.
 */
@Injectable()
export class CacheService {
  constructor(
    @Inject(STALEFREE_CACHE) private readonly cache: StalefreeCache,
  ) {}

  get<T>(key: string): Promise<T | undefined> {
    return this.cache.get<T>(key);
  }

  set<T>(key: string, value: T, options?: SetOptions): Promise<void> {
    return this.cache.set(key, value, options);
  }

  delete(key: string): Promise<void> {
    return this.cache.delete(key);
  }

  invalidateTags(tags: readonly string[]): Promise<void> {
    return this.cache.invalidateTags(tags);
  }

  wrap<T>(
    key: string,
    loader: () => Promise<T> | T,
    options?: SetOptions,
  ): Promise<T> {
    return this.cache.wrap(key, loader, options);
  }
}
