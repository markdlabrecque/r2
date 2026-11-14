import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyse, analysisWorktree } from "./analyze.mts";
import { claimRun, PARKED, readRuns, removeRun, reserveRun, setProject, setStage, TERMINAL } from "./board.mts";
import type { BoardRun } from "./board.mts";
import { AGENT, allLabels, GRAPH, LABELS, SUBTASKS, TRACKER } from "./config.mts";
import { disallowedModels, ticketModel } from "./models.mts";
import { contentHash, decide, edgesOf, expandUnits, findJam, staleReason, unitHash } from "./graph.mts";
import type { Note } from "./graph.mts";
import { readManifests, removeManifest, writeManifest } from "./manifests.mts";
import { refreshProject } from "./refresh.mts";
import * as tracker from "./tracker.mts";
import type { Ticket } from "./tracker.mts";

// Dispatcher: list the tickets that qualify, update the ticket graph, then start one detached
// main.mts run per ticket that is free to go (up to a cap on concurrent runs). Usually started through
// dispatch.sh (by hand, or by a sandcastle-dispatch@<project>.timer), which checks the tools and image first.
//   node .sandcastle/dispatch.mts --base sal-develop [--max 3] [--dry-run] [--whole-issues]
// A ticket is free to go when its manifest is current, every ticket it depends on is merged into the
// base or closed, and its files don't overlap a live run (in flight, or MR still open).
// Tickets that aren't free get a "queued" card on the board saying why. A ticket whose run failed
// is not retried every pass: delete its file in the state dir to retry it.
// Each launch is recorded on the board (stage "setup", note "starting", the child's pid) the moment it is spawned,
// so the cap counts it in every later pass, this project's or another's, before main.mts writes its own record.
// Before spawning, each launch is claimed atomically (claimRun in board.mts): the cap is recounted from the board and
// the ticket checked under a shared lock, so a pass running alongside (another project's, a manual one, or a recovery
// attempt) cannot overfill the cap or start the same ticket twice. A refused claim launches nothing. Claims live in the
// admission record (admission.mts, #75): each launch's claim is handed to its child, every normal admission advances the
// project's activity generation, and a project held by a recovery attempt admits nothing.
// With SUBTASKS.enabled (config.mts), a ready issue that has Tasks gets one run per open Task instead.
// Each pass also finishes merged work: a Task whose branch merged into the base is closed, a whole
// ticket moves to LABELS.done, and a parent moves to LABELS.done once all its Tasks are closed.
// With AGENT.modelLabels (config.mts), a ticket without exactly one model label stays queued.
// Existing cards, including deselected parked cards, are retained and reassessed separately (#78, refresh.mts).
// --refresh-only --ticket <iid> is the board's bounded read-only command. It exits before tracker writes or admission.
// Jam report (slice four self-recovery, #61): when the scheduler's tick sets FACTORY_JAM_REPORT (and FACTORY_PASS_ID),
// a pass that is not a dry run writes there, after the board update and before launching, whether the project is jammed
// (graph.mts findJam: still-ready stopped tickets and the holds behind them, with no run in flight, nothing launched,
// nothing awaiting analysis and a free slot) and, for each jammed or still-ready ticket with a run record, its requirement
// fingerprint (unitHash and labels minus the ones Sandcastle writes). The tick counts it only once the pass exits 0. Manual
// passes are not asked for one. The report changes nothing here; the tick decides what to do with it.

// ---- Selection config: which tickets get a run ----------------------------------------
// Tracker, milestone and labels live in config.mts. Every option below is optional; leave one unset
// (or empty) to skip that filter. Filters combine with AND. Each maps to a `glab issue list` flag, or
// on GitHub to the matching `gh issue list` flag or search qualifier (GitLab-only ones are ignored).
const SELECT = {
  // -- People --
  // Only tickets assigned to this username [--assignee]. "@me" means whoever glab is logged in as.
  // Examples: "mark" | "@me" | undefined (any assignee, including unassigned)
  assignee: undefined as string | undefined,
  // Skip tickets assigned to any of these usernames. Applied after the list comes back, so it also
  // catches multi-assignee tickets. Example: ["alice", "bob"]
  excludeAssignees: [] as string[],
  // Only tickets opened by this username [--author]. Example: "mark"
  author: undefined as string | undefined,

  // -- Scope --
  // GitLab only. Ticket type [--issue-type]: "issue" | "incident" | "test_case" | undefined (all types)
  issueType: "issue" as string | undefined,
  // GitLab only. true = only confidential tickets [--confidential]; undefined = both.
  confidential: undefined as boolean | undefined,
  // Free-text match in title and description [--search]. Example: "language switcher"
  search: undefined as string | undefined,

  // -- Order: which tickets are tried first when more qualify than there is room for --
  // [--order] created_at | updated_at | priority | due_date | relative_position | label_priority
  //           | milestone_due | popularity | weight   (GitHub: created_at, updated_at, popularity)
  order: "created_at",
  // [--sort] "asc" (oldest/lowest first) | "desc"
  sort: "asc",

  // -- Throughput --
  // Cap on runs in flight at once, counted from the board across ALL projects sharing the state
  // dir. A pass starts at most (cap - in flight). Overridden by --max.
  maxConcurrent: 3,
  // Pause between launches within one pass, so runs don't race on git fetch / docker start.
  staggerSeconds: 20,
};

