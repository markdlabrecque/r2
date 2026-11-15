import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { AcceptanceReboot, type RebootOptions } from '../scripts/acceptance/reboot.ts';
import { AcceptanceHost } from '../scripts/acceptance/host.ts';
import { classifyOwner, validateJournal } from '../scripts/acceptance/contracts.ts';
import { jsonReport, projectReport } from '../scripts/acceptance/report.ts';
import { cleanupRebootFixtures, rebootFixture } from './acceptance-reboot-fixture.ts';

afterEach(cleanupRebootFixtures);

async function setup(paused = false) {
  const x = await rebootFixture(paused);
  await x.runner().run();
  const acknowledgements: string[] = [];
  const options = (): RebootOptions => ({ ...x.options, host: x.host, rebootCapability: true, interactive: () => true,
    acknowledgeResume: async runId => { acknowledgements.push(runId); return 'approved'; } });
  const reboot = (changes: Partial<RebootOptions> = {}) => new AcceptanceReboot({ ...options(), ...changes });
  return { ...x, get lease() { return x.lease; }, options: x.options, reboot, acknowledgements };
}

it.each([false, true])('integrates prepare/new boot/resume with all real adapters and original pause=%s', async paused => {
  const x = await setup(paused);
  x.commandFault(r => {
    if (r.args[0] !== 'reboot') return;
    const s = x.lease.load();
    expect(s.cleanup).toMatchObject({ status: 'verified', originalPause: paused, pauseRestoreNeeded: false, artifacts: [] });
    expect(s.pending?.operation).toBe('reboot'); expect(s.reboot?.phase).toBe('pending');
    expect(x.acknowledgements).toEqual([s.runId]);
    expect(x.prompts.at(-1)?.id).toBe('reboot');
    expect(x.storage.getSettings().notificationsPaused).toBe(paused);
    expect(fs.existsSync(x.path('/run/r2-acceptance-model.env'))).toBe(false);
    expect(r.args).toEqual(['reboot', '--no-ask-password']);
  });
  await x.reboot().prepare();
  const before = x.lease.load(), oldLease = x.lease;
  expect(before.reboot?.previousBootId).toBe(before.priorBootId);
  expect(before.cases.filter(c => c.label === 'reboot')).toHaveLength(1);
  expect(x.commands.filter(c => c === 'reboot')).toHaveLength(1);
  expect(() => oldLease.release()).toThrow();
  x.boot(); expect(() => oldLease.load()).toThrow();
  x.clock.advance(800_000);
  const result = await x.reboot().resume();
  expect(result.reboot?.submission).toBe('overdue-recovery');
  expect(x.check('reboot-changed')?.status).toBe('pass');
  expect(x.check('reboot-automatic-recovery')?.status).toBe('pass');
  expect(x.check('reboot-provider')?.status).toBe('pass');
  expect(x.check('reboot-observed')).toMatchObject({ status: 'pass', provenance: 'owner-reported' });
  expect(x.storage.getSettings().notificationsPaused).toBe(paused);
  expect(x.lease.load().cleanup.status).toBe('verified');
  const count = x.requests.length, commands = x.commands.length, reminders = x.storage.listReminders().length;
  await x.reboot().resume();
  expect(x.requests.slice(count).some(r => ['/api/chat', '/api/reminders/confirm'].includes(r.path))).toBe(false);
  expect(x.commands).toHaveLength(commands); expect(x.storage.listReminders()).toHaveLength(reminders);
  expect(x.storage.getSettings().notificationsPaused).toBe(paused);
  await expect(x.reboot().prepare()).rejects.toMatchObject({ code: 'conflict' });
  const bytes = jsonReport(x.lease.load()) + fs.readFileSync(x.reportPath, 'utf8') + JSON.stringify(x.lease.load());
  expect(bytes).not.toMatch(/synthetic-password|PRIVATE_CANARY|https:\/\/|__Host-|push\.example|test\.synthetic|R2 acceptance [a-f0-9]{8}-/);
  x.lease.release();
});

