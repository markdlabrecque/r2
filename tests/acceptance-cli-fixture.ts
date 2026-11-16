// Test-only process entrypoint. The installed CLI has no way to select these adapters.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { main, type CliAdapters } from '../scripts/acceptance/main.ts';
import { cleanupRebootFixtures, rebootFixture } from './acceptance-reboot-fixture.ts';

const scenario = process.argv[2] ?? '';
const x = await rebootFixture();
const id = x.lease.owner.runId;
const registryRoot = x.registry.root;
const flags = ['--non-production', '--allow-service-disruption'];
let signalled = false;
let declined = false;
let passwordCount = 0;
let processEpoch = 10000;
const adapters: CliAdapters = {
  host: x.host, registry: x.registry, api: x.api, clock: x.clock, wait: x.options.wait,
  processStart: pid => pid === process.pid ? String(processEpoch) : 'absent', interactive: () => true,
  passwordPrompt: async () => { passwordCount++; return x.password; },
  prompt: async r => {
    if ((scenario === 'sigint' || scenario === 'sigterm') && r.id === 'tabs-closed' && !signalled) {
      signalled = true; process.kill(process.pid, scenario === 'sigint' ? 'SIGINT' : 'SIGTERM');
      await new Promise<void>(resolve => setImmediate(resolve));
      return 'cancelled';
    }
    if (scenario === 'decline' && r.id === 'live-run' && !declined) { declined = true; return 'declined'; }
    if (scenario === 'no-display' && r.id === 'a-observed') return 'unavailable';
    return 'approved';
  },
};
const invoke = (args: string[]) => { processEpoch++; return main(args, adapters); };
try {
  if (scenario === 'preflight') {
    await x.api.logout();
    await invoke([]);
    assert.deepEqual(x.commands, []);
    assert.equal(passwordCount, 0);
    console.log('SYNTHETIC_FIXTURE_OK');
    process.exitCode = 0;
  } else {
  if (scenario === 'failure') {
    let failed = false;
    x.commandFault(request => { if (!failed && request.args[0] === 'daemon-reload') { failed = true; throw Error('PRIVATE_CANARY'); } });
  }
  if (scenario === 'reboot') await x.runner().run();
  if (scenario === 'recovery-stopped' || scenario === 'resume-stopped') {
    await x.api.logout();
    x.edit(s => { s.cleanup.status = 'restore-needed'; s.cleanup.serviceRestoreNeeded = true; });
    x.setActive(false);
  }
  if (!['recovery-stopped', 'resume-stopped'].includes(scenario)) x.lease.release();
  if (!['recovery-stopped', 'resume-stopped'].includes(scenario)) await x.api.logout();
  if (scenario === 'reboot') {
    await invoke(['--reboot', id, ...flags]);
    let state = JSON.parse(fs.readFileSync(`${registryRoot}/${id}/journal.json`, 'utf8'));
    assert.equal(state.reboot.phase, 'pending');
    assert.equal(x.commands.filter(c => c === 'reboot').length, 1);
    await x.api.logout();
    await assert.rejects(invoke(['--reboot-resume', id, ...flags]), { code: 'same-boot' });
    assert.equal(x.commands.filter(c => c === 'reboot').length, 1);
    const bootPath = x.path('/proc/sys/kernel/random/boot_id');
    fs.chmodSync(bootPath, 0o644); fs.writeFileSync(bootPath, '12345678-1234-1234-1234-123456789abc\n'); fs.chmodSync(bootPath, 0o444);
    x.clock.advance(800_000);
    await invoke(['--reboot-resume', id, ...flags]);
    await invoke(['--reboot-resume', id, ...flags]);
    state = JSON.parse(fs.readFileSync(`${registryRoot}/${id}/journal.json`, 'utf8'));
    assert.equal(state.reboot.phase, 'resumed');
    assert.ok(passwordCount >= 2);
    assert.equal(state.cases.filter((c: { label: string }) => c.label === 'reboot').length, 1);
    assert.equal(x.commands.filter(c => c === 'reboot').length, 1);
  } else {
    await invoke([scenario === 'recovery-stopped' ? '--recover' : '--resume', id, ...flags]);
    const state = JSON.parse(fs.readFileSync(`${registryRoot}/${id}/journal.json`, 'utf8'));
    assert.equal(state.cleanup.status, 'verified');
    assert.equal(x.model(), true);
    if (scenario === 'sigint' || scenario === 'sigterm') assert.equal(signalled, true);
    if (scenario === 'decline') assert.equal(x.storage.listReminders().length, 0);
    if (scenario === 'recovery-stopped' || scenario === 'resume-stopped') assert.ok(x.commands.includes('restart'));
    if (scenario === 'failure') assert.notEqual(state.checks.find((c: { id: string }) => c.id === 'coordination')?.status, 'pass');
    if (scenario === 'sigint' || scenario === 'sigterm') {
      const before = x.storage.listReminders().length;
      await invoke(['--resume', id, ...flags]);
      assert.equal(x.storage.listReminders().length, before);
    }
    if (scenario === 'no-display') {
      assert.equal(state.checks.find((c: { id: string }) => c.id === 'a-provider')?.status, 'pass');
      assert.equal(state.checks.find((c: { id: string }) => c.id === 'a-observed')?.status, 'blocked');
    }
    await invoke(['--export', id]);
    await invoke(['--recover', id, ...flags]);
  }
  const stateBytes = fs.readFileSync(`${registryRoot}/${id}/journal.json`, 'utf8');
  const report = fs.readFileSync(`${registryRoot}/${id}/report.md`, 'utf8') + fs.readFileSync(`${registryRoot}/${id}/report.json`, 'utf8');
  assert.doesNotMatch(stateBytes + report, /synthetic-password|PRIVATE_CANARY|https:\/\/|__Host-|push\.example|test\.synthetic/);
  if (scenario !== 'decline') assert.ok(passwordCount >= 1);
  console.log('SYNTHETIC_FIXTURE_OK');
  process.exitCode = 0;
  }
} finally { await cleanupRebootFixtures(); }
