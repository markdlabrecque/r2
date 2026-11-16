import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { AcceptanceApi, ApiError, type Proposal, type Reminder } from './api.ts';
import { caseSchema, type Clock, type Journal, type SyntheticCase, type Wait } from './contracts.ts';
import { JournalLease } from './state.ts';
import { resolveLocalTime } from '../../src/reminders.ts';

export class CaseError extends Error {
  readonly code: 'invalid-time' | 'invalid-proposal' | 'too-late' | 'unresolved' | 'invalid-case';
  constructor(code: CaseError['code']) { super(`Acceptance case: ${code}`); this.name = 'CaseError'; this.code = code; }
}
export interface CasePlan { record: SyntheticCase; text: string; message: string; offset: string }
/** A unique synthetic request, calculated in the owner's selected zone, never the server's zone. */
export function makeCase(label: SyntheticCase['label'], caseNumber: number, timezone: string, now: number, leadMs: number): CasePlan {
  try {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leadMs) || leadMs < 120_000 || leadMs > 7 * 86_400_000) throw 0;
    const instant = Temporal.Instant.fromEpochMilliseconds(now + leadMs).round({ smallestUnit: 'minute', roundingMode: 'ceil' });
    const localDateTime = instant.toZonedDateTimeISO(timezone).toPlainDateTime().toString({ smallestUnit: 'minute' });
    const resolved = resolveLocalTime(localDateTime, timezone, now);
    if (!resolved.ok || resolved.dueAt !== instant.epochMilliseconds) throw 0;
    const requestId = randomUUID(); const text = `R2 acceptance ${requestId}`;
    const record: SyntheticCase = caseSchema.parse({ label, caseNumber, requestId, proposalId: null, reminderId: null, reason: null, phase: 'intended', dueAt: resolved.dueAt, localDateTime, timezone, createdAt: now, attemptAt: null, acceptedAt: null });
    return { record, text, message: `Remind me to ${text} at ${localDateTime} in ${timezone}.`, offset: resolved.utcOffset };
  } catch { throw new CaseError('invalid-time'); }
}
function next(s: Journal, clock: Clock): Journal { return { ...s, sequence: s.sequence + 1, updatedAt: Math.max(s.updatedAt, clock.now()) }; }
function replace(s: Journal, c: SyntheticCase): Journal { return { ...s, cases: s.cases.map(item => item.requestId === c.requestId ? c : item) }; }
function current(s: Journal, requestId: string): SyntheticCase { const c = s.cases.find(c => c.requestId === requestId); if (!c) throw new CaseError('invalid-case'); return c; }
function matches(c: SyntheticCase, p: Pick<Proposal, 'text' | 'dueAt' | 'timezone' | 'localDateTime'>, text: string): boolean {
  return p.text === text && p.timezone === c.timezone && p.localDateTime === c.localDateTime && Date.parse(p.dueAt) === c.dueAt;
}
/** Coordinator owns the lease and prompts. This helper never persists model text, credentials or raw DTOs. */
export class AcceptanceCases {
  readonly #api: AcceptanceApi; readonly #lease: JournalLease; readonly #clock: Clock;
  readonly #validated = new Map<string, { text: string; expiresAt: number }>();
  constructor(api: AcceptanceApi, lease: JournalLease, clock: Clock) { this.#api = api; this.#lease = lease; this.#clock = clock; }
  async propose(plan: CasePlan): Promise<'proposed' | 'clarify' | 'unsupported'> {
    let s = this.#lease.load();
    const planned = plan.record; const time = resolveLocalTime(planned.localDateTime, planned.timezone, this.#clock.now());
    if (!caseSchema.safeParse(planned).success || planned.phase !== 'intended' || planned.proposalId !== null || planned.reminderId !== null || planned.reason !== null || planned.attemptAt !== null || planned.acceptedAt !== null || !time.ok || time.dueAt !== planned.dueAt || plan.offset !== time.utcOffset || plan.text !== `R2 acceptance ${planned.requestId}` || plan.message !== `Remind me to ${plan.text} at ${planned.localDateTime} in ${planned.timezone}.` || s.pending || s.cases.some(item => item.requestId === planned.requestId)) throw new CaseError('invalid-case');
    if (this.#clock.now() + 60_000 >= plan.record.dueAt) throw new CaseError('too-late');
    const settings = await this.#api.settings(); if (settings.timezone !== plan.record.timezone) throw new CaseError('invalid-case');
    s = this.#lease.commit({ ...next(s, this.#clock), cases: [...s.cases, plan.record] }, s.sequence);
    const intent = { id: randomUUID(), operation: 'propose' as const, stage: s.stage, at: this.#clock.now(), caseLabel: plan.record.label, caseRequestId: plan.record.requestId };
    this.#lease.beginMutation({ ...next(s, this.#clock), pending: intent }, s.sequence);
    let result: Awaited<ReturnType<AcceptanceApi['chat']>>;
    try { result = await this.#api.chat(plan.message); }
    catch (e) {
      // A response may have been lost after the server stored a proposal. Keep intent for explicit recovery.
      s = this.#lease.load(); const c = current(s, plan.record.requestId);
      this.#lease.checkpointMutation(replace(next(s, this.#clock), { ...c, phase: 'proposal-unresolved', reason: 'interrupted' }), s.sequence, intent.id);
      throw e;
    }
    s = this.#lease.load(); let c = current(s, plan.record.requestId);
    if (result.type !== 'proposal') {
      c = { ...c, phase: 'blocked', reason: 'unavailable' };
      this.#lease.resolveRecovery({ ...replace(next(s, this.#clock), c), pending: null }, s.sequence, intent.id);
      return result.type;
    }
    // Persist the known proposal ID before validating or performing any other external call.
    c = { ...c, proposalId: result.proposal.id, phase: 'proposed' };
    s = this.#lease.resolveRecovery({ ...replace(next(s, this.#clock), c), pending: null }, s.sequence, intent.id);
    const expiresAt = Date.parse(result.proposal.expiresAt); const now = this.#clock.now();
    if (!matches(c, result.proposal, plan.text) || result.utcOffset !== plan.offset || result.proposal.confirmedReminderId !== null || Date.parse(result.proposal.createdAt) > now || expiresAt > c.dueAt || expiresAt > Date.parse(result.proposal.createdAt) + 15 * 60_000 || expiresAt <= now + 60_000 || c.dueAt <= now + 60_000) {
      this.#lease.commit(replace(next(s, this.#clock), { ...c, phase: 'blocked', reason: 'invalid-response' }), s.sequence);
      throw new CaseError('invalid-proposal');
    }
    this.#validated.set(c.requestId, { text: plan.text, expiresAt }); return 'proposed';
  }
  async confirm(requestId: string): Promise<Reminder> {
    let s = this.#lease.load(); const c = current(s, requestId); const valid = this.#validated.get(requestId);
    if (s.pending || c.phase !== 'proposed' || !c.proposalId || !valid) throw new CaseError('invalid-case');
    if (Math.min(valid.expiresAt, c.dueAt) <= this.#clock.now() + 60_000) throw new CaseError('too-late');
    const intent = { id: randomUUID(), operation: 'confirm' as const, stage: s.stage, at: this.#clock.now(), caseLabel: c.label, caseRequestId: c.requestId };
    this.#lease.beginMutation({ ...replace(next(s, this.#clock), { ...c, phase: 'confirm-intent' }), pending: intent }, s.sequence);
    return this.reconcileConfirmation();
  }
  /** Retry only an already-journaled proposal/request pair after a lost confirmation response. */
  async reconcileConfirmation(): Promise<Reminder> {
    let s = this.#lease.load(); const intent = s.pending;
    if (!intent || intent.operation !== 'confirm' || !intent.caseRequestId) throw new CaseError('invalid-case');
    const c = current(s, intent.caseRequestId); if (!c.proposalId || c.phase !== 'confirm-intent') throw new CaseError('invalid-case');
    if (c.dueAt <= this.#clock.now() + 60_000 && c.reminderId === null) throw new CaseError('too-late');
    const r = await this.#api.confirm(c.proposalId, c.requestId);
    if (c.reminderId !== null && c.reminderId !== r.id) throw new CaseError('invalid-proposal');
    s = this.#lease.load();
    s = this.#lease.checkpointMutation(replace(next(s, this.#clock), { ...c, reminderId: r.id }), s.sequence, intent.id);
    if (r.proposalId !== c.proposalId || !matches(c, r, `R2 acceptance ${c.requestId}`)) throw new CaseError('invalid-proposal');
    this.#lease.resolveRecovery({ ...replace(next(s, this.#clock), { ...c, phase: 'confirmed', reminderId: r.id }), pending: null }, s.sequence, intent.id);
    this.#validated.delete(c.requestId); return r;
  }
  async repeatConfirmation(requestId: string): Promise<Reminder> {
    const s = this.#lease.load(); const c = current(s, requestId);
    if (s.pending || c.phase !== 'confirmed' || !c.proposalId || !c.reminderId) throw new CaseError('invalid-case');
    const intent = { id: randomUUID(), operation: 'confirm' as const, stage: s.stage, at: this.#clock.now(), caseLabel: c.label, caseRequestId: c.requestId };
    this.#lease.beginMutation({ ...replace(next(s, this.#clock), { ...c, phase: 'confirm-intent' }), pending: intent }, s.sequence);
    return this.reconcileConfirmation();
  }
}
/** Absence is inconclusive because the server's reminder list is bounded. */
export async function proposalInList(api: AcceptanceApi, proposalId: string): Promise<'found' | 'inconclusive'> {
  return (await api.reminders()).some(r => r.proposalId === proposalId) ? 'found' : 'inconclusive';
}
export async function findKnown(api: AcceptanceApi, id: string) { return (await api.reminders()).find(r => r.id === id) ?? null; }
export function retained(c: SyntheticCase, r: Reminder): boolean { return c.reminderId === r.id && c.proposalId === r.proposalId && c.timezone === r.timezone && c.localDateTime === r.localDateTime && c.dueAt === Date.parse(r.dueAt); }
export function sameSubscription(a: Awaited<ReturnType<AcceptanceApi['push']>>, b: Awaited<ReturnType<AcceptanceApi['push']>>): boolean { return a.subscription.connected && b.subscription.connected && a.subscription.version !== null && a.subscription.version === b.subscription.version; }
export async function pollReminder(api: AcceptanceApi, id: string, clock: Clock, wait: Wait, deadline: number, intervalMs: number): Promise<{ kind: 'accepted' | 'attempted' | 'not-observed'; attemptAt: number | null; acceptedAt: number | null }> {
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000 || deadline < clock.now() || deadline - clock.now() > 86_400_000) throw new CaseError('invalid-time');
  let attempted: number | null = null;
  for (let i = 0; i < 1000; i++) {
    const r = await findKnown(api, id); const a = r?.deliveryAttempts[0];
    if (r && a && r.state === 'accepted' && r.acceptedAt !== null && r.deliveryAttempts.some(x => x.outcome === 'accepted')) return { kind: 'accepted', attemptAt: Date.parse(a.startedAt), acceptedAt: Date.parse(r.acceptedAt) };
    if (a && attempted === null) attempted = Date.parse(a.startedAt);
    if (clock.now() >= deadline) break;
    await wait.until(Math.min(deadline, clock.now() + intervalMs));
  }
  return attempted === null ? { kind: 'not-observed', attemptAt: null, acceptedAt: null } : { kind: 'attempted', attemptAt: attempted, acceptedAt: null };
}
export { ApiError };
