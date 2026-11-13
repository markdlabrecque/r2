import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authPlugin } from '../src/auth.ts';
import { chatPlugin } from '../src/chat.ts';
import { loadConfig } from '../src/config.ts';
import type { PushResult, PushSubscriptionKeys, PushTransport } from '../src/contracts.ts';
import { openStorage, type SqliteStorage } from '../src/db.ts';
import { hashPassword } from '../src/password.ts';
import { createApp } from '../src/routes.ts';
import { startService } from '../src/service.ts';
import { statusPlugin } from '../src/status.ts';
import { DeliveryWorker } from '../src/worker.ts';
import { FakeClock, syntheticEnv, tempDir } from './helpers.ts';

const KEYS: PushSubscriptionKeys = {
  endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/synthetic',
  p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'),
  auth: Buffer.alloc(16, 9).toString('base64url'),
};

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

class FakeTransport implements PushTransport {
  sent: { reminderId: string; endpoint: string }[] = [];
  results: PushResult[] = [];
  async send(sub: PushSubscriptionKeys, reminderId: string): Promise<PushResult> {
    this.sent.push({ reminderId, endpoint: sub.endpoint });
    return this.results.shift() ?? { outcome: 'accepted', httpStatus: 201 };
  }
}

function setup(opts: { transport?: PushTransport | undefined; subscribe?: boolean } = {}) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const clock = new FakeClock();
  const storage = openStorage(join(t.dir, 'data', 'r2.sqlite'), clock);
  cleanups.push(() => storage.close());
  if (opts.subscribe !== false) storage.replaceSubscription(KEYS);
  const transport = 'transport' in opts ? opts.transport : new FakeTransport();
  const worker = new DeliveryWorker({ storage, clock, pushTransport: transport });
  const remind = (text: string, dueInMs: number) => {
    const dueAt = clock.now() + dueInMs;
    const p = storage.storeProposal({ text, dueAt, timezone: 'UTC', localDateTime: '2026-10-14T12:00', expiresAt: dueAt });
    return storage.confirmProposal(p.id, `req-${text}`);
  };
  return { t, clock, storage, transport: transport as FakeTransport, worker, remind };
}

