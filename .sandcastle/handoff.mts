import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { RunState } from "./board.mts";
import { edgesOf, SANDCASTLE_MARK } from "./graph.mts";
import type { Manifest } from "./graph.mts";
import type { Delivered, Delivery } from "./tracker.mts";

// The hand-off every branch goes through before it leaves the host: the independent verifier, then evidence posted to
// the ticket, then on PASS push and normal delivery (tracker.deliver: an MR on GitLab, a PR merged after CI on GitHub
// with MERGE.auto). main.mts calls it after its implementer; a recovery run (slice four) calls the same functions after
// its repair agent, so a repaired branch gets no shortcut: the same verifier prompt and model (AGENT.model), the same
// "verifier must not change the branch" check, the same PASS gate, push and delivery limits. Two things protect a run
// that reuses a ticket's record and evidence folder (a recovery attempt on a preserved branch): beginVerification
// removes an earlier verdict.md and clears the record's verdict/PR before the verifier starts, so only this run's
// verdict can count and a stale PASS never reads as delivery (cli/src/recovery-state.mts deliveryMarker); and the PR
// description says the branch was repaired by which recovery attempt. prerequisiteHold (#75) is the recovery run's
// recheck, before verification and again before delivery, of the dependency holds the dispatcher's ticket analysis
// records (manifests: analysed requirements and implementer-reported blockers): any prerequisite not yet closed or
// merged, whether in flight or waiting in an open PR, holds the ticket; a missing or out-of-date analysis, or a lookup
// that fails, is unknown and holds it too. Host calls are passed in (Host), so this file imports no tracker, config or
// board module (only graph.mts's marker and edges) and is tested with fakes (handoff.test.mts).

/** What the hand-off needs from the host: board, tracker and git. main.mts passes the real ones. */
export interface Host {
  setStage(iid: string, patch: Partial<RunState>): void;
  readRuns(): RunState[];
  /** A run whose branch may still merge (board TERMINAL/PARKED rules): its conflicts are listed in the PR. */
  live(run: RunState, openMrs: Set<string>): boolean;
  /** git on the host checkout; throws on failure like execFileSync. */
  git(args: string[]): string;
  /** git returning its exit status instead of throwing (rev-parse --verify, merge-tree). */
  gitStatus(args: string[]): { status: number | null; stdout: string };
  tracker: {
    comment(iid: string, body: string): void;
    uploadEvidence(iid: string, tip: string, files: string[]): string[];
    openMrBranches(): Set<string>;
    deliver(d: Delivery & { waitMinutes: number; noCiMinutes: number; autoMerge: boolean }): Promise<Delivered>;
  };
}

/** The bit of a Sandcastle sandbox the verifier needs. */
export interface VerifierSandbox {
  run(o: { agent: unknown; promptFile: string; promptArgs: Record<string, string>; maxIterations: number; completionSignal: string; name: string }): Promise<{ commits: unknown[] }>;
  exec(cmd: string): Promise<{ stdout: string }>;
  worktreePath?: string;
}

/** Who produced the branch: the normal implementer, or a recovery attempt's repair agent. */
export type Origin = { kind: "implemented" } | { kind: "repaired"; attempt: number };

export const VERIFY_PROMPT = "./.sandcastle/prompt.verify.md";

/** Clear what an earlier run of this ticket left that could pass for this run's verdict, then mark the record verifying. */
export function beginVerification(host: Pick<Host, "setStage">, iid: string, evidenceHost: string): void {
  rmSync(resolve(evidenceHost, "verdict.md"), { force: true });
  host.setStage(iid, { stage: "verifying", verdict: undefined, mr: undefined, mergedAt: undefined });
}

