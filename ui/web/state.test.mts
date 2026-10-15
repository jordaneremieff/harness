import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationView, CachedRoster, NoticeView, AgentRow, EntryView, EventData, EventName, MessageView, PrimaryView, ProjectedFrame, Snapshot, TargetState, ToolOutputInfo } from '../shared/api.ts';
import { dismissNotice, markReadNotices, unreadNotices, mergeRosterPage, agentBlocks, conversationBlocks, createState, mergeAgentPage, mergePrimaryPage, parseCursor, primaryBlocks, reduceEvent, replaceSnapshot, visibleTargets, targetIdentity } from './state.ts';
import type { UiEvent, UiState } from './state.ts';
import { TranscriptIndex } from './transcript-tools.ts';
const target = {kind: 'primary' as const, key: 'p', epoch: 1};
const coverage = {complete: true, truncated: false, omitted: 0};
const primary = (epoch = 1): PrimaryView => ({key: 'p', epoch, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingOperationIds: [], pendingDialogs: [], capabilities: {input: true}});
const message = (id: string, text = 'text', state: MessageView['state'] = 'final'): MessageView => ({id, role: 'assistant', parts: [{type: 'text', text}], state, coverage});
const entry = (id: string, messageId = id): EntryView => ({id, kind: 'message', messages: [message(messageId)]});
const row = (identity: string): AgentRow => ({identity, storageId: identity, cwd: '/project', modifiedAt: 0, state: 'idle', owner: 'here', availability: 'live', partial: false});
const snapshot = (bootId = 'boot', sequence = 0): Snapshot => ({bootId, cursor: `${bootId}:${sequence}`, workspace: {id: 'workspace', revision: 0, primaryKey: 'p'}, primaries: [primary()], roster: {rows: [row('a'), row('b')], scan: {state: 'ready', complete: true, visited: 2, skipped: 0, omitted: 0}, stale: false}, dialogs: [], pendingOperations: []});
function event<N extends EventName>(sequence: number, name: N, data: EventData[N], extra: Partial<UiEvent> = {}): UiEvent {
  return {id: `boot:${sequence}`, name, data, ...extra} as UiEvent;
}
const baseline = (): UiState => replaceSnapshot(createState(), snapshot());
function selectAgent(state: UiState, identity: string): UiState {
  const snap = snapshot('boot', state.sequence);
  assert.ok(state.workspace);
  snap.workspace = {...state.workspace, revision: state.workspace.revision + 1, selectedTarget: {kind: 'agent', identity},
    conversationLayout: {root: {kind: 'pane', id: 'pane-1', tabs: [{kind: 'agent', identity}], active: `agent:${identity}`}, focusedPane: 'pane-1'}};
  return replaceSnapshot(state, snap);
}
const frame = (revision: number, entries: EntryView[] = [], live: EntryView[] = []): ProjectedFrame => ({revision, entries, live, observedAt: '2026-10-08T12:00:00.000Z', nextBefore: null, status: {busy: !!live.length}, coverage});

test('two visible agent leaves receive independent frames and reject stale availability epochs', () => {
  const snap = snapshot();
  snap.workspace.conversationLayout = {root: {kind: 'split', id: 'split', axis: 'x', ratio: 50,
    first: {kind: 'pane', id: 'left', tabs: [{kind: 'agent', identity: 'a'}], active: 'agent:a'},
    second: {kind: 'pane', id: 'right', tabs: [{kind: 'agent', identity: 'b'}], active: 'agent:b'}}, focusedPane: 'left'};
  snap.workspace.selectedTarget = {kind: 'agent', identity: 'a'};
  snap.observations = [{identity: 'a', connectionEpoch: 2, frame: frame(1, [], [entry('a-live')])}, {identity: 'b', connectionEpoch: 4, frame: frame(1, [], [entry('b-live')])}];
  let state = replaceSnapshot(createState(), snap);
  const capabilities = {history: true, observe: true, input: true, abort: false, configure: false};
  state = reduceEvent(state, event(1, 'agent.availability', {identity: 'b', connectionEpoch: 3, state: 'unavailable', capabilities}));
  assert.equal(state.agentAvailability.has('b'), false);
  state = reduceEvent(state, event(2, 'agent.frame', {identity: 'b', connectionEpoch: 3, frame: frame(100, [], [entry('b-stale')])}));
  assert.equal(agentBlocks(state, 'b')[0]?.id, 'b-live');
  state = reduceEvent(state, event(3, 'workspace.changed', {...snap.workspace, revision: 1, selectedTarget: {kind: 'agent', identity: 'b'}, panelVisible: false,
    conversationLayout: {...snap.workspace.conversationLayout, focusedPane: 'right'}}));
  state = reduceEvent(state, event(4, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(2, [], [entry('a-next')])}));
  state = reduceEvent(state, event(5, 'agent.availability', {identity: 'b', connectionEpoch: 5, state: 'live', capabilities}));
  assert.equal(agentBlocks(state, 'a')[0]?.id, 'a-next'); assert.equal(agentBlocks(state, 'b').length, 0);
  state = reduceEvent(state, event(6, 'agent.frame', {identity: 'b', connectionEpoch: 4, frame: frame(101, [], [entry('b-late')])}));
  assert.equal(agentBlocks(state, 'b').length, 0); assert.equal(state.agentAvailability.get('b')?.connectionEpoch, 5);
  state = reduceEvent(state, event(7, 'agent.frame', {identity: 'b', connectionEpoch: 5, frame: frame(0, [], [entry('b-new')])}));
  assert.equal(agentBlocks(state, 'b')[0]?.id, 'b-new'); assert.equal(agentBlocks(state, 'a')[0]?.id, 'a-next');
});
test('omitted unobserved targets do not admit epoch-zero events and workspace changes reset epoch ownership', () => {
  const snap = snapshot(); snap.workspace.selectedTarget = {kind: 'agent', identity: 'a'};
  snap.observations = [{identity: 'a', connectionEpoch: 0, omitted: true}];
  let state = replaceSnapshot(createState(), snap);
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 0, frame: frame(1, [], [entry('zero')])}));
  assert.deepEqual(agentBlocks(state, 'a'), []);
  state = reduceEvent(state, event(2, 'agent.frame', {identity: 'a', connectionEpoch: 9, frame: frame(1, [], [entry('first-workspace')])}));
  const next = {...snap, cursor: 'boot:3', workspace: {...snap.workspace, id: 'second-workspace'}, observations: [{identity: 'a', connectionEpoch: 1, frame: frame(1, [], [entry('second-workspace')])}]};
  state = replaceSnapshot(state, next); assert.equal(state.agentEpochs.get('a'), 1); assert.equal(agentBlocks(state, 'a')[0]?.id, 'second-workspace');
});
test('committed membership and ordering stay cached through unrelated deltas', () => {
  const retained = entry('cached-entry', 'cached-message'); const saved = retained.messages?.[0]; assert.ok(saved);
  const parts = saved.parts; let reads = 0; Object.defineProperty(saved, 'parts', {enumerable: true, get: () => { reads++; return parts; }});
  let state = mergePrimaryPage(baseline(), target, [retained]);
  const before = primaryBlocks(state, 'p'); assert.equal(primaryBlocks(state, 'p'), before); const baselineReads = reads;
  for (let sequence = 1; sequence <= 20; sequence++) {
    state = reduceEvent(state, event(sequence, 'primary.delta', {messageId: 'burst', index: 0, kind: 'text', delta: 'x'}, {target}));
    assert.equal(primaryBlocks(state, 'p')[0], retained);
  }
  assert.equal(reads, baselineReads);
  state = reduceEvent(state, event(21, 'primary.entry', {entry: {id: 'committed-burst', kind: 'message', messages: [message('burst', 'x'.repeat(20))]}}, {target}));
  assert.equal(primaryBlocks(state, 'p').filter(item => item.messages?.some(value => value.id === 'burst')).length, 1);
  state = mergePrimaryPage(state, target, [entry('earlier-first')]);
  assert.deepEqual(primaryBlocks(state, 'p').map(item => item.id), ['earlier-first', 'cached-entry', 'committed-burst']);
});