describe('delivery worker', () => {
  it('does nothing before a reminder is due, then submits one generic push with only an opaque id', async () => {
    const s = setup();
    const r = s.remind('secret bins', 60_000);
    await s.worker.runOnce();
    expect(s.transport.sent).toEqual([]);
    s.clock.advance(60_000);
    await s.worker.runOnce();
    expect(s.transport.sent).toEqual([{ reminderId: r.id, endpoint: KEYS.endpoint }]);
    expect(JSON.stringify(s.transport.sent)).not.toContain('secret');
    const done = s.storage.getReminder(r.id);
    expect(done).toMatchObject({ state: 'accepted', attempts: 1, errorCode: null, claimToken: null });
    expect(done?.acceptedAt).toBe(s.clock.now());
    // The original due time and the provider outcome stay on the record.
    expect(done?.dueAt).toBe(r.dueAt);
    expect(s.storage.listDeliveryAttempts(r.id).map((a) => a.outcome)).toEqual(['accepted']);
    await s.worker.runOnce();
    expect(s.transport.sent).toHaveLength(1);
  });

  it('sends every overdue reminder, oldest first, keeping each original due time', async () => {
    const s = setup();
    const a = s.remind('a', 10_000);
    const b = s.remind('b', 5_000);
    const c = s.remind('c', 20_000);
    s.clock.advance(7 * 24 * 3600_000);
    await s.worker.runOnce();
    expect(s.transport.sent.map((x) => x.reminderId)).toEqual([b.id, a.id, c.id]);
    for (const r of [a, b, c]) expect(s.storage.getReminder(r.id)).toMatchObject({ state: 'accepted', dueAt: r.dueAt });
  });

  it('retries a temporary failure after 30s, 2min and 10min, then stops after four attempts', async () => {
    const s = setup();
    s.transport.results = Array.from({ length: 6 }, () => ({ outcome: 'failed', retryable: true, code: 'temporary' }) as PushResult);
    const r = s.remind('x', 1000);
    s.clock.advance(1000);
    for (const wait of [30_000, 120_000, 600_000]) {
      await s.worker.runOnce();
      expect(s.storage.getReminder(r.id)).toMatchObject({ state: 'retry', errorCode: 'temporary', nextAttemptAt: s.clock.now() + wait });
      s.clock.advance(wait - 1);
      await s.worker.runOnce();
      expect(s.storage.getReminder(r.id)?.state).toBe('retry'); // not yet
      s.clock.advance(1);
    }
    await s.worker.runOnce();
    expect(s.storage.getReminder(r.id)).toMatchObject({ state: 'failed', attempts: 4, errorCode: 'temporary' });
    s.clock.advance(24 * 3600_000);
    await s.worker.runOnce();
    expect(s.transport.sent).toHaveLength(4);
    expect(s.storage.listDeliveryAttempts(r.id).map((a) => a.outcome)).toEqual(['failed', 'failed', 'failed', 'failed']);
  });

  it('fails permanently without retrying when the subscription is gone', async () => {
    const s = setup();
    s.transport.results = [{ outcome: 'failed', retryable: false, code: 'subscription_gone', httpStatus: 410 }];
    const r = s.remind('x', 0 + 1);
    s.clock.advance(1);
    await s.worker.runOnce();
    expect(s.storage.getReminder(r.id)).toMatchObject({ state: 'failed', errorCode: 'subscription_gone', attempts: 1 });
    await s.worker.runOnce();
    expect(s.transport.sent).toHaveLength(1);
  });

  it('keeps reminders scheduled while paused and sends them, overdue, after resume', async () => {
    const s = setup();
    const r = s.remind('x', 1000);
    s.storage.setNotificationsPaused(true);
    s.clock.advance(3600_000);
    await s.worker.runOnce();
    expect(s.transport.sent).toEqual([]);
    expect(s.storage.getReminder(r.id)?.state).toBe('scheduled');
    s.storage.setNotificationsPaused(false);
    await s.worker.runOnce();
    expect(s.storage.getReminder(r.id)?.state).toBe('accepted');
  });

  it('keeps reminders waiting, not failed, without a browser or push configuration', async () => {
    const noBrowser = setup({ subscribe: false });
    const r1 = noBrowser.remind('x', 1);
    noBrowser.clock.advance(1);
    await noBrowser.worker.runOnce();
    expect(noBrowser.storage.getReminder(r1.id)?.state).toBe('scheduled');

    const noPush = setup({ transport: undefined });
    const r2 = noPush.remind('x', 1);
    noPush.clock.advance(1);
    await noPush.worker.runOnce();
    expect(noPush.storage.getReminder(r2.id)?.state).toBe('scheduled');
  });

  it('never sends one reminder twice when passes overlap', async () => {
    const s = setup();
    s.remind('x', 1);
    s.clock.advance(1);
    const other = new DeliveryWorker({ storage: s.storage, clock: s.clock, pushTransport: s.transport });
    await Promise.all([s.worker.runOnce(), other.runOnce()]);
    expect(s.transport.sent).toHaveLength(1);
  });

  it('records a thrown transport as unknown and retries it', async () => {
    const s = setup({
      transport: {
        send: async () => {
          throw new Error('boom');
        },
      },
    });
    const r = s.remind('x', 1);
    s.clock.advance(1);
    await s.worker.runOnce();
    expect(s.storage.getReminder(r.id)).toMatchObject({ state: 'retry', errorCode: 'network' });
    expect(s.storage.listDeliveryAttempts(r.id)[0]?.outcome).toBe('unknown');
  });
});

describe('crash recovery', () => {
  function crashed(storage: SqliteStorage, clock: FakeClock, attemptsBefore = 0) {
    const p = storage.storeProposal({ text: 'x', dueAt: clock.now() + 1, timezone: 'UTC', localDateTime: '2026-10-14T12:00', expiresAt: clock.now() + 1 });
    const r = storage.confirmProposal(p.id, 'req-crash');
    clock.advance(1);
    // Simulate a process that claimed and recorded an attempt, then died before the outcome.
    for (let i = 0; i < attemptsBefore; i++) {
      const [c] = storage.claimDueReminders({ limit: 1, leaseMs: 1000 });
      storage.startDeliveryAttempt({ reminderId: r.id, claimToken: c?.claimToken ?? '', subscriptionVersion: 1 });
      storage.recoverExpiredLeases({ maxAttempts: 4, all: true });
    }
    const [c] = storage.claimDueReminders({ limit: 1, leaseMs: 60_000 });
    storage.startDeliveryAttempt({ reminderId: r.id, claimToken: c?.claimToken ?? '', subscriptionVersion: 1 });
    return r;
  }

  it('on start, returns an orphaned sending reminder to retry and delivers it', async () => {
    const s = setup();
    const r = crashed(s.storage, s.clock);
    expect(s.storage.getReminder(r.id)?.state).toBe('sending');
    await s.worker.start();
    await s.worker.stop();
    expect(s.storage.getReminder(r.id)).toMatchObject({ state: 'retry', errorCode: 'interrupted' });
    await new DeliveryWorker({ storage: s.storage, clock: s.clock, pushTransport: s.transport }).runOnce();
    expect(s.storage.getReminder(r.id)?.state).toBe('accepted');
    expect(s.storage.listDeliveryAttempts(r.id).map((a) => a.outcome)).toEqual(['unknown', 'accepted']);
  });

  it('recovers an expired lease while running, and fails it once attempts are used up', async () => {
    const s = setup();
    const r = crashed(s.storage, s.clock);
    s.clock.advance(61_000);
    await s.worker.runOnce();
    expect(s.storage.getReminder(r.id)?.state).toBe('accepted');

    const t = setup();
    const r2 = crashed(t.storage, t.clock, 3);
    t.clock.advance(61_000);
    await t.worker.runOnce();
    expect(t.storage.getReminder(r2.id)).toMatchObject({ state: 'failed', errorCode: 'interrupted', attempts: 4 });
    expect(t.transport.sent).toEqual([]);
  });

  it('does not touch a lease that is still live', async () => {
    const s = setup();
    const r = crashed(s.storage, s.clock);
    await s.worker.runOnce();
    expect(s.storage.getReminder(r.id)?.state).toBe('sending');
    expect(s.transport.sent).toEqual([]);
  });
});