it('normal-window submission is separate from the owner display gate', async () => {
  const x = await setup(); await x.reboot().prepare(); x.boot();
  x.prompt(async r => r.id === 'reboot-observed' ? 'unavailable' : 'approved');
  const result = await x.reboot().resume();
  expect(result.reboot?.submission).toBe('normal-window');
  expect(x.check('reboot-provider')?.status).toBe('pass');
  expect(x.check('reboot-observed')).toMatchObject({ status: 'blocked', reason: 'unavailable' });
  expect(result.overall).toBe('blocked');
});

it.each(['mode', 'capability', 'disruption', 'tty', 'live-lock', 'wrong-boot-owner'])('blocks preparation without %s', async kind => {
  const x = await setup(); const count = x.requests.length;
  const changes: Partial<RebootOptions> = kind === 'mode' ? { mode: 'read-only' } : kind === 'capability' ? { rebootCapability: false } : kind === 'disruption' ? { hostDisruption: false } : kind === 'tty' ? { interactive: () => false } : {};
  if (kind === 'live-lock') {
    const s = x.lease.load(), old = x.lease.owner;
    expect(() => x.registry.takeoverStale(s.installation, old, { ...old, token: randomUUID() }, { inspect: o => classifyOwner(o, { bootId: old.bootId, processStart: old.processStart }) })).toThrow();
    x.lease.release();
  }
  if (kind === 'wrong-boot-owner') fs.chmodSync(x.path('/proc/sys/kernel/random/boot_id'), 0o644), fs.writeFileSync(x.path('/proc/sys/kernel/random/boot_id'), randomUUID()), fs.chmodSync(x.path('/proc/sys/kernel/random/boot_id'), 0o444);
  await expect(x.reboot(changes).prepare()).rejects.toThrow();
  expect(x.requests).toHaveLength(count); expect(x.commands).not.toContain('reboot');
});

it.each(['create-case', 'confirm-case', 'reboot', 'instructions'])('declined %s never reboots and restores normally', async kind => {
  const x = await setup(true); x.prompt(async r => r.id === kind ? 'declined' : 'approved');
  const r = x.reboot(kind === 'instructions' ? { acknowledgeResume: async () => 'declined' } : {});
  if (['create-case', 'confirm-case'].includes(kind)) await expect(r.prepare()).rejects.toThrow(); else await r.prepare();
  expect(x.commands).not.toContain('reboot');
  expect(x.storage.getSettings().notificationsPaused).toBe(true); expect(x.lease.load().cleanup.status).toBe('verified');
  if (kind === 'reboot' || kind === 'instructions') expect(x.lease.load().reboot?.phase).toBe('declined');
});

it('declined case preparation cannot hide reboot checks by later running ordinary completion', async () => {
  const x = await setup(); x.prompt(async r => r.id === 'create-case' ? 'declined' : 'approved');
  await expect(x.reboot().prepare()).rejects.toThrow();
  expect(x.lease.load().reboot).toBeNull();
  await x.runner().run();
  const result = projectReport(x.lease.load());
  expect(result.overall).toBe('blocked');
  expect(result.checks.filter(c => c.id.startsWith('reboot-')).every(c => c.required)).toBe(true);
  expect(() => x.edit(s => { delete s.coordinator!.rebootSelected; })).toThrow();
});

it.each(['before', 'create-case', 'confirm-case', 'instructions', 'approval'])('cancellation at %s never invokes reboot and retains safe state', async point => {
  const x = await setup(); const controller = new AbortController();
  if (point === 'before') controller.abort();
  x.prompt(async r => { if (r.id === (point === 'approval' ? 'reboot' : point)) controller.abort(); return 'approved'; });
  const r = x.reboot({ signal: controller.signal, ...(point === 'instructions' ? { acknowledgeResume: async () => { controller.abort(); return 'approved'; } } : {}) });
  await expect(r.prepare()).rejects.toThrow();
  expect(x.commands).not.toContain('reboot');
  expect(x.lease.load().cleanup.status).toBe('verified');
  expect(x.model()).toBe(true);
});