test('tool start receipt captures client time once and update/end retain it', t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const tool = (sequence: number, phase: 'start' | 'update' | 'end') => event(sequence, 'primary.tool', {callId: 'c', name: 'read', phase, ...(phase === 'end' ? {durationMs: 37} : {})}, {target});
  let state = reduceEvent(baseline(), tool(1, 'start'));
  const start = state.conversations.get(targetIdentity(target))?.tools.get('c')?.observedStart;
  assert.equal(start, 1000); now = 4000;
  state = reduceEvent(state, tool(2, 'start')); state = reduceEvent(state, tool(3, 'update')); state = reduceEvent(state, tool(4, 'end'));
  assert.equal(state.conversations.get(targetIdentity(target))?.tools.get('c')?.observedStart, start);
  assert.equal(state.conversations.get(targetIdentity(target))?.tools.get('c')?.durationMs, 37);
  now = 5000; state = reduceEvent(state, tool(5, 'start'));
  assert.equal(state.conversations.get(targetIdentity(target))?.tools.get('c')?.observedStart, 5000);
});
test('history, snapshot baselines, argument deltas and updates do not infer a tool start', () => {
  const call: EntryView = {id: 'call', kind: 'message', messages: [{id: 'm', role: 'assistant', state: 'final', coverage,
    parts: [{type: 'toolCall', callId: 'c', name: 'read', arguments: {value: {}, truncated: false}}]}]};
  let state = mergePrimaryPage(baseline(), target, [call]);
  assert.equal(state.conversations.get(targetIdentity(target))?.tools.get('c')?.observedStart, undefined);
  state = reduceEvent(state, event(1, 'primary.delta', {messageId: 'args', index: 0, kind: 'toolArguments', callId: 'c', toolName: 'read', delta: '{}'}, {target}));
  state = reduceEvent(state, event(2, 'primary.tool', {callId: 'c', name: 'read', phase: 'update'}, {target}));
  assert.equal(state.conversations.get(targetIdentity(target))?.tools.get('c')?.observedStart, undefined);
  state = reduceEvent(state, event(3, 'primary.tool', {callId: 'c', name: 'read', phase: 'start'}, {target}));
  const resynced = replaceSnapshot(state, {...snapshot('boot', 3), selectedPage: {target, items: [call], nextBefore: null, coverage}});
  assert.equal(resynced.conversations.get(targetIdentity(target))?.tools.get('c')?.observedStart, undefined);
  const updated = reduceEvent(resynced, event(4, 'primary.tool', {callId: 'c', name: 'read', phase: 'update'}, {target}));
  assert.equal(updated.conversations.get(targetIdentity(target))?.tools.get('c')?.observedStart, undefined);
});
test('target keys include exact primary epochs and agent identities', () => {
  assert.notEqual(targetIdentity(target), targetIdentity({...target, epoch: 2}));
  assert.notEqual(targetIdentity({kind: 'agent', identity: 'p'}), targetIdentity(target));
  assert.deepEqual(parseCursor('boot:12'), {bootId: 'boot', sequence: 12});
  for (const cursor of ['boot:-1', 'boot:01', 'boot:1x', 'boot:9007199254740992', '']) assert.equal(parseCursor(cursor), null);
});
test('filtered sequence gaps are valid and duplicates never repeat deltas', () => {
  let state = baseline();
  const delta = event(4, 'primary.delta', {messageId: 'm', index: 0, kind: 'text', delta: 'first'}, {target});
  state = reduceEvent(state, delta);
  assert.equal(state.needsResync, false); assert.equal(state.sequence, 4);
  assert.equal(reduceEvent(state, delta), state);
  state = reduceEvent(state, event(20, 'primary.delta', {messageId: 'm', index: 0, kind: 'text', delta: ' next'}, {target}));
  assert.equal(primaryBlocks(state, 'p')[0]?.messages?.[0]?.parts[0]?.type === 'text' && primaryBlocks(state, 'p')[0]?.messages?.[0]?.parts[0]?.text, 'first next');
});
test('ready and resync advisory cursors never advance the processed cursor', () => {
  let state = baseline();
  state = reduceEvent(state, {name: 'ready', data: {bootId: 'boot', cursor: 'boot:100'}});
  assert.equal(state.cursor, 'boot:0');
  state = reduceEvent(state, {name: 'resync', data: {reason: 'expired', snapshotUrl: '/api/snapshot', cursor: 'boot:200'}});
  assert.equal(state.needsResync, true); assert.equal(state.cursor, 'boot:0');
  assert.equal(reduceEvent(state, event(10, 'notice', {level: 'info', message: 'ignored'})), state);
});
test('boot change requires a fresh baseline before journal data is accepted', () => {
  const state = reduceEvent(baseline(), {name: 'notice', id: 'new:3', data: {level: 'info', message: 'not applied'}});
  assert.equal(state.needsResync, true); assert.equal(state.bootId, 'boot'); assert.equal(state.notices.length, 0);
  const fresh = replaceSnapshot(state, snapshot('new', 3));
  assert.equal(fresh.bootId, 'new'); assert.equal(fresh.needsResync, false);
  assert.equal(reduceEvent(fresh, {name: 'ready', data: {bootId: 'old', cursor: 'old:3'}}).needsResync, true);
});
test('snapshot cut skips duplicate buffered data and applies only later events', () => {
  const state = replaceSnapshot(baseline(), snapshot('boot', 5), [event(4, 'notice', {level: 'info', message: 'old'}), event(8, 'notice', {level: 'info', message: 'new'})]);
  assert.deepEqual(state.notices.map(notice => notice.message), ['new']);
  assert.equal(state.sequence, 8);
  assert.equal(replaceSnapshot(state, snapshot('boot', 5)), state);
});
test('final primary messages replace partials without an extra block', () => {
  let state = reduceEvent(baseline(), event(1, 'primary.delta', {messageId: 'm', index: 0, kind: 'text', delta: 'partial'}, {target}));
  state = reduceEvent(state, event(2, 'primary.message', {message: message('m', 'final')}, {target}));
  state = reduceEvent(state, event(3, 'primary.delta', {messageId: 'm', index: 0, kind: 'text', delta: 'late'}, {target}));
  assert.equal(primaryBlocks(state, 'p').length, 1);
  assert.equal(primaryBlocks(state, 'p')[0]?.messages?.[0]?.parts[0]?.type === 'text' && primaryBlocks(state, 'p')[0]?.messages?.[0]?.parts[0]?.text, 'final');
});
test('unrelated deltas retain stable completed block and message references', () => {
  let state = reduceEvent(baseline(), event(1, 'primary.message', {message: message('done')}, {target}));
  const first = primaryBlocks(state, 'p')[0];
  state = reduceEvent(state, event(2, 'primary.delta', {messageId: 'active', index: 0, kind: 'text', delta: 'grows'}, {target}));
  assert.equal(primaryBlocks(state, 'p')[0], first);
  assert.equal(primaryBlocks(state, 'p')[0]?.messages?.[0], first?.messages?.[0]);
});
test('tool events update one keyed card without consuming a native delta index', () => {
  const call: MessageView = {id: 'm', role: 'assistant', state: 'partial', coverage, parts: [{type: 'toolCall', callId: 'call', name: 'read', arguments: {value: {}, truncated: false}}]};
  let state = reduceEvent(baseline(), event(1, 'primary.message', {message: call}, {target}));
  state = reduceEvent(state, event(2, 'primary.tool', {callId: 'call', name: 'read', phase: 'update', parts: [{type: 'text', text: 'partial output'}]}, {target}));
  state = reduceEvent(state, event(3, 'primary.delta', {messageId: 'm', index: 1, kind: 'text', delta: 'after tool'}, {target}));
  const conversation = state.conversations.get(targetIdentity(target)); assert.ok(conversation);
  assert.equal(conversation.tools.size, 1); assert.equal(conversation.tools.get('call')?.phase, 'update');
  assert.deepEqual(conversation.messages.get('m')?.parts[1], {type: 'text', text: 'after tool'});
  assert.equal(conversationBlocks(conversation)[0]?.messages?.[0]?.parts.filter(part => part.type === 'toolResult').length, 1);
  state = reduceEvent(state, event(4, 'primary.tool', {callId: 'call', name: 'read', phase: 'end', parts: [{type: 'text', text: 'done'}], isError: false, durationMs: 10}, {target}));
  assert.equal(state.conversations.get(targetIdentity(target))?.tools.get('call')?.phase, 'end');
});
test('tool events retain supplied output metadata in state and derived results', () => {
  const output: ToolOutputInfo = {truncation: {truncated: true, truncatedBy: 'bytes', totalLines: 10, outputLines: 2,
    totalBytes: 4096, outputBytes: 1024, maxLines: 2000, maxBytes: 1024, lastLinePartial: true}, fullOutputPath: '/output/bash-output.txt'};
  const call: MessageView = {id: 'm', role: 'assistant', state: 'partial', coverage,
    parts: [{type: 'toolCall', callId: 'c', name: 'bash', arguments: {value: {}, truncated: false}}]};
  const initial = reduceEvent(baseline(), event(1, 'primary.message', {message: call}, {target}));
  const state = reduceEvent(initial, event(2, 'primary.tool', {callId: 'c', name: 'bash', phase: 'end',
    parts: [{type: 'text', text: 'tail'}], output}, {target}));
  assert.deepEqual(state.conversations.get(targetIdentity(target))?.tools.get('c')?.output, output);
  const result = primaryBlocks(state, 'p')[0]?.messages?.[0]?.parts.find(part => part.type === 'toolResult');
  assert.deepEqual(result?.output, output);
  assert.equal(call.parts.length, 1);
  assert.equal(initial.conversations.get(targetIdentity(target))?.tools.get('c')?.output, undefined);
});
test('authoritative tool results copy supplied metadata and preserve unknown fields', () => {
  const output: ToolOutputInfo = {truncation: {truncated: true, totalLines: 1, outputLines: 0, firstLineExceedsLimit: true}};
  const raw: MessageView = {id: 'result', role: 'toolResult', state: 'final', coverage,
    parts: [{type: 'toolResult', callId: 'c', name: 'read', parts: [], isError: false, output}]};
  let state = reduceEvent(baseline(), event(1, 'primary.message', {message: raw}, {target}));
  assert.deepEqual(state.conversations.get(targetIdentity(target))?.tools.get('c')?.output, output);
  const call: MessageView = {id: 'call', role: 'assistant', state: 'final', coverage,
    parts: [{type: 'toolCall', callId: 'c', name: 'read', arguments: {value: {}, truncated: false}}]};
  state = reduceEvent(state, event(2, 'primary.message', {message: call}, {target}));
  const result = state.conversations.get(targetIdentity(target))?.messageBlocks.get('call')?.messages?.[0]?.parts.find(part => part.type === 'toolResult');
  assert.deepEqual(result?.output, output);
  assert.equal(result?.output?.truncation?.outputLines, 0);
  assert.equal(result?.output?.truncation?.totalBytes, undefined);
  assert.equal(result?.output?.fullOutputPath, undefined);
  const replacement: MessageView = {...raw, parts: [{type: 'toolResult', callId: 'c', name: 'read', parts: [], isError: false}]};
  state = reduceEvent(state, event(3, 'primary.message', {message: replacement}, {target}));
  assert.equal(state.conversations.get(targetIdentity(target))?.tools.get('c')?.output, undefined);
});
test('tool arguments remain raw until authoritative message replacement', () => {
  let state = reduceEvent(baseline(), event(1, 'primary.delta', {messageId: 'm', index: 0, kind: 'toolArguments', callId: 'c', toolName: 'read', delta: '{"path":'}, {target}));
  state = reduceEvent(state, event(2, 'primary.delta', {messageId: 'm', index: 0, kind: 'toolArguments', callId: 'c', delta: '"file"}'}, {target}));
  assert.equal(state.conversations.get(targetIdentity(target))?.tools.get('c')?.argumentText, '{"path":"file"}');
  const final: MessageView = {id: 'm', role: 'assistant', state: 'final', coverage, parts: [{type: 'toolCall', callId: 'c', name: 'read', arguments: {value: {path: 'file'}, truncated: false}}]};
  state = reduceEvent(state, event(3, 'primary.message', {message: final}, {target}));
  assert.deepEqual(state.conversations.get(targetIdentity(target))?.tools.get('c')?.arguments?.value, {path: 'file'});
});
test('standalone tool events reconcile with a later assistant call', () => {
  let state = reduceEvent(baseline(), event(1, 'primary.tool', {callId: 'c', name: 'read', phase: 'start'}, {target}));
  assert.equal(primaryBlocks(state, 'p').length, 1);
  state = reduceEvent(state, event(2, 'primary.message', {message: {id: 'm', role: 'assistant', state: 'partial', coverage, parts: [{type: 'toolCall', callId: 'c', name: 'read', arguments: {value: {}, truncated: false}}]}}, {target}));
  assert.equal(primaryBlocks(state, 'p').length, 1);
});
test('primary epoch replacement rejects stale events and stale history pages', () => {
  let state = reduceEvent(baseline(), event(1, 'primary.state', primary(2)));
  state = reduceEvent(state, event(2, 'primary.delta', {messageId: 'old', index: 0, kind: 'text', delta: 'stale'}, {target}));
  assert.equal(primaryBlocks(state, 'p').length, 0);
  assert.equal(mergePrimaryPage(state, target, [entry('old')]), state);
  state = reduceEvent(state, event(3, 'primary.state', primary(1)));
  assert.equal(state.primaries.get('p')?.epoch, 2);
});
test('retained entry and standalone message reconcile by message ID', () => {
  let state = reduceEvent(baseline(), event(1, 'primary.message', {message: message('m')}, {target}));
  state = reduceEvent(state, event(2, 'primary.entry', {entry: entry('e', 'm')}, {target}));
  assert.deepEqual(primaryBlocks(state, 'p').map(block => block.id), ['e']);
});
test('agent frames replace live output and reject duplicate revisions and old epochs', () => {
  let state = selectAgent(baseline(), 'a');
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(8, [], [entry('live:8')])}));
  state = reduceEvent(state, event(2, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(9, [entry('committed')], [])}));
  assert.deepEqual(agentBlocks(state, 'a').map(block => block.id), ['committed']);
  state = reduceEvent(state, event(3, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(8, [], [entry('old')])}));
  state = reduceEvent(state, event(4, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(100, [], [entry('old epoch')])}));
  assert.deepEqual(agentBlocks(state, 'a').map(block => block.id), ['committed']);
  state = reduceEvent(state, event(5, 'agent.frame', {identity: 'a', connectionEpoch: 3, frame: frame(1, [], [entry('fresh')])}));
  assert.equal(state.conversations.get(targetIdentity({kind: 'agent', identity: 'a'}))?.frame?.revision, 1);
  assert.deepEqual(agentBlocks(state, 'a').map(block => block.id), ['committed', 'fresh']);
});
test('deselection rejects late frames and re-entry requires a fresh connection epoch', () => {
  let state = selectAgent(baseline(), 'a');
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(8)}));
  state = selectAgent(state, 'b');
  state = reduceEvent(state, event(2, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(9, [], [entry('late')])}));
  state = selectAgent(state, 'a');
  state = reduceEvent(state, event(3, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(10, [], [entry('stale')])}));
  assert.deepEqual(agentBlocks(state, 'a'), []);
  state = reduceEvent(state, event(4, 'agent.frame', {identity: 'a', connectionEpoch: 3, frame: frame(1, [], [entry('new')])}));
  assert.equal(agentBlocks(state, 'a')[0]?.id, 'new');
});
test('agent live and committed projections reconcile by message and tool-call keys', () => {
  const toolEntry = (id: string, messageId: string): EntryView => ({id, kind: 'message', messages: [{id: messageId, role: 'tool', state: 'final', coverage, parts: [{type: 'toolResult', callId: 'c', name: 'read', parts: [], isError: false}]}]});
  let state = selectAgent(baseline(), 'a');
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(1, [entry('e', 'm'), toolEntry('tool', 'committed-tool')], [entry('live:generation', 'm'), toolEntry('live:tool:c', 'live-tool')])}));
  assert.deepEqual(agentBlocks(state, 'a').map(block => block.id), ['e', 'tool']);
});
test('same-session primary snapshots keep earlier pages while replacing transient tool state', () => {
  const current = {...primary(), sessionId: 'session', sessionFile: '/project/session.jsonl'};
  const first = {...snapshot(), primaries: [current], selectedPage: {target, items: [entry('leaf')], nextCursor: 'earlier', coverage}};
  let state = replaceSnapshot(createState(), first); const earlier = entry('earlier');
  state = mergePrimaryPage(state, target, [earlier], {nextCursor: null, earlier: true});
  state = reduceEvent(state, event(1, 'primary.tool', {callId: 'c', name: 'read', phase: 'start'}, {target}));
  const next = replaceSnapshot(state, {...first, cursor: 'boot:2'});
  assert.deepEqual(next.conversations.get(targetIdentity(target))?.entryOrder, ['earlier', 'leaf']);
  assert.equal(next.conversations.get(targetIdentity(target))?.entries.get('earlier'), earlier);
  assert.equal(next.conversations.get(targetIdentity(target))?.tools.size, 0);
  assert.equal(next.conversations.get(targetIdentity(target))?.historyCursor, null);
});

