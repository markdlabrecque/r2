import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { ModelInterpreter, PushTransport, Worker } from '../src/contracts.ts';
import { openStorage, type SqliteStorage } from '../src/db.ts';
import { BODY_LIMIT_BYTES, createApp, type AppDependencies, type FeaturePlugin } from '../src/routes.ts';
import { FakeWorker } from './app-fixtures.ts';
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

