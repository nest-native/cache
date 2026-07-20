# @nest-native/cache

<p align="center">A thin NestJS adapter over <a href="https://www.npmjs.com/package/@stalefree/core"><code>@stalefree/core</code></a> — tag-based cache invalidation through the database you already have. No Redis.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nest-native/cache"><img src="https://img.shields.io/npm/v/@nest-native/cache.svg" alt="NPM Version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="Package License" /></a>
</p>

## Usage

```bash
npm install @nest-native/cache @stalefree/core
```

```ts
import { Module } from '@nestjs/common';
import { CacheModule } from '@nest-native/cache';

@Module({
  imports: [
    CacheModule.forRoot({ defaultTtlMs: 30_000 }),
  ],
})
export class AppModule {}
```

Then inject the service (by explicit token if your toolchain is esbuild/tsx —
they emit no `design:paramtypes`):

```ts
import { CacheService } from '@nest-native/cache';

@Injectable()
export class ProjectsService {
  constructor(@Inject(CacheService) private readonly cache: CacheService) {}

  getProject(orgId: number, id: number) {
    return this.cache.wrap(
      `org:${orgId}:project:${id}`,
      () => this.repo.findById(id),
      { tags: [`org:${orgId}`, `project:${id}`] },
    );
  }

  async renameProject(orgId: number, id: number, name: string) {
    await this.repo.rename(id, name);
    await this.cache.invalidateTags([`project:${id}`]);
  }
}
```

## Cross-instance coherence

Build a bus from `@stalefree/core`'s subpaths and hand it to `forRootAsync` —
a unix-socket mesh for same-machine processes, Postgres `LISTEN`/`NOTIFY`
across machines (with **transactional invalidation**: `publishInTx` rides your
business transaction — delivered on commit, dropped on rollback). Every entry
carries a TTL as the delivery backstop: a lost bus message means stale *until
TTL*, never stale *forever*. See the
[core README](https://www.npmjs.com/package/@stalefree/core) for the recipes.

```ts
CacheModule.forRootAsync({
  inject: [getDrizzleClientToken()],
  useFactory: (db: AppDatabase) => ({
    defaultTtlMs: 30_000,
    store: new PostgresCacheStore(db, cacheTable), // optional shared L2
    bus,                                           // built at bootstrap
  }),
}),
```

`useFactory` is typed `(...args: any[])` — a factory with typed injected
parameters assigns directly (no widening dance), matching NestJS's own
`FactoryProvider`.

## Relationship to `@stalefree/core`

This package is a thin DI shell: `CacheModule.forRoot/forRootAsync`,
`CacheService`, and a shutdown hook that detaches the cache from the bus. All
the caching logic — the L1 LRU + tag index, `wrap` single-flight, TTL policy,
fail-open — lives in the framework-agnostic core, usable from Express or any
other framework. Supports **NestJS 10, 11, and 12** (stable primitives only).

MIT licensed. Part of the [nest-native](https://github.com/nest-native) family.
Not affiliated with the NestJS core team.
