import fs, { constants as C } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { idSchema, type Clock, type Installation, type Journal, type StageApproval, type CleanupIntent } from './contracts.ts';
import type { JournalLease } from './state.ts';

export type HostOperation = 'restart' | 'stop' | 'start' | 'disable-model' | 'restore-model';
export type HostErrorCode = 'unsafe-installation' | 'unauthorized' | 'operation-failed' | 'timeout' | 'conflict' | 'recovery-required';
export class HostError extends Error {
  readonly code: HostErrorCode;
  constructor(code: HostErrorCode) {
    const safe: HostErrorCode = ['unsafe-installation', 'unauthorized', 'operation-failed', 'timeout', 'conflict', 'recovery-required'].includes(code) ? code : 'operation-failed';
    super(`Host operation blocked: ${safe}.`); this.name = 'HostError'; this.code = safe;
  }
}
const fail = (code: HostErrorCode): never => { throw new HostError(code); };
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const unitHash = '654f6000639693323a7e8e1363f532722ef7da11eb6ab3e31912ac3c536503e4';
const unitPath = '/etc/systemd/system/r2.service';
const artifactPaths = {
  'model-drop-in': '/run/systemd/system/r2.service.d/90-r2-acceptance.conf',
  'model-environment': '/run/r2-acceptance-model.env',
} as const;
type Kind = keyof typeof artifactPaths;
const activeLeases = new WeakSet<JournalLease>();
const consumedApprovals = new WeakSet<StageApproval>();
const runningExecutors = new Map<CommandExecutor, number>();
const properties = ['Id', 'FragmentPath', 'DropInPaths', 'User', 'Group', 'WorkingDirectory', 'EnvironmentFiles', 'ExecStart', 'ReadWritePaths', 'ActiveState', 'UnitFileState', 'MainPID', 'Job'];
export interface CommandRequest {
  executable: '/usr/bin/systemctl' | '/usr/bin/node' | '/usr/bin/ss' | '/usr/bin/timedatectl' | '/usr/bin/tailscale' | '/usr/bin/curl';
  args: readonly string[];
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  /** The executor must not inherit shell PATH, NODE_OPTIONS, proxies or credential variables. */
  env: Readonly<Record<string, string>>;
}
/** Trusted adapter: spawn without a shell; enforce maxBytes while streaming, kill/reap on abort before rejecting.
 * Never log output/errors. No built-in live executor is installed by this module. */
export type CommandExecutor = (request: CommandRequest) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface HostOptions {
  /** Trusted boundary, not a CLI option. Tests supply a private synthetic root; live layout is '/'. */
  root: string;
  execute: CommandExecutor;
  clock: Clock;
  /** Privilege and terminal facts must come from the calling process, not CLI flags. */
  privileged: () => boolean;
  interactive: () => boolean;
  /** Trusted synthetic ownership mapping. Live callers leave these at root and the installed r2 UID. */
  rootUid?: number;
  serviceUid: number;
  /** Test-only interruption hook. Throws simulate process death; recovery is explicit after a hook throws. */
  boundary?: (name: string) => void;
}
export interface HostFacts {
  installation: Installation;
  layout: 'supported';
  runtime: { executable: '/usr/bin/node'; version: string };
  active: boolean;
  enabled: boolean;
  permissions: 'restrictive';
  healthy: boolean;
  loopbackOnly: boolean;
  listener: 'loopback-only' | 'absent' | 'unsafe';
  synchronizedClock: boolean;
  privateHttps: boolean;
  ready: boolean;
}
export interface HostAuthority { nonProduction: boolean; hostDisruption: boolean; approval: StageApproval }
export const hostRecoveryInstructions = Object.freeze({
  none: 'No host recovery action remains. API pause and assistant checks are separate.',
  'retry-recovery': 'Keep the host/unit lock. Stop new acceptance stages. After the command executor has terminated and been reaped, retry recover with fresh restore-model approval. If health still fails, the owner must inspect the service privately.',
  'inspect-owned-artifacts': 'Keep the host/unit lock and stop acceptance processes. The owner must compare journal artifact fingerprints with /run/r2-acceptance-model.env and /run/systemd/system/r2.service.d/90-r2-acceptance.conf, including parent links, ownership and modes. Preserve operator edits and unrelated drop-ins. Reconcile conflicts manually, then retry recover with fresh approval. Never edit or disclose /etc/r2/r2.env.',
});
export interface RecoveryResult {
  status: 'restore-needed' | 'restored-and-verified' | 'conflict' | 'failed';
  /** Fixed, secret-free instruction, never an error message or an arbitrary path from an adapter. */
  instruction: 'none' | 'retry-recovery' | 'inspect-owned-artifacts';
}

