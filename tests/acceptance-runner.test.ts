import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import { AcceptanceRunner, type RunnerOptions, type RunnerPrompt } from '../scripts/acceptance/runner.ts';
import { AcceptanceApi } from '../scripts/acceptance/api.ts';
import { AcceptanceHost, type CommandRequest } from '../scripts/acceptance/host.ts';
import { AcceptanceCases, makeCase } from '../scripts/acceptance/cases.ts';
import type { Journal, PromptOutcome } from '../scripts/acceptance/contracts.ts';
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
import { DeliveryWorker } from '../src/worker.ts';
import { FakeClock, syntheticEnv, tempDir } from './helpers.ts';
import { fixture } from './acceptance-fixtures.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const vapid = generateVAPIDKeys();
async function setup(initialPause = false) {
  const t = tempDir(), f = fixture(); cleanups.push(t.cleanup, f.remove);
  const clock = new FakeClock(f.state.createdAt);
  const path = (p: string) => join(t.dir, 'host', p);
  const write = (p: string, bytes: string, mode = 0o644) => { fs.mkdirSync(dirname(path(p)), { recursive: true, mode: 0o755 }); fs.writeFileSync(path(p), bytes, { mode }); };
  fs.mkdirSync(path('/run/systemd/system'), { recursive: true });
  fs.mkdirSync(path('/var/lib/r2'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path('/etc/r2'), { recursive: true, mode: 0o700 });
  write('/etc/r2/r2.env', 'PRIVATE_CANARY_UNREAD', 0o600);
  write('/etc/systemd/system/r2.service', fs.readFileSync(new URL('../deploy/r2.service', import.meta.url), 'utf8'));
  write('/opt/r2/.r2-revision', 'b'.repeat(40)); write('/etc/machine-id', 'c'.repeat(32)); write('/usr/bin/node', 'synthetic', 0o755);
  fs.mkdirSync(path('/proc/123'), { recursive: true }); fs.symlinkSync('/usr/bin/node', path('/proc/123/exe'));
  f.state.installation.hostFingerprint = createHash('sha256').update('c'.repeat(32)).digest('hex');
  f.state.optionalChecks = ['reboot-changed', 'reboot-automatic-recovery', 'reboot-retained', 'reboot-provider', 'reboot-observed'];
  const lease = f.registry.acquire(f.state.installation, f.owner); lease.create(f.state);
  let active = true, loaded = false, model = true, healthy = true;
  let commandFault: ((r: CommandRequest) => void) | undefined;
  const commands: string[] = [];
  const execute = async (r: CommandRequest) => {
    commandFault?.(r); const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (r.executable === '/usr/bin/systemctl') {
      const op = r.args[0]!;
      if (op === 'show') return ok(Object.entries({ Id: 'r2.service', FragmentPath: '/etc/systemd/system/r2.service', DropInPaths: loaded ? '/run/systemd/system/r2.service.d/90-r2-acceptance.conf' : '', User: 'r2', Group: 'r2', WorkingDirectory: '/opt/r2', EnvironmentFiles: '/etc/r2/r2.env (ignore_errors=no)' + (loaded ? ' /run/r2-acceptance-model.env (ignore_errors=no)' : ''), ExecStart: '{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/r2/dist/server/main.js ; ignore_errors=no ; pid=123 }', ReadWritePaths: '/var/lib/r2', ActiveState: active ? 'active' : 'inactive', UnitFileState: 'enabled', MainPID: active ? '123' : '0', Job: '0' }).map(([k,v]) => `${k}=${v}`).join('\n') + '\n');
      commands.push(op);
      if (op === 'daemon-reload') loaded = fs.existsSync(path('/run/systemd/system/r2.service.d/90-r2-acceptance.conf'));
      else if (op === 'stop') active = false;
      else if (op === 'restart' || op === 'start') { active = true; model = !loaded; }
      else throw Error('unexpected synthetic command');
      return ok();
    }
    if (r.executable === '/usr/bin/node') return ok('v24.20.0\n');
    if (r.executable === '/usr/bin/ss') return ok(active ? 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=123,fd=20))\n' : '');
    if (r.executable === '/usr/bin/timedatectl') return ok('yes\n');
    if (r.executable === '/usr/bin/tailscale' && r.args[0] === 'status') return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'test.synthetic.ts.net.' } }));
    if (r.executable === '/usr/bin/tailscale') return ok(JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'test.synthetic.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }));
    if (r.executable === '/usr/bin/curl') return ok(healthy ? '{"status":"ok"}' : '{"status":"error"}');
    throw Error('unexpected synthetic command');
  };
  const hostOptions = { root: path('/'), execute, clock, privileged: () => true, interactive: () => true, rootUid: process.getuid!(), serviceUid: process.getuid!(), boundary: undefined as ((name: string) => void) | undefined };
  // root must be normalized, unlike path('/') which may retain a trailing slash.
  hostOptions.root = join(t.dir, 'host');
  const host = new AcceptanceHost(hostOptions);
  const password = 'synthetic-password-canary';
  const config = loadConfig(syntheticEnv(join(t.dir, 'data'), { R2_PASSWORD_HASH: await hashPassword(password, { ln: 10, r: 8, p: 1 }), OPENAI_API_KEY: 'synthetic-key', OPENAI_MODEL: 'synthetic-model', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:owner@example.com' }));
  const storage = openStorage(config.dbPath, clock); storage.setTimezone('Pacific/Auckland'); storage.setNotificationsPaused(initialPause);
  storage.replaceSubscription({ endpoint: 'https://push.example.test/synthetic', p256dh: 'synthetic', auth: 'synthetic' }); storage.markSubscriptionReady(1);
  const pushTransport = { send: async () => ({ outcome: 'accepted' as const }) };
  const worker = new DeliveryWorker({ storage, clock, pushTransport });
  let wrong = false, unsupported = false;
  const makeApp = () => {
    config.chat.enabled = model;
    return createApp({ config, storage, clock, worker, pushTransport, logger: false, webRoot: join(t.dir, 'none'), ...(model ? { modelInterpreter: { interpret: async (message: string) => {
      if (message === 'Remind me about something.') return { type: 'clarify' as const, question: 'when?' };
      if (unsupported) return { type: 'unsupported' as const, reason: 'synthetic refusal' };
      const m = /Remind me to (.+) at (\d{4}-\d\d-\d\dT\d\d:\d\d) in /.exec(message)!;
      return { type: 'one_off' as const, text: wrong ? 'wrong interpretation' : m[1]!, localDateTime: m[2]! };
    } } } : {}) }, [authPlugin, settingsPlugin, statusPlugin, pushPlugin, chatPlugin]);
  };
  let app = makeApp(), appModel = model;
  cleanups.push(async () => { await app.close(); storage.close(); });
  const requests: { method: string; path: string }[] = [];
  let apiFault: ((path: string, method: string, after: boolean) => void) | undefined;
  const transport: typeof fetch = async (url, init) => {
    const p = new URL(String(url)).pathname, method = init?.method ?? 'GET'; requests.push({ method, path: p });
    apiFault?.(p, method, false);
    if (!active) throw Error('synthetic stopped service');
    if (appModel !== model) { await app.close(); app = makeApp(); appModel = model; }
    await worker.runOnce();
    const res = await app.inject({ method: method as 'GET' | 'POST' | 'PUT' | 'DELETE', url: p, headers: init?.headers as Record<string,string>, ...(init?.body ? { payload: String(init.body) } : {}) });
    apiFault?.(p, method, true);
    const headers = new Headers(); for (const [k,v] of Object.entries(res.headers)) if (v !== undefined) for (const x of Array.isArray(v) ? v : [v]) headers.append(k, String(x));
    return new Response(res.body, { status: res.statusCode, headers });
  };
  const api = new AcceptanceApi('https://r2.example.ts.net', { fetch: transport }); await api.login(password);
  let prompt: (r: RunnerPrompt) => Promise<PromptOutcome> = async () => 'approved';
  const prompts: RunnerPrompt[] = [];
  const options: RunnerOptions = { api, host, lease, clock, mode: 'non-production-live', hostDisruption: true, wait: { until: async at => { clock.t = Math.max(clock.t, at); if (active) await worker.runOnce(); } }, prompt: async r => { prompts.push(r); return prompt(r); }, reauthenticate: () => api.login(password) };
  const runner = () => new AcceptanceRunner(options);
  return { runner, options, api, host, hostOptions, lease, storage, clock, requests, prompts, commands, path, reportPath: join(f.root, f.state.runId, 'report.md'),
    prompt: (p: typeof prompt) => { prompt = p; }, wrong: () => { wrong = true; }, unsupported: () => { unsupported = true; },
    fault: (fn: typeof apiFault) => { apiFault = fn; }, commandFault: (fn: typeof commandFault) => { commandFault = fn; },
    setActive: (v: boolean) => { active = v; }, setHealthy: (v: boolean) => { healthy = v; }, model: () => model,
    check: (id: string) => lease.load().checks.find(c => c.id === id),
  };
}

it.each([false, true])('runs A/B/C with real host/API/case adapters and restores original pause=%s', async initial => {
  const x = await setup(initial); const r = await x.runner().run();
  expect('overall' in r && r.overall, JSON.stringify(r)).toBe('pass');
  expect(x.lease.load().coordinator?.completed).toEqual(['preflight', 'browser', 'case-a', 'case-b', 'case-c', 'devices']);
  expect(x.storage.listReminders()).toHaveLength(3); expect(x.storage.getSettings().notificationsPaused).toBe(initial);
  expect(x.model()).toBe(true); expect(x.lease.load().cleanup.status).toBe('verified');
  expect(x.commands).toEqual(['daemon-reload', 'restart', 'daemon-reload', 'restart', 'stop', 'daemon-reload', 'start', 'daemon-reload', 'restart', 'restart']);
  for (const id of ['a-provider','a-observed','a-timing','b-model-disabled','b-retained','b-provider','c-pause-retained','c-no-attempt','c-retained','c-provider']) expect(x.check(id)?.status).toBe('pass');
  expect(x.check('a-observed')?.provenance).toBe('owner-reported');
  expect(x.lease.load().cases.filter(c => c.reminderId).every(c => c.attemptAt !== null && c.acceptedAt !== null)).toBe(true);
  const count = x.requests.length; await x.runner().run();
  expect(x.requests.slice(count).some(r => r.path === '/api/chat' || r.path === '/api/reminders/confirm')).toBe(false);
  expect(jsonReport(x.lease.load())).not.toMatch(/synthetic-password|PRIVATE_CANARY|prp_|rem_|https:\/\//);
  expect(fs.existsSync(x.reportPath)).toBe(true);
});

it('read-only only inspects and performs an anonymous safe probe', async () => {
  const x = await setup(); x.options.mode = 'read-only'; x.requests.length = 0;
  expect(await x.runner().run()).toEqual({ ready: true, anonymousDenied: true });
  expect(x.requests).toEqual([{ method: 'GET', path: '/api/settings' }]); expect(x.commands).toEqual([]); expect(x.prompts).toEqual([]);
});
it.each(['flag', 'inactive', 'timezone', 'live-refusal', 'approval'])('gates mutations for %s', async kind => {
  const x = await setup();
  if (kind === 'flag') x.options.hostDisruption = false;
  if (kind === 'inactive') x.setActive(false);
  if (kind === 'timezone') { const old = x.api.settings.bind(x.api); x.api.settings = async () => ({ ...await old(), timezone: null }); }
  if (kind === 'live-refusal') x.prompt(async () => 'declined');
  if (kind === 'approval') x.prompt(async r => r.id === 'disable-model' ? 'declined' : 'approved');
  const report = await x.runner().run(); expect('overall' in report && report.overall).not.toBe('pass');
  expect(x.commands).toEqual([]);
  if (kind !== 'approval') expect(x.storage.listReminders()).toHaveLength(0);
});
it.each(['test-observed', 'generic-wording', 'click-through', 'a-observed', 'b-observed', 'c-observed', 'outside-tailnet-denied', 'excluded-client-denied', 'second-device-observed'])('keeps %s independent from provider acceptance', async id => {
  const x = await setup(); x.prompt(async r => r.id === id ? 'unavailable' : 'approved');
  const r = await x.runner().run(); expect('overall' in r && r.overall).not.toBe('pass');
  expect(x.check(id)).toMatchObject({ status: 'blocked', provenance: 'owner-reported', reason: 'unavailable' });
  expect(x.storage.getSettings().notificationsPaused).toBe(false); expect(x.model()).toBe(true); expect(x.lease.load().cleanup.status).toBe('verified');
});
it('accepted but explicitly not displayed is a failure, not a yes-default pass', async () => {
  const x = await setup(true); x.prompt(async r => r.id === 'a-observed' ? 'declined' : 'approved');
  const r = await x.runner().run(); expect('overall' in r && r.overall).toBe('fail');
  expect(x.check('a-provider')?.status).toBe('pass'); expect(x.check('a-observed')?.status).toBe('fail');
  expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.model()).toBe(true);
});
it('late human actions cannot establish normal submission timing', async () => {
  const x = await setup(); x.prompt(async r => { if (r.id === 'tabs-closed') x.clock.advance(700_000); return 'approved'; });
  await x.runner().run(); expect(x.check('a-timing')).toMatchObject({ status: 'blocked', reason: 'missed-window' });
  expect(x.check('a-provider')?.status).toBe('pass');
});
it.each(['wrong', 'unsupported', 'expired'])('retains %s case outcome without silently creating a replacement', async kind => {
  const x = await setup(true);
  if (kind === 'wrong') x.wrong();
  if (kind === 'unsupported') x.unsupported();
  if (kind === 'expired') x.prompt(async r => { if (r.id === 'confirm-case') x.clock.advance(900_000); return 'approved'; });
  await x.runner().run(); const count = x.lease.load().cases.length;
  await x.runner().run(); expect(x.lease.load().cases).toHaveLength(count); expect(x.storage.listReminders()).toHaveLength(0);
  expect(x.storage.getSettings().notificationsPaused).toBe(true);
});
it('restores after lost confirmation and resumes without recreating known cases', async () => {
  const x = await setup(true); let lost = false;
  x.fault((path, _method, after) => { if (!lost && path === '/api/reminders/confirm' && after) { lost = true; throw Error('PRIVATE_CANARY'); } });
  await x.runner().run(); expect(x.storage.listReminders()).toHaveLength(1); expect(x.lease.load().pending).toBeNull();
  expect(x.lease.load().cases.at(-1)?.phase).toBe('confirmed');
  const count = x.requests.filter(r => r.path === '/api/chat').length;
  await x.runner().run(); expect(x.requests.filter(r => r.path === '/api/chat')).toHaveLength(count);
  expect(x.storage.getSettings().notificationsPaused).toBe(true);
});
it('lost model intent survives cleanup and needs deliberate owner retry', async () => {
  const x = await setup(true); let lost = false;
  x.fault((path, _method, after) => { if (!lost && path === '/api/chat' && after) { lost = true; throw Error('PRIVATE_CANARY'); } });
  await x.runner().run(); expect(x.lease.load().pending?.operation).toBe('propose');
  expect(x.storage.getSettings().notificationsPaused).toBe(true);
  await x.runner().run(); expect(x.storage.listReminders()).toHaveLength(0);
  const old = x.lease.load().cases[0]!; await x.runner().retryStage();
  expect(x.lease.load().cases[0]).toMatchObject({ requestId: old.requestId, phase: 'blocked', reason: 'interrupted' });
  await x.runner().run(); expect(x.storage.listReminders()).toHaveLength(3); expect(x.lease.load().cases[0]?.requestId).toBe(old.requestId);
});
it('session loss during pause restore permits in-memory reauthentication without losing intent', async () => {
  const x = await setup(true); let once = false;
  x.prompt(async r => { if (r.id === 'a-observed' && !once) { once = true; await x.api.logout(); } return 'approved'; });
  await x.runner().run(); expect(x.check('cleanup')?.status).toBe('pass'); expect(x.storage.getSettings().notificationsPaused).toBe(true);
  expect(x.requests.filter(r => r.path === '/api/session' && r.method === 'POST').length).toBeGreaterThan(1);
});
it('unavailable reauthentication retains original pause and restoration intent for recover', async () => {
  const x = await setup(true); x.options.reauthenticate = undefined;
  x.prompt(async r => { if (r.id === 'a-observed') await x.api.logout(); return 'approved'; });
  await x.runner().run(); expect(x.lease.load().cleanup).toMatchObject({ originalPause: true, pauseRestoreNeeded: true, status: 'failed' });
  expect(() => x.lease.release()).toThrow();
  x.options.reauthenticate = async () => x.api.login('synthetic-password-canary');
  await x.runner().recover(); expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.lease.load().cleanup.status).toBe('verified');
});
it('cancellation at a human checkpoint restores model and pause and exports progress', async () => {
  const x = await setup(true), abort = new AbortController();
  x.prompt(async r => { if (r.id === 'tabs-closed') abort.abort(); return 'approved'; });
  await x.runner().run(abort.signal); expect(x.model()).toBe(true); expect(x.storage.getSettings().notificationsPaused).toBe(true);
  expect(x.check('coordination')?.reason).toBe('interrupted'); expect(x.check('cleanup')?.status).toBe('pass');
});
it('provider failure is bounded without real sleeps or fabricated display', async () => {
  const x = await setup(); x.options.wait = { until: async at => { x.clock.t = at; } };
  // No worker submissions can be observed after due in this synthetic API fixture.
  const original = x.api.reminders.bind(x.api);
  x.api.reminders = async () => (await original()).map(r => ({ ...r, state: 'scheduled', acceptedAt: null, attempts: 0, deliveryAttempts: [] }));
  await x.runner().run(); expect(x.check('a-provider')).toMatchObject({ status: 'fail', reason: 'timeout' });
  expect(x.check('a-observed')).toBeUndefined(); expect(x.model()).toBe(true);
});
it('recipient replacement on a second device is a failure even with affirmative owner answers', async () => {
  const x = await setup(); x.prompt(async r => { if (r.id === 'second-device') x.storage.replaceSubscription({ endpoint: 'https://push.example.test/other', p256dh: 'synthetic', auth: 'synthetic' }); return 'approved'; });
  await x.runner().run(); expect(x.check('recipient-unchanged')?.status).toBe('fail');
});
it('conflicted owned artifacts are retained with failed cleanup and a held lock', async () => {
  const x = await setup(true); x.prompt(async r => { if (r.id === 'tabs-closed') fs.appendFileSync(x.path('/run/r2-acceptance-model.env'), '# operator change\n'); return 'approved'; });
  await x.runner().run(); expect(x.lease.load().cleanup.status).toBe('conflict'); expect(x.check('cleanup')?.status).toBe('fail');
  expect(fs.readFileSync(x.path('/run/r2-acceptance-model.env'), 'utf8')).toContain('operator change'); expect(() => x.lease.release()).toThrow();
  expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.lease.load().cleanup.pauseRestoreNeeded).toBe(false);
});
it('does not offer reboot authority before an independently confirmed future reboot case', async () => {
  const x = await setup(); await x.runner().run(); expect(() => x.runner().rebootCheckpoint()).toThrow();
  const plan = makeCase('reboot', 1, 'Pacific/Auckland', x.clock.now(), 600_000);
  const cases = new AcceptanceCases(x.api, x.lease, x.clock); await cases.propose(plan); await cases.confirm(plan.record.requestId);
  const checkpoint = x.runner().rebootCheckpoint(); expect(checkpoint).toMatchObject({ phase: 'prepared', caseRequestId: plan.record.requestId, previousBootId: x.lease.load().priorBootId });
  expect(x.commands).not.toContain('reboot'); expect(x.lease.load().reboot).toBeNull();
});

