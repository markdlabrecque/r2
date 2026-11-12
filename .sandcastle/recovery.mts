import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { postAndDeliver, runVerifier } from "./handoff.mts";
import type { Host, Outcome, VerifierSandbox } from "./handoff.mts";

// One bounded recovery attempt (slice four, #60, continued by #74): the production lifecycle main.mts's
// `--recover <attempt>` mode runs in the project's copy, and what Factory's launcher (cli/src/recovery-run.mts) reads back
// when it settles an attempt. Import-safe: no Sandcastle, tracker, config or board import and nothing runs at import
// time. Every effect outside this file comes through RecoveryDeps (sandbox provider, workspace Git, clock, exact-container
// cleanup, host board/tracker, requirement/ownership recheck), so tests drive this same function against stubbed
// boundaries (orchestrator/recovery-runner.test.mts) and main.mts passes the real ones (recovery-sandbox.mts).
//
// runRecoveryAttempt, in order:
//  1. The worktree's HEAD must still be the tip recorded when the attempt was claimed (else ownership-refused, nothing
//     touched). The input (HEAD, `git status`, staged/unstaged diff, untracked list) is snapshotted into the attempt.
//  2. This attempt's evidence folder, `.sandcastle/evidence/<iid>/recovery/<attemptId>/`, is created fresh (never
//     reused): recovery-context.json, previous-run.json, previous-logs/ (log copies), history/ (a copy of the ticket's
//     earlier evidence, other attempts excluded) and input/ (the snapshot). Those are mounted read-only; only the rest of
//     this folder is writable by the agents. Earlier evidence (verdict.md, blocked.json, media) is never removed.
//  3. The owned container's exact name was recorded before this process started; the host-owned attempt record (outside
//     every mount) says `setup` before the container is created, and gets its sandbox id as soon as it is known.
//  4. Container ready and setup hooks done: a deadline of exactly REPAIR_DEADLINE_MS (900000 ms) starts immediately
//     before the repair agent runs (AGENT.model, never a ticket's model label) and is cleared as soon as it settles.
//     Setup, the verifier and delivery are outside it. A repair that resolves after the deadline or a cancellation
//     fired still counts as timed out or interrupted.
//  5. The agent's recovery-report.json must be well formed (cause, filesChanged, tests[{command,result}], canProceed,
//     remainingBlockers, requiresHostUpdate) with recovery-report.md beside it. Missing or malformed, cannot proceed or
//     blockers left: `unresolved`; requiresHostUpdate: `host-followup` (nothing applied, restarted or filed). The
//     report never sets the outcome or any host field: it can only stop delivery.
//  6. The worktree must be clean in the container (leftover changes, including pre-existing dirty input the agent did
//     not commit, are preserved and stop delivery; the host never commits them) and its tip must descend from the
//     recorded tip and be beyond the base. A no-change transient repair verifies the existing tip.
//  7. Requirements, prerequisites and ownership are rechecked (deps.recheck); then the shared independent verifier
//     (handoff.mts runVerifier) checks the exact tip with this attempt's evidence folder.
//  8. The container is removed by its exact name and confirmed gone before anything is imported or delivered.
//  9. The repaired tip is imported into the project's branch only by compare-and-swap against the recorded tip, then
//     requirements/ownership are rechecked and handoff.mts postAndDeliver delivers that exact tip. `delivered` is
//     recorded only after delivery succeeds; a failed or ambiguous delivery is reported, never retried here.
// Every timeout, cancellation and error aborts the agent, waits for it to settle, removes only the exact owned container
// and confirms it is gone. Unconfirmed: the attempt stays `cleanup-pending` (the launcher keeps it running and starts no
// other attempt) and the outcome is a failure. Work, logs and evidence are always kept. The outcome is written once.

export const REPAIR_MINUTES = 15;
export const REPAIR_DEADLINE_MS = 900_000;
export const REPAIR_PROMPT = "./.sandcastle/prompt.recover.md";

