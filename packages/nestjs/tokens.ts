// DI tokens for @nest-native/cache.

/** The resolved {@link CacheModuleOptions}. */
export const CACHE_OPTIONS = Symbol.for('@nest-native/cache:options');

/** The underlying `StalefreeCache` engine instance. */
export const STALEFREE_CACHE = Symbol.for('@nest-native/cache:engine');
