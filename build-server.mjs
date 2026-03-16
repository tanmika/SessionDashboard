/**
 * esbuild script — compiles server + CLI TypeScript into lib/
 *
 * Produces:
 *   lib/server.js  — Express server bundle
 *   lib/cli.js     — CLI entry point (with shebang)
 *
 * better-sqlite3 is marked external (native C++ addon, cannot be bundled).
 */

import { build } from 'esbuild'

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: [
    'better-sqlite3',  // Native C++ addon
    'express',         // CJS package, keep as runtime dependency
    'ws',              // CJS package, keep as runtime dependency
  ],
}

// Server bundle
await build({
  ...commonOptions,
  entryPoints: ['server/index.ts'],
  outfile: 'lib/server.js',
})

// CLI bundle (with shebang for bin entry)
await build({
  ...commonOptions,
  entryPoints: ['bin/cli.ts'],
  outfile: 'lib/cli.js',
  banner: { js: '#!/usr/bin/env node' },
})

console.log('  ✓ lib/server.js')
console.log('  ✓ lib/cli.js')
