import fs from 'node:fs';
import path from 'node:path';

// The one cold-consumer smoke. release:check:consumer runs it against the
// tarball `npm pack` builds from this checkout, release:check:published
// against the version on the registry; `origin` ('packed' or 'published')
// only names which install a failure came from.
export function writeConsumerSmoke(consumerRoot, { packageName, origin }) {
  fs.writeFileSync(
    path.join(consumerRoot, 'smoke.cjs'),
    `'use strict';

const assert = require('node:assert/strict');
const core = require('${packageName}');
const packageJson = require('${packageName}/package.json');

// The main entry resolves and loads with nothing but this package installed —
// importing '${packageName}' above already proves the core pulls NO
// drizzle-orm and NO pg by default.
assert.ok(core && typeof core === 'object', 'core entry point must load');

// As the engine lands, extend this smoke with the documented public surface
// (StalefreeCache, ...) and the store/bus subpath exports
// (./socket, ./postgres, ./sqlite, ./mysql), mirroring the lockout template.

// The published package declares zero runtime dependencies (consumers only pull
// the OPTIONAL drizzle-orm / pg peers if they use a store or bus subpath).
assert.equal(
  Object.keys(packageJson.dependencies ?? {}).length,
  0,
  'The ${origin} package must not declare runtime dependencies.',
);
`,
  );
}
