import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
import type {EntryView, ProjectedFrame} from '../shared/api.ts';

const browser = await createAppFixture();
test('sent-image history requests retain their exact workspace across workspace changes', async t => {
  const original = globalThis.fetch, reads: URL[] = [], identity = 'sent-image-agent:9';
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname === `/api/agents/${encodeURIComponent(identity)}/history`) reads.push(url);
    return original(input, init);
  };
  const target = {kind: 'agent' as const, identity};
  for (const workspace of ['image-workspace-one', 'image-workspace-two']) {
    const before = reads.length;
    await browser.arrive({workspace: {id: workspace, revision: 1, primaryKey: 'p', selectedTarget: target},
      primaries: [browser.primaryFixture()], roster: [browser.agentFixture(identity)], targets: [browser.targetFixture(`${workspace}-target`, target)], history: []});
    await browser.settle();
    assert.ok(reads.length > before);
    assert.ok(reads.slice(before).every(url => url.searchParams.get('workspace') === workspace));
  }
});

test('native image metadata reaches the unresolved input renderer through the app snapshot', async () => {
  const workspace = '11111111-1111-1111-1111-111111111111', identity = 'image-render-agent:7', target = {kind: 'agent' as const, identity};
  const text = 'Describe the image.\n\nAttached image "sample.png" (image/png): /fixture/retained.bin';
  const entry: EntryView = {id: '47', kind: 'pi.user', messages: [{id: '47:message:0', role: 'user', state: 'final', communication: {state: 'unresolved'},
    coverage: browser.coverage, parts: [{type: 'text', text}], attachments: [{part: 0, start: text.indexOf('Attached image'), end: text.length,
      image: {type: 'image', mimeType: 'image/png', digest: 'a'.repeat(64), bytes: 512, width: 32, height: 16, alt: 'sample.png',
        attachment: {workspaceId: workspace, targetKey: '22222222-2222-2222-2222-222222222222'}}}]}]};
  const frame: ProjectedFrame = {revision: 1, attachmentRevision: 1, observedAt: 'now', entries: [entry], live: [], nextBefore: null, status: {busy: false}, coverage: browser.coverage};
  await browser.arrive({workspace: {id: workspace, revision: 1, primaryKey: 'p', selectedTarget: target},
    primaries: [browser.primaryFixture()], roster: [browser.agentFixture(identity)], targets: [browser.targetFixture('render-target', target)], history: [],
    observations: [browser.observation(identity, frame, 20)]});
  await browser.settle();
  const image = browser.hostDocument.body.querySelector('.transcript-image-content'); assert.ok(image);
  assert.equal(Reflect.get(image, 'alt'), 'sample.png');
  const card = image.closest('.communication-card'); assert.ok(card); assert.equal(card.dataset.state, 'unresolved');
  assert.doesNotMatch(card.textContent, /\/fixture\/retained.bin/);
});
