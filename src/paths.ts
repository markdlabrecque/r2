import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nearest ancestor of the module at `fromUrl` that holds a package.json. It is the same
 * directory for `src/*.ts` (dev, tests) and `dist/server/main.js` (built), and does not
 * depend on the process working directory.
 */
export function findPackageRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot locate the R2 installation directory.');
    dir = parent;
  }
}

export const packageRoot = (): string => findPackageRoot(import.meta.url);
/**
 * SQL migrations ship with the installation, at a path independent of the working directory:
 * a copy beside the built server when present (`dist/server/migrations`), else the source
 * directory in the package root.
 */
export function defaultMigrationsDir(): string {
  const beside = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
  return existsSync(beside) ? beside : join(packageRoot(), 'migrations');
}
/** Built web assets (`npm run build`). */
export const defaultWebRoot = (): string => join(packageRoot(), 'dist', 'web');