const { values: opts } = parseArgs({
  options: {
    base: { type: "string" },
    max: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "whole-issues": { type: "boolean", default: false }, // one run per ready issue, ignoring Tasks
    "refresh-only": { type: "boolean", default: false },
    ticket: { type: "string" },
  },
});
if (!opts.base && !opts["refresh-only"]) {
  console.error("--base <integration branch> is required");
  process.exit(1);
}
const base = opts.base ?? "main";
const dry = opts["dry-run"];
const subtasks = SUBTASKS.enabled && !opts["whole-issues"];
const PROJECT = TRACKER.project;
const cap = Number(opts.max ?? SELECT.maxConcurrent);
const here = dirname(fileURLToPath(import.meta.url));
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

if (opts["refresh-only"]) {
  if (!opts.ticket || !/^\d+$/.test(opts.ticket)) throw new Error("--refresh-only requires --ticket <iid>");
  refreshProject({ base, ticket: opts.ticket, subtasks, select: SELECT, log });
  process.exit(0);
}

const badModels = disallowedModels(AGENT.modelLabels, [AGENT.model, GRAPH.model]);
if (badModels) {
  console.error(badModels);
  process.exit(1);
}
await tracker.ensureLabels(allLabels());
setProject(PROJECT);

// ---- capacity ----------------------------------------------------------------
const allRuns = readRuns();
const running = (r: BoardRun) => !TERMINAL.includes(r.stage) && !PARKED.includes(r.stage);
const active = allRuns.filter(running).length;
const room = Math.max(0, cap - active);
log(`${active} active run(s), cap ${cap}`);

// ---- merged work -------------------------------------------------------------
// Runs whose MR merged into their base since the last pass: close the Task, or move the ticket on.
const openMrs = tracker.openMrBranches();
for (const r of allRuns) {
  if (r.project !== PROJECT || r.stage !== "done" || !r.branch || r.mergedAt || openMrs.has(r.branch)) continue;
  if (!tracker.mergedInto(r.branch, r.base ?? base)) continue;
  const what = r.parentIid ? "Task closed" : `moved to ${LABELS.done}`;
  log(`#${r.iid} merged into ${r.base ?? base}: ${dry ? `would be ${what.toLowerCase()} (dry run)` : what}`);
  if (dry) continue;
  if (r.parentIid) tracker.close(Number(r.iid));
  else tracker.advance(Number(r.iid));
  setStage(r.iid, { mergedAt: new Date().toISOString(), note: `merged; ${what}` });
}

// ---- candidates --------------------------------------------------------------
const ready = tracker.readyList(SELECT);
const parents = ready.filter((i) => !(SELECT.excludeAssignees.length && i.assignees?.some((a) => SELECT.excludeAssignees.includes(a.username))));

// Ready issues with Tasks become their open Tasks; an issue whose Tasks are all closed moves on.
const work = tracker.workCatalogue(subtasks);
const { units, advance } = expandUnits(parents.map((p) => p.iid), work.childrenOf, subtasks);
for (const p of advance) {
  log(`#${p}: every Task is closed; ${dry ? `would move to ${LABELS.done} (dry run)` : `moving to ${LABELS.done}`}`);
  if (!dry) tracker.advance(p);
}
const workById = new Map(work.tickets.map((t) => [t.iid, t]));
const parentById = new Map(parents.map((p) => [p.iid, p]));
const issues = units
  // The catalogue copy is canonical: it carries parent context, so analysis, hashing and dispatch agree.
  .map((u) => workById.get(u.iid) ?? parentById.get(u.iid))
  .filter((t): t is Ticket => !!t && !t.labels?.some((l) => LABELS.exclude.includes(l)));

