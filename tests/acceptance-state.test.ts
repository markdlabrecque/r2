import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AcceptanceError, classifyOwner, validateJournal } from '../scripts/acceptance/contracts.ts';
import { AcceptanceRegistry, JournalLease, type WriteBoundary } from '../scripts/acceptance/state.ts';
import { fixture, installation, journal, syntheticCase } from './acceptance-fixtures.ts';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup(options: Parameters<typeof fixture>[0] = {}) { const f = fixture(options); fixtures.push(f); return f; }
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach(f => f.remove()); });
const canaries = ['password-SUPER-private', 'owner_session=COOKIE', 'https://private-host.tailnet.ts.net', 'KEY-super-private', 'remind me about private text', 'private-hostname'];
function errorOnly(fn: () => unknown, expected = 'invalid-state') {
  try { fn(); throw new Error('Expected rejection'); } catch (e) {
    expect(e).toBeInstanceOf(AcceptanceError); expect((e as AcceptanceError).code).toBe(expected);
    for (const c of canaries) expect(String(e)).not.toContain(c);
  }
}
describe('private journal', () => {
  it('round trips and resumes under a fresh process owner after explicit stale recovery', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner);
    f.state.cases.push(syntheticCase());
    expect(lease.create(f.state)).toEqual(f.state);
    expect(lease.load()).toEqual(f.state);
    const file = join(f.root, f.state.runId, 'journal.json');
    expect(lstatSync(f.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(f.root, f.state.runId)).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    f.registry.recoverStale(installation, f.owner, { inspect: () => 'stale' });
    const resumed = f.registry.acquire(installation, { ...f.owner, token: randomUUID(), processStart: '54321' });
    expect(resumed.load()).toEqual(f.state); resumed.release();
  });
  it.each([
    { version: 2 }, { extra: 'no' }, { runId: '../escape' }, { createdAt: -1 }, { updatedAt: Infinity },
    { priorBootId: 'host' }, { sequence: 0.5 }, { cases: [syntheticCase(), syntheticCase()] },
    { optionalChecks: ['a-observed'] },
  ])('rejects unknown versions/fields and invalid bounded values: %j', changes => {
    errorOnly(() => validateJournal({ ...journal(), ...changes }));
  });
  it('rejects malformed nested IDs, timestamps, reason strings, and arbitrary objects', () => {
    for (const changes of [{ requestId: 'a'.repeat(1000) }, { dueAt: NaN }, { timezone: 'secret' }, { localDateTime: 'text' }, { error: { body: 'private' } }]) {
      errorOnly(() => validateJournal({ ...journal(), cases: [{ ...syntheticCase(), ...changes }] }));
    }
    errorOnly(() => validateJournal({ ...journal(), checks: [{ id: 'https', status: 'fail', provenance: 'automated', reason: canaries[0], at: 1 }] }));
  });
  it('rejects canary extras before writing and never echoes them', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner); lease.create(f.state);
    for (const canary of canaries) for (const input of [
      { ...f.state, extra: canary },
      { ...f.state, cleanup: { ...f.state.cleanup, stderr: canary } },
      { ...f.state, cases: [{ ...syntheticCase(), text: canary }] },
    ]) errorOnly(() => lease.commit(input, 0));
    const bytes = readFileSync(join(f.root, f.state.runId, 'journal.json'), 'utf8');
    for (const c of canaries) expect(bytes).not.toContain(c);
  });
  it('corruption yields a generic error, with no content in message/cause', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner); lease.create(f.state);
    writeFileSync(join(f.root, f.state.runId, 'journal.json'), canaries.join(' '));
    errorOnly(() => lease.load());
  });
  it.each<WriteBoundary>(['temp-created', 'temp-synced', 'renamed', 'directory-synced'])('retains a complete old or new checkpoint at %s interruption', boundary => {
    let armed = false;
    const f = setup({ onWrite: b => { if (armed && b === boundary) throw new Error(canaries[0]); } });
    const lease = f.registry.acquire(installation, f.owner); lease.create(f.state); armed = true;
    errorOnly(() => lease.commit({ ...f.state, sequence: 1, stage: 'browser' }, 0), 'io'); armed = false;
    const recovered = lease.load();
    expect(recovered.sequence).toBe(['temp-created', 'temp-synced'].includes(boundary) ? 0 : 1);
    expect(recovered.stage).toBe(recovered.sequence === 0 ? 'preflight' : 'browser');
    if (boundary.startsWith('temp-')) expect(readdirSync(join(f.root, f.state.runId)).some(n => n.startsWith('.pending-'))).toBe(true);
  });
  it('enforces compare-and-swap and immutable case identities/times and original pause', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner);
    f.state.cases = [syntheticCase()]; f.state.cleanup.originalPause = true; lease.create(f.state);
    for (const changes of [{ cases: [] }, { cases: [{ ...f.state.cases[0]!, dueAt: 4 }] },
      { cleanup: { ...f.state.cleanup, originalPause: false } }, { optionalChecks: ['reboot-provider'] }, { priorBootId: randomUUID() }]) {
      errorOnly(() => lease.commit({ ...f.state, ...changes, sequence: 1 }, 0));
    }
    lease.commit({ ...f.state, sequence: 1 }, 0);
    errorOnly(() => lease.commit({ ...f.state, sequence: 1 }, 0));
  });
  it('retains old retry cases and checkpoints confirmation identity before effects', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner);
    const old = syntheticCase(); old.phase = 'blocked'; old.reason = 'invalid-response'; f.state.cases = [old]; lease.create(f.state);
    const retry = { ...syntheticCase(), caseNumber: 2, proposalId: randomUUID(), phase: 'confirm-intent' as const };
    const pending = { id: randomUUID(), operation: 'confirm' as const, stage: 'case-a' as const, at: f.state.updatedAt, caseLabel: 'A' as const, caseRequestId: retry.requestId };
    const intended = { ...f.state, cases: [old, retry], sequence: 1, pending };
    lease.beginMutation(intended, 0); expect(lease.load().cases).toHaveLength(2);
    lease.resolveRecovery({ ...intended, sequence: 2, pending: null, cases: [old, { ...retry, phase: 'confirmed', reminderId: randomUUID() }] }, 1, pending.id);
    const loaded = lease.load(); expect(loaded.cases[0]).toEqual(old);
    errorOnly(() => lease.commit({ ...loaded, sequence: 3, cases: [loaded.cases[1]] }, 2));
  });
  it('journals unresolved proposal intent without pretending a lost response saved nothing', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner); lease.create(f.state);
    const c = { ...syntheticCase(), phase: 'proposal-unresolved' as const };
    const pending = { id: randomUUID(), operation: 'propose' as const, stage: 'case-a' as const, at: f.state.updatedAt, caseLabel: 'A' as const, caseRequestId: c.requestId };
    lease.beginMutation({ ...f.state, sequence: 1, pending, cases: [c] }, 0);
    expect(lease.load().cases[0]?.phase).toBe('proposal-unresolved');
    errorOnly(() => lease.beginMutation({ ...lease.load(), sequence: 2, pending }, 1), 'recovery-required');
  });
  it('requires complete cleanup ownership before model or pause mutations', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner); lease.create(f.state);
    const pending = { id: randomUUID(), operation: 'disable-model' as const, stage: 'case-a' as const, at: f.state.updatedAt, caseLabel: null, caseRequestId: null };
    const cleanup = { ...f.state.cleanup, status: 'restore-needed' as const, serviceRestoreNeeded: true, daemonReloadNeeded: true };
    errorOnly(() => lease.beginMutation({ ...f.state, sequence: 1, pending, cleanup }, 0));
    errorOnly(() => lease.beginMutation({ ...f.state, sequence: 1, pending: { ...pending, operation: 'pause' }, cleanup }, 0));
    lease.beginMutation({ ...f.state, sequence: 1, pending, cleanup: { ...cleanup, artifacts: [
      { kind: 'model-drop-in', fingerprint: 'c'.repeat(64), phase: 'create-intent' },
      { kind: 'model-environment', fingerprint: 'd'.repeat(64), phase: 'create-intent' },
    ] } }, 0);
    const loaded = lease.load(); expect(loaded.cleanup.artifacts).toHaveLength(2);
    const partial = { ...loaded, sequence: 2, cleanup: { ...loaded.cleanup, artifacts: loaded.cleanup.artifacts.map(a => ({ ...a, phase: 'created' as const })) } };
    errorOnly(() => lease.checkpointMutation({ ...partial, pending: null }, 1, pending.id), 'recovery-required');
    lease.checkpointMutation(partial, 1, pending.id);
    expect(lease.load().pending).toEqual(pending);
    expect(lease.load().cleanup.artifacts.every(a => a.phase === 'created')).toBe(true);
  });
  it('binds reboot to a confirmed case and requires verified restoration before intent', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner);
    const c = { ...syntheticCase(), label: 'reboot' as const, proposalId: randomUUID(), reminderId: randomUUID(), phase: 'confirmed' as const };
    const reboot = { previousBootId: f.owner.bootId, installation, caseLabel: 'reboot' as const, caseRequestId: c.requestId, phase: 'pending' as const, at: f.state.updatedAt };
    const pending = { id: randomUUID(), operation: 'reboot' as const, stage: 'reboot' as const, at: f.state.updatedAt, caseLabel: 'reboot' as const, caseRequestId: c.requestId };
    lease.create(f.state);
    errorOnly(() => lease.beginMutation({ ...f.state, sequence: 1, pending, reboot, cases: [c], cleanup: { ...f.state.cleanup, status: 'restore-needed' } }, 0));
    errorOnly(() => validateJournal({ ...f.state, reboot, cases: [] }));
    errorOnly(() => validateJournal({ ...f.state, reboot: { ...reboot, installation: { ...installation, revision: 'e'.repeat(40) } }, cases: [c] }));
    lease.beginMutation({ ...f.state, sequence: 1, pending, reboot, cases: [c] }, 0);
    expect(lease.load().reboot).toEqual(reboot);
  });
  it('writes private safe exports without exposing stable internal identifiers', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner); lease.create(f.state); lease.exportReports();
    for (const file of ['report.json', 'report.md']) {
      const path = join(f.root, f.state.runId, file);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).not.toContain(f.state.installation.hostFingerprint);
    }
    expect(JSON.parse(readFileSync(join(f.root, f.state.runId, 'report.json'), 'utf8')).overall).toBe('blocked');
  });
  it('requires durable intent then explicit reconciliation, never automatic replay', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner); lease.create(f.state);
    const pending = { id: randomUUID(), operation: 'restart' as const, stage: 'case-a' as const, at: f.state.updatedAt, caseLabel: null, caseRequestId: null };
    const next = { ...f.state, sequence: 1, pending, cleanup: { ...f.state.cleanup, status: 'restore-needed' as const, serviceRestoreNeeded: true } };
    errorOnly(() => lease.commit(next, 0));
    lease.beginMutation(next, 0);
    expect(lease.load().pending).toEqual(pending);
    errorOnly(() => lease.commit({ ...next, sequence: 2, pending: null }, 1), 'recovery-required');
    errorOnly(() => lease.resolveRecovery({ ...next, sequence: 2, pending: null }, 1, randomUUID()), 'recovery-required');
    lease.resolveRecovery({ ...next, sequence: 2, pending: null }, 1, pending.id);
    expect(lease.load().cleanup.status).toBe('restore-needed');
  });
});
describe('paths and ownership', () => {
  it('refuses unsafe root, ancestor, file and run directory permissions', () => {
    const f = setup(); chmodSync(f.root, 0o755);
    errorOnly(() => new AcceptanceRegistry({ root: f.root }), 'unsafe-path'); chmodSync(f.root, 0o700);
    const lease = f.registry.acquire(installation, f.owner); lease.create(f.state);
    const file = join(f.root, f.state.runId, 'journal.json'); chmodSync(file, 0o644);
    errorOnly(() => lease.load(), 'unsafe-path'); chmodSync(file, 0o600);
    chmodSync(join(f.root, f.state.runId), 0o755); errorOnly(() => lease.load(), 'unsafe-path');
    chmodSync(join(f.root, f.state.runId), 0o700);
    mkdirSync(join(f.root, 'unsafe'), { mode: 0o777 }); chmodSync(join(f.root, 'unsafe'), 0o777);
    errorOnly(() => new AcceptanceRegistry({ root: join(f.root, 'unsafe', 'child') }), 'unsafe-path');
  });
  it('rejects source/app roots, relative/dot components and symlink ancestors', () => {
    const f = setup(); symlinkSync(f.root, join(f.root, 'alias'));
    for (const root of ['relative', `${f.root}/../other`, `${f.root}/alias/child`, process.cwd(), '/var/lib/r2/acceptance']) {
      expect(() => new AcceptanceRegistry({ root })).toThrow(AcceptanceError);
    }
    errorOnly(() => new AcceptanceRegistry({ root: f.root, appDataRoots: [f.root] }), 'unsafe-path');
  });
  it('rejects symlink run dirs/files, preserves targets and refuses hardlinks', async () => {
    const { unlinkSync, linkSync } = await import('node:fs');
    const f = setup(); const lease = f.registry.acquire(installation, f.owner);
    const target = join(f.root, 'target'); mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(f.root, f.state.runId)); errorOnly(() => lease.create(f.state), 'unsafe-path');
    unlinkSync(join(f.root, f.state.runId)); lease.create(f.state);
    const file = join(f.root, f.state.runId, 'journal.json'); unlinkSync(file);
    const privateFile = join(target, 'private'); writeFileSync(privateFile, 'do not touch', { mode: 0o600 });
    symlinkSync(privateFile, file); expect(() => lease.commit({ ...f.state, sequence: 1 }, 0)).toThrow(AcceptanceError);
    expect(readFileSync(privateFile, 'utf8')).toBe('do not touch');
    unlinkSync(file); linkSync(privateFile, file); errorOnly(() => lease.load(), 'unsafe-path');
  });
  it.runIf(process.getuid?.() === 0)('rejects foreign ownership', () => {
    const f = setup(); chownSync(f.root, 65534, 65534);
    errorOnly(() => new AcceptanceRegistry({ root: f.root }), 'unsafe-path'); chownSync(f.root, 0, 0);
  });
  it('rejects foreign directory and file ownership using injected stat facts without chown privilege', () => {
    const f = setup(); const realStat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path: string) => {
      const st = realStat(path);
      return path === f.root ? Object.assign(st, { uid: process.getuid!() + 1 }) : st;
    }) as typeof fs.lstatSync);
    errorOnly(() => new AcceptanceRegistry({ root: f.root }), 'unsafe-path'); vi.restoreAllMocks();
    const lease = f.registry.acquire(installation, f.owner); lease.create(f.state);
    const realFstat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => Object.assign(realFstat(fd), { uid: process.getuid!() + 1 })) as typeof fs.fstatSync);
    errorOnly(() => lease.load(), 'unsafe-path');
  });
});
describe('host/unit locks', () => {
  it('classifies only verified boot/process death as stale, including PID reuse', () => {
    const f = setup();
    expect(classifyOwner(f.owner, { bootId: f.owner.bootId, processStart: f.owner.processStart })).toBe('live');
    expect(classifyOwner(f.owner, { bootId: f.owner.bootId, processStart: null })).toBe('uncertain');
    expect(classifyOwner(f.owner, { bootId: null, processStart: 'absent' })).toBe('uncertain');
    expect(classifyOwner(f.owner, { bootId: f.owner.bootId, processStart: 'absent' })).toBe('stale');
    expect(classifyOwner(f.owner, { bootId: f.owner.bootId, processStart: '98765' })).toBe('stale');
    expect(classifyOwner(f.owner, { bootId: randomUUID(), processStart: null })).toBe('stale');
  });
  it('contends with a separate Node process sharing the fixed registry', () => {
    const f = setup(); f.registry.acquire(installation, f.owner);
    const script = `import { AcceptanceRegistry } from './scripts/acceptance/state.ts';
      try { new AcceptanceRegistry({root: ${JSON.stringify(f.root)}}).acquire(${JSON.stringify(installation)}, ${JSON.stringify({ ...f.owner, runId: randomUUID(), token: randomUUID() })}); process.exit(2); }
      catch(e) { if(e.code !== 'locked') process.exit(3); }`;
    expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), timeout: 10000 })).not.toThrow();
  });
  it('contends across different runs and installed revisions and only releases owned locks', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner);
    const another = { ...f.owner, runId: randomUUID(), token: randomUUID() };
    const separateInvocation = new AcceptanceRegistry({ root: f.root });
    errorOnly(() => separateInvocation.acquire({ ...installation, revision: 'c'.repeat(40) }, another), 'locked');
    const forged = new JournalLease(separateInvocation, installation, another);
    errorOnly(() => forged.release(), 'not-owner');
    expect(f.registry.owner(installation)).toEqual(f.owner);
    lease.release(); expect(() => separateInvocation.acquire(installation, another)).not.toThrow();
    errorOnly(() => lease.release(), 'not-owner');
  });
  it.each(['live', 'uncertain'] as const)('never recovers a %s owner', status => {
    const f = setup(); f.registry.acquire(installation, f.owner);
    errorOnly(() => f.registry.recoverStale(installation, f.owner, { inspect: () => status }), 'locked');
    expect(f.registry.owner(installation)).toEqual(f.owner);
  });
  it('retains unfinished recovery across process death without an unlocked interval for other runs', () => {
    const f = setup(); const lease = f.registry.acquire(installation, f.owner); lease.create(f.state);
    const pending = { id: randomUUID(), operation: 'restart' as const, stage: 'case-a' as const, at: f.state.updatedAt, caseLabel: null, caseRequestId: null };
    const next = { ...f.state, sequence: 1, pending, cleanup: { ...f.state.cleanup, status: 'restore-needed' as const, serviceRestoreNeeded: true } };
    lease.beginMutation(next, 0);
    errorOnly(() => lease.release(), 'recovery-required');
    errorOnly(() => f.registry.recoverStale(installation, f.owner, { inspect: () => 'stale' }), 'recovery-required');
    errorOnly(() => f.registry.takeoverStale(installation, f.owner, { ...f.owner, runId: randomUUID(), token: randomUUID() }, { inspect: () => 'stale' }), 'not-owner');
    errorOnly(() => f.registry.takeoverStale(installation, f.owner, { ...f.owner, token: randomUUID() }, { inspect: () => 'uncertain' }), 'locked');
    const recovered = f.registry.takeoverStale(installation, f.owner, { ...f.owner, token: randomUUID(), processStart: '34567' }, { inspect: () => 'stale' });
    errorOnly(() => lease.release(), 'not-owner');
    expect(recovered.load()).toEqual(next);
    recovered.resolveRecovery({ ...next, sequence: 2, pending: null, cleanup: f.state.cleanup }, 1, pending.id);
    recovered.release();
  });
  it('recovers only the exact stale owner; probe errors cannot delete the lock', () => {
    const f = setup(); const old = f.registry.acquire(installation, f.owner);
    errorOnly(() => f.registry.recoverStale(installation, { ...f.owner, token: randomUUID() }, { inspect: () => 'stale' }), 'not-owner');
    errorOnly(() => f.registry.recoverStale(installation, f.owner, { inspect: () => { throw new Error(canaries[0]); } }), 'io');
    f.registry.recoverStale(installation, f.owner, { inspect: () => 'stale' });
    const next = f.registry.acquire(installation, { ...f.owner, token: randomUUID(), bootId: randomUUID() });
    errorOnly(() => old.release(), 'not-owner'); next.release();
  });
  it('preserves corrupt/symlink locks and interrupted ownership gates', () => {
    const f = setup(); f.registry.acquire(installation, f.owner);
    const lock = join(f.root, `host-${installation.hostFingerprint}-r2.service.lock`);
    writeFileSync(lock, canaries[0]!); errorOnly(() => f.registry.recoverStale(installation, f.owner, { inspect: () => 'stale' }));
    expect(existsSync(lock)).toBe(true);
    mkdirSync(join(f.root, '.ownership-gate'), { mode: 0o700 });
    errorOnly(() => f.registry.acquire(installation, f.owner), 'locked');
    expect(existsSync(join(f.root, '.ownership-gate'))).toBe(true);
  });
});
