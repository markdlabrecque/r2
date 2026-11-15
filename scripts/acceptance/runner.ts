import { randomUUID } from 'node:crypto';
import { AcceptanceApi, ApiError } from './api.ts';
import { AcceptanceCases, CaseError, findKnown, makeCase, pollReminder, retained, sameSubscription } from './cases.ts';
import type { CheckId, CheckResult, Clock, Journal, PromptOutcome, StageApproval, SyntheticCase, Wait } from './contracts.ts';
import { AcceptanceHost, type HostAuthority, type HostOperation } from './host.ts';
import type { JournalLease } from './state.ts';
import { projectReport } from './report.ts';

type Stage = Journal['stage'];
export type PromptId = CheckId | HostOperation | 'live-run' | 'connect' | 'create-case' | 'confirm-case' | 'temporary-unpause' | 'pause' | 'retry-stage' | 'reboot';
export interface RunnerPrompt {
  id: PromptId; stage: Stage; message: string;
  /** There is deliberately no default answer. Only an explicit approved result is affirmative. */
  case?: { label: SyntheticCase['label']; caseNumber: number; dueAt: number };
}
export interface RunnerOptions {
  api: AcceptanceApi;
  host: Pick<AcceptanceHost, 'inspect' | 'operate' | 'recover'>;
  lease: JournalLease;
  clock: Clock;
  wait: Wait;
  prompt: (request: RunnerPrompt) => Promise<PromptOutcome>;
  mode: 'read-only' | 'non-production-live';
  hostDisruption: boolean;
  /** In-memory only. The CLI may ask for credentials and call api.login here. */
  reauthenticate?: () => Promise<void>;
  leadMs?: number;
  providerWindowMs?: number;
}
class Halt extends Error {
  constructor(readonly reason: CheckResult['reason'], readonly status: 'fail' | 'blocked' = 'blocked') { super('Acceptance stage stopped.'); }
}
const activeRunners = new WeakSet<JournalLease>();
const hostOperations = ['restart', 'stop', 'start', 'disable-model', 'restore-model'];
const bound = (a: Journal['installation'], b: Journal['installation']) => a.hostFingerprint === b.hostFingerprint && a.unit === b.unit && a.revision === b.revision;

