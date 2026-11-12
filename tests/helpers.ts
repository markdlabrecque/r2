import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../src/contracts.ts';

export class FakeClock implements Clock {
  t: number;
  constructor(start = Date.UTC(2026, 9, 14, 12, 0, 0)) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'r2-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Minimal valid environment for synthetic tests: no real credentials. */
export function syntheticEnv(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { R2_ORIGIN: 'https://r2.example.ts.net', R2_DATA_DIR: dataDir, R2_PORT: '0', ...extra };
}