it('cancellation immediately after durable reboot intent does not issue the reboot command', async () => {
  const x = await setup(); const controller = new AbortController();
  const original = x.lease.beginMutation.bind(x.lease);
  x.lease.beginMutation = (input, seq) => {
    const result = original(input, seq);
    if (result.operation === 'reboot') controller.abort();
    return result;
  };
  await expect(x.reboot({ signal: controller.signal }).prepare()).rejects.toThrow();
  expect(x.commands).not.toContain('reboot');
  expect(x.lease.load().pending?.operation).toBe('reboot');
  expect(x.lease.load().cleanup.status).toBe('verified');
});

it('same boot cannot become reboot acceptance or repeat a reboot', async () => {
  const x = await setup(); await x.reboot().prepare();
  await expect(x.reboot().resume()).rejects.toMatchObject({ code: 'same-boot' });
  expect(x.check('reboot-changed')?.status).toBe('blocked');
  expect(x.lease.load().pending?.operation).toBe('reboot');
  await x.runner().recover(); expect(x.lease.load().pending?.operation).toBe('reboot');
  await x.runner().run(); expect(x.commands.filter(c => c === 'reboot')).toHaveLength(1);
});

it('inspects failed automatic startup before explicitly approved repair and retains failure', async () => {
  const x = await setup(); await x.reboot().prepare(); x.boot(); x.setActive(false);
  let inspected = false;
  x.commandFault(r => {
    if (r.args[0] === 'show') inspected = true;
    if (r.args[0] === 'restart') {
      expect(inspected).toBe(true);
      expect(x.check('reboot-automatic-recovery')?.status).toBe('fail');
      expect(x.lease.load().reboot?.resume?.automaticRecovery).toBe(false);
    }
  });
  const result = await x.reboot().resume();
  expect(result.overall).toBe('fail'); expect(x.check('reboot-provider')?.status).toBe('pass');
  expect(x.check('reboot-automatic-recovery')?.status).toBe('fail');
  await x.reboot().resume(); expect(x.check('reboot-automatic-recovery')?.status).toBe('fail');
});

it.each(['tailscale', 'serve', 'https', 'funnel', 'listener'])('records failed %s recovery without overwriting it later', async kind => {
  const x = await setup(); await x.reboot().prepare(); x.boot();
  let once = true;
  const host = new AcceptanceHost({ ...x.hostOptions, execute: async r => {
    const match = kind === 'tailscale' ? r.executable === '/usr/bin/tailscale' && r.args[0] === 'status'
      : kind === 'serve' || kind === 'funnel' ? r.executable === '/usr/bin/tailscale' && r.args[0] === 'serve'
      : kind === 'listener' ? r.executable === '/usr/bin/ss' : false;
    const result = await x.hostOptions.execute(r);
    if (match && once) {
      once = false;
      if (kind === 'tailscale') result.stdout = '{"BackendState":"Stopped"}';
      else if (kind === 'serve') result.stdout = '{}';
      else if (kind === 'funnel') result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), AllowFunnel: { 'test.synthetic.ts.net:443': true } });
      else result.stdout = 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=123,fd=20))\n';
    }
    return result;
  } });
  if (kind === 'https') x.fault((p, _m) => { if (p === '/api/settings' && once) { once = false; throw Error('PRIVATE_CANARY'); } });
  await x.reboot({ host }).resume();
  expect(x.check('reboot-changed')?.status).toBe('pass');
  expect(x.check('reboot-automatic-recovery')?.status).toBe('fail');
  await x.reboot().resume(); expect(x.check('reboot-automatic-recovery')?.status).toBe('fail');
});

it('a retained-time mismatch before repair is sticky and never authorizes temporary unpause', async () => {
  const x = await setup(true); await x.reboot().prepare(); x.boot();
  const reminders = x.api.reminders.bind(x.api);
  let mismatch = true;
  x.api.reminders = async () => (await reminders()).map(r => r.id === x.lease.load().cases.find(c => c.label === 'reboot')!.reminderId && mismatch
    ? { ...r, dueAt: new Date(Date.parse(r.dueAt) + 1000).toISOString() } : r);
  const count = x.requests.length;
  await expect(x.reboot().resume()).rejects.toThrow();
  expect(x.check('reboot-retained')?.status).toBe('fail');
  expect(x.requests.slice(count).some(r => r.method === 'PUT')).toBe(false);
  mismatch = false; await expect(x.reboot().resume()).rejects.toThrow();
  expect(x.check('reboot-retained')?.status).toBe('fail'); expect(x.storage.getSettings().notificationsPaused).toBe(true);
});

