// Read-only current assessment adapter (#78). Shared by scheduled dispatch and --refresh-only, which exits before
// tracker writes, run updates, admission or launches. Analysis results go only to assessments; execution manifests
// remain untouched. Assessment uses a separate read-only worktree so a manual check cannot reset the execution
// analyst's checkout. Allocate assessment attempts before any tracker reads, including catalogue failures, so older
// scheduled/manual passes cannot publish over newer facts. The board worker passes its token to its child; neither
// path takes admission locks. The caller gives the remaining per-pass budget; analyze.mts enforces its own timeout.
import { analyse, analysisWorktree } from "./analyze.mts";
import { readRuns, stateDir } from "./board.mts";
import { assessed, beginAssessment, pickRefreshes, publishAssessment, readAssessment, readAssessments, refreshCards, writeAssessment, pendingRequests, clearRequest } from "./assessment.mts";
import { AGENT, GRAPH, LABELS, SUBTASKS, TRACKER } from "./config.mts";
import { contentHash, expandUnits, unitHash } from "./graph.mts";
import { readManifests } from "./manifests.mts";
import { ticketModel } from "./models.mts";
import * as tracker from "./tracker.mts";
import type { Select, Ticket } from "./tracker.mts";

export function refreshProject(o: { base: string; ticket?: string; budget?: number; subtasks?: boolean; select?: Select & { excludeAssignees?: string[] };
  log?: (m: string) => void }): void {
  const log = o.log ?? console.log, dir = stateDir();
  const allRuns = readRuns(dir, false);
  const runs = allRuns.filter((r) => r.project === TRACKER.project && (!o.ticket || r.iid === o.ticket));
  if (!runs.length) return;
  const asked = pendingRequests(dir), attempts = new Map<string, string>();
  try {
    const keys = pickRefreshes(runs.map((r) => r.key), asked, readAssessments(dir));
    for (const key of keys) {
      try {
        attempts.set(key, beginAssessment(dir, key, process.env.FACTORY_REFRESH_KEY === key ? process.env.FACTORY_REFRESH_ATTEMPT : undefined));
      } catch (e) { log(`assessment store: ${(e as Error).message}`); }
    }
    if (!attempts.size) return;
    const work = tracker.workCatalogue(o.subtasks ?? SUBTASKS.enabled);
    const catalogue = work.tickets;
    const manifests = readManifests(TRACKER.project);
    const parents = tracker.readyList(o.select).filter((t) => !o.select?.excludeAssignees?.some((a) => t.assignees?.some((x) => x.username === a)));
    const selected = new Set(expandUnits(parents.map((t) => t.iid), work.childrenOf, o.subtasks ?? SUBTASKS.enabled).units.map((t) => t.iid));
    const catalogueKey = contentHash({ title: JSON.stringify(catalogue.map((t) => [t.iid, t.title, t.description, t.parent]).sort((a, b) => Number(a[0]) - Number(b[0]))) });
    let worktree: ReturnType<typeof analysisWorktree> | undefined;
    refreshCards(runs.filter((r) => attempts.has(r.key)), {
      dir, attempts, project: TRACKER.project, root: process.cwd(), now: () => new Date().toISOString(),
      read: (iid) => {
        const t = tracker.ticket(iid), parent = tracker.parentOf(iid);
        if (parent === undefined) return t;
        const p = tracker.ticket(parent);
        return { ...t, parent: { iid: p.iid, title: p.title, description: p.description } };
      },
      notes: tracker.notes, hash: unitHash, model: (labels) => ticketModel(labels, AGENT.modelLabels, AGENT.model),
      selection: (t) => {
        const closed = t.state === "closed", excluded = t.labels?.some((l) => LABELS.exclude.includes(l));
        return { selected: !closed && !excluded && selected.has(t.iid),
          selectionReason: closed ? "Closed in tracker" : excluded ? "Excluded by tracker label" : !selected.has(t.iid) ? "Not selected by current dispatch filters" : undefined };
      },
      analysisInput: (t, notes) => `${unitHash(t, notes)}:${catalogueKey}:${JSON.stringify(manifests.get(t.iid)?.implementerBlockers ?? [])}`,
      analysisBudget: o.budget ?? GRAPH.maxAnalysesPerPass,
      analyse: (ticket, notes) => {
        worktree ??= analysisWorktree(`${TRACKER.project}--assessment`, o.base);
        const prev = manifests.get(ticket.iid);
        const old = readAssessment(dir, runs.find((r) => Number(r.iid) === ticket.iid)!.key)?.analysis;
        const ids = new Set([...(prev?.requires ?? []), ...(old?.requires ?? [])].map((r) => r.providedBy).filter((i): i is number => i != null));
        const knownProviders: Ticket[] = [];
        for (const iid of ids) if (!catalogue.some((t) => t.iid === iid)) {
          try { knownProviders.push(tracker.ticket(iid)); } catch { /* leave unresolved, never infer satisfied */ }
        }
        return analyse({ project: TRACKER.project, base: o.base, worktree, ticket, notes, catalogue, manifests,
          knownProviders, keepImplementerBlockers: true });
      },
      historicalBlockers: (iid) => manifests.get(iid),
      dependency: (iid) => {
        // Never reuse dispatch's fail-open satisfied(): network/auth errors mean unknown here.
        let state: "satisfied" | "unsatisfied" | "unknown" = "unknown";
        try {
          const current = tracker.ticket(iid).state;
          state = current === "closed" ? "satisfied" : current === "open" || current === "opened" ? "unsatisfied" : "unknown";
        } catch { return "unknown"; }
        if (state === "satisfied") return state;
        const r = allRuns.find((r) => r.project === TRACKER.project && Number(r.iid) === iid);
        if (r?.branch) {
          try { if (tracker.mergedInto(r.branch, r.base ?? o.base)) return "satisfied"; } catch { return "unknown"; }
        }
        return state;
      }, log,
    });
  } catch (e) {
    const error = (e as Error).message.slice(0, 300);
    log(`assessment refresh: ${error}`);
    for (const r of runs) {
      try {
        const token = attempts.get(r.key);
        if (!token) continue;
        publishAssessment(dir, r.key, token, () => {
          writeAssessment(dir, r.key, assessed(readAssessment(dir, r.key), { iid: r.iid, project: r.project, at: new Date().toISOString(), error }));
          clearRequest(dir, r.key, asked.get(r.key));
        });
      } catch (e) { log(`assessment store: ${(e as Error).message}`); }
    }
  }
}