const apiMutations = [
  ...[1,2,3,4].map(n => ['/api/chat', 'POST', n] as const),
  ...[1,2,3,4].map(n => ['/api/reminders/confirm', 'POST', n] as const),
  ...[1,2,3,4,5,6,7,8].map(n => ['/api/notifications/pause', 'PUT', n] as const),
];
it.each(apiMutations.flatMap(([path, method, n]) => [false, true].map(after => ({ path, method, n, after }))))('recovers API boundary $method $path occurrence $n after=$after without extra cases', async target => {
  const x = await setup(true); let seen = 0, injected = false;
  x.fault((path, method, after) => {
    if (path === target.path && method === target.method && after === target.after && ++seen === target.n) { injected = true; throw Error('PRIVATE_CANARY_FAILURE'); }
  });
  const report = await x.runner().run(); expect(injected).toBe(true); expect('overall' in report && report.overall).not.toBe('pass');
  expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.model()).toBe(true);
  const before = x.storage.listReminders().map(r => r.id), chat = x.requests.filter(r => r.path === '/api/chat').length;
  await x.runner().run();
  expect(x.storage.listReminders().map(r => r.id)).toEqual(before); expect(x.requests.filter(r => r.path === '/api/chat')).toHaveLength(chat);
  if (x.lease.load().pending) expect(x.check('cleanup')?.status).toBe('fail');
  else expect(x.lease.load().cleanup.status).toBe('verified');
  expect(jsonReport(x.lease.load())).not.toContain('PRIVATE_CANARY');
});