it('changed installation blocks inspection/repair and a stale uncertain lock cannot be taken', async () => {
  const x = await setup(); await x.reboot().prepare(); const s = x.lease.load(), old = x.lease.owner;
  expect(() => x.registry.takeoverStale(s.installation, old, { ...old, token: randomUUID() }, { inspect: () => 'uncertain' })).toThrow();
  x.boot(); fs.writeFileSync(x.path('/opt/r2/.r2-revision'), 'd'.repeat(40));
  const count = x.commands.length;
  await expect(x.reboot().resume()).rejects.toMatchObject({ code: 'unsafe-installation' });
  expect(x.commands).toHaveLength(count); expect(x.lease.load().pending?.operation).toBe('reboot');
});

it('reauthenticates in memory on resume and leaves original true pause restored after lost session', async () => {
  const x = await setup(true); await x.reboot().prepare(); x.boot(); await x.api.logout();
  let logins = 0; const reauthenticate = async () => { logins++; await x.api.login(x.password); };
  await x.reboot({ reauthenticate }).resume(); expect(logins).toBe(1);
  expect(x.storage.getSettings().notificationsPaused).toBe(true);
  expect(x.check('reboot-automatic-recovery')?.status).toBe('pass');
});

it('lost session during post-boot pause restoration reauthenticates without dropping the debt', async () => {
  const x = await setup(true); await x.reboot().prepare(); x.boot(); let logins = 0;
  x.prompt(async r => { if (r.id === 'reboot-observed') { await x.api.logout(); return 'unavailable'; } return 'approved'; });
  await x.reboot({ reauthenticate: async () => { logins++; await x.api.login(x.password); } }).resume();
  expect(logins).toBe(1); expect(x.storage.getSettings().notificationsPaused).toBe(true);
  expect(x.lease.load().cleanup).toMatchObject({ status: 'verified', pauseRestoreNeeded: false });
  expect(x.check('reboot-observed')?.status).toBe('blocked');
});

it('declined temporary unpause remains explicit and never changes the original true preference', async () => {
  const x = await setup(true); await x.reboot().prepare(); x.boot();
  x.prompt(async r => r.id === 'temporary-unpause' ? 'declined' : 'approved');
  const count = x.requests.length;
  await expect(x.reboot().resume()).rejects.toThrow();
  expect(x.check('reboot-provider')).toMatchObject({ status: 'blocked', reason: 'declined' });
  expect(x.storage.getSettings().notificationsPaused).toBe(true);
  expect(x.requests.slice(count).some(r => r.method === 'PUT')).toBe(false);
});

it('lost session without a caller credential callback is not an automatic recovery pass', async () => {
  const x = await setup(); await x.reboot().prepare(); x.boot(); await x.api.logout();
  await expect(x.reboot({ reauthenticate: undefined }).resume()).rejects.toThrow();
  expect(x.check('reboot-automatic-recovery')?.status).toBe('fail');
  expect(x.lease.load().reboot?.resume?.automaticRecovery).toBe(false);
});

it('a nonzero reboot command records failure without assuming it did not schedule a reboot', async () => {
  const x = await setup();
  const host = new AcceptanceHost({ ...x.hostOptions, execute: async r => r.args[0] === 'reboot' ? { code: 1, stdout: '', stderr: 'PRIVATE_CANARY' } : x.hostOptions.execute(r) });
  await expect(x.reboot({ host }).prepare()).rejects.toThrow();
  expect(x.lease.load().reboot?.phase).toBe('failed'); expect(x.lease.load().pending?.operation).toBe('reboot');
  expect(x.check('reboot-changed')?.status).toBe('blocked'); expect(x.lease.load().cleanup.status).toBe('verified');
  expect(jsonReport(x.lease.load())).not.toContain('PRIVATE_CANARY');
});

