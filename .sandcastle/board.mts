import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimLive, keyFor, newToken, ownerOf, releaseClaim, transferClaim, withAdmission } from "./admission.mts";
import type { AdmissionClaim, AdmissionTx, ClaimKind } from "./admission.mts";
export { keyFor } from "./admission.mts";

// Run-state store + the Factory tracker board/evidence page (light/dark/system appearance).
// Stage visits persist for real timing, blockers and bounce stats; legacy history stays explicitly incomplete.
// Completed tickets appear in the template's latest-ten Shipped section; stopped runs remain unfinished.
// Writers (main.mts) call setStage(); each call writes <stateDir>/<key>.json and regenerates
// .sandcastle/board.html, a self-contained snapshot that opens from disk and does not poll. The always-on
// service (board-server.mts) serves the same page over HTTP, plus buildBoardData() as JSON at /api/runs,
// which the page polls to animate live changes.
// The dispatcher calls reserveRun() as it spawns each run, so the run counts against the shared cap (in this and
// every other project's pass) before main.mts writes its own record; a launch whose process dies before that is
// forgotten rather than stopped, so the next pass retries it.
// claimRun() makes that reservation atomic through the admission record (admission.mts, #75): under its one lock it
// counts live claims and in-flight run records across every project, refuses when the cap is reached or the ticket already
// has a claim or a run in flight, then commits a claim (a token, kind `normal`, the owning pid and its start identity,
// and one more for the project's activity generation) and only then writes the record, carrying the token as `claim`.
// The dispatcher claims each ticket before spawning it and hands the claim to the child (reserveRun); main.mts adopts it
// (adoptClaim). From then on that process's board writes, its heartbeat and exit handler included, are token-fenced: a
// record that now carries another claim's token is left alone, so a stale run cannot overwrite a newer claim. A normal
// claim ends when its run reaches a terminal or parked stage, or when its owner process is gone.
// Recovery (cli/src/recovery-claim.mts) admits through admitRun in the same lock, with kind `recovery`: such a claim holds
// its ticket, a capacity slot and its whole project (no other run of the project is admitted, and it is refused while
// another run of the project is in flight) whatever its record's stage or process, until the recovery launcher's settle
// step releases it after the attempt's exact container is confirmed gone.
// stateDir: $SANDCASTLE_STATE_DIR, else .sandcastle/state in the current repo. Set the variable to
// one shared folder (the service's) so a single board shows runs from every project and worktree.

export type Stage = "queued" | "waiting" | "setup" | "implementing" | "verifying" | "posting" | "pushing" | "ci" | "done" | "stopped";
export const TERMINAL: Stage[] = ["done", "stopped"];
// Not running and not finished: the dispatcher re-evaluates these every pass. "queued" = not started
// (the note says why), "waiting" = the implementer reported a blocker. Neither counts against capacity.
export const PARKED: Stage[] = ["queued", "waiting"];

export interface QueueReason { code: string; text: string }
export interface StageVisit { stage: Stage; at: string; note?: string; reasons?: QueueReason[] }

export interface RunState {
  iid: string;
  project?: string;
  title?: string;
  ticketUrl?: string;
  branch?: string;
  base?: string;
  stage: Stage;
  stageSince: string;
  startedAt: string;
  updatedAt: string;
  pid: number;
  verdict?: string;
  mr?: string;
  note?: string;
  queueReasons?: QueueReason[]; // optional structured blockers; older writers supply note instead
  stageHistory?: StageVisit[]; // each visit ends at the next visit's timestamp
  historyComplete?: boolean; // false for pre-upgrade records or truncated history
  evidenceDir?: string;
  ticketHash?: string; // content hash of the ticket the run was built from
  parentIid?: string; // set when the ticket is a GitLab Task; the Task is closed once its branch merges
  mergedAt?: string; // when the dispatcher saw the MR merged and closed the Task or moved the ticket on
  starting?: boolean; // reserved by the dispatcher at launch; main.mts clears it with its first write
  // Set while a recovery attempt owns the ticket: its attempt number, its UUID (#74) and the record's stage/note before the claim.
  recovery?: { attempt: number; id?: string; from?: { stage: Stage; note?: string; stageSince?: string } };
  // The admission claim token this record was written under (#75); writes from a process holding another token are dropped.
  claim?: string;
}

export interface BoardRun extends RunState {
  key: string;
  evidenceUrl?: string;
  activity?: string; // newest line of the agent's log, for a run that is in progress
  activityAt?: string; // when that log was last written
}

const expand = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));
export const stateDir = () => expand(process.env.SANDCASTLE_STATE_DIR || ".sandcastle/state");
const boardFile = () => resolve(".sandcastle/board.html");
const templateFile = resolve(dirname(fileURLToPath(import.meta.url)), "board.template.html");
const now = () => new Date().toISOString();

