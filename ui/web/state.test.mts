import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationView, CachedRoster, NoticeView, AgentRow, EntryView, EventData, EventName, MessageView, PrimaryView, ProjectedFrame, Snapshot, TargetState } from '../shared/api.ts';
import { dismissNotice, markReadNotices, unreadNotices, mergeRosterPage, agentBlocks, conversationBlocks, createState, mergeAgentPage, mergePrimaryPage, parseCursor, primaryBlocks, reduceEvent, replaceSnapshot, selectAgent, targetIdentity } from './state.ts';
import type { UiEvent, UiState } from './state.ts';
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
const frame = (revision: number, entries: EntryView[] = [], live: EntryView[] = []): ProjectedFrame => ({revision, entries, live, observedAt: '2026-10-08T12:00:00.000Z', nextBefore: null, status: {busy: !!live.length}, coverage});

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
  assert.deepEqual(agentBlocks(state).map(block => block.id), ['committed']);
  state = reduceEvent(state, event(3, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(8, [], [entry('old')])}));
  state = reduceEvent(state, event(4, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(100, [], [entry('old epoch')])}));
  assert.deepEqual(agentBlocks(state).map(block => block.id), ['committed']);
  state = reduceEvent(state, event(5, 'agent.frame', {identity: 'a', connectionEpoch: 3, frame: frame(1, [], [entry('fresh')])}));
  assert.equal(state.selectedAgent?.revision, 1);
  assert.deepEqual(agentBlocks(state).map(block => block.id), ['committed', 'fresh']);
});
test('deselection rejects late frames and re-entry requires a fresh connection epoch', () => {
  let state = selectAgent(baseline(), 'a');
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(8)}));
  state = selectAgent(state, 'b');
  state = reduceEvent(state, event(2, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(9, [], [entry('late')])}));
  state = selectAgent(state, 'a');
  state = reduceEvent(state, event(3, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(10, [], [entry('stale')])}));
  assert.deepEqual(agentBlocks(state), []);
  state = reduceEvent(state, event(4, 'agent.frame', {identity: 'a', connectionEpoch: 3, frame: frame(1, [], [entry('new')])}));
  assert.equal(agentBlocks(state)[0]?.id, 'new');
});
test('agent live and committed projections reconcile by message and tool-call keys', () => {
  const toolEntry = (id: string, messageId: string): EntryView => ({id, kind: 'message', messages: [{id: messageId, role: 'tool', state: 'final', coverage, parts: [{type: 'toolResult', callId: 'c', name: 'read', parts: [], isError: false}]}]});
  let state = selectAgent(baseline(), 'a');
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 0, frame: frame(1, [entry('e', 'm'), toolEntry('tool', 'committed-tool')], [entry('live:generation', 'm'), toolEntry('live:tool:c', 'live-tool')])}));
  assert.deepEqual(agentBlocks(state).map(block => block.id), ['e', 'tool']);
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
test('workspace revisions and hidden panels release selected frame state', () => {
  let state = reduceEvent(baseline(), event(1, 'workspace.changed', {id: 'workspace', revision: 1, selectedTarget: {kind: 'agent', identity: 'a'}}));
  assert.equal(state.selectedAgent?.identity, 'a');
  state = reduceEvent(state, event(2, 'workspace.changed', {id: 'workspace', revision: 2, selectedTarget: {kind: 'agent', identity: 'a'}, panelVisible: false}));
  assert.equal(state.selectedAgent, undefined);
  state = reduceEvent(state, event(3, 'workspace.changed', {id: 'workspace', revision: 1, selectedTarget: {kind: 'agent', identity: 'b'}}));
  assert.equal(state.selectedAgent, undefined);
});
test('snapshot default panel visibility acquires selected agent and explicit clearing releases it', () => {
  const snap = snapshot(); snap.workspace.selectedTarget = {kind: 'agent', identity: 'a'}; snap.selectedFrame = frame(1, [entry('baseline')]);
  let state = replaceSnapshot(createState(), snap);
  assert.equal(agentBlocks(state)[0]?.id, 'baseline');
  state = reduceEvent(state, event(1, 'workspace.changed', {id: 'workspace', revision: 1}));
  assert.equal(state.selectedAgent, undefined);
});
test('same-boot snapshot frame accepts the existing connection after its boundary', () => {
  let state = selectAgent(baseline(), 'a');
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(8)}));
  const snap = snapshot('boot', 2); snap.workspace.selectedTarget = {kind: 'agent', identity: 'a'}; snap.selectedFrame = frame(9);
  state = replaceSnapshot(state, snap);
  state = reduceEvent(state, event(3, 'agent.frame', {identity: 'a', connectionEpoch: 2, frame: frame(10, [], [entry('latest')])}));
  assert.equal(agentBlocks(state)[0]?.id, 'latest');
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
  const blocks = agentBlocks(state);
  state = reduceEvent(state, event(2, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(2, [entry('e')], [entry('live:new')])}));
  assert.equal(agentBlocks(state)[0], blocks[0]);
  assert.equal(agentBlocks(state)[1], blocks[1]);
});
test('mixed live entries drop only committed messages, not remaining text', () => {
  let state = selectAgent(baseline(), 'a');
  const mixed = {id: 'live:generation', kind: 'message', messages: [message('committed'), message('new', 'still live', 'partial')]};
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(1, [entry('e', 'committed')], [mixed])}));
  assert.deepEqual(agentBlocks(state)[1]?.messages?.map(message => message.id), ['new']);
});
test('a committed tool key never removes unrelated live prose', () => {
  const tool: EntryView = {id: 'e', kind: 'message', messages: [{id: 'result', role: 'tool', state: 'final', coverage, parts: [{type: 'toolResult', callId: 'c', name: 'read', parts: [], isError: false}]}]};
  const live: EntryView = {id: 'live:generation', kind: 'message', messages: [{id: 'active', role: 'assistant', state: 'partial', coverage, parts: [{type: 'toolCall', callId: 'c', name: 'read', arguments: {value: {}, truncated: false}}, {type: 'text', text: 'new prose'}]}]};
  let state = selectAgent(baseline(), 'a');
  state = reduceEvent(state, event(1, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(1, [tool], [live])}));
  assert.equal(agentBlocks(state).length, 2);
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
  snap.selectedAgent = {...row('c'), name: 'Selected'};
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
test('snapshot selected agent supplies an unknown first-page row without changing the page cursor', () => {
  const snap = partialSnapshot(); snap.workspace.selectedTarget = {kind: 'agent', identity: 'outside'};
  const selected: AgentRow = {...row('outside'), capabilities: {history: true, observe: true, input: true, abort: false, configure: false}};
  snap.selectedAgent = selected;
  const state = replaceSnapshot(createState(), snap);
  assert.equal(state.roster.get('outside'), selected); assert.equal(state.roster.get('outside')?.capabilities?.input, true);
  assert.deepEqual(state.rosterOrder, ['a', 'b', 'outside']); assert.equal(state.rosterMeta?.nextCursor, 'after-b');
  assert.deepEqual(state.selectedAgent, {identity: 'outside', connectionEpoch: -1, revision: -1});
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
  state = reduceEvent(state, event(1, 'agent.availability', {identity: 'a', state: 'live', capabilities}));
  state = reduceEvent(state, event(2, 'agent.roster', {revision: 1, changed: [{...row('a'), availability: 'stored'}], removed: [], scan: {state: 'ready', complete: true, visited: 1, skipped: 0, omitted: 0}, stale: false}));
  state = mergeRosterPage(state, {...snapshot().roster, rows: [{...row('a'), availability: 'stored'}]});
  assert.equal(state.agentAvailability.get('a')?.state, 'live'); assert.equal(state.agentAvailability.get('a')?.capabilities.input, true);
  state = reduceEvent(state, event(3, 'agent.frame', {identity: 'a', connectionEpoch: 1, frame: frame(1)}));
  assert.equal(state.agentAvailability.get('a')?.state, 'live');
  state = selectAgent(state, 'b'); assert.equal(state.agentAvailability.size, 0);
});
