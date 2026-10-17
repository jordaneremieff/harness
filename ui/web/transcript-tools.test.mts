import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryView, PartView } from '../shared/api.ts';
import { actionableEntry, slot, communicationDisclosureKeys, TranscriptIndex, ToolElapsedClock, toolTime } from './transcript-tools.ts';

const coverage = {complete: true, truncated: false, omitted: 0};
function entry(id: string, parts: PartView[]): EntryView { return {id, kind: 'message', messages: [{id, role: 'assistant', state: 'final', parts, coverage}]}; }
const call = (id: string): PartView => ({type: 'toolCall', callId: id, name: 'read', arguments: {value: {}, truncated: false}});
const result = (id: string, text: string): PartView => ({type: 'toolResult', callId: id, name: 'read', isError: false, parts: [{type: 'text', text}]});

test('native nested tasks use supplied status and duration without a model call or start clock', () => {
  const tool: NonNullable<EntryView['tool']> = {callId: 'parent/child', name: 'read', taskId: 3, parentTaskId: 2, parentCallId: 'parent',
    status: 'running', arguments: {value: {path: 'notes.md'}, truncated: false}, parts: [{type: 'text', text: 'partial'}], coverage};
  const nested = (value = tool): EntryView => ({id: 'live:tool:parent/child', kind: 'pi.tool-result', tool: value});
  const index = new TranscriptIndex(); index.update([nested()], new Map());
  const joined = index.joined.get(tool.callId); assert.ok(joined); assert.equal(joined.status, 'working'); assert.equal(joined.parentCallId, 'parent');
  assert.equal(joined.taskId, 3); assert.equal(joined.parentTaskId, 2); assert.equal(joined.observedStart, undefined); assert.equal(toolTime(joined), '');
  assert.equal(index.sessions.size, 0); assert.equal(index.disclosures.get('tool:parent/child'), 'live:tool:parent/child');
  for (const [value, status] of [[{...tool, status: 'pending' as const}, 'pending'], [{...tool, status: 'done' as const}, 'ended'],
    [{...tool, status: 'done' as const, isError: false, durationMs: 0}, 'success'], [{...tool, status: 'done' as const, isError: true}, 'error']] as const) {
    index.update([nested(value)], new Map()); assert.equal(index.joined.get(tool.callId)?.status, status);
    assert.equal(index.joined.get(tool.callId)?.duration, 'durationMs' in value ? 0 : undefined);
  }
  index.update([], new Map()); assert.equal(index.joined.size, 0); assert.equal(index.disclosures.size, 0);
});

test('partial call arguments prepare without implying execution or changing historical unresolved calls', () => {
  const index = new TranscriptIndex(), historical = entry('historical', [call('old')]);
  for (const stopReason of ['pending','stop','toolUse']) {
    const source = entry('live', [call('new')]); const message = source.messages?.[0]; assert.ok(message);
    message.state = 'partial'; message.stopReason = stopReason;
    index.update([historical, source], new Map());
    assert.equal(index.joined.get('new')?.status, 'preparing');
    assert.equal(index.joined.get('new')?.observedStart, undefined);
    assert.equal(index.joined.get('old')?.status, 'missing');
    for (const [nativeStatus, expected] of [['pending','pending'],['running','working'],['done','ended']] as const) {
      index.update([historical, source], new Map([['new',{callId:'new',name:'read',phase:'update',nativeStatus}]]));
      assert.equal(index.joined.get('new')?.status, expected);
      assert.equal(index.joined.get('old')?.status, 'missing');
    }
    index.update([historical, {...source,messages:[{...message,state:'final'}]}], new Map());
    assert.equal(index.joined.get('new')?.status, 'missing');
    index.update([historical, source, entry('output',[result('new','Supplied output')])], new Map());
    assert.equal(index.joined.get('new')?.status, 'success');
  }
});

test('partial tool results remain active until their final result without an invented start time', () => {
  const index = new TranscriptIndex(), source = entry('progress', [result('read', 'first output')]);
  const message = source.messages?.[0]; assert.ok(message); message.state = 'partial';
  index.update([source], new Map());
  assert.equal(index.joined.get('read')?.status, 'working');
  assert.equal(index.joined.get('read')?.observedStart, undefined);
  assert.equal(toolTime(index.joined.get('read') as NonNullable<ReturnType<typeof index.joined.get>>), '');
  index.update([{...source, messages: [{...message, state: 'final'}]}], new Map());
  assert.equal(index.joined.get('read')?.status, 'success');
});