sh("git", ["fetch", "origin", "--prune"]);
const branches = new Set(
  sh("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]).split("\n").map((b) => b.replace(/^origin\//, "")),
);
const runs = allRuns.filter((r) => r.project === PROJECT);
const runOf = new Map(runs.map((r) => [Number(r.iid), r]));

const unstarted = issues.filter((i) => {
  const r = runOf.get(i.iid);
  if (r && !PARKED.includes(r.stage)) return false; // has a run record that isn't parked
  if ([...branches].some((b) => b.startsWith(`${i.iid}-`))) return false; // already has a branch
  return true;
});
// Tickets without exactly one model label (when AGENT.modelLabels is set) wait for a person to add one.
const noModel = new Map<number, string>();
for (const i of unstarted) {
  const m = ticketModel(i.labels ?? [], AGENT.modelLabels, AGENT.model);
  if ("error" in m) noModel.set(i.iid, m.error);
}
const candidates = unstarted.filter((i) => !noModel.has(i.iid));
for (const i of unstarted.filter((u) => noModel.has(u.iid))) {
  log(`#${i.iid} ${i.title}: ${noModel.get(i.iid)}`);
  if (!dry) setStage(String(i.iid), { stage: "queued", title: i.title, ticketUrl: tracker.ticketUrl(i.iid), base, note: noModel.get(i.iid) });
}
log(`${parents.length} ready ticket(s), ${issues.length} unit(s) of work, ${candidates.length} not yet started`);

// ---- ticket graph ------------------------------------------------------------
const live = runs.filter((r) => running(r) || (r.stage === "done" && !!r.branch && openMrs.has(r.branch)));
const catalogue = work.tickets;
const catalogueById = new Map(catalogue.map((t) => [t.iid, t]));
const catalogueHash = new Map(catalogue.map((t) => [t.iid, contentHash({ title: t.title, description: t.description })]));
const manifests = readManifests(PROJECT);

// Tickets whose manifest must be current: candidates, plus live runs still on a predicted footprint.
const tracked: Ticket[] = [
  ...candidates,
  ...live.filter((r) => !manifests.get(Number(r.iid))?.actualFootprint).map((r) => catalogueById.get(Number(r.iid))).filter((t): t is Ticket => !!t),
];
const notesOf = new Map<number, Note[]>();
const hashOf = new Map<number, string>();
for (const t of tracked) {
  const n = tracker.notes(t.iid);
  notesOf.set(t.iid, n);
  hashOf.set(t.iid, unitHash(t, n));
}

const stale = tracked
  .map((t) => ({ t, why: staleReason(manifests.get(t.iid), hashOf.get(t.iid)!, catalogueHash) }))
  .filter((s): s is { t: Ticket; why: string } => !!s.why);
const batch = stale.slice(0, GRAPH.maxAnalysesPerPass);
if (stale.length) log(`${stale.length} ticket(s) need analysis; analysing ${batch.length} this pass`);
if (batch.length) {
  const worktree = analysisWorktree(PROJECT, base);
  for (const { t, why } of batch) {
    log(`analysing #${t.iid} (${why})`);
    const prev = manifests.get(t.iid);
    try {
      const m = analyse({
        project: PROJECT, base, worktree, ticket: t, notes: notesOf.get(t.iid)!, catalogue, manifests,
        // A person editing the ticket is how a wrong implementer-reported blocker gets corrected.
        keepImplementerBlockers: !prev?.analyzedAt || why !== "ticket changed",
      });
      writeManifest(m);
      manifests.set(t.iid, m);
      const deps = edgesOf(m).map((e) => `#${e.from}`);
      log(`  depends on ${deps.join(", ") || "nothing"}; footprint ${m.footprint.length} path(s)`);
    } catch (e) {
      log(`  ${(e as Error).message}`);
    }
  }
}

// A blocker is satisfied when its ticket is closed, or its Sandcastle branch is merged into its base.
const satisfiedCache = new Map<number, boolean>();
const satisfied = (iid: number): boolean => {
  if (!satisfiedCache.has(iid)) {
    let ok = false;
    try {
      ok = !catalogueById.has(iid) && tracker.ticket(iid).state === "closed";
    } catch {
      ok = true; // ticket doesn't exist: nothing to wait for; the implementer reports it if it matters
    }
    const r = runOf.get(iid);
    if (!ok && r?.branch) ok = tracker.mergedInto(r.branch, r.base ?? base);
    satisfiedCache.set(iid, ok);
  }
  return satisfiedCache.get(iid)!;
};

const { decisions, dropped } = decide({
  candidates: candidates.map((c) => ({ iid: c.iid, hash: hashOf.get(c.iid)! })),
  manifests,
  satisfied,
  queue: new Set([...candidates.map((c) => c.iid), ...runs.filter((r) => r.stage !== "stopped").map((r) => Number(r.iid))]),
  live: live.map((r) => {
    const m = manifests.get(Number(r.iid));
    return { iid: Number(r.iid), footprint: m?.actualFootprint ?? m?.footprint ?? [] };
  }),
  room,
  ignore: GRAPH.conflictIgnore,
});
for (const e of dropped) log(`cycle: ignoring "#${e.to} depends on #${e.from}" (${e.what}, confidence ${e.confidence})`);

// ---- refresh existing cards (#78) ----------------------------------------------------
// This separate analysis store never feeds decide() or writes an execution manifest. Share the per-pass budget,
// including failed analysis attempts. No assessment-store failure may abort the admission path below.
if (!dry) {
  try { refreshProject({ base, subtasks, select: SELECT, budget: Math.max(0, GRAPH.maxAnalysesPerPass - batch.length), log }); }
  catch (e) { log(`assessment refresh: ${(e as Error).message}`); }
}

// ---- board -------------------------------------------------------------------
const byIid = new Map(candidates.map((c) => [c.iid, c]));
for (const d of decisions) {
  const c = byIid.get(d.iid)!;
  log(`#${d.iid} ${c.title}: ${d.launch ? (dry ? "would launch (dry run)" : "launching") : d.reason}`);
  if (dry || d.launch) continue;
  const stage = runOf.get(d.iid)?.stage === "waiting" ? "waiting" : "queued";
  setStage(String(d.iid), { stage, title: c.title, ticketUrl: tracker.ticketUrl(d.iid), base, note: d.reason });
}
if (!dry) {
  // Parked cards that leave selection keep their complete history. They are absent from candidates, so cannot launch.
  // Their current tracker state/selection is recorded by refreshProject, not by rewriting the historical run.
  // Manifests of tickets that are gone, once they're old enough not to explain anything.
  const cutoff = Date.now() - GRAPH.pruneAfterDays * 86_400_000;
  const liveIids = new Set(live.map((r) => Number(r.iid)));
  for (const m of manifests.values()) {
    if (!catalogueById.has(m.iid) && !liveIids.has(m.iid) && Date.parse(m.analyzedAt || "1970-01-01") < cutoff) removeManifest(PROJECT, m.iid);
  }
}

// ---- jam report (scheduled passes only; see the header) --------------------------
const jamReport = process.env.FACTORY_JAM_REPORT;
if (jamReport && !dry) {
  const jam = findJam({
    units: issues.map((i) => {
      const r = runOf.get(i.iid);
      return { iid: i.iid, stage: r?.stage, openPr: !!r?.branch && openMrs.has(r.branch) };
    }),
    decisions,
    active: runs.filter(running).map((r) => Number(r.iid)),
    room,
  });
  const ours = new Set([...LABELS.ready, LABELS.needsHuman, LABELS.done]);
  const jammed = new Set<number>(jam.tickets);
  const watched = issues.filter((i) => jammed.has(i.iid) || ["stopped", "done"].includes(runOf.get(i.iid)?.stage ?? ""));
  const tickets = watched.map((t) => ({
    iid: t.iid,
    content: hashOf.get(t.iid) ?? unitHash(t, tracker.notes(t.iid)),
    labels: (t.labels ?? []).filter((l) => !ours.has(l)),
  }));
  log(jam.tickets.length ? `jam: ${jam.tickets.map((t) => `#${t}`).join(", ")}` : `no jam: ${"none" in jam ? jam.none : ""}`);
  const temp = `${jamReport}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, pass: process.env.FACTORY_PASS_ID ?? "", project: PROJECT, at: new Date().toISOString(), ...jam, observed: tickets }, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, jamReport);
}

// ---- launch ------------------------------------------------------------------
const launch = decisions.filter((d) => d.launch);
if (dry || !launch.length) process.exit(0);
const npx = resolve(dirname(process.execPath), "npx");
const logDir = resolve(here, "logs");
mkdirSync(logDir, { recursive: true });
for (const [n, d] of launch.entries()) {
  const iid = String(d.iid);
  const meta = { title: byIid.get(d.iid)!.title, ticketUrl: tracker.ticketUrl(d.iid), base };
  // Held by this pass's pid until the child is spawned; if this pass dies first, readers drop the unstarted claim.
  const claim = claimRun({ iid, pid: process.pid, cap, patch: meta });
  if (!claim.ok) {
    log(`#${iid} not launched: ${claim.reason}`);
    if (claim.reason.startsWith("no capacity")) break;
    continue;
  }
  const out = openSync(resolve(logDir, `run-${iid}.log`), "a");
  const child = spawn(existsSync(npx) ? npx : "npx", ["tsx", resolve(here, "main.mts"), "--base", base, "--issue", iid, ...(opts["whole-issues"] ? ["--whole-issues"] : [])], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  // The claim goes to the child (main.mts adopts it); a launch that failed to spawn releases it.
  if (child.pid) reserveRun(iid, child.pid, { ...meta, claim: claim.run.claim });
  else removeRun(iid, claim.run.claim);
  if (n < launch.length - 1) await new Promise((r) => setTimeout(r, SELECT.staggerSeconds * 1000));
}
