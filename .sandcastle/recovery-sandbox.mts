import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecoveryDeps, RecoverySandbox, SandboxSpec } from "./recovery.mts";

// The recovery attempt's own sandbox and Git boundary (slice four, #74), used by main.mts --recover through
// recovery.mts's RecoveryDeps. It replaces Sandcastle's createSandbox for recovery only, because that worktree manager
// prunes and removes worktrees, fast-forwards an existing branch to its origin copy and mounts the project's common Git
// directory (every branch's refs) writable. Normal runs keep using Sandcastle unchanged.
// - createOwnedSandbox: `docker run -d --name <exact name recorded before creation> --label factory.recovery.attempt=<id>`
//   with the same image, uid:gid, HOME and workdir Sandcastle's docker() uses. Mounts: the ticket's existing worktree at
//   /home/agent/workspace; over its `.git` file a read-only gitfile pointing at /home/agent/.factory-git, the
//   attempt-private Git metadata (only the ticket's branch and history); this attempt's evidence folder writable at the
//   prompt's EVIDENCE_DIR with its snapshots (recovery-context.json, previous-run.json, previous-logs/, history/, input/)
//   mounted read-only over themselves; .sandcastle/sandbox read-only at /opt/sandcastle. No Docker socket, host common
//   Git directory, other evidence or credentials file is mounted; agent environment values go through the docker
//   client's environment (`-e NAME`), never its arguments. Setup hooks run with `docker exec` after the container is up.
//   Agents run with `docker exec` of the agent provider's own print command; aborting kills that exec and waits for it
//   to exit, and the attempt then removes the exact container (recovery.mts ownedContainerGone), which ends anything
//   left inside it. Nothing here removes a worktree, branch or container by any other name.
// - gitWorkspace: snapshot the worktree; build the private metadata (clone of the one branch, the remote removed, the
//   worktree's index and any staged blobs copied in so staged/unstaged/untracked input looks exactly as on the host);
//   import a repaired tip only by `git update-ref <branch> <new> <recorded>` after checking ancestry, so a moved branch
//   is never overwritten (the private commits stay in the attempt's metadata).
// All external commands go through Proc / execFileSync with argument arrays; tests stub `docker` and use real Git on a
// synthetic repo (orchestrator/recovery-runner.test.mts).

export type ProcResult = { status: number | null; stdout: string; stderr: string };
/** Start `cmd args`, feed `stdin`, stream lines to `onLine`; on `signal` abort kill it and reject once it has exited. */
export type Proc = (cmd: string, args: string[], o?: { stdin?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onLine?: (line: string) => void; cwd?: string }) => Promise<ProcResult>;

export const realProc: Proc = (cmd, args, o = {}) => new Promise((resolve, reject) => {
  if (o.signal?.aborted) return reject(o.signal.reason);
  const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: [o.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", buf = "";
  const kill = () => child.kill("SIGTERM");
  o.signal?.addEventListener("abort", kill, { once: true });
  child.stdout!.on("data", (c) => {
    stdout += c;
    if (!o.onLine) return;
    buf += c;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines) o.onLine(l);
  });
  child.stderr!.on("data", (c) => { stderr += c; });
  child.on("error", (e) => { o.signal?.removeEventListener("abort", kill); reject(e); });
  child.on("close", (status) => {
    o.signal?.removeEventListener("abort", kill);
    if (buf && o.onLine) o.onLine(buf);
    if (o.signal?.aborted) reject(o.signal.reason);
    else resolve({ status, stdout, stderr });
  });
  if (o.stdin !== undefined) { child.stdin!.write(o.stdin); child.stdin!.end(); }
});

export interface SetupStep { command: string; sudo?: boolean; timeoutMs?: number }
interface AgentLike { env?: Record<string, string>; buildPrintCommand(o: { prompt: string; dangerouslySkipPermissions: boolean }): { command: string; stdin?: string } }

export interface OwnedSandboxConfig {
  image: string;
  setup: SetupStep[];
  /** Host .sandcastle/sandbox, mounted read-only at /opt/sandcastle. */
  helpers: string;
  /** Values for the container's environment (e.g. from .sandcastle/.env); passed by name only. */
  env: Record<string, string>;
  uid: number;
  gid: number;
  proc: Proc;
  /** Prompt files are read relative to this folder (the project root). */
  root: string;
}