test('current native slots supply exact state before output without classifying other retained calls', () => {
  const index = new TranscriptIndex(), source = entry('calls', [call('active'), call('historical')]);
  for (const [nativeStatus, status] of [['pending', 'pending'], ['running', 'working'], ['done', 'ended']] as const) {
    index.update([source], new Map([['active', {callId: 'active', name: 'read', phase: 'update', nativeStatus}]]));
    const active = index.joined.get('active'); assert.ok(active); assert.equal(active.status, status);
    assert.equal(active.result, undefined); assert.equal(active.observedStart, undefined); assert.equal(toolTime(active), '');
    assert.equal(index.joined.get('historical')?.status, 'missing');
  }
  const output = entry('output', [result('active', 'Partial source text')]); const message = output.messages?.[0]; assert.ok(message);
  message.state = 'partial';
  index.update([source, output], new Map([['active', {callId: 'active', name: 'read', phase: 'update', nativeStatus: 'running'}]]));
  assert.equal(index.joined.get('active')?.status, 'working'); assert.deepEqual(index.joined.get('active')?.result, [{type: 'text', text: 'Partial source text'}]);
  index.update([source], new Map()); assert.equal(index.joined.get('active')?.status, 'missing');
});
test('current native done state does not replace a recorded tool outcome', () => {
  for (const isError of [false, true]) {
    const index = new TranscriptIndex(), source = entry('call', [call('active')]);
    const output = entry('output', [{type: 'toolResult', callId: 'active', name: 'read', parts: [], isError}]);
    index.update([source, output], new Map([['active', {callId: 'active', name: 'read', phase: 'update', nativeStatus: 'done'}]]));
    assert.equal(index.joined.get('active')?.status, isError ? 'error' : 'success');
  }
});
test('communication disclosures follow their message owner and clear on source removal', () => {
  const index = new TranscriptIndex(); const source = entry('peer', []); const message = source.messages?.[0]; assert.ok(message); message.communication = {state: 'unresolved'};
  const keys = communicationDisclosureKeys('peer', 'peer');
  index.update([source], new Map()); for (const key of keys) assert.equal(index.disclosures.get(key), 'peer');
  index.update([], new Map()); for (const key of keys) assert.equal(index.disclosures.has(key), false);
  assert.ok(communicationDisclosureKeys('a'.repeat(256), 'b'.repeat(256)).every(key => key.length <= 256));
  assert.notDeepEqual(communicationDisclosureKeys('a:b', 'c'), communicationDisclosureKeys('a', 'b:c'));
});
test('elapsed formatting uses only observed starts and retains supplied completed durations', () => {
  const base = {callId: 'x', name: 'read', owner: 'entry', slot: 'slot', status: 'working'};
  assert.equal(toolTime(base, 90000), '');
  assert.equal(toolTime({...base, observedStart: 1000}, 1000), '0s elapsed');
  assert.equal(toolTime({...base, observedStart: 1000}, 60999), '59s elapsed');
  assert.equal(toolTime({...base, observedStart: 1000}, 62000), '1m 1s elapsed');
  assert.equal(toolTime({...base, observedStart: 1000}, 0), '0s elapsed');
  assert.equal(toolTime({...base, observedStart: 1000, status: 'success', duration: 123}, 90000), '123 ms');
  assert.equal(toolTime({...base, observedStart: 1000, status: 'error'}, 90000), '');
});
test('one elapsed clock starts only with visible timed work and stops on hide, completion, unmount and reset', t => {
  t.mock.timers.enable({apis: ['setInterval']});
  let painted = false; let visible = true; let working = true; let observed = true; let writes = 0; let calls = 0;
  const clock = new ToolElapsedClock(() => { calls++; const active = painted && visible && working && observed; if (active) writes++; return active; });
  clock.sync(); const idle = calls; t.mock.timers.tick(3000); assert.equal(calls, idle);
  painted = true; observed = false; clock.sync(); const unknown = calls; t.mock.timers.tick(3000); assert.equal(calls, unknown);
  observed = true; clock.sync(); clock.sync(); const before = writes; t.mock.timers.tick(1000); assert.equal(writes, before + 1);
  visible = false; clock.sync(); const hidden = calls; t.mock.timers.tick(3000); assert.equal(calls, hidden);
  visible = true; clock.sync(); working = false; t.mock.timers.tick(1000); const ended = calls; t.mock.timers.tick(3000); assert.equal(calls, ended);
  working = true; clock.sync(); painted = false; clock.sync(); const unmounted = calls; t.mock.timers.tick(3000); assert.equal(calls, unmounted);
  painted = true; clock.sync(); clock.stop(); clock.stop(); const reset = calls; t.mock.timers.tick(3000); assert.equal(calls, reset);
});
test('joined tools carry observed starts and invalidate timing changes without inventing history starts', () => {
  const index = new TranscriptIndex(); const entries = [entry('owner', [call('x')])];
  index.update(entries, new Map()); assert.equal(index.joined.get('x')?.observedStart, undefined);
  index.update(entries, new Map([['x', {callId: 'x', name: 'read', phase: 'start', observedStart: 1000}]]));
  assert.equal(index.joined.get('x')?.observedStart, 1000); const first = index.joined.get('x');
  index.update(entries, new Map([['x', {callId: 'x', name: 'read', phase: 'start', observedStart: 2000}]]));
  assert.notEqual(index.joined.get('x'), first); assert.equal(index.changed.has('owner'), true);
  index.update(entries, new Map()); assert.equal(index.joined.get('x')?.observedStart, undefined);
});
test('historical calls never imply execution and known child disclosures follow the actual call owner', () => {
  const index = new TranscriptIndex(); const owner = entry('call', [call('x')]);
  index.update([owner], new Map()); assert.equal(index.joined.get('x')?.status, 'missing'); assert.equal(toolTime(index.joined.get('x') as NonNullable<ReturnType<typeof index.joined.get>>), '');
  for (const key of ['tool:x', 'arguments:x', 'raw-output:x']) assert.equal(index.disclosures.get(key), 'call');
  index.update([owner], new Map([['x', {callId: 'x', name: 'read', phase: 'update'}]])); assert.equal(index.joined.get('x')?.status, 'missing');
  index.update([owner], new Map([['x', {callId: 'x', name: 'read', phase: 'update', parts: [{type: 'text', text: 'partial supplied result'}]}]]));
  assert.equal(index.joined.get('x')?.status, 'available');
  index.update([owner], new Map([['x', {callId: 'x', name: 'read', phase: 'start', observedStart: 1000}]])); assert.equal(index.joined.get('x')?.status, 'working');
  const supplied = entry('result', [{type: 'toolResult', callId: 'x', name: 'different supplied result name', isError: false, parts: [{type: 'text', text: 'error is only literal text'}]}]);
  index.update([owner, supplied], new Map()); assert.equal(index.joined.get('x')?.status, 'success'); assert.equal(index.joined.get('x')?.name, 'read');
  index.update([supplied], new Map()); for (const key of ['tool:x', 'arguments:x', 'raw-output:x']) assert.equal(index.disclosures.get(key), 'result');
  index.update([], new Map()); assert.equal(index.disclosures.size, 0);
});
test('text deltas inspect changed entries without reading retained message parts', () => {
  const index = new TranscriptIndex(); let reads = 0;
  const retained = entry('retained', [call('tool')]); const parts = retained.messages?.[0]?.parts;
  Object.defineProperty(retained.messages?.[0], 'parts', {get: () => { reads++; return parts; }});
  const tail = entry('tail', [{type: 'text', text: 'a'}]);
  index.update([retained, tail], new Map()); const before = reads; const tool = index.joined.get('tool');
  index.update([retained, entry('tail', [{type: 'text', text: 'ab'}])], new Map());
  assert.equal(reads, before); assert.equal(index.joined.get('tool'), tool);
  assert.deepEqual([...index.changed], ['tail']);
});
test('changed results and tool state update the call owner and preserve exact result parts', () => {
  const index = new TranscriptIndex(); const owner = entry('call', [call('x')]); const answer = entry('result', [result('x', 'one')]);
  index.update([owner, answer], new Map());
  assert.equal(index.joined.get('x')?.owner, 'call');
  assert.equal(index.disclosures.get('tool:x'), 'call');
  const parts: PartView[] = [{type: 'text', text: 'two'}];
  index.update([owner, answer], new Map([['x', {callId: 'x', name: 'read', phase: 'end', parts, isError: true}]]));
  assert.equal(index.joined.get('x')?.result, parts); assert.equal(index.joined.get('x')?.status, 'error');
  assert.equal(index.changed.has('call'), true); assert.equal(index.changed.has('result'), true);
  index.update([answer], new Map()); assert.equal(index.joined.get('x')?.owner, 'result');
  index.update([], new Map()); assert.equal(index.joined.size, 0); assert.equal(index.disclosures.size, 0);
});
test('reorder reassigns duplicate calls and disclosure owners without losing tool results', () => {
  const index = new TranscriptIndex(); const a = entry('a', [call('x'), {type: 'thinking', text: 'thought'}]); const b = entry('b', [call('x'), result('x', 'retained')]);
  index.update([a, b], new Map()); assert.equal(index.joined.get('x')?.owner, 'a');
  index.update([b, a], new Map()); assert.equal(index.joined.get('x')?.owner, 'b');
  assert.equal(index.disclosures.get('thinking:a:a:1'), 'a');
  index.update([b], new Map()); assert.equal(index.disclosures.has('thinking:a:a:1'), false);
});
test('metadata-only result and live-state changes invalidate the joined owner without replacing retained parts', () => {
  const index = new TranscriptIndex(); const owner = entry('call', [call('x')]); const parts: PartView[] = [{type: 'text', text: 'same output'}];
  const answer = (output: {fullOutputPath: string}) => entry('result', [{type: 'toolResult', callId: 'x', name: 'bash', parts, isError: false, output}]);
  const first = {fullOutputPath: '/retained/one'}; index.update([owner, answer(first)], new Map()); const previous = index.joined.get('x');
  const second = {fullOutputPath: '/retained/two'}; index.update([owner, answer(second)], new Map());
  assert.notEqual(index.joined.get('x'), previous); assert.equal(index.joined.get('x')?.result, parts); assert.equal(index.joined.get('x')?.output, second);
  const live = {fullOutputPath: '/retained/live'}; index.update([owner, answer(second)], new Map([['x', {callId: 'x', name: 'bash', phase: 'end', parts, output: live}]]));
  assert.equal(index.joined.get('x')?.output, live); assert.equal(index.changed.has('call'), true);
});
function event(id: string, value: unknown = {}): EntryView { return {id, kind: 'custom', data: {value, truncated: false}}; }
test('the default predicate retains every entry and original adjacency with a representative member mapping', () => {
  const index = new TranscriptIndex(); const a = event('a'); const b = event('b'); const hidden = entry('empty', []); const c = event('c');
  index.update([a, b, hidden, c], new Map());
  assert.deepEqual([...index.sessions.keys()], ['a', 'c']); assert.deepEqual(index.sessions.get('a')?.entries, [a, b]);
  assert.equal(index.sessionOwners.get('b'), 'a'); assert.equal(index.disclosures.get('events:a'), 'a'); assert.equal(index.entries.size, 4);
  const first = index.sessions.get('a'); index.update([a, b, hidden, c], new Map());
  assert.equal(index.sessions.get('a'), first); assert.equal(index.changed.size, 0);
  index.update([b, a], new Map()); assert.equal(index.sessionOwners.get('a'), 'b'); assert.equal(index.disclosures.has('events:a'), false);
  index.update([], new Map()); assert.equal(index.sessions.size, 0); assert.equal(index.sessionOwners.size, 0); assert.equal(index.disclosures.size, 0);
});
test('custom messages keep their message parts while generic actionable data flags stay visible', () => {
  const index = new TranscriptIndex(); const warning = event('warning', {severity: 'warning', message: 'Check the input'});
  const actionable = event('action', {requiresAction: true}); const passive = event('passive', {status: 'success'});
  const customMessage = {...entry('custom-message', [{type: 'text', text: 'retained content'}]), kind: 'custom'};
  index.update([warning, actionable, passive, customMessage, event('tail')], new Map());
  assert.deepEqual(index.sessions.get('warning')?.notices, [warning, actionable]);
  assert.equal(index.sessionOwners.has('custom-message'), false); assert.equal(index.entries.get('custom-message'), customMessage);
  assert.equal(index.sessions.has('tail'), true);
});
test('visible event runs cross hidden empty messages and joined result wrappers without losing entry or tool identities', () => {
  const index = new TranscriptIndex(); const owner = entry('owner', [call('x'), {type: 'thinking', text: 'thought'}]);
  const a = event('a'); const hidden = entry('empty', []); const answer = entry('answer', [result('x', 'output')]); const b = event('b');
  const entries = [owner, a, hidden, answer, b];
  const isVisible = (item: EntryView): boolean => item !== hidden && (item !== answer || index.joined.get('x')?.slot === slot('answer', 'answer', 0));
  index.update(entries, new Map(), isVisible);
  assert.deepEqual([...index.sessions.keys()], ['a']); assert.deepEqual(index.sessions.get('a')?.entries, [a, b]);
  assert.deepEqual([...index.sessionOwners], [['a', 'a'], ['b', 'a']]); assert.equal(index.disclosures.get('events:a'), 'a');
  assert.deepEqual([...index.entries.values()], entries);
  for (const item of entries) assert.equal(index.entries.get(item.id), item);
  const tool = index.joined.get('x'); const group = index.sessions.get('a');
  assert.equal(tool?.slot, slot('owner', 'owner', 0)); assert.equal(tool?.result, answer.messages?.[0]?.parts[0]?.type === 'toolResult' ? answer.messages[0].parts[0].parts : undefined);
  assert.equal(index.disclosures.get('thinking:owner:owner:1'), 'owner'); assert.equal(index.disclosures.get('tool:x'), 'owner');
  index.update(entries, new Map(), isVisible);
  assert.equal(index.sessions.get('a'), group); assert.equal(index.joined.get('x'), tool); assert.equal(index.changed.size, 0);
  index.update([a, hidden, answer, b], new Map(), isVisible);
  assert.equal(index.joined.get('x')?.slot, slot('answer', 'answer', 0)); assert.equal(index.disclosures.get('tool:x'), 'answer');
  assert.deepEqual([...index.sessions.keys()], ['a', 'b']);
});
test('visible normal messages, custom messages, and images each break an event run', () => {
  const barriers: EntryView[] = [
    entry('normal', [{type: 'text', text: 'content'}]),
    {...entry('custom', [{type: 'text', text: 'custom content'}]), kind: 'custom'},
    entry('image', [{type: 'image', mimeType: 'image/png', digest: 'image', bytes: 1, width: 1, height: 1, alt: 'Image'}]),
  ];
  for (const barrier of barriers) {
    const index = new TranscriptIndex(); const a = event('a'); const b = event('b');
    index.update([a, barrier, b], new Map(), () => true);
    assert.deepEqual([...index.sessions.keys()], ['a', 'b']); assert.equal(index.sessionOwners.has(barrier.id), false);
    assert.equal(index.entries.get(barrier.id), barrier);
    index.update([a, barrier, b], new Map(), item => item !== barrier);
    assert.deepEqual([...index.sessions.keys()], ['a']); assert.deepEqual(index.sessions.get('a')?.entries, [a, b]);
  }
});
test('visibility merges and splits stable groups and invalidates old representatives without replacing source entries', () => {
  const index = new TranscriptIndex(); const a = event('a'); const barrier = entry('barrier', []); const b = event('b'); const c = event('c');
  const entries = [a, barrier, b, c]; const hidden = new Set(['barrier']); const isVisible = (item: EntryView) => !hidden.has(item.id);
  index.update(entries, new Map(), isVisible); const merged = index.sessions.get('a');
  index.update(entries, new Map(), isVisible); assert.equal(index.sessions.get('a'), merged); assert.equal(index.changed.size, 0);
  hidden.clear(); index.update(entries, new Map(), isVisible);
  assert.deepEqual([...index.sessions.keys()], ['a', 'b']); assert.deepEqual([...index.changed], ['barrier', 'a', 'b']);
  assert.equal(index.disclosures.get('events:b'), 'b'); assert.equal(index.sessionOwners.get('c'), 'b');
  const split = index.sessions.get('b'); index.update(entries, new Map(), isVisible); assert.equal(index.sessions.get('b'), split);
  hidden.add('barrier'); index.update(entries, new Map(), isVisible);
  assert.deepEqual([...index.sessions.keys()], ['a']); assert.equal(index.disclosures.has('events:b'), false); assert.equal(index.changed.has('b'), true);
  hidden.add('a'); index.update(entries, new Map(), isVisible);
  assert.deepEqual([...index.sessions.keys()], ['b']); assert.equal(index.sessionOwners.has('a'), false); assert.equal(index.sessionOwners.get('c'), 'b');
  assert.equal(index.disclosures.has('events:a'), false); assert.equal(index.changed.has('a'), true); assert.equal(index.changed.has('b'), true);
  assert.deepEqual([...index.entries.values()], entries);
  index.update([], new Map(), isVisible); assert.equal(index.sessions.size, 0); assert.equal(index.sessionOwners.size, 0); assert.equal(index.disclosures.size, 0);
  index.update(entries, new Map(), isVisible); assert.deepEqual([...index.sessions.keys()], ['b']);
});
test('hidden events exclude notices and leave an invisible-only transcript fully indexed', () => {
  const index = new TranscriptIndex(); const warning = event('warning', {severity: 'warning'}); const action = event('action', {requiresAction: true});
  const passive = event('passive'); const message = entry('hidden-message', [call('hidden-tool'), {type: 'thinking', text: 'retained'}]);
  const hidden = new Set(['warning', 'hidden-message']); const entries = [warning, passive, action, message];
  const isVisible = (item: EntryView) => !hidden.has(item.id);
  index.update(entries, new Map(), isVisible);
  assert.deepEqual(index.sessions.get('passive')?.entries, [passive, action]); assert.deepEqual(index.sessions.get('passive')?.notices, [action]);
  assert.equal(index.sessionOwners.has('warning'), false);
  hidden.add('passive'); hidden.add('action'); index.update(entries, new Map(), isVisible);
  assert.equal(index.sessions.size, 0); assert.equal(index.sessionOwners.size, 0); assert.equal(index.disclosures.has('events:passive'), false);
  assert.equal(index.joined.get('hidden-tool')?.slot, slot('hidden-message', 'hidden-message', 0));
  assert.equal(index.disclosures.get('tool:hidden-tool'), 'hidden-message'); assert.equal(index.disclosures.get('thinking:hidden-message:hidden-message:1'), 'hidden-message');
  assert.equal(index.changed.has('passive'), true); assert.deepEqual([...index.entries.values()], entries);
  index.update(entries, new Map(), isVisible); assert.equal(index.changed.size, 0);
  hidden.clear(); index.update(entries, new Map(), isVisible); assert.deepEqual(index.sessions.get('warning')?.notices, [warning, action]);
  const cleared = event('warning', {severity: 'info'}); index.update([cleared, passive, action, message], new Map(), isVisible);
  assert.deepEqual(index.sessions.get('warning')?.notices, [action]); assert.equal(index.changed.has('warning'), true);
});
test('the visibility callback sees rebuilt joined tools and live state for all entries before group formation', () => {
  const index = new TranscriptIndex(); const a = entry('a', [call('x')]); const b = entry('b', [call('x'), result('x', 'output')]);
  index.update([a, b], new Map()); assert.equal(index.joined.get('x')?.owner, 'a');
  const parts: PartView[] = [{type: 'text', text: 'live result'}]; const entries = [event('first'), b, event('last'), a]; const seen: EntryView[] = [];
  index.update(entries, new Map([['x', {callId: 'x', name: 'read', phase: 'end', parts, isError: true}]]), item => {
    seen.push(item); assert.equal(index.joined.get('x')?.owner, 'b'); assert.equal(index.joined.get('x')?.result, parts);
    assert.equal(index.joined.get('x')?.status, 'error'); assert.equal(index.disclosures.get('tool:x'), 'b');
    assert.equal(index.joined.get('x')?.slot, slot('b', 'b', 0)); assert.equal(index.entries.size, entries.length);
    return item !== a && item !== b;
  });
  assert.deepEqual(seen, entries); assert.deepEqual([...index.sessions.keys()], ['first']);
  index.update([event('only')], new Map(), () => { assert.equal(index.joined.size, 0); assert.equal(index.disclosures.has('tool:x'), false); return true; });
});
test('actionable detection ignores inherited properties and accessors without invoking supplied objects', () => {
  assert.equal(actionableEntry(event('inherited', Object.create({severity: 'error', requiresAction: true}))), false);
  const value = {}; Object.defineProperty(value, 'error', {get: () => { throw new Error('Accessor must not run'); }});
  assert.equal(actionableEntry(event('accessor', value)), false);
  assert.equal(actionableEntry(event('object', {status: {toString: 'not callable'}})), false);
  assert.equal(actionableEntry(event('actions', {actions: [{label: 'Retry'}]})), true);
  assert.equal(actionableEntry(event('error', {error: 'Retained error'})), true);
});