it.each(['before-command', 'after-command'])('uncertain crash %s retains intent for explicit new-boot resume', async boundary => {
  const x = await setup();
  const host = new AcceptanceHost({ ...x.hostOptions, execute: async r => {
    if (r.args[0] === 'reboot' && boundary === 'after-command') { await x.hostOptions.execute(r); throw Error('simulated death'); }
    return x.hostOptions.execute(r);
  }, boundary: n => { if (n === 'before-effect' && boundary === 'before-command') throw Error('simulated death'); } });
  await expect(x.reboot({ host }).prepare()).rejects.toThrow();
  expect(x.lease.load().pending?.operation).toBe('reboot');
  await expect(x.reboot().prepare()).rejects.toThrow();
  x.boot(); await x.reboot().resume(); expect(x.check('reboot-changed')?.status).toBe('pass');
  expect(x.commands.filter(c => c === 'reboot')).toHaveLength(boundary === 'before-command' ? 0 : 1);
});

it('prepared-only crash cannot prove scheduling or initiate reboot during resume', async () => {
  const x = await setup();
  await expect(x.reboot({ acknowledgeResume: async () => { throw Error('simulated death'); } }).prepare()).rejects.toThrow();
  expect(x.lease.load().reboot?.phase).toBe('prepared'); x.boot();
  await expect(x.reboot().resume()).rejects.toThrow(); expect(x.commands).not.toContain('reboot');
});

it.each(['missing', 'corrupt'])('blocks %s reboot checkpoints without host actions', async kind => {
  const x = await setup();
  if (kind === 'corrupt') {
    const file = x.reportPath.replace('report.md', 'journal.json'); fs.writeFileSync(file, '{bad');
  }
  const count = x.commands.length;
  await expect(x.reboot().resume()).rejects.toThrow(); expect(x.commands).toHaveLength(count);
});

it('restores original true pause when provider work fails after temporary unpause', async () => {
  const x = await setup(true); await x.reboot().prepare(); x.boot(); let unpaused = false;
  x.fault((path, method, after) => {
    if (path === '/api/notifications/pause' && method === 'PUT' && after && !x.storage.getSettings().notificationsPaused) unpaused = true;
    if (path === '/api/reminders' && unpaused) throw Error('PRIVATE_CANARY');
  });
  await expect(x.reboot().resume()).rejects.toThrow();
  expect(unpaused).toBe(true); expect(x.storage.getSettings().notificationsPaused).toBe(true);
  expect(x.lease.load().cleanup.status).toBe('verified');
});

it('refuses unresolved cleanup and preserves operator model-file conflicts', async () => {
  const x = await setup(); x.edit(s => { s.stage = 'reboot'; });
  await x.host.operate(x.lease, 'disable-model', { nonProduction: true, hostDisruption: true,
    approval: { runId: x.lease.load().runId, stage: 'reboot', operation: 'disable-model', outcome: 'approved' } });
  fs.appendFileSync(x.path('/run/r2-acceptance-model.env'), '# operator edit');
  await expect(x.reboot().prepare()).rejects.toThrow();
  expect(x.commands).not.toContain('reboot'); expect(fs.readFileSync(x.path('/run/r2-acceptance-model.env'), 'utf8')).toContain('operator edit');
  expect(x.lease.load().cleanup.status).toBe('conflict');
});

it('slow final host inspection rechecks the due window before issuing reboot', async () => {
  const x = await setup(); let approved = false;
  x.prompt(async r => { if (r.id === 'reboot') approved = true; return 'approved'; });
  x.commandFault(r => { if (approved && r.executable === '/usr/bin/timedatectl') x.clock.advance(900_000); });
  await expect(x.reboot().prepare()).rejects.toThrow();
  expect(x.commands).not.toContain('reboot'); expect(x.lease.load().pending?.operation).toBe('reboot');
});

it('late approval cannot schedule reboot or silently move the known due time', async () => {
  const x = await setup(); x.prompt(async r => { if (r.id === 'reboot') x.clock.advance(900_000); return 'approved'; });
  await expect(x.reboot().prepare()).rejects.toMatchObject({ code: 'missed-window' });
  expect(x.commands).not.toContain('reboot'); expect(x.lease.load().reboot?.phase).toBe('prepared');
});