describe('restart, end to end, without OpenAI', () => {
  it('delivers a reminder saved before restart, with chat disabled and an overdue due time', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const dir = join(t.dir, 'data');
    const clock = new FakeClock();
    const hash = await hashPassword('correct horse battery staple', { ln: 10, r: 8, p: 1 });
    const env = syntheticEnv(dir, { R2_PASSWORD_HASH: hash });
    const transport = new FakeTransport();

    const first = await startService(env, { clock, logger: false, adapters: { webRoot: join(t.dir, 'none') } });
    first.storage.setTimezone('UTC');
    first.storage.replaceSubscription(KEYS);
    const p = first.storage.storeProposal({ text: 'take the bins out', dueAt: clock.now() + 5 * 60_000, timezone: 'UTC', localDateTime: '2026-10-14T12:05', expiresAt: clock.now() + 5 * 60_000 });
    const reminder = first.storage.confirmProposal(p.id, 'request-0001');
    await first.stop();

    clock.advance(30 * 60_000); // due while the service was down
    const second = await startService(env, { clock, logger: false, adapters: { webRoot: join(t.dir, 'none'), pushTransport: transport } });
    cleanups.push(() => second.stop());
    expect(second.config.chat.enabled).toBe(false);
    await waitFor(() => second.storage.getReminder(reminder.id)?.state === 'accepted');
    expect(transport.sent.map((x) => x.reminderId)).toEqual([reminder.id]);
    expect(second.storage.getReminder(reminder.id)).toMatchObject({ dueAt: reminder.dueAt, localDateTime: reminder.localDateTime });
  });
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('status and pause routes', () => {
  const ORIGIN = 'https://r2.example.ts.net';
  const PASSWORD = 'correct horse battery staple';

  async function api() {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const clock = new FakeClock();
    const hash = await hashPassword(PASSWORD, { ln: 10, r: 8, p: 1 });
    const config = loadConfig(syntheticEnv(join(t.dir, 'data'), { R2_PASSWORD_HASH: hash }));
    const storage = openStorage(config.dbPath, clock);
    const worker = new DeliveryWorker({ storage, clock });
    const app = createApp({ config, storage, clock, logger: false, webRoot: join(t.dir, 'none'), worker }, [authPlugin, statusPlugin, chatPlugin]);
    cleanups.push(async () => {
      await app.close();
      storage.close();
    });
    const headers = { origin: ORIGIN, 'content-type': 'application/json' };
    const login = await app.inject({ method: 'POST', url: '/api/session', headers, payload: { password: PASSWORD } });
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    return { app, storage, headers: { ...headers, cookie }, clock };
  }

  it('requires the owner', async () => {
    const { app } = await api();
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/notifications/pause', headers: { origin: ORIGIN, 'content-type': 'application/json' }, payload: { paused: true } })).statusCode).toBe(401);
  });

  it('reports counts and toggles the pause without exposing reminder text', async () => {
    const { app, storage, headers, clock } = await api();
    const p = storage.storeProposal({ text: 'private text', dueAt: clock.now() + 1000, timezone: 'UTC', localDateTime: '2026-10-14T12:00', expiresAt: clock.now() + 1000 });
    storage.confirmProposal(p.id, 'request-0001');
    const before = await app.inject({ method: 'GET', url: '/api/status', headers });
    expect(before.json()).toMatchObject({ notifications: { paused: false, pushConfigured: false, browserConnected: false }, reminders: { byState: { scheduled: 1 }, due: 0 } });
    const paused = await app.inject({ method: 'PUT', url: '/api/notifications/pause', headers, payload: { paused: true } });
    expect(paused.json().notifications.paused).toBe(true);
    expect(storage.getSettings().notificationsPaused).toBe(true);
    expect(paused.body).not.toContain('private text');
    const bad = await app.inject({ method: 'PUT', url: '/api/notifications/pause', headers, payload: { paused: 'yes' } });
    expect(bad.statusCode).toBe(400);
  });
});
