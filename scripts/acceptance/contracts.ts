import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';

/** Persist only these schemas. Runtime origin/password/cookie and raw adapter DTOs stay in memory. */
export class AcceptanceError extends Error {
  readonly code: 'invalid-state' | 'unsafe-path' | 'io' | 'locked' | 'not-owner' | 'recovery-required';
  constructor(code: AcceptanceError['code']) {
    super(`Acceptance operation blocked: ${code}.`);
    this.code = code;
    this.name = 'AcceptanceError';
  }
}
export const idSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const proposalIdSchema = z.string().regex(/^prp_[A-Za-z0-9_-]{22}$/);
export const reminderIdSchema = z.string().regex(/^rem_[A-Za-z0-9_-]{22}$/);
export const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const instantSchema = z.number().int().min(0).max(8_640_000_000_000_000);
export const stages = ['preflight', 'browser', 'case-a', 'case-b', 'case-c', 'devices', 'reboot', 'cleanup', 'complete'] as const;
export const caseLabels = ['A', 'B', 'C', 'reboot'] as const;
export const checkIds = [
  'installation', 'https', 'authentication', 'timezone', 'firefox-permission', 'test-provider',
  'test-observed', 'generic-wording', 'click-through', 'clarification', 'proposal-unsaved', 'duplicate-save',
  'a-retained', 'a-model-disabled', 'a-provider', 'a-observed', 'a-timing',
  'b-retained', 'b-provider', 'b-observed', 'c-pause-retained', 'c-no-attempt', 'c-provider', 'c-observed',
  'second-device', 'recipient-unchanged', 'signed-out-denied', 'outside-tailnet-denied', 'excluded-client-denied',
  'reboot-changed', 'reboot-automatic-recovery', 'reboot-retained', 'reboot-provider', 'reboot-observed', 'cleanup',
] as const;
export type CheckId = typeof checkIds[number];
export const reasons = ['verified', 'declined', 'unavailable', 'interrupted', 'timeout', 'invalid-response',
  'conflict', 'unauthorized', 'unsafe-installation', 'missed-window', 'not-observed', 'operation-failed', 'pending'] as const;
export const checkSchema = z.strictObject({
  id: z.enum(checkIds), status: z.enum(['pass', 'fail', 'blocked', 'not-run']),
  provenance: z.enum(['automated', 'owner-reported']), reason: z.enum(reasons), at: instantSchema,
}).superRefine((c, ctx) => {
  const human = ['firefox-permission', 'test-observed', 'generic-wording', 'click-through', 'a-observed',
    'b-observed', 'c-observed', 'second-device', 'signed-out-denied', 'outside-tailnet-denied',
    'excluded-client-denied', 'reboot-observed'].includes(c.id);
  if (human && c.provenance !== 'owner-reported') ctx.addIssue({ code: 'custom', message: 'Invalid evidence.' });
  if (c.status === 'pass' && c.reason !== 'verified') ctx.addIssue({ code: 'custom', message: 'Invalid evidence.' });
});
export type CheckResult = z.infer<typeof checkSchema>;
export const caseSchema = z.strictObject({
  label: z.enum(caseLabels), caseNumber: z.number().int().min(1).max(32),
  requestId: idSchema, proposalId: proposalIdSchema.nullable(), reminderId: reminderIdSchema.nullable(),
  reason: z.enum(reasons).nullable(),
  phase: z.enum(['intended', 'proposal-unresolved', 'proposed', 'confirm-intent', 'confirmed', 'blocked']),
  dueAt: instantSchema, localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/).refine(v => {
    try { Temporal.PlainDateTime.from(v, { overflow: 'reject' }); return true; } catch { return false; }
  }),
  timezone: z.string().regex(/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/).refine(v => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch { return false; }
  }),
  createdAt: instantSchema, attemptAt: instantSchema.nullable(), acceptedAt: instantSchema.nullable(),
}).superRefine((c, ctx) => {
  if ((['proposed', 'confirm-intent', 'confirmed'].includes(c.phase) && c.proposalId === null) ||
    (c.phase === 'confirmed' && c.reminderId === null) || (c.reminderId !== null && c.proposalId === null) ||
    (c.acceptedAt !== null && (c.reminderId === null || c.attemptAt === null || c.acceptedAt < c.attemptAt))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid case.' });
  }
});
export type SyntheticCase = z.infer<typeof caseSchema>;
export const installationSchema = z.strictObject({ hostFingerprint: fingerprintSchema, unit: z.literal('r2.service'), revision: z.string().regex(/^[a-f0-9]{40}$/) });
export type Installation = z.infer<typeof installationSchema>;
export const ownerSchema = z.strictObject({ runId: idSchema, token: idSchema, pid: z.number().int().positive().max(4_194_304), bootId: idSchema, processStart: z.string().regex(/^[0-9]{1,24}$/) });
export type LockOwner = z.infer<typeof ownerSchema>;
export const operations = ['propose', 'confirm', 'pause', 'restore-pause', 'restart', 'stop', 'start', 'disable-model', 'restore-model', 'reboot'] as const;
export const intentSchema = z.strictObject({ id: idSchema, operation: z.enum(operations), stage: z.enum(stages), at: instantSchema, caseLabel: z.enum(caseLabels).nullable(), caseRequestId: idSchema.nullable() });
export type MutationIntent = z.infer<typeof intentSchema>;
export const cleanupSchema = z.strictObject({
  status: z.enum(['verified', 'restore-needed', 'conflict', 'failed']),
  originalPause: z.boolean().nullable(), pauseRestoreNeeded: z.boolean(), serviceRestoreNeeded: z.boolean(),
  daemonReloadNeeded: z.boolean(),
  artifacts: z.array(z.strictObject({ kind: z.enum(['model-drop-in', 'model-environment']), fingerprint: fingerprintSchema, phase: z.enum(['create-intent', 'created', 'remove-intent']) })).max(2),
}).superRefine((c, ctx) => {
  if (c.pauseRestoreNeeded && c.originalPause === null || c.status === 'verified' &&
    (c.pauseRestoreNeeded || c.serviceRestoreNeeded || c.daemonReloadNeeded || c.artifacts.length)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid cleanup.' });
  }
  if (new Set(c.artifacts.map(a => a.kind)).size !== c.artifacts.length) ctx.addIssue({ code: 'custom', message: 'Duplicate artifact.' });
});
export type CleanupIntent = z.infer<typeof cleanupSchema>;
export const rebootSchema = z.strictObject({ previousBootId: idSchema, installation: installationSchema,
  caseLabel: z.literal('reboot'), caseRequestId: idSchema, phase: z.enum(['prepared', 'pending', 'resumed', 'declined', 'failed']), at: instantSchema });
