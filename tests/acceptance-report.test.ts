import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkIds, validateJournal, type Journal } from '../scripts/acceptance/contracts.ts';
import { evidence, jsonReport, markdownReport, projectReport } from '../scripts/acceptance/report.ts';
import { journal, syntheticCase } from './acceptance-fixtures.ts';
function complete(): Journal {
  const s = journal();
  s.checks = checkIds.map(id => evidence(id, 'pass', 'owner-reported', 'verified', s.updatedAt));
  return s;
}
describe('truthful evidence exports', () => {
  it('lists every missing check with no fabricated evidence time or provenance', () => {
    const r = projectReport(journal());
    expect(r.overall).toBe('blocked'); expect(r.checks).toHaveLength(checkIds.length);
    expect(r.checks.every(c => c.status === 'not-run' && c.at === null && c.provenance === null)).toBe(true);
    expect(markdownReport(journal())).toContain('| a-observed | yes | not-run | missing | pending | missing |');
  });
  it('provider acceptance never implies observation', () => {
    const s = complete(); s.checks = s.checks.filter(c => c.id !== 'a-observed');
    expect(projectReport(s).checks.find(c => c.id === 'a-provider')?.status).toBe('pass');
    expect(projectReport(s).checks.find(c => c.id === 'a-observed')?.status).toBe('not-run');
    expect(projectReport(s).overall).toBe('blocked');
    expect(() => validateJournal({ ...s, checks: [evidence('a-observed', 'pass', 'automated', 'verified', 1)] })).toThrow('invalid-state');
  });
  it.each(['fail', 'blocked', 'not-run'] as const)('every required %s prevents pass', status => {
    for (const id of checkIds) {
      const s = complete(); s.checks = s.checks.map(c => c.id === id ? { ...c, status, reason: 'unavailable' } : c);
      expect(projectReport(s).overall).not.toBe('pass');
    }
  });
  it('requires verified cleanup and no pending action as well as all check passes', () => {
    expect(projectReport(complete()).overall).toBe('pass');
    for (const status of ['restore-needed', 'conflict', 'failed'] as const) {
      const s = complete(); s.cleanup.status = status; expect(projectReport(s).overall).not.toBe('pass');
    }
    const s = complete(); s.pending = { id: randomUUID(), operation: 'restart', stage: 'case-a', caseLabel: null, caseRequestId: null, at: s.updatedAt };
    expect(projectReport(s).overall).toBe('blocked');
    expect(projectReport(s).recoveryRequired).toBe(true);
  });
  it('retains explicit optional checks; only reboot checks can be optional', () => {
    const s = complete(); s.optionalChecks = ['reboot-observed']; s.checks = s.checks.filter(c => c.id !== 'reboot-observed');
    expect(projectReport(s).overall).toBe('pass');
    expect(projectReport(s).checks.find(c => c.id === 'reboot-observed')).toMatchObject({ required: false, status: 'not-run' });
    expect(markdownReport(s)).toContain('| reboot-observed | optional | not-run');
    expect(() => projectReport({ ...s, optionalChecks: ['a-observed'] })).toThrow('invalid-state');
  });
  it('preserves provenance and original case/evidence times through serialization and resume', () => {
    const s = complete(); const c = syntheticCase(); c.proposalId = randomUUID(); c.reminderId = randomUUID(); c.attemptAt = c.dueAt + 1000; c.acceptedAt = c.dueAt + 2000; s.cases = [c];
    s.checks = [evidence('a-provider', 'pass', 'automated', 'verified', c.acceptedAt), evidence('a-observed', 'blocked', 'owner-reported', 'unavailable', c.acceptedAt + 4000)];
    const resumed = validateJournal(JSON.parse(JSON.stringify(s)));
    expect(jsonReport(resumed)).toBe(jsonReport(s));
    const r = JSON.parse(jsonReport(resumed));
    expect(r.cases[0]).toMatchObject({ label: 'A', dueAt: c.dueAt, attemptAt: c.attemptAt, acceptedAt: c.acceptedAt });
    expect(r.cases[0]).not.toHaveProperty('requestId');
    expect(markdownReport(resumed)).toContain(new Date(c.dueAt).toISOString());
    expect(r.checks.find((c: { id: string }) => c.id === 'a-provider')).toMatchObject({ provenance: 'automated', at: c.acceptedAt });
  });
  it('projects neither installation identifiers nor whole journal/internal IDs', () => {
    const s = complete(); s.cases = [syntheticCase()];
    const output = jsonReport(s) + markdownReport(s);
    for (const privateValue of [s.installation.hostFingerprint, s.installation.revision, s.priorBootId, s.cases[0]!.requestId]) expect(output).not.toContain(privateValue);
  });
  it('rejects secret canaries in any extra field without leaking them in errors or exports', () => {
    const s = journal(); const clean = jsonReport(s) + markdownReport(s);
    for (const canary of ['password-secret', 'owner_session=COOKIE', 'https://private.tailnet.ts.net', 'KEY-private', 'private reminder text', 'hostname-secret']) {
      for (const invalid of [{ ...s, password: canary }, { ...s, cleanup: { ...s.cleanup, output: canary } },
        { ...s, checks: [{ ...evidence('https', 'fail', 'automated', 'operation-failed', 1), body: canary }] }]) {
        for (const render of [jsonReport, markdownReport]) {
          try { render(invalid); throw new Error('Expected rejection'); } catch (e) {
            expect(String(e)).toBe('AcceptanceError: Acceptance operation blocked: invalid-state.');
            expect(String(e)).not.toContain(canary);
          }
        }
      }
      expect(clean).not.toContain(canary);
    }
  });
});
