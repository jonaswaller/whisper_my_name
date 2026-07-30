/**
 * Bundle the Electron main and preload processes.
 *
 * Electron cannot execute TypeScript, and the agent modules import each other
 * with .ts paths so tsx can run them directly from the CLI harness. esbuild
 * reconciles both: one bundle per process, sources unchanged.
 *
 * The renderer needs no build — it is plain HTML/JS, copied as-is.
 */

import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs', // Electron's main process loads CJS
  sourcemap: true,
  // Electron provides these at runtime; bundling them would break native bits.
  external: ['electron'],
  logLevel: 'info',
};

await mkdir('dist/renderer', { recursive: true });

// .cjs, not .js: package.json declares "type": "module", so a .js bundle would
// be loaded as ESM and every require() in it would throw.
await build({
  ...shared,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.cjs',
});

await build({
  ...shared,
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist/main/preload.cjs',
});

await cp('src/renderer', 'dist/renderer', { recursive: true });
console.log('built -> dist/');
