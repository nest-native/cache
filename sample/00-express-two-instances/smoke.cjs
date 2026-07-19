// The acceptance test: instance A caches a read; instance B mutates and
// invalidates; instance A's next read is fresh — cross-process coherence with
// no broker, no Redis, no NestJS.
const { spawn } = require('node:child_process');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const dir = mkdtempSync(join(tmpdir(), 'stalefree-demo-'));
const busPath = join(dir, 'bus.sock');
const dataFile = join(dir, 'data.json');
writeFileSync(dataFile, JSON.stringify({ value: 'v0' }));

const PORT_A = 34871;
const PORT_B = 34872;
const children = [];

function start(port) {
  const child = spawn(
    process.execPath,
    [join(__dirname, 'server.cjs'), String(port), busPath, dataFile],
    { stdio: 'inherit' },
  );
  children.push(child);
}

async function waitReady(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`instance on ${port} never became ready`);
}

async function getValue(port) {
  const response = await fetch(`http://127.0.0.1:${port}/value`);
  return response.json();
}

async function main() {
  start(PORT_A);
  start(PORT_B);
  await waitReady(PORT_A);
  await waitReady(PORT_B);

  // 1. A loads and caches.
  const first = await getValue(PORT_A);
  if (first.value !== 'v0' || first.loads !== 1) {
    throw new Error(`step 1 failed: ${JSON.stringify(first)}`);
  }
  // 2. A hits its L1 (no new load).
  const second = await getValue(PORT_A);
  if (second.value !== 'v0' || second.loads !== 1) {
    throw new Error(`step 2 (cache hit) failed: ${JSON.stringify(second)}`);
  }
  // 3+4. B mutates + invalidates; A must serve the fresh value. The mutation
  // is RETRIED because the mesh may still be attaching in the first couple
  // hundred milliseconds after boot — an invalidation published before the
  // bus attaches is dropped by design (the TTL backstop covers that window in
  // production; a subsequent mutation invalidates normally).
  const deadline = Date.now() + 8_000;
  let third = await getValue(PORT_A);
  while (third.value !== 'v1' && Date.now() < deadline) {
    await fetch(`http://127.0.0.1:${PORT_B}/value`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'v1' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    third = await getValue(PORT_A);
  }
  if (third.value !== 'v1') {
    throw new Error(`cross-process invalidation failed: ${JSON.stringify(third)}`);
  }
  console.log('SMOKE PASS: cached, hit, invalidated across processes, reloaded fresh');
}

main()
  .then(() => cleanup(0))
  .catch((error) => {
    console.error(error);
    cleanup(1);
  });

function cleanup(code) {
  for (const child of children) child.kill('SIGKILL');
  process.exit(code);
}
