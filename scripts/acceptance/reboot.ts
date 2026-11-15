import { randomUUID } from 'node:crypto';
import { ApiError } from './api.ts';
import { AcceptanceCases, findKnown, makeCase, pollReminder, retained } from './cases.ts';
import { idSchema, type CheckId, type CheckResult, type Journal, type PromptOutcome, type SyntheticCase } from './contracts.ts';
import type { AcceptanceHost } from './host.ts';
import { AcceptanceRunner, type RunnerOptions } from './runner.ts';
import { projectReport } from './report.ts';

export class RebootError extends Error {
  constructor(readonly code: 'unauthorized' | 'conflict' | 'same-boot' | 'unsafe-installation' | 'missed-window' | 'declined' | 'unavailable' | 'operation-failed') {
    super(`Acceptance reboot blocked: ${code}.`); this.name = 'RebootError';
  }
}
export interface RebootOptions extends RunnerOptions {
  host: Pick<AcceptanceHost, 'inspect' | 'operate' | 'recover' | 'bootId' | 'identity' | 'inspectBoot' | 'reboot'>;
  rebootCapability: boolean;
  /** Stops new reboot work after process interruption; cleanup remains independently available. */
  signal?: AbortSignal;
  /** Actual caller terminal fact, not a flag or a persisted approval. */
  interactive: () => boolean;
  /** Render the exact manual resume invocation for this run using the future CLI's syntax.
   * Obtain a fresh explicit acknowledgement. Never put a credential in that command. */
  acknowledgeResume: (runId: string) => Promise<PromptOutcome>;
}
const sameInstallation = (a: Journal['installation'], b: Journal['installation']) =>
  a.hostFingerprint === b.hostFingerprint && a.unit === b.unit && a.revision === b.revision;