/** Run the independent verifier on `tip` in the run's sandbox. Returns why the result can't be used, or undefined. */
export async function runVerifier(sandbox: VerifierSandbox, host: Pick<Host, "setStage">,
  o: { iid: string; evidenceHost: string; agent: unknown; promptArgs: Record<string, string>; tip: string; promptFile?: string }): Promise<string | undefined> {
  beginVerification(host, o.iid, o.evidenceHost);
  const ver = await sandbox.run({
    agent: o.agent,
    promptFile: o.promptFile ?? VERIFY_PROMPT,
    promptArgs: { ...o.promptArgs, TIP_SHA: o.tip },
    maxIterations: 1,
    completionSignal: "<promise>COMPLETE</promise>",
    name: "verifier",
  });
  const after = (await sandbox.exec("git rev-parse HEAD")).stdout.trim();
  const dirty = (await sandbox.exec("git status --porcelain")).stdout.trim();
  if (ver.commits.length || after !== o.tip || dirty) {
    return `Verifier changed the branch (commits=${ver.commits.length}, head=${after.slice(0, 8)}, dirty=${!!dirty}). Not posting or pushing; inspect ${sandbox.worktreePath ?? "the worktree"}.`;
  }
  return undefined;
}

export interface Handoff {
  iid: string;
  project: string;
  branch: string;
  base: string;
  baseSha: string;
  tip: string;
  title: string;
  evidenceHost: string;
  parentIid?: number;
  origin: Origin;
  /** Markdown said in the PR when the ticket changed during the run; "" when it did not. */
  staleNote?: string;
  noPush?: boolean;
  ciWaitMinutes: number;
  noCiMinutes: number;
  autoMerge: boolean;
}

export type Outcome =
  | { ok: true; verdict: "PASS"; pushed: false; note: string }
  | { ok: true; verdict: "PASS"; pushed: true; url: string; merged: boolean }
  | { ok: false; verdict?: string; reason: string };

/** Steps 3 and 4: post the verifier's evidence to the ticket, then on PASS push and deliver. Leaves the record `done`
 *  with verdict and PR on success; on failure returns the reason (the caller ends the run, as `stopped`). */
