import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { LABELS, TRACKER } from "./config.mts";
import type { Child, Note } from "./graph.mts";
import type { Delivered, Delivery, ReadyTicket, Select, Ticket } from "./tracker.mts";

// GitLab adapter for tracker.mts, via `glab` on the host. Units of work can be GitLab Tasks (the
// "Child items" on an issue). Delivery: wait for the branch pipeline, then open an MR. Never merges.

// Cast: the shipped config.personal.mts (GitHub) has no GitLab fields, and this module still loads there.
const { gitlabHost: HOST = "", projectId: ID = 0 } = TRACKER as { gitlabHost?: string; projectId?: number };
const enc = encodeURIComponent;

function glab(args: string[], input?: string): string {
  return execFileSync("glab", args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }).trim();
}

export const ticketUrl = (iid: number | string) => `https://${HOST}/${TRACKER.project}/-/issues/${iid}`;
const api = <T,>(path: string): T => JSON.parse(glab(["api", path, "--hostname", HOST]));
/** GET every page of a list endpoint (100 per page). */
function apiAll<T>(path: string): T[] {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const batch = api<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

/** Open tickets the graph can name as blockers: the milestone's, or the whole project's when none is set. */
export function catalogue(milestone = TRACKER.milestone): Ticket[] {
  const filter = milestone ? `&milestone=${enc(milestone)}` : "";
  return apiAll<Ticket>(`projects/${ID}/issues?state=opened${filter}`).map(slim);
}
const slim = (t: Ticket): Ticket => ({ iid: t.iid, title: t.title, description: t.description ?? "", state: t.state, labels: t.labels ?? [] });

/** Open tickets by iid, whatever their milestone. */
function openTickets(iids: number[]): Ticket[] {
  const out: Ticket[] = [];
  for (let i = 0; i < iids.length; i += 50) {
    const q = iids.slice(i, i + 50).map((n) => `iids[]=${n}`).join("&");
    out.push(...apiAll<Ticket>(`projects/${ID}/issues?state=opened&${q}`).map(slim));
  }
  return out;
}

function gql<T>(query: string): T {
  const out = JSON.parse(glab(["api", "graphql", "--hostname", HOST, "-f", `query=${query}`]));
  if (out.errors?.length) throw new Error(`GitLab GraphQL: ${out.errors.map((e: { message: string }) => e.message).join("; ")}`);
  return out.data;
}
type Hierarchy = { iid: string; workItemType: { name: string }; widgets: { parent?: { iid: string } | null; children?: { nodes: { iid: string; state: string; workItemType: { name: string } }[] } }[] };
function hierarchy(iids: number[]): Hierarchy[] {
  const out: Hierarchy[] = [];
  for (let i = 0; i < iids.length; i += 50) {
    const list = iids.slice(i, i + 50).map((n) => JSON.stringify(String(n))).join(",");
    const data = gql<{ project: { workItems: { nodes: Hierarchy[] } } }>(
      `{ project(fullPath: ${JSON.stringify(TRACKER.project)}) { workItems(iids: [${list}], first: 50) { nodes { iid workItemType { name } widgets { ... on WorkItemWidgetHierarchy { parent { iid } children(first: 100) { nodes { iid state workItemType { name } } } } } } } } }`,
    );
    out.push(...data.project.workItems.nodes);
  }
  return out;
}

/** Each issue's Tasks, in board order. Issues without Tasks are left out. */
export function children(iids: number[]): Map<number, Child[]> {
  const map = new Map<number, Child[]>();
  for (const w of hierarchy(iids)) {
    const kids = w.widgets.flatMap((x) => x.children?.nodes ?? []).filter((k) => k.workItemType.name === "Task");
    if (kids.length) map.set(Number(w.iid), kids.map((k) => ({ iid: Number(k.iid), open: k.state === "OPEN" })));
  }
  return map;
}

/** The issue a Task belongs to; undefined for anything that isn't a Task with a parent. */
export function parentOf(iid: number): number | undefined {
  const w = hierarchy([iid])[0];
  if (w?.workItemType.name !== "Task") return undefined;
  const p = w.widgets.find((x) => x.parent)?.parent;
  return p ? Number(p.iid) : undefined;
}

/**
 * The tickets the graph and the implementer see. With subtasks, issues that have Tasks are replaced
 * by their open Tasks (which may sit outside the milestone), each carrying its parent's text.
 */
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
  const t = api<Ticket>(`projects/${ID}/issues/${iid}`);
  return { iid: t.iid, title: t.title, description: t.description ?? "", state: t.state, labels: t.labels ?? [] };
}

/** The ticket with its comments, as text for the agents' prompts. */
export function viewText(iid: number): string {
  return glab(["issue", "view", String(iid), "-R", TRACKER.project, "--comments"]);
}

/** Open tickets carrying every ready label and no exclude label, filtered by `select`. */
export function readyList(select: Select = {}): ReadyTicket[] {
  const args = ["issue", "list", "-R", TRACKER.project, "--per-page", "100", "--output", "json"];
  if (select.order) args.push("--order", select.order);
  if (select.sort) args.push("--sort", select.sort);
  if (LABELS.ready.length) args.push("--label", LABELS.ready.join(","));
  if (LABELS.exclude.length) args.push("--not-label", LABELS.exclude.join(","));
  if (TRACKER.milestone) args.push("--milestone", TRACKER.milestone);
  if (select.assignee) args.push("--assignee", select.assignee);
  if (select.author) args.push("--author", select.author);
  if (select.issueType) args.push("--issue-type", select.issueType);
  if (select.confidential) args.push("--confidential");
  if (select.search) args.push("--search", select.search);
  return JSON.parse(glab(args));
}