it('strict resumed snapshot rejects unknown fields, unchanged boot and rewritten evidence', async () => {
  const x = await setup(); await x.reboot().prepare(); x.boot(); await x.reboot().resume();
  const s = x.lease.load();
  expect(() => validateJournal({ ...s, reboot: { ...s.reboot, hostname: 'PRIVATE_CANARY' } })).toThrow();
  expect(() => validateJournal({ ...s, reboot: { ...s.reboot, resume: { ...s.reboot!.resume, bootId: s.priorBootId } } })).toThrow();
  expect(() => x.edit(n => { n.reboot!.resume!.automaticRecovery = false; })).toThrow();
  expect(projectReport(s).reboot).not.toHaveProperty('bootId');
});

it.each((['prepared', 'pending'] as const).flatMap(phase =>
  ['temp-created', 'temp-synced', 'renamed', 'directory-synced'].map(boundary => ({ phase, boundary }))))(
  'atomic crash at $phase checkpoint/$boundary never schedules after uncertain persistence', async ({ phase, boundary }) => {
    const x = await setup(); let armed = false, tripped = false;
    const commit = x.lease.commit.bind(x.lease), begin = x.lease.beginMutation.bind(x.lease);
    x.lease.commit = (input, seq) => {
      if ((input as { reboot?: { phase: string } }).reboot?.phase === 'prepared' && phase === 'prepared') armed = true;
      return commit(input, seq);
    };
    x.lease.beginMutation = (input, seq) => {
      if ((input as { pending?: { operation: string } }).pending?.operation === 'reboot' && phase === 'pending') armed = true;
      return begin(input, seq);
    };
    x.writeFault(b => { if (armed && !tripped && b === boundary) { tripped = true; throw Error('synthetic crash'); } });
    await expect(x.reboot().prepare()).rejects.toThrow();
    x.writeFault(undefined); expect(tripped).toBe(true); expect(x.commands).not.toContain('reboot');
    expect(() => x.lease.load()).not.toThrow();
    if (x.lease.load().pending?.operation === 'reboot') { x.boot(); await x.reboot().resume(); }
    expect(x.commands).not.toContain('reboot');
});

it.each(['temp-created', 'temp-synced', 'renamed', 'directory-synced'])('resumes idempotently after interrupted automatic-recovery snapshot at %s', async boundary => {
  const x = await setup(); await x.reboot().prepare(); x.boot(); let armed = false, tripped = false;
  const resolve = x.lease.resolveRecovery.bind(x.lease);
  x.lease.resolveRecovery = (input, seq, id) => { if ((input as { reboot?: { phase: string } }).reboot?.phase === 'resumed') armed = true; return resolve(input, seq, id); };
  x.writeFault(b => { if (armed && !tripped && b === boundary) { tripped = true; throw Error('synthetic crash'); } });
  await expect(x.reboot().resume()).rejects.toThrow(); x.writeFault(undefined);
  const count = x.storage.listReminders().length;
  await x.reboot().resume(); expect(x.storage.listReminders()).toHaveLength(count);
  expect(x.check('reboot-automatic-recovery')?.status).toBe('pass');
  expect(x.commands.filter(c => c === 'reboot')).toHaveLength(1);
});

it('host reboot still enforces actual privilege/TTY and consumes scoped approval objects', async () => {
  const x = await setup(); await x.reboot().prepare();
  const authority = { nonProduction: true, hostDisruption: true, approval: { runId: x.lease.load().runId, stage: 'reboot' as const, operation: 'reboot' as const, outcome: 'approved' as const } };
  for (const facts of [{ privileged: () => false }, { interactive: () => false }]) {
    await expect(new AcceptanceHost({ ...x.hostOptions, ...facts }).reboot(x.lease, authority)).rejects.toMatchObject({ code: 'unauthorized' });
  }
  const before = x.commands.length;
  await x.host.reboot(x.lease, authority);
  await expect(x.host.reboot(x.lease, authority)).rejects.toMatchObject({ code: 'unauthorized' });
  expect(x.commands.length - before).toBe(1);
});

