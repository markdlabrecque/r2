import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const path = (p) => new URL(p, root).pathname;

rmSync(path('dist'), { recursive: true, force: true });

// Server: dist/server/main.js, with the SQL migrations beside it.
await build({
  entryPoints: [path('src/main.ts')],
  outfile: path('dist/server/main.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});
cpSync(path('migrations'), path('dist/server/migrations'), { recursive: true });

// Web: dist/web. /sw.js is reserved at the root for the later service worker.
mkdirSync(path('dist/web'), { recursive: true });
await build({
  entryPoints: [path('web/app.ts')],
  outfile: path('dist/web/app.js'),
  bundle: true,
  platform: 'browser',
  target: 'es2023',
  format: 'esm',
  sourcemap: true,
});
cpSync(path('web/index.html'), path('dist/web/index.html'));
cpSync(path('web/styles.css'), path('dist/web/styles.css'));
