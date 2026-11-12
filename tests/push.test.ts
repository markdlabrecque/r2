import { join } from 'node:path';
import { generateVAPIDKeys } from 'web-push';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, authPlugin } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import type { PushResult, PushSubscriptionKeys, PushTransport } from '../src/contracts.ts';
import { openStorage } from '../src/db.ts';
import { hashPassword } from '../src/password.ts';
import { pushPlugin } from '../src/push-routes.ts';
import {
  WebPushTransport,
  classifyStatus,
  isBlockedAddress,
  validatePushEndpoint,
  type SendFunction,
} from '../src/push.ts';
import { createApp } from '../src/routes.ts';
import { FakeClock, syntheticEnv, tempDir } from './helpers.ts';

const ORIGIN = 'https://r2.example.ts.net';
const PASSWORD = 'correct horse battery staple';
const vapid = generateVAPIDKeys();
const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/synthetic-token';
const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 9).toString('base64url');
const KEYS: PushSubscriptionKeys = { endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('endpoint validation', () => {
  it('accepts reviewed push hosts and rejects everything else without echoing it', () => {
    for (const ok of [
      ENDPOINT,
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      expect(() => validatePushEndpoint(ok)).not.toThrow();
    }
    for (const bad of [
      'http://updates.push.services.mozilla.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest',
      'https://100.64.0.1/x',
      'https://evil.example/x',
      'https://push.services.mozilla.com.evil.example/x',
      'https://user:pw@updates.push.services.mozilla.com/x',
      'https://updates.push.services.mozilla.com:8443/x',
      'https://updates.push.services.mozilla.com/x#frag',
      'not a url',
      '',
      `https://fcm.googleapis.com/${'a'.repeat(3000)}`,
    ]) {
      let message = '';
      try {
        validatePushEndpoint(bad);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, bad.slice(0, 60)).not.toBe('');
      expect(message).not.toContain('evil');
    }
  });

  it('blocks loopback, private, tailnet, link-local and mapped addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '100.100.1.1', '169.254.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', 'garbage']) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2607:f8b0:4005::1')).toBe(false);
  });
});

describe('status classification', () => {
  it('separates acceptance, retryable and permanent outcomes, and never follows redirects', () => {
    expect(classifyStatus(201)).toEqual({ outcome: 'accepted', httpStatus: 201 });
    for (const s of [404, 410]) expect(classifyStatus(s)).toMatchObject({ retryable: false, code: 'subscription_gone' });
    for (const s of [408, 429, 500, 503]) expect(classifyStatus(s)).toMatchObject({ retryable: true, code: 'temporary' });
    for (const s of [301, 302, 400, 401, 403, 413]) expect(classifyStatus(s)).toMatchObject({ retryable: false, code: 'rejected' });
  });
});

describe('web push transport', () => {
  function transport(send: SendFunction, extra: { deadlineMs?: number } = {}) {
    return new WebPushTransport({ vapid: { subject: 'mailto:owner@example.com', ...vapid }, send, ...extra });
  }

  it('sends only the opaque reminder id, never reminder text or a due time', async () => {
    const seen: { payload: string; options: Record<string, unknown> }[] = [];
    const t = transport(async (_sub, payload, options) => {
      seen.push({ payload, options: options as Record<string, unknown> });
      return { statusCode: 201 };
    });
    expect(await t.send(KEYS, 'rem_abc123')).toEqual({ outcome: 'accepted', httpStatus: 201 });
    expect(JSON.parse(seen[0]!.payload)).toEqual({ reminderId: 'rem_abc123' });
    expect(seen[0]!.options).toMatchObject({ timeout: 10_000, contentEncoding: 'aes128gcm', urgency: 'high' });
    expect(seen[0]!.options.agent).toBeDefined();
  });

  it('maps provider errors, timeouts and connection failures; refuses unsafe input before any request', async () => {
    let calls = 0;
    const fail = (error: unknown) =>
      transport(async () => {
        calls++;
        throw error;
      });
    expect(await fail(Object.assign(new Error('gone'), { statusCode: 410 })).send(KEYS, 'rem_1')).toMatchObject({ code: 'subscription_gone', retryable: false });
    expect(await fail(Object.assign(new Error('busy'), { statusCode: 503 })).send(KEYS, 'rem_1')).toMatchObject({ code: 'temporary', retryable: true });
    expect(await fail(new Error('ECONNRESET')).send(KEYS, 'rem_1')).toMatchObject({ code: 'network', retryable: true });

    const hang = transport(() => new Promise(() => undefined), { deadlineMs: 20 });
    expect(await hang.send(KEYS, 'rem_1')).toMatchObject({ code: 'network', retryable: true });

    calls = 0;
    const t = fail(new Error('should not be called'));
    expect(await t.send({ ...KEYS, endpoint: 'https://127.0.0.1/x' }, 'rem_1')).toMatchObject({ code: 'rejected', retryable: false });
    expect(await t.send({ ...KEYS, auth: 'short' }, 'rem_1')).toMatchObject({ code: 'rejected' });
    expect(await t.send(KEYS, 'has space and text')).toMatchObject({ code: 'rejected' });
    expect(calls).toBe(0);
  });
});