export async function postAndDeliver(h: Handoff, host: Host): Promise<Outcome> {
  const { iid, branch, base, tip } = h;
  host.setStage(iid, { stage: "posting" });
  const verdictFile = resolve(h.evidenceHost, "verdict.md");
  if (!existsSync(verdictFile)) return { ok: false, reason: `Verifier wrote no verdict.md in ${h.evidenceHost}. Nothing posted or pushed.` };
  const verdictText = readFileSync(verdictFile, "utf8").trim();
  const verdict = /^VERDICT:\s*(PASS|FAIL|INCONCLUSIVE)/.exec(verdictText)?.[1] ?? "INCONCLUSIVE";
  const repaired = h.origin.kind === "repaired" ? `Repaired by Factory recovery attempt ${h.origin.attempt}, then verified independently.` : "";

  const files = readdirSync(h.evidenceHost).sort();
  const media = (label: string) => files.filter((f) => (f.startsWith(`${label}-`) && f.endsWith(".png")) || f === `${label}.webm`);
  const shown = [...media("before"), ...media("after")];
  const uploaded = new Map(host.tracker.uploadEvidence(iid, tip, shown.map((f) => resolve(h.evidenceHost, f))).map((md, i) => [shown[i], md]));
  const section = (label: string, title: string) => {
    const items = media(label).map((f) => `**${f}**\n\n${uploaded.get(f)}`);
    return items.length ? `### ${title}\n\n${items.join("\n\n")}` : "";
  };
  host.tracker.comment(iid, [
    `## Sandcastle verification: ${verdict}`,
    `Branch \`${branch}\` @ \`${tip.slice(0, 8)}\` (from \`${base}\` @ \`${h.baseSha.slice(0, 8)}\`). Synthetic data.`,
    repaired,
    verdictText.replace(/^VERDICT:.*\n?/, ""),
    section("before", "Before"),
    section("after", "After"),
    SANDCASTLE_MARK,
  ].filter(Boolean).join("\n\n"));
  console.log(`Evidence posted to #${iid} (verdict ${verdict}).`);
  host.setStage(iid, { verdict });

  if (verdict !== "PASS") return { ok: false, verdict, reason: `Verdict ${verdict}: branch ${branch} kept locally, not pushed. Review the ticket comment.` };
  if (h.noPush) {
    const note = "--no-push: branch ready locally";
    host.setStage(iid, { stage: "done", note });
    return { ok: true, verdict, pushed: false, note };
  }

  host.setStage(iid, { stage: "pushing" });
  try {
    host.git(["push", "-u", "origin", branch]);
  } catch (e) {
    return { ok: false, verdict, reason: `Push of ${branch} failed: ${(e as Error).message}` };
  }
  const sha = host.git(["rev-parse", branch]);

  // Exact conflicts with the other live Sandcastle branches, so you know which MR to merge first.
  const openMrs = host.tracker.openMrBranches();
  const conflicts = host.readRuns()
    .filter((r) => r.project === h.project && r.iid !== iid && r.branch && host.live(r, openMrs))
    .filter((r) => host.gitStatus(["rev-parse", "--verify", "--quiet", r.branch!]).status === 0)
    .flatMap((r) => {
      const res = host.gitStatus(["merge-tree", "--write-tree", "--name-only", "--no-messages", branch, r.branch!]);
      if (res.status !== 1) return [];
      const files = [...new Set(res.stdout.trim().split("\n").slice(1).filter(Boolean))];
      return [`- #${r.iid} (\`${r.branch}\`${r.mr ? `, ${r.mr}` : ""}): ${files.map((f) => `\`${f}\``).join(", ")}`];
    });
  const body = (ciNote: string) => [
    h.parentIid === undefined ? `Refs #${iid}` : `Refs #${iid} (Task of #${h.parentIid})`,
    repaired
      ? `${repaired} Verdict: **${verdict}** (evidence in the ticket comment).`
      : `Implemented and verified by Sandcastle. Verdict: **${verdict}** (evidence in the ticket comment).`,
    ciNote,
    h.staleNote ?? "",
    conflicts.length ? `**Conflicts with other open Sandcastle work.** Merge one, then rebase the other:\n\n${conflicts.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  let delivered: Delivered;
  try {
    delivered = await host.tracker.deliver({
      branch, base, sha, title: `#${iid}: ${h.title}`, body, onStage: (stage) => host.setStage(iid, { stage }),
      waitMinutes: h.ciWaitMinutes, noCiMinutes: h.noCiMinutes, autoMerge: h.autoMerge,
    });
  } catch (e) {
    return { ok: false, verdict, reason: (e as Error).message };
  }
  host.setStage(iid, { stage: "done", mr: delivered.url, note: delivered.merged ? "merged after CI passed" : "" });
  return { ok: true, verdict, pushed: true, url: delivered.url, merged: delivered.merged };
}

/** What prerequisiteHold reads, from the host: the ticket's analysis and live lookups. */
export interface PrerequisiteView {
  /** The dispatcher's analysis of the ticket (its manifest), if any. */
  manifest: Manifest | undefined;
  /** The ticket's current content hash (graph.mts unitHash), to tell an out-of-date analysis. */
  hash: string;
  /** Is prerequisite `iid` done (closed, or its branch merged into its base)? May throw: unknown. */
  satisfied(iid: number): boolean;
  /** Why prerequisite `iid` is still active (a run in flight, an open PR), or undefined. May throw: unknown. */
  active(iid: number): string | undefined;
}

/** Why ticket `iid` is held by a prerequisite (or by not knowing its prerequisites), or undefined when it is free. */
export function prerequisiteHold(iid: number, v: PrerequisiteView): string | undefined {
  try {
    if (!v.manifest) return `#${iid} has no ticket analysis, so its prerequisites are unknown`;
    if (v.manifest.hash !== v.hash) return `#${iid}'s ticket analysis is out of date, so its prerequisites are unknown`;
    for (const e of edgesOf(v.manifest)) {
      if (e.to !== iid || v.satisfied(e.from)) continue;
      const why = v.active(e.from);
      return `#${iid} waits on #${e.from}${why ? ` (${why})` : ""}: ${e.what}`;
    }
    return undefined;
  } catch (e) {
    return `#${iid}'s prerequisites are unknown: ${(e as Error).message}`;
  }
}
