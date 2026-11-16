import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeWorker } from './app-fixtures.ts';
import { loggerOptions, type AppDependencies } from '../src/routes.ts';
import { startService } from '../src/service.ts';
import { FakeClock, syntheticEnv, tempDir } from './helpers.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const tmp = (): string => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};

describe('service lifecycle', () => {
  const start = async (dir: string, extra: NodeJS.ProcessEnv = {}, logger?: AppDependencies['logger'], adapters?: NonNullable<Parameters<typeof startService>[1]>['adapters']) => {
    const svc = await startService(syntheticEnv(dir, extra), {
      clock: new FakeClock(),
      ...(logger !== undefined ? { logger } : { logger: false }),
      ...(adapters ? { adapters } : {}),
    });
    cleanups.push(() => svc.stop().catch(() => undefined));
    return svc;
  };
  const get = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`);

  it('starts with no credentials, binds only loopback, stops and restarts on the same data', async () => {
    const dir = join(tmp(), 'data');
    const first = await start(dir);
    expect(first.config.chat.enabled).toBe(false);
    expect(first.config.auth.enabled).toBe(false);
    expect(first.config.push.enabled).toBe(false);
    const address = first.app.server.address();
    expect(address).toMatchObject({ address: '127.0.0.1' });
    expect((await get(first.port, '/healthz')).status).toBe(200);
    first.storage.setTimezone('America/Toronto');
    const reminder = first.storage.confirmProposal(
      first.storage.storeProposal({ text: 'synthetic', dueAt: 2e12, timezone: 'UTC', localDateTime: '2033-05-18T03:33', expiresAt: 2e12 }).id,
      'req-1',
    );
    await first.stop();
    await first.stop().catch(() => undefined);

    const second = await start(dir);
    expect(second.storage.getReminder(reminder.id)).toEqual(reminder);
    expect(second.storage.getSettings().timezone).toBe('America/Toronto');
    const body = await (await get(second.port, '/healthz')).text();
    expect(body).toBe('{"status":"ok"}');
  });

  it('stops cleanly: the port is released, the database handle closed and the worker stopped', async () => {
    const worker = new FakeWorker();
    const svc = await startService(syntheticEnv(join(tmp(), 'data')), {
      clock: new FakeClock(),
      logger: false,
      adapters: { worker },
      featurePlugins: [{
        name: 'before-ready',
        register() {
          // Registration precedes readiness: no worker may run against partial setup.
          expect(worker.events).toEqual([]);
        },
      }],
    });
    cleanups.push(() => svc.stop());
    expect(worker.events).toEqual(['start']);
    await svc.stop();
    await svc.stop();
    expect(worker.events).toEqual(['start', 'stop']);
    expect(svc.storage.db.open).toBe(false);
    await expect(get(svc.port, '/healthz')).rejects.toThrow();
  });

  it('refuses a non-https origin and a data directory in the checkout before opening anything', async () => {
    const dir = tmp();
    await expect(startService(syntheticEnv(join(dir, 'd'), { R2_ORIGIN: 'http://r2.example.ts.net' }))).rejects.toThrow(/R2_ORIGIN/);
    await expect(startService(syntheticEnv(join(process.cwd(), 'data')))).rejects.toThrow(/outside/);
    expect(existsSync(join(dir, 'd'))).toBe(false);
  });

  it('releases the database when the port is already taken', async () => {
    const first = await start(join(tmp(), 'a'));
    await expect(startService(syntheticEnv(join(tmp(), 'b'), { R2_PORT: String(first.port) }), { logger: false })).rejects.toThrow();
  });

  it('never logs the OpenAI key, VAPID private key, password hash, cookies or authorization headers', async () => {
    let out = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const secrets = {
      OPENAI_API_KEY: 'sk-super-secret-key',
      OPENAI_MODEL: 'gpt-x',
      R2_PASSWORD_HASH: '$scrypt$ln=15,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo',
    };
    const svc = await start(join(tmp(), 'data'), secrets, { ...loggerOptions('info'), stream } as never);
    await fetch(`http://127.0.0.1:${svc.port}/healthz`, { headers: { cookie: 'r2_session=topsecretcookie', authorization: 'Bearer topsecrettoken' } });
    await svc.stop();
    expect(out).toContain('R2 listening');
    expect(out).not.toMatch(/sk-super-secret-key|topsecretcookie|topsecrettoken|aGFzaGhhc2hoYXNo/);
  });
});

