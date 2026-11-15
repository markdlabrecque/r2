import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { classifyOwner } from '../scripts/acceptance/contracts.ts';
import { afterEach } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import { AcceptanceRunner, type RunnerOptions, type RunnerPrompt } from '../scripts/acceptance/runner.ts';
import { AcceptanceApi } from '../scripts/acceptance/api.ts';
import { AcceptanceHost, type CommandRequest } from '../scripts/acceptance/host.ts';
import type { Journal, PromptOutcome } from '../scripts/acceptance/contracts.ts';
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
export async function rebootFixture(initialPause = false) {
  let writeFault: ((boundary: string) => void) | undefined;
  const t = tempDir(), f = fixture({ onWrite: b => writeFault?.(b) }); cleanups.push(t.cleanup, f.remove);
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
  write('/proc/sys/kernel/random/boot_id', f.owner.bootId + '\n', 0o444);
  let lease = f.registry.acquire(f.state.installation, f.owner); lease.create(f.state);
  let active = true, loaded = false, model = true, healthy = true;
  let commandFault: ((r: CommandRequest) => void) | undefined;
  const commands: string[] = [];
  const execute = async (r: CommandRequest) => {
    commandFault?.(r); const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (r.executable === '/usr/bin/systemctl') {
      const op = r.args[0]!;
      if (op === 'show') return ok(Object.entries({ Id: 'r2.service', FragmentPath: '/etc/systemd/system/r2.service', DropInPaths: loaded ? '/run/systemd/system/r2.service.d/90-r2-acceptance.conf' : '', User: 'r2', Group: 'r2', WorkingDirectory: '/opt/r2', EnvironmentFiles: '/etc/r2/r2.env (ignore_errors=no)' + (loaded ? ' /run/r2-acceptance-model.env (ignore_errors=no)' : ''), ExecStart: '{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/r2/dist/server/main.js ; ignore_errors=no ; pid=123 }', ReadWritePaths: '/var/lib/r2', ActiveState: active ? 'active' : 'inactive', UnitFileState: 'enabled', MainPID: active ? '123' : '0', Job: '0' }).map(([k,v]) => `${k}=${v}`).join('\n') + '\n');
      commands.push(op);
      if (op === 'reboot') return ok();
      if (op === 'daemon-reload') loaded = fs.existsSync(path('/run/systemd/system/r2.service.d/90-r2-acceptance.conf'));
      else if (op === 'stop') active = false;
      else if (op === 'restart' || op === 'start') { active = true; model = !loaded; }
      else throw Error('unexpected synthetic command');
      return ok();
    }
    if (r.executable === '/usr/bin/node') return ok('v24.20.0\n');
    if (r.executable === '/usr/bin/ss') return ok(active ? 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=123,fd=20))\n' : '');
    if (r.executable === '/usr/bin/timedatectl') return ok('yes\n');
    if (r.executable === '/usr/bin/tailscale' && r.args[0] === 'status') return ok('{"BackendState":"Running"}');
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
  return { runner, options, api, host, hostOptions, get lease() { return lease; }, storage, clock, requests, prompts, commands, path,
    registry: f.registry, password,
    writeFault: (fn: typeof writeFault) => { writeFault = fn; },
    boot: (id = randomUUID()) => {
      loaded = fs.existsSync(path('/run/systemd/system/r2.service.d/90-r2-acceptance.conf'));
      model = !loaded;
      fs.chmodSync(path('/proc/sys/kernel/random/boot_id'), 0o644);
      fs.writeFileSync(path('/proc/sys/kernel/random/boot_id'), id + '\n');
      fs.chmodSync(path('/proc/sys/kernel/random/boot_id'), 0o444);
      const old = lease.owner;
      lease = f.registry.takeoverStale(f.state.installation, old, { ...old, bootId: id, token: randomUUID(), processStart: '54321' },
        { inspect: owner => classifyOwner(owner, { bootId: id, processStart: '54321' }) });
      options.lease = lease;
    },
    edit: (fn: (s: Journal) => void) => { const s = lease.load(), seq = s.sequence; s.sequence++; s.updatedAt = Math.max(s.updatedAt, clock.now()); fn(s); lease.commit(s, seq); },
    reportPath: join(f.root, f.state.runId, 'report.md'),
    prompt: (p: typeof prompt) => { prompt = p; }, wrong: () => { wrong = true; }, unsupported: () => { unsupported = true; },
    fault: (fn: typeof apiFault) => { apiFault = fn; }, commandFault: (fn: typeof commandFault) => { commandFault = fn; },
    setActive: (v: boolean) => { active = v; }, setHealthy: (v: boolean) => { healthy = v; }, model: () => model,
    check: (id: string) => lease.load().checks.find(c => c.id === id),
  };
}
