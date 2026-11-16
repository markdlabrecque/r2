import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AcceptanceApi } from '../scripts/acceptance/api.ts';
import { AcceptanceCases, makeCase, findKnown, proposalInList, retained, pollReminder, sameSubscription } from '../scripts/acceptance/cases.ts';
import { jsonReport } from '../scripts/acceptance/report.ts';
import { authPlugin } from '../src/auth.ts';
import { chatPlugin } from '../src/chat.ts';
import { settingsPlugin } from '../src/settings.ts';
import { statusPlugin } from '../src/status.ts';
import { pushPlugin } from '../src/push-routes.ts';
import { loadConfig } from '../src/config.ts';
import { openStorage } from '../src/db.ts';
import { hashPassword } from '../src/password.ts';
import { createApp } from '../src/routes.ts';
import { FakeClock, syntheticEnv, tempDir } from './helpers.ts';
import { fixture, installation } from './acceptance-fixtures.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
async function setup() {
  const t = tempDir(); const f = fixture(); cleanups.push(t.cleanup, f.remove);
  const clock = new FakeClock(f.state.createdAt); const password = 'synthetic-password-canary';
  const config = loadConfig(syntheticEnv(join(t.dir, 'data'), { R2_PASSWORD_HASH: await hashPassword(password, { ln: 10, r: 8, p: 1 }) }));
  const storage = openStorage(config.dbPath, clock); storage.setTimezone('Pacific/Auckland');
  let wrong = false; let clarify = false; let loseConfirm = false; let loseModel = false;
  const app = createApp({ config, storage, clock, logger: false, webRoot: join(t.dir, 'none'), modelInterpreter: { interpret: async (message) => {
    if (clarify) return { type: 'clarify', question: 'when?' };
    const m = /Remind me to (.+) at (\d{4}-\d\d-\d\dT\d\d:\d\d) in /.exec(message)!;
    return { type: 'one_off', text: wrong ? 'wrong' : m[1]!, localDateTime: m[2]! };
  } } }, [authPlugin, settingsPlugin, statusPlugin, pushPlugin, chatPlugin]);
  cleanups.push(async () => { await app.close(); storage.close(); });
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const res = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE', url: path, headers: init?.headers as Record<string, string>, ...(init?.body ? { payload: String(init.body) } : {}) });
    if (path === '/api/reminders/confirm' && loseConfirm) { loseConfirm = false; throw new Error('sensitive lost response'); }
    if (path === '/api/chat' && loseModel) { loseModel = false; throw new Error('sensitive lost model'); }
    const headers = new Headers(); for (const [k,v] of Object.entries(res.headers)) if (v !== undefined) for (const x of Array.isArray(v) ? v : [v]) headers.append(k, String(x));
    return new Response(res.body, { status: res.statusCode, headers });
  };
  const api = new AcceptanceApi('https://r2.example.ts.net', { fetch: transport }); await api.login(password);
  expect(sameSubscription(await api.push(), await api.push())).toBe(false);
  const sub = storage.replaceSubscription({ endpoint: 'https://example.invalid/push', p256dh: 'synthetic', auth: 'synthetic' });
  // Synthetic acceptance only; real push readiness routing is owned by chat/push integration tests.
  const pushTransport = { send: async () => ({ outcome: 'accepted' as const }) };
  if ((await pushTransport.send()).outcome === 'accepted') storage.markSubscriptionReady(sub.version);
  const lease = f.registry.acquire(installation, f.owner); lease.create(f.state);
  return { api, lease, storage, clock, cases: new AcceptanceCases(api, lease, clock), wrong: () => { wrong = true; }, clarify: () => { clarify = true; }, loseConfirm: () => { loseConfirm = true; }, loseModel: () => { loseModel = true; } };
}