it('old-boot recovery reconciles vanished runtime artifacts without recreating model-disable files', async () => {
  const x = await setup(); x.edit(s => { s.stage = 'reboot'; });
  await x.host.operate(x.lease, 'disable-model', { nonProduction: true, hostDisruption: true,
    approval: { runId: x.lease.load().runId, stage: 'reboot', operation: 'disable-model', outcome: 'approved' } });
  fs.rmSync(x.path('/run'), { recursive: true }); x.boot();
  // This interruption preceded reboot preparation, so there is no checkpoint to accept.
  await expect(x.reboot().resume()).rejects.toThrow();
  await x.runner().recover();
  expect(x.lease.load().cleanup).toMatchObject({ status: 'verified', artifacts: [], serviceRestoreNeeded: false, daemonReloadNeeded: false });
  expect(x.model()).toBe(true); expect(fs.existsSync(x.path('/run'))).toBe(false);
  expect(x.commands).not.toContain('reboot');
});

it('preparation restores actual pause and model debt before checkpoint/command', async () => {
  const x = await setup(true); x.edit(s => { s.stage = 'reboot'; });
  await x.host.operate(x.lease, 'disable-model', { nonProduction: true, hostDisruption: true,
    approval: { runId: x.lease.load().runId, stage: 'reboot', operation: 'disable-model', outcome: 'approved' } });
  x.edit(s => { s.cleanup.pauseRestoreNeeded = true; }); await x.api.pause(false);
  const before = x.commands.length;
  x.commandFault(r => { if (r.args[0] === 'reboot') {
    expect(x.model()).toBe(true); expect(x.storage.getSettings().notificationsPaused).toBe(true);
    expect(x.lease.load().cleanup.status).toBe('verified');
  } });
  await x.reboot().prepare();
  expect(x.commands.slice(before)).toEqual(['daemon-reload', 'restart', 'reboot']);
});

it('late normal submission retains provider acceptance but blocks overall timing evidence', async () => {
  const x = await setup(); await x.reboot().prepare(); x.boot();
  const wait = x.options.wait;
  const result = await x.reboot({ wait: { until: async at => { await wait.until(at + 90_000); } } }).resume();
  expect(x.check('reboot-provider')?.status).toBe('pass');
  expect(result.reboot?.submission).toBe('missed-window'); expect(result.overall).toBe('blocked');
});

it('an unjournaled operator pause change after boot is a conflict, not permission to unpause', async () => {
  const x = await setup(); await x.reboot().prepare(); x.boot(); await x.api.pause(true);
  const before = x.requests.length;
  await expect(x.reboot().resume()).rejects.toThrow();
  expect(x.storage.getSettings().notificationsPaused).toBe(true);
  expect(x.requests.slice(before).some(r => r.method === 'PUT')).toBe(false);
  expect(x.lease.load().cleanup.status).toBe('conflict');
});

it('originally paused resume holds pause through due and restores after an explicitly approved overdue test', async () => {
  const x = await setup(true); await x.reboot().prepare(); x.boot();
  const dueAt = x.lease.load().cases.find(c => c.label === 'reboot')!.dueAt;
  x.prompt(async r => { if (r.id === 'temporary-unpause') {
    expect(x.clock.now()).toBeGreaterThan(dueAt);
    expect(x.storage.getSettings().notificationsPaused).toBe(true);
  } return 'approved'; });
  const result = await x.reboot().resume();
  expect(result.reboot?.submission).toBe('overdue-recovery');
  expect(x.storage.getSettings().notificationsPaused).toBe(true);
});

it('known confirmed reboot case is reused without another model or confirmation call', async () => {
  const x = await setup();
  const { AcceptanceCases, makeCase } = await import('../scripts/acceptance/cases.ts');
  const cases = new AcceptanceCases(x.api, x.lease, x.clock);
  const plan = makeCase('reboot', 1, 'Pacific/Auckland', x.clock.now(), 600_000);
  await cases.propose(plan); await cases.confirm(plan.record.requestId);
  const count = x.requests.length; await x.reboot().prepare();
  expect(x.requests.slice(count).some(r => ['/api/chat', '/api/reminders/confirm'].includes(r.path))).toBe(false);
  expect(x.lease.load().cases.filter(c => c.label === 'reboot')).toHaveLength(1);
});