export const WORKSPACE = "/home/agent/workspace";
export const PRIVATE_GIT = "/home/agent/.factory-git";

/** The `docker run` arguments for an owned recovery container (exported for tests). */
export function runArgs(spec: SandboxSpec, cfg: Pick<OwnedSandboxConfig, "image" | "helpers" | "uid" | "gid">, gitfile: string, envNames: string[]): string[] {
  const v = (host: string, box: string, ro = false) => ["-v", `${host}:${box}:${ro ? "ro,z" : "z"}`];
  return [
    "run", "-d", "--name", spec.name, "--label", `${spec.label.key}=${spec.label.value}`,
    "-e", "HOME=/home/agent", ...envNames.flatMap((n) => ["-e", n]),
    ...v(spec.worktree, WORKSPACE),
    ...v(gitfile, `${WORKSPACE}/.git`, true),
    ...v(spec.gitDir, PRIVATE_GIT),
    ...v(spec.evidence, spec.evidenceBox),
    ...spec.readonly.flatMap((p) => v(p, `${spec.evidenceBox}/${p.slice(spec.evidence.length + 1)}`, true)),
    ...v(cfg.helpers, "/opt/sandcastle", true),
    "-w", WORKSPACE, "--user", `${cfg.uid}:${cfg.gid}`, cfg.image,
  ];
}

const fill = (text: string, args: Record<string, string>) => text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in args ? args[k] : m));

/** Create the owned container, run setup, and return the attempt's sandbox; see the file comment. */
export async function createOwnedSandbox(spec: SandboxSpec, cfg: OwnedSandboxConfig): Promise<RecoverySandbox> {
  for (const p of spec.readonly) if (!p.startsWith(`${spec.evidence}/`)) throw new Error(`read-only mount ${p} is outside the attempt's evidence`);
  const gitfile = join(dirname(spec.gitDir), "gitfile");
  writeFileSync(gitfile, `gitdir: ${PRIVATE_GIT}\n`, { mode: 0o600 });
  const env = { ...process.env, ...cfg.env };
  const docker = async (args: string[], o: { stdin?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; onLine?: (l: string) => void } = {}) =>
    cfg.proc("docker", args, { env: o.env ?? env, stdin: o.stdin, signal: o.signal, onLine: o.onLine });
  const started = await docker(runArgs(spec, cfg, gitfile, Object.keys(cfg.env)), { signal: spec.signal });
  if (started.status !== 0) throw new Error(`docker run failed (exit ${started.status}): ${started.stderr.trim().split("\n")[0] ?? ""}`);
  const execIn = (cmd: string, o: { sudo?: boolean; stdin?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; names?: string[]; onLine?: (l: string) => void } = {}) =>
    docker(["exec", ...(o.sudo ? ["--user", "0:0"] : []), ...(o.stdin !== undefined ? ["-i"] : []), ...(o.names ?? []).flatMap((n) => ["-e", n]),
      "-w", WORKSPACE, spec.name, "sh", "-c", cmd], o);
  for (const step of cfg.setup) {
    const signal = step.timeoutMs ? AbortSignal.any([spec.signal, AbortSignal.timeout(step.timeoutMs)]) : spec.signal;
    const r = await execIn(step.command, { sudo: step.sudo, signal });
    if (r.status !== 0) throw new Error(`setup step failed (exit ${r.status}): ${step.command}`);
  }
  const head = async () => (await execIn("git rev-parse HEAD")).stdout.trim();
  return {
    id: spec.name,
    worktreePath: spec.worktree,
    async exec(cmd) {
      const r = await execIn(cmd, { signal: spec.signal });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
    },
    async run(o) {
      const agent = o.agent as AgentLike;
      const prompt = fill(readFileSync(join(cfg.root, o.promptFile), "utf8"), o.promptArgs);
      const print = agent.buildPrintCommand({ prompt, dangerouslySkipPermissions: true });
      const before = await head();
      const log = join(spec.evidence, `${o.name}.log`);
      appendFileSync(log, `==== ${o.name} (${spec.name}) ${new Date().toISOString()}\n`);
      const signal = o.signal ? AbortSignal.any([o.signal, spec.signal]) : spec.signal;
      const agentEnv = agent.env ?? {};
      await execIn(print.command, { stdin: print.stdin, signal, env: { ...env, ...agentEnv }, names: Object.keys(agentEnv),
        onLine: (l) => appendFileSync(log, `${l}\n`) });
      const after = await head();
      const list = after === before ? "" : (await execIn(`git rev-list ${before}..${after}`)).stdout.trim();
      return { commits: list ? list.split("\n").map((sha) => ({ sha })) : [] };
    },
  };
}

