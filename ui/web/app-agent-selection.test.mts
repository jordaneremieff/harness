import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectedFrame } from '../shared/api.ts';
import {app, arrive, settle, hostDocument, byId, agentControl, primaryFixture, agentFixture, targetFixture, entryFixture, messageFixture, textPart, observation, singlePane, coverage, transportLog} from './app-fixture.mts';

test('initial focused draft hydration restores focus, while rerenders preserve another control focus', async () => {
  const target = {kind: 'agent', identity: 'caret-agent'} as const;
  const saved = targetFixture('caret-target', target, {draft: {revision: 4, text: 'saved draft', mode: 'followUp', persisted: true}, reading: {revision: 3, anchorId: 'caret-entry', offsetPx: 17, followTail: false}});
  const frame: ProjectedFrame = {revision: 1, observedAt: '', live: [], entries: [entryFixture('caret-entry', [messageFixture('caret-message', [textPart('Reading anchor')])])], nextBefore: null, coverage, status: {busy: false}};
  hostDocument.activeElement = hostDocument.body;
  await arrive({workspace: {id: 'caret-workspace', revision: 1, selectedTarget: target}, primaries: [], roster: [agentFixture(target.identity)], targets: [saved], observations: [observation(target.identity, frame)]});
  const composer = app.agentComposer(); assert.equal(hostDocument.activeElement, composer.editor);
  composer.editor.setSelectionRange(2, 7, 'backward'); agentControl('editor').dispatch('select');
  const unrelated = byId('agent-search'); unrelated.focus(); await app.reload(); await settle();
  assert.equal(hostDocument.activeElement, unrelated); assert.deepEqual([composer.editor.selectionStart, composer.editor.selectionEnd], [2, 7]);
  assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading, saved.reading);
  app.focusPane('pane-1'); assert.equal(hostDocument.activeElement, composer.editor);
  assert.deepEqual([composer.editor.selectionStart, composer.editor.selectionEnd, composer.editor.selectionDirection], [2, 7, 'backward']);
  assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading, saved.reading);
});
test('agent settings retain model and thinking text from the exact frame without replacing global Primary facts', async () => {
  const row = agentFixture('selected', {model: {provider: 'other', modelId: 'roster-model'}, thinkingLevel: 'low'});
  const frame: ProjectedFrame = {revision: 1, observedAt: '', live: [], entries: [], nextBefore: null, coverage,
    status: {busy: false, model: {provider: 'provider', modelId: 'selected-agent-long-model-name'}, thinkingLevel: 'medium'}};
  await arrive({workspace: {id: 'agent-settings', revision: 2, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'selected'}}, primaries: [primaryFixture()], roster: [row], observations: [observation('selected', frame)]});
  byId('model-button').textContent = 'Primary model'; byId('thinking-button').textContent = 'Thinking high';
  app.agentChrome('selected', row); assert.equal(byId('agent-status').textContent, 'Model selected-agent-long-model-name · Thinking medium');
  app.state.conversations.clear(); app.agentChrome('selected', row);
  assert.equal(byId('agent-status').textContent, 'Model roster-model (retained) · Thinking low (retained)');
  assert.equal(byId('model-button').textContent, 'Primary model'); assert.equal(byId('thinking-button').textContent, 'Thinking high');
});
test('a fresh agent selection retains each earlier control and prepares only its addressed owner', async () => {
  const a = agentFixture('a'), b = agentFixture('b'); const targetA = targetFixture('saved-a', {kind: 'agent', identity: 'a'}), targetB = targetFixture('saved-b', {kind: 'agent', identity: 'b'});
  const frame: ProjectedFrame = {revision: 1, observedAt: '', live: [], status: {busy: false}, entries: [entryFixture('a-entry', [messageFixture('a-message', [textPart('A transcript')])])], nextBefore: 1, coverage};
  await arrive({workspace: {id: 'agent-selection', revision: 3, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'a'}, conversationLayout: singlePane([{kind: 'primary'}, {kind: 'agent', identity: 'a'}], 'agent:a')}, primaries: [primaryFixture()], roster: [a, b], targets: [targetA], observations: [observation('a', frame)]});
  const earlierA = agentControl('earlier'), rootA = agentControl('root'), editorA = app.agentComposer().editor; const calls = transportLog.length;
  assert.equal(rootA.contains(earlierA), true); assert.match(rootA.textContent, /A transcript/);
  const original = globalThis.fetch; let complete: (response: Response) => void = () => {}; const pending = new Promise<Response>(resolve => {complete = resolve;});
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname.endsWith('/targets') && JSON.parse(String(init?.body)).target.identity === 'b' ? pending.then(response => response.clone()) : original(input, init);
  try {
    const selecting = app.selectAgent(b); await settle(); const earlierB = agentControl('earlier'), rootB = agentControl('root');
    assert.notEqual(rootB, rootA); assert.notEqual(earlierB, earlierA); assert.equal(rootB.contains(earlierB), true);
    assert.equal(rootA.contains(earlierA), true); assert.equal(rootA.hidden, true); assert.doesNotMatch(rootB.textContent, /A transcript/); assert.equal(app.agentComposer().state, undefined);
    complete(Response.json({ok: true, data: {targetState: targetB, availability: 'live', capabilities: b.capabilities}})); await selecting; await settle();
    assert.equal(app.agentComposer().state?.targetKey, 'saved-b'); assert.equal(agentControl('earlier'), earlierB); assert.equal(agentControl('root'), rootB);
    await app.selectAgent(a); await settle(); assert.equal(app.agentComposer().editor, editorA); assert.equal(agentControl('earlier'), earlierA);
    assert.equal(transportLog.slice(calls).some(call => call.path.endsWith('/input') || call.path.endsWith('/start')), false);
  } finally {globalThis.fetch = original;}
});
