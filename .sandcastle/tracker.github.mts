import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ciGate } from "./ci.mts";
import type { Gate } from "./ci.mts";
import { LABELS, MERGE, TRACKER } from "./config.mts";
import type { Child, Note } from "./graph.mts";
import type { Delivered, Delivery, ReadyTicket, Select, Ticket } from "./tracker.mts";

// GitHub adapter for tracker.mts, via `gh` on the host (TRACKER.kind "github", TRACKER.project
// "owner/repo"). Units of work can be sub-issues. Evidence images can't be uploaded to an issue
// through the API, so they are committed to the `sandcastle-evidence` branch and linked from there.
// Delivery: open a PR, and with MERGE.auto merge it only when ciGate (ci.mts) says "pass" for the
// pushed commit. Failed or missing CI leaves the PR open as a draft and the run stopped.

const REPO = TRACKER.project;
const HOST = (TRACKER as { host?: string }).host ?? "github.com";
const [OWNER, NAME] = REPO.split("/");
const EVIDENCE_BRANCH = "sandcastle-evidence";

function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }).trim();
}
const json = <T,>(args: string[]): T => JSON.parse(gh(args));
const git = (args: string[], env?: NodeJS.ProcessEnv) => execFileSync("git", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] }).trim();

type GhIssue = { number: number; title: string; body: string; state: string; labels?: { name: string }[]; assignees?: { login: string }[] };
const slim = (i: GhIssue): Ticket => ({ iid: i.number, title: i.title, description: i.body ?? "", state: i.state.toLowerCase(), labels: (i.labels ?? []).map((l) => l.name) });
const FIELDS = "number,title,body,state,labels";

export const ticketUrl = (iid: number | string) => `https://${HOST}/${REPO}/issues/${iid}`;

/** Open issues the graph can name as blockers: the milestone's, or the whole repo's when none is set. */
export function catalogue(milestone = TRACKER.milestone): Ticket[] {
  return json<GhIssue[]>(["issue", "list", "-R", REPO, "--state", "open", "--limit", "1000", "--json", FIELDS, ...(milestone ? ["--milestone", milestone] : [])]).map(slim);
}

