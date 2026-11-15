import fs, { constants as C, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { jsonReport, markdownReport } from './report.ts';
import { AcceptanceError, idSchema, installationSchema, ownerSchema, validateJournal, type Installation, type Journal, type LockOwner, type MutationIntent, type OwnershipProbe } from './contracts.ts';

const uid = () => process.getuid!();
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_BYTES = 128 * 1024;
function safe<T>(fn: () => T): T {
  try { return fn(); } catch (e) { if (e instanceof AcceptanceError) throw e; throw new AcceptanceError('io'); }
}
function directory(path: string, dedicated: boolean): void {
  const st = fs.lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== uid() && !(st.uid === 0 && !dedicated)) ||
      (dedicated ? (st.mode & 0o7777) !== 0o700 : (st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000)))) {
    throw new AcceptanceError('unsafe-path');
  }
}
function parents(path: string): void {
  const parts = path.split(sep).filter(Boolean);
  let current: string = sep;
  directory(current, false);
  for (const part of parts) { current = join(current, part); directory(current, current === path); }
}
function privateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  directory(path, true);
}
function checkFile(fd: number): void {
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.uid !== uid() || (st.mode & 0o7777) !== 0o600 || st.nlink !== 1 || st.size > MAX_BYTES) throw new AcceptanceError('unsafe-path');
}
function readPrivate(path: string): string {
  const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try { checkFile(fd); return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export type WriteBoundary = 'temp-created' | 'temp-synced' | 'renamed' | 'directory-synced';
/** Hooks inject crashes only in tests. A throw after rename means outcome is uncertain: reload before doing anything else. */
function atomic(path: string, bytes: string, hook?: (boundary: WriteBoundary) => void): void {
  const parent = dirname(path);
  directory(parent, true);
  // Existing destinations must be safe, even though rename would not follow a symlink.
  try { readPrivate(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const temp = join(parent, `.pending-${randomUUID()}`);
  const fd = openSync(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  try {
    hook?.('temp-created');
    writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd); hook?.('temp-synced');
  } finally { closeSync(fd); }
  renameSync(temp, path); hook?.('renamed'); syncDirectory(parent); hook?.('directory-synced');
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function parseOwner(bytes: string): LockOwner {
  try { return ownerSchema.parse(JSON.parse(bytes)); } catch { throw new AcceptanceError('invalid-state'); }
}
export interface RegistryOptions {
  /** Test filesystem boundary only. Live callers must use the fixed default, never a per-run/configurable root. */
  root?: string;
  /** Additional app data roots, rejected even in tests. */
  appDataRoots?: string[];
  onWrite?: (boundary: WriteBoundary) => void;
}
/** One fixed host registry for the designated OS operator. Other UIDs must fail permissions, not use separate roots. */
export class AcceptanceRegistry {
  readonly root: string;
  private readonly hook?: RegistryOptions['onWrite'];
  constructor(options: RegistryOptions = {}) {
    this.root = options.root ?? '/var/lib/r2-acceptance';
    this.hook = options.onWrite;
    safe(() => {
      if (!isAbsolute(this.root) || resolve(this.root) !== this.root || this.root.split(sep).some(p => p === '.' || p === '..')) throw new AcceptanceError('unsafe-path');
      for (const forbidden of [source, '/opt/r2', '/var/lib/r2', ...(options.appDataRoots ?? [])]) {
        if (this.root === forbidden || this.root.startsWith(`${forbidden}/`)) throw new AcceptanceError('unsafe-path');
      }
      // Validate ancestors before creating anything. No recursive mkdir through unknown paths.
      const parent = dirname(this.root);
      let p = parent;
      while (true) { directory(p, false); if (p === dirname(p)) break; p = dirname(p); }
      privateDirectory(this.root); parents(this.root);
    });
  }
  private lockPath(installation: Installation): string {
    const result = installationSchema.safeParse(installation);
    if (!result.success) throw new AcceptanceError('invalid-state');
    return join(this.root, `host-${result.data.hostFingerprint}-r2.service.lock`);
  }
  /** Serialize all ownership transitions. A crash leaving .ownership-gate blocks automation, not a guessed stale deletion. */
  private gate<T>(fn: () => T): T {
    parents(this.root);
    const path = join(this.root, '.ownership-gate');
    try { mkdirSync(path, { mode: 0o700 }); } catch { throw new AcceptanceError('locked'); }
    try { return fn(); } finally { rmdirSync(path); syncDirectory(this.root); }
  }
  acquire(installation: Installation, input: LockOwner): JournalLease {
    return safe(() => this.gate(() => {
      const parsed = ownerSchema.safeParse(input);
      if (!parsed.success) throw new AcceptanceError('invalid-state');
      const owner = parsed.data;
      const path = this.lockPath(installation);
      try { readPrivate(path); throw new AcceptanceError('locked'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      // No partial owner record: atomic rename under the ownership gate.
      atomic(path, JSON.stringify(owner));
      return new JournalLease(this, installationSchema.parse(installation), owner, this.hook);
    }));
  }
  /** Explicit recovery only. Probe must prove death or verified prior boot; errors/uncertainty preserve lock. */
  recoverStale(installation: Installation, expected: LockOwner, probe: OwnershipProbe): void {
    safe(() => this.gate(() => {
      const path = this.lockPath(installation);
      const owner = parseOwner(readPrivate(path));
      if (!same(owner, ownerSchema.parse(expected))) throw new AcceptanceError('not-owner');
      if (probe.inspect(owner) !== 'stale') throw new AcceptanceError('locked');
      this.assertReleasable(installation, owner);
      unlinkSync(path); syncDirectory(this.root);
    }));
  }
  /** Transfer a proven stale lock to a fresh process in the SAME run, retaining all unfinished recovery. */
  takeoverStale(installation: Installation, expected: LockOwner, replacement: LockOwner, probe: OwnershipProbe): JournalLease {
    return safe(() => this.gate(() => {
      const path = this.lockPath(installation);
      const owner = parseOwner(readPrivate(path));
      const next = ownerSchema.parse(replacement);
      if (!same(owner, ownerSchema.parse(expected)) || next.runId !== owner.runId || next.token === owner.token) throw new AcceptanceError('not-owner');
      if (probe.inspect(owner) !== 'stale') throw new AcceptanceError('locked');
      atomic(path, JSON.stringify(next));
      return new JournalLease(this, installationSchema.parse(installation), next, this.hook);
    }));
  }
  private assertReleasable(installation: Installation, owner: LockOwner): void {
    const run = join(this.root, owner.runId);
    try { directory(run, true); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    let state: Journal;
    try { state = validateJournal(JSON.parse(readPrivate(join(run, 'journal.json')))); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (e instanceof AcceptanceError) throw e;
      throw new AcceptanceError('invalid-state');
    }
    if (state.runId !== owner.runId || !same(state.installation, installation)) throw new AcceptanceError('invalid-state');
    if (state.pending !== null || state.cleanup.status !== 'verified') throw new AcceptanceError('recovery-required');
  }
  /** Safe inspection for explicit recovery. No path/private process output is exposed. */
  owner(installation: Installation): LockOwner {
    return safe(() => this.gate(() => parseOwner(readPrivate(this.lockPath(installation)))));
  }
  withOwner<T>(installation: Installation, owner: LockOwner, fn: () => T): T {
    return safe(() => this.gate(() => {
      if (!same(parseOwner(readPrivate(this.lockPath(installation))), owner)) throw new AcceptanceError('not-owner');
      return fn();
    }));
  }
  release(installation: Installation, owner: LockOwner): void {
    this.withOwner(installation, owner, () => {
      this.assertReleasable(installation, owner);
      unlinkSync(this.lockPath(installation)); syncDirectory(this.root);
    });
  }
}
export class JournalLease {
  private readonly path: string;
  private readonly registry: AcceptanceRegistry;
  readonly installation: Installation;
  readonly owner: LockOwner;
  private readonly hook?: RegistryOptions['onWrite'];
  constructor(registry: AcceptanceRegistry, installation: Installation, owner: LockOwner, hook?: RegistryOptions['onWrite']) {
    this.registry = registry;
    this.installation = installation;
    this.owner = owner;
    this.hook = hook;
    this.path = join(registry.root, owner.runId, 'journal.json');
  }
  private run<T>(fn: () => T): T {
    return this.registry.withOwner(this.installation, this.owner, () => {
      privateDirectory(dirname(this.path)); return fn();
    });
  }
  private read(): Journal {
    try { return validateJournal(JSON.parse(readPrivate(this.path))); }
    catch (e) { if (e instanceof AcceptanceError) throw e; throw new AcceptanceError('invalid-state'); }
  }
  private bound(s: Journal): void {
    if (s.runId !== this.owner.runId || !same(s.installation, this.installation)) throw new AcceptanceError('invalid-state');
  }
  create(input: unknown): Journal {
    return this.run(() => {
      const state = validateJournal(input); this.bound(state);
      if (state.sequence !== 0 || state.pending !== null) throw new AcceptanceError('invalid-state');
      try { readPrivate(this.path); throw new AcceptanceError('invalid-state'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      atomic(this.path, JSON.stringify(state), this.hook); return state;
    });
  }
  load(): Journal { return this.run(() => { const state = this.read(); this.bound(state); return state; }); }
  /** CAS prevents stale in-memory snapshots from overwriting a later checkpoint. Pending mutations need resolveRecovery. */
  commit(input: unknown, expectedSequence: number): Journal {
    return this.run(() => {
      const previous = this.read(); const next = validateJournal(input); this.bound(previous); this.bound(next);
      if (previous.pending !== null) throw new AcceptanceError('recovery-required');
      if (next.pending !== null) throw new AcceptanceError('invalid-state');
      return this.writeNext(previous, next, expectedSequence);
    });
  }
  private writeNext(previous: Journal, next: Journal, expectedSequence: number): Journal {
    if (previous.sequence !== expectedSequence || next.sequence !== expectedSequence + 1 ||
      next.createdAt !== previous.createdAt || next.updatedAt < previous.updatedAt) throw new AcceptanceError('invalid-state');
    // Stable identities and original timing cannot be rewritten during resume/retry.
    for (const old of previous.cases) {
      const current = next.cases.find(c => c.requestId === old.requestId);
      if (!current || old.phase === 'blocked' && !same(old, current) || ['label', 'caseNumber', 'requestId', 'dueAt', 'localDateTime', 'timezone', 'createdAt'].some(k =>
        current[k as keyof typeof current] !== old[k as keyof typeof old]) ||
        (['proposalId', 'reminderId', 'attemptAt', 'acceptedAt'] as const).some(k => old[k] !== null && old[k] !== current[k])) {
        throw new AcceptanceError('invalid-state');
      }
    }
    if (previous.reboot !== null && (next.reboot === null ||
      (['previousBootId', 'installation', 'caseLabel', 'caseRequestId', 'at'] as const).some(k => !same(previous.reboot![k], next.reboot![k])))) throw new AcceptanceError('invalid-state');
    if (previous.cleanup.originalPause !== null && next.cleanup.originalPause !== previous.cleanup.originalPause) throw new AcceptanceError('invalid-state');
    if (!same(previous.optionalChecks, next.optionalChecks) || previous.priorBootId !== next.priorBootId) throw new AcceptanceError('invalid-state');
    atomic(this.path, JSON.stringify(next), this.hook); return next;
  }
  /** Persist intent AND cleanup ownership before performing an external effect. Never proceed if this throws. */
  beginMutation(input: unknown, expectedSequence: number): MutationIntent {
    const next = validateJournal(input);
    const intent = next.pending;
    if (!intent) throw new AcceptanceError('invalid-state');
    if (intent.operation === 'confirm' || intent.operation === 'propose') {
      const c = next.cases.find(c => c.requestId === intent.caseRequestId && c.label === intent.caseLabel);
      if (!c || (intent.operation === 'confirm'
        ? c.phase !== 'confirm-intent' || c.proposalId === null
        : !['intended', 'proposal-unresolved'].includes(c.phase) || c.proposalId !== null)) throw new AcceptanceError('invalid-state');
    } else if (intent.operation === 'reboot') {
      if (next.cleanup.status !== 'verified' || next.reboot?.phase !== 'pending' ||
        intent.caseRequestId !== next.reboot.caseRequestId || intent.stage !== 'reboot') throw new AcceptanceError('invalid-state');
    } else {
      if (next.cleanup.status !== 'restore-needed') throw new AcceptanceError('invalid-state');
      if (['pause', 'restore-pause'].includes(intent.operation) &&
        (next.cleanup.originalPause === null || !next.cleanup.pauseRestoreNeeded)) throw new AcceptanceError('invalid-state');
      if (['restart', 'stop', 'start', 'disable-model', 'restore-model'].includes(intent.operation) &&
        !next.cleanup.serviceRestoreNeeded) throw new AcceptanceError('invalid-state');
      if (intent.operation === 'disable-model' && (!next.cleanup.daemonReloadNeeded || next.cleanup.artifacts.length !== 2)) throw new AcceptanceError('invalid-state');
    }
    this.run(() => {
      const previous = this.read(); this.bound(previous); this.bound(next);
      if (previous.pending !== null) throw new AcceptanceError('recovery-required');
      this.writeNext(previous, next, expectedSequence);
    });
    return intent;
  }
  /** Record partial artifact/effect progress without clearing or changing authority to reconcile the pending operation. */
  checkpointMutation(input: unknown, expectedSequence: number, intentId: string): Journal {
    return this.run(() => {
      const previous = this.read(); const next = validateJournal(input); this.bound(previous); this.bound(next);
      if (!idSchema.safeParse(intentId).success || previous.pending?.id !== intentId || !same(previous.pending, next.pending)) throw new AcceptanceError('recovery-required');
      return this.writeNext(previous, next, expectedSequence);
    });
  }
  /** Reconcile actual external state, then commit the result with the exact pending ID. No automatic replay. */
  resolveRecovery(input: unknown, expectedSequence: number, intentId: string): Journal {
    return this.run(() => {
      const previous = this.read(); const next = validateJournal(input); this.bound(previous); this.bound(next);
      if (!idSchema.safeParse(intentId).success || previous.pending?.id !== intentId || next.pending !== null) throw new AcceptanceError('recovery-required');
      return this.writeNext(previous, next, expectedSequence);
    });
  }
  /** Each export is atomic and private. Compare checkpoint numbers if interrupted between the two files. */
  exportReports(): void {
    this.run(() => {
      const state = this.read(); this.bound(state);
      atomic(join(dirname(this.path), 'report.json'), jsonReport(state));
      atomic(join(dirname(this.path), 'report.md'), markdownReport(state));
    });
  }
  release(): void { this.registry.release(this.installation, this.owner); }
}