test('same-session navigation snapshots retain represented tool durations and active progress without replay', t => {
  t.mock.method(Date, 'now', () => 123);
  const current = {...primary(), activity: 'running' as const, sessionId: 'session'};
  const calls: EntryView = {id: 'calls', kind: 'message', messages: [{id: 'call-message', role: 'assistant', state: 'final', coverage,
    parts: ['read', 'edit', 'error', 'active'].map(callId => ({type: 'toolCall' as const, callId, name: 'custom', arguments: {value: {}, truncated: false}}))}]};
  const first: Snapshot = {...snapshot(), primaries: [current], selectedPage: {target, items: [calls], nextCursor: null, coverage}};
  let state = replaceSnapshot(createState(), first);
  for (const [index, durationMs] of [83, 21, 47].entries()) state = reduceEvent(state, event(index + 1, 'primary.tool', {callId: ['read', 'edit', 'error'][index], name: 'custom', phase: 'end', durationMs, isError: index === 2}, {target}));
  state = reduceEvent(state, event(4, 'primary.tool', {callId: 'active', name: 'custom', phase: 'start'}, {target}));
  state = reduceEvent(state, event(5, 'primary.tool', {callId: 'active', name: 'custom', phase: 'update', parts: [{type: 'text', text: 'Partial progress'}]}, {target}));
  const tools = state.conversations.get(targetIdentity(target))?.tools; assert.ok(tools);
  const away = replaceSnapshot(state, {...first, cursor: 'boot:6', selectedPage: undefined});
  const returned = replaceSnapshot(away, {...first, cursor: 'boot:7'});
  const retained = returned.conversations.get(targetIdentity(target))?.tools; assert.ok(retained);
  assert.deepEqual([...retained.values()].map(tool => tool.durationMs), [83, 21, 47, undefined]);
  assert.equal(retained.get('active'), tools.get('active')); assert.equal(retained.get('active')?.observedStart, 123);
  assert.deepEqual(retained.get('active')?.parts, [{type: 'text', text: 'Partial progress'}]);
  for (const changed of [{...current, sessionId: 'other'}, {...current, sessionId: undefined}, {...current, sessionFile: '/project/other.jsonl'}]) {
    const reset = replaceSnapshot(state, {...first, cursor: 'boot:7', primaries: [changed]});
    assert.equal(reset.conversations.get(targetIdentity(target))?.tools.size, 0);
  }
  const idle = replaceSnapshot(state, {...first, cursor: 'boot:7', primaries: [{...current, activity: 'idle'}]});
  assert.equal(idle.conversations.get(targetIdentity(target))?.tools.has('active'), false);
  assert.equal(idle.conversations.get(targetIdentity(target))?.tools.get('read')?.durationMs, 83);
  const omitted = replaceSnapshot(state, {...first, cursor: 'boot:7', selectedPage: {target, items: [], nextCursor: null, coverage}});
  assert.equal(omitted.conversations.get(targetIdentity(target))?.tools.size, 0);
  const branch = replaceSnapshot(state, {...first, cursor: 'boot:7', selectedPage: {target, items: [calls, {id: 'branch', kind: 'branch_summary'}], nextCursor: null, coverage}});
  assert.equal(branch.conversations.get(targetIdentity(target))?.tools.size, 0);
});
test('terminal snapshot results replace observed partial tools without replay while the turn stays active', t => {
  t.mock.method(Date, 'now', () => 123);
  for (const activity of ['running', 'retrying'] as const) for (const isError of [false, true]) {
    const current = {...primary(), activity, sessionId: 'session'};
    const calls: EntryView = {id: 'calls', kind: 'message', messages: [{id: 'calls-message', role: 'assistant', state: 'final', coverage,
      parts: ['A', 'B'].map(callId => ({type: 'toolCall' as const, callId, name: 'custom', arguments: {value: {}, truncated: false}}))}]};
    const first: Snapshot = {...snapshot(), primaries: [current], selectedPage: {target, items: [calls], nextCursor: null, coverage}};
    let state = replaceSnapshot(createState(), first);
    state = reduceEvent(state, event(1, 'primary.tool', {callId: 'A', name: 'custom', phase: 'start'}, {target}));
    state = reduceEvent(state, event(2, 'primary.tool', {callId: 'A', name: 'custom', phase: 'update', parts: [{type: 'text', text: 'Old partial'}]}, {target}));
    state = reduceEvent(state, event(3, 'primary.tool', {callId: 'B', name: 'custom', phase: 'start'}, {target}));
    const before = new TranscriptIndex(); before.update(primaryBlocks(state, 'p'), state.conversations.get(targetIdentity(target))?.tools ?? new Map());
    assert.equal(before.joined.get('A')?.status, 'working'); assert.deepEqual(before.joined.get('A')?.result, [{type: 'text', text: 'Old partial'}]);
    const parts = [{type: 'text' as const, text: isError ? 'Fresh terminal error' : 'Fresh terminal result'}];
    const result: EntryView = {id: 'result', kind: 'message', messages: [{id: 'result-message', role: 'toolResult', state: 'final', coverage,
      parts: [{type: 'toolResult', callId: 'A', name: 'custom', parts, isError}]}]};
    const incoming: Snapshot = {...first, cursor: 'boot:4', selectedPage: {target, items: [calls, result], nextCursor: null, coverage}};
    state = replaceSnapshot(state, incoming);
    for (const next of [state, replaceSnapshot(state, {...incoming, cursor: 'boot:5'})]) {
      const tools = next.conversations.get(targetIdentity(target))?.tools; assert.ok(tools);
      const index = new TranscriptIndex(); index.update(primaryBlocks(next, 'p'), tools);
      assert.equal(index.joined.get('A')?.status, isError ? 'error' : 'success');
      assert.equal(index.joined.get('A')?.result, parts); assert.equal(index.joined.get('A')?.observedStart, undefined);
      assert.equal(tools.has('A'), false); assert.equal(index.joined.get('B')?.status, 'working');
      assert.equal(index.joined.get('B')?.observedStart, 123); assert.equal(next.primaries.get('p')?.activity, activity);
    }
  }
});
test('terminal snapshots retain only consistent completed duration metadata and never old payloads', () => {
  const calls: EntryView = {id: 'calls', kind: 'message', messages: [{id: 'calls-message', role: 'assistant', state: 'final', coverage,
    parts: [{type: 'toolCall', callId: 'A', name: 'custom', arguments: {value: {}, truncated: false}}]}]};
  const first: Snapshot = {...snapshot(), primaries: [{...primary(), activity: 'running', sessionId: 'session'}], selectedPage: {target, items: [calls], nextCursor: null, coverage}};
  const parts = [{type: 'text' as const, text: 'Final output'}];
  for (const mode of ['match-success', 'match-error', 'wrong-name', 'wrong-status', 'wrong-parts', 'wrong-output'] as const) {
    const isError = mode === 'match-error';
    const result: EntryView = {id: 'result', kind: 'message', messages: [{id: 'result-message', role: 'toolResult', state: 'final', coverage,
      parts: [{type: 'toolResult', callId: 'A', name: 'custom', parts, isError}]}]};
    let state = replaceSnapshot(createState(), first);
    state = reduceEvent(state, event(1, 'primary.tool', {callId: 'A', name: 'custom', phase: 'start'}, {target}));
    state = reduceEvent(state, event(2, 'primary.tool', {callId: 'A', name: mode === 'wrong-name' ? 'other' : 'custom', phase: 'end',
      durationMs: 83, isError: mode === 'wrong-status' ? true : isError,
      parts: mode === 'wrong-parts' ? [{type: 'text', text: 'Old terminal output'}] : parts,
      ...(mode === 'wrong-output' ? {output: {fullOutputPath: '/project/old-output.txt'}} : {})}, {target}));
    state = replaceSnapshot(state, {...first, cursor: 'boot:3', selectedPage: {target, items: [calls, result], nextCursor: null, coverage}});
    const tools = state.conversations.get(targetIdentity(target))?.tools; assert.ok(tools);
    const index = new TranscriptIndex(); index.update(primaryBlocks(state, 'p'), tools);
    const match = mode.startsWith('match'), joined = index.joined.get('A'); assert.ok(joined);
    assert.equal(joined.duration, match ? 83 : undefined);
    assert.equal(joined.status, isError ? 'error' : 'success'); assert.equal(joined.result, parts);
    assert.equal(joined.observedStart, undefined); assert.equal(joined.output, undefined);
    assert.deepEqual(tools.get('A'), match ? {callId: 'A', name: 'custom', phase: 'end', durationMs: 83, isError} : undefined);
  }
});
test('initial refreshes preserve a partial earlier boundary and only earlier pages advance it', () => {
  const current = {...primary(), sessionId: 'session', sessionFile: '/project/session.jsonl'};
  const first: Snapshot = {...snapshot(), primaries: [current], selectedPage: {target, items: [entry('leaf')], nextCursor: null, coverage}};
  let state = replaceSnapshot(createState(), first);
  assert.equal(state.conversations.get(targetIdentity(target))?.historyCursor, undefined, 'a snapshot window does not establish the disk history boundary');
  state = mergePrimaryPage(state, target, [], {nextCursor: null, earlier: false});
  assert.equal(state.conversations.get(targetIdentity(target))?.historyCursor, undefined, 'an empty startup projection does not establish an exhausted boundary');
  state = mergePrimaryPage(state, target, [entry('leaf')], {nextCursor: 'first', earlier: false});
  assert.equal(state.conversations.get(targetIdentity(target))?.historyCursor, 'first');
  state = mergePrimaryPage(state, target, [entry('middle')], {nextCursor: 'remaining', earlier: true});
  state = replaceSnapshot(state, {...first, cursor: 'boot:2'});
  state = mergePrimaryPage(state, target, [entry('leaf')], {nextCursor: 'first', earlier: false});
  assert.equal(state.conversations.get(targetIdentity(target))?.historyCursor, 'remaining');
  state = mergePrimaryPage(state, target, [entry('start')], {nextCursor: null, earlier: true});
  assert.equal(state.conversations.get(targetIdentity(target))?.historyCursor, null);
});
test('a stopped exact Primary retains observed blocks across backend boots without execution or cursor authority', () => {
  const current={...primary(),sessionId:'retained-session',sessionFile:'/project/retained.jsonl'};
  const first:Snapshot={...snapshot(),primaries:[current],selectedPage:{target,items:[entry('leaf')],nextCursor:'old-cursor',coverage}};
  let state=mergePrimaryPage(replaceSnapshot(createState(),first),target,[entry('earlier')],{nextCursor:'old-cursor',earlier:true});
  state=reduceEvent(state,event(1,'primary.delta',{messageId:'interrupted',index:0,kind:'text',delta:'Last observed partial text'},{target}));
  const before=primaryBlocks(state,'p'),stopped={...current,lifecycle:'stopped' as const,activity:'unknown' as const,pid:undefined};
  const nextSnapshot:Snapshot={...first,bootId:'replacement',cursor:'replacement:0',primaries:[stopped],selectedPage:{target,items:[],nextCursor:null,coverage}};
  const next=replaceSnapshot(state,nextSnapshot),conversation=next.conversations.get(targetIdentity(target));assert.ok(conversation);
  assert.deepEqual(primaryBlocks(next,'p'),before);assert.equal(primaryBlocks(next,'p')[0],before[0]);assert.deepEqual(conversation.retainedSession,{id:current.sessionId,file:current.sessionFile});
  assert.equal(conversation.historyCursor,undefined);assert.equal(conversation.tools.size,0);assert.equal(conversation.queue,undefined);assert.equal(conversation.recovery,undefined);assert.equal(conversation.frame,undefined);assert.deepEqual(conversation.live,[]);assert.equal(next.primaries.get('p')?.lifecycle,'stopped');
  assert.deepEqual(primaryBlocks(mergePrimaryPage(next,target,[],{nextCursor:null,earlier:false}),'p'),before);
  assert.deepEqual(primaryBlocks(replaceSnapshot(next,{...nextSnapshot,cursor:'replacement:1'}),'p'),before);
  for(const change of [{...stopped,epoch:2},{...stopped,sessionId:'different'},{...stopped,sessionFile:'/project/different.jsonl'}]) {
    const changed=reduceEvent(next,{id:'replacement:1',name:'primary.state',data:change,target});assert.equal(primaryBlocks(changed,'p').length,0);assert.equal(changed.conversations.has(targetIdentity(target)),false);
  }
  for(const primaries of [[],[{...stopped,epoch:2}],[{...stopped,key:'other'}],[{...stopped,sessionId:'different'}],[{...stopped,sessionId:undefined}],[{...stopped,sessionFile:'/project/different.jsonl'}],[{...stopped,sessionFile:undefined}]]) {
    const changed=replaceSnapshot(next,{...nextSnapshot,cursor:'replacement:1',primaries,selectedPage:undefined});assert.equal(primaryBlocks(changed,'p').length,0);assert.equal(changed.conversations.has(targetIdentity(target)),false);
  }
  assert.deepEqual(primaryBlocks(replaceSnapshot(next,{...nextSnapshot,cursor:'replacement:1',selectedPage:undefined}),'p'),before);
});
for(const saved of [false,true]) test(`resumed output and execution state survive an unsaved observed partial${saved?' with new committed entries':''}`, () => {
  const current={...primary(),sessionId:'retained-session',sessionFile:'/project/retained.jsonl'};
  const first:Snapshot={...snapshot(),primaries:[current],selectedPage:{target,items:[entry('leaf')],nextCursor:null,coverage}};
  let state=replaceSnapshot(createState(),first);
  state=reduceEvent(state,event(1,'primary.delta',{messageId:'interrupted',index:0,kind:'text',delta:'Unsaved interrupted partial'},{target}));
  const stopped={...current,lifecycle:'stopped' as const,activity:'unknown' as const,pid:undefined};
  state=replaceSnapshot(state,{...first,bootId:'replacement',cursor:'replacement:0',primaries:[stopped],selectedPage:{target,items:[],nextCursor:null,coverage}});
  assert(primaryBlocks(state,'p').some(block=>block.id==='message:interrupted'));
  const updates:UiEvent[]=[
    {id:'replacement:1',name:'primary.state',data:current,target},
    {id:'replacement:2',name:'primary.delta',data:{messageId:'fresh',index:0,kind:'text',delta:'New live output'},target},
    {id:'replacement:3',name:'primary.message',data:{message:{...message('fresh-message','New message','partial'),parts:[{type:'toolCall',callId:'fresh-tool',name:'read',arguments:{value:{path:'fresh.txt'},truncated:false}}]}},target},
    {id:'replacement:4',name:'primary.tool',data:{callId:'fresh-tool',name:'read',phase:'update',parts:[{type:'text',text:'Fresh tool output'}]},target},
    {id:'replacement:5',name:'primary.queue',data:{pending:1,followUp:['New queued input']},target},
    {id:'replacement:6',name:'primary.recovery',data:{kind:'retry',phase:'scheduled',attempt:1,delayMs:250},target},
  ];
  for(const update of updates) state=reduceEvent(state,update);
    let resumed=state;
    if(saved) for(const [index,value] of [entry('newly-saved'),{...entry('leaf'),messages:[message('new-leaf','Updated current content')]}].entries()) resumed=reduceEvent(resumed,{id:`replacement:${7+index}`,name:'primary.entry',data:{entry:value},target});
    const before=resumed.conversations.get(targetIdentity(target));assert.ok(before);
    for(const items of [[entry('leaf')],[],[entry('branch'),{id:'summary',kind:'branch_summary'}] as EntryView[]]) {
      const next=mergePrimaryPage(resumed,target,items,{nextCursor:'fresh-cursor',earlier:false}),after=next.conversations.get(targetIdentity(target));assert.ok(after);
      assert.deepEqual(after.live,before.live);assert.equal(after.live[0],before.live[0]);
      for(const key of ['messages','messageOrder','messageBlocks','tools','queue','recovery'] as const) assert.equal(after[key],before[key],key);
      assert(!primaryBlocks(next,'p').some(block=>block.id==='message:interrupted'));assert(primaryBlocks(next,'p').some(block=>block.id==='message:fresh'));
      assert.equal(after.retainedSession,undefined);assert.equal(after.retainedEntries,undefined);assert.equal(after.historyCursor,items.length?'fresh-cursor':undefined);
      if(saved) {assert.equal(after.entries.get('newly-saved'),before.entries.get('newly-saved'));if(!items.some(item=>item.id==='leaf'))assert.equal(after.entries.get('leaf'),before.entries.get('leaf'));}
    }
    for(const changed of [{...current,sessionId:'other'},{...current,sessionFile:'/project/other.jsonl'},{...current,epoch:2}]) {
      const reset=reduceEvent(resumed,{id:'replacement:9',name:'primary.state',data:changed,target});assert.equal(primaryBlocks(reset,'p').length,0);
    }
});
test('stopped history retention refuses changed identity workspace or authoritative reset and releases its observed marker on validated history', () => {
  const current={...primary(),sessionId:'retained-session',sessionFile:'/project/retained.jsonl'},first:Snapshot={...snapshot(),primaries:[current],selectedPage:{target,items:[entry('leaf')],nextCursor:null,coverage}};
  const state=mergePrimaryPage(replaceSnapshot(createState(),first),target,[entry('earlier')]);
  const stopped={...current,lifecycle:'stopped' as const,activity:'unknown' as const},base:Snapshot={...first,bootId:'replacement',cursor:'replacement:0',primaries:[stopped],selectedPage:{target,items:[],nextCursor:null,coverage}};
  const cases:Snapshot[]=[{...base,workspace:{...base.workspace,id:'different'}},...[
    {...stopped,epoch:2},{...stopped,key:'other'},{...stopped,sessionId:'different'},{...stopped,sessionId:undefined},{...stopped,sessionFile:'/project/other.jsonl'},{...stopped,sessionFile:undefined},{...stopped,lifecycle:'ready' as const},{...stopped,lifecycle:'failed' as const}
  ].map(value=>({...base,primaries:[value]})),{...base,selectedPage:{target,items:[entry('rewound')],nextCursor:null,coverage}},{...base,selectedPage:{target,items:[entry('leaf'),{id:'branch',kind:'branch_summary'}],nextCursor:null,coverage}}];
  for(const snap of cases) {const next=replaceSnapshot(state,snap);assert(!primaryBlocks(next,'p').some(value=>value.id==='earlier'));assert.equal([...next.conversations.values()].some(value=>!!value.retainedSession),false);}
  const retained=replaceSnapshot(state,base),ready={...retained,primaries:new Map([['p',current]])};
  const validated=mergePrimaryPage(ready,target,[entry('leaf')],{nextCursor:'fresh-cursor',earlier:false});assert.deepEqual(validated.conversations.get(targetIdentity(target))?.entryOrder,['earlier','leaf']);assert.equal(validated.conversations.get(targetIdentity(target))?.retainedSession,undefined);assert.equal(validated.conversations.get(targetIdentity(target))?.historyCursor,'fresh-cursor');
  const reset=mergePrimaryPage(ready,target,[],{nextCursor:null,earlier:false});assert.equal(primaryBlocks(reset,'p').length,0);assert.equal(reset.conversations.get(targetIdentity(target))?.retainedSession,undefined);
});
test('primary snapshots discard cached pages across changed or unproven histories', () => {
  const current = {...primary(), sessionId: 'session', sessionFile: '/project/session.jsonl'};
  const first: Snapshot = {...snapshot(), primaries: [current], selectedPage: {target, items: [entry('leaf')], nextCursor: 'earlier', coverage}};
  const state = mergePrimaryPage(replaceSnapshot(createState(), first), target, [entry('earlier')]);
  const cases: {name: string; snapshot: Snapshot; target?: typeof target}[] = [
    {name: 'boot', snapshot: {...first, bootId: 'next', cursor: 'next:2'}},
    {name: 'epoch', snapshot: {...first, primaries: [{...current, epoch: 2}], selectedPage: {target: {...target, epoch: 2}, items: [entry('leaf')], nextCursor: null, coverage}}, target: {...target, epoch: 2}},
    {name: 'fork session', snapshot: {...first, primaries: [{...current, sessionId: 'fork'}]}},
    {name: 'changed file', snapshot: {...first, primaries: [{...current, sessionFile: '/project/fork.jsonl'}]}},
    {name: 'unknown session', snapshot: {...first, primaries: [{...current, sessionId: undefined}]}},
    {name: 'rewound leaf', snapshot: {...first, selectedPage: {target, items: [entry('earlier')], nextCursor: null, coverage}}},
    {name: 'branch', snapshot: {...first, selectedPage: {target, items: [entry('leaf'), {id: 'branch', kind: 'branch_summary'}], nextCursor: null, coverage}}},
    {name: 'compaction', snapshot: {...first, selectedPage: {target, items: [entry('leaf'), {id: 'compact', kind: 'compaction'}], nextCursor: null, coverage}}},
  ];
  for (const item of cases) {
    const next = replaceSnapshot(state, {...item.snapshot, cursor: `${item.snapshot.bootId}:2`});
    const history = next.conversations.get(targetIdentity(item.target ?? target)); assert.ok(history, item.name);
    assert.deepEqual(history.entryOrder, item.snapshot.selectedPage && 'items' in item.snapshot.selectedPage ? item.snapshot.selectedPage.items.map(entry => entry.id) : [], item.name);
  }
  const agent = {kind: 'agent' as const, identity: 'a'};
  const agentState = mergeAgentPage(state, 'a', [entry('agent-older')]);
  const next = replaceSnapshot(agentState, {...first, cursor: 'boot:2', selectedPage: {target: agent, entries: [entry('agent-leaf')], nextBefore: null, coverage, revision: 'r'}});
  assert.deepEqual(next.conversations.get(targetIdentity(agent))?.entryOrder, ['agent-leaf']);
});

