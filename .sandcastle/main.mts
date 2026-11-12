import { createSandbox, claudeCode, pi } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { PARKED, readRuns, setProject, setStage, TERMINAL } from "./board.mts";
import { parentText } from "./analyze.mts";
import { AGENT, allLabels, GRAPH, LABELS, MERGE, SUBTASKS, TRACKER } from "./config.mts";
import { disallowedModels, piEnvFor, ticketModel } from "./models.mts";
import { blockedOutcome, expandUnits, SANDCASTLE_MARK, unitHash } from "./graph.mts";
import type { ImplementerBlocker } from "./graph.mts";
import { patchManifest } from "./manifests.mts";
import * as tracker from "./tracker.mts";

// End-to-end loop for one ticket (run from the repo root):
//   npx tsx .sandcastle/main.mts --base sal-develop [--issue 695] [--no-push]
// 1. branch <iid>-<slug> off origin/<base>   2. implementer run   3. verifier run (screenshots/video + verdict)
// 4. host posts the evidence to the ticket   5. on PASS: push and deliver (tracker adapter):
//    GitLab: wait for the branch pipeline, open an MR into <base>; never merges.
//    GitHub: open a PR into <base>; with MERGE.auto, merge it once every CI check passes (ci.mts).
// Never closes the ticket (the dispatcher closes a Task/sub-issue, or moves a ticket on, once its work
// merges). Every tracker call runs on the host with your glab/gh login; the container has no tracker token.
// The agent (Claude Code or Pi) comes from AGENT in config.mts. The implementer's model is AGENT.model, or
// with AGENT.modelLabels the one the ticket's model label names (models.mts); the verifier always uses AGENT.model.