// ---- host-side Git ---------------------------------------------------------------------------------------------------

const git = (args: string[], o: { cwd?: string; input?: Buffer | string; trim?: boolean } = {}): string => {
  const out = execFileSync("git", args, { cwd: o.cwd, input: o.input, encoding: "utf8", stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  return o.trim === false ? out : out.trim();
};
const gitOk = (args: string[], cwd?: string) => { try { git(args, { cwd }); return true; } catch { return false; } };

export const gitWorkspace: RecoveryDeps["workspace"] = {
  snapshot(worktree) {
    return {
      head: git(["rev-parse", "HEAD"], { cwd: worktree }),
      status: git(["status", "--porcelain", "--untracked-files=all"], { cwd: worktree, trim: false }),
      staged: git(["diff", "--cached", "--binary"], { cwd: worktree, trim: false }),
      unstaged: git(["diff", "--binary"], { cwd: worktree, trim: false }),
    };
  },
  prepareGit({ root, worktree, branch, gitDir }) {
    if (existsSync(gitDir)) throw new Error(`${gitDir} already exists`);
    mkdirSync(dirname(gitDir), { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(dirname(gitDir), "clone-"));
    try {
      git(["clone", "--quiet", "--no-local", "--no-checkout", "--single-branch", "--no-tags", "--branch", branch, root, tmp]);
      renameSync(join(tmp, ".git"), gitDir);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const g = ["--git-dir", gitDir];
    git([...g, "remote", "remove", "origin"]);
    for (const key of ["user.name", "user.email"]) {
      const value = (() => { try { return git(["config", "--get", key], { cwd: root }); } catch { return ""; } })();
      if (value) git([...g, "config", key, value]);
    }
    const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: worktree });
    if (existsSync(index)) {
      for (const line of git(["ls-files", "-s"], { cwd: worktree }).split("\n").filter(Boolean)) {
        const sha = line.split(/\s+/)[1];
        if (gitOk([...g, "cat-file", "-e", sha])) continue;
        const blob = execFileSync("git", ["cat-file", "blob", sha], { cwd: worktree, maxBuffer: 256 * 1024 * 1024 });
        git([...g, "hash-object", "-w", "--stdin"], { input: blob });
      }
      copyFileSync(index, join(gitDir, "index"));
    }
  },
  descends(gitDir, ancestor, tip) {
    return gitOk(["--git-dir", gitDir, "merge-base", "--is-ancestor", ancestor, tip]);
  },
  beyond({ root, gitDir, base, start, tip }) {
    const onBranch = Number(git(["rev-list", "--count", `${base}..${start}`], { cwd: root }));
    return onBranch + (tip === start ? 0 : Number(git(["--git-dir", gitDir, "rev-list", "--count", `${start}..${tip}`])));
  },
  importRef({ root, worktree, gitDir, branch, from, to, attemptId }) {
    if (!gitOk(["--git-dir", gitDir, "merge-base", "--is-ancestor", from, to])) return `the repaired tip does not descend from ${from.slice(0, 8)}`;
    const temp = `refs/factory-recovery/${attemptId}`;
    try {
      git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", gitDir, `+refs/heads/${branch}:${temp}`], { cwd: root });
      if (git(["rev-parse", temp], { cwd: root }) !== to) return `the attempt's ${branch} is not at the verified tip ${to.slice(0, 8)}`;
      try {
        git(["update-ref", "-m", `factory recovery ${attemptId}`, `refs/heads/${branch}`, to, from], { cwd: root });
      } catch {
        return `${branch} no longer points at the recorded ${from.slice(0, 8)}; not overwriting it`;
      }
    } finally {
      try { git(["update-ref", "-d", temp], { cwd: root }); } catch { /* never created */ }
    }
    // The container left the worktree clean at `to`; give the host worktree the matching index.
    copyFileSync(join(gitDir, "index"), git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: worktree }));
    return undefined;
  },
};

/** KEY=VALUE lines of a .env file (comments and blanks skipped, surrounding quotes removed); empty when missing. */
export function readDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}
