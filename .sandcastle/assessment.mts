// Current tracker assessments (#78), separate from execution manifests and run records. Store failures are best-effort
// and never gate admission or board rendering. Analysis has its own freshness key and budget. Unknown dependencies
// fail closed here, independently of dispatch admission. Request generations preserve newer clicks; assessment
// attempts fence pending, success and failure publication across processes. A short per-card lock covers only
// generation allocation and compare/write, never tracker/analysis work. Dead owners are reclaimed under a separate
// guard; an abandoned/unreadable guard fails closed. Only process-identity helpers come from admission, not its locks.
// No orchestrator imports: this also runs beside copied files in .sandcastle/ and in the installed board.
import { mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ownerOf, ownerState } from "./admission.mts";

export const REFRESH_PER_PASS = 25;
export type DependencyState = "satisfied" | "unsatisfied" | "unknown";
export interface Dependencies {
  requires?: { providedBy: number | null; what?: string }[];
  implementerBlockers?: { iid: number | null; what?: string }[];
}
export interface Analysis extends Dependencies { input: string; analyzedAt: string }
export interface Facts {
  title: string;
  state: string;
  labels: string[];
  selected?: boolean;
  selectionReason?: string;
  model?: string;
  modelError?: string;
  hash: string;
  checkedAt: string;
}
export interface Assessment {
  iid: string;
  project?: string;
  projectRoot?: string;
  facts?: Facts;
  attemptedAt?: string;
  error?: string;
  pending?: boolean; // derived from outstanding generation files when reading
  changed?: boolean;
  analysis?: Analysis; // last good dependency analysis, never an execution manifest
  analysisState?: "pending" | "current" | "error";
  analysisError?: string;
  dependencies?: { iid: number | null; what?: string; state: DependencyState }[];
  retryRequired?: string;
}
const folder = (dir: string) => resolve(dir, "assessment");
const file = (dir: string, key: string) => resolve(folder(dir), `${key}.json`);
const requests = (dir: string) => resolve(dir, "refresh");
const message = (e: unknown) => String((e as Error).message ?? e).slice(0, 300);
const report = (e: unknown) => console.error(`assessment store: ${message(e)}`);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
function atomic(path: string, value: unknown) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}
function raw(dir: string, key: string): Assessment | undefined {
  try { return JSON.parse(readFileSync(file(dir, key), "utf8")); }
  catch (e) { if (!missing(e)) report(e); return undefined; }
}
export function readAssessment(dir: string, key: string): Assessment | undefined {
  const a = raw(dir, key);
  const pending = pendingRequests(dir).has(key);
  return a ? { ...a, pending } : undefined;
}
export function readAssessments(dir: string): Map<string, Assessment> {
  const out = new Map<string, Assessment>();
  try {
    const asked = pendingRequests(dir);
    for (const f of readdirSync(folder(dir)).filter((n) => n.endsWith(".json"))) {
      const key = f.replace(/\.json$/, ""), a = raw(dir, key);
      if (a) out.set(key, { ...a, pending: asked.has(key) });
    }
  } catch (e) { if (!missing(e)) report(e); }
  return out;
}
export function writeAssessment(dir: string, key: string, a: Assessment): void { atomic(file(dir, key), a); }
const generation = (dir: string, key: string) => resolve(folder(dir), `${key}.generation`);
/** Independent of run admission. The guard serializes stale-owner checks with removal, so two reclaimers cannot
 * unlink a replacement lock. A crash while reclaiming fails closed rather than guessing based on lock age. */
