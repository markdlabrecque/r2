import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../src/password.ts';
import { startService } from '../src/service.ts';
import { FakeClock, syntheticEnv, tempDir } from './helpers.ts';

import { FakeTransport, KEYS } from './worker-fixtures.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
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
    cleanups.push(() => first.stop());
    first.storage.setTimezone('UTC');
    const subscription = first.storage.replaceSubscription(KEYS);
    expect(first.storage.markSubscriptionReady(subscription.version)).toBe(true);
    const readySubscription = first.storage.getSubscription();
    expect(readySubscription).toMatchObject({ ...KEYS, version: subscription.version, readyAt: clock.now() });
    const p = first.storage.storeProposal({ text: 'take the bins out', dueAt: clock.now() + 5 * 60_000, timezone: 'UTC', localDateTime: '2026-10-14T12:05', expiresAt: clock.now() + 5 * 60_000 });
    const reminder = first.storage.confirmProposal(p.id, 'request-0001');
    await first.stop();

    clock.advance(30 * 60_000); // due while the service was down
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cleanups.push(() => { vi.useRealTimers(); });
    const second = await startService(env, { clock, logger: false, adapters: { webRoot: join(t.dir, 'none'), pushTransport: transport } });
    cleanups.push(() => second.stop());
    expect(second.config.chat.enabled).toBe(false);
    expect(second.storage.getSubscription()).toEqual(readySubscription);
    // Only the worker's timer is virtual: real socket startup and SQLite remain real.
    // Drive its initial scheduled pass to completion, not a wall-clock polling loop.
    await vi.advanceTimersByTimeAsync(0);
    expect(second.storage.getReminder(reminder.id)?.state).toBe('accepted');
    expect(transport.sent.map((x) => x.reminderId)).toEqual([reminder.id]);
    expect(second.storage.getReminder(reminder.id)).toMatchObject({ dueAt: reminder.dueAt, localDateTime: reminder.localDateTime, state: 'accepted', attempts: 1, acceptedAt: clock.now() });
    expect(second.storage.listDeliveryAttempts(reminder.id)).toEqual([
      expect.objectContaining({ reminderId: reminder.id, attemptNumber: 1, subscriptionVersion: subscription.version, outcome: 'accepted', startedAt: clock.now(), finishedAt: clock.now(), errorCode: null }),
    ]);
  });
});

