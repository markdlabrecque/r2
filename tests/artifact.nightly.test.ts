import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from './helpers.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const tmp = (): string => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};

describe('built service', () => {
  const root = join(import.meta.dirname, '..');
  beforeAll(() => {
    for (const artifact of ['server/main.js', 'server/migrations/001.sql', 'web/index.html', 'web/app.js', 'web/sw.js', 'web/styles.css']) {
      if (!existsSync(join(root, 'dist', artifact))) throw new Error(`Missing dist/${artifact}; run npm run build before npm run test:smoke.`);
    }
  });

  const run = (dataDir: string, port: number) =>
    new Promise<{ stop(): Promise<number | null>; stdout: () => string }>((resolve, reject) => {
      let out = '';
      const child = spawn(process.execPath, [join(root, 'dist/server/main.js')], {
        cwd: tmp(), // deliberately not the checkout: nothing may depend on the working directory
        env: { PATH: process.env.PATH ?? '', R2_ORIGIN: 'https://r2.example.ts.net', R2_DATA_DIR: dataDir, R2_PORT: String(port) },
      });
      // Register teardown before any startup/assertion can fail. This legacy poller
      // still uses a random fixed port and belongs nightly, not on commits/PRs.
      const exited = new Promise<void>((done) => child.once('close', () => done()));
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      });
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`exited early (${code}): ${out}`)));
      const deadline = setTimeout(() => reject(new Error(`built service startup timed out: ${out}`)), 10_000);
      cleanups.push(() => clearTimeout(deadline));
      const timer = setInterval(async () => {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) {
            clearInterval(timer);
            clearTimeout(deadline);
            child.removeAllListeners('exit');
            resolve({
              stdout: () => out,
              stop: () =>
                new Promise((res) => {
                  child.once('exit', (code) => res(code));
                  child.kill('SIGTERM');
                }),
            });
          }
        } catch {
          // not listening yet
        }
      }, 50);
      cleanups.push(() => clearInterval(timer));
    });

  it('runs from dist in another cwd with fresh migrations, serves health and web assets, and exits on SIGTERM', async () => {
    const dataDir = join(tmp(), 'data');
    const port = 20000 + Math.floor(Math.random() * 20000);
    const first = await run(dataDir, port);
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).toEqual({ status: 'ok' });
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<script type="module" src="/app.js">');
    expect(html).toContain('id="login"');
    expect((await fetch(`http://127.0.0.1:${port}/app.js`)).status).toBe(200);
    const sw = await fetch(`http://127.0.0.1:${port}/sw.js`);
    expect(sw.status).toBe(200);
    expect(await sw.text()).toContain('You have an R2 reminder');
    expect(await first.stop()).toBe(0);

  }, 30000);
});