// ---- Project config: the block to edit when adapting this to another project ----------
// Tracker, agent, merge policy, milestone and labels live in config.mts. (Also adapt sandbox/bootstrap-site.sh, the
// Environment section of prompt.md, and the fixture advice in prompt.verify.md. See ADAPTING.md.)
const CONFIG = {
  image: "sandcastle-r2", // factory:image - `factory init --image` replaces the value
  ciWaitMinutes: 30, // give up waiting for CI after this long
  // No CI seen in this time: GitLab opens the MR anyway; with MERGE.auto the PR is not merged.
  noPipelineMinutes: 5,
  // Runs in order inside the container once it is up; the working directory is the worktree.
  sandboxSetup: [
    { command: "npm ci", timeoutMs: 10 * 60_000 },
  ] as { command: string; sudo?: boolean; timeoutMs?: number }[],
};
const PROJECT = TRACKER.project;
const IMAGE = CONFIG.image;
// What the container's Pi run needs depends on its model's provider (models.mts). pi-claude-subscription (the
// personal config) needs nothing from here: the image's Claude Code CLI logs in with CLAUDE_CODE_OAUTH_TOKEN,
// which Sandcastle reads from .sandcastle/.env itself. Only an `openai/` model (a custom config) gets a
// per-run token from the host's pi login, handed over as OPENAI_API_KEY for that one run.
function openaiCredential(): string {
  for (const cmd of [["print-bearer-token", "--min-expiry", "50m"], ["print-api-key"]]) {
    const res = spawnSync("pi", ["auth", ...cmd, "--provider", "openai"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  }
  fail("pi on the host has no usable OpenAI login. Run pi, then /login, and pick Sign in with ChatGPT.");
}
// Called as each run starts.
const agent = (model: string) =>
  AGENT.provider === "pi" ? pi(model, { thinking: AGENT.thinking, env: piEnvFor(model, openaiCredential) }) : claudeCode(model);

let currentIid: string | undefined;
let finished = false;
let lastMessage = "";
function fail(msg: string): never {
  lastMessage = msg;
  console.error(msg);
  process.exit(1);
}
// Anything that ends the process before a terminal stage lands on the board as "washed away".
process.on("exit", (code) => {
  if (currentIid && !finished) setStage(currentIid, { stage: "stopped", note: lastMessage || `exited with code ${code}` });
});
function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

const { values: opts } = parseArgs({
  options: {
    base: { type: "string" },
    issue: { type: "string" },
    "no-push": { type: "boolean", default: false },
    "whole-issues": { type: "boolean", default: false }, // without --issue: pick a ready issue, not one of its Tasks
  },
});
if (!opts.base) fail("--base <integration branch> is required (e.g. sal-develop, or sal-redesign for #565 children)");
const base = opts.base;
if (base !== "spike-1") fail("R2 Factory runs must target spike-1, never main.");
if (MERGE.auto && (TRACKER as { kind?: string }).kind !== "github" && !opts["no-push"]) fail('MERGE.auto needs TRACKER.kind "github" (config.mts).');
const badModels = disallowedModels(AGENT.modelLabels, [AGENT.model, GRAPH.model]);
if (badModels) fail(badModels);
await tracker.ensureLabels(allLabels());

// ---- pick the ticket -------------------------------------------------------
const subtasks = SUBTASKS.enabled && !opts["whole-issues"];
const work = tracker.workCatalogue(subtasks);
let iid = opts.issue;
if (!iid) {
  const first = expandUnits(tracker.readyList().map((i) => i.iid), work.childrenOf, subtasks).units[0];
  if (!first) fail(`No open issues or Tasks labelled ${LABELS.ready.join(" + ")}.`);
  iid = String(first.iid);
}
// A Task gets its parent issue as context; whole tickets have none.
const parentIid = tracker.parentOf(Number(iid));
const withParent = (t: tracker.Ticket): tracker.Ticket => {
  if (parentIid === undefined) return t;
  const p = tracker.ticket(parentIid);
  return { ...t, parent: { iid: p.iid, title: p.title, description: p.description } };
};
const startTicket = withParent(tracker.ticket(Number(iid)));
const issue = startTicket;
const picked = ticketModel(startTicket.labels ?? [], AGENT.modelLabels, AGENT.model);
if ("error" in picked) fail(`#${iid} ${picked.error}. Not started.`);
const implementerModel = picked.model;
const ticket = [tracker.viewText(Number(iid)), parentText(startTicket)].filter(Boolean).join("\n\n");
// The version of the ticket this run builds from; compared again before the MR opens.
const ticketHash = (t = withParent(tracker.ticket(Number(iid)))) => ({ hash: unitHash(t, tracker.notes(Number(iid))), description: t.description });
const startVersion = ticketHash(startTicket);
const catalogue = work.tickets.filter((t) => String(t.iid) !== iid);
const slug = String(issue.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
const branch = `${iid}-${slug}`;

sh("git", ["fetch", "origin", base]);
const baseSha = sh("git", ["rev-parse", `origin/${base}`]);
if (sh("git", ["branch", "--list", branch]) || sh("git", ["ls-remote", "--heads", "origin", branch])) {
  fail(`Branch ${branch} already exists locally or on origin; delete it or pick another ticket.`);
}
currentIid = iid;
setProject(PROJECT);
setStage(iid, {
  title: String(issue.title), ticketUrl: tracker.ticketUrl(iid), branch, base, stage: "setup", startedAt: new Date().toISOString(), note: "",
  evidenceDir: resolve(".sandcastle/evidence", iid), ticketHash: startVersion.hash, verdict: undefined, mr: undefined,
  parentIid: parentIid === undefined ? undefined : String(parentIid), mergedAt: undefined,
});
// Heartbeat so the board can tell a long agent run from a dead process.
setInterval(() => { if (!finished) setStage(iid!, {}); }, 60_000).unref();
console.log(`#${iid} ${issue.title}\n  branch ${branch} from origin/${base} (${baseSha.slice(0, 8)}), implementer ${implementerModel}`);

// ---- sandbox: one container + one site install shared by both runs -------------
const evidenceHost = resolve(".sandcastle/evidence", iid);
const evidenceBox = `/home/agent/evidence/${iid}`;
mkdirSync(evidenceHost, { recursive: true });
mkdirSync(resolve(".sandcastle/sandbox"), { recursive: true }); // mounted read-only at /opt/sandcastle; empty unless the project adds helpers
// A relaunched ticket (it was waiting on a blocker) must not pick up the last run's reports.
for (const f of ["blocked.json", "verdict.md"]) rmSync(resolve(evidenceHost, f), { force: true });

/** blocked.json from the implementer: tickets (or things) it needs that aren't merged yet. */
function readBlocked(): ImplementerBlocker[] | undefined {
  const file = resolve(evidenceHost, "blocked.json");
  if (!existsSync(file)) return undefined;
  try {
    const list = JSON.parse(readFileSync(file, "utf8")).blockers;
    if (!Array.isArray(list)) return [];
    return list.map((b: Partial<ImplementerBlocker>) => ({
      iid: Number.isInteger(b.iid) ? (b.iid as number) : null,
      what: String(b.what ?? ""),
      evidence: String(b.evidence ?? ""),
    }));
  } catch {
    return []; // unreadable report: blockedOutcome sends it to a person
  }
}

const sandbox = await createSandbox({
  branch,
  baseBranch: `origin/${base}`,
  sandbox: docker({
    imageName: IMAGE,
    mounts: [
      { hostPath: resolve(".sandcastle/evidence"), sandboxPath: "/home/agent/evidence" },
      { hostPath: resolve(".sandcastle/sandbox"), sandboxPath: "/opt/sandcastle", readonly: true },
    ],
  }),
  hooks: {
    sandbox: {
      onSandboxReady: CONFIG.sandboxSetup,
    },
  },
});

const promptArgs = {
  ISSUE_IID: iid,
  ISSUE_TITLE: String(issue.title),
  TICKET: ticket,
  BASE_BRANCH: base,
  BASE_SHA: baseSha,
  BRANCH: branch,
  EVIDENCE_DIR: evidenceBox,
  CATALOGUE: catalogue.map((t) => `- #${t.iid} ${t.title}`).join("\n") || "(none)",
};

let tip = "";
let blockers: ImplementerBlocker[] | undefined;
try {
  // ---- 1. implementer ----------------------------------------------------------
  setStage(iid, { stage: "implementing" });
  const impl = await sandbox.run({
    agent: agent(implementerModel),
    promptFile: "./.sandcastle/prompt.md",
    promptArgs,
    maxIterations: 1,
    completionSignal: "<promise>COMPLETE</promise>",
    name: "implementer",
  });
  if (!impl.commits.length) {
    blockers = readBlocked();
    if (!blockers) fail(`Implementer made no commit for #${iid} (no change needed, or blocked). See ${impl.logFilePath ?? "logs"}. Nothing pushed.`);
  } else {
    tip = (await sandbox.exec("git rev-parse HEAD")).stdout.trim();
    // The real diff replaces the predicted footprint for conflict checks from now on.
    patchManifest(PROJECT, Number(iid), { actualFootprint: sh("git", ["diff", "--name-only", `${baseSha}...${tip}`]).split("\n").filter(Boolean) });

    // ---- 2. verifier -------------------------------------------------------------
    setStage(iid, { stage: "verifying" });
    const ver = await sandbox.run({
      agent: agent(AGENT.model),
      promptFile: "./.sandcastle/prompt.verify.md",
      promptArgs: { ...promptArgs, TIP_SHA: tip },
      maxIterations: 1,
      completionSignal: "<promise>COMPLETE</promise>",
      name: "verifier",
    });
    const after = (await sandbox.exec("git rev-parse HEAD")).stdout.trim();
    const dirty = (await sandbox.exec("git status --porcelain")).stdout.trim();
    if (ver.commits.length || after !== tip || dirty) {
      fail(`Verifier changed the branch (commits=${ver.commits.length}, head=${after.slice(0, 8)}, dirty=${!!dirty}). Not posting or pushing; inspect ${sandbox.worktreePath}.`);
    }
  }
} finally {
  await sandbox.close();
}

// ---- implementer reported a missing prerequisite ----------------------------------
if (blockers) {
  const satisfied = (b: number) => {
    const t = tracker.ticket(b);
    if (t.state === "closed") return true;
    const run = readRuns().find((r) => r.project === PROJECT && r.iid === String(b));
    return !!run?.branch && tracker.mergedInto(run.branch, run.base ?? base);
  };
  const what = blockers.map((b) => `${b.iid != null ? `#${b.iid}` : "no ticket"}: ${b.what}`).join("; ");
  const outcome = blockedOutcome(Number(iid), blockers, (b) => {
    try {
      return satisfied(b);
    } catch {
      return true; // no such ticket: nothing to wait for
    }
  });
  if (outcome === "needs-human") {
    tracker.addLabel(Number(iid), LABELS.needsHuman);
    tracker.comment(iid, [
      `## Sandcastle: blocked`,
      `The implementer couldn't do this ticket, and the blocker isn't one Sandcastle can wait for (no open ticket provides it, or that ticket is already merged or closed). Labelled \`${LABELS.needsHuman}\`.`,
      ...blockers.map((b) => `- ${b.iid != null ? `#${b.iid}` : "No ticket"}: ${b.what}. ${b.evidence}`),
      SANDCASTLE_MARK,
    ].join("\n\n"));
    fail(`Blocked (${what}); labelled ${LABELS.needsHuman}.`);
  }
  patchManifest(PROJECT, Number(iid), { implementerBlockers: blockers });
  // Remove the empty branch so the dispatcher can relaunch the ticket once the blocker merges.
  try {
    sh("git", ["branch", "-D", branch]);
  } catch {
    fail(`Blocked (${what}), but branch ${branch} could not be deleted (worktree left behind?). Delete it to let the ticket run again.`);
  }
  finished = true;
  setStage(iid, { stage: "waiting", note: `implementer: needs ${what}` });
  console.log(`#${iid} waits on ${what}. The dispatcher relaunches it once that is merged.`);
  process.exit(0);
}

// ---- 3. post evidence to the ticket (host-side) -----------------------------------
setStage(iid, { stage: "posting" });
// Ticket edited since the run started? Still finish (you review every MR), but say so.
const endVersion = ticketHash();
let staleNote = "";
if (endVersion.hash !== startVersion.hash) {
  const dir = mkdtempSync(resolve(tmpdir(), "sandcastle-"));
  writeFileSync(resolve(dir, "built-from"), `${startVersion.description}\n`);
  writeFileSync(resolve(dir, "current"), `${endVersion.description}\n`);
  const diff = spawnSync("git", ["diff", "--no-index", "--no-color", "built-from", "current"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  rmSync(dir, { recursive: true, force: true });
  staleNote = [
    "**Built from an older version of the ticket.** It was edited while this run was in progress, so check the change against the current text.",
    diff ? `Description changes:\n\n\`\`\`diff\n${diff}\n\`\`\`` : "The description is unchanged; the title or comments changed.",
  ].join("\n\n");
  setStage(iid, { note: "built from an older ticket version" });
}
const verdictFile = resolve(evidenceHost, "verdict.md");
if (!existsSync(verdictFile)) fail(`Verifier wrote no verdict.md in ${evidenceHost}. Nothing posted or pushed.`);
const verdictText = readFileSync(verdictFile, "utf8").trim();
const verdict = /^VERDICT:\s*(PASS|FAIL|INCONCLUSIVE)/.exec(verdictText)?.[1] ?? "INCONCLUSIVE";

const files = readdirSync(evidenceHost).sort();
const media = (label: string) => files.filter((f) => (f.startsWith(`${label}-`) && f.endsWith(".png")) || f === `${label}.webm`);
const shown = [...media("before"), ...media("after")];
const uploaded = new Map(tracker.uploadEvidence(iid, tip, shown.map((f) => resolve(evidenceHost, f))).map((md, i) => [shown[i], md]));
const section = (label: string, title: string) => {
  const items = media(label).map((f) => `**${f}**\n\n${uploaded.get(f)}`);
  return items.length ? `### ${title}\n\n${items.join("\n\n")}` : "";
};
const body = [
  `## Sandcastle verification: ${verdict}`,
  `Branch \`${branch}\` @ \`${tip.slice(0, 8)}\` (from \`${base}\` @ \`${baseSha.slice(0, 8)}\`). Synthetic data.`,
  verdictText.replace(/^VERDICT:.*\n?/, ""),
  section("before", "Before"),
  section("after", "After"),
  SANDCASTLE_MARK,
].filter(Boolean).join("\n\n");
tracker.comment(iid, body);
console.log(`Evidence posted to #${iid} (verdict ${verdict}).`);
setStage(iid, { verdict });

if (verdict !== "PASS") fail(`Verdict ${verdict}: branch ${branch} kept locally, not pushed. Review the ticket comment.`);
if (opts["no-push"]) {
  finished = true;
  setStage(iid, { stage: "done", note: "--no-push: branch ready locally" });
  console.log(`--no-push: stopping. Branch ${branch} is ready locally.`);
  process.exit(0);
}

// ---- 4. push, then deliver: MR (GitLab), or PR merged once CI passes (GitHub + MERGE.auto) ----
setStage(iid, { stage: "pushing" });
sh("git", ["push", "-u", "origin", branch]);
const sha = sh("git", ["rev-parse", branch]);

// Exact conflicts with the other live Sandcastle branches, so you know which MR to merge first.
const openMrs = tracker.openMrBranches();
const conflicts = readRuns()
  .filter((r) => r.project === PROJECT && r.iid !== iid && r.branch)
  .filter((r) => (!TERMINAL.includes(r.stage) && !PARKED.includes(r.stage)) || (r.stage === "done" && openMrs.has(r.branch!)))
  .filter((r) => spawnSync("git", ["rev-parse", "--verify", "--quiet", r.branch!]).status === 0)
  .flatMap((r) => {
    const res = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", branch, r.branch!], { encoding: "utf8" });
    if (res.status !== 1) return [];
    const files = [...new Set(res.stdout.trim().split("\n").slice(1).filter(Boolean))];
    return [`- #${r.iid} (\`${r.branch}\`${r.mr ? `, ${r.mr}` : ""}): ${files.map((f) => `\`${f}\``).join(", ")}`];
  });

const description = (ciNote: string) => [
  parentIid === undefined ? `Refs #${iid}` : `Refs #${iid} (Task of #${parentIid})`,
  `Implemented and verified by Sandcastle. Verdict: **${verdict}** (evidence in the ticket comment).`,
  ciNote,
  staleNote,
  conflicts.length ? `**Conflicts with other open Sandcastle work.** Merge one, then rebase the other:\n\n${conflicts.join("\n")}` : "",
].filter(Boolean).join("\n\n");
let delivered: tracker.Delivered;
try {
  delivered = await tracker.deliver({
    branch, base, sha, title: `#${iid}: ${issue.title}`, body: description, onStage: (stage) => setStage(iid!, { stage }),
    waitMinutes: CONFIG.ciWaitMinutes, noCiMinutes: CONFIG.noPipelineMinutes, autoMerge: MERGE.auto,
  });
} catch (e) {
  fail((e as Error).message);
}
finished = true;
setStage(iid, { stage: "done", mr: delivered.url, note: delivered.merged ? "merged after CI passed" : "" });
const next = parentIid === undefined ? `moves #${iid} to ${LABELS.done}` : `closes Task #${iid}`;
console.log(delivered.merged ? `Merged after CI passed. The next dispatcher pass ${next}.` : `Not merged. Once you merge it, the dispatcher ${next}.`);