it.each(['pause', 'propose', 'confirm', 'disable-model', 'restore-model', 'stop', 'restart'].flatMap(operation => [false, true].map(after => ({ operation, after }))))('handles journal intent $operation after=$after without unjournaled effects', async ({ operation, after }) => {
  const x = await setup(true), original = x.lease.beginMutation.bind(x.lease); let injected = false;
  x.lease.beginMutation = (input, seq) => {
    if (!injected && (input as Journal).pending?.operation === operation) {
      injected = true; if (after) original(input, seq); throw Error('PRIVATE_CANARY_JOURNAL');
    }
    return original(input, seq);
  };
  await x.runner().run(); expect(injected).toBe(true);
  expect(x.storage.getSettings().notificationsPaused).toBe(true);
  const s = x.lease.load();
  expect(s.cleanup.status === 'verified' || s.pending !== null || s.cleanup.status === 'failed' || s.cleanup.status === 'conflict').toBe(true);
  expect(x.model()).toBe(true);
  const before = x.storage.listReminders().map(r => r.id); await x.runner().run(); expect(x.storage.listReminders().map(r => r.id)).toEqual(before);
});

it.each(['before-intent','after-intent','before-container','after-container','before-create-model-environment','after-create-model-environment','before-create-model-drop-in','after-create-model-drop-in','before-reload','after-reload','before-service','after-service','before-remove-model-environment','after-remove-model-environment','before-remove-model-drop-in','after-remove-model-drop-in','before-cleanup-reload','after-cleanup-reload','before-cleanup-service','after-cleanup-service'])('coordinator restores after host interruption at %s', async boundary => {
  const x = await setup(true); let injected = false;
  x.hostOptions.boundary = name => { if (!injected && name === boundary) { injected = true; throw Error('synthetic interruption'); } };
  await x.runner().run(); expect(injected).toBe(true);
  // A failed normal restore can be retried in finally. No new scenario is started.
  expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.model()).toBe(true);
  expect(x.lease.load().cleanup.status).toBe('verified'); expect(x.lease.load().pending).toBeNull();
  expect(x.storage.listReminders()).toHaveLength(1);
});

