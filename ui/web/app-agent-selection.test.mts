import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectedFrame } from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';
const {app, arrive, settle, event, hostDocument, byId, agentControl, primaryFixture, agentFixture, targetFixture, entryFixture, messageFixture, textPart, observation, singlePane, coverage, transportLog} = await createAppFixture();

test('passive draft hydration leaves focus unchanged, while explicit focus and rerenders preserve native ranges', async () => {
  const target = {kind: 'agent', identity: 'caret-agent'} as const;
  const saved = targetFixture('caret-target', target, {draft: {revision: 4, text: 'saved draft', mode: 'followUp', persisted: true}, reading: {revision: 3, anchorId: 'caret-entry', offsetPx: 17, followTail: false}});
  const frame: ProjectedFrame = {revision: 1, observedAt: '', live: [], entries: [entryFixture('caret-entry', [messageFixture('caret-message', [textPart('Reading anchor')])])], nextBefore: null, coverage, status: {busy: false}};
  hostDocument.activeElement = hostDocument.body;
  await arrive({workspace: {id: 'caret-workspace', revision: 1, selectedTarget: target}, primaries: [], roster: [agentFixture(target.identity)], targets: [saved], observations: [observation(target.identity, frame)]});
  const composer = app.agentComposer(); assert.equal(hostDocument.activeElement, hostDocument.body);
  composer.editor.setSelectionRange(2, 7, 'backward'); agentControl('editor').dispatch('select');
  const unrelated = byId('agent-search'); unrelated.focus(); await app.reload(); await settle();
  assert.equal(hostDocument.activeElement, unrelated); assert.deepEqual([composer.editor.selectionStart, composer.editor.selectionEnd], [2, 7]);
  assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading, saved.reading);
  app.focusPane('pane-1'); assert.equal(hostDocument.activeElement, composer.editor);
  assert.deepEqual([composer.editor.selectionStart, composer.editor.selectionEnd, composer.editor.selectionDirection], [2, 7, 'backward']);
  assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading, saved.reading);
});
test('agent view combines pending read, source refusal and confirmed empty in one composition', {timeout: 10000}, async () => {
  const original = globalThis.fetch; let complete: (response: Response) => void = () => {}; const held = new Promise<Response>(resolve => {complete = resolve;}); let pending = true;
  const reason = 'Required Durable 1.1.0; reader Durable 1.0.3.';
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname === '/api/agents/history-state/history' ? pending ? held.then(response => response.clone()) : Response.json({ok: true, data: {target: {kind: 'agent', identity: 'history-state'}, entries: [], nextBefore: null, coverage, revision: 'empty'}}) : original(input, init);
  try {
    const arrival = arrive({workspace: {id: 'history-state', revision: 1, selectedTarget: {kind: 'agent', identity: 'history-state'}}, primaries: [], roster: [agentFixture('history-state', {availability: 'stored', capabilities: {input: false}})], targets: [targetFixture('history-state-target', {kind: 'agent', identity: 'history-state'})]});
    await settle(); assert.equal(agentControl('agent-state-line').textContent, 'Loading messages… · Agent is not connected.'); assert.equal(agentControl('history-retry').disabled, true); assertAgentComposition();
    complete(Response.json({ok: false, error: {code: 'contract_mismatch', message: reason, retry: 'none'}})); await arrival; await settle();
    assert.equal(agentControl('agent-state-line').textContent, 'History unavailable: saved messages use an unsupported format. · Agent is not connected.'); assert.equal(agentControl('agent-state-line').title, reason); assertAgentComposition();
    pending = false; agentControl('history-retry').dispatch('click'); await settle();
    assert.equal(agentControl('agent-state-line').textContent, 'No messages yet. · Agent is not connected.'); assertAgentComposition();
    assert.equal(transportLog.filter(call => call.path.includes('/history-state/start') || call.path.includes('/inputs')).length, 0);
  } finally {pending = false; complete(Response.json({ok: true, data: {entries: [], nextBefore: null, coverage}})); globalThis.fetch = original;}
});
function visibleText(node: ReturnType<typeof agentControl>): string {return node.hidden ? '' : node.text + node.children.map(visibleText).join(' ');}
function assertAgentComposition(): void {
  const root = agentControl('root'), status = agentControl('agent-state'), row = agentControl('agent-state-actions');
  assert.equal(root.querySelectorAll('.agent-state').length, 1); assert.equal(status.children.length, 2); assert.equal(status.children[0].tagName, 'p'); assert.equal(status.children[0].attributes.get('role'), 'status');
  assert.equal(status.children[1], row); assert.equal(row.querySelectorAll('svg').length, 0); assert.equal(status.querySelectorAll('details').length, 0); assert.equal(status.querySelectorAll('h2').length, 0);
  assert.equal(root.querySelectorAll('.agent-start-help').length, 0); assert.equal(agentControl('view-notice').textContent, ''); assert.equal(agentControl('empty').hidden, true);
  assert.doesNotMatch(visibleText(root), /Stored metadata|History is disconnected|History could not be loaded|A start can resume|Check connection/);
  assert.deepEqual(row.children.map(button => button.textContent), ['Retry', 'Start agent', 'Start in Pi']); assert.match(agentControl('start').title, /resume unfinished work/);
}
test('whole agent views retain messages independently of running, idle and incompatible hosts in both themes', async () => {
  const original = globalThis.fetch;
  try {
    for (const theme of ['dark', 'light']) for (const availability of ['live', 'stored', 'incompatible'] as const) {
      hostDocument.documentElement.dataset.appearance = theme;
      const identity = `history-${theme}-${availability}`, target = {kind: 'agent', identity} as const;
      const entry = entryFixture('retained-message', [messageFixture('retained-source', [textPart('Exact retained conversation text')])]); let failed = false;
      globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname === `/api/agents/${identity}/history` ? failed ? Response.json({ok: false, error: {code: 'host_unavailable', message: 'The saved history read failed.', retry: 'read'}}) : Response.json({ok: true, data: {target, entries: [entry], nextBefore: null, coverage, revision: 'retained'}}) : original(input, init);
      const saved = targetFixture(`saved-${identity}`, target, {draft: {revision: 4, text: 'Exact editable draft', mode: 'followUp', persisted: true}});
      const row = agentFixture(identity, {availability, capabilities: {input: availability === 'live'}});
      await arrive({workspace: {id: identity, revision: 1, selectedTarget: target}, primaries: [], roster: [row], targets: [saved], observations: availability === 'live' ? [observation(identity, {revision: 1, observedAt: '', status: {busy: true}, live: [], entries: [entry], nextBefore: null, coverage})] : []});
      if (availability === 'live') {event('agent.availability', {identity, connectionEpoch: app.state.agentEpochs.get(identity), state: 'live', capabilities: row.capabilities}); await settle();}
      assertAgentComposition(); assert.match(visibleText(agentControl('root')), /Exact retained conversation text/); assert.equal(app.agentComposer().state?.draft.text, 'Exact editable draft');
      assert.equal(agentControl('send').disabled, availability !== 'live'); assert.equal(agentControl('editor').disabled, false); assert.equal(agentControl('start').hidden, availability !== 'stored');
      assert.equal(agentControl('agent-state').hidden, availability === 'live');
      const editor = app.agentComposer().editor, message = agentControl('root').querySelector('[data-entry-id=retained-message]'); assert.ok(message); editor.setSelectionRange(2, 7, 'backward'); editor.focus();
      const before = transportLog.length; failed = true; agentControl('history-retry').dispatch('click'); await settle(); assertAgentComposition();
      assert.match(visibleText(agentControl('root')), /Exact retained conversation text/); assert.doesNotMatch(visibleText(agentControl('root')), /The saved history read failed/); assert.equal(agentControl('agent-state-line').title, 'The saved history read failed.'); assert.match(agentControl('agent-state-line').textContent, /saved messages could not be read/); assert.equal(agentControl('root').querySelector('[data-entry-id=retained-message]'), message);
      failed = false; agentControl('history-retry').dispatch('click'); await settle(); assertAgentComposition(); assert.doesNotMatch(visibleText(agentControl('root')), /read failed/);
      assert.equal(app.agentComposer().editor, editor); assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [2, 7, 'backward']); assert.equal(hostDocument.activeElement, editor);
      assert.equal(transportLog.slice(before).some(call => call.path.endsWith('/start') || call.path.includes('/inputs')), false);
    }
  } finally {globalThis.fetch = original;}
});
test('whole idle and incompatible views show one plain unreadable-history error with its diagnostic tooltip', async () => {
  const original = globalThis.fetch, diagnostic = 'The retained source is unreadable.', plain = 'History unavailable: saved messages could not be read.';
  try {
    for (const theme of ['dark', 'light']) for (const availability of ['stored', 'incompatible'] as const) {
      hostDocument.documentElement.dataset.appearance = theme; const identity = `unreadable-${theme}-${availability}`, target = {kind: 'agent', identity} as const; let failed = true;
      const requests: Array<[string, string]> = [];
      globalThis.fetch = async (input, init) => {
        const path = new URL(String(input), 'http://ui.test').pathname; requests.push([init?.method ?? 'GET', path]);
        return path === `/api/agents/${identity}/history` ? failed ? Response.json({ok: false, error: {code: 'source_unreadable', message: diagnostic, retry: 'none'}}) : Response.json({ok: true, data: {target, entries: [], nextBefore: null, coverage, revision: 'empty'}}) : original(input, init);
      };
      await arrive({workspace: {id: identity, revision: 1, selectedTarget: target}, primaries: [], roster: [agentFixture(identity, {availability, capabilities: {input: false}})], targets: [targetFixture(identity, target, {draft: {revision: 4, text: 'Exact unreadable-view draft', mode: 'followUp', persisted: true}})]});
      assertAgentComposition(); const rendered = visibleText(agentControl('root')); assert.equal(rendered.split(plain).length - 1, 1); assert.doesNotMatch(rendered, /retained source|Permission denied/);
      assert.equal(agentControl('agent-state-line').textContent, plain + (availability === 'stored' ? ' · Agent is not connected.' : ' · This agent cannot connect; messages remain read-only.'));
      assert.equal(agentControl('agent-state-line').title, diagnostic); assert.equal(agentControl('send').disabled, true);
      if (availability === 'incompatible') {assert.equal(byId('workbench-activity').textContent, 'Connection unavailable'); assert.doesNotMatch(hostDocument.title, /host/i);}
      const editor = app.agentComposer().editor, before = requests.length; assert.equal(editor.value, 'Exact unreadable-view draft'); editor.setSelectionRange(1, 3); editor.focus(); failed = false; agentControl('history-retry').dispatch('click'); await settle();
      assertAgentComposition(); assert.match(agentControl('agent-state-line').textContent, /^No messages yet/); assert.doesNotMatch(visibleText(agentControl('root')), /saved messages could not be read|retained source/); assert.equal(agentControl('agent-state-line').title, '');
      assert.equal(app.agentComposer().editor, editor); assert.equal(editor.value, 'Exact unreadable-view draft'); assert.deepEqual([editor.selectionStart, editor.selectionEnd], [1, 3]); assert.equal(hostDocument.activeElement, editor); assert.equal(agentControl('send').disabled, true);
      assert.deepEqual(requests.slice(before), [['GET', `/api/agents/${identity}/history`]]);
    }
  } finally {globalThis.fetch = original;}
});
test('agent settings retain model and thinking text from the exact frame without replacing global Primary facts', async () => {
  const row = agentFixture('selected', {model: {provider: 'other', modelId: 'roster-model'}, thinkingLevel: 'low'});
  const frame: ProjectedFrame = {revision: 1, observedAt: '', live: [], entries: [], nextBefore: null, coverage,
    status: {busy: false, model: {provider: 'provider', modelId: 'selected-agent-long-model-name'}, thinkingLevel: 'medium'}};
  await arrive({workspace: {id: 'agent-settings', revision: 2, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: 'selected'}}, primaries: [primaryFixture()], roster: [row], observations: [observation('selected', frame)]});
  event('agent.availability', {identity: row.identity, connectionEpoch: app.state.agentEpochs.get(row.identity), state: 'live', capabilities: row.capabilities}); await settle();
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
