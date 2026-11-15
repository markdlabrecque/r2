import { checkIds, validateJournal, type CheckId, type CheckResult } from './contracts.ts';

/** Complete catalog, including missing checks. Optional reboot checks remain visible. */
export function projectReport(input: unknown) {
  const state = validateJournal(input);
  const checks = checkIds.map(id => {
    const c = state.checks.find(c => c.id === id);
    return {
      id, required: !state.optionalChecks.includes(id), status: c?.status ?? 'not-run',
      provenance: c?.provenance ?? null, reason: c?.reason ?? 'pending', at: c?.at ?? null,
    };
  });
  const required = checks.filter(c => c.required);
  const overall = state.cleanup.status === 'failed' || state.cleanup.status === 'conflict' || required.some(c => c.status === 'fail')
    ? 'fail' : state.cleanup.status === 'verified' && state.pending === null && required.every(c => c.status === 'pass')
      ? 'pass' : 'blocked';
  // Explicit projection. Never spread a journal, adapter DTO or arbitrary error into output.
  return {
    version: 1, runId: state.runId, sequence: state.sequence, stage: state.stage,
    createdAt: state.createdAt, updatedAt: state.updatedAt, overall,
    cleanup: state.cleanup.status, recoveryRequired: state.pending !== null || state.cleanup.status !== 'verified',
    checks,
    cases: state.cases.map(c => ({ label: c.label, caseNumber: c.caseNumber, phase: c.phase, reason: c.reason, dueAt: c.dueAt,
      localDateTime: c.localDateTime, timezone: c.timezone, createdAt: c.createdAt,
      attemptAt: c.attemptAt, acceptedAt: c.acceptedAt })),
    reboot: state.reboot === null ? null : { phase: state.reboot.phase, at: state.reboot.at },
  };
}
export function jsonReport(input: unknown): string { return `${JSON.stringify(projectReport(input), null, 2)}\n`; }
const time = (value: number | null) => value === null ? 'missing' : new Date(value).toISOString();
export function markdownReport(input: unknown): string {
  const r = projectReport(input);
  return [
    '# R2 acceptance evidence', '', `Run: ${r.runId}`, `Checkpoint: ${r.sequence}`, `Stage: ${r.stage}`,
    `Overall: ${r.overall}`, `Cleanup: ${r.cleanup}`, `Recovery required: ${r.recoveryRequired}`,
    `Started: ${time(r.createdAt)}`, `Updated: ${time(r.updatedAt)}`, '',
    'Provider acceptance is not observed desktop display. Missing evidence stays incomplete.', '',
    '| Check | Required | Result | Provenance | Reason | Evidence time |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.checks.map(c => `| ${c.id} | ${c.required ? 'yes' : 'optional'} | ${c.status} | ${c.provenance ?? 'missing'} | ${c.reason} | ${time(c.at)} |`),
    '', '## Synthetic cases', '',
    '| Case | Phase | Original due UTC | Original local time | Zone | Created | Attempt | Accepted |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.cases.map(c => `| ${c.label}-${c.caseNumber} | ${c.phase}${c.reason === null ? '' : ` / ${c.reason}`} | ${time(c.dueAt)} | ${c.localDateTime} | ${c.timezone} | ${time(c.createdAt)} | ${time(c.attemptAt)} | ${time(c.acceptedAt)} |`),
    '', ...(r.reboot ? [`Reboot: ${r.reboot.phase}, ${time(r.reboot.at)}`, ''] : []),
  ].join('\n');
}
/** Construction helper for typed adapters; runtime journal validation still rejects extra fields. */
export function evidence(id: CheckId, status: CheckResult['status'], provenance: CheckResult['provenance'], reason: CheckResult['reason'], at: number): CheckResult {
  return { id, status, provenance, reason, at };
}
