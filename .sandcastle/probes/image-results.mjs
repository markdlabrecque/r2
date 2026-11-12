// Run inside sandcastle-r2. Mount this file only, never the host extension or credentials.
// This verifies request construction, not a live Claude response.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const revision = '05be412cb37cf3b5f5436ed88694c2a84f69bdb6';
const expectedHash = '4a5e0bb47387a568aa82e97eb10229d4512b64713e2985f17bc38a0a03e6d373';
const root = '/home/agent/.pi/agent/extensions/pi-claude-subscription';
const requirePi = createRequire('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json');
const { createJiti } = requirePi('jiti');
// Pi supplies this peer dependency when it loads an extension.
const jiti = createJiti(import.meta.url, {
  alias: { '@earendil-works/pi-ai': '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js' },
});
const { findUnsupportedAttachment, buildReplayPrompt, buildResumePrompt } = await jiti.import(`${root}/src/prompt-builder.ts`);

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==';
const image = { type: 'image', data, mimeType: 'image/png' };
const messages = [
  { role: 'user', content: 'Inspect the synthetic screenshot.', timestamp: 1 },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/tmp/synthetic.png' } }], timestamp: 2 },
  { role: 'toolResult', toolName: 'read', toolCallId: 'read-1', isError: false, content: [{ type: 'text', text: 'Synthetic screenshot result' }, image], timestamp: 3 },
];

for (const [mode, build, resumed] of [
  ['replay', buildReplayPrompt, false],
  ['resume', buildResumePrompt, true],
]) {
  assert.equal(findUnsupportedAttachment(messages, resumed), null, `${mode}: valid read image must be accepted`);
  const blocks = build({ messages });
  assert.ok(Array.isArray(blocks), `${mode}: multimodal content blocks`);
  const images = blocks.filter((block) => block.type === 'image');
  assert.equal(images.length, 1, `${mode}: exactly one image`);
  assert.deepEqual(images[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  assert.match(text, /Synthetic screenshot result/);
  assert.doesNotMatch(text, /could not be included|tool results can carry text only/);
  assert.ok(blocks.findIndex((block) => block.type === 'text' && block.text.includes('Synthetic screenshot result')) < blocks.indexOf(images[0]), `${mode}: image follows its tool text`);
  console.log(`${mode}: accepted image-bearing read result; exactly one unchanged image block after tool text`);
}

const malformed = [...messages.slice(0, -1), { ...messages.at(-1), content: [{ type: 'image', data: '', mimeType: 'image/png' }] }];
assert.match(findUnsupportedAttachment(malformed), /malformed/);
const unsupported = [...messages.slice(0, -1), { ...messages.at(-1), content: [{ type: 'file', name: 'synthetic.bin' }] }];
assert.match(findUnsupportedAttachment(unsupported), /not supported/);
console.log('negative controls: malformed image and unsupported file still rejected');

const actualRevision = readFileSync(`${root}/.factory-revision`, 'utf8').trim();
const actualHash = createHash('sha256').update(readFileSync(`${root}/src/prompt-builder.ts`)).digest('hex');
assert.equal(actualRevision, revision);
assert.equal(actualHash, expectedHash);
assert.equal(process.getuid(), 1000);
console.log(JSON.stringify({ revision: actualRevision, promptBuilderSha256: actualHash, uid: process.getuid(), scope: 'request construction only; no live Claude call' }));