export type Phase = "claimed" | "setup" | "repairing" | "verifying" | "delivering" | "finished" | "cleanup-pending";
export type RecoveryOutcome = "delivered" | "unresolved" | "failed" | "timed-out" | "interrupted" | "host-followup" | "ownership-refused";
export const OUTCOMES: RecoveryOutcome[] = ["delivered", "unresolved", "failed", "timed-out", "interrupted", "host-followup", "ownership-refused"];
const PHASES: Phase[] = ["claimed", "setup", "repairing", "verifying", "delivering", "finished", "cleanup-pending"];

/** Host-owned record of one attempt. Written by the launcher (claimed) and main.mts; never mounted into a container. */
export interface AttemptRecord {
  version: 1;
  id: string;
  seq: number;
  project: string;
  iid: string;
  branch: string;
  base: string;
  startSha: string;
  worktree: string;
  container: string;
  evidence: string;
  gitDir: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  owner?: { pid: number };
  sandboxId?: string;
  deadline?: { ms: number; startedAt: string; endsAt: string; clearedAt?: string };
  input?: { head: string; dirty: string[] };
  tip?: string;
  verifier?: { tip: string; refused?: string };
  delivery?: { tip: string; ok: boolean; url?: string; reason?: string };
  intended?: RecoveryOutcome;
  outcome?: RecoveryOutcome;
  reason?: string;
  finishedAt?: string;
  events: { at: string; phase: Phase; note?: string }[];
}

export const containerFor = (attemptId: string) => `factory-recovery-${attemptId}`;
export const CONTAINER_LABEL = "factory.recovery.attempt";
export const attemptEvidence = (root: string, iid: string, attemptId: string) => resolve(root, ".sandcastle/evidence", iid, "recovery", attemptId);
export const attemptGitDir = (root: string, attemptId: string) => resolve(root, ".sandcastle/recovery", attemptId, "git");

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const str = (x: unknown) => typeof x === "string" && x.length > 0;

/** The attempt record, or why it is unusable (missing, malformed, unknown version). Never repaired or replaced. */
export function readAttemptRecord(file: string): { ok: true; record: AttemptRecord } | { ok: false; reason: string } {
  let d: any;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: existsSync(file) ? `attempt record ${file} is not valid JSON` : `attempt record ${file} is missing` };
  }
  const ok = d?.version === 1 && typeof d.id === "string" && ID.test(d.id) && Number.isInteger(d.seq) && d.seq > 0
    && [d.project, d.iid, d.branch, d.base, d.startSha, d.worktree, d.container, d.evidence, d.gitDir, d.createdAt, d.updatedAt].every(str)
    && d.container === containerFor(d.id) && PHASES.includes(d.phase) && Array.isArray(d.events)
    && (d.outcome === undefined || OUTCOMES.includes(d.outcome)) && (d.intended === undefined || OUTCOMES.includes(d.intended));
  return ok ? { ok: true, record: d } : { ok: false, reason: `attempt record ${file} has an unsupported shape or version` };
}

/** Write the record atomically (temp + rename, 0600). */
export function writeAttemptRecord(file: string, r: AttemptRecord): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

// ---- the repair agent's report ------------------------------------------------------------------------------------

export interface RepairReport {
  cause: string;
  filesChanged: string[];
  tests: { command: string; result: string }[];
  canProceed: boolean;
  remainingBlockers: unknown[];
  requiresHostUpdate: boolean;
}
export type ReportCheck = { ok: true; report: RepairReport } | { ok: false; outcome: "unresolved" | "host-followup"; reason: string };

/** Validate `<dir>/recovery-report.json` (and that recovery-report.md exists). Only a well-formed report saying the
 *  ticket can proceed, with no blockers and no host update, lets the attempt continue to verification. */