test('older history prepends without duplicate entries or changed references', () => {
  let state = mergeAgentPage(baseline(), 'a', [entry('tail')]);
  const key = targetIdentity({kind: 'agent', identity: 'a'});
  const tail = state.conversations.get(key)?.entries.get('tail');
  state = mergeAgentPage(state, 'a', [entry('older')]);
  assert.deepEqual(state.conversations.get(key)?.entryOrder, ['older', 'tail']);
  assert.equal(state.conversations.get(key)?.entries.get('tail'), tail);
});
test('roster changes do not reorder pointer targets; removals use exact keys', () => {
  let state = reduceEvent(baseline(), event(1, 'agent.roster', {revision: 1, changed: [{...row('b'), modifiedAt: 100}, row('c')], removed: ['a'], scan: snapshot().roster.scan, stale: false}));
  assert.deepEqual(state.rosterOrder, ['b', 'c']);
  state = reduceEvent(state, event(2, 'agent.roster', {revision: 0, changed: [row('a')], removed: [], scan: snapshot().roster.scan, stale: false}));
  assert.equal(state.roster.has('a'), false);
});
test('workspace focus revisions do not let panel visibility suppress an active agent leaf', () => {
  let state = reduceEvent(baseline(), event(1, 'workspace.changed', {id: 'workspace', revision: 1, selectedTarget: {kind: 'agent', identity: 'a'}}));
  assert.ok(state.workspace); assert.equal(visibleTargets(state.workspace)[0]?.kind, 'agent');
  state = reduceEvent(state, event(2, 'workspace.changed', {id: 'workspace', revision: 2, selectedTarget: {kind: 'agent', identity: 'a'}, panelVisible: false}));
  assert.equal(state.workspace?.selectedTarget?.kind, 'agent');
  state = reduceEvent(state, event(3, 'workspace.changed', {id: 'workspace', revision: 1, selectedTarget: {kind: 'agent', identity: 'b'}}));
  assert.equal(state.workspace?.selectedTarget?.kind, 'agent');
});
test('snapshot observations carry epochs and clearing the active layout releases live frames', () => {
  const snap = snapshot(); snap.workspace.selectedTarget = {kind: 'agent', identity: 'a'}; snap.observations = [{identity: 'a', connectionEpoch: 1, frame: frame(1, [entry('baseline')])}];
  let state = replaceSnapshot(createState(), snap);
  assert.equal(agentBlocks(state, 'a')[0]?.id, 'baseline');
  state = reduceEvent(state, event(1, 'workspace.changed', {id: 'workspace', revision: 1}));
  assert.equal(state.conversations.get(targetIdentity({kind: 'agent', identity: 'a'}))?.frame, undefined);
});
test('same-boot snapshot frame accepts the existing connection after its boundary', () => {
  let state = selectAgent(baseline(), 'a');
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(8)}));
  const snap = snapshot('boot', 2); snap.workspace.selectedTarget = {kind: 'agent', identity: 'a'}; snap.observations = [{identity: 'a', connectionEpoch: 2, frame: frame(9)}];
  state = replaceSnapshot(state, snap);
  state = reduceEvent(state, event(3, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(10, [], [entry('latest')])}));
  assert.equal(agentBlocks(state, 'a')[0]?.id, 'latest');
});
test('target draft and reading revisions reject older records', () => {
  const item: TargetState = {targetKey: 'opaque', target, draft: {revision: 4, text: 'new', mode: 'prompt', persisted: true}, reading: {revision: 2, anchorId: 'e', offsetPx: 10, followTail: false}, unconfirmed: []};
  const snap = snapshot(); snap.targets = [item];
  let state = replaceSnapshot(createState(), snap);
  state = reduceEvent(state, event(1, 'draft.changed', {targetKey: 'opaque', target, draft: {...item.draft, revision: 3, text: 'old'}}));
  state = reduceEvent(state, event(2, 'reading.changed', {targetKey: 'opaque', reading: {...item.reading, revision: 1, followTail: true}}));
  assert.equal(state.targets.get('opaque'), item);
});
test('extension keyed state clears omitted values and rejects stale epochs', () => {
  let state = reduceEvent(baseline(), event(1, 'extension.request', {method: 'setStatus', statusKey: 's', statusText: 'ready'}, {target}));
  state = reduceEvent(state, event(2, 'extension.request', {method: 'setWidget', widgetKey: 'w', widgetLines: ['line']}, {target}));
  state = reduceEvent(state, event(3, 'extension.request', {method: 'setStatus', statusKey: 's'}, {target}));
  state = reduceEvent(state, event(4, 'extension.request', {method: 'setWidget', widgetKey: 'w'}, {target}));
  assert.deepEqual(state.primaries.get('p')?.extension?.statuses, {});
  assert.deepEqual(state.primaries.get('p')?.extension?.widgets, {});
  state = reduceEvent(state, event(5, 'extension.request', {method: 'setTitle', title: 'stale'}, {target: {...target, epoch: 0}}));
  assert.equal(state.primaries.get('p')?.extension?.title, undefined);
});
test('foreign workspace payloads advance journal order but never change this workspace', () => {
  const state = reduceEvent(baseline(), event(4, 'notice', {level: 'error', message: 'foreign'}, {workspaceId: 'other'}));
  assert.equal(state.sequence, 4); assert.equal(state.notices.length, 0);
});

