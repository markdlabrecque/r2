import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keyFor, stateDir } from "./board.mts";
import { AGENT, GRAPH } from "./config.mts";
import { contentHash, isSandcastleNote, unitHash } from "./graph.mts";
import { piAnalysisArgs } from "./models.mts";
import type { Manifest, Note, Requirement } from "./graph.mts";
import type { Ticket } from "./tracker.mts";

// Ticket analysis: one read-only agent run on the host per ticket, against a detached worktree at
// origin/<base>, with GRAPH.model. AGENT.provider "claude": `claude -p` with Read, Grep and Glob and a
// JSON schema. "pi": `pi -p` with read, grep, find and ls, no discovered extensions, skills or context files
// (the pi-claude-subscription provider is the one extension loaded, by an explicit -e), and the JSON parsed
// from its reply. Either way no shell, no writes and no MCP servers, because ticket
// text is untrusted input. Current-assessment analysis may also include previously named closed providers (#78),
// without changing the open-provider validation used by execution/admission manifests.

const here = dirname(fileURLToPath(import.meta.url));
const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

/** Detached worktree at origin/<base> (fetch first). Shared by every analysis in a pass. */
export function analysisWorktree(project: string, base: string): { path: string; sha: string } {
  const path = resolve(stateDir(), "worktrees", keyFor(base.replace(/[^A-Za-z0-9._-]+/g, "_"), project));
  const sha = git(["rev-parse", `origin/${base}`]);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    git(["worktree", "prune"]);
    git(["worktree", "add", "--detach", path, sha]);
  } else {
    git(["checkout", "--detach", "--force", sha], path);
    git(["clean", "-fdq"], path);
  }
  return { path, sha };
}