export const journalSchema = z.strictObject({
  version: z.literal(1), runId: idSchema, sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  installation: installationSchema, priorBootId: idSchema, stage: z.enum(stages), createdAt: instantSchema, updatedAt: instantSchema,
  optionalChecks: z.array(z.enum(checkIds)).max(checkIds.length), checks: z.array(checkSchema).max(checkIds.length),
  cases: z.array(caseSchema).max(32), cleanup: cleanupSchema, pending: intentSchema.nullable(), reboot: rebootSchema.nullable(),
}).superRefine((s, ctx) => {
  for (const values of [s.checks.map(c => c.id), s.cases.map(c => `${c.label}-${c.caseNumber}`), s.cases.map(c => c.requestId), s.optionalChecks]) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: 'Duplicate entry.' });
  }
  if (s.pending && ((s.pending.caseLabel === null) !== (s.pending.caseRequestId === null) ||
    s.pending.caseRequestId !== null && !s.cases.some(c => c.requestId === s.pending!.caseRequestId && c.label === s.pending!.caseLabel))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid intent.' });
  }
  // These safety/evidence gates cannot be made optional.
  if (s.optionalChecks.some(c => !c.startsWith('reboot-'))) ctx.addIssue({ code: 'custom', message: 'Required check.' });
  if (s.reboot && (!s.cases.some(c => c.label === 'reboot' && c.requestId === s.reboot!.caseRequestId && c.reminderId !== null) ||
    JSON.stringify(s.reboot.installation) !== JSON.stringify(s.installation))) ctx.addIssue({ code: 'custom', message: 'Invalid reboot.' });
});
export type Journal = z.infer<typeof journalSchema>;
export function validateJournal(input: unknown): Journal {
  try { return journalSchema.parse(input); } catch { throw new AcceptanceError('invalid-state'); }
}
export interface Clock { now(): number }
export interface Wait { until(at: number, signal?: AbortSignal): Promise<void> }
/** No default affirmative outcome. Approval is ephemeral, never journaled as authority. */
export type PromptOutcome = 'approved' | 'declined' | 'unavailable' | 'cancelled';
export interface StageApproval { runId: string; stage: typeof stages[number]; operation: typeof operations[number]; outcome: PromptOutcome }
export interface RuntimeSession { origin: URL; password: string; cookie: string | null }
/** Probe must establish boot/start identity, not only PID existence. Uncertainty never permits takeover. */
export type OwnerLiveness = 'live' | 'stale' | 'uncertain';
export interface OwnershipProbe { inspect(owner: LockOwner): OwnerLiveness }
/** Verified facts from a trusted host adapter. Missing permission/read/parse results are uncertain, never absent. */
export interface ProcessFacts { bootId: string | null; processStart: string | 'absent' | null }
export function classifyOwner(owner: LockOwner, facts: ProcessFacts): OwnerLiveness {
  if (!idSchema.safeParse(facts.bootId).success) return 'uncertain';
  if (facts.bootId !== owner.bootId) return 'stale';
  if (facts.processStart === 'absent') return 'stale';
  if (facts.processStart === null || !/^[0-9]{1,24}$/.test(facts.processStart)) return 'uncertain';
  return facts.processStart === owner.processStart ? 'live' : 'stale';
}
