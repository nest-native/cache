import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const nodeExecutable = process.execPath;
const repoRoot = process.cwd();
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'stalefree-core-consumer-'),
);
const consumerRoot = path.join(tempRoot, 'consumer');
const npmCache = path.join(tempRoot, 'npm-cache');

try {
  fs.mkdirSync(consumerRoot);

  const tarballPath = packTarball();
  writeConsumerPackage(tarballPath);
  writeConsumerSmoke();

  execFileSync(
    npmExecutable,
    [
      'install',
      '--package-lock=false',
      '--no-audit',
      '--fund=false',
      '--ignore-scripts',
    ],
    {
      cwd: consumerRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_cache: npmCache,
      },
    },
  );
  execFileSync(nodeExecutable, ['smoke.cjs'], {
    cwd: consumerRoot,
    stdio: 'inherit',
  });

  console.log('Packed consumer validation OK.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function packTarball() {
  const rawOutput = execFileSync(
    npmExecutable,
    [
      'pack',
      '--json',
      '--workspace',
      '@stalefree/core',
      '--pack-destination',
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: npmCache,
      },
    },
  );
  const [packResult] = JSON.parse(rawOutput);

  if (!packResult?.filename) {
    throw new Error('npm pack did not produce a tarball filename.');
  }

  return path.join(tempRoot, packResult.filename);
}

function writeConsumerPackage(tarballPath) {
  // The core installs with zero third-party production dependencies — the whole
  // point of the empty `"dependencies": {}` contract.
  fs.writeFileSync(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'stalefree-core-packed-consumer',
        private: true,
        type: 'commonjs',
        dependencies: {
          '@stalefree/core': `file:${tarballPath}`,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeConsumerSmoke() {
  fs.writeFileSync(
    path.join(consumerRoot, 'smoke.cjs'),
    `'use strict';

const assert = require('node:assert/strict');
const core = require('@stalefree/core');
const packageJson = require('@stalefree/core/package.json');

// The main entry resolves and loads from the packed tarball with nothing but
// the tarball installed — importing '@stalefree/core' above already proves the
// core pulls NO drizzle-orm and NO pg by default.
assert.ok(core && typeof core === 'object', 'core entry point must load');

// As the engine lands, extend this smoke with the documented public surface
// (StalefreeCache, ...) and the store/bus subpath exports
// (./socket, ./postgres, ./sqlite, ./mysql), mirroring the lockout template.

// The published package declares zero runtime dependencies (consumers only pull
// the OPTIONAL drizzle-orm / pg peers if they use a store or bus subpath).
assert.equal(
  Object.keys(packageJson.dependencies ?? {}).length,
  0,
  'The packed package must not declare runtime dependencies.',
);
`,
  );
}
