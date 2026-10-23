import assert from 'node:assert/strict';
import test from 'node:test';
import type {DraftImage} from '../shared/api.ts';
import {createAppFixture, type HostNode} from './app-fixture.mts';
const {app, arrive, settle, event, primaryControl, agentControl, primaryFixture, agentFixture, targetFixture, entryFixture, messageFixture, textPart, twoPanes, observation, coverage, host, streamSources} = await createAppFixture();

test('working delivery guidance yields to lifecycle and settings feedback without changing the draft', async () => {
  const identity = 'working-guidance-agent', target = {kind: 'agent' as const, identity};
  const draft = targetFixture('working-guidance-draft', target);
  const frame = {revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: true}, coverage};
  await arrive({workspace: {id: 'working-guidance', revision: 1, primaryKey: null, selectedTarget: target}, primaries: [], roster: [agentFixture(identity)], targets: [draft], observations: [observation(identity, frame)]});
  const epoch = app.state.agentEpochs.get(identity) ?? 1;
  event('agent.availability', {identity, connectionEpoch: epoch, state: 'live', capabilities: agentFixture(identity).capabilities}); await settle();
  const editor = agentControl('editor') as HostNode & {placeholder: string}, line = agentControl('state');
  const chain = ancestors(editor); editor.focus();
  assert.equal(editor.placeholder, 'Message'); assert.match(editor.getAttribute('aria-label') ?? '', /^Message /);
  assert.equal(line.querySelector('.composer-state-label')?.textContent, 'Steer at the next step; Queue adds a follow-up.');
  assert.equal(line.classList.contains('composer-delivery-guidance'), true);
  for (const key of ['send', 'queue']) {assert.equal(agentControl(key).hidden, false); assert.equal(agentControl(key).disabled, true);}
  assert.equal(agentControl('stop').querySelector('.action-label')?.textContent, 'Stop');
  const composer = app.agentComposer();
  composer.setSettingsState({line: 'Updating settings', label: 'Updating settings'});
  assert.equal(line.querySelector('.composer-state-label')?.textContent, 'Updating settings'); assert.equal(line.classList.contains('composer-delivery-guidance'), false);
  composer.setSettingsState({line: 'Settings update not confirmed.', label: 'Settings update not confirmed.', detail: 'Exact native reason', tone: 'warning'});
  assert.doesNotMatch(line.textContent, /Steer at the next step/); assert.equal(agentControl('state-details').textContent, 'Exact native reason');
  composer.setSettingsState();
  for (const availability of ['stored', 'unavailable', 'incompatible'] as const) {
    event('agent.availability', {identity, connectionEpoch: epoch, state: availability, capabilities: agentFixture(identity).capabilities}); await settle();
    assert.equal(editor.placeholder, 'Message'); assert.doesNotMatch(line.textContent, /Steer at the next step/); assert.equal(agentControl('queue').hidden, true);
    if (availability === 'stored') {assert.equal(agentControl('start').hidden, false); assert.equal(agentControl('start').querySelector('.action-label')?.textContent, 'Start');}
    assert.equal(app.agentComposer().editor, editor); assert.deepEqual(ancestors(editor), chain); assert.equal(editor.value, '');
  }
});

function ancestors(node: HostNode): HostNode[] {
  const result: HostNode[] = [];
  for (let parent = node.parentNode; parent; parent = parent.parentNode) result.push(parent);
  return result;
}
function layoutPlaceholderPattern(_state: string): RegExp {
  return /^Message$/;
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
    assert.deepEqual(intake.children,[attach,sources,latest,picker]);
    // Utility rows precede the surface; the native editor and shelf retain their ancestry.
    assert.equal(intake.parentNode, line);
    assert.equal(latest.parentNode, intake); assert.deepEqual(meta.children, [control('state'), control('state-details')]);
    assert.ok(latest.querySelector('.card-icon-latest')); assert.equal(latest.querySelector('.latest-text')?.textContent, 'Latest'); assert.equal(latest.getAttribute('aria-label'), 'Latest message');
    const utilities = form.querySelector('.composer-utilities'), recallLine = form.querySelector('.composer-recall'); assert.ok(utilities); assert.ok(recallLine);
    assert.deepEqual(utilities.children, [recallLine, form.querySelector('.composer-handover')]); assert.equal(utilities.parentNode, form);
    assert.deepEqual(line.children, [intake, control('settings'), bar]); assert.equal(line.parentNode, surface);
    assert.equal(surface.contains(meta), false); assert.equal(surface.contains(recallLine), false);
    assert.ok(form.children.indexOf(meta) > form.children.indexOf(surface));
    assert.ok(control('model').querySelector('.card-icon-chevron')); assert.ok(control('thinking').querySelector('.card-icon-chevron'));
    const submit = bar.querySelector('.composer-submit'); assert.ok(submit);
    assert.deepEqual(bar.children, [submit]); assert.deepEqual(submit.children, [control('stop'), control('queue'), control('start'), control('send')]);
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
      assert.match(editor.placeholder, layoutPlaceholderPattern(next)); assert.match(editor.getAttribute('aria-label') ?? '', /^(?:Message |Draft for )/);
    }
  }
});

test('a working recipient refreshes its placeholder across disconnect and reconnect', async t => {
  const identity = 'disconnected-guidance-agent', target = {kind: 'agent' as const, identity};
  const saved = targetFixture('disconnected-guidance-draft', target, {draft: {revision: 1, text: 'Retained draft', mode: 'followUp', persisted: true}});
  const frame = {revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: true}, coverage};
  await arrive({workspace: {id: identity, revision: 1, primaryKey: null, selectedTarget: target}, primaries: [], roster: [agentFixture(identity)], targets: [saved], observations: [observation(identity, frame)]});
  event('agent.availability', {identity, connectionEpoch: app.state.agentEpochs.get(identity), state: 'live', capabilities: agentFixture(identity).capabilities}); await settle();
  const editor = agentControl('editor') as HostNode & {placeholder: string}; editor.focus(); editor.setSelectionRange(2, 7, 'backward'); editor.dispatch('select');
  assert.equal(agentControl('queue').hidden, false); assert.equal(editor.placeholder, 'Message');
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  let recover: (() => void) | undefined; const timeout = window.setTimeout.bind(window);
  t.mock.method(window, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 250) {recover = () => {if (typeof callback === 'function') callback(...args);}; return 0;}
    return timeout(callback, delay, ...args);
  });
  const previous = streamSources.at(-1); assert.ok(previous); previous.onerror?.(); await settle();
  assert.equal(editor.placeholder, 'Message'); assert.doesNotMatch(agentControl('state').textContent, /Steer at the next step/); assert.equal(agentControl('queue').hidden, true);
  assert.ok(recover); recover(); await settle(); const fresh = streamSources.at(-1); assert.ok(fresh); assert.notEqual(fresh, previous);
  fresh.emit('ready', {bootId: 'boot', connectionId: 'restored-guidance-stream'}); await settle();
  assert.equal(editor.placeholder, 'Message'); assert.equal(agentControl('queue').hidden, false);
  assert.equal(app.agentComposer().editor, editor); assert.equal(editor.value, saved.draft.text);
  assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']);
});