export function checkReport(dir: string): ReportCheck {
  const no = (reason: string): ReportCheck => ({ ok: false, outcome: "unresolved", reason });
  let r: any;
  try {
    r = JSON.parse(readFileSync(join(dir, "recovery-report.json"), "utf8"));
  } catch {
    return no("the repair agent wrote no readable recovery-report.json");
  }
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
  const valid = r && typeof r === "object" && typeof r.cause === "string" && r.cause.trim() !== "" && strings(r.filesChanged)
    && Array.isArray(r.tests) && r.tests.every((t: any) => typeof t?.command === "string" && typeof t.result === "string")
    && typeof r.canProceed === "boolean" && Array.isArray(r.remainingBlockers) && typeof r.requiresHostUpdate === "boolean";
  if (!valid) return no("recovery-report.json is malformed (needs cause, filesChanged, tests[{command,result}], canProceed, remainingBlockers, requiresHostUpdate)");
  if (!existsSync(join(dir, "recovery-report.md"))) return no("the repair agent wrote no recovery-report.md");
  if (r.requiresHostUpdate) return { ok: false, outcome: "host-followup", reason: `the repair needs a host-side workflow update; nothing was applied: ${r.cause}` };
  if (!r.canProceed || r.remainingBlockers.length) {
    return no(`the repair agent reports the ticket cannot proceed${r.remainingBlockers.length ? ` (blockers: ${JSON.stringify(r.remainingBlockers)})` : ""}: ${r.cause}`);
  }
  return { ok: true, report: r };
}

// ---- the repair deadline ------------------------------------------------------------------------------------------

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };

export type Bounded<T> = { ok: true; value: T } | { ok: false; why: "timed-out" | "cancelled"; error: unknown };

/** Run `work` with a signal that aborts after `ms` (on `clock`) or when `cancel` aborts. The deadline starts when this is
 *  called and is cleared once `work` settles. A run that ends after either fired is `timed-out`/`cancelled`, even if it
 *  resolved; any other rejection is rethrown. `onStart` sees the deadline as it starts. */
export async function repairWithin<T>(ms: number, cancel: AbortSignal, work: (signal: AbortSignal) => Promise<T>,
  clock: Clock = realClock, onStart?: (startedAt: number) => void): Promise<Bounded<T>> {
  const deadline = new AbortController();
  onStart?.(clock.now());
  const timer = clock.setTimeout(() => deadline.abort(new Error(`repair agent exceeded ${Math.round(ms / 60_000)} minutes`)), ms);
  const stopped = (error: unknown): Bounded<T> | undefined =>
    cancel.aborted ? { ok: false, why: "cancelled", error } : deadline.signal.aborted ? { ok: false, why: "timed-out", error } : undefined;
  try {
    const value = await work(AbortSignal.any([deadline.signal, cancel]));
    return stopped(cancel.reason ?? deadline.signal.reason) ?? { ok: true, value };
  } catch (error) {
    const s = stopped(error);
    if (s) return s;
    throw error;
  } finally {
    clock.clearTimeout(timer);
  }
}

// ---- exact owned container cleanup -------------------------------------------------------------------------------

/** `docker` with an argument list: exit status (null when it could not run) and output. */
export type Docker = (args: string[]) => { status: number | null; stdout: string; stderr: string };
export const realDocker: Docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
};
export type Gone = { ok: true; removed: boolean } | { ok: false; reason: string };
const absent = (r: { status: number | null; stderr: string }) => r.status !== 0 && r.status !== null && /no such (container|object)/i.test(r.stderr);

/** Remove the container with exactly this name (`docker rm -f <name>`) and confirm `docker container inspect <name>`
 *  no longer finds it. No listing, filtering or other container is involved. Inspection that cannot answer, or a
 *  container still there, is not gone. */