export function comment(iid: number | string, body: string): void {
  glab(["issue", "note", String(iid), "-R", TRACKER.project, "-m", body]);
}

/** Upload evidence files; returns the markdown for each, in order. */
export function uploadEvidence(_iid: string, _tip: string, files: string[]): string[] {
  return files.map((f) => String(JSON.parse(glab(["api", `projects/${ID}/uploads`, "--hostname", HOST, "--form", `file=@${f}`])).markdown));
}

/**
 * Wait for the branch pipeline on the pushed tip, then open an MR into the base. A failed pipeline,
 * or one still running at the deadline, throws (pushed, no MR). If no pipeline appears within
 * `noCiMinutes`, the MR opens anyway and CI runs on it. Never merges.
 */
export async function deliver(d: Delivery & { waitMinutes: number; noCiMinutes: number; autoMerge: boolean }): Promise<Delivered> {
  if (d.autoMerge) throw new Error("MERGE.auto is only supported with TRACKER.kind \"github\".");
  d.onStage("ci");
  let status = "none";
  const deadline = Date.now() + d.waitMinutes * 60_000;
  const noPipelineBy = Date.now() + d.noCiMinutes * 60_000;
  while (Date.now() < deadline) {
    status = api<{ status: string }[]>(`projects/${ID}/pipelines?sha=${d.sha}&per_page=1`)[0]?.status ?? "none";
    if (["success", "failed", "canceled", "skipped"].includes(status)) break;
    if (status === "none" && Date.now() > noPipelineBy) break;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (status === "failed" || status === "canceled") throw new Error(`CI ${status} on ${d.branch}. Pushed, but no MR opened.`);
  if (!["success", "none", "skipped"].includes(status)) throw new Error(`CI still ${status} after ${d.waitMinutes} min on ${d.branch}. Pushed, no MR opened.`);
  const out = glab([
    "mr", "create", "-R", TRACKER.project, "--source-branch", d.branch, "--target-branch", d.base, "--title", d.title,
    "--description", d.body(status === "success" ? "Branch CI passed before this MR was opened." : "No branch pipeline appeared; CI will run on this MR."),
    "--yes", "--no-editor",
  ]);
  console.log(out);
  return { url: out.split(/\s+/).find((w) => w.startsWith("http")) ?? "", merged: false };
}

/** Comments, oldest first. */
export function notes(iid: number): Note[] {
  return apiAll<Note>(`projects/${ID}/issues/${iid}/notes?sort=asc&order_by=created_at`).map((n) => ({ body: n.body, system: n.system }));
}

/** Source branches of every open MR in the project. */
export function openMrBranches(): Set<string> {
  return new Set(apiAll<{ source_branch: string }>(`projects/${ID}/merge_requests?state=opened`).map((m) => m.source_branch));
}

export function mergedInto(branch: string, base: string): boolean {
  return api<unknown[]>(`projects/${ID}/merge_requests?state=merged&source_branch=${enc(branch)}&target_branch=${enc(base)}&per_page=1`).length > 0;
}

export function addLabel(iid: number, label: string): void {
  glab(["issue", "update", String(iid), "-R", TRACKER.project, "--label", label]);
}

// REST rather than `glab issue`, which may not accept Tasks.
const put = (iid: number, fields: Record<string, string>) =>
  glab(["api", "-X", "PUT", `projects/${ID}/issues/${iid}`, "--hostname", HOST, ...Object.entries(fields).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);

export function close(iid: number): void {
  put(iid, { state_event: "close" });
}

/** Move a ticket to the next stage: `LABELS.done` on, the ready labels off. It stays open. */
export function advance(iid: number): void {
  put(iid, { add_labels: LABELS.done, remove_labels: LABELS.ready.join(",") });
}

/**
 * Check every label exists in the project (group labels count). Offer to create missing ones when a
 * person is at the terminal; without one, or if they decline, exit.
 */
export async function ensureLabels(names: string[]): Promise<void> {
  const have = new Set(apiAll<{ name: string }>(`projects/${ID}/labels?include_ancestor_groups=true`).map((l) => l.name));
  const missing = names.filter((n) => !have.has(n));
  if (!missing.length) return;
  const list = missing.map((m) => `"${m}"`).join(", ");
  if (!process.stdin.isTTY) {
    console.error(`Missing label(s) in ${TRACKER.project}: ${list}. Run this once from a terminal to create them, or change LABELS in config.mts.`);
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (const name of missing) {
    const answer = (await rl.question(`Label "${name}" doesn't exist in ${TRACKER.project}. Create it? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      rl.close();
      console.error(`Not creating "${name}". Sandcastle needs it; quitting.`);
      process.exit(1);
    }
    glab(["label", "create", "--name", name, "-R", TRACKER.project]);
    console.log(`Created label "${name}".`);
  }
  rl.close();
}
