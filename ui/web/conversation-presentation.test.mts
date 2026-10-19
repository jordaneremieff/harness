import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRow, ProjectedFrame, PrimaryView, SavedSession } from '../shared/api.ts';
import { effortText, modelText, composerFolder, conversationPresentation, presentationGlyph, presentationName, projectIdentity, projectLabels, agentHistoryNote, readsSavedMessages, agentComposerState, responseOutcome, settingsLabel } from './conversation-presentation.ts';
const row: AgentRow = {identity: 'agent:one', storageId: 'agent', cwd: '/projects/work', name: 'Worker', modifiedAt: 0,
  state: 'unavailable', owner: 'unknown', availability: 'live', partial: false,
  capabilities: {input: true, observe: true, history: true, abort: true, configure: false}};
const frame = (busy: boolean): ProjectedFrame => ({revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null,
  status: {busy}, coverage: {complete: true, truncated: false, omitted: 0}});
const target = {kind: 'agent' as const, identity: row.identity};
assert.ok(row.capabilities);
const negotiated = {identity: row.identity, availability: 'live' as const, capabilities: row.capabilities};
test('settings labels qualify only displayed last-observed fields and retain full model identity', () => {
  const base = {model:{provider:'provider',modelId:'long-model'},thinking:'high',retainedModel:false,retainedThinking:false};
  const cases = [
    [base,'Model long-model · Thinking high'],
    [{...base,retainedModel:true,retainedThinking:true},'Last observed: Model long-model · Thinking high'],
    [{...base,retainedModel:true},'Last observed model long-model · Thinking high'],
    [{...base,retainedThinking:true},'Model long-model · Last observed thinking high'],
    [{...base,thinking:undefined,retainedModel:true,retainedThinking:true},'Last observed model long-model'],
    [{...base,model:undefined,retainedModel:true,retainedThinking:true},'Last observed thinking high'],
    [{...base,model:undefined,thinking:undefined,retainedModel:true,retainedThinking:true},''],
  ] as const;
  for (const [view, label] of cases) { assert.equal(settingsLabel(view),label); assert.equal(settingsLabel(view,true),label.replace('long-model','provider/long-model')); }
});
test('Primary captions prefer current names and qualify only exact ready prompt metadata',()=> {
  const primary={key:'p',epoch:1,sessionId:'session',sessionFile:'/sessions/session.jsonl',lifecycle:'ready',activity:'idle'} as PrimaryView;
  const savedSession:SavedSession={id:'session',path:primary.sessionFile as string,project:'/project',revision:'r',modifiedAt:'2026-01-01T00:00:00Z',size:20,title:'A supplied first message '.repeat(8),titleSource:'prompt',titleState:'ready'};
  const source={target:{kind:'primary' as const,key:'p',epoch:1},primary,savedSession,connected:true};
  const prompt=conversationPresentation(source);assert.equal(prompt.name,`${savedSession.title.slice(0,64).trimEnd()}…`);assert.equal(prompt.nameDetail,`Title from first message, not a supplied name\n${savedSession.title}`);assert.equal(prompt.input,true);
  assert.equal(conversationPresentation({...source,primary:{...primary,sessionName:'Current name'}}).name,'Current name');
  assert.equal(conversationPresentation({...source,primary:{...primary,sessionName:'Current name',extension:{title:'Current extension title',statuses:{},widgets:{}}}}).name,'Current extension title');
  for(const changed of [{titleState:'pending' as const},{titleState:'unavailable' as const},{id:'different'},{path:'/other'},{titleSource:'name' as const,title:'Old saved name'},{title:'   '}]){const view=conversationPresentation({...source,savedSession:{...savedSession,...changed}});assert.equal(view.name,'Primary');assert.equal(view.nameDetail,undefined);}
  assert.equal(conversationPresentation({...source,savedSession:undefined}).name,'Primary');
  const cleared={...primary,sessionName:''};assert.equal(conversationPresentation({...source,primary:cleared}).name,prompt.name);assert.equal(conversationPresentation({...source,primary:cleared,savedSession:{...savedSession,titleSource:'name'}}).name,'Primary');
  const stopped=conversationPresentation({...source,primary:{...primary,lifecycle:'stopped'}});assert.equal(stopped.name,prompt.name);assert.equal(stopped.activity,'Stopped');assert.equal(stopped.input,false);
  assert.equal(conversationPresentation({...source,target:{kind:'primary',key:'p',epoch:2}}).name,'Primary');assert.equal(conversationPresentation({...source,target:undefined}).name,'Primary');
});
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
  assert.equal(unchecked.activity, 'Running'); assert.equal(unchecked.tone, 'secondary'); assert.equal(unchecked.input, false); assert.equal(unchecked.busy, false); assert.equal(unchecked.tool, undefined);
  assert.equal(conversationPresentation({target, row, connected: false}).tone, 'warning');
  for (const availability of ['unavailable', 'incompatible'] as const) assert.equal(conversationPresentation({target, row: {...row, availability}, connected: true}).tone, 'warning');
  const stopped = frame(false); stopped.entries = [{id: 'stop', kind: 'message', messages: [{id: 'stopped', role: 'assistant', state: 'final', parts: [], stopReason: 'aborted', coverage: stopped.coverage}]}];
  const view = conversationPresentation({target, row, negotiated, frame: stopped, connected: true}); assert.equal(view.tone, 'warning'); assert.equal(view.activity, 'Stopped'); assert.equal(view.input, true);
});
test('only an unchecked live catalog claim hides the roster state, never its canonical fact', () => {
  for (const state of ['working', 'failed', 'done']) {
    const view = conversationPresentation({target, row: {...row, state}, connected: true});
    assert.equal(view.hideVisibleState, true); assert.equal(view.activity, 'Running'); assert.equal(view.input, false);
  }
  for (const availability of ['stored', 'unavailable', 'incompatible'] as const) {
    assert.equal(conversationPresentation({target, row: {...row, availability}, connected: true}).hideVisibleState, false);
  }
  assert.equal(conversationPresentation({target, row, connected: false}).hideVisibleState, false);
  assert.equal(conversationPresentation({target, connected: true}).hideVisibleState, false);
  assert.equal(conversationPresentation({target, row: {...row, identity: 'other'}, connected: true}).hideVisibleState, false);
  assert.equal(conversationPresentation({target, row, negotiated: {...negotiated, identity: 'other'}, connected: true}).hideVisibleState, true);
  assert.equal(conversationPresentation({target, row, availability: {identity: row.identity, state: 'live', capabilities: row.capabilities}, connected: true}).hideVisibleState, false);
  const retry = frame(true); retry.status.retry = {attempt: 2, at: 1700000060000, error: 'retry detail'};
  const failed = frame(false); failed.entries = [{id: 'error', kind: 'message', messages: [{id: 'error', role: 'assistant', state: 'final', parts: [], stopReason: 'error', coverage: failed.coverage}]}];
  for (const current of [undefined, frame(false), frame(true), retry, failed]) {
    assert.equal(conversationPresentation({target, row, negotiated, frame: current, connected: true}).hideVisibleState, false);
  }
  assert.equal(conversationPresentation({connected: true}).hideVisibleState, undefined);
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
  assert.equal(published.activity, 'Running'); assert.equal(published.input, false);
});
test('a newer user or successful assistant record clears an earlier failed response', () => {
  const message = {id: 'failed', role: 'assistant', state: 'final' as const, parts: [], stopReason: 'error', coverage: {complete: true, truncated: false, omitted: 0}};
  const entry = {id: '1', kind: 'message', messages: [message]}; assert.equal(responseOutcome([entry]), 'failed');
  assert.equal(responseOutcome([entry, {...entry, id: '2', messages: [{...message, role: 'user'}]}]), undefined);
  assert.equal(responseOutcome([entry, {...entry, id: '2', messages: [{...message, stopReason: 'stop'}]}]), undefined);
  assert.equal(responseOutcome([{...entry, messages: [{...message, stopReason: 'aborted'}]}]), 'stopped');
});
test('history notes report only the read and keep exact diagnostics in detail', () => {
  const source = {hasEntries: false, connected: true, loading: false, ready: false};
  assert.deepEqual(agentHistoryNote(source), {text: 'Messages not loaded.', detail: '', reload: true, label: 'Load messages'});
  const message = 'Required Durable 1.1.0; reader Durable 1.0.3.';
  assert.deepEqual(agentHistoryNote({...source, error: {code: 'contract_mismatch', message}}), {text: 'Saved messages use an unsupported format.', detail: message, reload: true, label: 'Reload messages'});
  assert.equal(agentHistoryNote({...source, connected: false}).text, 'Messages are unavailable while the browser is disconnected.');
  const incomplete = agentHistoryNote({...source, ready: true, complete: false});
  assert.deepEqual(incomplete, {text: 'Saved messages could not be confirmed.', detail: '', reload: true, label: 'Reload messages'});
  assert.equal(agentHistoryNote({...source, ready: true}).text, incomplete.text);
  assert.equal(agentHistoryNote({...source, ready: true, complete: false, hasEntries: true}).text, '');
  assert.equal(agentHistoryNote({...source, ready: true, complete: true}).text, 'No messages yet.');
  assert.equal(agentHistoryNote({...source, hasEntries: true, connected: false}).text, '');
  assert.equal(agentHistoryNote({...source, loading: true, hasEntries: true}).text, '');
  assert.equal(agentHistoryNote({...source, loading: true}).text, 'Loading messages…');
  for (const text of [agentHistoryNote(source).text, agentHistoryNote({...source, loading: true}).text, agentHistoryNote({...source, ready: true, complete: true}).text]) assert.doesNotMatch(text, /connected/i);
});
test('only an active history read reports loading for a cold retained agent', () => {
  const source = {hasEntries: false, connected: true, loading: false, ready: false};
  assert.equal(agentHistoryNote(source).text, 'Messages not loaded.');
  assert.equal(agentHistoryNote({...source, complete: true}).text, 'Messages not loaded.');
  assert.equal(agentHistoryNote({...source, loading: true}).text, 'Loading messages…');
  assert.equal(agentHistoryNote({...source, loading: true, hasEntries: true}).text, '');
  assert.equal(agentHistoryNote({...source, ready: true, complete: true}).text, 'No messages yet.');
});
test('the first read of a stored or unavailable agent says it reads saved messages, and saved messages with entries show no note', () => {
  const source = {hasEntries: false, connected: true, loading: false, ready: false, availability: 'stored' as const};
  assert.deepEqual(agentHistoryNote({...source, loading: true}), {text: 'Reading saved messages…', detail: '', reload: false, label: 'Load messages'});
  for (const availability of ['unavailable', 'incompatible'] as const) assert.equal(agentHistoryNote({...source, availability, loading: true}).text, 'Reading saved messages…');
  for (const extra of [{}, {loading: true}, {ready: true, complete: true}, {ready: true, complete: false}]) assert.deepEqual(agentHistoryNote({...source, hasEntries: true, ...extra}), {text: '', detail: '', reload: false, label: 'Load messages'});
  assert.deepEqual(agentHistoryNote({...source, ready: true, complete: true}), {text: 'No messages yet.', detail: '', reload: false, label: 'Load messages'});
  assert.deepEqual(agentHistoryNote(source), {text: 'Messages not loaded.', detail: '', reload: true, label: 'Load messages'});
  const failed = agentHistoryNote({...source, hasEntries: true, ready: true, error: {message: 'Unreadable'}});
  assert.deepEqual([failed.text, failed.label, failed.reload], ['Saved messages could not be read.', 'Reload messages', true]);
  assert.equal(agentHistoryNote({...source, ready: true, complete: false}).label, 'Reload messages');
  assert.equal(readsSavedMessages(source), true); assert.equal(readsSavedMessages({...source, availability: 'live'}), false);
  assert.equal(readsSavedMessages({...source, connected: false}), false); assert.equal(readsSavedMessages({connected: true}), false);
});
test('live agents and a disconnected browser keep the ordinary read wording', () => {
  const source = {hasEntries: false, connected: true, loading: false, ready: false};
  for (const availability of [undefined, 'live' as const]) assert.equal(agentHistoryNote({...source, availability, loading: true}).text, 'Loading messages…');
  const offline = {...source, availability: 'stored' as const, connected: false};
  assert.equal(agentHistoryNote({...offline, loading: true}).text, 'Loading messages…');
  assert.deepEqual(agentHistoryNote(offline), {text: 'Messages are unavailable while the browser is disconnected.', detail: '', reload: false, label: 'Load messages'});
});
test('unreadable saved messages use plain text, offer a reload, and retain the exact diagnostic', () => {
  const message = 'The retained source is unreadable.';
  for (const hasEntries of [false, true]) {
    for (const code of ['source_unreadable', 'host_unavailable']) {
      const view = agentHistoryNote({hasEntries, connected: true, loading: false, ready: false, error: {code, message}});
      assert.equal(view.text, 'Saved messages could not be read.'); assert.equal(view.detail, message); assert.equal(view.reload, true);
    }
  }
});
test('the composer state names what the draft needs before it can be sent', () => {
  const source = {connected: true};
  assert.equal(agentComposerState({...source, availability: 'live', input: true, checked: true}), undefined);
  assert.equal(agentComposerState({...source, availability: 'live', checked: false, input: false}), undefined);
  assert.deepEqual(agentComposerState({...source, availability: 'stored'}), {kind: 'start', line: 'Not running. Start it to send a message.', label: 'Not running', action: {label: 'Start'}, detail: ''});
  assert.equal(agentComposerState({connected: false, availability: 'stored'}), undefined);
  const starting = agentComposerState({...source, availability: 'stored', startAttempt: {pending: true}});
  assert.equal(starting?.kind, 'starting'); assert.equal(starting?.line, 'Starting the agent…'); assert.equal(starting?.label, 'Starting the agent'); assert.equal(starting?.action?.pending, true); assert.equal(starting?.action?.disabled, true);
  const failed = agentComposerState({...source, availability: 'stored', startAttempt: {pending: false, reason: 'Readiness timed out.'}});
  assert.equal(failed?.kind, 'failed'); assert.equal(failed?.line, 'Start did not complete.'); assert.equal(failed?.label, 'Start did not complete'); assert.equal(failed?.action?.label, 'Try again'); assert.equal(failed?.detail, 'Readiness timed out.');
  for (const availability of ['incompatible', 'unavailable'] as const) {
    const view = agentComposerState({...source, availability}); assert.equal(view?.kind, 'read-only'); assert.equal(view?.line, 'This agent cannot run here. Messages are read only.'); assert.equal(view?.label, 'This agent cannot run here'); assert.equal(view?.action, undefined);
  }
  const reason = 'Check the agent after the browser reconnects.';
  const noInput = agentComposerState({...source, availability: 'live', checked: true, input: false, reason}); assert.equal(noInput?.line, 'Messages are read only.'); assert.equal(noInput?.label, 'Read only');
  const connectionError = `task-submit/1.2.0 host unavailable: ${'diagnostic '.repeat(40)}`;
  const failedCheck = agentComposerState({...source, availability: 'stored', connectionError}); assert.equal(failedCheck?.kind, 'unreachable'); assert.equal(failedCheck?.line, 'Could not reach the agent.'); assert.equal(failedCheck?.label, 'Could not reach the agent'); assert.equal(failedCheck?.action?.label, 'Check again'); assert.equal(failedCheck?.detail, connectionError);
  const checking = agentComposerState({...source, availability: 'live', checked: true, input: true, checking: true}); assert.equal(checking?.kind, 'checking'); assert.equal(checking?.line, 'Checking the agent…'); assert.equal(checking?.label, 'Checking the agent…'); assert.equal(checking?.action, undefined);
  const blocked = agentComposerState({...source, availability: 'live', checked: true, input: true, blocked: 'Quota reached.'});
  assert.deepEqual(blocked, {kind: 'notice', line: 'Provider blocked. Configure this agent through Primary.', label: 'Provider blocked', detail: 'Quota reached.'});
});
test('live negotiated input overrides unavailable catalog claims without inventing idle', () => {
  const connected = conversationPresentation({target, row, negotiated, connected: true});
  assert.equal(connected.activity, 'Ready'); assert.equal(connected.input, true); assert.equal(connected.busy, false);
  const settings = {...row, model: {provider: 'saved', modelId: 'catalog'}, thinkingLevel: 'low'};
  const accepted = {...frame(false), status: {busy: false, model: {provider: 'live', modelId: 'accepted'}}};
  const mixed = conversationPresentation({target, row: settings, negotiated, frame: accepted, connected: true});
  assert.equal(mixed.retainedModel, false); assert.equal(mixed.retainedThinking, true);
  assert.equal(conversationPresentation({target, row: settings, negotiated, frame: {...accepted, status: {...accepted.status, thinkingLevel: 'high'}}, connected: true}).retainedThinking, false);
  const noInput = conversationPresentation({target, row: {...row, capabilities: {...row.capabilities, history: true, observe: true, abort: false, configure: false, input: false}}, negotiated: {...negotiated, capabilities: {...negotiated.capabilities, input: false}}, connected: true});
  assert.equal(noInput.activity, 'Read only'); assert.equal(noInput.input, false); assert.equal(noInput.guidance, 'Messages are unavailable for this agent.');
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
  assert.equal(disconnected.activity, 'Read only'); assert.equal(disconnected.tool, undefined);
  current.status.compactions = {value: [], truncated: false};
  assert.equal(conversationPresentation({target, row, negotiated, frame: current, connected: true}).activity, 'Working');
});

