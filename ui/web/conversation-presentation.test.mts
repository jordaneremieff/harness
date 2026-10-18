import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRow, ProjectedFrame, PrimaryView } from '../shared/api.ts';
import { composerFolder, conversationPresentation, presentationGlyph, presentationName, projectIdentity, projectLabels, agentViewStatus, responseOutcome } from './conversation-presentation.ts';
const row: AgentRow = {identity: 'agent:one', storageId: 'agent', cwd: '/projects/work', name: 'Worker', modifiedAt: 0,
  state: 'unavailable', owner: 'unknown', availability: 'live', partial: false,
  capabilities: {input: true, observe: true, history: true, abort: true, configure: false}};
const frame = (busy: boolean): ProjectedFrame => ({revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null,
  status: {busy}, coverage: {complete: true, truncated: false, omitted: 0}});
const target = {kind: 'agent' as const, identity: row.identity};
assert.ok(row.capabilities);
const negotiated = {identity: row.identity, availability: 'live' as const, capabilities: row.capabilities};
test('presentation tones come from source states without changing readiness',()=> {
  const states=[['ready','running','info'],['ready','compacting','info'],['ready','idle','success'],['ready','retrying','warning'],['ready','unknown','warning'],['stopped','idle','warning'],['failed','idle','error'],['starting','unknown','info']];
  for(const [lifecycle,activity,tone]of states){const primary={key:'p',epoch:1,lifecycle,activity} as PrimaryView;const view=conversationPresentation({target:{kind:'primary',key:'p',epoch:1},primary,connected:true});assert.equal(view.tone,tone,`${lifecycle}/${activity}`);assert.equal(view.input,lifecycle==='ready');}
  for(const availability of ['stored','unavailable','incompatible'] as const) {const view=conversationPresentation({target,row:{...row,availability},connected:true});assert.equal(view.tone,availability==='stored'?'secondary':'warning');assert.equal(view.input,false);}
  assert.equal(conversationPresentation({target,row,connected:true}).tone,'secondary');
  assert.equal(conversationPresentation({target,row,negotiated,frame:frame(true),connected:true}).tone,'info');
  assert.equal(conversationPresentation({target,row,negotiated,frame:frame(false),connected:true}).tone,'success');
  const compacting=frame(false);compacting.status.compactions={value:[{active:true}],truncated:false};assert.equal(conversationPresentation({target,row,negotiated,frame:compacting,connected:true}).tone,'info');
});
test('unchecked live claims stay neutral without admitting input or hiding real warnings', () => {
  const unchecked = conversationPresentation({target, row: {...row, state: 'working'}, connected: true});
  assert.equal(unchecked.activity, 'Connection not checked'); assert.equal(unchecked.tone, 'secondary'); assert.equal(unchecked.input, false); assert.equal(unchecked.busy, false); assert.equal(unchecked.tool, undefined);
  assert.equal(conversationPresentation({target, row, connected: false}).tone, 'warning');
  for (const availability of ['unavailable', 'incompatible'] as const) assert.equal(conversationPresentation({target, row: {...row, availability}, connected: true}).tone, 'warning');
  const stopped = frame(false); stopped.entries = [{id: 'stop', kind: 'message', messages: [{id: 'stopped', role: 'assistant', state: 'final', parts: [], stopReason: 'aborted', coverage: stopped.coverage}]}];
  const view = conversationPresentation({target, row, negotiated, frame: stopped, connected: true}); assert.equal(view.tone, 'warning'); assert.equal(view.activity, 'Stopped'); assert.equal(view.input, true);
});
test('agent display names reject identity fallbacks and retain shared suffixes in accessible names',()=> {
  const identity='00000000-0000-4000-8000-000000000099', target={kind:'agent' as const,identity};
  const unnamed=conversationPresentation({target,row:{...row,identity,name:identity,handle:undefined},connected:true});assert.equal(unnamed.name,'Unnamed conversation');assert.equal(presentationName(unnamed),'Unnamed conversation');
  const named=conversationPresentation({target,row:{...row,identity,name:'Review',handle:'reviewer'},caption:{name:'Review',tail:'2'},frame:{...frame(false),status:{busy:false,name:' '}},connected:true});assert.equal(named.name,'Review');assert.equal(presentationName(named),'Review · 2');assert.equal(target.identity,identity);
});
test('retry, response outcome and provider blocks do not change input readiness or connection', () => {
  const current = frame(true); current.status.retry = {attempt: 2, at: 1700000060000, error: 'unclassified provider detail'};
  let view = conversationPresentation({target, row, negotiated, frame: current, connected: true});
  assert.match(view.activity, /^Retrying · attempt 2 · next /); assert.equal(view.detail, current.status.retry.error); assert.equal(view.input, true); assert.equal(view.busy, true); assert.equal(view.tone,'warning');
  current.status.busy = false; delete current.status.retry;
  current.entries = [{id: 'failed', kind: 'message', messages: [{id: 'm', role: 'assistant', state: 'final', parts: [], stopReason: 'error', error: 'anything', coverage: current.coverage}]}];
  view = conversationPresentation({target, row, negotiated, frame: current, connected: true}); assert.equal(view.activity, 'Response failed'); assert.equal(view.input, true); assert.equal(view.busy, false); assert.equal(presentationGlyph(view), '!'); assert.equal(view.tone,'error');
  current.status.providerBlock = {blockId: 'b', conversationId: 1, providerSessionId: 'p', epoch: 1, model: {provider: 'fixture', modelId: 'fixture'}, error: 'opaque', errorRedacted: true, errorTruncated: true, source: 'provider', timestamp: 1, originalResults: [], omittedOriginalResults: 0};
  view = conversationPresentation({target, row, negotiated, frame: current, connected: true}); assert.equal(view.activity, 'Provider blocked'); assert.match(view.detail ?? '', /Configure this agent through Primary/); assert.match(view.detail ?? '', /redacted/); assert.match(view.detail ?? '', /shortened/);
  const published = conversationPresentation({target, row: {...row, publishedRetry: {attempt: 2, maxAttempts: 5, delayMs: 60000, error: 'published'}}, connected: true});
  assert.equal(published.activity, 'Connection not checked'); assert.equal(published.input, false);
});
test('a newer user or successful assistant record clears an earlier failed response', () => {
  const message = {id: 'failed', role: 'assistant', state: 'final' as const, parts: [], stopReason: 'error', coverage: {complete: true, truncated: false, omitted: 0}};
  const entry = {id: '1', kind: 'message', messages: [message]}; assert.equal(responseOutcome([entry]), 'failed');
  assert.equal(responseOutcome([entry, {...entry, id: '2', messages: [{...message, role: 'user'}]}]), undefined);
  assert.equal(responseOutcome([entry, {...entry, id: '2', messages: [{...message, stopReason: 'stop'}]}]), undefined);
  assert.equal(responseOutcome([{...entry, messages: [{...message, stopReason: 'aborted'}]}]), 'stopped');
});
test('one status combines read truth with independent connection and admission state', () => {
  const source = {hasEntries: false, connected: true, loading: false, ready: false};
  assert.equal(agentViewStatus(source).text, 'Messages not loaded.');
  const message = 'Required Durable 1.1.0; reader Durable 1.0.3.';
  const failed = agentViewStatus({...source, availability: 'incompatible', error: {code: 'contract_mismatch', message}});
  assert.equal(failed.text, 'History unavailable: saved messages use an unsupported format. · This agent cannot connect; messages remain read-only.'); assert.equal(failed.detail, message); assert.equal(failed.start, false);
  assert.equal(agentViewStatus({...source, connected: false}).text, 'History unavailable: the browser is disconnected.');
  assert.equal(agentViewStatus({...source, availability: 'stored', ready: true, complete: true}).text, 'No messages yet. · Agent is not connected.');
  const incomplete = agentViewStatus({...source, ready: true, complete: false, reason: 'Earlier saved messages are missing.'});
  assert.equal(incomplete.text, 'History unavailable: saved messages could not be confirmed.'); assert.equal(incomplete.detail, 'Earlier saved messages are missing.');
  assert.equal(agentViewStatus({...source, ready: true}).text, incomplete.text);
  assert.equal(agentViewStatus({...source, ready: true, complete: false, hasEntries: true}).text, '');
  assert.equal(agentViewStatus({...source, ready: true, complete: true}).text, 'No messages yet.');
  assert.equal(agentViewStatus({...source, hasEntries: true, connected: false}).text, 'The browser is disconnected.');
  assert.equal(agentViewStatus({...source, hasEntries: true, availability: 'stored'}).text, 'Agent is not connected.');
  assert.equal(agentViewStatus({...source, loading: true, hasEntries: true}).text, 'Updating messages…');
  const uncertain = agentViewStatus({...source, hasEntries: true, availability: 'stored', startAttempt: {pending: false, reason: 'Readiness timed out.'}});
  assert.equal(uncertain.start, false); assert.match(uncertain.text, /^Start not confirmed/); assert.equal(uncertain.detail, 'Readiness timed out.');
});
test('only an active history read reports loading for a cold retained agent', () => {
  const source = {hasEntries: false, connected: true, loading: false, ready: false, availability: 'stored' as const};
  const cold = agentViewStatus(source);
  assert.equal(cold.text, 'Messages not loaded. · Agent is not connected.');
  assert.equal(cold.start, true);
  assert.equal(agentViewStatus({...source, complete: true}).text, cold.text);
  assert.equal(agentViewStatus({...source, loading: true}).text, 'Loading messages… · Agent is not connected.');
  assert.equal(agentViewStatus({...source, loading: true, hasEntries: true}).text, 'Updating messages… · Agent is not connected.');
  assert.equal(agentViewStatus({...source, hasEntries: true}).text, 'Agent is not connected.');
  assert.equal(agentViewStatus({...source, ready: true, complete: true}).text, 'No messages yet. · Agent is not connected.');
});
test('unreadable saved messages use plain text and retain the exact diagnostic', () => {
  const message = 'The retained source is unreadable.';
  for (const hasEntries of [false, true]) {
    const view = agentViewStatus({hasEntries, connected: true, loading: false, ready: false, error: {code: 'source_unreadable', message}});
    assert.equal(view.text, 'History unavailable: saved messages could not be read.'); assert.equal(view.detail, message);
    assert.equal(view.start, false);
  }
});
test('read and connection diagnostics stay in detail without changing admission or retained history', () => {
  const message = `retained-read/1.0.0 request failed at host endpoint: ${'technical diagnostic '.repeat(80)}`;
  const connectionError = `task-submit/1.2.0 host unavailable: ${'connection diagnostic '.repeat(80)}`;
  for (const hasEntries of [false, true]) {
    const source = {hasEntries, connected: true, loading: false, ready: false, error: {code: 'host_unavailable', message}, connectionError};
    const view = agentViewStatus(source);
    assert.equal(view.text, 'History unavailable: saved messages could not be read. · Agent connection is unavailable.');
    assert.equal(view.detail, `${message}\n${connectionError}`); assert.equal(view.start, false);
    const stored = agentViewStatus({...source, availability: 'stored'}); assert.equal(stored.start, true);
    assert.equal(stored.detail, view.detail);
    const duplicate = agentViewStatus({...source, connectionError: message});
    assert.equal(duplicate.text, 'History unavailable: saved messages could not be read.');
  }
  const readOnly = agentViewStatus({hasEntries: true, connected: true, loading: false, ready: true, complete: true, availability: 'incompatible', input: false});
  assert.equal(readOnly.text, 'This agent cannot connect; messages remain read-only.');
  assert.equal(readOnly.start, false);
});
test('live negotiated input overrides unavailable catalog claims without inventing idle', () => {
  const connected = conversationPresentation({target, row, negotiated, connected: true});
  assert.equal(connected.activity, 'Connected'); assert.equal(connected.input, true); assert.equal(connected.busy, false);
  const settings = {...row, model: {provider: 'saved', modelId: 'catalog'}, thinkingLevel: 'low'};
  const accepted = {...frame(false), status: {busy: false, model: {provider: 'live', modelId: 'accepted'}}};
  const mixed = conversationPresentation({target, row: settings, negotiated, frame: accepted, connected: true});
  assert.equal(mixed.retainedModel, false); assert.equal(mixed.retainedThinking, true);
  assert.equal(conversationPresentation({target, row: settings, negotiated, frame: {...accepted, status: {...accepted.status, thinkingLevel: 'high'}}, connected: true}).retainedThinking, false);
  const noInput = conversationPresentation({target, row: {...row, capabilities: {...row.capabilities, history: true, observe: true, abort: false, configure: false, input: false}}, negotiated: {...negotiated, capabilities: {...negotiated.capabilities, input: false}}, connected: true});
  assert.equal(noInput.activity, 'Connected'); assert.equal(noInput.input, false); assert.equal(noInput.guidance, 'Messages are unavailable for this agent.');
  assert.equal(conversationPresentation({target, row, negotiated, frame: frame(false), connected: true}).activity, 'Ready');
  const working = conversationPresentation({target, row, negotiated, frame: frame(true), connected: true});
  assert.equal(working.activity, 'Working'); assert.equal(working.busy, true); assert.equal(working.input, true);
});
test('only accepted live tool calls supply current tools and completed calls disappear', () => {
  const stale = {...row, state: 'working', currentTool: {name: 'old-tool', argument: 'old'}};
  assert.equal(conversationPresentation({target, row: stale, negotiated, frame: frame(true), connected: true}).tool, undefined);
  const current = frame(true); current.live = [{id: 'live', kind: 'message', messages: [{id: 'm', role: 'assistant', state: 'partial', coverage: current.coverage, parts: [{type: 'toolCall', callId: 'call', name: 'read', arguments: {value: {path: 'current.ts'}, truncated: false}}]}]}];
  assert.deepEqual(conversationPresentation({target, row: stale, negotiated, frame: current, connected: true}).tool, {name: 'read', argument: '{"path":"current.ts"}'});
  current.entries = [{id: 'result', kind: 'message', messages: [{id: 'r', role: 'toolResult', state: 'final', coverage: current.coverage, parts: [{type: 'toolResult', callId: 'call', name: 'read', parts: [], isError: false}]}]}];
  assert.equal(conversationPresentation({target, row: stale, negotiated, frame: current, connected: true}).tool, undefined);
});

