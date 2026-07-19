// One instance of the demo app: a bare-Express server (NO @nestjs/* anywhere —
// this sample is the neutrality acceptance test for the framework-agnostic
// core). The "database" is a JSON file both instances share; the cache sits in
// front of it, and the socket bus keeps both instances' L1s coherent.
const { readFileSync, writeFileSync } = require('node:fs');
const express = require('express');
const { StalefreeCache } = require('@stalefree/core');
const { SocketInvalidationBus } = require('@stalefree/core/socket');

const [, , portArg, busPath, dataFile] = process.argv;
const port = Number(portArg);

let loads = 0; // proves caching: the loader only runs on a genuine miss

async function main() {
  const bus = new SocketInvalidationBus({ path: busPath, reconnectDelayMs: 200 });
  await bus.start();
  const cache = new StalefreeCache({ bus, defaultTtlMs: 60_000 });

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/value', async (_req, res) => {
    const value = await cache.wrap(
      'demo:value',
      () => {
        loads += 1;
        return JSON.parse(readFileSync(dataFile, 'utf8')).value;
      },
      { tags: ['demo'] },
    );
    res.json({ value, loads });
  });

  app.post('/value', async (req, res) => {
    writeFileSync(dataFile, JSON.stringify({ value: req.body.value }));
    // The write and the invalidation: every instance's next read reloads.
    await cache.invalidateTags(['demo']);
    res.json({ ok: true });
  });

  app.listen(port, '127.0.0.1', () => {
    console.log(`instance ready on ${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