describe('push API', () => {
  async function setup(options: { push?: boolean; send?: PushResult } = {}) {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const clock = new FakeClock();
    const hash = await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 });
    const env = syntheticEnv(join(t.dir, 'data'), {
      R2_PASSWORD_HASH: hash,
      ...(options.push === false ? {} : { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:owner@example.com' }),
    });
    const config = loadConfig(env);
    const storage = openStorage(config.dbPath, clock);
    cleanups.push(() => storage.close());
    const sent: { sub: PushSubscriptionKeys; id: string }[] = [];
    const pushTransport: PushTransport = {
      async send(sub, id) {
        sent.push({ sub, id });
        return options.send ?? { outcome: 'accepted', httpStatus: 201 };
      },
    };
    const app = createApp({ config, storage, clock, logger: false, webRoot: join(t.dir, 'none'), pushTransport }, [authPlugin, pushPlugin]);
    cleanups.push(() => app.close());
    const login = await app.inject({ method: 'POST', url: '/api/session', headers: { origin: ORIGIN }, payload: { password: PASSWORD } });
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    expect(cookie).toContain(SESSION_COOKIE);
    const write = (method: 'PUT' | 'POST', url: string, payload?: unknown) =>
      app.inject({ method, url, headers: { origin: ORIGIN, cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { app, storage, sent, cookie, write };
  }
  const body = { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } };

  it('requires the owner session', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/push')).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/push/subscription', headers: { origin: ORIGIN }, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/push/test', headers: { origin: ORIGIN } })).statusCode).toBe(401);
  });

  it('connects one browser, replaces it, and never exposes the endpoint or keys', async () => {
    const { app, storage, write, cookie } = await setup();
    const first = await write('PUT', '/api/push/subscription', body);
    expect(first.statusCode).toBe(200);
    expect(first.json().subscription).toEqual({ connected: true, ready: false, version: 1 });
    expect(first.body).not.toContain('synthetic-token');

    storage.markSubscriptionReady(1);
    const status = await app.inject({ url: '/api/push', headers: { cookie } });
    expect(status.json()).toMatchObject({ configured: true, publicKey: vapid.publicKey, subscription: { ready: true } });
    expect(status.body).not.toContain(P256DH);

    const second = await write('PUT', '/api/push/subscription', { ...body, endpoint: `${ENDPOINT}-2` });
    expect(second.json().subscription).toEqual({ connected: true, ready: false, version: 2 });
    expect(storage.getSubscription()?.endpoint).toBe(`${ENDPOINT}-2`);
  });

  it('rejects unsafe or malformed subscriptions and does not store them', async () => {
    const { storage, write } = await setup();
    for (const payload of [
      { ...body, endpoint: 'https://127.0.0.1/x' },
      { ...body, endpoint: 'http://fcm.googleapis.com/x' },
      { ...body, keys: { p256dh: 'AAAA', auth: AUTH } },
      { ...body, keys: { p256dh: P256DH, auth: 'AAAA' } },
      { ...body, extra: 1 },
      { endpoint: ENDPOINT },
    ]) {
      expect((await write('PUT', '/api/push/subscription', payload)).statusCode).toBe(400);
    }
    expect(storage.getSubscription()).toBeUndefined();
  });

  it('marks the subscription ready only after an accepted test, and reports failures', async () => {
    const ok = await setup();
    expect((await ok.write('POST', '/api/push/test')).statusCode).toBe(409);
    await ok.write('PUT', '/api/push/subscription', body);
    const res = await ok.write('POST', '/api/push/test');
    expect(res.json()).toMatchObject({ ok: true, subscription: { ready: true } });
    expect(ok.sent).toHaveLength(1);
    expect(ok.sent[0]!.id).toBe('test');

    const bad = await setup({ send: { outcome: 'failed', retryable: false, code: 'subscription_gone', httpStatus: 410 } });
    await bad.write('PUT', '/api/push/subscription', body);
    const failed = await bad.write('POST', '/api/push/test');
    expect(failed.json()).toMatchObject({ ok: false, code: 'subscription_gone', subscription: { connected: true, ready: false } });
  });

  it('reports Web Push unconfigured instead of failing', async () => {
    const { app, cookie, write } = await setup({ push: false });
    const status = await app.inject({ url: '/api/push', headers: { cookie } });
    expect(status.json()).toMatchObject({ configured: false, publicKey: null });
    expect((await write('PUT', '/api/push/subscription', body)).statusCode).toBe(503);
    expect((await write('POST', '/api/push/test')).statusCode).toBe(503);
  });
});
