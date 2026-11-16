import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AcceptanceApi } from './api.ts';
import { AcceptanceError, classifyOwner, idSchema, type Journal, type LockOwner } from './contracts.ts';
import { AcceptanceHost, type CommandExecutor } from './host.ts';
import { AcceptanceReboot } from './reboot.ts';
import { AcceptanceRunner } from './runner.ts';
import { AcceptanceRegistry } from './state.ts';
import { interruptPrompt, passwordPrompt, prompt } from './prompts.ts';

const help = `R2 acceptance (installed non-production host only)
  npm run acceptance -- --help
  npm run acceptance -- --preflight
  npm run acceptance -- --live --non-production --allow-service-disruption
  npm run acceptance -- --resume RUN-ID --non-production --allow-service-disruption
  npm run acceptance -- --recover RUN-ID --non-production --allow-service-disruption
  npm run acceptance -- --retry RUN-ID --non-production --allow-service-disruption
  npm run acceptance -- --export RUN-ID
  npm run acceptance -- --reboot RUN-ID --non-production --allow-service-disruption
  npm run acceptance -- --reboot-resume RUN-ID --non-production --allow-service-disruption
No default approves changes. Live work costs model quota and creates permanent reminders.
SIGKILL cannot clean up; use --recover with the displayed run ID. No credentials in arguments.
`;
type Mode = 'preflight' | 'live' | 'resume' | 'recover' | 'retry' | 'export' | 'reboot' | 'reboot-resume';
function parse(args: string[]): { mode: Mode; runId?: string; disruption: boolean } | 'help' {
  if (args.length === 1 && args[0] === '--help') return 'help';
  let mode: Mode | undefined, runId: string | undefined, nonProduction = false, disruption = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--non-production' && !nonProduction) nonProduction = true;
    else if (a === '--allow-service-disruption' && !disruption) disruption = true;
    else if (['--preflight', '--live', '--resume', '--recover', '--retry', '--export', '--reboot', '--reboot-resume'].includes(a) && !mode) {
      mode = a.slice(2) as Mode;
      if (!['preflight', 'live'].includes(mode)) { runId = args[++i]; if (!idSchema.safeParse(runId).success) throw Error(); }
    } else throw Error();
  }
  mode ??= 'preflight';
  if (['preflight', 'export'].includes(mode) ? nonProduction || disruption : !nonProduction || (['recover', 'retry', 'reboot', 'reboot-resume'].includes(mode) && !disruption)) throw Error();
  return { mode, runId, disruption };
}
const clock = { now: () => Date.now() };
const execute: CommandExecutor = request => new Promise((resolve, reject) => {
  const child = spawn(request.executable, [...request.args], { shell: false, env: request.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', bytes = 0, failed = false;
  const stop = () => { failed = true; child.kill('SIGKILL'); };
  const collect = (which: 'out' | 'err', chunk: Buffer) => { bytes += chunk.length; if (bytes > request.maxBytes) stop(); else if (which === 'out') out += chunk.toString(); else err += chunk.toString(); };
  child.stdout.on('data', (b: Buffer) => collect('out', b)); child.stderr.on('data', (b: Buffer) => collect('err', b));
  request.signal.addEventListener('abort', stop, { once: true });
  child.on('error', () => { failed = true; });
  child.on('close', code => { request.signal.removeEventListener('abort', stop); if (failed || code === null) reject(Error('command failed')); else resolve({ code, stdout: out, stderr: err }); });
});
function processStart(pid: number): string | 'absent' | null {
  try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'); const end = text.lastIndexOf(')'); const fields = text.slice(end + 2).split(' '); const value = fields[19]; return end < 0 || !value || !/^\d+$/.test(value) ? null : value; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    // hidepid and permission restrictions can make a live process invisible in /proc.
    try { process.kill(pid, 0); return null; }
    catch (probe) { return (probe as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : null; }
  }
}
function serviceUid(): number {
  const matches = readFileSync('/etc/passwd', 'utf8').split('\n').filter(s => s.startsWith('r2:')).map(s => s.split(':')[2]);
  if (matches.length !== 1 || !/^\d+$/.test(matches[0]!)) throw Error();
  return Number(matches[0]);
}
export async function recoverySafeApi(host: Pick<AcceptanceHost, 'privateOrigin'>, allowOffline: boolean): Promise<AcceptanceApi> {
  try { return new AcceptanceApi(await host.privateOrigin()); }
  catch (error) {
    if (!allowOffline) throw error;
    // This fallback cannot send credentials or make any network request.
    return new AcceptanceApi('https://unavailable.invalid', { fetch: async () => { throw new Error('offline'); } });
  }
}
const wait = { until: async (at: number, signal?: AbortSignal) => { while (Date.now() < at) await new Promise<void>((resolve, reject) => { if (signal?.aborted) return reject(Error()); const timer = setTimeout(done, Math.min(at - Date.now(), 60_000)); function done() { signal?.removeEventListener('abort', abort); resolve(); } function abort() { clearTimeout(timer); reject(Error()); } signal?.addEventListener('abort', abort, { once: true }); }); } };
export interface CliAdapters {
  host: AcceptanceHost;
  registry: AcceptanceRegistry;
  api: AcceptanceApi;
  clock: typeof clock;
  wait: typeof wait;
  prompt: typeof prompt;
  passwordPrompt: typeof passwordPrompt;
  interactive: () => boolean;
  processStart: typeof processStart;
}
/** Test adapters are supplied only by an importing fixture, never through CLI flags or environment. */
export async function main(args = process.argv.slice(2), injected?: CliAdapters) {
  let options: ReturnType<typeof parse>;
  try { options = parse(args); } catch { console.error('Invalid or incompatible arguments. See --help.'); process.exitCode = 2; return; }
  if (options === 'help') { console.log(help); return; }
  const interactive = injected?.interactive ?? (() => !!process.stdin.isTTY && !!process.stdout.isTTY);
  if (!['preflight', 'export'].includes(options.mode) && !interactive()) { console.error('Live operations require an interactive terminal; piped approvals and secrets are refused.'); process.exitCode = 2; return; }
  const actualClock = injected?.clock ?? clock;
  const actualWait = injected?.wait ?? wait;
  const actualPrompt = injected?.prompt ?? prompt;
  const host = injected?.host ?? new AcceptanceHost({ root: '/', execute, clock: actualClock, serviceUid: serviceUid(), privileged: () => process.geteuid?.() === 0, interactive });
  const installation = host.identity(), bootId = host.bootId();
  if (options.mode === 'preflight') {
    const facts = await host.inspect(); const api = injected?.api ?? new AcceptanceApi(await host.privateOrigin());
    console.log(`Host ready: ${facts.ready}; anonymous access denied: ${(await api.probe('anonymous')) === 'unauthorized'}. No acceptance changes made.`); return;
  }
  const registry = injected?.registry ?? new AcceptanceRegistry(); const runId = options.runId ?? randomUUID();
  const startFact = injected?.processStart ?? processStart;
  const start = startFact(process.pid); if (!start || start === 'absent') throw Error();
  const owner: LockOwner = { runId, token: randomUUID(), pid: process.pid, bootId, processStart: start };
  let lease;
  if (options.runId) {
    try { lease = registry.acquire(installation, owner); }
    catch (e) {
      if (!(e instanceof AcceptanceError) || e.code !== 'locked') throw e;
      const previous = registry.owner(installation);
      if (previous.runId !== runId) throw Error();
      lease = registry.takeoverStale(installation, previous, owner, { inspect: old => classifyOwner(old, { bootId, processStart: old.bootId === bootId ? startFact(old.pid) : null }) });
    }
    try { lease.load(); } catch (e) { try { lease.release(); } catch { /* preserve uncertain ownership */ } throw e; }
  } else {
    lease = registry.acquire(installation, owner);
    const now = actualClock.now();
    const state: Journal = { version: 1, runId, sequence: 0, installation, priorBootId: bootId, stage: 'preflight', createdAt: now, updatedAt: now, optionalChecks: ['reboot-changed','reboot-automatic-recovery','reboot-retained','reboot-provider','reboot-observed'], checks: [], cases: [], cleanup: { status: 'verified', originalPause: null, pauseRestoreNeeded: false, serviceRestoreNeeded: false, daemonReloadNeeded: false, artifacts: [] }, pending: null, reboot: null };
    lease.create(state);
  }
  console.log(`Run ID: ${runId}. State and reports: /var/lib/r2-acceptance/${runId}/`);
  try {
    if (options.mode === 'export') { lease.exportReports(); return; }
    const api = injected?.api ?? await recoverySafeApi(host, ['resume', 'recover', 'reboot-resume'].includes(options.mode));
    const reauthenticate = async () => { const password = await (injected?.passwordPrompt ?? passwordPrompt)(); await api.login(password); };
    const controller = new AbortController();
    const safePrompt: typeof prompt = request => controller.signal.aborted && request.id !== 'restore-model' ? Promise.resolve('cancelled') : actualPrompt(request);
    const o = { api, host, lease, clock: actualClock, wait: actualWait, prompt: safePrompt, mode: 'non-production-live' as const, hostDisruption: options.disruption, reauthenticate };
    const runner = new AcceptanceRunner(o);
    const signal = () => { controller.abort(); runner.cancel(); interruptPrompt(); };
    process.on('SIGINT', signal); process.on('SIGTERM', signal);
    try {
      if (!['resume', 'recover', 'reboot-resume'].includes(options.mode)) await reauthenticate();
      if (controller.signal.aborted) throw Error();
      if (options.mode === 'recover') { const report = await runner.recover(); if (report.overall !== 'pass') process.exitCode = 1; }
      else if (options.mode === 'retry') await runner.retryStage();
      else if (options.mode === 'reboot' || options.mode === 'reboot-resume') {
        const reboot = new AcceptanceReboot({ ...o, signal: controller.signal, wait: { until: (at, signal) => actualWait.until(at, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal) }, rebootCapability: true, interactive, acknowledgeResume: async id => safePrompt({ id: 'reboot', stage: 'reboot', message: `After reboot run exactly: cd /opt/r2 && sudo npm run acceptance -- --reboot-resume ${id} --non-production --allow-service-disruption. Acknowledge manual resume.` }) });
        if (options.mode === 'reboot') await reboot.prepare(); else await reboot.resume();
      } else { const report = await runner.run(controller.signal); if ('overall' in report && report.overall !== 'pass') process.exitCode = 1; }
    } finally { process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal); }
  } finally {
    try {
      lease.exportReports();
      if (lease.load().pending?.operation === 'reboot') {
        console.error('Reboot intent remains pending. Retain the run ID and follow the manual --reboot-resume instructions after a verified new boot.');
      } else lease.release();
    } catch { console.error('Recovery or lock release required. Retain the run ID and use --recover; see runbook.'); process.exitCode = 1; }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Acceptance operation blocked. No private error details are displayed; consult the runbook.'); process.exitCode = 1; });
}