export function ownedContainerGone(name: string, docker: Docker): Gone {
  if (!/^factory-recovery-[0-9a-f-]{36}$/.test(name)) return { ok: false, reason: `refusing to remove ${name}: not a recovery attempt's container name` };
  const before = docker(["container", "inspect", "--format", "{{.Name}}", name]);
  if (absent(before)) return { ok: true, removed: false };
  if (before.status !== 0) return { ok: false, reason: `docker could not inspect ${name} (exit ${before.status}${before.stderr.trim() ? `: ${before.stderr.trim().split("\n")[0]}` : ""})` };
  docker(["rm", "-f", name]);
  const after = docker(["container", "inspect", "--format", "{{.Name}}", name]);
  if (absent(after)) return { ok: true, removed: true };
  return { ok: false, reason: after.status === 0 ? `container ${name} is still present after docker rm -f`
    : `docker could not confirm ${name} is gone (exit ${after.status}${after.stderr.trim() ? `: ${after.stderr.trim().split("\n")[0]}` : ""})` };
}

// ---- the lifecycle ------------------------------------------------------------------------------------------------

/** A running owned sandbox: what the repair agent and the verifier need. */
export interface RecoverySandbox extends VerifierSandbox {
  readonly id: string;
  run(o: { agent: unknown; promptFile: string; promptArgs: Record<string, string>; maxIterations: number; completionSignal: string; name: string; signal?: AbortSignal }): Promise<{ commits: unknown[] }>;
}
export interface SandboxSpec {
  name: string;
  label: { key: string; value: string };
  worktree: string;
  gitDir: string;
  evidence: string;
  evidenceBox: string;
  readonly: string[];
  signal: AbortSignal;
}
export interface RecoveryDeps {
  clock: Clock;
  /** Create the owned container under spec.name, wait for readiness and the configured setup hooks, honour spec.signal. */
  createSandbox(spec: SandboxSpec): Promise<RecoverySandbox>;
  /** Remove the exact owned container and confirm it is gone. */
  containerGone(name: string): Gone;
  workspace: {
    /** HEAD, porcelain status (untracked included) and binary diffs of the worktree, read on the host. */
    snapshot(worktree: string): { head: string; status: string; staged: string; unstaged: string };
    /** Attempt-private Git metadata with only the branch, its history and the worktree's index. */
    prepareGit(o: { root: string; worktree: string; branch: string; gitDir: string }): void;
    /** Is `ancestor` an ancestor of (or equal to) `tip` in the private metadata? */
    descends(gitDir: string, ancestor: string, tip: string): boolean;
    /** Commits on `tip` beyond `base`: the recorded branch's (`start`, in the project) plus the repair's (private). */
    beyond(o: { root: string; gitDir: string; base: string; start: string; tip: string }): number;
    /** Import the branch's new tip into the project only if it still points at `from`; reason on refusal. */
    importRef(o: { root: string; worktree: string; gitDir: string; branch: string; from: string; to: string; attemptId: string }): string | undefined;
  };
  /** Why requirements, prerequisites or ownership no longer allow this attempt to continue, or undefined. */
  recheck(stage: "verify" | "deliver"): string | undefined;
  /** The board/tracker/git host for the shared hand-off (handoff.mts). */
  host: Host;
  setStage(patch: Record<string, unknown>): void;
  agent(model: string): unknown;
  log(line: string): void;
}
export interface RecoveryContext {
  root: string;
  record: string;
  model: string;
  title: string;
  baseSha: string;
  parentIid?: number;
  promptArgs: Record<string, string>;
  previousRun: unknown;
  diagnostics?: unknown;
  logs: string[];
  delivery: { ciWaitMinutes: number; noCiMinutes: number; autoMerge: boolean };
  cancel: AbortSignal;
  deadlineMs?: number;
}
export type AttemptResult = { outcome: RecoveryOutcome; reason: string; cleanupPending: boolean; record: AttemptRecord };

const VERIFY_PROMPT = "./.sandcastle/prompt.verify.md";
const READONLY = ["recovery-context.json", "previous-run.json", "previous-logs", "history", "input"];

