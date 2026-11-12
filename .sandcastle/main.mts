import { createSandbox, claudeCode, pi } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { adoptClaim, keyFor, PARKED, readRuns, setProject, setStage, stateDir, TERMINAL } from "./board.mts";
import { readAdmission } from "./admission.mts";
import { fillReceipt, recordIntent } from "./ownership.mts";
import { parentText } from "./analyze.mts";
import { AGENT, allLabels, GRAPH, LABELS, MERGE, SUBTASKS, TRACKER } from "./config.mts";
import { disallowedModels, piEnvFor, ticketModel } from "./models.mts";
import { blockedOutcome, expandUnits, SANDCASTLE_MARK, unitHash } from "./graph.mts";
import type { ImplementerBlocker } from "./graph.mts";
import { patchManifest, readManifest } from "./manifests.mts";
import { postAndDeliver, prerequisiteHold, runVerifier } from "./handoff.mts";
import type { Host } from "./handoff.mts";
import { ownedContainerGone, readAttemptRecord, realClock, realDocker, REPAIR_DEADLINE_MS, REPAIR_MINUTES, runRecoveryAttempt } from "./recovery.mts";
import { createOwnedSandbox, gitWorkspace, readDotEnv, realProc } from "./recovery-sandbox.mts";
import * as tracker from "./tracker.mts";

// End-to-end loop for one ticket (run from the repo root):
//   npx tsx .sandcastle/main.mts --base sal-develop [--issue 695] [--no-push]
// 1. branch <iid>-<slug> off origin/<base>   2. implementer run   3. verifier run (screenshots/video + verdict)
// 4. host posts the evidence to the ticket   5. on PASS: push and deliver (tracker adapter).
//    Steps 3-5 live in handoff.mts, shared with recovery runs so a repaired branch is verified and delivered the same way:
//    GitLab: wait for the branch pipeline, open an MR into <base>; never merges.
//    GitHub: open a PR into <base>; with MERGE.auto, merge it once every CI check passes (ci.mts).
// Never closes the ticket (the dispatcher closes a Task/sub-issue, or moves a ticket on, once its work
// merges). Every tracker call runs on the host with your glab/gh login; the container has no tracker token.
// The agent (Claude Code or Pi) comes from AGENT in config.mts. The implementer's model is AGENT.model, or
// with AGENT.modelLabels the one the ticket's model label names (models.mts); the verifier always uses AGENT.model.
//
// Recovery mode (slice four, #60/#74): `main.mts --issue <n> --base <b> --recover <seq> --attempt-record <file>` is
// started only by Factory's recovery launcher (cli/src/recovery-run.mts) after it claimed the ticket and wrote the
// host-owned attempt record. Before any Git or container side effect it checks the record, the claimed run record and
// the arguments name the same project, ticket, branch, base and attempt (seq and UUID), and that the worktree is inside
// .sandcastle/worktrees/. It then runs recovery.mts runRecoveryAttempt with the real boundaries: recovery-sandbox.mts's
// owned container (exact pre-recorded name, private Git metadata, this attempt's evidence only writable; not
// Sandcastle's createSandbox), the repair agent on AGENT.model whatever the ticket's model label, a 900000 ms deadline
// from container readiness, the shared verifier and delivery (handoff.mts), and a recheck of the ticket's requirements,
// state, needs-human label, prerequisite holds (handoff.mts prerequisiteHold over the dispatcher's analysis; unknown
// holds) and claim before verifying and before delivering. SIGTERM/SIGINT cancel the attempt (exit 143). The record
// ends `done` (delivered) or `stopped` with the reason; the recovery claim in the admission record (admission.mts, #75)
// is never released here, even with the container's removal unconfirmed: the launcher's settle step releases it once
// the exact container is confirmed gone. It never creates or deletes a branch, labels the ticket or closes it.
// Claims and receipts (#75): a dispatched run adopts the launch claim its record carries (board.mts adoptClaim), so its
// board writes, heartbeat and exit handler are fenced by the claim token, and refuses to start if the claim was
// superseded. Before Sandcastle creates the branch and worktree it writes the ticket's ownership receipt
// (ownership.mts) and fills in the branch's commit once they exist. The normal path keeps its branch-exists protection.

