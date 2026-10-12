import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRow, ProjectedFrame, PrimaryView } from '../shared/api.ts';
import { composerFolder, conversationPresentation, presentationGlyph, projectIdentity, projectLabels, agentHistoryEmpty } from './conversation-presentation.ts';
const row: AgentRow = {identity: 'agent:one', storageId: 'agent', cwd: '/projects/work', name: 'Worker', modifiedAt: 0,
  state: 'unavailable', owner: 'unknown', availability: 'live', partial: false,
  capabilities: {input: true, observe: true, history: true, abort: true, configure: false}};
const frame = (busy: boolean): ProjectedFrame => ({revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null,
  status: {busy}, coverage: {complete: true, truncated: false, omitted: 0}});
const target = {kind: 'agent' as const, identity: row.identity};
test('agent zero-entry presentation separates loading, negotiation failure, disconnect and confirmed empty', () => {
  const source = {hasEntries: false, connected: true, loading: false, ready: false};
  assert.match(agentHistoryEmpty(source)?.heading ?? '', /Loading/);
  const message = 'Host operation snapshot is unavailable. Required: snapshot/2.0.0, Durable 1.0.3. Host: snapshot/1.0.0, Durable 1.1.0.';
  const failed = agentHistoryEmpty({...source, error: {code: 'contract_mismatch', message}});
  assert.equal(failed?.heading, 'Agent history is unavailable.'); assert.equal(failed?.caption, message);
  assert.equal(agentHistoryEmpty({...source, connected: false})?.heading, 'History is disconnected.');
  assert.equal(agentHistoryEmpty({...source, availability: 'stored'})?.heading, 'History is disconnected.');
  assert.equal(agentHistoryEmpty({...source, ready: true, complete: false})?.heading, 'Agent history is unavailable.');
  assert.equal(agentHistoryEmpty({...source, ready: true, complete: true})?.heading, 'This agent has no messages yet.');
  assert.equal(agentHistoryEmpty({...source, hasEntries: true, connected: false}), undefined);
  assert.match(agentHistoryEmpty({...source, loading: true, ready: true, complete: true})?.heading ?? '', /Loading/);
});
test('live negotiated input overrides unavailable catalog claims without inventing idle', () => {
  const connected = conversationPresentation({target, row, connected: true});
  assert.equal(connected.activity, 'Connected'); assert.equal(connected.input, true); assert.equal(connected.busy, false);
  const settings = {...row, model: {provider: 'saved', modelId: 'catalog'}, thinkingLevel: 'low'};
  const accepted = {...frame(false), status: {busy: false, model: {provider: 'live', modelId: 'accepted'}}};
  const mixed = conversationPresentation({target, row: settings, frame: accepted, connected: true});
  assert.equal(mixed.retainedModel, false); assert.equal(mixed.retainedThinking, true);
  assert.equal(conversationPresentation({target, row: settings, frame: {...accepted, status: {...accepted.status, thinkingLevel: 'high'}}, connected: true}).retainedThinking, false);
  const noInput = conversationPresentation({target, row: {...row, capabilities: {...row.capabilities, history: true, observe: true, abort: false, configure: false, input: false}}, connected: true});
  assert.equal(noInput.activity, 'Connected'); assert.equal(noInput.input, false); assert.equal(noInput.guidance, 'Messages are unavailable for this agent.');
  assert.equal(conversationPresentation({target, row, frame: frame(false), connected: true}).activity, 'Ready');
  const working = conversationPresentation({target, row, frame: frame(true), connected: true});
  assert.equal(working.activity, 'Working'); assert.equal(working.busy, true); assert.equal(working.input, true);
});
test('only accepted live tool calls supply current tools and completed calls disappear', () => {
  const stale = {...row, state: 'working', currentTool: {name: 'old-tool', argument: 'old'}};
  assert.equal(conversationPresentation({target, row: stale, frame: frame(true), connected: true}).tool, undefined);
  const current = frame(true); current.live = [{id: 'live', kind: 'message', messages: [{id: 'm', role: 'assistant', state: 'partial', coverage: current.coverage, parts: [{type: 'toolCall', callId: 'call', name: 'read', arguments: {value: {path: 'current.ts'}, truncated: false}}]}]}];
  assert.deepEqual(conversationPresentation({target, row: stale, frame: current, connected: true}).tool, {name: 'read', argument: '{"path":"current.ts"}'});
  current.entries = [{id: 'result', kind: 'message', messages: [{id: 'r', role: 'toolResult', state: 'final', coverage: current.coverage, parts: [{type: 'toolResult', callId: 'call', name: 'read', parts: [], isError: false}]}]}];
  assert.equal(conversationPresentation({target, row: stale, frame: current, connected: true}).tool, undefined);
});

