/**
 * The package is ESM ("type": "module"), but the server is compiled to
 * CommonJS. Node decides per-directory, so drop a marker next to the compiled
 * output telling it those .js files are CommonJS.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('dist/node', { recursive: true });
writeFileSync('dist/node/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
console.log('[build] marked dist/node as commonjs');