/** Explicit library operations only. No real executor, CLI, credential file or auto-resume unit. */
export class AcceptanceReboot {
  private readonly runner: AcceptanceRunner;
  constructor(private readonly o: RebootOptions) {
    this.runner = new AcceptanceRunner(o);
    if ((o.leadMs ?? 600_000) > 3_600_000) throw new RebootError('missed-window');
  }
  private state() { return this.o.lease.load(); }
  private update(edit: (s: Journal) => void, resolve = false) {
    const s = this.state(), seq = s.sequence, intent = s.pending?.id;
    s.sequence++; s.updatedAt = Math.max(s.updatedAt, this.o.clock.now()); edit(s);
    if (resolve) {
      if (!intent) throw new RebootError('conflict');
      s.pending = null; return this.o.lease.resolveRecovery(s, seq, intent);
    }
    return intent ? this.o.lease.checkpointMutation(s, seq, intent) : this.o.lease.commit(s, seq);
  }
  private record(id: CheckId, status: CheckResult['status'], reason: CheckResult['reason'], human = false) {
    this.update(s => { s.checks = [...s.checks.filter(c => c.id !== id), { id, status, reason,
      provenance: human ? 'owner-reported' : 'automated', at: this.o.clock.now() }]; });
  }
  private gate() {
    // load proves current exclusive lock ownership, including after a verified stale takeover.
    const s = this.state();
    if (this.o.signal?.aborted || this.o.mode !== 'non-production-live' || !this.o.rebootCapability || !this.o.hostDisruption || !this.o.interactive()) throw new RebootError('unauthorized');
    const boot = idSchema.safeParse(this.o.host.bootId());
    if (!boot.success) throw new RebootError('unsafe-installation');
    if (this.o.lease.owner.bootId !== boot.data) throw new RebootError('conflict');
    return s;
  }
  private async approve(id: 'create-case' | 'confirm-case', message: string, c: SyntheticCase) {
    const answer = await this.o.prompt({ id, stage: 'reboot', message, case: { label: c.label, caseNumber: c.caseNumber, dueAt: c.dueAt } });
    if (answer !== 'approved') throw new RebootError(answer === 'declined' ? 'declined' : 'unavailable');
  }
  private async session<T>(call: () => Promise<T>): Promise<T> {
    try { return await call(); } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'unauthorized' || !this.o.reauthenticate) throw e;
      await this.o.reauthenticate(); return call();
    }
  }
  /** A second prepare never repeats a reboot, even after an uncertain command result. */
  async prepare() {
    const initial = this.gate();
    if (initial.reboot) throw new RebootError('conflict');
    try {
      await this.runner.withRebootPreparation(async checkpoint => {
        this.gate(); this.update(s => { s.stage = 'reboot'; s.coordinator!.rebootSelected = true; });
        const facts = await this.o.host.inspectBoot();
        if (!facts.ready || !sameInstallation(facts.installation, this.state().installation)) throw new RebootError('unsafe-installation');
        const previousBootId = this.o.host.bootId();
        // The baseline runner binds its eligibility checkpoint to the run's original boot.
        if (previousBootId !== this.state().priorBootId) throw new RebootError('conflict');
        let c = this.state().cases.find(c => c.label === 'reboot');
        if (c && c.phase !== 'confirmed') throw new RebootError('conflict');
        if (!c) {
          const settings = await this.session(() => this.o.api.settings());
          if (!settings.timezone) throw new RebootError('unsafe-installation');
          const plan = makeCase('reboot', 1, settings.timezone, this.o.clock.now(), this.o.leadMs ?? 600_000);
          await this.approve('create-case', 'Spend model quota for one reboot case? Explicit save creates a permanent synthetic reminder with no cancellation route. Browser setup will not change.', plan.record);
          this.gate();
          const cases = new AcceptanceCases(this.o.api, this.o.lease, this.o.clock);
          if (await cases.propose(plan) !== 'proposed') throw new RebootError('operation-failed');
          await this.approve('confirm-case', 'Save this reboot proposal at its original due time? Allow enough time to reboot and manually resume. No due time will be moved.', plan.record);
          this.gate();
          await cases.confirm(plan.record.requestId);
          c = this.state().cases.find(c => c.requestId === plan.record.requestId)!;
        }
        const known = await this.session(() => findKnown(this.o.api, c!.reminderId!));
        if (!known || !retained(c, known) || known.attempts !== 0) throw new RebootError('conflict');
        this.update(s => { s.reboot = checkpoint(); });
        // A crash from here leaves a prepared checkpoint. It cannot authorize an action.
        if (await this.o.acknowledgeResume(this.state().runId) !== 'approved') {
          this.update(s => { s.reboot!.phase = 'declined'; });
          this.record('reboot-changed', 'blocked', 'declined'); return;
        }
        const outcome = await this.o.prompt({ id: 'reboot', stage: 'reboot', message: 'Approve rebooting this non-production host NOW. Manual resume instructions have been acknowledged. This approval applies only to this action.' });
        if (outcome !== 'approved') {
          this.update(s => { s.reboot!.phase = 'declined'; });
          this.record('reboot-changed', 'blocked', outcome === 'declined' ? 'declined' : 'unavailable'); return;
        }
        this.gate();
        if (c.dueAt <= this.o.clock.now() + 60_000) throw new RebootError('missed-window');
        const settings = await this.session(() => this.o.api.settings()), s = this.state();
        if (s.cleanup.status !== 'verified' || settings.notificationsPaused !== s.cleanup.originalPause) throw new RebootError('conflict');
        const next = { ...s, sequence: s.sequence + 1, updatedAt: Math.max(s.updatedAt, this.o.clock.now()),
          reboot: { ...s.reboot!, phase: 'pending' as const }, pending: { id: randomUUID(), operation: 'reboot' as const,
            stage: 'reboot' as const, at: this.o.clock.now(), caseLabel: 'reboot' as const, caseRequestId: c.requestId } };
        this.o.lease.beginMutation(next, s.sequence);
        try {
          if (this.o.signal?.aborted) throw new RebootError('unavailable');
          await this.o.host.reboot(this.o.lease, { nonProduction: true, hostDisruption: true,
            approval: { runId: s.runId, stage: 'reboot', operation: 'reboot', outcome: 'approved' } });
        } catch {
          // Even a nonzero systemctl exit can follow an accepted D-Bus action. Preserve
          // scheduling uncertainty, just as for timeout or process death. Never replay.
          this.update(s => { s.reboot!.phase = 'failed'; });
          this.record('reboot-changed', 'blocked', 'operation-failed');
          throw new RebootError('operation-failed');
        }
      });
    } catch (e) {
      this.record('reboot-changed', 'blocked', e instanceof RebootError && ['declined', 'unavailable', 'missed-window'].includes(e.code)
        ? e.code as 'declined' | 'unavailable' | 'missed-window' : 'operation-failed');
      if (e instanceof RebootError) throw e;
      throw new RebootError('operation-failed');
    } finally { this.o.lease.exportReports(); }
    return projectReport(this.state());
  }
  /** Inspect automatic recovery before coordinator cleanup can restart anything. Never creates a case. */
  async resume() {
    this.gate();
    try {
      await this.runner.withRebootNotifications(async enableNotifications => {
        const s = this.state(), c = s.cases.find(c => c.requestId === s.reboot!.caseRequestId)!;
        if (s.checks.some(c => c.id === 'reboot-retained' && c.status === 'fail')) throw new RebootError('conflict');
        if (!s.checks.some(c => c.id === 'reboot-retained' && c.status === 'pass')) {
          const row = await this.session(() => findKnown(this.o.api, c.reminderId!));
          this.record('reboot-retained', row && retained(c, row) ? 'pass' : 'fail', row && retained(c, row) ? 'verified' : 'invalid-response');
          if (!row || !retained(c, row)) throw new RebootError('conflict');
        }
        if (!this.state().checks.some(c => c.id === 'reboot-provider' && c.status === 'pass')) {
          this.gate();
          await enableNotifications();
          const result = await this.session(() => pollReminder(this.o.api, c.reminderId!, this.o.clock, this.o.wait,
            Math.max(c.dueAt, this.o.clock.now()) + (this.o.providerWindowMs ?? 120_000), 1000));
          this.update(next => {
            const item = next.cases.find(x => x.requestId === c.requestId)!;
            item.attemptAt ??= result.attemptAt; item.acceptedAt ??= result.acceptedAt;
            if (next.reboot!.resume!.submission === 'pending') next.reboot!.resume!.submission =
              next.reboot!.resume!.at >= c.dueAt || next.cleanup.originalPause === true ? 'overdue-recovery' :
                result.attemptAt !== null && result.attemptAt >= c.dueAt && result.acceptedAt !== null && result.acceptedAt >= result.attemptAt && result.acceptedAt <= c.dueAt + 60_000 ? 'normal-window' : 'missed-window';
          });
          this.record('reboot-provider', result.kind === 'accepted' ? 'pass' : 'blocked', result.kind === 'accepted' ? 'verified' : 'timeout');
        }
        if (!this.state().checks.some(c => c.id === 'reboot-observed' && c.status === 'pass')) {
          const result = await this.o.prompt({ id: 'reboot-observed', stage: 'reboot', message: 'Did you explicitly observe this reboot case notification in stock Firefox on the MacBook? A historical provider acceptance does not establish display. If you did not observe it, answer declined or unavailable.' });
          this.record('reboot-observed', result === 'approved' ? 'pass' : result === 'declined' ? 'fail' : 'blocked', result === 'approved' ? 'verified' : result === 'declined' ? 'not-observed' : 'unavailable', true);
        }
      }, async () => {
        const s = this.state(), cp = s.reboot;
        if (!cp || !['pending', 'failed', 'resumed'].includes(cp.phase) || !s.pending && cp.phase !== 'resumed' || s.pending && s.pending.operation !== 'reboot') throw new RebootError('conflict');
        const bootId = this.o.host.bootId();
        if (bootId === cp.previousBootId) { this.record('reboot-changed', 'blocked', 'pending'); throw new RebootError('same-boot'); }
        if (cp.resume && cp.resume.bootId !== bootId) throw new RebootError('conflict');
        // The identity check is independent of readiness. inspect() never starts a service.
        if (!sameInstallation(this.o.host.identity(), cp.installation)) { this.record('reboot-changed', 'blocked', 'unsafe-installation'); throw new RebootError('unsafe-installation'); }
        if (!cp.resume) {
          let automatic = false, serviceRepair = false;
          try { const facts = await this.o.host.inspectBoot(); automatic = facts.ready; serviceRepair = !facts.active || !facts.healthy; } catch { /* failure is evidence, never repair */ }
          // API HTTPS/authenticated reachability is also part of automatic recovery. Reauth stays in memory.
          let retainedBeforeRepair: boolean | null = null;
          try { await this.session(() => this.o.api.settings()); } catch { automatic = false; }
          try {
            const c = s.cases.find(c => c.requestId === cp.caseRequestId)!;
            const row = await this.session(() => findKnown(this.o.api, c.reminderId!));
            retainedBeforeRepair = row !== null && retained(c, row);
          } catch { automatic = false; }
          this.update(next => {
            if (serviceRepair) { next.cleanup.serviceRestoreNeeded = true; next.cleanup.status = 'restore-needed'; }
            next.reboot!.phase = 'resumed'; next.reboot!.resume = { bootId, at: this.o.clock.now(), automaticRecovery: automatic, submission: 'pending' };
            const checks: CheckResult[] = [
              { id: 'reboot-changed', status: 'pass', reason: 'verified', provenance: 'automated', at: this.o.clock.now() },
              { id: 'reboot-automatic-recovery', status: automatic ? 'pass' : 'fail', reason: automatic ? 'verified' : 'operation-failed', provenance: 'automated', at: this.o.clock.now() },
            ];
            if (retainedBeforeRepair !== null) checks.push({ id: 'reboot-retained', status: retainedBeforeRepair ? 'pass' : 'fail', reason: retainedBeforeRepair ? 'verified' : 'invalid-response', provenance: 'automated', at: this.o.clock.now() });
            next.checks = [...next.checks.filter(c => !checks.some(x => x.id === c.id)), ...checks];
          }, s.pending !== null);
        }
      });
    } catch (e) {
      if (e instanceof RebootError) throw e;
      throw new RebootError('operation-failed');
    } finally { this.o.lease.exportReports(); }
    return projectReport(this.state());
  }
}
