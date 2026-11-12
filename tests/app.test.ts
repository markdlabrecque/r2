import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { ModelInterpreter, PushTransport, Worker, WorkerHealth } from '../src/contracts.ts';
import { openStorage, type SqliteStorage } from '../src/db.ts';
import { BODY_LIMIT_BYTES, createApp, loggerOptions, type AppDependencies, type FeaturePlugin } from '../src/routes.ts';
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

function build(opts: { plugins?: FeaturePlugin[]; worker?: Worker; extra?: Partial<AppDependencies>; storage?: SqliteStorage } = {}) {
  const dir = tmp();
  const clock = new FakeClock();
  const config = loadConfig(syntheticEnv(join(dir, 'data')));
  const storage = opts.storage ?? openStorage(config.dbPath, clock);
  cleanups.push(() => storage.close());
  const app = createApp(
    { config, storage, clock, logger: false, webRoot: join(dir, 'no-web'), ...(opts.worker ? { worker: opts.worker } : {}), ...opts.extra },
    opts.plugins ?? [],
  );
  cleanups.push(() => app.close());
  return { app, storage, config, dir };
}

class FakeWorker implements Worker {
  events: string[] = [];
  state: WorkerHealth['state'] = 'stopped';
  start() {
    this.events.push('start');
    this.state = 'running';
  }
  async stop() {
    this.events.push('stop');
    this.state = 'stopped';
  }
  getStatus(): WorkerHealth {
    return { state: this.state, lastRunAt: null, lastErrorCode: null };
  }
}

describe('health', () => {
  it('is generic: status only, no counts, settings or provider configuration', async () => {
    const { app, storage } = build();
    storage.setTimezone('America/Toronto');
    storage.confirmProposal(
      storage.storeProposal({ text: 'secret bins text', dueAt: 1e13, timezone: 'UTC', localDateTime: '2026-01-01T00:00', expiresAt: 1e13 }).id,
      'req-1',
    );
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.body).not.toMatch(/secret|Toronto|openai|vapid|reminders/i);
  });

  it('reports 503 without details when the database is unavailable or the worker failed', async () => {
    const a = build();
    a.storage.db.close();
    const down = await a.app.inject('/healthz');
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: 'unavailable' });

    const worker = new FakeWorker();
    const b = build({ worker });
    await b.app.ready();
    worker.state = 'failed';
    expect((await b.app.inject('/healthz')).statusCode).toBe(503);
  });
});

