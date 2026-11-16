import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('acceptance terminal boundary', () => {
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
