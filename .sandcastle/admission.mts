import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

// The admission record (slice four, #75): the one durable source of run claims, shared by every project in a run-state
// folder. `<stateDir>/admission/state.json` (folder 0700, file 0600, version 1) holds:
// - `claims`, by run key (`<project>--<iid>`): a token, the project and ticket, the kind (`normal` for a dispatched
//   launch, `recovery` for a repair attempt), the owning process (pid plus its start identity, so a reused pid is not
//   mistaken for the owner) and, for recovery, the attempt's UUID. A normal claim lives while its owner does. A recovery
//   claim is never released by its owner dying: only the recovery launcher's settle step releases it, after the
//   attempt's exact container is confirmed gone (cli/src/recovery-run.mts).
// - `generations`: per project, a counter that every normal admission increments. The jam detector compares it across
//   passes, so a normal launch breaks a pending jam confirmation (cli/src/recovery-state.mts).
// - `recovery`: per project, the number of recovery attempts admitted and the admitted attempts whose charge has not yet
//   been applied to the project's recovery record (`pending`). A recovery claim and its attempt charge are written in one
//   replacement; the charge is then applied to the recovery record idempotently by attempt UUID and cleared, so a crash
//   between the two writes is replayed later without charging twice or refunding (cli/src/recovery-claim.mts).
// Every change runs under one short interprocess lock across all projects, `<stateDir>/admission/lock`, created complete
// (written to a temp file, then hard-linked into place) and naming its holder's pid and start identity. It is taken over
// only when that exact process is gone (the pid has exited, or now belongs to a process started at another time), never
// because of its age or a live pid alone. Writes are temp file, fsync, rename, fsync of the folder. A corrupt record or an
// unknown version fails closed: nothing is claimed and the file is never overwritten. readAdmission never writes.
// Import-safe and dependency-free apart from Node, so factory init copies it next to board.mts (cli/src/scaffold.mts).

export type ClaimKind = "normal" | "recovery";
/** A process: its pid and, where the platform tells, when it started (to tell a reused pid apart). */
export type Owner = { pid: number; start?: string };
export interface AdmissionClaim {
  token: string;
  project: string;
  iid: string;
  kind: ClaimKind;
  owner: Owner;
  at: string;
  /** Recovery only: the attempt's UUID. */
  attempt?: string;
}
/** A recovery attempt admitted with its claim, whose charge is still to be applied to the project's recovery record. */
export interface AdmittedAttempt {
  id: string;
  iid: string;
  root: string;
  at: string;
  branch?: string;
  log?: string;
  container?: string;
  record?: string;
}
export interface AdmissionState {
  version: 1;
  claims: Record<string, AdmissionClaim>;
  generations: Record<string, number>;
  recovery: Record<string, { admitted: number; pending: AdmittedAttempt[] }>;
}

export const keyFor = (iid: string, proj?: string) => (proj ? `${proj.replace(/[^A-Za-z0-9._-]+/g, "_")}--${iid}` : iid);
export const admissionDir = (stateDir: string) => join(stateDir, "admission");
export const admissionFile = (stateDir: string) => join(admissionDir(stateDir), "state.json");
export const emptyAdmission = (): AdmissionState => ({ version: 1, claims: {}, generations: {}, recovery: {} });
export const newToken = () => randomUUID();

// ---- process identity ------------------------------------------------------------------------------------------------

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}
/** When process `pid` started: a platform-specific string, null when no such process exists, undefined when it exists
 *  but its start cannot be read. */
export function processStart(pid: number): string | null | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || processGone(pid)) return null;
  try {
    // Linux: field 22 of /proc/<pid>/stat (clock ticks since boot), after the parenthesised command name.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return `linux:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
  } catch {
    /* not Linux, or gone meanwhile */
  }
  if (process.platform === "linux") return processGone(pid) ? null : undefined;
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return `ps:${r.stdout.trim()}`;
  return processGone(pid) ? null : undefined;
}
export function ownerOf(pid: number): Owner {
  const start = processStart(pid);
  return start ? { pid, start } : { pid };
}
/** Whether the owner still runs: "dead" only when its pid is gone or now belongs to a process started at another time. */
export function ownerState(o: Owner): "alive" | "dead" | "unknown" {
  const start = processStart(o.pid);
  if (start === null) return "dead";
  if (start === undefined) return "unknown";
  if (o.start && o.start !== start) return "dead";
  return o.start ? "alive" : "unknown";
}
/** A claim that still holds: every recovery claim (released only by settling), and a normal claim whose owner may run. */
export const claimLive = (c: AdmissionClaim) => c.kind === "recovery" || ownerState(c.owner) !== "dead";

// ---- the record ------------------------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown) => typeof x === "string" && x.length > 0;
const optStr = (x: unknown) => x === undefined || typeof x === "string";
const validOwner = (o: any) => isObj(o) && Number.isInteger(o.pid) && o.pid > 0 && optStr(o.start);

