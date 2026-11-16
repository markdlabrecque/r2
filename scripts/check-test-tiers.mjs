import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

// Collect real expanded cases (including it.each), without running their bodies.
// Compare discovery, not a frozen test count: concurrent additions stay protected.
const collect = (tier) => {
  const cases = JSON.parse(execFileSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'list', '--json', '--staticParse=false',
  ], { encoding: 'utf8', env: { ...process.env, R2_TEST_TIER: tier }, maxBuffer: 8 * 1024 * 1024 }));
  // Existing parameterized cases can have equal display names. Preserve their
  // multiplicity instead of collapsing them or inventing duplicate ownership.
  const occurrences = new Map();
  return cases.map(test => {
    const base = `${relative(process.cwd(), test.file)} > ${test.name}`;
    const n = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, n);
    return { ...test, id: `${base} [${n}]` };
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
console.log(`Exhaustive partition verified: ${all.length} cases; smoke: ${smoke.length} (nightly subset).`);