function withAssessmentLock<T>(dir: string, key: string, fn: () => T): T {
  const lock = resolve(folder(dir), `${key}.lock`), guard = `${lock}.reap`;
  mkdirSync(folder(dir), { recursive: true });
  const owner = JSON.stringify(ownerOf(process.pid)), deadline = Date.now() + 2000;
  for (;;) {
    try { symlinkSync(owner, lock); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    let guarded = false;
    try {
      symlinkSync(owner, guard);
      guarded = true;
      const holder = JSON.parse(readlinkSync(lock));
      if (Number.isInteger(holder.pid) && holder.pid > 0 && ownerState(holder) === "dead") rmSync(lock);
    } catch (e) {
      if (!missing(e) && (e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally { if (guarded) rmSync(guard); }
    if (Date.now() >= deadline) throw new Error(`Assessment lock busy or unreadable: ${lock}; inspect its owner and ${guard}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  try { return fn(); }
  finally { rmSync(lock); }
}
/** Allocate before reading tracker facts. The worker's child inherits its attempt instead of superseding it. */
export function beginAssessment(dir: string, key: string, inherited?: string): string {
  if (inherited) return inherited;
  return withAssessmentLock(dir, key, () => {
    const token = randomUUID();
    atomic(generation(dir, key), token);
    return token;
  });
}
/** All production pending/result/error writes and request consumption pass this cross-process CAS. */
export function publishAssessment(dir: string, key: string, token: string, publish: () => void): boolean {
  return withAssessmentLock(dir, key, () => {
    if (JSON.parse(readFileSync(generation(dir, key), "utf8")) !== token) return false;
    publish();
    return true;
  });
}
export function assessed(prev: Assessment | undefined,
  o: { iid: string; project?: string; at: string; runHash?: string; ticket?: Omit<Facts, "checkedAt">; error?: string; retryRequired?: string },
): Assessment {
  const base = { iid: o.iid, project: o.project, attemptedAt: o.at, pending: false };
  if (o.error || !o.ticket) return { ...prev, ...base, error: o.error ?? "ticket could not be read", retryRequired: undefined };
  const { error: _e, ...kept } = prev ?? { iid: o.iid };
  return { ...kept, ...base, facts: { ...o.ticket, checkedAt: o.at },
    changed: o.runHash !== undefined && o.runHash !== o.ticket.hash, retryRequired: o.retryRequired };
}
/** A request has its own immutable filename. Only the captured generations are consumed by a refresh. */
export function requestRefresh(dir: string, key: string, iid: string, project?: string): void {
  atomic(resolve(requests(dir), `${key}.${randomUUID()}.json`), { key, at: new Date().toISOString() });
  withAssessmentLock(dir, key, () => {
    if (!raw(dir, key)) writeAssessment(dir, key, { iid, project });
  });
}
export function pendingRequests(dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  try {
    for (const f of readdirSync(requests(dir)).filter((n) => n.endsWith(".json"))) {
      const key = f.replace(/\.[0-9a-f-]{36}\.json$|\.json$/g, "");
      out.set(key, [...(out.get(key) ?? []), f]);
    }
  } catch (e) { if (!missing(e)) report(e); }
  return out;
}
export function clearRequest(dir: string, key: string, generations: string[] = []): void {
  for (const f of generations) {
    if (f === `${key}.json` || f.startsWith(`${key}.`)) rmSync(resolve(requests(dir), f), { force: true });
  }
}
export function pickRefreshes(keys: string[], asked: Map<string, unknown>, known: Map<string, Assessment>, limit = REFRESH_PER_PASS): string[] {
  const age = (k: string) => known.get(k)?.attemptedAt ?? "";
  return [...keys].sort((a, b) => Number(asked.has(b)) - Number(asked.has(a)) || age(a).localeCompare(age(b))).slice(0, limit);
}
export interface RefreshTicket {
  iid: number; title: string; description: string; state?: string; labels?: string[];
  parent?: { iid: number; title: string; description: string };
}
export interface RefreshNote { body: string; system?: boolean }
export interface RefreshRun { key: string; iid: string; project?: string; stage: string; ticketHash?: string }
export interface RefreshDeps {
  dir: string;
  project: string;
  root?: string;
  now: () => string;
  read: (iid: number) => RefreshTicket;
  notes: (iid: number) => RefreshNote[];
  hash: (t: RefreshTicket, notes: RefreshNote[]) => string;
  model: (labels: string[]) => { model: string } | { error: string };
  selection: (t: RefreshTicket) => { selected: boolean; selectionReason?: string };
  analysisInput: (t: RefreshTicket, notes: RefreshNote[]) => string;
  analyse: (t: RefreshTicket, notes: RefreshNote[]) => Dependencies;
  analysisBudget: number;
  dependency: (iid: number) => DependencyState;
  historicalBlockers?: (iid: number) => Dependencies | undefined;
  log: (m: string) => void;
  attempts?: Map<string, string>; // adapter allocates before catalogue/selection reads
  // Injectable filesystem boundary for failure tests; production uses the functions above.
  store?: Partial<{ read: typeof readAssessments; requests: typeof pendingRequests; write: typeof writeAssessment; clear: typeof clearRequest }>;
}
/** Bounded read-only assessment. Fence publication, including the pending state before invoking the analyst. */
export function refreshCards(runs: RefreshRun[], d: RefreshDeps): string[] {
  const store = { read: readAssessments, requests: pendingRequests, write: writeAssessment, clear: clearRequest, ...d.store };
  const done: string[] = [];
  try {
    const mine = runs.filter((r) => r.project === d.project);
    const known = store.read(d.dir), asked = store.requests(d.dir);
    const keys = pickRefreshes(mine.map((r) => r.key), asked, known);
    let budget = d.analysisBudget;
    for (const key of keys) {
      const run = mine.find((r) => r.key === key)!, at = d.now();
      try {
        const token = d.attempts?.get(key) ?? beginAssessment(d.dir, key);
        // The pass-wide map orders cards only. Re-read after beginning this attempt to preserve the last good result.
        const prev = store.read(d.dir).get(key);
        let next: Assessment;
        try {
          const t = d.read(Number(run.iid)), notes = d.notes(Number(run.iid));
          const hash = d.hash(t, notes), m = d.model(t.labels ?? []);
          next = assessed(prev, { iid: run.iid, project: run.project, at, runHash: run.ticketHash,
            ticket: { title: t.title, state: t.state ?? "open", labels: t.labels ?? [], hash, ...d.selection(t),
              ...("error" in m ? { modelError: m.error } : { model: m.model }) } });
          next.projectRoot = d.root;
          const input = d.analysisInput(t, notes);
          if (next.analysis?.input !== input) {
            next.analysisState = "pending";
            next.dependencies = undefined;
            next.analysisError = undefined;
            if (!publishAssessment(d.dir, key, token, () => store.write(d.dir, key, next))) continue;
            if (budget > 0) {
              budget--;
              try {
                const result = d.analyse(t, notes);
                next.analysis = { ...result, input, analyzedAt: d.now() };
              } catch (e) {
                next.analysisState = "error";
                next.analysisError = message(e);
                d.log(`  assessment analysis of #${run.iid} failed: ${message(e)}`);
              }
            }
          }
          if (next.analysis?.input === input) {
            next.analysisState = "current";
            next.analysisError = undefined;
            const blockers = [...(next.analysis.requires ?? []).map((r) => ({ iid: r.providedBy, what: r.what })),
              ...(next.analysis.implementerBlockers ?? []).map((b) => ({ iid: b.iid, what: b.what }))];
            next.dependencies = blockers.map((b) => {
              let state: DependencyState = "unknown";
              if (b.iid != null) { try { state = d.dependency(b.iid); } catch { /* unknown fails closed */ } }
              return { ...b, state };
            });
            // Fresh analysis can find no remaining requirement because it now exists in the code. Still check
            // every historical blocker: absence from the new analysis is not proof that a human blocker cleared.
            const historical = d.historicalBlockers?.(Number(run.iid)) ?? prev?.analysis;
            const oldIds = [...(historical?.requires ?? []).map((r) => r.providedBy), ...(historical?.implementerBlockers ?? []).map((b) => b.iid)];
            const checks = [...next.dependencies.map((b) => b.state), ...oldIds.map((iid): DependencyState => {
              if (iid == null) return "unknown";
              try { return d.dependency(iid); } catch { return "unknown"; }
            })];
            if (run.stage === "stopped" && checks.length > 0 && checks.every((s) => s === "satisfied") && next.facts?.state !== "closed") {
              next.retryRequired = "The blocker has cleared. Nothing restarts on its own: run an explicit retry (factory retry).";
            }
          }
        } catch (e) {
          next = assessed(prev, { iid: run.iid, project: run.project, at, error: message(e) });
          d.log(`  refresh of #${run.iid} failed: ${message(e)}`);
        }
        if (publishAssessment(d.dir, key, token, () => {
          store.write(d.dir, key, next);
          store.clear(d.dir, key, asked.get(key));
        })) done.push(key);
      } catch (e) { d.log(`  assessment store for #${run.iid}: ${message(e)}`); }
    }
  } catch (e) { d.log(`  assessment store: ${message(e)}`); }
  return done;
}
