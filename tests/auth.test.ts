import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, SESSION_COOKIE, authPlugin } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { openStorage } from '../src/db.ts';
import { hashPassword, verifyPassword } from '../src/password.ts';
import { createApp, type FeaturePlugin } from '../src/routes.ts';
import { settingsPlugin } from '../src/settings.ts';
import { FakeClock, syntheticEnv, tempDir } from './helpers.ts';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://r2.example.ts.net';
const cheap = { ln: 10, r: 8, p: 1 };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(options: { password?: boolean; plugins?: FeaturePlugin[] } = {}) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const clock = new FakeClock();
  const hash = await hashPassword(PASSWORD, cheap);
  const config = loadConfig(syntheticEnv(join(t.dir, 'data'), options.password === false ? {} : { R2_PASSWORD_HASH: hash }));
  const storage = openStorage(config.dbPath, clock);
  cleanups.push(() => storage.close());
  const app = createApp({ config, storage, clock, logger: false, webRoot: join(t.dir, 'none') }, [authPlugin, settingsPlugin, ...(options.plugins ?? [])]);
  cleanups.push(() => app.close());
  return { app, storage, clock };
}

const write = { origin: ORIGIN, 'content-type': 'application/json' };

async function login(app: FastifyInstance, password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/api/session', headers: write, payload: { password } });
}

async function signedIn(app: FastifyInstance): Promise<string> {
  const res = await login(app);
  expect(res.statusCode).toBe(200);
  const raw = String(res.headers['set-cookie']);
  return raw.split(';')[0] ?? '';
}

describe('password hashing', () => {
  it('verifies the right password only, and treats malformed or extreme hashes as a mismatch', async () => {
    const hash = await hashPassword(PASSWORD, cheap);
    expect(hash).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$/);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, '$scrypt$garbage')).toBe(false);
    expect(await verifyPassword(PASSWORD, '$scrypt$ln=30,r=8,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA')).toBe(false);
  });
});

describe('owner login', () => {
  it('sets a hardened session cookie, stores only a hash of the token, and rejects a wrong password', async () => {
    const { app, storage } = await setup();
    const bad = await login(app, 'nope');
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();

    const ok = await login(app);
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);

    const token = decodeURIComponent((cookie.split(';')[0] ?? '').split('=')[1] ?? '');
    const rows = storage.db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('says plainly that sign-in is unavailable when no password hash is configured', async () => {
    const { app } = await setup({ password: false });
    expect((await app.inject('/api/session')).json()).toEqual({ authenticated: false, loginAvailable: false });
    expect((await login(app)).statusCode).toBe(503);
  });

  it('throttles repeated wrong passwords, then recovers after the window', async () => {
    const { app, clock } = await setup();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) expect((await login(app, `wrong-${i}`)).statusCode).toBe(401);
    const blocked = await login(app);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    clock.advance(LOGIN_WINDOW_MS + 1);
    expect((await login(app)).statusCode).toBe(200);
  });

  it('expires sessions and revokes them on logout', async () => {
    const { app, clock } = await setup();
    const cookie = await signedIn(app);
    const get = () => app.inject({ url: '/api/settings', headers: { cookie } });
    expect((await get()).statusCode).toBe(200);

    const out = await app.inject({ method: 'DELETE', url: '/api/session', headers: { origin: ORIGIN, cookie } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/i);
    expect((await get()).statusCode).toBe(401);

    const again = await signedIn(app);
    clock.advance(169 * 3600_000);
    expect((await app.inject({ url: '/api/settings', headers: { cookie: again } })).statusCode).toBe(401);
  });
});

describe('protected API access', () => {
  it('rejects unauthenticated reads and writes to settings without revealing them', async () => {
    const { app, storage } = await setup();
    storage.setTimezone('America/Toronto');
    const read = await app.inject('/api/settings');
    expect(read.statusCode).toBe(401);
    expect(read.body).not.toContain('Toronto');
    const put = await app.inject({ method: 'PUT', url: '/api/settings', headers: write, payload: { timezone: 'UTC' } });
    expect(put.statusCode).toBe(401);
    expect(storage.getSettings().timezone).toBe('America/Toronto');
  });

  it('is closed by default: an /api route a feature forgets to protect still needs a session, unless it opts out', async () => {
    const later: FeaturePlugin = {
      name: 'later',
      register(app) {
        app.get('/api/forgotten', async () => ({ secret: 1 }));
        app.get('/api/open', { config: { public: true } }, async () => ({ open: 1 }));
        app.get('/elsewhere', async () => ({ page: 1 }));
      },
    };
    const { app } = await setup({ plugins: [later] });
    expect((await app.inject('/api/forgotten')).statusCode).toBe(401);
    expect((await app.inject('/api/open')).statusCode).toBe(200);
    expect((await app.inject('/elsewhere')).statusCode).toBe(200);
    const cookie = await signedIn(app);
    expect((await app.inject({ url: '/api/forgotten', headers: { cookie } })).statusCode).toBe(200);
  });

  it('rejects cross-origin writes even with a valid session, and a missing origin', async () => {
    const { app, storage } = await setup();
    const cookie = await signedIn(app);
    const put = (headers: Record<string, string>) =>
      app.inject({ method: 'PUT', url: '/api/settings', headers: { 'content-type': 'application/json', cookie, ...headers }, payload: { timezone: 'UTC' } });
    expect((await put({ origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await put({})).statusCode).toBe(403);
    expect((await put({ origin: ORIGIN, 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect(storage.getSettings().timezone).toBeNull();
    expect((await put({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
  });

  it('rejects cross-origin sign-in attempts before checking the password', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/session', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, payload: { password: PASSWORD } });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('keeps /healthz public and generic', async () => {
    const { app } = await setup();
    expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
  });
});

describe('timezone settings', () => {
  it('starts with no timezone, saves an explicit IANA name in canonical form and keeps it across restart', async () => {
    const { app, storage } = await setup();
    const cookie = await signedIn(app);
    expect((await app.inject({ url: '/api/settings', headers: { cookie } })).json()).toEqual({ timezone: null, notificationsPaused: false });

    const put = await app.inject({ method: 'PUT', url: '/api/settings', headers: { ...write, cookie }, payload: { timezone: 'america/toronto' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ timezone: 'America/Toronto', notificationsPaused: false });
    expect(storage.getSettings().timezone).toBe('America/Toronto');
  });

  it('rejects offsets, junk, extra fields and non-strings without changing the saved timezone', async () => {
    const { app, storage } = await setup();
    const cookie = await signedIn(app);
    storage.setTimezone('UTC');
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/settings', headers: { ...write, cookie }, payload: payload as object });
    for (const timezone of ['+05:00', 'Mars/Olympus', '', 'x'.repeat(100)]) {
      const res = await put({ timezone });
      expect(res.statusCode, timezone).toBe(400);
    }
    expect((await put({ timezone: 'UTC', notificationsPaused: true })).statusCode).toBe(400);
    expect((await put({ timezone: 5 })).statusCode).toBe(400);
    expect(storage.getSettings()).toEqual({ timezone: 'UTC', notificationsPaused: false });
  });
});
