import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT, GRAPH, LABELS, MERGE, SUBTASKS, TRACKER } from './config.mts';
import { ciGate } from './ci.mts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('personal profile dispatches child issues with the approved models', () => {
  assert.equal(TRACKER.kind, 'github');
  assert.equal(TRACKER.project, 'markdlabrecque/r2');
  assert.equal(SUBTASKS.enabled, true);
  assert.deepEqual(LABELS.ready, ['ready-for-agent']);
  assert.equal(AGENT.modelLabels['model:sonnet'], 'pi-claude-subscription/claude-sonnet-5-5');
  assert.equal(AGENT.model, 'pi-claude-subscription/claude-opus-5-5');
  assert.equal(GRAPH.model, 'pi-claude-subscription/claude-sonnet-5-5');
  assert.equal(MERGE.auto, true);
  assert.equal(MERGE.method, 'squash');
});

test('merge gate fails closed without actual passing checks', () => {
  assert.equal(ciGate([]), 'none');
  assert.equal(ciGate([{ bucket: 'skipping' }]), 'none');
  assert.equal(ciGate([{ bucket: 'pass' }, { bucket: 'pending' }]), 'pending');
  assert.equal(ciGate([{ bucket: 'pass' }, { bucket: 'fail' }]), 'fail');
  assert.equal(ciGate([{ bucket: 'pass' }, { bucket: 'cancel' }]), 'fail');
  assert.equal(ciGate([{ bucket: 'pass' }, { bucket: 'unknown' }]), 'pending');
  assert.equal(ciGate([{ bucket: 'pass' }, { bucket: 'skipping' }]), 'pass');
});

test('both entrypoints refuse a different integration branch', () => {
  assert.match(read('main.mts'), /if \(base !== "spike-1"\) fail\(/);
  assert.match(read('dispatch.sh'), /\[ "\$base" = "spike-1" \] \|\| fail/);
});

test('CI runs on every PR and requires application checks once source exists', () => {
  const ci = read('../.github/workflows/ci.yml');
  assert.match(ci, /pull_request:/);
  assert.doesNotMatch(ci, /paths(?:-ignore)?:/);
  for (const command of ['npm ci', 'npm run test:factory', 'npm run typecheck', 'npm run build', 'npm test', 'npm run test:browser']) {
    assert.ok(ci.includes(command), command);
  }
  assert.doesNotMatch(ci, /continue-on-error|--if-present/);
});

test('Factory credential file is ignored and image copies no host credentials', () => {
  assert.match(read('.gitignore'), /^\.env$/m);
  const dockerfile = read('Dockerfile');
  assert.doesNotMatch(dockerfile, /^\s*(?:COPY|ADD)\s/m);
  assert.doesNotMatch(dockerfile, /(?:ENV|ARG)\s+(?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|GH_TOKEN)/);
  assert.match(dockerfile, /playwright install --with-deps chromium/);
});