test('agent frames retain unchanged committed and live entry objects', () => {
  let state = selectAgent(baseline(), 'a');
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(1, [entry('e')], [entry('live:new')])}));
  const blocks = agentBlocks(state, 'a');
  state = reduceEvent(state, event(2, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(2, [entry('e')], [entry('live:new')])}));
  assert.equal(agentBlocks(state, 'a')[0], blocks[0]);
  assert.equal(agentBlocks(state, 'a')[1], blocks[1]);
});
test('mixed live entries drop only committed messages, not remaining text', () => {
  let state = selectAgent(baseline(), 'a');
  const mixed = {id: 'live:generation', kind: 'message', messages: [message('committed'), message('new', 'still live', 'partial')]};
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(1, [entry('e', 'committed')], [mixed])}));
  assert.deepEqual(agentBlocks(state, 'a')[1]?.messages?.map(message => message.id), ['new']);
});
test('a committed tool key never removes unrelated live prose', () => {
  const tool: EntryView = {id: 'e', kind: 'message', messages: [{id: 'result', role: 'tool', state: 'final', coverage, parts: [{type: 'toolResult', callId: 'c', name: 'read', parts: [], isError: false}]}]};
  const live: EntryView = {id: 'live:generation', kind: 'message', messages: [{id: 'active', role: 'assistant', state: 'partial', coverage, parts: [{type: 'toolCall', callId: 'c', name: 'read', arguments: {value: {}, truncated: false}}, {type: 'text', text: 'new prose'}]}]};
  let state = selectAgent(baseline(), 'a');
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(1, [tool], [live])}));
  assert.equal(agentBlocks(state, 'a').length, 2);
});