describe('security headers and errors', () => {
  it('sends no-store, a script-safe CSP and same-origin headers on every response, with no CORS grant', async () => {
    const { app } = build();
    for (const url of ['/healthz', '/missing']) {
      const res = await app.inject({ url, headers: { origin: 'https://evil.example' } });
      expect(res.headers['cache-control']).toBe('no-store');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    const preflight = await app.inject({ method: 'OPTIONS', url: '/healthz', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('maps unknown routes and thrown exceptions to safe typed errors', async () => {
    const boom: FeaturePlugin = {
      name: 'boom',
      register(app) {
        app.get('/boom', async () => {
          throw new Error('SELECT secret FROM /home/agent/data.sqlite');
        });
        app.get('/typed', async () => {
          const { R2Error } = await import('../src/contracts.ts');
          throw new R2Error('request_id_conflict', 'Used for another proposal.');
        });
      },
    };
    const { app } = build({ plugins: [boom] });
    const missing = await app.inject('/nope');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    const failed = await app.inject('/boom');
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: { code: 'internal_error', message: 'Something went wrong.' } });
    expect(failed.body).not.toMatch(/secret|sqlite|home/);
    const typed = await app.inject('/typed');
    expect(typed.statusCode).toBe(409);
    expect(typed.json().error.code).toBe('request_id_conflict');
  });

  it('serves no app shell for /sw.js when web assets are absent', async () => {
    const { app } = build();
    expect((await app.inject('/sw.js')).statusCode).toBe(404);
  });
});

describe('feature plugins and injected adapters', () => {
  it('registers every plugin with the injected dependencies, each in its own scope', async () => {
    const interpreter: ModelInterpreter = { interpret: async () => ({ type: 'unsupported', reason: 'test' }) };
    const transport: PushTransport = { send: async () => ({ outcome: 'accepted' }) };
    const seen: string[] = [];
    const a: FeaturePlugin = {
      name: 'a',
      register(app, deps) {
        seen.push('a');
        app.addHook('onSend', async (_req, reply) => {
          reply.header('x-plugin-a', '1');
        });
        app.get('/a', async () => ({
          interpreter: deps.modelInterpreter === interpreter,
          transport: deps.pushTransport === transport,
          now: deps.clock.now(),
          timezone: deps.storage.getSettings().timezone,
        }));
      },
    };
    const b: FeaturePlugin = {
      name: 'b',
      async register(app) {
        seen.push('b');
        app.get('/b', async () => ({ ok: true }));
      },
    };
    const { app } = build({ plugins: [a, b], extra: { modelInterpreter: interpreter, pushTransport: transport } });
    const ra = await app.inject('/a');
    expect(ra.json()).toEqual({ interpreter: true, transport: true, now: new FakeClock().now(), timezone: null });
    expect(ra.headers['x-plugin-a']).toBe('1');
    const rb = await app.inject('/b');
    expect(rb.statusCode).toBe(200);
    expect(rb.headers['x-plugin-a']).toBeUndefined(); // hooks do not leak across plugins
    expect(seen).toEqual(['a', 'b']);
    // Core protections still apply inside plugin scopes.
    expect(ra.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('starts the worker when ready and stops it exactly when the app closes', async () => {
    const worker = new FakeWorker();
    const { app } = build({ worker });
    expect(worker.events).toEqual([]);
    await app.ready();
    expect(worker.events).toEqual(['start']);
    await app.close();
    expect(worker.events).toEqual(['start', 'stop']);
  });
});

describe('request limits and proxy trust', () => {
  const echo: FeaturePlugin = {
    name: 'echo',
    register(app) {
      app.post('/echo', async (req) => ({ length: JSON.stringify(req.body).length }));
      app.get('/whoami', async (req) => ({ ip: req.ip, protocol: req.protocol, host: req.hostname }));
    },
  };

  it('accepts a body of exactly 8192 bytes and rejects 8193 with a typed 413', async () => {
    expect(BODY_LIMIT_BYTES).toBe(8192);
    const { app } = build({ plugins: [echo] });
    const send = (bytes: number) =>
      app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ t: 'x'.repeat(bytes - 8) }) });
    expect(JSON.stringify({ t: 'x'.repeat(8184) })).toHaveLength(8192);
    expect((await send(8192)).statusCode).toBe(200);
    const big = await send(8193);
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('payload_too_large');
  });

  it('maps malformed JSON and unsupported content types to typed 4xx errors', async () => {
    const { app } = build({ plugins: [echo] });
    const bad = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_request');
    const type = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/x-weird' }, payload: 'x' });
    expect(type.statusCode).toBe(415);
    expect(type.json().error.code).toBe('unsupported_media_type');
  });

  it('honours forwarding headers only from a loopback peer', async () => {
    const { app } = build({ plugins: [echo] });
    const headers = { 'x-forwarded-for': '100.64.0.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'r2.example.ts.net' };
    const viaProxy = await app.inject({ url: '/whoami', headers, remoteAddress: '127.0.0.1' });
    expect(viaProxy.json()).toEqual({ ip: '100.64.0.9', protocol: 'https', host: 'r2.example.ts.net' });
    const viaV6 = await app.inject({ url: '/whoami', headers, remoteAddress: '::1' });
    expect(viaV6.json().ip).toBe('100.64.0.9');
    const spoofed = await app.inject({ url: '/whoami', headers, remoteAddress: '203.0.113.7' });
    expect(spoofed.json()).toMatchObject({ ip: '203.0.113.7', protocol: 'http' });
    expect(spoofed.json().host).not.toBe('r2.example.ts.net');
  });
});

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
    const svc = await start(join(tmp(), 'data'), {}, undefined, { worker });
    expect(worker.events).toEqual(['start']);
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

describe('built service', () => {
  const root = join(import.meta.dirname, '..');
  const built = existsSync(join(root, 'dist/server/main.js'));

  const run = (dataDir: string, port: number) =>
    new Promise<{ stop(): Promise<number | null>; stdout: () => string }>((resolve, reject) => {
      let out = '';
      const child = spawn(process.execPath, [join(root, 'dist/server/main.js')], {
        cwd: tmp(), // deliberately not the checkout: nothing may depend on the working directory
        env: { PATH: process.env.PATH ?? '', R2_ORIGIN: 'https://r2.example.ts.net', R2_DATA_DIR: dataDir, R2_PORT: String(port) },
      });
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`exited early (${code}): ${out}`)));
      const timer = setInterval(async () => {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) {
            clearInterval(timer);
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

  it.skipIf(!built)('runs from dist with synthetic HTTPS origin, serves health and the web shell, restarts with the same record', async () => {
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

    // Write a record directly with a separate connection while the service is stopped.
    const direct = openStorage(join(dataDir, 'r2.sqlite'), new FakeClock());
    direct.setTimezone('America/Toronto');
    direct.close();

    const second = await run(dataDir, port);
    expect(await second.stop()).toBe(0);
    const check = openStorage(join(dataDir, 'r2.sqlite'), new FakeClock());
    expect(check.getSettings().timezone).toBe('America/Toronto');
    check.close();
  }, 30000);
});