test('native compaction and nested tasks describe only the accepted current frame', () => {
  const current = frame(true); current.status.compactions = {value: [{taskId: 4, reason: 'manual', blocking: true, attempt: 0}], truncated: false};
  assert.equal(conversationPresentation({target, row, negotiated, frame: current, connected: true}).activity, 'Compacting…');
  current.live = [{id: 'live:tool:parent/child', kind: 'pi.tool-result', tool: {callId: 'parent/child', name: 'read', taskId: 3, parentTaskId: 2, parentCallId: 'parent',
    status: 'running', arguments: {value: {path: 'notes.md'}, truncated: false}, coverage: current.coverage}}];
  assert.deepEqual(conversationPresentation({target, row, negotiated, frame: current, connected: true}).tool, {name: 'read', argument: '{"path":"notes.md"}'});
  const tool = current.live[0].tool; assert.ok(tool); tool.status = 'done'; assert.equal(conversationPresentation({target, row, negotiated, frame: current, connected: true}).tool, undefined);
  const disconnected = conversationPresentation({target, row, negotiated: {...negotiated, availability: 'unavailable'}, frame: current, connected: true});
  assert.equal(disconnected.activity, 'Unavailable'); assert.equal(disconnected.tool, undefined);
  current.status.compactions = {value: [], truncated: false};
  assert.equal(conversationPresentation({target, row, negotiated, frame: current, connected: true}).activity, 'Working');
});