const notice = (sequence: number, message = 'Notice', bootId = 'boot'): NoticeView => ({id: `${bootId}:${sequence}`, level: 'info', message});
test('notice snapshot and replay use journal IDs rather than identical text', () => {
  const snap = snapshot('boot', 2); snap.notices = [notice(1), notice(1), notice(2)];
  let state = replaceSnapshot(createState(), snap);
  assert.deepEqual(state.notices.map(item => item.id), ['boot:1', 'boot:2']);
  assert.equal(unreadNotices(state), 2);
  assert.equal(reduceEvent(state, event(2, 'notice', {level: 'info', message: 'Notice'})), state);
  state = reduceEvent(state, event(3, 'notice', {level: 'info', message: 'Notice'}));
  assert.equal(unreadNotices(state), 3);
});
test('notice dismissal and read state survive same-boot snapshot replacement', () => {
  const snap = snapshot('boot', 2); snap.notices = [notice(1), notice(2)];
  let state = markReadNotices(replaceSnapshot(createState(), snap));
  state = dismissNotice(state, 'boot:2');
  assert.equal(unreadNotices(state), 0);
  assert.equal(dismissNotice(state, 'boot:2'), state);
  const refreshed = {...snap, cursor: 'boot:3', notices: [notice(1), notice(2), notice(3)]};
  state = replaceSnapshot(state, refreshed);
  assert.deepEqual(state.notices.map(item => item.id), ['boot:1', 'boot:3']);
  assert.equal(unreadNotices(state), 1);
  const read = markReadNotices(state);
  assert.equal(unreadNotices(read), 0); assert.equal(markReadNotices(read), read);
});
test('notice dismissal tombstones persist when a notice leaves and returns in a snapshot', () => {
  const snap = snapshot('boot', 1); snap.notices = [notice(1)];
  let state = dismissNotice(replaceSnapshot(createState(), snap), 'boot:1');
  state = replaceSnapshot(state, {...snap, cursor: 'boot:2', notices: []});
  state = replaceSnapshot(state, {...snap, cursor: 'boot:3'});
  assert.equal(state.notices.length, 0); assert.equal(unreadNotices(state), 0);
});
test('omitted notice baseline retains the local shelf and its read state', () => {
  const snap = snapshot('boot', 1); snap.notices = [notice(1)];
  let state = markReadNotices(replaceSnapshot(createState(), snap));
  state = replaceSnapshot(state, {...snapshot('boot', 2), omitted: ['notices']});
  assert.equal(state.notices[0]?.id, 'boot:1'); assert.equal(unreadNotices(state), 0);
});
test('backend restart resets transient notice state and rejects old-boot shelf records', () => {
  const snap = snapshot('boot', 1); snap.notices = [notice(1)];
  let state = dismissNotice(replaceSnapshot(createState(), snap), 'boot:1');
  const restarted = snapshot('next', 1); restarted.notices = [notice(1), notice(1, 'Fresh', 'next')];
  state = replaceSnapshot(state, restarted);
  assert.deepEqual(state.notices.map(item => item.id), ['next:1']);
  assert.equal(state.dismissedNotices.size, 0); assert.equal(unreadNotices(state), 1);
});
test('notice shelf excludes other workspaces and preserves exact source targets', () => {
  const snap = snapshot('boot', 3);
  snap.notices = [notice(1), {...notice(2), workspaceId: 'other'}, {...notice(3), workspaceId: 'workspace', target}];
  const state = replaceSnapshot(createState(), snap);
  assert.deepEqual(state.notices.map(item => item.id), ['boot:1', 'boot:3']);
  assert.equal(state.notices[1]?.target, target);
});
test('extension notify and notice replay share one notice identity', () => {
  let state = reduceEvent(baseline(), event(1, 'extension.request', {method: 'notify', notifyType: 'warning', message: 'Check'}, {target}));
  assert.deepEqual(state.notices[0], {id: 'boot:1', level: 'warning', message: 'Check', target, workspaceId: undefined});
  const snap = snapshot('boot', 1); snap.notices = [{id: 'boot:1', level: 'warning', message: 'Check', target}];
  state = replaceSnapshot(state, snap);
  assert.equal(state.notices.length, 1);
  assert.equal(reduceEvent(state, event(1, 'extension.request', {method: 'notify', notifyType: 'warning', message: 'Check'}, {target})), state);
});
test('notice shelf and local dismissal records remain bounded', () => {
  let state = baseline();
  for (let sequence = 1; sequence <= 100; sequence++) {
    state = reduceEvent(state, event(sequence, 'notice', {level: 'info', message: `Notice ${sequence}`}));
    state = dismissNotice(state, `boot:${sequence}`);
  }
  assert.equal(state.noticeShelf.size, 32); assert.equal(state.dismissedNotices.size, 32);
  assert.equal(state.notices.length, 0); assert.equal(state.readNotices.size, 0);
  assert.equal(dismissNotice(state, 'missing'), state);
});
test('cached roster pages preserve loaded row order and update the page cursor', () => {
  const base = baseline(); const original = base.roster.get('a');
  const page: CachedRoster = {...snapshot().roster, rows: [row('b'), row('c')], nextCursor: 'next-page'};
  let state = mergeRosterPage(base, page);
  assert.deepEqual(state.rosterOrder, ['a', 'b', 'c']); assert.equal(state.roster.get('a'), original);
  assert.equal(state.rosterMeta?.nextCursor, 'next-page'); assert.equal(state.rosterRevision, base.rosterRevision);
  state = mergeRosterPage(state, {...page, rows: [row('c'), row('d')], nextCursor: null});
  assert.deepEqual(state.rosterOrder, ['a', 'b', 'c', 'd']); assert.equal(state.rosterMeta?.nextCursor, null);
});
test('roster deltas preserve the cached page cursor independently of scan completeness', () => {
  let state = mergeRosterPage(baseline(), {...snapshot().roster, rows: [row('c')], nextCursor: 'older-page'});
  state = reduceEvent(state, event(1, 'agent.roster', {revision: 1, changed: [row('d')], removed: ['b'], scan: snapshot().roster.scan, stale: true}));
  assert.deepEqual(state.rosterOrder, ['a', 'c', 'd']); assert.equal(state.rosterMeta?.nextCursor, 'older-page');
  assert.equal(state.rosterMeta?.scan.complete, true); assert.equal(state.rosterMeta?.stale, true);
});
test('snapshot preserves hydration indexes and cached roster continuation', () => {
  const snap = snapshot(); snap.roster.nextCursor = 'more'; snap.primaryIndex = [{key: 'p', epoch: 1, lifecycle: 'ready'}];
  snap.operationIndex = ['operation']; snap.omitted = ['pendingOperations', 'targets'];
  const state = replaceSnapshot(createState(), snap);
  assert.equal(state.rosterMeta?.nextCursor, 'more'); assert.deepEqual(state.primaryIndex, snap.primaryIndex);
  assert.deepEqual(state.operationIndex, ['operation']); assert.deepEqual(state.omitted, snap.omitted);
});