/** Fixed-layout, fail-closed host protocol. No API assistant/push/browser facts are inferred here. */
export class AcceptanceHost {
  private readonly root: string;
  private readonly uid: number;
  private busy = false;
  private interrupted = false;
  constructor(private readonly options: HostOptions) {
    this.root = options.root;
    this.uid = options.rootUid ?? 0;
    if (!this.root.startsWith('/') || resolve(this.root) !== this.root) fail('unsafe-installation');
  }
  private path(path: string): string { return join(this.root, path); }
  private directories(path: string): void {
    const target = this.path(path);
    let current = target;
    while (true) {
      const s = fs.lstatSync(current);
      if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== this.uid && s.uid !== 0) ||
        ((s.mode & 0o022) !== 0 && !(s.uid === 0 && (s.mode & 0o1000) !== 0 && !current.startsWith(this.root === '/' ? '/run/' : this.root)))) fail('unsafe-installation');
      if (current === dirname(current)) break;
      current = dirname(current);
    }
  }
  private stat(path: string, owner: number, mode: number, directory = false): fs.Stats {
    this.directories(dirname(path));
    const s = fs.lstatSync(this.path(path));
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) || s.uid !== owner || (s.mode & 0o7777) !== mode) fail('unsafe-installation');
    return s;
  }
  private read(path: string, mode = 0o644): string {
    this.stat(path, this.uid, mode);
    const fd = fs.openSync(this.path(path), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.uid !== this.uid || (s.mode & 0o7777) !== mode || s.size > 16_384) fail('unsafe-installation');
      const buffer = Buffer.alloc(16_385);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (count > 16_384) fail('unsafe-installation');
      return buffer.subarray(0, count).toString('utf8');
    } finally { fs.closeSync(fd); }
  }
  private missing(path: string): boolean {
    // /run and its children may have vanished after reboot. Validate existing ancestors,
    // but do not recreate or follow a replacement symlink.
    let parent = dirname(path);
    while (true) {
      try { this.directories(parent); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || parent === '/') throw e;
        parent = dirname(parent);
      }
    }
    try { fs.lstatSync(this.path(path)); return false; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw e;
    }
  }
  private sync(path: string): void {
    const fd = fs.openSync(this.path(path), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  private async command(executable: CommandRequest['executable'], args: readonly string[]): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const executor = this.options.execute;
      runningExecutors.set(executor, (runningExecutors.get(executor) ?? 0) + 1);
      const execution = Promise.resolve().then(() => executor({ executable, args: Object.freeze([...args]), timeoutMs: 10_000, maxBytes: 16_384,
        signal: controller.signal, env: Object.freeze({ PATH: '/usr/bin', LANG: 'C', LC_ALL: 'C' }) })).finally(() => {
          const remaining = (runningExecutors.get(executor) ?? 1) - 1;
          if (remaining) runningExecutors.set(executor, remaining); else runningExecutors.delete(executor);
        });
      const result = await Promise.race([
        execution,
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new HostError('timeout')); }, 10_000); }),
      ]);
      if (result.code !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 16_384) fail('operation-failed');
      return result.stdout;
    } catch (e) { if (e instanceof HostError) throw new HostError(e.code); return fail('operation-failed'); }
    finally { if (timer) clearTimeout(timer); }
  }
  private system(operation: 'restart' | 'stop' | 'start' | 'daemon-reload'): Promise<string> {
    return this.command('/usr/bin/systemctl', operation === 'daemon-reload' ? [operation, '--no-ask-password'] : [operation, '--no-ask-password', 'r2.service']);
  }
  private async unit(owned: boolean | 'recovery') {
    if (hash(this.read(unitPath)) !== unitHash) fail('unsafe-installation');
    const raw = await this.command('/usr/bin/systemctl', ['show', '--no-pager', ...properties.map(p => `--property=${p}`), 'r2.service']);
    const values: Record<string, string> = {};
    for (const line of raw.trimEnd().split('\n')) {
      const at = line.indexOf('='); const key = line.slice(0, at);
      if (at < 0 || !properties.includes(key) || key in values) fail('unsafe-installation');
      values[key] = line.slice(at + 1);
    }
    if (Object.keys(values).length !== properties.length || values.Id !== 'r2.service' || values.FragmentPath !== unitPath ||
      values.User !== 'r2' || values.Group !== 'r2' || values.WorkingDirectory !== '/opt/r2' || values.ReadWritePaths !== '/var/lib/r2' ||
      !/^\{ path=\/usr\/bin\/node ; argv\[\]=\/usr\/bin\/node \/opt\/r2\/dist\/server\/main.js ; ignore_errors=no ;[^\n{}]*\}$/.test(values.ExecStart!) ||
      !['active', 'inactive', 'failed'].includes(values.ActiveState!) || !['enabled', 'disabled'].includes(values.UnitFileState!) || !/^\d{1,7}$/.test(values.MainPID!) || values.Job !== '0') fail('unsafe-installation');
    const hasOverride = owned === true || owned === 'recovery' && values.DropInPaths === artifactPaths['model-drop-in'];
    const drop = hasOverride ? artifactPaths['model-drop-in'] : '';
    const env = '/etc/r2/r2.env (ignore_errors=no)' + (hasOverride ? ` ${artifactPaths['model-environment']} (ignore_errors=no)` : '');
    if (values.DropInPaths !== drop || values.EnvironmentFiles !== env) fail('unsafe-installation');
    return values;
  }
  private installation(): Installation {
    const revision = this.read('/opt/r2/.r2-revision').trim();
    const machine = this.read('/etc/machine-id').trim();
    if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{32}$/.test(machine)) fail('unsafe-installation');
    this.stat('/etc/r2', this.uid, 0o700, true);
    // Metadata only. Never open, parse or copy the installed secret environment file.
    this.stat('/etc/r2/r2.env', this.uid, 0o600);
    this.stat('/var/lib/r2', this.options.serviceUid, 0o700, true);
    this.stat('/opt/r2', this.uid, 0o755, true);
    this.stat('/usr/bin/node', this.uid, 0o755);
    return { hostFingerprint: hash(machine), revision, unit: 'r2.service' };
  }
  private async health(): Promise<boolean> {
    const raw = await this.command('/usr/bin/curl', ['--silent', '--fail', '--noproxy', '*', '--max-time', '5', 'http://127.0.0.1:3000/healthz']);
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && JSON.stringify(value) === '{"status":"ok"}';
  }
  /** Read-only. Unknown formats/layout throw a sanitized HostError, never guessed checkout facts. */
  async inspect(): Promise<HostFacts> {
    try {
      const installation = this.installation();
      const unit = await this.unit(false);
      const version = (await this.command('/usr/bin/node', ['--version'])).trim();
      if (!/^v24\.\d{1,3}\.\d{1,3}$/.test(version)) fail('unsafe-installation');
      if (unit.ActiveState === 'active') {
        if (unit.MainPID === '0') fail('unsafe-installation');
        // Inspect the service process, not the developer shell's PATH or Node version.
        this.directories(`/proc/${unit.MainPID}`);
        if (fs.readlinkSync(this.path(`/proc/${unit.MainPID}/exe`)) !== '/usr/bin/node') fail('unsafe-installation');
      }
      const rawListeners = (await this.command('/usr/bin/ss', ['--tcp', '--listening', '--numeric', '--no-header', '--processes', 'sport = :3000'])).trim();
      const listeners = rawListeners ? rawListeners.split('\n') : [];
      const match = listeners.length === 1 ? /^LISTEN\s+\d+\s+\d+\s+127\.0\.0\.1:3000\s+(?:0\.0\.0\.0:\*|\*:\*)\s+users:\(\("node",pid=(\d{1,7}),fd=\d+\)\)\s*$/.exec(listeners[0]!) : null;
      const loopbackOnly = match !== null && unit.ActiveState === 'active' && match[1] === unit.MainPID;
      const listener = loopbackOnly ? 'loopback-only' : listeners.length === 0 ? 'absent' : 'unsafe';
      const clock = await this.command('/usr/bin/timedatectl', ['show', '--property=NTPSynchronized', '--value']);
      if (!['yes\n', 'no\n'].includes(clock)) fail('unsafe-installation');
      const serve = JSON.parse(await this.command('/usr/bin/tailscale', ['serve', 'status', '--json'])) as Record<string, unknown>;
      const { TCP, Web, AllowFunnel, ...extra } = serve;
      if (Object.keys(extra).length || JSON.stringify(TCP) !== '{"443":{"HTTPS":true}}' || typeof Web !== 'object' || !Web || Object.keys(Web).length !== 1) fail('unsafe-installation');
      const [name, web] = Object.entries(Web as Record<string, unknown>)[0]!;
      if (!/^[a-z0-9][a-z0-9.-]*\.ts\.net:443$/.test(name) || JSON.stringify(web) !== '{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}' ||
        (AllowFunnel !== undefined && (typeof AllowFunnel !== 'object' || AllowFunnel === null || Object.values(AllowFunnel as Record<string, unknown>).some(v => v !== false)))) fail('unsafe-installation');
      const healthy = unit.ActiveState === 'active' ? await this.health() : false;
      const active = unit.ActiveState === 'active', enabled = unit.UnitFileState === 'enabled';
      return { installation, layout: 'supported', runtime: { executable: '/usr/bin/node', version }, active, enabled,
        permissions: 'restrictive', healthy, loopbackOnly, listener, synchronizedClock: clock === 'yes\n', privateHttps: true,
        ready: active && enabled && healthy && loopbackOnly && clock === 'yes\n' };
    } catch (e) { if (e instanceof HostError) throw e; return fail('unsafe-installation'); }
  }
  /** Stable installed binding, independent of whether automatic service/Serve recovery succeeded. */
  identity(): Installation {
    try { return this.installation(); } catch { return fail('unsafe-installation'); }
  }
  /** Trusted current boot fact; no hostname or process environment is returned. */
  bootId(): string {
    try { return idSchema.parse(this.read('/proc/sys/kernel/random/boot_id', 0o444).trim()); }
    catch { return fail('unsafe-installation'); }
  }
  /** Additional read-only boot recovery fact. Never starts Tailscale or changes Serve. */
  async inspectBoot(): Promise<HostFacts> {
    const facts = await this.inspect();
    try {
      const status = JSON.parse(await this.command('/usr/bin/tailscale', ['status', '--json'])) as { BackendState?: unknown };
      if (status.BackendState !== 'Running') fail('unsafe-installation');
      return facts;
    } catch { return fail('unsafe-installation'); }
  }
  /** Only the explicit reboot coordinator can supply the already-durable pending intent. */
  async reboot(lease: JournalLease, authority: HostAuthority): Promise<void> {
    return this.exclusive(lease, async () => {
      const s = this.authorize(lease, authority, 'reboot'); this.bound(s);
      if (s.stage !== 'reboot' || s.pending?.operation !== 'reboot' || s.reboot?.phase !== 'pending' ||
        s.cleanup.status !== 'verified' || s.pending.caseRequestId !== s.reboot.caseRequestId ||
        this.bootId() !== s.reboot.previousBootId || lease.owner.bootId !== s.reboot.previousBootId) fail('recovery-required');
      if (!(await this.inspectBoot()).ready) fail('unsafe-installation');
      const c = lease.load().cases.find(c => c.requestId === s.reboot!.caseRequestId);
      if (!c || c.phase !== 'confirmed' || c.dueAt <= this.options.clock.now() + 60_000 ||
        this.bootId() !== s.reboot!.previousBootId) fail('recovery-required');
      this.effect(lease);
      await this.command('/usr/bin/systemctl', ['reboot', '--no-ask-password']);
    });
  }
  private authorize(lease: JournalLease, authority: HostAuthority, operation: HostOperation | 'reboot'): Journal {
    const s = lease.load(), a = authority.approval;
    if (authority.nonProduction !== true || authority.hostDisruption !== true || !this.options.privileged() || !this.options.interactive() ||
      a.outcome !== 'approved' || a.runId !== s.runId || a.stage !== s.stage || a.operation !== operation || consumedApprovals.has(a)) fail('unauthorized');
    consumedApprovals.add(a);
    return s;
  }
  private bound(s: Journal): void {
    const current = this.installation();
    if (current.hostFingerprint !== s.installation.hostFingerprint || current.revision !== s.installation.revision || current.unit !== s.installation.unit) fail('unsafe-installation');
  }
  private update(lease: JournalLease, edit: (s: Journal) => void): Journal {
    const s = lease.load(), sequence = s.sequence; s.sequence++; s.updatedAt = Math.max(s.updatedAt, this.options.clock.now()); edit(s);
    if (s.pending) return lease.checkpointMutation(s, sequence, s.pending.id);
    return lease.commit(s, sequence);
  }
  private resolve(lease: JournalLease): Journal {
    const s = lease.load(), sequence = s.sequence, id = s.pending?.id;
    if (!id) return s;
    s.pending = null; s.sequence++; s.updatedAt = Math.max(s.updatedAt, this.options.clock.now());
    return lease.resolveRecovery(s, sequence, id);
  }
  private async exclusive<T>(lease: JournalLease, fn: () => Promise<T>): Promise<T> {
    if (this.busy || activeLeases.has(lease) || runningExecutors.has(this.options.execute)) fail('recovery-required');
    this.busy = true; this.interrupted = false; activeLeases.add(lease);
    try { return await fn(); } catch (e) { if (e instanceof HostError) throw e; return fail('operation-failed'); }
    finally { this.busy = false; activeLeases.delete(lease); }
  }
  private boundary(name: string): void {
    try { this.options.boundary?.(name); } catch { this.interrupted = true; fail('operation-failed'); }
  }
  private effect(lease: JournalLease): void { lease.load(); this.boundary('before-effect'); }
  /** start is only allowed for this run's deliberate stop. It never starts a failed initial preflight. */
  async operate(lease: JournalLease, operation: Exclude<HostOperation, 'restore-model'>, authority: HostAuthority): Promise<void> {
    return this.exclusive(lease, async () => {
      if (!['restart', 'stop', 'start', 'disable-model'].includes(operation)) fail('unauthorized');
      const s = this.authorize(lease, authority, operation); this.bound(s);
      // API pause restoration is independent of owned host restoration. Never clear it here.
      const stoppedDisable = operation === 'disable-model' && s.cleanup.serviceRestoreNeeded && s.cleanup.status === 'restore-needed';
      const pauseOnly = s.cleanup.pauseRestoreNeeded && !s.cleanup.serviceRestoreNeeded && s.cleanup.status === 'restore-needed';
      if (s.pending || s.cleanup.artifacts.length || s.cleanup.daemonReloadNeeded ||
        (operation === 'start' ? !s.cleanup.serviceRestoreNeeded || s.cleanup.status !== 'restore-needed'
          : !stoppedDisable && s.cleanup.status !== 'verified' && !pauseOnly)) fail('recovery-required');
      const facts = await this.inspect();
      if (operation === 'start' || stoppedDisable ? facts.active || !facts.enabled || !facts.synchronizedClock || facts.listener !== 'absent' : !facts.ready) fail('unsafe-installation');
      const id = randomUUID();
      const contents: Record<Kind, string> = {
        'model-environment': `# R2 acceptance ${s.runId} ${id}\nOPENAI_API_KEY=\nOPENAI_MODEL=\n`,
        'model-drop-in': `# R2 acceptance ${s.runId} ${id}\n[Service]\nEnvironmentFile=${artifactPaths['model-environment']}\n`,
      };
      if (operation === 'disable-model') {
        this.directories('/run/systemd/system');
        for (const path of Object.values(artifactPaths)) if (!this.missing(path)) fail('conflict');
      }
      const seq = s.sequence; s.sequence++; s.updatedAt = Math.max(s.updatedAt, this.options.clock.now());
      s.pending = { id, operation, stage: s.stage, at: s.updatedAt, caseLabel: null, caseRequestId: null };
      s.cleanup.status = 'restore-needed'; s.cleanup.serviceRestoreNeeded = true;
      if (operation === 'disable-model') {
        s.cleanup.daemonReloadNeeded = true;
        s.cleanup.artifacts = (['model-environment', 'model-drop-in'] as const).map(kind => ({ kind, fingerprint: hash(contents[kind]), phase: 'create-intent' }));
      }
      this.boundary('before-intent'); lease.beginMutation(s, seq); this.boundary('after-intent');
      try {
        if (operation === 'disable-model') {
          this.effect(lease); this.boundary('before-container');
          // Shared systemd container, never treated as an owned artifact or removed.
          // Its creation is covered by the already-durable drop-in/reload cleanup intent.
          const container = '/run/systemd/system/r2.service.d';
          this.directories(dirname(container));
          try { fs.mkdirSync(this.path(container), { mode: 0o755 }); this.sync(dirname(container)); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
          this.directories(container); this.boundary('after-container');
          for (const kind of ['model-environment', 'model-drop-in'] as const) {
            this.effect(lease); this.boundary(`before-create-${kind}`);
            const path = artifactPaths[kind];
            this.directories(dirname(path));
            const fd = fs.openSync(this.path(path), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
            try { fs.writeFileSync(fd, contents[kind]); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            this.sync(dirname(path)); this.boundary(`after-create-${kind}`);
            this.update(lease, next => { next.cleanup.artifacts.find(a => a.kind === kind)!.phase = 'created'; });
          }
          this.effect(lease); this.boundary('before-reload'); await this.system('daemon-reload'); this.boundary('after-reload');
          await this.unit(true); // Confirm EnvironmentFile append order before restart.
        }
        this.effect(lease); this.boundary('before-service');
        await this.system(operation === 'disable-model' ? stoppedDisable ? 'start' : 'restart' : operation); this.boundary('after-service');
        const actual = await this.unit(operation === 'disable-model');
        if (operation === 'stop' ? actual.ActiveState !== 'inactive' : actual.ActiveState !== 'active' || !await this.health()) fail('operation-failed');
        if (operation === 'restart' || operation === 'start') this.update(lease, next => { next.cleanup.serviceRestoreNeeded = false; next.cleanup.status = next.cleanup.pauseRestoreNeeded ? 'restore-needed' : 'verified'; });
        this.resolve(lease);
      } catch (error) {
        // Never race rollback against an executor that has not acknowledged cancellation.
        if (error instanceof HostError && error.code === 'timeout') {
          try { this.update(lease, next => { next.cleanup.status = 'failed'; }); } catch { /* retain intent */ }
          throw error;
        }
        // A hook models abrupt death and must leave the durable intent untouched.
        // Ordinary external failures are reconciled now; a failed recovery remains durable.
        if (this.interrupted) throw new HostError('operation-failed');
        await this.cleanup(lease);
        fail('operation-failed');
      }
    });
  }
  /** Fresh restore-model approval; works with a stopped service or missing /run files after reboot.
   * Does not replay an interrupted restart/disable. API pause restoration belongs to the coordinator. */
  async recover(lease: JournalLease, authority: HostAuthority): Promise<RecoveryResult> {
    return this.exclusive(lease, async () => {
      const s = this.authorize(lease, authority, 'restore-model'); this.bound(s);
      if (s.pending && !['restart', 'start', 'stop', 'disable-model', 'restore-model'].includes(s.pending.operation)) fail('recovery-required');
      return this.cleanup(lease);
    });
  }
  private async cleanup(lease: JournalLease): Promise<RecoveryResult> {
    let status: CleanupIntent['status'] = 'failed';
    try {
      let initial = lease.load(); this.bound(initial);
      if (initial.cleanup.status === 'verified' && !initial.pending) return { status: 'restored-and-verified', instruction: 'none' };
      if (!initial.cleanup.serviceRestoreNeeded && !initial.cleanup.daemonReloadNeeded && !initial.cleanup.artifacts.length && initial.cleanup.pauseRestoreNeeded) {
        return { status: 'restore-needed', instruction: 'none' };
      }
      if (!initial.pending) {
        const seq = initial.sequence; initial.sequence++; initial.updatedAt = Math.max(initial.updatedAt, this.options.clock.now());
        initial.pending = { id: randomUUID(), operation: 'restore-model', stage: initial.stage, at: initial.updatedAt, caseLabel: null, caseRequestId: null };
        initial.cleanup.status = 'restore-needed'; initial.cleanup.serviceRestoreNeeded = true;
        lease.beginMutation(initial, seq);
        initial = lease.load();
      }
      // Validate every artifact before removing any. Preserve changed files, links and unknown drop-ins.
      for (const a of initial.cleanup.artifacts) {
        const path = artifactPaths[a.kind];
        if (!this.missing(path) && hash(this.read(path, 0o600)) !== a.fingerprint) fail('conflict');
      }
      // A killed systemctl client can leave a systemd job running. Require a settled unit
      // before touching files, accepting only the known original or runner-loaded state.
      await this.unit('recovery');
      for (const a of initial.cleanup.artifacts) {
        this.update(lease, s => { s.cleanup.artifacts.find(v => v.kind === a.kind)!.phase = 'remove-intent'; });
        this.effect(lease); this.boundary(`before-remove-${a.kind}`);
        const path = artifactPaths[a.kind];
        if (!this.missing(path)) {
          if (hash(this.read(path, 0o600)) !== a.fingerprint) fail('conflict');
          fs.unlinkSync(this.path(path)); this.sync(dirname(path));
        }
        this.boundary(`after-remove-${a.kind}`);
        this.update(lease, s => { s.cleanup.artifacts = s.cleanup.artifacts.filter(v => v.kind !== a.kind); });
      }
      const s = lease.load();
      if (s.cleanup.daemonReloadNeeded) {
        this.effect(lease); this.boundary('before-cleanup-reload'); await this.system('daemon-reload'); this.boundary('after-cleanup-reload');
      }
      await this.unit(false);
      if (s.cleanup.serviceRestoreNeeded) {
        this.effect(lease); this.boundary('before-cleanup-service'); await this.system('restart'); this.boundary('after-cleanup-service');
      }
      const actual = await this.unit(false);
      if (actual.ActiveState !== 'active' || !await this.health()) fail('operation-failed');
      this.update(lease, next => {
        next.cleanup.serviceRestoreNeeded = false; next.cleanup.daemonReloadNeeded = false;
        next.cleanup.status = next.cleanup.pauseRestoreNeeded ? 'restore-needed' : 'verified';
      });
      this.resolve(lease);
      return { status: lease.load().cleanup.status === 'verified' ? 'restored-and-verified' : 'restore-needed', instruction: 'none' };
    } catch (e) {
      status = e instanceof HostError && ['conflict', 'unsafe-installation'].includes(e.code) ? 'conflict' : 'failed';
      // Never clear ownership/flags on persistence uncertainty or failed health.
      try { this.update(lease, s => { s.cleanup.status = status; }); } catch { /* retain last durable recovery intent */ }
      return { status, instruction: status === 'conflict' ? 'inspect-owned-artifacts' : 'retry-recovery' };
    }
  }
}