test('status glyphs distinguish ready, working, stored, stopped and unknown without changing words', () => {
  const ready = conversationPresentation({target, row, negotiated, frame: frame(false), connected: true});
  const cases = [{...ready, activity: 'Ready'}, {...ready, activity: 'Working', busy: true},
    {...ready, activity: 'Not running'}, {...ready, activity: 'Stopped'}, {...ready, activity: ''}];
  assert.equal(new Set(cases.map(presentationGlyph)).size, cases.length);
  assert.deepEqual(cases.map(presentationGlyph), ['✓', '●', '○', '!', '?']);
  assert.equal(presentationGlyph({...ready, activity: 'Connected'}), '?'); assert.equal(presentationGlyph({...ready, activity: 'Running'}), '?');
  for (const activity of ['Start failed', 'Provider blocked', 'Session stopped']) assert.equal(presentationGlyph({...ready, activity}), '!');
  assert.equal(presentationGlyph({...ready, activity: 'Read only'}), '○');
  assert.equal(presentationGlyph({...ready, lastObserved: true}), presentationGlyph(ready));
  assert.equal(ready.activity, 'Ready'); assert.equal(ready.input, true);
});

test('availability loss defeats stale activity and another identity never supplies input', () => {
  assert.ok(row.capabilities);
  const capabilities = {...row.capabilities, input: false};
  for (const [state, activity] of [['stored','Not running'], ['incompatible','Read only'], ['unavailable','Read only']] as const) {
    const view = conversationPresentation({target, row, availability: {identity: row.identity, state, capabilities}, frame: frame(true), connected: true});
    assert.equal(view.activity, activity); assert.equal(view.busy, false); assert.equal(view.input, false);
    assert.equal(view.guidance, state === 'stored' ? 'Start this agent to send.' : 'Messages are unavailable for this agent.');
  }
  const missing = conversationPresentation({target, row: {...row, identity: 'other'}, availability: {identity: 'other', state: 'live', capabilities: row.capabilities}, connected: true});
  assert.equal(missing.input, false); assert.equal(missing.activity, 'Read only');
});
test('connection loss marks only last observation and preserves target facts', () => {
  const view = conversationPresentation({target, row, negotiated, frame: frame(true), connected: false});
  assert.equal(view.activity, 'Connection lost; activity unknown'); assert.equal(view.lastObserved, true); assert.equal(view.busy, false); assert.equal(view.input, false);
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
  assert.equal(view.activity, 'Running'); assert.equal(view.input, false); assert.equal(view.busy, false); assert.equal(view.tool, undefined); assert.equal(view.retainedModel, true);
  assert.equal(presentationGlyph(view), '?');
  const other = conversationPresentation({target, row: claim, negotiated: {...negotiated, identity: 'other'}, connected: true});
  assert.equal(other.activity, view.activity); assert.equal(other.input, false);
  const unavailable = conversationPresentation({target, row: claim, negotiated: {...negotiated, availability: 'unavailable'}, connected: true});
  assert.equal(unavailable.activity, 'Read only'); assert.equal(unavailable.input, false);
});

test('stored agents report their own start attempt in the activity word', () => {
  const stored = {target, row, availability: {identity: row.identity, state: 'stored' as const, capabilities: row.capabilities}, connected: true};
  assert.equal(conversationPresentation(stored).activity, 'Not running');
  assert.equal(conversationPresentation({...stored, start: {pending: true}}).activity, 'Starting…');
  const failed = conversationPresentation({...stored, start: {pending: false, reason: 'Timed out.'}});
  assert.equal(failed.activity, 'Start failed'); assert.equal(failed.tone, 'warning'); assert.equal(presentationGlyph(failed), '!');
});

test('model text prefers the model list name, then the reported name, then the id; effort is capitalized', () => {
  assert.equal(modelText({modelId: 'id', name: 'Reported'}, 'Listed'), 'Listed');
  assert.equal(modelText({modelId: 'id', name: 'Reported'}), 'Reported');
  assert.equal(modelText({modelId: 'id', name: '  '}, ' '), 'id'); assert.equal(modelText({modelId: 'id'}), 'id');
  assert.equal(effortText('high'), 'High'); assert.equal(effortText('xhigh'), 'Xhigh'); assert.equal(effortText(''), '');
});