const loadedRoster = (): UiState => mergeRosterPage(baseline(), {...snapshot().roster, rows: [row('c'), row('d')], nextCursor: 'after-d'});
const partialSnapshot = (sequence = 5): Snapshot => ({...snapshot('boot', sequence), roster: {...snapshot().roster, nextCursor: 'after-b'}});
const rosterDelta = (revision: number, changed: AgentRow[] = [], removed: string[] = []): EventData['agent.roster'] => ({revision, changed, removed, scan: snapshot().roster.scan, stale: false});
test('same-boot partial roster snapshots preserve loaded pages and pointer order', () => {
  const old = loadedRoster(); const snap = partialSnapshot();
  snap.roster.rows = [{...row('b'), name: 'Current'}, row('a'), row('e')];
  const state = replaceSnapshot(old, snap);
  assert.deepEqual(state.rosterOrder, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(state.roster.get('c'), old.roster.get('c')); assert.equal(state.roster.get('b')?.name, 'Current');
  assert.equal(state.rosterMeta?.nextCursor, 'after-b'); assert.deepEqual(old.rosterOrder, ['a', 'b', 'c', 'd']);
});
test('pre-cut roster changes reconcile extras without replacing authoritative snapshot rows', () => {
  const snap = partialSnapshot(); snap.roster.rows = [{...row('a'), name: 'Baseline'}, row('b')];
  const delta = event(3, 'agent.roster', {...rosterDelta(3, [{...row('a'), name: 'Old'}, {...row('c'), name: 'Updated'}, row('unloaded')], ['a', 'd']), stale: true});
  const state = replaceSnapshot(loadedRoster(), snap, [delta]);
  assert.deepEqual(state.rosterOrder, ['a', 'b', 'c']); assert.equal(state.roster.get('a')?.name, 'Baseline');
  assert.equal(state.roster.get('c')?.name, 'Updated'); assert.equal(state.roster.has('unloaded'), false);
  assert.equal(state.rosterRevision, 3); assert.equal(state.rosterMeta?.stale, false); assert.equal(state.sequence, 5);
});
test('pre-cut roster events use journal order before a removed extra returns', () => {
  const removed = event(3, 'agent.roster', rosterDelta(3, [], ['c']));
  const changed = event(4, 'agent.roster', rosterDelta(4, [{...row('c'), name: 'Returned'}]));
  const state = replaceSnapshot(loadedRoster(), partialSnapshot(), [changed, removed]);
  assert.deepEqual(state.rosterOrder, ['a', 'b', 'd', 'c']); assert.equal(state.roster.get('c')?.name, 'Returned');
});
test('duplicate pre-cut journal IDs apply a roster change exactly once', () => {
  const first = event(3, 'agent.roster', rosterDelta(3, [{...row('c'), name: 'First'}]));
  const duplicate = event(3, 'agent.roster', rosterDelta(4, [], ['c']));
  const state = replaceSnapshot(loadedRoster(), partialSnapshot(), [first, duplicate]);
  assert.equal(state.roster.get('c')?.name, 'First'); assert.equal(state.rosterRevision, 3);
});
test('pre-cut roster reconciliation excludes invalid cursors and foreign boot or workspace data', () => {
  const valid = event(2, 'agent.roster', rosterDelta(2, [{...row('c'), name: 'Valid'}]));
  const foreign = event(3, 'agent.roster', rosterDelta(999, [], ['c', 'd']), {workspaceId: 'other'});
  const wrongBoot = event(4, 'agent.roster', rosterDelta(999, [], ['c', 'd']), {id: 'other:4'});
  const invalid = event(4, 'agent.roster', rosterDelta(999, [], ['c', 'd']), {id: 'invalid'});
  const state = replaceSnapshot(loadedRoster(), partialSnapshot(), [valid, foreign, wrongBoot, invalid]);
  assert.equal(state.roster.get('c')?.name, 'Valid'); assert.equal(state.roster.has('d'), true);
  assert.equal(state.rosterRevision, 2); assert.equal(state.needsResync, true);
});
test('post-cut roster replay still changes baseline rows and retained extra rows', () => {
  const before = event(3, 'agent.roster', rosterDelta(3, [{...row('c'), name: 'Before'}]));
  const after = event(8, 'agent.roster', rosterDelta(8, [{...row('c'), name: 'After'}, row('new')], ['a', 'd']));
  const state = replaceSnapshot(loadedRoster(), partialSnapshot(), [before, after]);
  assert.deepEqual(state.rosterOrder, ['b', 'c', 'new']); assert.equal(state.roster.get('c')?.name, 'After');
  assert.equal(state.sequence, 8); assert.equal(state.rosterRevision, 8); assert.equal(state.rosterMeta?.nextCursor, 'after-b');
});
test('omitted roster snapshots retain page metadata and reconcile loaded extras', () => {
  const snap = snapshot('boot', 5); snap.omitted = ['roster']; snap.roster.rows = []; snap.roster.nextCursor = null;
  snap.roster.rows = [{...row('c'), name: 'Selected'}];
  const delta = event(3, 'agent.roster', {...rosterDelta(3, [{...row('c'), name: 'Old'}], ['b']), stale: true});
  const state = replaceSnapshot(loadedRoster(), snap, [delta]);
  assert.deepEqual(state.rosterOrder, ['a', 'c', 'd']); assert.equal(state.roster.get('c')?.name, 'Selected');
  assert.equal(state.rosterMeta?.nextCursor, 'after-d'); assert.equal(state.rosterMeta?.stale, true);
});
test('complete same-boot roster baselines replace loaded pages normally', () => {
  for (const nextCursor of [undefined, null]) {
    const snap = snapshot('boot', 5); snap.roster.rows = [row('b'), row('a')]; snap.roster.nextCursor = nextCursor;
    const state = replaceSnapshot(loadedRoster(), snap, [event(3, 'agent.roster', rosterDelta(3, [row('c')]))]);
    assert.deepEqual(state.rosterOrder, ['b', 'a']); assert.equal(state.roster.has('c'), false);
    assert.equal(state.rosterRevision, -1); assert.equal(state.rosterMeta?.nextCursor, nextCursor);
  }
});
test('new-boot partial roster baselines discard previously loaded pages', () => {
  const snap = {...partialSnapshot(), bootId: 'next', cursor: 'next:5'};
  const state = replaceSnapshot(loadedRoster(), snap);
  assert.deepEqual(state.rosterOrder, ['a', 'b']); assert.equal(state.roster.has('c'), false);
  assert.equal(state.rosterRevision, -1); assert.equal(state.rosterMeta?.nextCursor, 'after-b');
});
test('pre-cut events already applied to the state never regress retained extras', () => {
  const old = reduceEvent(loadedRoster(), event(2, 'agent.roster', rosterDelta(2, [{...row('c'), name: 'Current'}])));
  const stale = event(1, 'agent.roster', rosterDelta(999, [{...row('c'), name: 'Old'}], ['d']));
  const state = replaceSnapshot(old, partialSnapshot(), [stale]);
  assert.equal(state.roster.get('c')?.name, 'Current'); assert.equal(state.roster.has('d'), true);
  assert.equal(state.rosterRevision, 2);
});
test('snapshot roster carries an active agent row without changing the page cursor', () => {
  const snap = partialSnapshot(); snap.workspace.selectedTarget = {kind: 'agent', identity: 'outside'};
  const selected: AgentRow = {...row('outside'), capabilities: {history: true, observe: true, input: true, abort: false, configure: false}};
  snap.roster.rows.push(selected);
  snap.observations = [{identity: 'outside', connectionEpoch: 0, omitted: true}];
  const state = replaceSnapshot(createState(), snap);
  assert.equal(state.roster.get('outside'), selected); assert.equal(state.roster.get('outside')?.capabilities?.input, true);
  assert.deepEqual(state.rosterOrder, ['a', 'b', 'outside']); assert.equal(state.rosterMeta?.nextCursor, 'after-b');
  assert.equal(state.agentEpochs.has('outside'), false);
});

test('captured snapshots never overwrite newer acknowledged presentation preferences', () => {
  const item: TargetState = {targetKey: 'opaque', target, draft: {revision: 4, text: 'new', mode: 'prompt', persisted: true},
    reading: {revision: 2, anchorId: 'e', offsetPx: 10, followTail: false},
    presentation: {revision: 5, expanded: ['e'], showThinking: true}, unconfirmed: []};
  const state = {...baseline(), targets: new Map([[item.targetKey, item]])};
  for (const revision of [undefined, 4, 5, 6]) {
    const presentation = revision === undefined ? undefined : {revision, expanded: [], showThinking: false};
    const snap = snapshot('boot', 5); snap.targets = [{...item, presentation}];
    const merged = replaceSnapshot(state, snap).targets.get(item.targetKey);
    assert.equal(merged?.presentation, revision === undefined || revision < 5 ? item.presentation : presentation);
    assert.equal(merged?.draft, item.draft); assert.equal(merged?.reading, item.reading);
  }
  assert.equal(state.targets.get(item.targetKey)?.presentation, item.presentation);
});

const operation = (state: OperationView['state'], id = 'op', updatedAt = '2026-10-08T12:00:00.000Z'): OperationView => ({id, kind: 'primary.handoff', target, state, createdAt: '2026-10-08T12:00:00.000Z', updatedAt});
test('late operation events never replace a known definite receipt', () => {
  for (const finalState of ['accepted', 'rejected', 'completed'] as const) {
    const final = operation(finalState);
    const settled = reduceEvent(baseline(), event(1, 'operation.changed', final));
    let state = reduceEvent(settled, event(2, 'operation.changed', operation('uncertain', 'op', '2026-10-08T12:00:02.000Z')));
    state = reduceEvent(state, event(3, 'operation.changed', operation('dispatched', 'op', '2026-10-08T12:00:03.000Z')));
    assert.equal(state.operations.get('op'), final); assert.equal(state.sequence, 3);
    assert.equal(settled.operations.get('op'), final); assert.equal(settled.sequence, 1);
  }
});
test('same-boot operation snapshots merge known receipts and a new boot resets them', () => {
  const finals = ['accepted', 'rejected', 'completed'].map(state => operation(state as OperationView['state'], state));
  const retained = operation('completed', 'absent'); const provisional = operation('uncertain', 'pending');
  const known = [...finals, retained, provisional];
  const old = {...baseline(), operations: new Map(known.map(view => [view.id, view]))};
  const resolved = operation('completed', 'pending', '2026-10-08T12:00:02.000Z');
  const incoming = operation('reserved', 'new'); const snap = snapshot('boot', 5);
  snap.pendingOperations = [...finals.map(view => operation('uncertain', view.id, '2026-10-08T12:00:03.000Z')), resolved, incoming];
  const merged = replaceSnapshot(old, snap);
  for (const final of finals) assert.equal(merged.operations.get(final.id), final);
  assert.equal(merged.operations.get('absent'), retained); assert.equal(merged.operations.get('pending'), resolved);
  assert.equal(merged.operations.get('new'), incoming); assert.equal(old.operations.get('pending'), provisional);
  const reset = replaceSnapshot(merged, {...snap, bootId: 'next', cursor: 'next:5'});
  assert.equal(reset.operations.has('absent'), false);
  assert.equal(reset.operations.get('accepted'), snap.pendingOperations[0]);
  assert.equal(reset.operations.size, snap.pendingOperations.length);
});

test('negotiated workspace availability survives retained roster and cached page updates', () => {
  let state = selectAgent(baseline(), 'a'); const capabilities = {history: true, observe: true, input: true, abort: true, configure: false};
  state = reduceEvent(state, event(1, 'agent.availability', {identity: 'a', connectionEpoch: 1, state: 'live', capabilities}));
  state = reduceEvent(state, event(2, 'agent.roster', {revision: 1, changed: [{...row('a'), availability: 'stored'}], removed: [], scan: {state: 'ready', complete: true, visited: 1, skipped: 0, omitted: 0}, stale: false}));
  state = mergeRosterPage(state, {...snapshot().roster, rows: [{...row('a'), availability: 'stored'}]});
  assert.equal(state.agentAvailability.get('a')?.state, 'live'); assert.equal(state.agentAvailability.get('a')?.capabilities.input, true);
  state = reduceEvent(state, event(3, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(1)}));
  assert.equal(state.agentAvailability.get('a')?.state, 'live');
  state = selectAgent(state, 'b'); assert.equal(state.agentAvailability.size, 0);
});
