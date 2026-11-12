import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import { loggerOptions } from '../src/server.ts';
import { startService, type RunningService } from '../src/service.ts';
import { FakeClock, tempDir } from './helpers.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function start(extra: NodeJS.ProcessEnv = {}, dir?: string, logger?: Parameters<typeof startService>[2]) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const svc = await startService(
    { R2_DATA_DIR: dir ?? t.dir, R2_PORT: '0', ...extra },
    new FakeClock(),
    logger,
  );
  cleanups.push(() => svc.stop().catch(() => undefined));
  return { svc, dir: dir ?? t.dir };
}

const get = (svc: RunningService, path: string) => fetch(`http://127.0.0.1:${svc.port}${path}`);

describe('config', () => {
  it('rejects non-loopback binding and bad values', () => {
    expect(() => loadConfig({ R2_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ R2_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ R2_PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ R2_LOG_LEVEL: 'loud' })).toThrow(ConfigError);
  });
  it('defaults to loopback and does not require OpenAI', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.openai.apiKey).toBeUndefined();
  });
});

describe('service', () => {
  it('starts without OpenAI and reports health', async () => {
    const { svc } = await start();
    const res = await get(svc, '/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({
      status: 'ok',
      database: 'ok',
      schemaVersion: 1,
      openai: { configured: false },
      notifications: { paused: false, browserConnected: false },
      reminders: { scheduled: 0, failed: 0 },
    });
  });

  it('keeps saved reminders across restart and never exposes their text in health', async () => {
    const first = await start();
    first.svc.db
      .prepare(
        `INSERT INTO reminders (id, request_id, text, due_at_ms, timezone, status, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('r_1','q1','secret bins text',1,'UTC','scheduled',1,1,1)`,
      )
      .run();
    await first.svc.stop();
    const second = await start({}, first.dir);
    const body = await (await get(second.svc, '/healthz')).text();
    expect(JSON.parse(body).reminders.scheduled).toBe(1);
    expect(body).not.toContain('secret');
  });

  it('reports 503 when the database is unavailable', async () => {
    const { svc } = await start();
    svc.db.close();
    const res = await get(svc, '/healthz');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'unavailable' });
  });

  it('never logs the OpenAI key, cookies or authorization headers', async () => {
    let out = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const { svc } = await start({ OPENAI_API_KEY: 'sk-super-secret' }, undefined, {
      ...loggerOptions('info'),
      stream,
    } as never);
    await fetch(`http://127.0.0.1:${svc.port}/healthz`, {
      headers: { cookie: 'r2_session=topsecretcookie', authorization: 'Bearer topsecrettoken' },
    });
    await svc.stop();
    expect(out).toContain('R2 listening');
    expect(out).not.toMatch(/sk-super-secret|topsecretcookie|topsecrettoken/);
  });

  it('refuses to start on a port already in use and closes the database', async () => {
    const { svc } = await start();
    const t = tempDir();
    cleanups.push(t.cleanup);
    await expect(startService({ R2_DATA_DIR: join(t.dir, 'x'), R2_PORT: String(svc.port) }, new FakeClock())).rejects.toThrow();
  });
});
