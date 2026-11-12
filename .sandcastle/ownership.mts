import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Ownership receipts (slice four, #75): what Factory itself created for a ticket, written before it creates anything, so
// a later repair can tell its own branch and worktree apart from anyone else's after a crash. One file per ticket,
// `<stateDir>/ownership/<projectId>/<iid>.json` (folders 0700, file 0600, temp file + fsync + rename), where
//   projectId = sha256(realpath(projectRoot) + "\0" + trackerKind + "\0" + trackerHost + "\0" + trackerProject)
// so two checkouts, or two trackers, never share receipts. A receipt holds the project root, its Git common directory,
// the ticket, branch, base, the canonical worktree path (`<root>/.sandcastle/worktrees/<branch with / as ->`), the run
// that wrote it (a claim token or recovery attempt UUID) and `creationIntent`: which of the branch and worktree that run
// was about to create. The created identities are filled in as each step completes (`branchSha`, `worktreeAt`), so a
// receipt with an intent and no identity marks a crash between the two; the next reader reconciles it against Git
// (cli/src/recovery-workspace.mts) rather than guessing. main.mts writes one before a normal run creates its branch and
// worktree; the recovery launcher (cli/src/recovery-run.mts) writes one before it adds a missing worktree or creates a
// local branch from origin, and adopts a pre-upgrade run's exact branch. Receipts are never deleted by `factory retry`.
// Import-safe (Node only); factory init copies it next to main.mts (cli/src/scaffold.mts).

export type TrackerIdentity = { kind: string; host: string; project: string };
export interface Receipt {
  version: 1;
  projectId: string;
  projectRoot: string;
  gitCommonDir: string;
  ticket: string;
  branch: string;
  base?: string;
  worktreePath: string;
  runId: string;
  creationIntent: { branch: boolean; worktree: boolean; at: string };
  branchSha?: string;
  worktreeAt?: string;
  createdAt: string;
  updatedAt: string;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
export const projectId = (root: string, t: TrackerIdentity) =>
  createHash("sha256").update(`${real(root)}\0${t.kind}\0${t.host}\0${t.project}`).digest("hex");
export const receiptFile = (stateDir: string, id: string, iid: string) => join(stateDir, "ownership", id, `${iid}.json`);
/** Sandcastle's worktree for `branch`: <root>/.sandcastle/worktrees/<branch with / as ->. */
export const canonicalWorktree = (root: string, branch: string) => join(real(root), ".sandcastle/worktrees", branch.replaceAll("/", "-"));
/** The checkout's Git common directory, resolved. */
export const gitCommonDir = (cwd: string) =>
  real(resolve(cwd, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()));

const str = (x: unknown) => typeof x === "string" && x.length > 0;
/** The receipt, `null` when there is none, or an error for an unreadable one (never repaired or replaced). */
export function readReceipt(file: string): Receipt | null {
  if (!existsSync(file)) return null;
  let d: any;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Ownership receipt ${file} is not valid JSON; Factory will not overwrite it.`);
  }
  const ok = d?.version === 1 && [d.projectId, d.projectRoot, d.gitCommonDir, d.ticket, d.branch, d.worktreePath, d.runId, d.createdAt, d.updatedAt].every(str)
    && (d.base === undefined || typeof d.base === "string") && typeof d.creationIntent?.branch === "boolean"
    && typeof d.creationIntent.worktree === "boolean" && str(d.creationIntent.at)
    && (d.branchSha === undefined || str(d.branchSha)) && (d.worktreeAt === undefined || str(d.worktreeAt));
  if (!ok) throw new Error(`Ownership receipt ${file} has an unsupported shape or version; Factory will not overwrite it.`);
  return d;
}

export function writeReceipt(file: string, r: Receipt): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(r, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    const dfd = openSync(dirname(file), "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch {
    /* folder fsync unsupported here */
  }
}

/** Write the receipt for a ticket's branch and worktree before creating either. */
export function recordIntent(stateDir: string, o: { root: string; tracker: TrackerIdentity; ticket: string; branch: string; base?: string;
  runId: string; branchToCreate: boolean; worktreeToCreate: boolean; at?: string; branchSha?: string; worktreeAt?: string }): string {
  const id = projectId(o.root, o.tracker);
  const file = receiptFile(stateDir, id, o.ticket);
  const at = o.at ?? new Date().toISOString();
  writeReceipt(file, {
    version: 1, projectId: id, projectRoot: real(o.root), gitCommonDir: gitCommonDir(o.root), ticket: o.ticket, branch: o.branch,
    ...(o.base ? { base: o.base } : {}), worktreePath: canonicalWorktree(o.root, o.branch), runId: o.runId,
    creationIntent: { branch: o.branchToCreate, worktree: o.worktreeToCreate, at }, ...(o.branchSha ? { branchSha: o.branchSha } : {}),
    ...(o.worktreeAt ? { worktreeAt: o.worktreeAt } : {}), createdAt: at, updatedAt: at,
  });
  return file;
}

/** Fill in identities that now exist. Throws when there is no receipt to fill. */
export function fillReceipt(file: string, patch: Partial<Pick<Receipt, "branchSha" | "worktreeAt">>): Receipt {
  const r = readReceipt(file);
  if (!r) throw new Error(`No ownership receipt ${file} to fill in`);
  const next = { ...r, ...patch, updatedAt: new Date().toISOString() };
  writeReceipt(file, next);
  return next;
}
