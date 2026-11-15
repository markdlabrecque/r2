import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Journal, LockOwner } from '../scripts/acceptance/contracts.ts';
import { AcceptanceRegistry, type RegistryOptions } from '../scripts/acceptance/state.ts';
export const installation = { hostFingerprint: 'a'.repeat(64), unit: 'r2.service' as const, revision: 'b'.repeat(40) };
export function journal(): Journal {
  return { version: 1, runId: randomUUID(), sequence: 0, installation, priorBootId: randomUUID(), stage: 'preflight',
    createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, optionalChecks: [], checks: [], cases: [],
    cleanup: { status: 'verified', originalPause: null, pauseRestoreNeeded: false, serviceRestoreNeeded: false, daemonReloadNeeded: false, artifacts: [] },
    pending: null, reboot: null };
}
export function fixture(options: Omit<RegistryOptions, 'root'> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'r2-journal-'));
  const registry = new AcceptanceRegistry({ root, ...options });
  const state = journal();
  const owner: LockOwner = { runId: state.runId, token: randomUUID(), pid: process.pid, bootId: state.priorBootId, processStart: '12345' };
  return { root, registry, state, owner, remove: () => rmSync(root, { recursive: true, force: true }) };
}
export function syntheticCase(): Journal['cases'][number] {
  return { label: 'A', caseNumber: 1, reason: null, requestId: randomUUID(), proposalId: null, reminderId: null, phase: 'intended',
    dueAt: 1_800_000_600_000, localDateTime: '2027-01-15T08:10:00', timezone: 'America/Toronto', createdAt: 1_800_000_000_000,
    attemptAt: null, acceptedAt: null };
}
