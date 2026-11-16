import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recoverySafeApi } from '../scripts/acceptance/main.ts';

const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/acceptance/main.ts', ...args], { encoding: 'utf8', timeout: 10_000 });
describe('acceptance process argument boundary', () => {
  it('uses a network-disabled API only for explicit recovery when Serve is unavailable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const host = { privateOrigin: async () => { throw new Error('PRIVATE_CANARY'); } };
      await expect(recoverySafeApi(host, false)).rejects.toThrow();
      const api = await recoverySafeApi(host, true);
      await expect(api.login('synthetic-password-canary')).rejects.toMatchObject({ code: 'network' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
  it('documents the same commands exposed by help', () => {
    const text = cli('--help').stdout;
    const docs = readFileSync('docs/automated-acceptance.md', 'utf8');
    for (const command of ['--preflight', '--live', '--resume', '--recover', '--retry', '--export', '--reboot', '--reboot-resume']) {
      expect(text).toContain(command); expect(docs).toContain(command);
    }
  });
  it('prints help without inspecting the host', () => {
    const result = cli('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--reboot-resume');
    expect(result.stdout).toContain('--recover');
  });
  it.each([
    ['--yes'], ['--live'], ['--recover', 'not-a-uuid', '--non-production'],
    ['--preflight', '--allow-service-disruption'], ['--preflight', '--live'],
    ['--resume', 'not-a-uuid', '--non-production', '--allow-service-disruption'],
  ])('rejects incompatible arguments before host access: %j', (...args) => {
    const result = cli(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid or incompatible arguments');
  });
  it('refuses live operation without a terminal before host access', () => {
    const result = cli('--live', '--non-production', '--allow-service-disruption');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('interactive terminal');
  });
  it.each(['preflight', 'decline', 'no-display', 'failure', 'recovery-stopped', 'resume-stopped', 'sigint', 'sigterm', 'reboot'])('exercises real coordinator in synthetic process: %s', scenario => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/acceptance-cli-fixture.ts', scenario], { encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('SYNTHETIC_FIXTURE_OK');
    expect(result.stdout + result.stderr).not.toMatch(/synthetic-password|PRIVATE_CANARY|__Host-|push\.example|test\.synthetic/);
  }, 70_000);
  it('does not echo a password on a real pseudo-terminal', () => {
    const code = `import os, pty, select, sys, time\npid, fd = pty.fork()\nif pid == 0:\n os.execv(sys.argv[1], [sys.argv[1], '--import', 'tsx', 'tests/acceptance-password-fixture.ts'])\nout = b''\nend = time.monotonic() + 10\nwhile b'input hidden' not in out and time.monotonic() < end:\n r,_,_ = select.select([fd], [], [], 1)\n if r: out += os.read(fd, 4096)\nos.write(fd, b'password-canary-9381\\r')\nwhile time.monotonic() < end:\n r,_,_ = select.select([fd], [], [], 1)\n if r:\n  try: out += os.read(fd, 4096)\n  except OSError: break\n_, status = os.waitpid(pid, 0)\nsys.stdout.buffer.write(out)\nsys.exit(os.waitstatus_to_exitcode(status))`;
    const result = spawnSync('python3', ['-c', code, process.execPath], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASSWORD_RECEIVED');
    expect(result.stdout).not.toContain('password-canary-9381');
  });
  it('restores terminal mode when a hidden prompt is interrupted', () => {
    const code = `import os, pty, select, signal, sys, time\npid, fd = pty.fork()\nif pid == 0:\n os.execv(sys.argv[1], [sys.argv[1], '--import', 'tsx', 'tests/acceptance-password-fixture.ts', 'cancel'])\nout = b''\nend = time.monotonic() + 10\nwhile b'input hidden' not in out and time.monotonic() < end:\n r,_,_ = select.select([fd], [], [], 1)\n if r: out += os.read(fd, 4096)\nos.kill(pid, signal.SIGTERM)\nwhile time.monotonic() < end:\n r,_,_ = select.select([fd], [], [], 1)\n if r:\n  try: out += os.read(fd, 4096)\n  except OSError: break\n_, status = os.waitpid(pid, 0)\nsys.stdout.buffer.write(out)\nsys.exit(os.waitstatus_to_exitcode(status))`;
    const result = spawnSync('python3', ['-c', code, process.execPath], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('TERMINAL_RESTORED');
    expect(result.stdout).not.toContain('TERMINAL_STILL_RAW');
  });
});