it('uses actual authenticated routes, journals real IDs and replays a lost confirmation', async () => {
  const x = await setup(); const plan = makeCase('A', 1, 'Pacific/Auckland', x.clock.now(), 600_000);
  expect(await x.api.probe('anonymous')).toBe('unauthorized'); expect(await x.api.probe('bad-origin')).toBe('forbidden');
  expect(await x.cases.propose(plan)).toBe('proposed');
  expect(x.storage.listReminders()).toHaveLength(0);
  expect(x.lease.load().cases[0]?.proposalId).toMatch(/^prp_[\w-]{22}$/);
  expect(await proposalInList(x.api, x.lease.load().cases[0]!.proposalId!)).toBe('inconclusive');
  x.loseConfirm(); await expect(x.cases.confirm(plan.record.requestId)).rejects.toMatchObject({ code: 'network' });
  expect(x.lease.load().pending?.operation).toBe('confirm');
  expect(x.storage.listReminders()).toHaveLength(1);
  const r = await x.cases.reconcileConfirmation();
  expect(r.id).toMatch(/^rem_[\w-]{22}$/); expect(retained(x.lease.load().cases[0]!, r)).toBe(true);
  expect((await x.cases.repeatConfirmation(plan.record.requestId)).id).toBe(r.id);
  expect(x.storage.listReminders()).toHaveLength(1);
  expect((await findKnown(x.api, r.id))?.id).toBe(r.id);
  expect(await proposalInList(x.api, r.proposalId)).toBe('found');
  expect(sameSubscription(await x.api.push(), await x.api.push())).toBe(true);
  const report = jsonReport(x.lease.load()); expect(report).not.toContain(plan.text); expect(report).not.toContain('synthetic-password-canary');
  await x.api.logout(); await expect(x.api.settings()).rejects.toMatchObject({ code: 'unauthorized' });
});

it('clarifies without a saved row and blocks a wrong proposal before confirmation', async () => {
  const x = await setup(); x.clarify(); const p = makeCase('A', 1, 'Pacific/Auckland', x.clock.now(), 600_000);
  expect(await x.cases.propose(p)).toBe('clarify'); expect(x.storage.listReminders()).toHaveLength(0);
  const y = await setup(); y.wrong(); const q = makeCase('A', 1, 'Pacific/Auckland', y.clock.now(), 600_000);
  await expect(y.cases.propose(q)).rejects.toMatchObject({ code: 'invalid-proposal' });
  expect(y.lease.load().cases[0]?.phase).toBe('blocked'); expect(y.storage.listReminders()).toHaveLength(0);
});
it('keeps lost model response unresolved and does not claim no proposal was stored', async () => {
  const x = await setup(); const p = makeCase('B', 1, 'Pacific/Auckland', x.clock.now(), 600_000); x.loseModel();
  await expect(x.cases.propose(p)).rejects.toMatchObject({ code: 'network' });
  expect(x.lease.load().cases[0]?.phase).toBe('proposal-unresolved'); expect(x.lease.load().pending?.operation).toBe('propose');
  expect(x.storage.listReminders()).toHaveLength(0);
});
it('generates the selected zone across midnight and refuses a too-late confirmation', async () => {
  const x = await setup(); const p = makeCase('C', 1, 'Pacific/Auckland', Date.UTC(2027, 0, 1, 10, 50), 1200_000);
  expect(p.record.localDateTime.startsWith('2027-01-02')).toBe(true);
  const q = makeCase('A', 1, 'Pacific/Auckland', x.clock.now(), 180_000); await x.cases.propose(q);
  x.clock.advance(130_000); await expect(x.cases.confirm(q.record.requestId)).rejects.toMatchObject({ code: 'too-late' }); expect(x.storage.listReminders()).toHaveLength(0);
});
it('does not confuse unrelated rows or an attempted push with provider acceptance', async () => {
  const x = await setup(); const p = makeCase('A', 1, 'Pacific/Auckland', x.clock.now(), 600_000);
  await x.cases.propose(p); const r = await x.cases.confirm(p.record.requestId);
  expect(await findKnown(x.api, 'rem_abcdefghijklmnopqrstuv')).toBeNull();
  const original = await x.api.reminders(); const row = original.find(item => item.id === r.id)!;
  const startedAt = new Date(x.clock.now()).toISOString(); let calls = 0;
  const api = { reminders: async () => { calls++; return [{ ...row, state: 'scheduled' as const, acceptedAt: null, deliveryAttempts: [{ attemptNumber: 1, subscriptionVersion: 1, startedAt, finishedAt: null, outcome: 'started' as const }] }]; } } as unknown as AcceptanceApi;
  const start = x.clock.now();
  expect(await pollReminder(api, r.id, x.clock, { until: async at => { x.clock.t = at; } }, start + 400, 200)).toEqual({ kind: 'attempted', attemptAt: start, acceptedAt: null });
  expect(calls).toBe(3);
});
it('polls only the requested ID with a finite deadline', async () => {
  const x = await setup(); const p = makeCase('A', 1, 'Pacific/Auckland', x.clock.now(), 600_000);
  await x.cases.propose(p); const r = await x.cases.confirm(p.record.requestId);
  const start = x.clock.now(); const wait = { until: async (at: number) => { x.clock.t = at; } };
  expect(await pollReminder(x.api, r.id, x.clock, wait, start + 1000, 200)).toEqual({ kind: 'not-observed', attemptAt: null, acceptedAt: null });
});
