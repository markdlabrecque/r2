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

test('R2 scheduler keeps detached runs alive and uses a five-minute interval', () => {
  const service = read('systemd/factory-r2-dispatch.service');
  const timer = read('systemd/factory-r2-dispatch.timer');
  assert.match(service, /^KillMode=process$/m);
  assert.match(service, /^TimeoutStartSec=infinity$/m);
  assert.match(service, /^ExecStart=%h\/Projects\/r2\/code\/main\/\.sandcastle\/factory-dispatch\.sh$/m);
  assert.match(timer, /^OnUnitInactiveSec=5min$/m);
  assert.match(timer, /^Unit=factory-r2-dispatch\.service$/m);
});

test('sandbox pins the upstream image-handling fix to an immutable commit', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /git fetch --depth 1 origin 05be412cb37cf3b5f5436ed88694c2a84f69bdb6/);
  assert.match(dockerfile, /git rev-parse HEAD > \.factory-revision/);
  assert.doesNotMatch(dockerfile, /--branch v1\.6\.0/);
});

test('Factory credential file is ignored and image copies no host credentials', () => {
  assert.match(read('.gitignore'), /^\.env$/m);
  const dockerfile = read('Dockerfile');
  assert.doesNotMatch(dockerfile, /^\s*(?:COPY|ADD)\s/m);
  assert.doesNotMatch(dockerfile, /(?:ENV|ARG)\s+(?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|GH_TOKEN)/);
  assert.match(dockerfile, /playwright install --with-deps chromium/);
});