/** The admission record. Missing is empty; malformed or an unknown version throws. Never writes. */
export function readAdmission(stateDir: string): AdmissionState {
  const file = admissionFile(stateDir);
  if (!existsSync(file)) return emptyAdmission();
  let d: any;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Admission record is not valid JSON: ${file}. Nothing is admitted until it is fixed; Factory will not overwrite it.`);
  }
  const ok = isObj(d) && d.version === 1
    && isObj(d.claims) && Object.entries<any>(d.claims).every(([k, c]) => isObj(c) && str(c.token) && typeof c.project === "string" && str(c.iid)
      && k === keyFor(c.iid, c.project) && (c.kind === "normal" || c.kind === "recovery") && validOwner(c.owner) && str(c.at)
      && optStr(c.attempt) && (c.kind === "normal" || str(c.attempt)))
    && isObj(d.generations) && Object.values(d.generations).every((g) => Number.isInteger(g) && (g as number) >= 0)
    && isObj(d.recovery) && Object.values<any>(d.recovery).every((r) => isObj(r) && Number.isInteger(r.admitted) && r.admitted >= 0
      && Array.isArray(r.pending) && r.pending.every((a: any) => isObj(a) && str(a.id) && str(a.iid) && str(a.root) && str(a.at)
        && optStr(a.branch) && optStr(a.log) && optStr(a.container) && optStr(a.record)));
  if (!ok) throw new Error(`Unsupported admission record: ${file}. Nothing is admitted until it is fixed; Factory will not overwrite it.`);
  return d;
}

/** Write `text` to `file` atomically and durably: temp file (mode 0600), fsync, rename, fsync of the folder. */
export function writeDurable(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
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
    /* some platforms cannot fsync a folder; the rename is still atomic */
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Take <stateDir>/admission/lock, run `fn`, release. See the file comment for when a lock is taken over. */
export function withAdmissionLock<T>(stateDir: string, fn: () => T, waitMs = 10_000): T {
  const dir = admissionDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "lock");
  const me = ownerOf(process.pid);
  const tmp = join(dir, `lock.${process.pid}.${randomUUID().slice(0, 8)}`);
  writeDurable(tmp, JSON.stringify(me));
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      try {
        linkSync(tmp, lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let holder: Owner | undefined;
      let ino = 0;
      try {
        ino = statSync(lock).ino;
        const h = JSON.parse(readFileSync(lock, "utf8"));
        if (validOwner(h)) holder = h;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile
      }
      if (holder && ownerState(holder) === "dead") {
        // Take over only that exact lock: move it aside, and put it back if someone else's replaced it meanwhile.
        const aside = join(dir, `lock.stale.${randomUUID().slice(0, 8)}`);
        try {
          renameSync(lock, aside);
        } catch {
          continue;
        }
        if (statSync(aside).ino !== ino) {
          try { linkSync(aside, lock); } catch { /* a third claimant holds it now */ }
        }
        rmSync(aside, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(holder
          ? `Run admission is locked by process ${holder.pid} (${lock}). Retry shortly.`
          : `Run admission lock ${lock} is unreadable; it is never taken over by age. Remove it once no factory or dispatcher process runs.`);
      }
      sleep(25);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export interface AdmissionTx {
  /** The record as read under the lock; mutate it, then commit. */
  state: AdmissionState;
  /** Write the current state as one atomic replacement. May be called more than once. */
  commit(): void;
}

/** Run `fn` with the admission record under the lock. Normal claims whose owner is gone are dropped on commit. */
export function withAdmission<T>(stateDir: string, fn: (tx: AdmissionTx) => T): T {
  return withAdmissionLock(stateDir, () => {
    const state = readAdmission(stateDir);
    const tx: AdmissionTx = {
      state,
      commit() {
        for (const [k, c] of Object.entries(state.claims)) if (!claimLive(c)) delete state.claims[k];
        writeDurable(admissionFile(stateDir), JSON.stringify(state, null, 2) + "\n");
      },
    };
    return fn(tx);
  });
}

/** Hand the claim `token` on `key` to process `pid`. Only that token, and with `from`, only while `from` owns it. */
export function transferClaim(stateDir: string, key: string, token: string, pid: number, from?: number): boolean {
  return withAdmission(stateDir, (tx) => {
    const c = tx.state.claims[key];
    if (!c || c.token !== token || (from !== undefined && c.owner.pid !== from)) return false;
    c.owner = ownerOf(pid);
    tx.commit();
    return true;
  });
}

/** Release the claim `token` on `key`, only if it still holds that token and (when given) is of `kind`. */
export function releaseClaim(stateDir: string, key: string, token: string, kind?: ClaimKind): boolean {
  return withAdmission(stateDir, (tx) => {
    const c = tx.state.claims[key];
    if (!c || c.token !== token || (kind && c.kind !== kind)) return false;
    delete tx.state.claims[key];
    tx.commit();
    return true;
  });
}

/** The project's activity generation (normal admissions so far). */
export const generationOf = (s: AdmissionState, project: string) => s.generations[project] ?? 0;
