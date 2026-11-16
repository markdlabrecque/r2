import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/acceptance/main.ts', ...args], { encoding: 'utf8', timeout: 10_000 });
describe('acceptance process argument boundary', () => {
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
});