// ---- Project config: the block to edit when adapting this to another project ----------
// Tracker, agent, merge policy, milestone and labels live in config.mts. (Also adapt sandbox/bootstrap-site.sh, the
// Environment section of prompt.md, and the fixture advice in prompt.verify.md. See ADAPTING.md.)
const CONFIG = {
  image: "sandcastle-islandhealth", // factory:image - `factory init --image` replaces the value
  ciWaitMinutes: 30, // give up waiting for CI after this long
  // No CI seen in this time: GitLab opens the MR anyway; with MERGE.auto the PR is not merged.
  noPipelineMinutes: 5,
  // Runs in order inside the container once it is up; the working directory is the worktree.
  // factory:sandbox-setup:start - `factory init` replaces everything up to the :end tag with an empty list
  sandboxSetup: [
    { command: "cd /home/agent/workspace && composer install --no-interaction --prefer-dist", timeoutMs: 20 * 60_000 },
    { command: "start-web.sh /home/agent/workspace/web", sudo: true },
    { command: "/opt/sandcastle/bootstrap-site.sh", timeoutMs: 10 * 60_000 },
  ],
  // factory:sandbox-setup:end
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
// The host side of the hand-off (handoff.mts): board, git and tracker.
const host: Host = {
  setStage, readRuns,
  live: (r, openMrs) => (!TERMINAL.includes(r.stage) && !PARKED.includes(r.stage)) || (r.stage === "done" && openMrs.has(r.branch!)),
  git: (args) => sh("git", args),
  gitStatus: (args) => {
    const res = spawnSync("git", args, { encoding: "utf8" });
    return { status: res.status, stdout: res.stdout ?? "" };
  },
  tracker,
};

const { values: opts } = parseArgs({
  options: {
    base: { type: "string" },
    issue: { type: "string" },
    "no-push": { type: "boolean", default: false },
    "whole-issues": { type: "boolean", default: false }, // without --issue: pick a ready issue, not one of its Tasks
    recover: { type: "string" }, // recovery attempt number; started by Factory's recovery launcher only
    "attempt-record": { type: "string" }, // the launcher's host-owned record of that attempt
  },
});
if (!opts.base) fail("--base <integration branch> is required (e.g. sal-develop, or sal-redesign for #565 children)");
const recovering = opts.recover !== undefined;
if (recovering) {
  if (!/^[1-9]\d*$/.test(opts.recover!) || !opts.issue || !opts["attempt-record"]) fail("--recover <attempt> needs a positive attempt number, --issue and --attempt-record.");
  if (opts["no-push"]) fail("--recover always delivers normally; --no-push is not allowed with it.");
}
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
if ("error" in picked && !recovering) fail(`#${iid} ${picked.error}. Not started.`);
const implementerModel = "error" in picked ? AGENT.model : picked.model; // recovery never uses it
const ticket = [tracker.viewText(Number(iid)), parentText(startTicket)].filter(Boolean).join("\n\n");
// The version of the ticket this run builds from; compared again before the MR opens.
const ticketHash = (t = withParent(tracker.ticket(Number(iid)))) => ({ hash: unitHash(t, tracker.notes(Number(iid))), description: t.description });
const startVersion = ticketHash(startTicket);
const catalogue = work.tickets.filter((t) => String(t.iid) !== iid);
const slug = String(issue.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
// ---- recovery mode: one admitted repair attempt (recovery.mts) ------------------------------------------------
if (recovering) {
  const seq = Number(opts.recover);
  const file = resolve(opts["attempt-record"]!);
  const read = readAttemptRecord(file);
  if (!read.ok) fail(`#${iid}: recovery refused: ${read.reason}`);
  const rec = read.record;
  setProject(PROJECT);
  const claimed = readRuns().find((r) => r.project === PROJECT && r.iid === iid);
  const claimOf = () => readAdmission(stateDir()).claims[keyFor(iid!, PROJECT)];
  const admitted = claimOf();
  const owned = (() => { try { const r = relative(realpathSync(".sandcastle/worktrees"), realpathSync(rec.worktree)); return !!r && !r.startsWith("..") && !r.includes("/"); } catch { return false; } })();
  if (rec.iid !== iid || rec.seq !== seq || rec.project !== PROJECT || rec.base !== base || rec.phase !== "claimed"
    || claimed?.recovery?.attempt !== seq || claimed.recovery.id !== rec.id || claimed.branch !== rec.branch || !owned
    || admitted?.kind !== "recovery" || admitted.attempt !== rec.id || admitted.token !== claimed.claim) {
    fail(`#${iid} is not claimed for recovery attempt ${seq} (${rec.id}); only Factory's recovery launcher starts --recover, once per attempt.`);
  }
  let token: string | undefined;
  try {
    token = adoptClaim(iid);
  } catch (e) {
    fail(`#${iid}: recovery refused: ${(e as Error).message}`);
  }
  sh("git", ["fetch", "origin", base]);
  const baseSha = sh("git", ["rev-parse", `origin/${base}`]);
  currentIid = iid;
  setStage(iid, { stage: "setup", note: `recovery attempt ${seq}: setting up`, base, starting: undefined });
  setInterval(() => { if (!finished) setStage(iid!, {}); }, 60_000).unref();
  console.log(`#${iid} ${issue.title}\n  recovery attempt ${seq} (${rec.id}) on ${rec.branch} at ${rec.startSha.slice(0, 8)}, repair model ${AGENT.model}`);
  const cancel = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => cancel.abort(new Error(`${sig}: recovery attempt cancelled`)));
  mkdirSync(resolve(".sandcastle/sandbox"), { recursive: true });
  const evidenceBox = `/home/agent/evidence/${iid}`;
  const recheck = () => {
    const now = withParent(tracker.ticket(Number(iid)));
    if (now.state === "closed") return `#${iid} is closed`;
    if ((now.labels ?? []).includes(LABELS.needsHuman)) return `#${iid} is labelled ${LABELS.needsHuman}`;
    if (ticketHash(now).hash !== startVersion.hash) return `#${iid}'s requirements changed since the attempt started`;
    const r = readRuns().find((x) => x.project === PROJECT && x.iid === iid);
    const c = claimOf();
    if (r?.recovery?.id !== rec.id || r.claim !== token || c?.token !== token || c.attempt !== rec.id) return `#${iid}'s claim is no longer held by this attempt`;
    // Dependency and open-PR prerequisite holds, as the dispatcher's analysis records them; unknown holds too.
    const openMrs = tracker.openMrBranches();
    const runOf = (b: number) => readRuns().find((x) => x.project === PROJECT && x.iid === String(b));
    return prerequisiteHold(Number(iid), {
      manifest: readManifest(PROJECT, Number(iid)), hash: ticketHash(now).hash,
      satisfied: (b) => {
        if (tracker.ticket(b).state === "closed") return true;
        const dep = runOf(b);
        return !!dep?.branch && tracker.mergedInto(dep.branch, dep.base ?? base);
      },
      active: (b) => {
        const dep = runOf(b);
        if (dep && !TERMINAL.includes(dep.stage) && !PARKED.includes(dep.stage)) return "a run in flight";
        return dep?.branch && openMrs.has(dep.branch) ? "an open PR" : undefined;
      },
    });
  };
  const result = await runRecoveryAttempt({
    root: process.cwd(), record: file, model: AGENT.model, title: String(issue.title), baseSha, parentIid,
    promptArgs: {
      ISSUE_IID: iid, ISSUE_TITLE: String(issue.title), TICKET: ticket, BASE_BRANCH: base, BASE_SHA: baseSha, BRANCH: rec.branch,
      EVIDENCE_DIR: evidenceBox, CATALOGUE: catalogue.map((t) => `- #${t.iid} ${t.title}`).join("\n") || "(none)",
      ATTEMPT: String(seq), ATTEMPT_ID: rec.id, REPAIR_MINUTES: String(REPAIR_MINUTES),
    },
    previousRun: claimed, logs: [resolve(".sandcastle/logs", `recover-${iid}.log`)],
    delivery: { ciWaitMinutes: CONFIG.ciWaitMinutes, noCiMinutes: CONFIG.noPipelineMinutes, autoMerge: MERGE.auto },
    cancel: cancel.signal, deadlineMs: REPAIR_DEADLINE_MS,
  }, {
    clock: realClock,
    createSandbox: (spec) => createOwnedSandbox(spec, {
      image: IMAGE, setup: CONFIG.sandboxSetup, helpers: resolve(".sandcastle/sandbox"), env: readDotEnv(resolve(".sandcastle/.env")),
      uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, proc: realProc, root: process.cwd(),
    }),
    containerGone: (name) => ownedContainerGone(name, realDocker),
    workspace: gitWorkspace,
    recheck, host,
    setStage: (patch) => setStage(iid!, patch),
    agent,
    log: (line) => console.log(line),
  });
  finished = true;
  // The recovery claim stays in the admission record either way; settleRecovery releases it once the container is confirmed gone.
  if (result.outcome !== "delivered" || result.cleanupPending) {
    setStage(iid, { stage: "stopped", note: `recovery attempt ${seq} ${result.outcome}${result.cleanupPending ? " (cleanup pending)" : ""}: ${result.reason}` });
  }
  console.log(`recovery attempt ${seq}: ${result.outcome}${result.cleanupPending ? " (cleanup pending)" : ""}: ${result.reason}`);
  process.exit(result.outcome === "delivered" && !result.cleanupPending ? 0 : result.outcome === "interrupted" ? 143 : 1);
}

const branch = `${iid}-${slug}`;

sh("git", ["fetch", "origin", base]);
const baseSha = sh("git", ["rev-parse", `origin/${base}`]);
if (sh("git", ["branch", "--list", branch]) || sh("git", ["ls-remote", "--heads", "origin", branch])) {
  fail(`Branch ${branch} already exists locally or on origin; delete it or pick another ticket.`);
}
setProject(PROJECT);
// The dispatcher's launch claim (if this run was dispatched): take it over, and fence every later board write with it.
let claimToken: string | undefined;
try {
  claimToken = adoptClaim(iid);
} catch (e) {
  fail(`#${iid} not started: ${(e as Error).message}`);
}
currentIid = iid;
setStage(iid, {
  title: String(issue.title), ticketUrl: tracker.ticketUrl(iid), branch, base, stage: "setup", startedAt: new Date().toISOString(), note: "",
  evidenceDir: resolve(".sandcastle/evidence", iid), ticketHash: startVersion.hash, verdict: undefined, mr: undefined,
  parentIid: parentIid === undefined ? undefined : String(parentIid), mergedAt: undefined,
  starting: undefined, // this run now owns the record the dispatcher reserved at launch
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

// The ownership receipt says what this run is about to create, before Sandcastle creates it (ownership.mts).
const tracked = TRACKER as { kind?: string; host?: string; gitlabHost?: string; project: string };
const receipt = recordIntent(stateDir(), {
  root: process.cwd(), tracker: { kind: tracked.kind ?? "gitlab", host: tracked.host ?? tracked.gitlabHost ?? "", project: PROJECT },
  ticket: iid, branch, base, runId: claimToken ?? randomUUID(), branchToCreate: true, worktreeToCreate: true,
});
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

try {
  fillReceipt(receipt, { branchSha: sh("git", ["rev-parse", `refs/heads/${branch}`]), worktreeAt: new Date().toISOString() });
} catch (e) {
  console.warn(`Ownership receipt ${receipt} not filled in (${(e as Error).message}); a later repair reconciles it with Git.`);
}

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

    // ---- 2. verifier (handoff.mts) -----------------------------------------------
    const refused = await runVerifier(sandbox, { setStage }, { iid, evidenceHost, agent: agent(AGENT.model), promptArgs, tip });
    if (refused) fail(refused);
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
// ---- 3-4. post evidence, then on PASS push and deliver (handoff.mts) ----------------
const outcome = await postAndDeliver({
  iid, project: PROJECT, branch, base, baseSha, tip, title: String(issue.title), evidenceHost, parentIid, origin: { kind: "implemented" },
  staleNote, noPush: opts["no-push"], ciWaitMinutes: CONFIG.ciWaitMinutes, noCiMinutes: CONFIG.noPipelineMinutes, autoMerge: MERGE.auto,
}, host);
if (!outcome.ok) fail(outcome.reason);
finished = true;
if (!outcome.pushed) {
  console.log(`--no-push: stopping. Branch ${branch} is ready locally.`);
  process.exit(0);
}
const next = parentIid === undefined ? `moves #${iid} to ${LABELS.done}` : `closes Task #${iid}`;
console.log(outcome.merged ? `Merged after CI passed. The next dispatcher pass ${next}.` : `Not merged. Once you merge it, the dispatcher ${next}.`);