test('status glyphs distinguish ready, working, stored, stopped and unknown without changing words', () => {
  const ready = conversationPresentation({target, row, frame: frame(false), connected: true});
  const cases = [{...ready, activity: 'Ready'}, {...ready, activity: 'Working', busy: true},
    {...ready, activity: 'Not connected'}, {...ready, activity: 'Stopped'}, {...ready, activity: ''}];
  assert.equal(new Set(cases.map(presentationGlyph)).size, cases.length);
  assert.deepEqual(cases.map(presentationGlyph), ['✓', '●', '○', '!', '?']);
  assert.equal(presentationGlyph({...ready, activity: 'Connected'}), presentationGlyph(ready));
  for (const activity of ['Unavailable', 'Incompatible host', 'Session stopped']) assert.equal(presentationGlyph({...ready, activity}), '!');
  assert.equal(presentationGlyph({...ready, lastObserved: true}), presentationGlyph(ready));
  assert.equal(ready.activity, 'Ready'); assert.equal(ready.input, true);
});

test('availability loss defeats stale activity and another identity never supplies input', () => {
  assert.ok(row.capabilities);
  const capabilities = {...row.capabilities, input: false};
  for (const [state, activity] of [['stored','Not connected'], ['incompatible','Incompatible host'], ['unavailable','Unavailable']] as const) {
    const view = conversationPresentation({target, row, availability: {identity: row.identity, state, capabilities}, frame: frame(true), connected: true});
    assert.equal(view.activity, activity); assert.equal(view.busy, false); assert.equal(view.input, false);
    assert.equal(view.guidance, state === 'stored' ? 'Use Start agent to connect this agent.' : 'Messages are unavailable for this agent.');
  }
  const missing = conversationPresentation({target, row: {...row, identity: 'other'}, availability: {identity: 'other', state: 'live', capabilities: row.capabilities}, connected: true});
  assert.equal(missing.input, false); assert.equal(missing.activity, 'Unavailable');
});
test('connection loss marks only last observation and preserves target facts', () => {
  const view = conversationPresentation({target, row, frame: frame(true), connected: false});
  assert.equal(view.activity, 'Working'); assert.equal(view.lastObserved, true);
  assert.equal(projectIdentity(view, '/launch/path').path, row.cwd);
  assert.deepEqual(projectIdentity({}, '/launch/path'), {path: '/launch/path', name: 'path'});
  assert.deepEqual(projectIdentity({}), {path: undefined, name: 'Working folder'});
});
test('Primary identity and lifecycle never supply facts to an agent', () => {
  const primary: PrimaryView = {key: 'p', epoch: 1, cwd: '/primary', lifecycle: 'ready', activity: 'running', pendingOperationIds: [], pendingDialogs: [], capabilities: {}, model: {provider: 'provider', id: 'primary-model'}};
  assert.equal(conversationPresentation({target, row, primary, connected: true}).model, undefined);
  const view = conversationPresentation({target: {kind: 'primary', key: 'p', epoch: 1}, primary, connected: true});
  assert.equal(view.activity, 'Working'); assert.equal(view.input, true); assert.equal(view.cwd, '/primary');
  assert.equal(view.retainedThinking, false);
  assert.deepEqual(composerFolder(view, false), {text: 'Folder /primary', title: 'Reported Primary folder: /primary'});
  assert.deepEqual(composerFolder(row, true), {text: 'Saved folder /projects/work', title: 'Retained agent folder: /projects/work'});
  assert.equal(composerFolder({}, true), undefined);
  assert.equal(conversationPresentation({target: {kind: 'primary', key: 'p', epoch: 2}, primary, connected: true}).input, false);
});


test('project labels use the shortest unique component suffix, not an ambiguous basename', () => {
  const paths = ['/projects/one/checkout', '/projects/two/checkout', '/projects/notes'];
  assert.deepEqual([...projectLabels(paths).values()], ['one/checkout', 'two/checkout', 'notes']);
  for (const path of paths) assert.equal(projectIdentity({cwd: path}, '/launch', paths).path, path);
  assert.equal(projectIdentity({cwd: paths[0]}, undefined, paths).name, 'one/checkout');
  assert.equal(projectIdentity({}, '/projects/two/checkout', paths).name, 'two/checkout');
});
test('deep and suffix-of-path collisions retain enough path and a full-path marker', () => {
  const paths = ['/a/team/work', '/b/team/work', '/team/work', '/work', '/'];
  assert.deepEqual([...projectLabels(paths).values()], ['a/team/work', 'b/team/work', '/team/work', '/work', '/']);
  assert.equal(new Set(projectLabels(paths).values()).size, paths.length);
  assert.deepEqual([...projectLabels(['/a/work', '/a/mywork']).values()], ['work', 'mywork']);
});
test('multiple sessions in one directory and trailing separators share labels without changing path data', () => {
  const paths = ['/projects/checkout', '/projects/checkout/', '/projects/checkout', '/other/checkout/'];
  const labels = projectLabels(paths);
  assert.deepEqual([...labels.entries()], [['/projects/checkout', 'projects/checkout'], ['/projects/checkout/', 'projects/checkout'], ['/other/checkout/', 'other/checkout']]);
  assert.deepEqual(projectIdentity({cwd: '/projects/checkout/'}, undefined, paths), {path: '/projects/checkout/', name: 'projects/checkout'});
  assert.equal(projectLabels(['/projects/checkout', '/projects/checkout/']).get('/projects/checkout/'), 'checkout');
});