/** Copy the ticket's earlier evidence (everything except other recovery attempts) into `to`. */
function copyHistory(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  if (!existsSync(from)) return;
  for (const name of readdirSync(from)) {
    if (name === "recovery") continue;
    cpSync(join(from, name), join(to, name), { recursive: true });
  }
}

/** Run one admitted recovery attempt to its outcome; see the file comment. Never throws for an attempt failure. */
export async function runRecoveryAttempt(ctx: RecoveryContext, deps: RecoveryDeps): Promise<AttemptResult> {
  const read = readAttemptRecord(ctx.record);
  if (!read.ok) throw new Error(`recovery attempt refused: ${read.reason}`);
  const rec = read.record;
  if (rec.outcome || rec.phase !== "claimed") throw new Error(`recovery attempt ${rec.id} was already started (phase ${rec.phase}); it is never run twice`);
  const iso = () => new Date(deps.clock.now()).toISOString();
  const save = (phase: Phase, patch: Partial<AttemptRecord> = {}, note?: string) => {
    Object.assign(rec, patch, { phase, updatedAt: iso() });
    rec.events.push({ at: rec.updatedAt, phase, ...(note ? { note } : {}) });
    writeAttemptRecord(ctx.record, rec);
  };
  const preserved = `work preserved on ${rec.branch} and in ${rec.worktree}; evidence in ${rec.evidence}`;
  let sandbox: RecoverySandbox | undefined;
  let created = false;

  const finish = (outcome: RecoveryOutcome, reason: string): AttemptResult => {
    let cleanupPending = false;
    if (created || rec.phase !== "claimed") {
      const gone = deps.containerGone(rec.container);
      if (!gone.ok) {
        cleanupPending = true;
        save("cleanup-pending", { intended: outcome, reason: `${reason}; container ${rec.container} not confirmed gone: ${gone.reason}` });
        deps.log(`recovery attempt ${rec.seq}: ${rec.reason}`);
        return { outcome, reason: rec.reason!, cleanupPending, record: rec };
      }
    }
    save("finished", { outcome, reason, finishedAt: iso() });
    deps.log(`recovery attempt ${rec.seq} ${outcome}: ${reason}`);
    return { outcome, reason, cleanupPending, record: rec };
  };

  // 1. ownership: the worktree still holds exactly the recorded tip.
  rec.owner = { pid: process.pid };
  let input: ReturnType<RecoveryDeps["workspace"]["snapshot"]>;
  try {
    input = deps.workspace.snapshot(rec.worktree);
  } catch (e) {
    return finish("ownership-refused", `could not read the recorded worktree ${rec.worktree}: ${(e as Error).message}`);
  }
  if (input.head !== rec.startSha) return finish("ownership-refused", `${rec.branch} moved from the recorded ${rec.startSha.slice(0, 8)} to ${input.head.slice(0, 8)}; not touching it`);

  // 2. this attempt's evidence, fresh; earlier evidence copied read-only.
  const dir = rec.evidence;
  if (existsSync(dir)) return finish("ownership-refused", `attempt evidence folder ${dir} already exists; an attempt never reuses one`);
  mkdirSync(join(dir, "input"), { recursive: true });
  writeFileSync(join(dir, "recovery-context.json"), JSON.stringify({ attempt: rec.seq, attemptId: rec.id, ticket: rec.iid, branch: rec.branch,
    base: rec.base, baseSha: ctx.baseSha, startSha: rec.startSha, diagnostics: ctx.diagnostics ?? null }, null, 2) + "\n");
  writeFileSync(join(dir, "previous-run.json"), JSON.stringify(ctx.previousRun ?? null, null, 2) + "\n");
  mkdirSync(join(dir, "previous-logs"), { recursive: true });
  for (const log of ctx.logs) if (existsSync(log) && statSync(log).isFile()) copyFileSync(log, join(dir, "previous-logs", basename(log)));
  copyHistory(resolve(dir, "../.."), join(dir, "history"));
  writeFileSync(join(dir, "input/head"), `${input.head}\n`);
  writeFileSync(join(dir, "input/status.txt"), input.status);
  writeFileSync(join(dir, "input/staged.diff"), input.staged);
  writeFileSync(join(dir, "input/unstaged.diff"), input.unstaged);
  const dirty = input.status.split("\n").filter(Boolean);

  // 3. container intent recorded before creation; private Git metadata.
  save("setup", { input: { head: input.head, dirty } }, `creating ${rec.container}`);
  deps.setStage({ stage: "setup", note: `recovery attempt ${rec.seq}: setting up` });
  try {
    deps.workspace.prepareGit({ root: ctx.root, worktree: rec.worktree, branch: rec.branch, gitDir: rec.gitDir });
  } catch (e) {
    return finish("failed", `could not prepare the attempt's Git metadata: ${(e as Error).message}; ${preserved}`);
  }
  if (ctx.cancel.aborted) return finish("interrupted", `cancelled before setup; ${preserved}`);
  try {
    created = true; // from here a container may exist under rec.container, even if create() never returns
    sandbox = await deps.createSandbox({ name: rec.container, label: { key: CONTAINER_LABEL, value: rec.id }, worktree: rec.worktree,
      gitDir: rec.gitDir, evidence: dir, evidenceBox: ctx.promptArgs.EVIDENCE_DIR, readonly: READONLY.map((f) => join(dir, f)), signal: ctx.cancel });
  } catch (e) {
    if (ctx.cancel.aborted) return finish("interrupted", `cancelled during setup; ${preserved}`);
    return finish("failed", `sandbox setup failed: ${(e as Error).message}; ${preserved}`);
  }
  save("setup", { sandboxId: sandbox.id }, "container ready and set up");
  if (ctx.cancel.aborted) return finish("interrupted", `cancelled during setup; ${preserved}`);

  // 4. the repair agent, bounded from here.
  const ms = ctx.deadlineMs ?? REPAIR_DEADLINE_MS;
  deps.setStage({ stage: "implementing", note: `recovery attempt ${rec.seq}: repairing (at most ${Math.round(ms / 60_000)} min)` });
  const sb = sandbox;
  let repair: Bounded<{ commits: unknown[] }>;
  try {
    repair = await repairWithin(ms, ctx.cancel, (signal) => sb.run({
      agent: deps.agent(ctx.model), promptFile: REPAIR_PROMPT, promptArgs: ctx.promptArgs, maxIterations: 1,
      completionSignal: "<promise>COMPLETE</promise>", name: "repair", signal,
    }), deps.clock, (t) => save("repairing", { deadline: { ms, startedAt: new Date(t).toISOString(), endsAt: new Date(t + ms).toISOString() } }));
  } catch (e) {
    rec.deadline!.clearedAt = iso();
    return finish("failed", `repair agent failed: ${(e as Error).message}; ${preserved}`);
  }
  rec.deadline!.clearedAt = iso();
  writeAttemptRecord(ctx.record, rec);
  if (!repair.ok) {
    if (repair.why === "cancelled") return finish("interrupted", `cancelled during repair; ${preserved}`);
    return finish("timed-out", `repair agent stopped after ${Math.round(ms / 60_000)} minutes; ${preserved}`);
  }

  // 5-6. report, clean tip descending from the recorded one.
  const report = checkReport(dir);
  if (!report.ok) return finish(report.outcome, `${report.reason}; ${preserved}`);
  try {
    const left = (await sb.exec("git status --porcelain --untracked-files=all")).stdout.trim();
    if (left) return finish("unresolved", `uncommitted changes are left in the worktree, so there is no reviewable tip (never committed by Factory); ${preserved}`);
    const tip = (await sb.exec("git rev-parse HEAD")).stdout.trim();
    rec.tip = tip;
    if (!/^[0-9a-f]{40,64}$/.test(tip)) return finish("failed", `could not read the repaired tip; ${preserved}`);
    if (!deps.workspace.descends(rec.gitDir, rec.startSha, tip)) return finish("failed", `the repaired tip ${tip.slice(0, 8)} does not descend from the recorded ${rec.startSha.slice(0, 8)}; ${preserved}`);
    if (!deps.workspace.beyond({ root: ctx.root, gitDir: rec.gitDir, base: ctx.baseSha, start: rec.startSha, tip })) return finish("unresolved", `${rec.branch} has no commits beyond ${rec.base}; nothing to verify; ${preserved}`);

    // 7. recheck, then the shared independent verifier on the exact tip.
    const stale = deps.recheck("verify");
    if (stale) return finish("unresolved", `not verifying: ${stale}; ${preserved}`);
    if (ctx.cancel.aborted) return finish("interrupted", `cancelled before verification; ${preserved}`);
    save("verifying", { tip });
    const refused = await runVerifier(sb, { setStage: (_iid, patch) => deps.setStage(patch) },
      { iid: rec.iid, evidenceHost: dir, agent: deps.agent(ctx.model), promptArgs: { ...ctx.promptArgs, TIP_SHA: tip }, tip, promptFile: VERIFY_PROMPT });
    rec.verifier = { tip, ...(refused ? { refused } : {}) };
    if (ctx.cancel.aborted) return finish("interrupted", `cancelled during verification; ${preserved}`);
    if (refused) return finish("failed", `${refused}; ${preserved}`);
  } catch (e) {
    if (ctx.cancel.aborted) return finish("interrupted", `cancelled: ${(e as Error).message}; ${preserved}`);
    return finish("failed", `${(e as Error).message}; ${preserved}`);
  }
  const tip = rec.tip!;

  // 8. the container must be gone before anything leaves the attempt.
  const gone = deps.containerGone(rec.container);
  if (!gone.ok) {
    save("cleanup-pending", { intended: "failed", reason: `container ${rec.container} not confirmed gone: ${gone.reason}; not delivering; ${preserved}` });
    return { outcome: "failed", reason: rec.reason!, cleanupPending: true, record: rec };
  }
  created = false;

  // 9. import by compare-and-swap, recheck, deliver the exact tip.
  if (tip !== rec.startSha) {
    const refusedImport = deps.workspace.importRef({ root: ctx.root, worktree: rec.worktree, gitDir: rec.gitDir, branch: rec.branch, from: rec.startSha, to: tip, attemptId: rec.id });
    if (refusedImport) return finish("failed", `${refusedImport}; the repair's commits stay in ${rec.gitDir}; ${preserved}`);
  }
  const stale = deps.recheck("deliver");
  if (stale) return finish("unresolved", `not delivering: ${stale}; ${preserved}`);
  if (ctx.cancel.aborted) return finish("interrupted", `cancelled before delivery; ${preserved}`);
  save("delivering");
  let out: Outcome;
  try {
    out = await postAndDeliver({
      iid: rec.iid, project: rec.project, branch: rec.branch, base: rec.base, baseSha: ctx.baseSha, tip, title: ctx.title, evidenceHost: dir,
      parentIid: ctx.parentIid, origin: { kind: "repaired", attempt: rec.seq }, staleNote: "",
      ciWaitMinutes: ctx.delivery.ciWaitMinutes, noCiMinutes: ctx.delivery.noCiMinutes, autoMerge: ctx.delivery.autoMerge,
    }, deps.host);
  } catch (e) {
    out = { ok: false, reason: `delivery outcome unknown: ${(e as Error).message}` };
  }
  rec.delivery = out.ok && out.pushed ? { tip, ok: true, url: out.url } : { tip, ok: false, reason: out.ok ? "not pushed" : out.reason };
  if (!out.ok || !out.pushed) return finish("failed", `${out.ok ? "not pushed" : out.reason}; ${preserved}`);
  return finish("delivered", `verified and delivered ${tip.slice(0, 8)}: ${out.url}`);
}