/** GraphQL; a missing issue (NOT_FOUND, e.g. a PR number) comes back as null rather than an error. */
function gql<T>(query: string): T {
  const res = spawnSync("gh", ["api", "graphql", "-f", `query=${query}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let out: { data?: T; errors?: { type?: string; message: string }[] };
  try {
    out = JSON.parse(res.stdout);
  } catch {
    throw new Error(`GitHub GraphQL failed: ${(res.stderr || res.stdout).slice(0, 500)}`);
  }
  const errors = (out.errors ?? []).filter((e) => e.type !== "NOT_FOUND");
  if (errors.length || !out.data) throw new Error(`GitHub GraphQL: ${errors.map((e) => e.message).join("; ") || res.stderr}`);
  return out.data;
}
/** One GraphQL query per 50 issues, each issue under an alias. */
function issuesQuery<T>(iids: number[], fields: string): Map<number, T> {
  const out = new Map<number, T>();
  for (let i = 0; i < iids.length; i += 50) {
    const chunk = iids.slice(i, i + 50);
    const data = gql<{ repository: Record<string, T | null> }>(
      `{ repository(owner: ${JSON.stringify(OWNER)}, name: ${JSON.stringify(NAME)}) { ${chunk.map((n) => `i${n}: issue(number: ${n}) { ${fields} }`).join(" ")} } }`,
    );
    for (const n of chunk) {
      const v = data.repository[`i${n}`];
      if (v) out.set(n, v);
    }
  }
  return out;
}

type Hierarchy = { parent: { number: number } | null; subIssues: { nodes: { number: number; state: string }[] } };
const HIERARCHY = "parent { number } subIssues(first: 100) { nodes { number state } }";

/** Each issue's sub-issues, in order. Issues without any are left out. */
export function children(iids: number[]): Map<number, Child[]> {
  const map = new Map<number, Child[]>();
  for (const [n, h] of issuesQuery<Hierarchy>(iids, HIERARCHY)) {
    if (h.subIssues.nodes.length) map.set(n, h.subIssues.nodes.map((k) => ({ iid: k.number, open: k.state === "OPEN" })));
  }
  return map;
}

/** The issue a sub-issue belongs to; undefined for a top-level issue. */
export function parentOf(iid: number): number | undefined {
  return issuesQuery<Hierarchy>([iid], HIERARCHY).get(iid)?.parent?.number;
}

/** Open issues by number, whatever their milestone. */
function openTickets(iids: number[]): Ticket[] {
  type Q = { number: number; title: string; body: string; state: string; labels: { nodes: { name: string }[] } };
  return [...issuesQuery<Q>(iids, "number title body state labels(first: 50) { nodes { name } }").values()]
    .filter((q) => q.state === "OPEN")
    .map((q) => slim({ ...q, labels: q.labels.nodes }));
}

/** Same contract as the GitLab adapter: issues with sub-issues are replaced by their open sub-issues. */
export function workCatalogue(subtasks: boolean): { tickets: Ticket[]; childrenOf: Map<number, Child[]> } {
  const open = catalogue();
  if (!subtasks) return { tickets: open, childrenOf: new Map() };
  const childrenOf = children(open.map((t) => t.iid));
  const byIid = new Map(open.map((t) => [t.iid, t]));
  const missing = [...childrenOf.values()].flat().filter((k) => k.open && !byIid.has(k.iid)).map((k) => k.iid);
  for (const t of openTickets(missing)) byIid.set(t.iid, t);
  for (const [p, kids] of childrenOf) {
    const parent = byIid.get(p)!;
    for (const k of kids) {
      const t = byIid.get(k.iid);
      if (t) t.parent = { iid: parent.iid, title: parent.title, description: parent.description };
    }
    byIid.delete(p);
  }
  return { tickets: [...byIid.values()], childrenOf };
}

export function ticket(iid: number): Ticket {
  return slim(json<GhIssue>(["issue", "view", String(iid), "-R", REPO, "--json", FIELDS]));
}

export function viewText(iid: number): string {
  return gh(["issue", "view", String(iid), "-R", REPO, "--comments"]);
}

/** Comments, oldest first. */
export function notes(iid: number): Note[] {
  const pages = json<{ body: string }[][]>(["api", "--paginate", "--slurp", `repos/${REPO}/issues/${iid}/comments?per_page=100`]);
  return pages.flat().map((c) => ({ body: c.body ?? "", system: false }));
}

const ORDER: Record<string, string> = { created_at: "created", updated_at: "updated", popularity: "comments" };

/** Open issues carrying every ready label and no exclude label, filtered by `select`. */
export function readyList(select: Select = {}): ReadyTicket[] {
  const search = [
    ...LABELS.exclude.map((l) => `-label:${JSON.stringify(l)}`),
    `sort:${ORDER[select.order ?? ""] ?? "created"}-${select.sort === "desc" ? "desc" : "asc"}`,
    select.search ?? "",
  ].filter(Boolean).join(" ");
  const args = ["issue", "list", "-R", REPO, "--state", "open", "--limit", "1000", "--json", `${FIELDS},assignees`, "--search", search];
  for (const l of LABELS.ready) args.push("--label", l);
  if (TRACKER.milestone) args.push("--milestone", TRACKER.milestone);
  if (select.assignee) args.push("--assignee", select.assignee);
  if (select.author) args.push("--author", select.author);
  return json<GhIssue[]>(args).map((i) => ({ ...slim(i), assignees: (i.assignees ?? []).map((a) => ({ username: a.login })) }));
}

export function comment(iid: number | string, body: string): void {
  gh(["issue", "comment", String(iid), "-R", REPO, "--body-file", "-"], body);
}

/**
 * Commit the files to `<iid>/<tip>/` on the evidence branch (without touching any checkout) and
 * return markdown linking each one: images inline, anything else as a link. Retries when a
 * concurrent run pushed first.
 */
export function uploadEvidence(iid: string, tip: string, files: string[]): string[] {
  const dir = `${iid}/${tip.slice(0, 8)}`;
  const tmp = mkdtempSync(resolve(tmpdir(), "sandcastle-evidence-"));
  const env = { ...process.env, GIT_INDEX_FILE: resolve(tmp, "index") };
  try {
    for (let attempt = 1; ; attempt++) {
      let parent = "";
      if (spawnSync("git", ["fetch", "--quiet", "origin", `+refs/heads/${EVIDENCE_BRANCH}:refs/sandcastle/evidence`]).status === 0) {
        parent = git(["rev-parse", "refs/sandcastle/evidence"]);
      }
      git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);
      for (const f of files) git(["update-index", "--add", "--cacheinfo", `100644,${git(["hash-object", "-w", f])},${dir}/${basename(f)}`], env);
      const tree = git(["write-tree"], env);
      const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `Evidence for #${iid} at ${tip.slice(0, 8)}`]);
      if (spawnSync("git", ["push", "--quiet", "origin", `${commit}:refs/heads/${EVIDENCE_BRANCH}`], { stdio: "inherit" }).status === 0) {
        return files.map((f) => {
          const name = basename(f);
          const url = `https://${HOST}/${REPO}/blob/${commit}/${dir}/${name}`;
          return name.endsWith(".png") ? `![${name}](${url}?raw=true)` : `[${name}](${url})`;
        });
      }
      if (attempt === 3) throw new Error(`Couldn't push evidence to ${EVIDENCE_BRANCH} after 3 tries.`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Source branches of every open PR. */
export function openMrBranches(): Set<string> {
  return new Set(json<{ headRefName: string }[]>(["pr", "list", "-R", REPO, "--state", "open", "--limit", "1000", "--json", "headRefName"]).map((p) => p.headRefName));
}

export function mergedInto(branch: string, base: string): boolean {
  return json<unknown[]>(["pr", "list", "-R", REPO, "--state", "merged", "--head", branch, "--base", base, "--limit", "1", "--json", "number"]).length > 0;
}

const addLabels = (iid: number, labels: string[]) =>
  gh(["api", "-X", "POST", `repos/${REPO}/issues/${iid}/labels`, ...labels.flatMap((l) => ["-f", `labels[]=${l}`])]);

export function addLabel(iid: number, label: string): void {
  addLabels(iid, [label]);
}

export function close(iid: number): void {
  gh(["issue", "close", String(iid), "-R", REPO, "--reason", "completed"]);
}

/** Move a ticket to the next stage: `LABELS.done` on, the ready labels off. It stays open. */
export function advance(iid: number): void {
  addLabels(iid, [LABELS.done]);
  for (const l of LABELS.ready) {
    spawnSync("gh", ["api", "-X", "DELETE", `repos/${REPO}/issues/${iid}/labels/${encodeURIComponent(l)}`], { stdio: "ignore" }); // 404 if absent: fine
  }
}

/** Check every label exists in the repo; offer to create missing ones from a terminal, else exit. */
export async function ensureLabels(names: string[]): Promise<void> {
  const have = new Set(json<{ name: string }[]>(["label", "list", "-R", REPO, "--limit", "1000", "--json", "name"]).map((l) => l.name));
  const missing = names.filter((n) => !have.has(n));
  if (!missing.length) return;
  const list = missing.map((m) => `"${m}"`).join(", ");
  if (!process.stdin.isTTY) {
    console.error(`Missing label(s) in ${REPO}: ${list}. Run this once from a terminal to create them, or change LABELS in config.mts.`);
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (const name of missing) {
    const answer = (await rl.question(`Label "${name}" doesn't exist in ${REPO}. Create it? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      rl.close();
      console.error(`Not creating "${name}". Sandcastle needs it; quitting.`);
      process.exit(1);
    }
    gh(["label", "create", name, "-R", REPO]);
    console.log(`Created label "${name}".`);
  }
  rl.close();
}

/** Checks on the PR's head right now. `gh pr checks` exits non-zero while pending or when there are none. */
function checks(pr: string): { name: string; bucket: string }[] {
  const res = spawnSync("gh", ["pr", "checks", pr, "--json", "name,bucket"], { encoding: "utf8" });
  try {
    return JSON.parse(res.stdout);
  } catch {
    return []; // "no checks reported"
  }
}

/**
 * Open a PR into the base. Without `autoMerge`, stop there (you merge it). With it, poll the checks
 * until ciGate decides: "pass" merges (only while the head is still the pushed commit); "fail", no
 * checks within `noCiMinutes`, or still pending at `waitMinutes` turns the PR into a draft and throws.
 */
export async function deliver(d: Delivery & { waitMinutes: number; noCiMinutes: number; autoMerge: boolean }): Promise<Delivered> {
  const note = d.autoMerge
    ? "Sandcastle merges this PR once every CI check on this commit has passed. It is never merged without CI."
    : "CI runs on this PR.";
  const url = gh(["pr", "create", "-R", REPO, "--base", d.base, "--head", d.branch, "--title", d.title, "--body-file", "-"], d.body(note)).split(/\s+/).find((w) => w.startsWith("http")) ?? "";
  console.log(url);
  if (!d.autoMerge) return { url, merged: false };

  d.onStage("ci");
  let gate: Gate = "none";
  const deadline = Date.now() + d.waitMinutes * 60_000;
  const noChecksBy = Date.now() + d.noCiMinutes * 60_000;
  while (Date.now() < deadline) {
    gate = ciGate(checks(url));
    if (gate === "pass" || gate === "fail") break;
    if (gate === "none" && Date.now() > noChecksBy) break;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (gate !== "pass") {
    const why = { fail: "CI failed", none: `no CI checks ran within ${d.noCiMinutes} min`, pending: `CI still running after ${d.waitMinutes} min` }[gate];
    spawnSync("gh", ["pr", "ready", url, "--undo"], { stdio: "ignore" });
    spawnSync("gh", ["pr", "comment", url, "--body", `Sandcastle did not merge this PR: ${why}. Marked as a draft.`], { stdio: "ignore" });
    throw new Error(`Not merged: ${why} on ${d.branch}. PR left open as a draft: ${url}`);
  }
  gh(["pr", "merge", url, `--${MERGE.method}`, "--match-head-commit", d.sha]);
  return { url, merged: true };
}