let project: string | undefined;
/** Name this process's runs by project so one shared board can tell repos apart. */
export function setProject(name: string): void {
  project = name;
}

// The claim token this process holds (adoptClaim/holdClaim). Set: setStage writes only a record carrying that token.
let held: string | undefined;
/** Fence this process's board writes with `token`. */
export function holdClaim(token: string | undefined): void {
  held = token;
}

/** Take over the claim the record of `iid` carries (the dispatcher's reservation) for this process and fence later
 *  writes with it. Returns the token, undefined when the record carries none (a manual start), or throws when the claim
 *  is no longer that record's (superseded or released). */
export function adoptClaim(iid: string, dir = stateDir()): string | undefined {
  const key = keyFor(iid, project);
  let token: string | undefined;
  try {
    token = (JSON.parse(readFileSync(resolve(dir, `${key}.json`), "utf8")) as RunState).claim;
  } catch {
    return undefined;
  }
  if (!token) return undefined;
  if (!transferClaim(dir, key, token, process.pid)) throw new Error(`#${iid}'s launch claim is no longer held; another run owns the ticket now`);
  held = token;
  return token;
}

function write(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Record stage changes, not heartbeats. Parked reason changes start a new blocker episode.
 *  A reopened completed ticket starts a new lifecycle; retries from stopped retain their visits. */
export function trackStage(previous: Partial<RunState>, next: RunState, at: string): RunState {
  const reopened = previous.stage === "done" && next.stage !== "done";
  const stored = Array.isArray(previous.stageHistory) ? previous.stageHistory : [];
  const visits = reopened ? [] : stored.filter(v => v && typeof v.stage === "string" && Number.isFinite(Date.parse(v.at)));
  let complete = reopened || (!previous.stage ? true : previous.historyComplete === true && visits.length === stored.length);
  if (!visits.length && previous.stage && !reopened) {
    visits.push({ stage: previous.stage, at: previous.stageSince || at, note: previous.note, reasons: previous.queueReasons });
    complete = false;
  }
  // An older project writer can update stage without adding visits. Never call that history complete.
  if (previous.stage && visits.length && visits.at(-1)!.stage !== previous.stage) {
    visits.push({ stage: previous.stage, at: previous.stageSince || at, note: previous.note, reasons: previous.queueReasons });
    complete = false;
  }
  const last = visits.at(-1);
  if (last && previous.stage && !PARKED.includes(previous.stage) && previous.stageSince && last.at !== previous.stageSince) complete = false;
  const reasons = PARKED.includes(next.stage) ? next.queueReasons : undefined;
  const note = PARKED.includes(next.stage) || next.stage === "stopped" ? next.note : undefined;
  if (!last || last.stage !== next.stage || (PARKED.includes(next.stage) &&
      (last.note !== note || JSON.stringify(last.reasons) !== JSON.stringify(reasons)))) {
    visits.push({ stage: next.stage, at, note, reasons });
  }
  // Bound a pathological retry loop without claiming its retained totals are complete.
  if (visits.length > 1000) { visits.splice(0, visits.length - 1000); complete = false; }
  return { ...next, stageHistory: visits, historyComplete: complete };
}

export function setStage(iid: string, patch: Partial<RunState>): void {
  mkdirSync(stateDir(), { recursive: true });
  const file = resolve(stateDir(), `${keyFor(iid, project)}.json`);
  let cur: Partial<RunState> = {};
  if (existsSync(file)) {
    try {
      cur = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* corrupt or mid-write: start fresh */
    }
  }
  if (held && cur.claim !== held) return; // fenced: the record belongs to a newer claim
  const stageChanged = patch.stage && patch.stage !== cur.stage;
  const at = now();
  const next = trackStage(cur, {
    startedAt: at,
    ...cur,
    ...patch,
    iid,
    project,
    pid: patch.pid ?? process.pid,
    updatedAt: at,
    stageSince: stageChanged || !cur.stageSince ? at : cur.stageSince,
    queueReasons: patch.queueReasons ?? (stageChanged || Object.prototype.hasOwnProperty.call(patch, "note") ? undefined : cur.queueReasons),
  } as RunState, at);
  write(file, JSON.stringify(next, null, 2));
  // A normal run that finished or parked lets go of its claim (a recovery claim is released only by settling).
  if (held && patch.stage && (TERMINAL.includes(patch.stage) || PARKED.includes(patch.stage))) {
    try {
      releaseClaim(stateDir(), keyFor(iid, project), held, "normal");
    } catch {
      /* its owner exiting releases it too */
    }
  }
  renderBoard();
}

/** Record a run the dispatcher has just spawned (process `pid`), before the run writes for itself. It counts as
 *  in flight while `pid` lives; if `pid` exits before main.mts clears `starting`, readRuns() drops the record. With
 *  `patch.claim`, the claim this process took is handed to `pid` (unless the run already adopted it). */
export function reserveRun(iid: string, pid: number, patch: Partial<RunState> = {}): void {
  if (patch.claim) transferClaim(stateDir(), keyFor(iid, project), patch.claim, pid, process.pid);
  setStage(iid, { ...patch, stage: "setup", note: "starting", starting: true, pid });
}

export type Claim = { ok: true; run: RunState } | { ok: false; reason: string };
const inFlight = (r: RunState) => !TERMINAL.includes(r.stage) && !PARKED.includes(r.stage);

export interface AdmitOptions {
  iid: string;
  pid: number;
  cap: number;
  project?: string;
  patch?: Partial<RunState>;
  /** `recovery`: holds the project and is refused while any other run of the project is in flight. Default `normal`. */
  kind?: ClaimKind;
  /** Recovery: the attempt's UUID, recorded on the claim. */
  attempt?: string;
  /** Runs under the lock after the shared checks, with the ticket's current record; may throw to refuse (its message is
   *  the reason, nothing is written) or return more fields for the record. */
  also?: (current: RunState | undefined) => Partial<RunState> | void;
}
export type Admitted = { ok: true; key: string; token: string; claim: AdmissionClaim; current?: RunState; run: RunState } | { ok: false; reason: string };

/** The admission check, inside withAdmission (claimRun, and recovery's claim): adds the claim to `tx.state` and returns
 *  the record to write, or the reason. Commits and writes nothing itself. */
export function admitRun(tx: AdmissionTx, dir: string, o: AdmitOptions): Admitted {
  const proj = o.project ?? project;
  const key = keyFor(o.iid, proj);
  const kind = o.kind ?? "normal";
  const runs = readRuns(dir);
  const claims = Object.entries(tx.state.claims).filter(([, c]) => claimLive(c));
  const current = runs.find((r) => r.key === key);
  const own = tx.state.claims[key];
  if (own && claimLive(own)) return { ok: false, reason: `#${o.iid} already has a run in flight (${own.kind} claim, process ${own.owner.pid})` };
  if (current && inFlight(current)) return { ok: false, reason: `#${o.iid} already has a run in flight (${current.stage}, process ${current.pid})` };
  // Recovery holds its project: while an attempt (running, or with its container's removal unconfirmed) owns a ticket, no other run of that project starts.
  const holder = claims.find(([k, c]) => k !== key && c.project === proj && c.kind === "recovery");
  if (holder) return { ok: false, reason: `project ${proj ?? "(unnamed)"} is held by recovery on #${holder[1].iid}` };
  if (kind === "recovery") {
    const other = claims.find(([k, c]) => k !== key && c.project === proj)?.[1].iid ?? runs.find((r) => r.key !== key && r.project === proj && inFlight(r))?.iid;
    if (other) return { ok: false, reason: `project ${proj ?? "(unnamed)"} has #${other} in flight; recovery needs the project to itself` };
  }
  const busy = new Set([...claims.map(([k]) => k), ...runs.filter(inFlight).map((r) => r.key)]);
  if (busy.size >= o.cap) return { ok: false, reason: `no capacity: ${busy.size} run(s) in flight, cap ${o.cap}` };
  let extra: Partial<RunState> | void;
  try {
    extra = o.also?.(current);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const at = now();
  const token = newToken();
  const claim: AdmissionClaim = { token, project: proj ?? "", iid: o.iid, kind, owner: ownerOf(o.pid), at, ...(o.attempt ? { attempt: o.attempt } : {}) };
  tx.state.claims[key] = claim;
  if (kind === "normal") tx.state.generations[claim.project] = (tx.state.generations[claim.project] ?? 0) + 1;
  const { key: _key, evidenceUrl: _url, activity: _a, activityAt: _at, ...cur } = (current ?? {}) as Partial<BoardRun>;
  const run = trackStage(cur, { startedAt: at, ...cur, stage: "setup", note: "starting", starting: true, ...o.patch, ...extra,
    queueReasons: undefined, iid: o.iid, project: proj, pid: o.pid, claim: token, updatedAt: at, stageSince: at } as RunState, at);
  return { ok: true, key, token, claim, current, run };
}

/** Write a claimed run's record (temp file + rename). */
export function writeRecord(dir: string, key: string, run: RunState): void {
  mkdirSync(dir, { recursive: true });
  write(resolve(dir, `${key}.json`), JSON.stringify(run, null, 2));
}

/** Atomically claim a slot under the shared cap and ownership of ticket `iid` for process `pid` (see admitRun). Refused,
 *  writing nothing, when `cap` runs are already in flight across every project in the state folder, when the ticket has
 *  a claim or a run in flight, or when recovery holds the project. The record is written as a reservation (stage
 *  `setup`, note `starting`, `starting: true`, the claim token) over the ticket's existing record, keeping its other
 *  fields (branch, evidence). It does not render the board; reserveRun() or the run's own writes do. */
export function claimRun(o: AdmitOptions & { dir?: string }): Claim {
  const dir = o.dir ?? stateDir();
  return withAdmission(dir, (tx) => {
    const a = admitRun(tx, dir, o);
    if (!a.ok) return a;
    tx.commit();
    writeRecord(dir, a.key, a.run);
    return { ok: true, run: a.run };
  });
}

/** Delete a run record (the dispatcher clears parked records for tickets that left the queue, and a launch it claimed
 *  but could not spawn). With `claim`, that normal claim is released too. */
export function removeRun(iid: string, claim?: string): void {
  if (claim) releaseClaim(stateDir(), keyFor(iid, project), claim, "normal");
  rmSync(resolve(stateDir(), `${keyFor(iid, project)}.json`), { force: true });
  renderBoard();
}

/** Read every run. A run whose process is gone without a terminal stage crashed: mark it washed away. A reserved
 *  launch whose process died before the run started is removed instead, as if never launched. */
export function readRuns(dir = stateDir()): BoardRun[] {
  if (!existsSync(dir)) return [];
  const runs: BoardRun[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      const file = resolve(dir, f);
      let s: RunState = JSON.parse(readFileSync(file, "utf8"));
      if (!TERMINAL.includes(s.stage) && !PARKED.includes(s.stage) && s.pid !== process.pid && !alive(s.pid)) {
        if (s.starting) {
          rmSync(file, { force: true });
          continue;
        }
        const at = now();
        s = trackStage(s, { ...s, note: `process ${s.pid} exited without finishing (last stage: ${s.stage})`,
          stage: "stopped", stageSince: at }, at);
        write(file, JSON.stringify(s, null, 2));
      }
      runs.push({ ...s, key: f.replace(/\.json$/, "") });
    } catch {
      /* skip unreadable file */
    }
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** What an in-progress run is doing now: the last line of its newest agent log (`<branch>-*.log` in the project's
 *  `.sandcastle/logs`, found next to the evidence folder). Read-only, and only for runs that are neither parked nor finished. */
export function latestActivity(run: RunState): { activity: string; activityAt: string } | undefined {
  if (TERMINAL.includes(run.stage) || PARKED.includes(run.stage) || !run.branch || !run.evidenceDir) return undefined;
  const dir = resolve(run.evidenceDir, "..", "..", "logs");
  try {
    const newest = readdirSync(dir)
      .filter((n) => n.startsWith(`${run.branch}-`) && n.endsWith(".log"))
      .map((n) => ({ file: resolve(dir, n), at: statSync(resolve(dir, n)) }))
      .sort((a, b) => b.at.mtimeMs - a.at.mtimeMs)[0];
    if (!newest) return undefined;
    const size = Math.min(newest.at.size, 8192);
    const fd = openSync(newest.file, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, newest.at.size - size);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const last = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    return last ? { activity: last.length > 200 ? last.slice(0, 199) + "…" : last, activityAt: newest.at.mtime.toISOString() } : undefined;
  } catch {
    return undefined; // no log yet, or an unreadable one
  }
}

/** Board snapshot shared by the embedded page data and GET /api/runs. mode "http" links evidence through the
 *  service's /evidence route; "file" links the folder directly. */
export function buildBoardData(mode: "file" | "http"): { runs: BoardRun[]; generatedAt: string } {
  const runs = readRuns().map((r) => ({
    ...r,
    evidenceUrl: !r.evidenceDir ? undefined : mode === "http" ? `/evidence/${encodeURIComponent(r.key)}/` : `file://${r.evidenceDir}/`,
    ...latestActivity(r),
  }));
  return { runs, generatedAt: now() };
}

const embed = (data: unknown) =>
  readFileSync(templateFile, "utf8").replace("/*__DATA__*/null", () => JSON.stringify(data).replace(/</g, "\\u003c"));

export function buildPage(mode: "file" | "http"): string {
  return embed(buildBoardData(mode));
}

/** Render evidence using the board's shell. Evidence pages never poll, so media keeps playing. */
export function buildEvidencePage(run: BoardRun, files: { name: string; kind: string; url: string; text?: string; truncated?: boolean }[]): string {
  return embed({ evidence: { run, files, url: `/evidence/${encodeURIComponent(run.key)}/` } });
}

export function renderBoard(): void {
  mkdirSync(dirname(boardFile()), { recursive: true });
  write(boardFile(), buildPage("file"));
}