/** Owner-run coordinator. No credentials, real executor, terminal implementation or reboot command is supplied. */
export class AcceptanceRunner {
  private readonly cases: AcceptanceCases;
  private signal?: AbortSignal;
  private busy = false;
  private liveApproved = false;
  private cancellation = new AbortController();
  cancel() { this.cancellation.abort(); }
  constructor(private readonly o: RunnerOptions) {
    this.cases = new AcceptanceCases(o.api, o.lease, o.clock);
    if (!Number.isSafeInteger(o.leadMs ?? 600_000) || (o.leadMs ?? 600_000) < 120_000 || (o.leadMs ?? 600_000) > 7 * 86_400_000 ||
      !Number.isSafeInteger(o.providerWindowMs ?? 120_000) || (o.providerWindowMs ?? 120_000) < 1000 || (o.providerWindowMs ?? 120_000) > 3_600_000) throw new Halt('invalid-response');
  }
  private state() { return this.o.lease.load(); }
  private update(edit: (s: Journal) => void): Journal {
    const s = this.state(), seq = s.sequence; s.sequence++; s.updatedAt = Math.max(s.updatedAt, this.o.clock.now()); edit(s);
    return s.pending ? this.o.lease.checkpointMutation(s, seq, s.pending.id) : this.o.lease.commit(s, seq);
  }
  private resolve(edit: (s: Journal) => void) {
    const s = this.state(), seq = s.sequence, id = s.pending?.id;
    if (!id) throw new Halt('conflict');
    s.sequence++; s.updatedAt = Math.max(s.updatedAt, this.o.clock.now()); edit(s); s.pending = null;
    return this.o.lease.resolveRecovery(s, seq, id);
  }
  private record(id: CheckId, status: CheckResult['status'], provenance: CheckResult['provenance'], reason: CheckResult['reason']) {
    this.update(s => { s.checks = [...s.checks.filter(c => c.id !== id), { id, status, provenance, reason, at: this.o.clock.now() }]; });
  }
  private fact(id: CheckId, ok: boolean, reason: CheckResult['reason'] = 'invalid-response') {
    this.record(id, ok ? 'pass' : 'fail', 'automated', ok ? 'verified' : reason);
    if (!ok) throw new Halt(reason, 'fail');
  }
  private cancelled() { if (this.signal?.aborted) throw new Halt('interrupted'); }
  private async ask(id: PromptId, message: string, c?: SyntheticCase, cleanup = false): Promise<PromptOutcome> {
    if (!cleanup) this.cancelled();
    const result = await this.o.prompt({ id, stage: this.state().stage, message, ...(c ? { case: { label: c.label, caseNumber: c.caseNumber, dueAt: c.dueAt } } : {}) });
    if (!cleanup) this.cancelled();
    return ['approved', 'declined', 'unavailable', 'cancelled'].includes(result) ? result : 'unavailable';
  }
  private async approve(id: PromptId, message: string, c?: SyntheticCase, cleanup = false) {
    const result = await this.ask(id, message, c, cleanup);
    if (result !== 'approved') throw new Halt(result === 'cancelled' ? 'interrupted' : result);
  }
  private async human(id: CheckId, message: string) {
    const result = await this.ask(id, message);
    this.record(id, result === 'approved' ? 'pass' : result === 'declined' ? 'fail' : 'blocked', 'owner-reported', result === 'approved' ? 'verified' : result === 'declined' ? 'not-observed' : result === 'cancelled' ? 'interrupted' : 'unavailable');
    if (result !== 'approved') throw new Halt(result === 'declined' ? 'not-observed' : 'unavailable', result === 'declined' ? 'fail' : 'blocked');
  }
  private async authority(operation: HostOperation, cleanup = false): Promise<HostAuthority> {
    if (this.o.mode !== 'non-production-live' || this.o.hostDisruption !== true || !this.liveApproved) throw new Halt('unauthorized');
    await this.approve(operation, `Approve this stage's ${operation} on the non-production installation. This may interrupt R2. Recovery must restore the originally active service and temporary model configuration.`, undefined, cleanup);
    const s = this.state();
    const approval: StageApproval = { runId: s.runId, stage: s.stage, operation, outcome: 'approved' };
    return { nonProduction: true, hostDisruption: true, approval };
  }
  private async host(operation: Exclude<HostOperation, 'restore-model'>, beforeDue?: SyntheticCase) {
    const authority = await this.authority(operation); this.cancelled();
    if (beforeDue) this.window(beforeDue);
    await this.o.host.operate(this.o.lease, operation, authority);
  }
  private async session<T>(call: () => Promise<T>): Promise<T> {
    try { return await call(); } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'unauthorized' || !this.o.reauthenticate) throw e;
      await this.o.reauthenticate(); return call();
    }
  }
  private async model(enabled: boolean, id?: CheckId) {
    const ok = (await this.session(() => this.o.api.status())).assistantConfigured === enabled;
    if (id) this.fact(id, ok); else if (!ok) throw new Halt('invalid-response', 'fail');
  }
  /** Pause snapshot and restoration intent survive session loss, including a lost PUT response. */
  private async pause(paused: boolean, restore = false, beforeDue?: SyntheticCase) {
    let s = this.state();
    if (!restore) {
      if (s.pending) throw new Halt('conflict');
      await this.approve(paused ? 'pause' : 'temporary-unpause', paused ? 'Temporarily pause notifications before due. The original preference will be restored.' : 'Temporarily unpause notifications. This can release all overdue owner reminders, not only synthetic cases. Restore the original preference on exit.');
    }
    const settings = await this.session(() => this.o.api.settings());
    if (restore && s.cleanup.originalPause === null) throw new Halt('conflict');
    const target = restore ? s.cleanup.originalPause! : paused;
    if (!restore && settings.notificationsPaused === target) return;
    if (beforeDue) this.window(beforeDue);
    // Restoration may coexist with an unresolved case intent. Preserve that exact intent.
    const independent = restore && s.pending !== null && !['pause', 'restore-pause'].includes(s.pending.operation);
    if (!s.pending) {
      const seq = s.sequence; s.sequence++; s.updatedAt = Math.max(s.updatedAt, this.o.clock.now());
      s.cleanup.originalPause ??= settings.notificationsPaused;
      s.cleanup.pauseRestoreNeeded = true; s.cleanup.status = 'restore-needed';
      s.pending = { id: randomUUID(), operation: restore ? 'restore-pause' : 'pause', stage: s.stage, at: this.o.clock.now(), caseLabel: null, caseRequestId: null };
      this.o.lease.beginMutation(s, seq);
    }
    await this.session(() => this.o.api.pause(target));
    if ((await this.session(() => this.o.api.settings())).notificationsPaused !== target) throw new Halt('invalid-response', 'fail');
    const edit = (next: Journal) => {
      if (restore) {
        next.cleanup.pauseRestoreNeeded = false;
        if (!['failed', 'conflict'].includes(next.cleanup.status)) next.cleanup.status = next.cleanup.serviceRestoreNeeded || next.cleanup.daemonReloadNeeded || next.cleanup.artifacts.length ? 'restore-needed' : 'verified';
      }
    };
    if (independent) this.update(edit); else this.resolve(edit);
  }
  private async restoreHost() {
    const s = this.state();
    if (s.cleanup.serviceRestoreNeeded || s.cleanup.daemonReloadNeeded || s.cleanup.artifacts.length || s.pending && hostOperations.includes(s.pending.operation)) {
      const result = await this.o.host.recover(this.o.lease, await this.authority('restore-model', true));
      if (result.status === 'conflict' || result.status === 'failed') throw new Halt(result.status === 'conflict' ? 'conflict' : 'operation-failed', 'fail');
      await this.model(true);
    }
  }
  /** Reconcile owned state before any stage. A lost model response is NEVER automatically retried. */
  private async recoverOwned() {
    // Attempt independent cleanup even if another adapter fails. Never forget either obligation.
    let failure: unknown;
    if (this.state().pending && ['pause', 'restore-pause'].includes(this.state().pending!.operation)) {
      try { await this.pause(false, true); } catch (e) { failure = e; }
    }
    try { await this.restoreHost(); } catch (e) { failure ??= e; }
    if (this.state().cleanup.pauseRestoreNeeded) {
      try { await this.pause(false, true); } catch (e) { failure ??= e; }
    }
    if (failure) throw failure;
    if (this.state().pending?.operation === 'confirm') await this.session(() => this.cases.reconcileConfirmation());
    if (this.state().pending) throw new Halt('interrupted');
    if (this.state().cleanup.status === 'failed') {
      const facts = await this.o.host.inspect(), s = this.state();
      if (!facts.ready || !bound(facts.installation, s.installation) || s.cleanup.serviceRestoreNeeded || s.cleanup.daemonReloadNeeded || s.cleanup.artifacts.length || s.cleanup.pauseRestoreNeeded) throw new Halt('operation-failed', 'fail');
      await this.model(true);
      if (s.cleanup.originalPause !== null && (await this.session(() => this.o.api.settings())).notificationsPaused !== s.cleanup.originalPause) throw new Halt('conflict');
      this.update(next => { next.cleanup.status = 'verified'; });
    }
    if (this.state().cleanup.status !== 'verified') throw new Halt('operation-failed', 'fail');
  }
  private async cleanup() {
    try {
      await this.recoverOwned();
      const facts = await this.o.host.inspect();
      if (!facts.active || !facts.healthy || !bound(facts.installation, this.state().installation)) throw new Halt('unsafe-installation', 'fail');
      const originalPause = this.state().cleanup.originalPause;
      if (originalPause !== null && (await this.session(() => this.o.api.settings())).notificationsPaused !== originalPause) throw new Halt('conflict', 'fail');
      this.record('cleanup', 'pass', 'automated', 'verified');
    } catch (e) {
      const reason = e instanceof Halt ? e.reason : e instanceof ApiError && e.code === 'unauthorized' ? 'unauthorized' : 'operation-failed';
      this.update(s => { if (reason === 'conflict') s.cleanup.status = 'conflict'; else if (s.cleanup.status !== 'conflict') s.cleanup.status = 'failed'; });
      this.record('cleanup', 'fail', 'automated', reason);
    }
  }
  private async preflight() {
    const facts = await this.o.host.inspect();
    this.fact('installation', facts.ready && bound(facts.installation, this.state().installation), 'unsafe-installation');
    this.fact('https', facts.privateHttps);
    const settings = await this.o.api.settings();
    this.fact('authentication', true);
    this.fact('origin-rejected', await this.o.api.probe('bad-origin') === 'forbidden');
    this.fact('timezone', settings.timezone !== null);
    if (this.state().cleanup.originalPause === null) this.update(s => { s.cleanup.originalPause = settings.notificationsPaused; });
    const status = await this.o.api.status();
    this.fact('model-enabled', status.assistantConfigured);
    if (status.notifications.pausedByConfig || !status.notifications.pushConfigured) throw new Halt('unavailable');
  }
  private async readyForStage() {
    const facts = await this.o.host.inspect();
    if (!facts.ready || !bound(facts.installation, this.state().installation)) throw new Halt('unsafe-installation');
    const settings = await this.o.api.settings(), status = await this.o.api.status();
    if (!settings.timezone || !status.assistantConfigured || status.notifications.pausedByConfig || !status.notifications.pushConfigured) throw new Halt('unavailable');
  }
  private async browser() {
    await this.approve('connect', 'Use real stock Firefox on the MacBook, not a managed substitute. Connect replaces the single notification recipient. Confirm that replacing it is intended BEFORE pressing Connect. Then use the app Connect and test controls. Do not Connect from another device.');
    await this.human('firefox-permission', 'In stock Firefox on the MacBook, explicitly allow this private site and Firefox notifications in OS settings. Use the app Connect and test controls now. Are both permissions allowed?');
    const push = await this.o.api.push(); this.fact('test-provider', push.subscription.connected && push.subscription.ready);
    await this.human('test-observed', 'Did the actual test desktop notification appear in the intended stock Firefox on the MacBook? Provider acceptance alone is not display evidence.');
    await this.human('generic-wording', 'Were BOTH title and body generic, with no reminder text or due time?');
    await this.human('click-through', 'Did clicking the notification open the intended private HTTPS origin and require owner authentication when signed out? There is no receipt-confirmation API.');
  }
  private window(c: SyntheticCase) { if (this.o.clock.now() + 60_000 >= c.dueAt) throw new Halt('missed-window'); }
  private async create(label: SyntheticCase['label']) {
    await this.model(true);
    const settings = await this.o.api.settings(); if (!settings.timezone) throw new Halt('unavailable');
    const number = Math.max(0, ...this.state().cases.filter(c => c.label === label).map(c => c.caseNumber)) + 1;
    const plan = makeCase(label, number, settings.timezone, this.o.clock.now(), this.o.leadMs ?? 600_000);
    await this.approve('create-case', 'This model request spends quota. Explicit confirmation creates a permanent synthetic reminder. There is no deletion, cancellation or retry-reset route. Approve this case?', plan.record);
    if (await this.cases.propose(plan) !== 'proposed') throw new Halt('invalid-response', 'fail');
    if (label === 'A') {
      // Absence in a truncated list is not proof. Exact ID and an untruncated list are required.
      const rows = await this.o.api.reminders();
      this.fact('proposal-unsaved', rows.length < 500 && !rows.some(r => r.proposalId === this.state().cases.at(-1)!.proposalId));
    }
    const c = this.state().cases.at(-1)!;
    await this.approve('confirm-case', 'Explicitly save this exact proposed synthetic case. It will remain in the app. The runner will not move its due time.', c);
    await this.cases.confirm(c.requestId);
    if (label === 'A') { await this.cases.repeatConfirmation(c.requestId); this.fact('duplicate-save', true); }
    return this.state().cases.find(x => x.requestId === c.requestId)!;
  }
  private async clarification() {
    if (this.state().checks.some(c => c.id === 'clarification' && c.status === 'pass')) return;
    await this.approve('create-case', 'Send one deliberately ambiguous synthetic request to check clarification without saving. This spends model quota.');
    const timezone = (await this.o.api.settings()).timezone; if (!timezone) throw new Halt('unavailable');
    const plan = makeCase('A', Math.max(0, ...this.state().cases.filter(c => c.label === 'A').map(c => c.caseNumber)) + 1, timezone, this.o.clock.now(), this.o.leadMs ?? 600_000);
    const before = await this.o.api.reminders();
    let s = this.update(s => { s.cases.push(plan.record); }); const seq = s.sequence;
    s = { ...s, sequence: seq + 1, updatedAt: Math.max(s.updatedAt, this.o.clock.now()), pending: { id: randomUUID(), operation: 'propose', stage: s.stage, at: this.o.clock.now(), caseLabel: 'A', caseRequestId: plan.record.requestId } };
    this.o.lease.beginMutation(s, seq);
    let response: Awaited<ReturnType<AcceptanceApi['chat']>>;
    try { response = await this.o.api.chat('Remind me about something.'); }
    catch (e) {
      this.update(next => { const c = next.cases.find(c => c.requestId === plan.record.requestId)!; c.phase = 'proposal-unresolved'; c.reason = 'interrupted'; });
      throw e;
    }
    this.resolve(s => { const c = s.cases.find(c => c.requestId === plan.record.requestId)!; c.phase = 'blocked'; c.reason = response.type === 'clarify' ? 'verified' : 'invalid-response'; if (response.type === 'proposal') c.proposalId = response.proposal.id; });
    const after = await this.o.api.reminders();
    this.fact('clarification', response.type === 'clarify' && before.length < 500 && after.length < 500 && before.length === after.length && before.every(r => after.some(a => a.id === r.id)));
  }
  private async retain(c: SyntheticCase, id: CheckId) { const r = await findKnown(this.o.api, c.reminderId!); this.fact(id, r !== null && retained(c, r)); }
  private async until(at: number) { this.cancelled(); await this.o.wait.until(at, this.signal); this.cancelled(); }
  private async delivery(c: SyntheticCase, provider: CheckId, observed: CheckId, normal = false) {
    if (normal && this.o.clock.now() >= c.dueAt) { this.record('a-timing', 'blocked', 'automated', 'missed-window'); }
    await this.until(Math.max(this.o.clock.now(), c.dueAt));
    const start = this.o.clock.now();
    const clock: Clock = { now: () => { this.cancelled(); return this.o.clock.now(); } };
    const result = await pollReminder(this.o.api, c.reminderId!, clock, { until: at => this.until(at) }, clock.now() + (this.o.providerWindowMs ?? 120_000), 1000);
    this.update(s => { const item = s.cases.find(x => x.requestId === c.requestId)!; item.attemptAt ??= result.attemptAt; item.acceptedAt ??= result.acceptedAt; });
    this.fact(provider, result.kind === 'accepted', 'timeout');
    if (normal && !this.state().checks.some(x => x.id === 'a-timing' && x.reason === 'missed-window')) {
      const timely = start <= c.dueAt && result.attemptAt !== null && result.attemptAt >= c.dueAt && result.attemptAt <= c.dueAt + 60_000;
      this.record('a-timing', timely ? 'pass' : 'fail', 'automated', timely ? 'verified' : 'missed-window');
    }
    await this.human(observed, `Did the actual ${c.label}-${c.caseNumber} desktop notification appear on the intended MacBook stock Firefox? Answer from observation, not provider status. Display timing is not the provider-submission measurement.`);
  }
  private async scenario(label: 'A' | 'B' | 'C') {
    if (this.o.hostDisruption !== true) throw new Halt('unauthorized');
    await this.pause(false);
    if (label === 'A') await this.clarification();
    const c = await this.create(label); this.window(c);
    if (label === 'A') {
      await this.host('disable-model', c); this.window(c);
      await this.model(false, 'a-model-disabled'); await this.retain(c, 'a-retained');
      await this.human('tabs-closed', 'Close EVERY R2 tab on every device while keeping stock Firefox running on the MacBook. Have you done this?');
      await this.delivery(c, 'a-provider', 'a-observed', true);
    } else if (label === 'B') {
      await this.host('stop', c); this.window(c);
      await this.until(c.dueAt + 5000);
      await this.host('disable-model'); // Owned stopped installation starts with the override already loaded.
      await this.model(false, 'b-model-disabled'); await this.retain(c, 'b-retained');
      await this.delivery(c, 'b-provider', 'b-observed');
    } else {
      await this.pause(true, false, c); this.window(c);
      await this.host('restart');
      this.fact('c-pause-retained', (await this.o.api.settings()).notificationsPaused && (await this.o.api.status()).notifications.paused);
      await this.until(c.dueAt + 5000);
      const r = await findKnown(this.o.api, c.reminderId!);
      this.fact('c-no-attempt', r !== null && r.attempts === 0 && r.deliveryAttempts.length === 0 && r.acceptedAt === null);
      await this.retain(c, 'c-retained'); await this.pause(false);
      await this.delivery(c, 'c-provider', 'c-observed');
    }
    await this.restoreHost();
    if (this.state().cleanup.pauseRestoreNeeded) await this.pause(false, true);
    await this.model(true);
  }
  private async devices() {
    const before = await this.o.api.push();
    await this.human('second-device', 'On a second authorized device, sign in and send a chat request without pressing Connect or Save. Did chat work? Leave the MacBook Firefox as recipient.');
    const after = await this.o.api.push(); this.fact('recipient-unchanged', sameSubscription(before, after));
    await this.human('second-device-observed', 'Using the app test control without Connect, did the test notification still appear on the intended MacBook stock Firefox, not the second device?');
    this.fact('recipient-unchanged', sameSubscription(before, await this.o.api.push()));
    await this.human('signed-out-denied', 'On a signed-out browser, verify private reminder/chat access is denied. Did you actually observe denial? This does not sign out the runner session.');
    await this.human('outside-tailnet-denied', 'From a real client OUTSIDE the tailnet, try the private app origin. Was access actually denied? If no such client is available, answer unavailable. Localhost tests or ACL review do not count.');
    await this.human('excluded-client-denied', 'From a real tailnet client EXCLUDED by policy, try the private app origin. Was access actually denied? Missing excluded clients are unavailable, not pass. ACL review alone does not count.');
  }
  /** Inspection and anonymous safe GET only. No authenticated session, prompts, service or app writes. */
  async inspect() {
    const facts = await this.o.host.inspect();
    const anonymous = await this.o.api.probe('anonymous');
    return { ready: facts.ready, anonymousDenied: anonymous === 'unauthorized' };
  }
  /** The caller acquires/takes over the host-wide lease first. Reports are exported on every live exit. */
  async run(signal?: AbortSignal) {
    if (this.busy || activeRunners.has(this.o.lease)) throw new Halt('conflict');
    if (this.o.mode === 'read-only') return this.inspect();
    if (this.o.mode !== 'non-production-live') throw new Halt('unauthorized');
    if (this.state().pending?.operation === 'reboot') { this.o.lease.exportReports(); return projectReport(this.state()); }
    activeRunners.add(this.o.lease);
    this.cancellation = new AbortController();
    this.busy = true; this.signal = signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal; this.liveApproved = false;
    try {
      await this.approve('live-run', 'Explicit non-production live run: model requests cost quota, confirmations leave permanent synthetic reminders, Connect replaces the recipient, and opted-in service operations interrupt R2. No timezone changes or reminder deletion will occur.');
      this.liveApproved = true;
      await this.recoverOwned();
      if (this.state().coordinator?.active) throw new Halt('interrupted');
      for (const stage of ['preflight', 'browser', 'case-a', 'case-b', 'case-c', 'devices'] as const) {
        if (this.state().coordinator?.completed.includes(stage)) continue;
        this.cancelled();
        this.update(s => { s.stage = stage; s.coordinator ??= { completed: [], active: null }; s.coordinator.active = stage; });
        if (stage === 'preflight') await this.preflight();
        else {
          await this.readyForStage();
          if (stage === 'browser') await this.browser();
          else if (stage === 'devices') await this.devices();
          else await this.scenario(stage === 'case-a' ? 'A' : stage === 'case-b' ? 'B' : 'C');
        }
        this.update(s => { s.coordinator!.completed.push(stage); s.coordinator!.active = null; });
      }
      this.update(s => { s.stage = 'complete'; });
      this.record('coordination', 'pass', 'automated', 'verified');
    } catch (e) {
      const reason = this.signal?.aborted ? 'interrupted' : e instanceof Halt ? e.reason
        : e instanceof CaseError ? e.code === 'too-late' ? 'missed-window' : 'invalid-response'
        : e instanceof ApiError ? e.code === 'unauthorized' ? 'unauthorized' : e.code === 'timeout' ? 'timeout' : 'invalid-response' : 'operation-failed';
      this.record('coordination', e instanceof Halt ? e.status : reason === 'interrupted' || reason === 'missed-window' ? 'blocked' : 'fail', 'automated', reason);
    } finally {
      try { if (this.liveApproved) await this.cleanup(); }
      finally { try { this.o.lease.exportReports(); } finally { this.busy = false; activeRunners.delete(this.o.lease); } }
    }
    return projectReport(this.state());
  }
  /** Explicit recovery does not replay stages. Reauthentication is allowed only in memory. */
  async recover() {
    if (this.busy || activeRunners.has(this.o.lease) || this.o.mode !== 'non-production-live') throw new Halt('unauthorized');
    if (this.state().pending?.operation === 'reboot') { this.o.lease.exportReports(); return projectReport(this.state()); }
    activeRunners.add(this.o.lease);
    this.busy = true; this.signal = undefined; this.liveApproved = false;
    try {
      await this.approve('live-run', 'Recover this non-production run only. Restore owned host changes and original notification pause; do not start new cases.', undefined, true);
      this.liveApproved = true; await this.cleanup(); return projectReport(this.state());
    } finally { try { this.o.lease.exportReports(); } finally { this.busy = false; activeRunners.delete(this.o.lease); } }
  }
  /** A deliberate retry retains old cases. No implicit new reminders on resume. */
  async retryStage() {
    if (this.busy || activeRunners.has(this.o.lease) || this.o.mode !== 'non-production-live') throw new Halt('unauthorized');
    activeRunners.add(this.o.lease); this.busy = true;
    this.signal = undefined;
    try {
      const s = this.state(); if (!s.coordinator?.active) throw new Halt('conflict');
      await this.approve('retry-stage', 'Deliberately retry the interrupted stage. Existing synthetic reminders remain and may still send. A new case costs quota and may create another permanent reminder. Old case outcomes will be retained.', undefined, true);
      if (s.cleanup.pauseRestoreNeeded || s.cleanup.serviceRestoreNeeded || s.cleanup.artifacts.length || s.cleanup.daemonReloadNeeded) throw new Halt('conflict');
      if (s.pending?.operation === 'propose') {
        this.resolve(next => { const c = next.cases.find(c => c.requestId === next.pending!.caseRequestId)!; c.phase = 'blocked'; c.reason = 'interrupted'; });
      } else if (s.pending) throw new Halt('conflict');
      this.update(next => {
        for (const c of next.cases.filter(c => c.phase !== 'blocked' && c.label === (s.stage === 'case-a' ? 'A' : s.stage === 'case-b' ? 'B' : s.stage === 'case-c' ? 'C' : 'reboot'))) c.reason ??= 'interrupted';
        next.coordinator!.active = null;
      });
    } finally { try { this.o.lease.exportReports(); } finally { this.busy = false; activeRunners.delete(this.o.lease); } }
  }
  /** Explicit reboot preparation owns the same coordinator gate as ordinary stages. */
  async withRebootPreparation<T>(work: (checkpoint: () => ReturnType<AcceptanceRunner['rebootCheckpoint']>) => Promise<T>): Promise<T> {
    if (this.busy || activeRunners.has(this.o.lease) || this.o.mode !== 'non-production-live' || !this.o.hostDisruption) throw new Halt('unauthorized');
    activeRunners.add(this.o.lease); this.busy = true; this.signal = undefined; this.liveApproved = false;
    try {
      await this.approve('live-run', 'Prepare an explicitly opted-in non-production reboot. Restore all temporary settings first. New synthetic reminders cost quota and cannot be cancelled.', undefined, true);
      this.liveApproved = true;
      await this.recoverOwned();
      if (this.state().coordinator?.active || !['case-a', 'case-b', 'case-c', 'devices'].every(stage => this.state().coordinator?.completed.includes(stage as Stage))) throw new Halt('conflict');
      await this.readyForStage();
      return await work(() => this.rebootEligibility());
    } finally {
      try { if (this.liveApproved && this.state().pending?.operation !== 'reboot') await this.cleanup(); }
      finally { try { this.o.lease.exportReports(); } finally { this.busy = false; activeRunners.delete(this.o.lease); } }
    }
  }
  /** Post-boot provider work only. Original pause is restored on every exit, including true.
   * Never leaves deliberate pause debt across the reboot boundary. */
  async withRebootNotifications<T>(work: (enableNotifications: () => Promise<void>) => Promise<T>, inspect?: () => Promise<void>): Promise<T> {
    if (this.busy || activeRunners.has(this.o.lease) || this.o.mode !== 'non-production-live' || !this.state().reboot) throw new Halt('unauthorized');
    activeRunners.add(this.o.lease); this.busy = true; this.signal = undefined; this.liveApproved = false;
    try {
      await inspect?.();
      if (this.state().reboot?.phase !== 'resumed') throw new Halt('conflict');
      await this.approve('live-run', 'Inspect this resumed non-production reboot case and restore original pause on exit. No new case or reboot will be scheduled.', undefined, true);
      this.liveApproved = true;
      await this.recoverOwned();
      if ((await this.session(() => this.o.api.settings())).notificationsPaused !== this.state().cleanup.originalPause) throw new Halt('conflict', 'fail');
      await this.readyForStage();
      return await work(async () => {
        if (!this.state().checks.some(c => c.id === 'reboot-provider' && c.status === 'pass') &&
          (await this.session(() => this.o.api.settings())).notificationsPaused) {
          const c = this.state().cases.find(c => c.requestId === this.state().reboot!.caseRequestId)!;
          // Originally paused owners keep that preference across boot and due. This is an
          // explicitly approved overdue test, never normal-condition submission evidence.
          if (this.o.clock.now() <= c.dueAt) await this.o.wait.until(c.dueAt + 1);
          await this.pause(false);
        }
      });
    } catch (e) {
      if (this.liveApproved && !this.state().checks.some(c => c.id === 'reboot-provider' && c.status === 'pass')) {
        this.record('reboot-provider', 'blocked', 'automated', e instanceof Halt ? e.reason : e instanceof ApiError && e.code === 'unauthorized' ? 'unauthorized' : 'operation-failed');
      }
      throw e;
    } finally {
      try { if (this.liveApproved) await this.cleanup(); }
      finally { try { this.o.lease.exportReports(); } finally { this.busy = false; activeRunners.delete(this.o.lease); } }
    }
  }
  /** Read-only eligibility, not reboot authority or a fabricated boot-change fact. */
  rebootCheckpoint() {
    if (this.busy || activeRunners.has(this.o.lease)) throw new Halt('conflict');
    return this.rebootEligibility();
  }
  private rebootEligibility() {
    const s = this.state();
    if (s.pending || s.cleanup.status !== 'verified' || s.coordinator?.active ||
      !['case-a', 'case-b', 'case-c', 'devices'].every(stage => s.coordinator?.completed.includes(stage as Stage))) throw new Halt('conflict');
    const c = s.cases.find(c => c.label === 'reboot' && c.phase === 'confirmed');
    if (!c || c.dueAt <= this.o.clock.now() + 60_000) throw new Halt('missed-window');
    return { installation: s.installation, previousBootId: s.priorBootId, caseLabel: 'reboot' as const, caseRequestId: c.requestId, phase: 'prepared' as const, at: this.o.clock.now() };
  }
}
