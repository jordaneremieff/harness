import assert from 'node:assert/strict';
import test from 'node:test';
import type {DraftImage} from '../shared/api.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
const {app, arrive, settle, event, primaryControl, agentControl, primaryFixture, agentFixture, targetFixture, entryFixture, messageFixture, textPart, twoPanes, observation, coverage, host} = await createAppFixture();

function ancestors(node: HostNode): HostNode[] {
  const result: HostNode[] = [];
  for (let parent = node.parentNode; parent; parent = parent.parentNode) result.push(parent);
  return result;
}

test('conversation state and split width changes retain editor ancestry, draft images, caret and manual size', async t => {
  const original = globalThis.fetch, computed = globalThis.getComputedStyle;
  t.mock.method(globalThis, 'getComputedStyle', (node: Element) => ({...computed(node), lineHeight: '22.5px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px'}));
  t.after(() => {globalThis.fetch = original; host.viewport = 1200;});
  const identity = 'composer-layout-agent', target = {kind: 'agent' as const, identity};
  const image: DraftImage = {digest: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, width: 1, height: 1, name: 'draft.png'};
  const saved = targetFixture('composer-layout-draft', target, {draft: {revision: 1, text: 'Retained draft\nSecond line', mode: 'prompt', images: [image], persisted: true}});
  const primary = primaryFixture({epoch: 11100});
  const savedPrimary = targetFixture('composer-layout-primary', {kind: 'primary', key: primary.key, epoch: primary.epoch});
  let phase = 'empty';
  const entries = [entryFixture('layout-message', [messageFixture('layout-body', [textPart('Retained conversation')])])];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname !== `/api/agents/${identity}/history`) return original(input, init);
    if (phase === 'failed') return Response.json({ok: false, error: {code: 'history_unavailable', message: 'Saved messages are unavailable', retry: 'read'}});
    return Response.json({ok: true, data: {target, entries: phase === 'populated' ? entries : [], nextBefore: null, coverage, revision: phase}});
  };
  const baseline = {workspace: {id: 'composer-layout', revision: 1, primaryKey: primary.key, selectedTarget: target, conversationLayout: twoPanes(identity)}, primaries: [primary], roster: [agentFixture(identity)], targets: [savedPrimary, saved]};
  await arrive(baseline);
  const editor = agentControl('editor'), chain = ancestors(editor), root = agentControl('root'), form = agentControl('composer');
  const primaryEditor = primaryControl('editor'), primaryChain = ancestors(primaryEditor);
  for (const control of [primaryControl, agentControl]) {
    const latest = control('latest'), form = control('composer'), surface = form.querySelector('.composer-input'), line = form.querySelector('.composer-line'), meta = form.querySelector('.composer-meta');
    assert.ok(surface); assert.ok(line); assert.ok(meta); const bar = line.querySelector('.composer-bar'); assert.ok(bar);
    const intake = surface.querySelector('.composer-intake'), sources = intake?.querySelector('.attachment-sources'), attach = intake?.querySelector('.attach'), picker = intake?.querySelector('input'); assert.ok(intake); assert.ok(sources); assert.ok(attach); assert.ok(picker);
    assert.equal(sources.getAttribute('aria-label'),'Add to message');assert.equal(sources.getAttribute('aria-haspopup'),'menu'); assert.equal(attach.hidden, true);
    assert.deepEqual(intake.children,[attach,sources,picker]);
    // One surface holds the add control, the editor and one control row in that tab order; Latest leads the row.
    const order = surface.children.filter(node => [intake, control('editor').parentNode, line].includes(node));
    assert.deepEqual(order, [intake, control('editor').parentNode, line]); assert.equal(latest.parentNode, meta); assert.equal(meta.children[0], latest, 'Latest leads the control row'); assert.equal(meta.parentNode, line); const recallLine = form.querySelector('.composer-recall'); assert.ok(recallLine); assert.deepEqual(line.children, [meta, bar, recallLine], 'the recall line follows the action in tab order'); assert.equal(form.querySelectorAll('.composer-input ~ *').length, 0, 'nothing sits under the box');
    const submit = bar.querySelector('.composer-submit'); assert.ok(submit);
    assert.deepEqual(bar.children, [control('stop'), submit]); assert.deepEqual(submit.children, [control('queue'), control('start'), control('send')]);
    assert.equal(control('editor').rows, 1);
    assert.equal(control('transcript').parentNode?.contains(latest), false);
    assert.equal(control('editor').parentNode?.classList.contains('composer-surface'), true);
  }
  app.agentComposer().setManualHeight(160); editor.focus(); editor.setSelectionRange(2, 9, 'backward'); editor.dispatch('select'); await settle();
  const height = (editor.style as {height?: string}).height;
  assert.equal(height, '160px');
  assert.equal(root.classList.contains('agent-empty'), true);
  let frameRevision = 0;
  for (const next of ['running', 'failed', 'incompatible', 'populated']) {
    phase = next;
    await arrive({...baseline, roster: [agentFixture(identity, {availability: next === 'incompatible' ? 'incompatible' : 'live'})], observations: [observation(identity, {revision: ++frameRevision, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: next === 'running'}, coverage}, 10)]});
    event('agent.availability', {identity, connectionEpoch: 10, state: next === 'incompatible' ? 'incompatible' : 'live', capabilities: agentFixture(identity).capabilities}); await settle();
    for (const width of [1000, 1440]) {
      host.viewport = width; app.renderNavigation(); await settle();
      assert.equal(agentControl('root'), root); assert.equal(agentControl('composer'), form); assert.equal(agentControl('editor'), editor);
      assert.deepEqual(ancestors(editor), chain); assert.deepEqual(ancestors(primaryEditor), primaryChain);
      assert.equal(editor.value, saved.draft.text); assert.deepEqual(app.agentComposer().state?.draft.images, [image]);
      assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 9, 'backward']);
      assert.equal((editor.style as {height?: string}).height, height);
      assert.equal(root.classList.contains('agent-empty'), next !== 'populated');
      assert.equal(agentControl('queue').hidden, next !== 'running'); assert.equal(agentControl('stop').hidden, next !== 'running');
      assert.match(editor.placeholder, /^Message .*…$/); assert.match(editor.getAttribute('aria-label') ?? '', /^(?:Message |Draft for )/);
    }
  }
});
