// Keys and tags travel through bus payloads, SQL rows, and log lines — an
// allow-list keeps every transport simple and injection-proof. Values are the
// application's business; keys/tags are OURS to constrain.
const KEY_PATTERN = /^[A-Za-z0-9_:.-]+$/;
const MAX_KEY_LENGTH = 256;
const MAX_TAG_LENGTH = 128;

export function assertValidKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    !KEY_PATTERN.test(key)
  ) {
    throw new Error(
      `invalid cache key ${JSON.stringify(key)}: must match ${String(KEY_PATTERN)} and be 1-${MAX_KEY_LENGTH} characters`,
    );
  }
}

export function assertValidTags(tags: readonly string[]): void {
  for (const tag of tags) {
    if (
      typeof tag !== 'string' ||
      tag.length === 0 ||
      tag.length > MAX_TAG_LENGTH ||
      !KEY_PATTERN.test(tag)
    ) {
      throw new Error(
        `invalid cache tag ${JSON.stringify(tag)}: must match ${String(KEY_PATTERN)} and be 1-${MAX_TAG_LENGTH} characters`,
      );
    }
  }
}

/**
 * TTL must be a finite number of milliseconds > 0. Infinite (or absent) TTLs
 * are rejected BY DESIGN: the bus is best-effort, so the TTL is the delivery
 * backstop — an entry that never expires could stay stale forever after one
 * lost invalidation message, and a cache whose correctness depends on a bus
 * message arriving is a design bug (see GUIDELINES_NEST_CACHE.md).
 */
export function assertValidTtl(ttlMs: unknown): asserts ttlMs is number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(
      `invalid ttlMs ${String(ttlMs)}: a finite number of milliseconds > 0 is required ` +
        '(pass it per call or set defaultTtlMs on the cache — infinite entries are not supported)',
    );
  }
}
