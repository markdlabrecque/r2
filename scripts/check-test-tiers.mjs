import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

// Collect real expanded runnable cases (including it.each), without running
// their bodies. Vitest list omits skipped cases; the existing root-only skip
// retains commit ownership in acceptance-state.test.ts (see testing-tiers.md).
// Compare discovery, not a frozen test count: concurrent additions stay protected.
const collect = (tier) => {
  const cases = JSON.parse(execFileSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'list', '--json', '--staticParse=false',
  ], { encoding: 'utf8', env: { ...process.env, R2_TEST_TIER: tier }, maxBuffer: 8 * 1024 * 1024 }));
  // File-local declaration order identifies expanded cases: existing it.each
  // names may duplicate or embed a fresh randomUUID on each collection. There
  // are no case-name filters in any tier, so ordinals are stable across tiers.
  const occurrences = new Map();
  return cases.map(test => {
    const file = relative(process.cwd(), test.file);
    const n = (occurrences.get(file) ?? 0) + 1;
    occurrences.set(file, n);
    return { ...test, id: `${file} [case ${n}]` };
  });
};
const key = (test) => test.id;
const all = collect('all');
const owners = new Map();
for (const tier of ['commit', 'functional', 'nightly']) {
  const cases = collect(tier);
  assert(cases.length > 0, `${tier} must not be empty`);
  for (const test of cases) {
    const id = key(test);
    assert(!owners.has(id), `Duplicate ownership: ${id}`);
    owners.set(id, tier);
  }
  console.log(`${tier}: ${new Set(cases.map(test => test.file)).size} files, ${cases.length} cases`);
}
assert.equal(owners.size, all.length, 'Tier union differs from all cases');
for (const test of all) assert(owners.has(key(test)), `Unowned case: ${key(test)}`);
// Also detect an entire file silently disappearing from discovery.
const discovered = new Set(all.map(test => resolve(test.file)));
for (const path of readdirSync('tests', { recursive: true })) {
  if (path.endsWith('.test.ts')) assert(discovered.has(resolve('tests', path)), `Undiscovered test file: ${path}`);
}
const smoke = collect('smoke');
assert(smoke.length > 0 && smoke.every(test => owners.get(key(test)) === 'nightly'), 'Smoke must be a nonempty nightly subset');
console.log(`Exhaustive runnable partition verified: ${all.length} cases; smoke: ${smoke.length} (nightly subset).`);
console.log('Vitest list omits skipped cases; see docs/testing-tiers.md for the existing root-only ownership case.');
