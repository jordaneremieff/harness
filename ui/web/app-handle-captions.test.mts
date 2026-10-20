import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRow, EntryView, ProjectedFrame} from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';
const {app, arrive, settle, event, agentControl, agentFixture, targetFixture, entryFixture, messageFixture, textPart, observation, coverage, transportLog} = await createAppFixture();

const host = '00000000-0000-4000-8000-000000000501', recipient = '00000000-0000-4000-8000-000000000502';
const target = {kind: 'agent' as const, identity: host};
function call(id: string, sessionId: string, name = 'agent_send'): EntryView {
  return entryFixture(id, [messageFixture(id, [
    {type: 'toolCall', callId: id, name, arguments: {value: {sessionId, ...(name === 'agent_inspect' ? {view: 'result'} : {message: 'Hello'})}, truncated: false}},
    {type: 'toolResult', callId: id, name, isError: false, parts: [textPart('Accepted')]},
  ])]);
}
async function show(workspace: string, rows: AgentRow[], entries: EntryView[]): Promise<void> {
  const frame: ProjectedFrame = {revision: 1, observedAt: '', live: [], entries, nextBefore: null, coverage, status: {busy: false}};
  await arrive({workspace: {id: workspace, revision: 1, selectedTarget: target}, primaries: [], roster: [agentFixture(host, {name: 'Host agent'}), ...rows],
    targets: [targetFixture(`${workspace}-target`, target)], observations: [observation(host, frame)]});
}
function card(id: string) {
  const node = agentControl('transcript').querySelector(`[data-entry-id="${id}"] .tool-card`); assert.ok(node); return node;
}

test('unique loaded handles with either stored form name send and inspect cards without changing their arguments', async () => {
  for (const handle of ['sample-agent', '@sample-agent']) {
    await show(`handle-${handle}`, [agentFixture(recipient, {handle, name: 'Sample agent'})], [call('send', '@sample-agent'), call('inspect', '@sample-agent', 'agent_inspect'), call('exact', recipient)]);
    assert.equal(card('send').querySelector('.tool-name')?.textContent, 'Sent a message to Sample agent: “Hello”');
    assert.equal(card('inspect').querySelector('.tool-name')?.textContent, 'Checked a task result from Sample agent');
    for (const id of ['send', 'inspect']) {
      assert.equal(card(id).querySelector('.tool-target')?.textContent, 'Sample agent');
      assert.equal(card(id).querySelector('.tool-target')?.title, '@sample-agent');
    }
    assert.equal(card('exact').querySelector('.tool-name')?.textContent, 'Sent a message to Sample agent: “Hello”');
    const direct = app.toolSubjectCaption(recipient), resolved = app.toolSubjectCaption('@sample-agent');
    assert.ok(direct && resolved);
    assert.deepEqual({...resolved, open: undefined}, {...direct, open: undefined, title: '@sample-agent'});
    const supplied = app.state.conversations.get(JSON.stringify(['agent', host]))?.frame?.entries[0]?.messages?.[0]?.parts[0];
    assert.equal(supplied?.type, 'toolCall');
    if (supplied?.type === 'toolCall') assert.deepEqual(supplied.arguments?.value, {sessionId: '@sample-agent', message: 'Hello'});
    assert.deepEqual(app.state.workspace?.selectedTarget, target);
  }
});

test('ambiguous, missing and empty handles keep the unnamed recipient sentence', async () => {
  const second = '00000000-0000-4000-8000-000000000503';
  await show('handle-fallbacks', [agentFixture(recipient, {handle: 'duplicate', name: 'First agent'}), agentFixture(second, {handle: '@duplicate', name: 'Second agent'}),
    agentFixture('00000000-0000-4000-8000-000000000504', {handle: '', name: 'Empty handle'}), agentFixture('00000000-0000-4000-8000-000000000505', {handle: '@', name: 'Sign only'})],
  [call('duplicate', '@duplicate'), call('missing', '@missing'), call('empty', '@')]);
  for (const id of ['duplicate', 'missing', 'empty']) {
    assert.equal(card(id).querySelector('.tool-name')?.textContent, 'Sent a message to another conversation: “Hello”');
    assert.equal(card(id).querySelector('.tool-target')?.hidden, true);
  }
  assert.equal(app.toolSubjectCaption('@'), undefined);
  assert.equal(app.toolSubjectCaption(''), undefined);
});

test('a loaded row and a later name repaint existing handle cards through caption refresh', async () => {
  await show('handle-refresh', [], [call('late-send', '@sample-agent'), call('late-inspect', '@sample-agent', 'agent_inspect')]);
  const send = card('late-send'), inspect = card('late-inspect');
  assert.equal(send.querySelector('.tool-name')?.textContent, 'Sent a message to another conversation: “Hello”');
  transportLog.length = 0;
  const publish = (name: string) => event('agent.roster', {revision: app.state.rosterRevision + 1, changed: [agentFixture(recipient, {handle: 'sample-agent', name})], removed: [],
    scan: {state: 'ready', complete: true, visited: 2, skipped: 0, omitted: 0}, stale: false});
  publish('Sample agent'); await settle();
  assert.equal(card('late-send'), send); assert.equal(card('late-inspect'), inspect);
  assert.equal(send.querySelector('.tool-name')?.textContent, 'Sent a message to Sample agent: “Hello”');
  assert.equal(inspect.querySelector('.tool-name')?.textContent, 'Checked a task result from Sample agent');
  publish('Renamed agent'); await settle();
  assert.equal(send.querySelector('.tool-name')?.textContent, 'Sent a message to Renamed agent: “Hello”');
  assert.equal(inspect.querySelector('.tool-name')?.textContent, 'Checked a task result from Renamed agent');
  assert.equal(send.querySelector('.tool-target')?.textContent, 'Renamed agent');
  assert.equal(send.querySelector('.tool-target')?.title, '@sample-agent');
  assert.deepEqual(app.state.workspace?.selectedTarget, target);
  assert.equal(transportLog.some(item => item.path.startsWith('/api/agents?identity=') || item.path.includes('/inputs') || item.path.endsWith('/start')), false);
});