test('status glyphs distinguish ready, working, stored, stopped and unknown without changing words', () => {
  const ready = conversationPresentation({target, row, negotiated, frame: frame(false), connected: true});
  const cases = [{...ready, activity: 'Ready'}, {...ready, activity: 'Working', busy: true},
    {...ready, activity: 'Not connected'}, {...ready, activity: 'Stopped'}, {...ready, activity: ''}];
  assert.equal(new Set(cases.map(presentationGlyph)).size, cases.length);
  assert.deepEqual(cases.map(presentationGlyph), ['✓', '●', '○', '!', '?']);
  assert.equal(presentationGlyph({...ready, activity: 'Connected'}), presentationGlyph(ready));
  for (const activity of ['Unavailable', 'Connection unavailable', 'Session stopped']) assert.equal(presentationGlyph({...ready, activity}), '!');
  assert.equal(presentationGlyph({...ready, lastObserved: true}), presentationGlyph(ready));
  assert.equal(ready.activity, 'Ready'); assert.equal(ready.input, true);
});

test('availability loss defeats stale activity and another identity never supplies input', () => {
  assert.ok(row.capabilities);
  const capabilities = {...row.capabilities, input: false};
  for (const [state, activity] of [['stored','Not connected'], ['incompatible','Connection unavailable'], ['unavailable','Unavailable']] as const) {
    const view = conversationPresentation({target, row, availability: {identity: row.identity, state, capabilities}, frame: frame(true), connected: true});
    assert.equal(view.activity, activity); assert.equal(view.busy, false); assert.equal(view.input, false);
    assert.equal(view.guidance, state === 'stored' ? 'Use Start agent to connect this agent.' : 'Messages are unavailable for this agent.');
  }
  const missing = conversationPresentation({target, row: {...row, identity: 'other'}, availability: {identity: 'other', state: 'live', capabilities: row.capabilities}, connected: true});
  assert.equal(missing.input, false); assert.equal(missing.activity, 'Unavailable');
});
test('connection loss marks only last observation and preserves target facts', () => {
  const view = conversationPresentation({target, row, negotiated, frame: frame(true), connected: false});
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


test('a live catalog claim without exact negotiated evidence is unchecked and admits no input', () => {
  const claim = {...row, model: {provider: 'saved', modelId: 'claim-model'}, currentTool: {name: 'read', argument: 'claim.ts'}};
  const view = conversationPresentation({target, row: claim, frame: frame(true), connected: true});
  assert.equal(view.activity, 'Connection not checked'); assert.equal(view.input, false); assert.equal(view.busy, false); assert.equal(view.tool, undefined); assert.equal(view.retainedModel, true);
  assert.equal(presentationGlyph(view), '?');
  const other = conversationPresentation({target, row: claim, negotiated: {...negotiated, identity: 'other'}, connected: true});
  assert.equal(other.activity, view.activity); assert.equal(other.input, false);
  const unavailable = conversationPresentation({target, row: claim, negotiated: {...negotiated, availability: 'unavailable'}, connected: true});
  assert.equal(unavailable.activity, 'Unavailable'); assert.equal(unavailable.input, false);
});

test('unchecked live claims use plain connection guidance independently of retained reads', () => {
  const view = agentViewStatus({hasEntries: true, connected: true, loading: false, ready: true, availability: 'live', checked: false, input: false});
  assert.equal(view.text, 'Connection not checked.'); assert.equal(view.start, false); assert.equal(view.detail, '');
});