it.each(['live-run','connect','firefox-permission','test-observed','generic-wording','click-through','create-case','confirm-case','temporary-unpause','disable-model','tabs-closed','a-observed','stop','b-observed','pause','restart','c-observed','second-device','second-device-observed','signed-out-denied','outside-tailnet-denied','excluded-client-denied'])('prompt failure at %s cannot be a pass and restores owned state', async id => {
  const x = await setup(true); let injected = false;
  x.prompt(async r => { if (!injected && r.id === id) { injected = true; throw Error('PRIVATE_CANARY_PROMPT'); } return 'approved'; });
  const report = await x.runner().run(); expect(injected).toBe(true); expect('overall' in report && report.overall).not.toBe('pass');
  expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.model()).toBe(true); expect(x.lease.load().cleanup.status).toBe('verified');
  expect(fs.existsSync(x.reportPath)).toBe(true);
});

it('a refused restore retains host debt but still restores pause independently', async () => {
  const x = await setup(true); x.prompt(async r => r.id === 'restore-model' ? 'declined' : 'approved');
  const report = await x.runner().run(); expect('overall' in report && report.overall).toBe('fail');
  expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.lease.load().cleanup).toMatchObject({ status: 'failed', pauseRestoreNeeded: false, serviceRestoreNeeded: true });
  expect(() => x.lease.release()).toThrow();
  x.prompt(async () => 'approved'); await x.runner().recover(); expect(x.lease.load().cleanup.status).toBe('verified'); expect(x.model()).toBe(true);
});
it('failed health verification remains recoverable and cannot pass cleanup', async () => {
  const x = await setup(true); x.prompt(async r => { if (r.id === 'a-observed') x.setHealthy(false); return 'approved'; });
  await x.runner().run(); expect(x.check('cleanup')?.status).toBe('fail'); expect(x.lease.load().cleanup.status).toBe('failed');
  expect(x.storage.getSettings().notificationsPaused).toBe(true);
  x.setHealthy(true); await x.runner().recover(); expect(x.lease.load().cleanup.status).toBe('verified');
});
it.each((['checkpointMutation', 'resolveRecovery'] as const).flatMap(method => (method === 'checkpointMutation' ? ['confirm', 'disable-model', 'restore-model'] : ['pause', 'propose', 'confirm', 'disable-model', 'restore-model']).flatMap(operation => [false, true].map(after => ({ method, operation, after })))))('preserves durable state for $method $operation after=$after', async ({ method, operation, after }) => {
  const x = await setup(true), original = x.lease[method].bind(x.lease); let injected = false;
  x.lease[method] = (input, seq, id) => {
    const previous = x.lease.load();
    if (!injected && previous.pending?.operation === operation) {
      injected = true; if (after) original(input, seq, id); throw Error('synthetic journal checkpoint failure');
    }
    return original(input, seq, id);
  };
  await x.runner().run();
  expect(injected).toBe(true); expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.model()).toBe(true);
  const before = x.storage.listReminders().map(r => r.id); await x.runner().run(); expect(x.storage.listReminders().map(r => r.id)).toEqual(before);
  expect(x.lease.load().cleanup.status === 'verified' || x.lease.load().pending !== null).toBe(true);
});
it.each(['preflight', 'browser', 'case-a', 'case-b', 'case-c', 'devices'].flatMap(stage => [false, true].map(after => ({ stage, after }))))('stage completion journal failure $stage after=$after never recreates a known case', async ({ stage, after }) => {
  const x = await setup(true), original = x.lease.commit.bind(x.lease); let injected = false;
  x.lease.commit = (input, seq) => {
    const next = input as Journal, old = x.lease.load();
    if (!injected && next.coordinator?.completed.includes(stage as Journal['stage']) && !old.coordinator?.completed.includes(stage as Journal['stage'])) {
      injected = true; if (after) original(input, seq); throw Error('synthetic stage completion interruption');
    }
    return original(input, seq);
  };
  await x.runner().run(); expect(injected).toBe(true); const before = x.storage.listReminders().map(r => r.id);
  await x.runner().run(); const now = x.storage.listReminders().map(r => r.id);
  expect(before.every(id => now.includes(id))).toBe(true); expect(now.length).toBeLessThanOrEqual(3);
  expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.model()).toBe(true);
});
it.each(['disable-model', 'stop', 'pause'])('rechecks due window after slow %s approval before mutating', async id => {
  const x = await setup(true); let delayed = false;
  x.prompt(async r => { if (!delayed && r.id === id) { delayed = true; x.clock.advance(900_000); } return 'approved'; });
  await x.runner().run(); expect(delayed).toBe(true); expect(x.check('coordination')?.reason).toBe('missed-window');
  if (id === 'disable-model') expect(x.commands).toEqual([]);
  if (id === 'stop') expect(x.commands).not.toContain('stop');
  if (id === 'pause') expect(x.check('c-pause-retained')).toBeUndefined();
  expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.model()).toBe(true);
});
it('rechecks timezone before stage mutations even after completed preflight', async () => {
  const x = await setup(true); const settings = x.api.settings.bind(x.api); let missing = false;
  x.api.settings = async () => ({ ...await settings(), ...(missing ? { timezone: null } : {}) });
  x.prompt(async r => { if (r.id === 'click-through') missing = true; return 'approved'; });
  await x.runner().run(); expect(x.storage.listReminders()).toHaveLength(0); expect(x.commands).toEqual([]); expect(x.storage.getSettings().notificationsPaused).toBe(true);
});
it('report preserves future synthetic case labels without exposing IDs', async () => {
  const x = await setup(); x.prompt(async r => r.id === 'disable-model' ? 'declined' : 'approved');
  const report = await x.runner().run();
  expect('remainingFutureCases' in report && report.remainingFutureCases).toEqual([{ label: 'A', caseNumber: 2, dueAt: x.lease.load().cases.at(-1)!.dueAt }]);
  expect('recoveryInstruction' in report && report.recoveryInstruction).toBe('stage');
});
it('shared lease concurrency is blocked and cancel() cooperates with cleanup', async () => {
  const x = await setup(true), runner = x.runner(); let concurrent = false;
  x.prompt(async r => { if (r.id === 'tabs-closed') { await expect(x.runner().run()).rejects.toThrow(); concurrent = true; runner.cancel(); } return 'approved'; });
  await runner.run(); expect(concurrent).toBe(true); expect(x.check('coordination')?.reason).toBe('interrupted');
  expect(x.model()).toBe(true); expect(x.storage.getSettings().notificationsPaused).toBe(true);
});
