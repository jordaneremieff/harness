import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';

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
