import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { AcceptanceHost, HostError, type CommandRequest, type HostAuthority, type HostOptions } from '../scripts/acceptance/host.ts';
import { fixture } from './acceptance-fixtures.ts';
import { markdownReport } from '../scripts/acceptance/report.ts';

const canary = 'PRIVATE_CANARY_KEY_AND_PATH';
const cleanups: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup() {
  const root = fs.mkdtempSync(join(tmpdir(), 'r2-host-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = (p: string) => join(root, p);
  const write = (p: string, bytes: string, mode = 0o644) => {
    fs.mkdirSync(dirname(path(p)), { recursive: true, mode: 0o755 }); fs.writeFileSync(path(p), bytes, { mode });
  };
  fs.mkdirSync(path('/run/systemd/system/r2.service.d'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path('/var/lib/r2'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path('/etc/r2'), { recursive: true, mode: 0o700 });
  write('/etc/r2/r2.env', `OPENAI_API_KEY=${canary}\nOPENAI_MODEL=synthetic-model\nR2_PASSWORD_HASH=${canary}\n`, 0o600);
  const originalUnit = fs.readFileSync(new URL('../deploy/r2.service', import.meta.url), 'utf8');
  write('/etc/systemd/system/r2.service', originalUnit);
  write('/opt/r2/.r2-revision', 'b'.repeat(40) + '\n');
  write('/etc/machine-id', 'c'.repeat(32) + '\n');
  write('/usr/bin/node', 'synthetic binary', 0o755);
  fs.mkdirSync(path('/proc/123'), { recursive: true }); fs.symlinkSync('/usr/bin/node', path('/proc/123/exe'));
  const envPath = '/run/r2-acceptance-model.env', dropPath = '/run/systemd/system/r2.service.d/90-r2-acceptance.conf';
  const calls: CommandRequest[] = [];
  let active = true, loaded = false, healthy = true, effectiveModel = true;
  let job = '0';
  let extraDrop = '', extraEnvironment = '', listener: string | undefined;
  let serve: unknown = { TCP: { '443': { HTTPS: true } }, Web: { 'test.synthetic.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  let commandFault: ((r: CommandRequest) => void) | undefined;
  const execute = vi.fn(async (r: CommandRequest) => {
    calls.push(r); commandFault?.(r);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (r.executable === '/usr/bin/systemctl') {
      const op = r.args[0];
      if (op === 'show') return ok(Object.entries({
        Id: 'r2.service', FragmentPath: '/etc/systemd/system/r2.service', DropInPaths: [loaded ? dropPath : '', extraDrop].filter(Boolean).join(' '),
        User: 'r2', Group: 'r2', WorkingDirectory: '/opt/r2',
        EnvironmentFiles: '/etc/r2/r2.env (ignore_errors=no)' + (loaded ? ` ${envPath} (ignore_errors=no)` : '') + extraEnvironment,
        ExecStart: '{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/r2/dist/server/main.js ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=123 ; code=(null) ; status=0/0 }',
        ReadWritePaths: '/var/lib/r2', ActiveState: active ? 'active' : 'inactive', UnitFileState: 'enabled', MainPID: active ? '123' : '0', Job: job,
      }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
      if (op === 'daemon-reload') loaded = fs.existsSync(path(dropPath));
      else if (op === 'restart' || op === 'start') {
        active = true;
        // A synthetic systemd evaluator: EnvironmentFile assignments override Environment= and earlier files.
        let key = canary, model = 'synthetic-model';
        if (loaded) {
          const drop = fs.readFileSync(path(dropPath), 'utf8');
          expect(drop).toContain(`EnvironmentFile=${envPath}`);
          expect(drop).not.toContain('Environment=');
          const bytes = fs.readFileSync(path(envPath), 'utf8');
          for (const line of bytes.split('\n')) {
            if (line.startsWith('OPENAI_API_KEY=')) key = line.slice('OPENAI_API_KEY='.length);
            if (line.startsWith('OPENAI_MODEL=')) model = line.slice('OPENAI_MODEL='.length);
          }
        }
        effectiveModel = key !== '' && model !== '';
      } else if (op === 'stop') active = false;
      else throw Error('unexpected command');
      return ok();
    }
    if (r.executable === '/usr/bin/node') return ok('v24.20.0\n');
    if (r.executable === '/usr/bin/ss') return ok(listener ?? (active ? 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=123,fd=20))\n' : ''));
    if (r.executable === '/usr/bin/timedatectl') return ok('yes\n');
    if (r.executable === '/usr/bin/tailscale' && r.args[0] === 'status') return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'test.synthetic.ts.net.' } }));
    if (r.executable === '/usr/bin/tailscale') return ok(JSON.stringify(serve));
    if (r.executable === '/usr/bin/curl') return ok(healthy ? '{"status":"ok"}' : '{"status":"error"}');
    throw Error(canary);
  });
  const f = fixture(); cleanups.push(f.remove);
  f.state.installation.hostFingerprint = createHash('sha256').update('c'.repeat(32)).digest('hex');
  const lease = f.registry.acquire(f.state.installation, f.owner); lease.create(f.state);
  const options: HostOptions = { root, execute, clock: { now: () => f.state.updatedAt + 1000 },
    privileged: () => true, interactive: () => true, rootUid: process.getuid!(), serviceUid: process.getuid!() };
  const host = () => new AcceptanceHost(options);
  const authority = (operation: HostAuthority['approval']['operation']): HostAuthority => ({ nonProduction: true, hostDisruption: true,
    approval: { runId: f.state.runId, stage: lease.load().stage, operation, outcome: 'approved' } });
  return { ...f, root, path, write, calls, execute, options, host, lease, authority, envPath, dropPath, originalUnit,
    setJob: (v: string) => { job = v; },
    setActive: (v: boolean) => { active = v; }, setHealthy: (v: boolean) => { healthy = v; },
    setListener: (v: string) => { listener = v; }, setServe: (v: unknown) => { serve = v; },
    setExtraDrop: (v: string) => { extraDrop = v; }, setExtraEnvironment: (v: string) => { extraEnvironment = v; },
    fault: (v: typeof commandFault) => { commandFault = v; }, model: () => effectiveModel,
    reboot: () => { fs.rmSync(path('/run'), { recursive: true }); loaded = false; active = true; },
  };
}
function mutations(f: ReturnType<typeof setup>) { return f.calls.filter(c => c.executable === '/usr/bin/systemctl' && c.args[0] !== 'show'); }

describe('host inspection', () => {
  it('returns bounded typed facts, uses actual service executable and never mutates or reads the secret env', async () => {
    const f = setup(); const spy = vi.spyOn(fs, 'openSync');
    const previous = process.env.PATH; process.env.PATH = '/misleading/node22';
    try {
      const facts = await f.host().inspect(); expect(facts.ready).toBe(true); expect(facts.runtime.version).toBe('v24.20.0');
      expect(mutations(f)).toEqual([]); expect(JSON.stringify(facts)).not.toContain(canary);
      expect(spy.mock.calls.some(c => c[0] === f.path('/etc/r2/r2.env'))).toBe(false);
      for (const c of f.calls) {
        expect(c.timeoutMs).toBe(10_000); expect(c.maxBytes).toBe(16_384); expect(c.env.PATH).toBe('/usr/bin');
        expect(c.args.join(' ')).not.toContain(canary); expect(c.executable.startsWith('/usr/bin/')).toBe(true);
      }
    } finally { process.env.PATH = previous; spy.mockRestore(); }
  });
  it('derives a runtime-only origin using the same Serve validation as inspection', async () => {
    const f = setup();
    expect(await f.host().privateOrigin()).toBe('https://test.synthetic.ts.net');
    f.setServe({ TCP: { '443': { HTTPS: true } }, Web: { 'test.synthetic.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } });
    await expect(f.host().privateOrigin()).rejects.toMatchObject({ code: 'unsafe-installation' });
    f.setServe({ TCP: { '443': { HTTPS: true } }, Web: { 'other.synthetic.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } });
    await expect(f.host().privateOrigin()).rejects.toMatchObject({ code: 'unsafe-installation' });
    expect(mutations(f)).toEqual([]);
  });
  it.each(['revision', 'unit', 'process', 'config-mode', 'data-mode', 'extra-drop', 'extra-env', 'serve', 'funnel'])('blocks unsupported %s', async kind => {
    const f = setup();
    if (kind === 'revision') f.write('/opt/r2/.r2-revision', 'unknown');
    if (kind === 'unit') f.write('/etc/systemd/system/r2.service', '[Service]\nExecStart=/some/node\n');
    if (kind === 'process') { fs.unlinkSync(f.path('/proc/123/exe')); fs.symlinkSync('/different/node', f.path('/proc/123/exe')); }
    if (kind === 'config-mode') fs.chmodSync(f.path('/etc/r2/r2.env'), 0o644);
    if (kind === 'data-mode') fs.chmodSync(f.path('/var/lib/r2'), 0o755);
    if (kind === 'extra-drop') f.setExtraDrop('/etc/systemd/system/r2.service.d/operator.conf');
    if (kind === 'extra-env') f.setExtraEnvironment(' /private/another.env (ignore_errors=no)');
    if (kind === 'serve') f.setServe({ TCP: { '80': { HTTP: true } } });
    if (kind === 'funnel') f.setServe({ TCP: { '443': { HTTPS: true } }, Web: { 'test.synthetic.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, AllowFunnel: { 'test.synthetic.ts.net:443': true } });
    await expect(f.host().inspect()).rejects.toBeInstanceOf(HostError); expect(mutations(f)).toEqual([]);
  });
  it('extra public or duplicate listeners block readiness and mutation', async () => {
    const f = setup(); f.setListener('LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\n');
    expect((await f.host().inspect()).ready).toBe(false);
    await expect(f.host().operate(f.lease, 'restart', f.authority('restart'))).rejects.toBeInstanceOf(HostError);
    expect(mutations(f)).toEqual([]);
  });
  it('does not mistake another process for the service listener', async () => {
    const f = setup(); f.setListener('LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=999,fd=20))\n');
    const facts = await f.host().inspect(); expect(facts.ready).toBe(false); expect(facts.listener).toBe('unsafe');
    await expect(f.host().operate(f.lease, 'restart', f.authority('restart'))).rejects.toBeInstanceOf(HostError);
    expect(mutations(f)).toEqual([]);
  });
  it('sanitizes raw failures, invalid DTOs and output overflow', async () => {
    for (const response of [{ code: 1, stdout: '', stderr: canary }, { code: 0, stdout: canary.repeat(20_000), stderr: '' }, { code: 0, stdout: canary, stderr: '' }]) {
      const f = setup(); f.options.execute = async () => response;
      await expect(f.host().inspect()).rejects.not.toThrow(canary);
    }
  });
  it('aborts a stalled command with a fixed deadline', async () => {
    vi.useFakeTimers(); const f = setup(); let signal: AbortSignal | undefined;
    f.options.execute = async r => { signal = r.signal; return new Promise(() => {}); };
    const result = f.host().inspect().catch(e => e); await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).code).toBe('timeout'); expect(signal?.aborted).toBe(true);
  });
});

describe('guarded operations and precedence', () => {
  it.each(['ack', 'flag', 'tty', 'approval', 'run', 'stage', 'operation', 'privilege', 'lock'])('missing %s prevents every mutation', async kind => {
    const f = setup(); const a = f.authority('disable-model');
    if (kind === 'ack') a.nonProduction = false;
    if (kind === 'flag') a.hostDisruption = false;
    if (kind === 'tty') f.options.interactive = () => false;
    if (kind === 'approval') a.approval.outcome = 'declined';
    if (kind === 'run') a.approval.runId = randomUUID();
    if (kind === 'stage') a.approval.stage = 'case-a';
    if (kind === 'operation') a.approval.operation = 'stop';
    if (kind === 'privilege') f.options.privileged = () => false;
    if (kind === 'lock') f.lease.release();
    await expect(f.host().operate(f.lease, 'disable-model', a)).rejects.toBeInstanceOf(HostError);
    expect(mutations(f)).toEqual([]); expect(fs.existsSync(f.path(f.envPath))).toBe(false);
  });
  it('rejects runtime operation values outside the fixed command catalog', async () => {
    const f = setup();
    await expect(f.host().operate(f.lease, 'reboot' as 'restart', f.authority('reboot'))).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.calls).toEqual([]);
  });
  it('never starts an initially stopped service', async () => {
    const f = setup(); f.setActive(false);
    for (const op of ['restart', 'stop', 'start', 'disable-model'] as const) await expect(f.host().operate(f.lease, op, f.authority(op))).rejects.toBeInstanceOf(HostError);
    expect(mutations(f)).toEqual([]);
  });
  it('disables with final EnvironmentFile precedence and restores without editing installed files', async () => {
    const f = setup(), h = f.host(); const original = fs.readFileSync(f.path('/etc/r2/r2.env'), 'utf8');
    const a = f.authority('disable-model'); await h.operate(f.lease, 'disable-model', a);
    expect(f.model()).toBe(false); expect(f.lease.load().cleanup.status).toBe('restore-needed');
    expect(f.lease.load().pending).toBeNull(); expect(f.lease.load().cleanup.artifacts.every(v => v.phase === 'created')).toBe(true);
    await expect(h.operate(f.lease, 'disable-model', a)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(h.operate(f.lease, 'restart', f.authority('restart'))).rejects.toBeInstanceOf(HostError);
    expect(await h.recover(f.lease, f.authority('restore-model'))).toEqual({ status: 'restored-and-verified', instruction: 'none' });
    expect(f.model()).toBe(true); expect(f.lease.load().cleanup.status).toBe('verified');
    expect(fs.readFileSync(f.path('/etc/r2/r2.env'), 'utf8')).toBe(original);
    expect(fs.readFileSync(f.path('/etc/systemd/system/r2.service'), 'utf8')).toBe(f.originalUnit);
    expect(fs.existsSync(f.path(f.envPath))).toBe(false); expect(fs.existsSync(f.path(f.dropPath))).toBe(false);
    const count = mutations(f).length; await h.recover(f.lease, f.authority('restore-model')); expect(mutations(f)).toHaveLength(count);
    expect(JSON.stringify(f.lease.load()) + markdownReport(f.lease.load())).not.toContain(canary);
  });
  it('creates a missing shared drop-in container only after durable intent and never removes it', async () => {
    const f = setup(); fs.rmdirSync(f.path('/run/systemd/system/r2.service.d'));
    f.options.boundary = name => {
      if (name === 'before-container') {
        expect(f.lease.load().pending?.operation).toBe('disable-model');
        expect(f.lease.load().cleanup.artifacts).toHaveLength(2);
        expect(fs.existsSync(f.path('/run/systemd/system/r2.service.d'))).toBe(false);
      }
    };
    await f.host().operate(f.lease, 'disable-model', f.authority('disable-model'));
    expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('restored-and-verified');
    expect(fs.readdirSync(f.path('/run/systemd/system/r2.service.d'))).toEqual([]);
  });
  it('stop/start retains restore intent and restart verifies generic health', async () => {
    const f = setup(), h = f.host();
    await h.operate(f.lease, 'stop', f.authority('stop')); expect(f.lease.load().cleanup.serviceRestoreNeeded).toBe(true);
    await h.operate(f.lease, 'start', f.authority('start')); expect(f.lease.load().cleanup.status).toBe('verified');
    await h.operate(f.lease, 'restart', f.authority('restart')); expect(f.lease.load().cleanup.status).toBe('verified');
  });
  it.each(['file', 'symlink', 'directory'])('preserves a pre-existing %s', async kind => {
    const f = setup();
    if (kind === 'file') f.write(f.envPath, canary, 0o600);
    if (kind === 'symlink') fs.symlinkSync(f.path('/etc/r2/r2.env'), f.path(f.envPath));
    if (kind === 'directory') fs.mkdirSync(f.path(f.envPath));
    await expect(f.host().operate(f.lease, 'disable-model', f.authority('disable-model'))).rejects.toBeInstanceOf(HostError);
    expect(fs.lstatSync(f.path(f.envPath))).toBeDefined(); expect(mutations(f)).toEqual([]); expect(f.lease.load().cleanup.status).toBe('verified');
  });
});

const creationBoundaries = ['before-intent', 'after-intent', 'before-container', 'after-container', 'before-create-model-environment', 'after-create-model-environment',
  'before-create-model-drop-in', 'after-create-model-drop-in', 'before-reload', 'after-reload', 'before-service', 'after-service'];
describe('interruption and recovery', () => {
  it.each(creationBoundaries)('recovers interrupted disable at %s without replay', async point => {
    const f = setup(); f.options.boundary = name => { if (name === point) throw Error(canary); };
    await expect(f.host().operate(f.lease, 'disable-model', f.authority('disable-model'))).rejects.not.toThrow(canary);
    if (point === 'before-intent') { expect(f.lease.load().cleanup.status).toBe('verified'); expect(mutations(f)).toEqual([]); }
    else expect(f.lease.load().pending?.operation).toBe('disable-model');
    f.options.boundary = undefined;
    expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('restored-and-verified');
    expect(f.lease.load().pending).toBeNull(); expect(f.model()).toBe(true);
    expect(fs.existsSync(f.path(f.envPath))).toBe(false); expect(fs.existsSync(f.path(f.dropPath))).toBe(false);
  });
  it.each(['before-remove-model-environment', 'after-remove-model-environment', 'before-remove-model-drop-in', 'after-remove-model-drop-in',
    'before-cleanup-reload', 'after-cleanup-reload', 'before-cleanup-service', 'after-cleanup-service'])('retries cleanup interruption at %s', async point => {
    const f = setup(); await f.host().operate(f.lease, 'disable-model', f.authority('disable-model'));
    f.options.boundary = name => { if (name === point) throw Error(canary); };
    expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('failed');
    expect(f.lease.load().cleanup.status).toBe('failed'); f.options.boundary = undefined;
    expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('restored-and-verified');
  });
  it.each(['restart', 'daemon-reload'])('rolls back ordinary %s failure automatically', async operation => {
    const f = setup(); let once = false;
    f.fault(r => { if (r.args[0] === operation && !once) { once = true; throw Error(canary); } });
    await expect(f.host().operate(f.lease, 'disable-model', f.authority('disable-model'))).rejects.toMatchObject({ code: 'operation-failed' });
    expect(f.lease.load().cleanup.status).toBe('verified'); expect(f.model()).toBe(true);
  });
  it.each(['edit', 'symlink', 'hardlink', 'permissions'])('preserves operator %s and reports conflict without secret content', async kind => {
    const f = setup(); await f.host().operate(f.lease, 'disable-model', f.authority('disable-model'));
    if (kind === 'edit') fs.appendFileSync(f.path(f.envPath), canary);
    if (kind === 'symlink') { fs.unlinkSync(f.path(f.envPath)); fs.symlinkSync(f.path('/etc/r2/r2.env'), f.path(f.envPath)); }
    if (kind === 'hardlink') fs.linkSync(f.path(f.envPath), f.path('/run/operator-copy'));
    if (kind === 'permissions') fs.chmodSync(f.path(f.envPath), 0o644);
    const count = mutations(f).length; const result = await f.host().recover(f.lease, f.authority('restore-model'));
    expect(result).toEqual({ status: 'conflict', instruction: 'inspect-owned-artifacts' }); expect(mutations(f)).toHaveLength(count);
    expect(fs.existsSync(f.path(f.dropPath))).toBe(true); expect(f.lease.load().cleanup.status).toBe('conflict');
    expect(JSON.stringify(result) + JSON.stringify(f.lease.load()) + markdownReport(f.lease.load())).not.toContain(canary);
  });
  it('reconciles missing runtime artifacts after reboot without recreating them', async () => {
    const f = setup(); await f.host().operate(f.lease, 'disable-model', f.authority('disable-model')); f.reboot();
    expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('restored-and-verified');
    expect(fs.existsSync(f.path(f.envPath))).toBe(false); expect(f.lease.load().cleanup.artifacts).toEqual([]);
  });
  it('keeps health failure failed, retaining recovery and lock', async () => {
    const f = setup(); await f.host().operate(f.lease, 'disable-model', f.authority('disable-model')); f.setHealthy(false);
    expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('failed');
    expect(f.lease.load().cleanup.serviceRestoreNeeded).toBe(true); expect(() => f.lease.release()).toThrow();
    expect(markdownReport(f.lease.load())).toContain('Overall: fail');
  });
  it('blocks a still-pending systemd job, including after a systemctl timeout', async () => {
    const f = setup(); f.setJob('123');
    await expect(f.host().inspect()).rejects.toMatchObject({ code: 'unsafe-installation' });
    expect(mutations(f)).toEqual([]);
    f.setJob('0'); await f.host().operate(f.lease, 'disable-model', f.authority('disable-model'));
    f.setJob('123'); const before = mutations(f).filter(c => c.args[0] === 'restart').length;
    expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('conflict');
    expect(mutations(f).filter(c => c.args[0] === 'restart')).toHaveLength(before);
    f.setJob('0'); expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('restored-and-verified');
  });
  it('preserves unknown operator drop-ins and blocks restart during cleanup', async () => {
    const f = setup(); await f.host().operate(f.lease, 'disable-model', f.authority('disable-model'));
    f.setExtraDrop('/run/systemd/system/r2.service.d/operator.conf');
    const count = mutations(f).filter(c => c.args[0] === 'restart').length;
    expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('conflict');
    expect(mutations(f).filter(c => c.args[0] === 'restart')).toHaveLength(count);
  });
  it('guards recovery with fresh flags, TTY and operation-scoped approval', async () => {
    const f = setup(); await f.host().operate(f.lease, 'disable-model', f.authority('disable-model'));
    const count = mutations(f).length;
    const a = f.authority('restart');
    await expect(f.host().recover(f.lease, a)).rejects.toMatchObject({ code: 'unauthorized' });
    f.options.interactive = () => false;
    await expect(f.host().recover(f.lease, f.authority('restore-model'))).rejects.toMatchObject({ code: 'unauthorized' });
    expect(mutations(f)).toHaveLength(count); expect(fs.existsSync(f.path(f.envPath))).toBe(true);
  });
  it('does not race recovery against an unacknowledged mutation timeout', async () => {
    vi.useFakeTimers(); const f = setup(); const execute = f.options.execute;
    let release: (() => void) | undefined;
    f.options.execute = async r => {
      if (r.executable === '/usr/bin/systemctl' && r.args[0] === 'restart') await new Promise<void>(resolve => { release = resolve; });
      return execute(r);
    };
    const h = f.host(); const result = h.operate(f.lease, 'restart', f.authority('restart')).catch(e => e);
    await vi.advanceTimersByTimeAsync(10_000); expect((await result).code).toBe('timeout');
    expect(f.lease.load().cleanup.status).toBe('failed');
    await expect(f.host().recover(f.lease, f.authority('restore-model'))).rejects.toMatchObject({ code: 'recovery-required' });
    release!(); await vi.advanceTimersByTimeAsync(0);
    // The late result cannot clear the journal or declare success.
    expect(f.lease.load().pending?.operation).toBe('restart');
    f.options.execute = execute;
    expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('restored-and-verified');
  });
  it.each([1, 2])('reconciles artifact checkpoint %s persistence failure before and after commit', async index => {
    for (const after of [false, true]) {
      const f = setup(); const checkpoint = f.lease.checkpointMutation.bind(f.lease); let count = 0;
      vi.spyOn(f.lease, 'checkpointMutation').mockImplementation((...args) => {
        if (++count === index) { if (after) checkpoint(...args); throw Error(canary); }
        return checkpoint(...args);
      });
      await expect(f.host().operate(f.lease, 'disable-model', f.authority('disable-model'))).rejects.not.toThrow(canary);
      expect(f.lease.load().cleanup.status).toBe('verified'); expect(f.lease.load().pending).toBeNull();
      expect(fs.existsSync(f.path(f.envPath))).toBe(false); expect(fs.existsSync(f.path(f.dropPath))).toBe(false);
    }
  });
  it.each([1, 2, 3, 4, 5])('retains and retries cleanup checkpoint %s failures before/after commit', async index => {
    for (const after of [false, true]) {
      const f = setup(); await f.host().operate(f.lease, 'disable-model', f.authority('disable-model'));
      const checkpoint = f.lease.checkpointMutation.bind(f.lease); let count = 0;
      vi.spyOn(f.lease, 'checkpointMutation').mockImplementation((...args) => {
        if (++count === index) { if (after) checkpoint(...args); throw Error(canary); }
        return checkpoint(...args);
      });
      expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('failed');
      expect(f.lease.load().cleanup.status).toBe('failed');
      expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('restored-and-verified');
      expect(f.lease.load().pending).toBeNull(); expect(f.model()).toBe(true);
    }
  });
  it.each(['before', 'after'])('reconciles resolve failure %s journal commit', async point => {
    const f = setup(); const resolve = f.lease.resolveRecovery.bind(f.lease); let once = false;
    vi.spyOn(f.lease, 'resolveRecovery').mockImplementation((...args) => {
      if (!once) { once = true; if (point === 'after') resolve(...args); throw Error(canary); }
      return resolve(...args);
    });
    await expect(f.host().operate(f.lease, 'disable-model', f.authority('disable-model'))).rejects.not.toThrow(canary);
    expect(f.lease.load().cleanup.status).toBe('verified'); expect(f.model()).toBe(true);
  });
  it('rejects concurrent runs and concurrent operations', async () => {
    const f = setup(); expect(() => f.registry.acquire(f.state.installation, { ...f.owner, token: randomUUID(), runId: randomUUID() })).toThrow();
    const h = f.host(); const first = h.operate(f.lease, 'disable-model', f.authority('disable-model'));
    await expect(h.operate(f.lease, 'stop', f.authority('stop'))).rejects.toMatchObject({ code: 'recovery-required' });
    await expect(f.host().recover(f.lease, f.authority('restore-model'))).rejects.toMatchObject({ code: 'recovery-required' }); await first;
  });
  it.each(['before', 'after'])('journal begin failure %s commit permits no effects; explicit recovery reconciles', async point => {
    const f = setup(); const begin = f.lease.beginMutation.bind(f.lease);
    vi.spyOn(f.lease, 'beginMutation').mockImplementation((...args) => { if (point === 'after') begin(...args); throw Error(canary); });
    await expect(f.host().operate(f.lease, 'disable-model', f.authority('disable-model'))).rejects.not.toThrow(canary);
    expect(mutations(f)).toEqual([]); expect(fs.existsSync(f.path(f.envPath))).toBe(false);
    expect((await f.host().recover(f.lease, f.authority('restore-model'))).status).toBe('restored-and-verified');
  });
  it('a partially written artifact is not deleted on a guessed ownership match', async () => {
    const f = setup(); const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[1] === 'string' && args[1].includes('# R2 acceptance')) { write(args[0], '# partial'); throw Error(canary); }
      return write(...args);
    });
    try {
      await expect(f.host().operate(f.lease, 'disable-model', f.authority('disable-model'))).rejects.toBeInstanceOf(HostError);
      expect(f.lease.load().cleanup.status).toBe('conflict'); expect(fs.readFileSync(f.path(f.envPath), 'utf8')).toBe('# partial');
    } finally { vi.restoreAllMocks(); }
  });
});
