import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../src/clock.ts';

export class FakeClock implements Clock {
  constructor(private t = Date.UTC(2026, 9, 14, 12, 0, 0)) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'r2-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