const SCHEMA = {
  type: "object",
  required: ["provides", "requires", "footprint"],
  properties: {
    provides: { type: "array", items: { type: "string" } },
    requires: {
      type: "array",
      items: {
        type: "object",
        required: ["what", "providedBy", "evidence", "confidence"],
        properties: {
          what: { type: "string" },
          providedBy: { type: ["integer", "null"] },
          evidence: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    footprint: { type: "array", items: { type: "string" } },
  },
};

const excerpt = (s: string, n = 300) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

type Analysis = { provides: string[]; requires: Requirement[]; footprint: string[] };
const spawnOpts = (cwd: string, input: string) => ({ cwd, input, encoding: "utf8" as const, timeout: GRAPH.analysisTimeoutMinutes * 60_000, maxBuffer: 64 * 1024 * 1024 });
const failed = (iid: number, res: { status: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string }) =>
  new Error(`analysis of #${iid} failed (exit ${res.status ?? res.signal}): ${(res.stderr || res.stdout || "").slice(0, 500)}`);

function runClaude(iid: number, prompt: string, cwd: string): Analysis {
  const res = spawnSync(
    "claude",
    ["-p", "--model", GRAPH.model, "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--strict-mcp-config",
      "--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA)],
    spawnOpts(cwd, prompt),
  );
  if (res.status !== 0) throw failed(iid, res);
  const out = JSON.parse(res.stdout);
  if (out.is_error || !out.structured_output) throw new Error(`analysis of #${iid} returned no result: ${String(out.result ?? "").slice(0, 500)}`);
  return out.structured_output;
}

/** pi has no schema flag: ask for bare JSON, take the outermost object from the reply, check its shape. */
function runPi(iid: number, prompt: string, cwd: string): Analysis {
  const ask = `${prompt}\n\n## Output\n\nReply with one JSON object and nothing else (no prose, no code fence), matching this JSON Schema:\n\n${JSON.stringify(SCHEMA)}\n`;
  const res = spawnSync("pi", piAnalysisArgs(GRAPH.model, process.env, existsSync), spawnOpts(cwd, ask));
  if (res.status !== 0) throw failed(iid, res);
  const text = res.stdout;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let so: Analysis | undefined;
  try {
    so = JSON.parse(text.slice(start, end + 1));
  } catch {
    /* reported below */
  }
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const ok = so && strings(so.provides) && strings(so.footprint) && Array.isArray(so.requires)
    && so.requires.every((r) => typeof r?.what === "string" && (r.providedBy === null || Number.isInteger(r.providedBy)) && typeof r.confidence === "number");
  if (!ok) throw new Error(`analysis of #${iid} returned no usable JSON: ${text.slice(0, 500)}`);
  so!.requires = so!.requires.map((r) => ({ ...r, evidence: String(r.evidence ?? "") }));
  return so!;
}

/** Ticket text as an agent sees it: description, then comments from people, then a Task's parent. */
export function ticketText(t: Ticket, notes: Note[]): string {
  const comments = notes.filter((n) => !isSandcastleNote(n)).map((n) => `> ${n.body.replace(/\n/g, "\n> ")}`);
  return [t.description || "(no description)", ...(comments.length ? ["### Comments", ...comments] : []), parentText(t)].filter(Boolean).join("\n\n");
}

/** Context for a Task: its parent issue. Empty for a whole ticket. */
export function parentText(t: Ticket): string {
  if (!t.parent) return "";
  return [
    `### Parent ticket #${t.parent.iid}: ${t.parent.title}`,
    `This ticket is one Task of #${t.parent.iid}. Do only this Task; the parent and its other Tasks are context.`,
    t.parent.description || "(no description)",
  ].join("\n\n");
}

/** One line per open ticket plus what it provides when it has been analysed. */
export function catalogueText(cat: Ticket[], manifests: Map<number, Manifest>, self: number): string {
  const lines = cat.filter((t) => t.iid !== self).map((t) => {
    const provides = manifests.get(t.iid)?.provides ?? [];
    return [`- #${t.iid} ${t.title}`, t.description ? `  ${excerpt(t.description)}` : "", provides.length ? `  provides: ${provides.join("; ")}` : ""].filter(Boolean).join("\n");
  });
  return lines.length ? lines.join("\n") : "(none)";
}

export function analyse(args: {
  project: string;
  base: string;
  worktree: { path: string; sha: string };
  ticket: Ticket;
  notes: Note[];
  catalogue: Ticket[];
  manifests: Map<number, Manifest>;
  keepImplementerBlockers: boolean;
  knownProviders?: Ticket[]; // assessment only: previously named dependencies can now be closed
}): Manifest {
  const { ticket: t, catalogue: cat } = args;
  const vars: Record<string, string> = {
    ISSUE_IID: String(t.iid),
    ISSUE_TITLE: t.title,
    BASE_BRANCH: args.base,
    BASE_SHA: args.worktree.sha,
    CATALOGUE: [catalogueText(cat, args.manifests, t.iid), ...(args.knownProviders?.length ? [
      "Previously named dependencies outside the open catalogue (closed is not proof of a merge or verification PASS):",
      ...args.knownProviders.map((p) => `- #${p.iid} ${p.title} [${p.state}]: ${p.description}`),
    ] : [])].join("\n"),
    TICKET: ticketText(t, args.notes),
  };
  // One pass, so placeholders inside ticket text are left alone.
  const prompt = readFileSync(resolve(here, "prompt.analyze.md"), "utf8").replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);

  const so = AGENT.provider === "pi" ? runPi(t.iid, prompt, args.worktree.path) : runClaude(t.iid, prompt, args.worktree.path);

  // Execution uses only the open catalogue. Read-only assessment can retain a known closed provider's identity.
  const open = new Map([...cat, ...(args.knownProviders ?? [])].map((c) => [c.iid, c]));
  const requires = so.requires.map((r) => ({ ...r, providedBy: r.providedBy != null && r.providedBy !== t.iid && open.has(r.providedBy) ? r.providedBy : null }));
  const blockerHashes: Record<string, string> = {};
  for (const r of requires) {
    if (r.providedBy != null) {
      const p = open.get(r.providedBy)!;
      blockerHashes[r.providedBy] = contentHash({ title: p.title, description: p.description });
    }
  }
  const prev = args.manifests.get(t.iid);
  return {
    iid: t.iid,
    project: args.project,
    hash: unitHash(t, args.notes),
    analyzedAt: new Date().toISOString(),
    base: args.base,
    baseSha: args.worktree.sha,
    provides: so.provides,
    requires,
    footprint: so.footprint,
    catalogueIids: cat.map((c) => c.iid),
    blockerHashes,
    ...(prev?.actualFootprint ? { actualFootprint: prev.actualFootprint } : {}),
    ...(args.keepImplementerBlockers && prev?.implementerBlockers ? { implementerBlockers: prev.implementerBlockers } : {}),
  };
}
