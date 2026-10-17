import type {
  AgentRow, CachedRoster, EntryView, EventData, EventName, JsonDisplay, MessageView,
  PartView, PrimaryView, ProjectedFrame, Snapshot, Target, TargetState, Workspace, OperationView, TargetIndex, NoticeView, ToolOutputInfo,
} from '../shared/api.ts';
import { createDialogs, enqueueDialog, expireDialog, expirePrimaryDialogs, reconcileDialogs } from './dialog-state.ts';
import type { DialogState } from './dialog-state.ts';
import { mergeOperationMap } from './operation-state.ts';
import { workspaceLayout, tabKey } from './tabs.ts';
import { paneLeaves } from './pane-layout.ts';

export type UiEvent = { [N in EventName]: { name: N; id?: string; target?: Target; workspaceId?: string; data: EventData[N] } }[EventName];
export interface ToolState {
  callId: string; name: string; phase: 'start' | 'update' | 'end'; arguments?: JsonDisplay;
  argumentText?: string; parts?: PartView[]; isError?: boolean; durationMs?: number; observedStart?: number; output?: ToolOutputInfo; nativeStatus?: 'pending'|'running'|'done';
}
export interface Conversation {
  target: Target; entries: ReadonlyMap<string, EntryView>; entryOrder: string[]; historyCursor?: string | null;
  messages: ReadonlyMap<string, MessageView>; messageOrder: string[];
  tools: ReadonlyMap<string, ToolState>; live: EntryView[]; messageBlocks: ReadonlyMap<string, EntryView>;
  queue?: EventData['primary.queue']; recovery?: EventData['primary.recovery']; frame?: ProjectedFrame; connectionEpoch?: number;
  retainedSession?: {id:string;file:string}; retainedEntries?: ReadonlyMap<string,EntryView>;
}
export interface UiState {
  bootId?: string; cursor?: string; sequence: number; needsResync: boolean; resyncReason?: string;
  workspace?: Workspace; primaries: ReadonlyMap<string, PrimaryView>;
  conversations: ReadonlyMap<string, Conversation>; roster: ReadonlyMap<string, AgentRow>;
  rosterOrder: string[]; rosterRevision: number; rosterMeta?: Omit<CachedRoster, 'rows'>;
  targets: ReadonlyMap<string, TargetState>; targetIndex: ReadonlyMap<string, TargetIndex>; dialogs: DialogState;
  operations: ReadonlyMap<string, OperationView>;
  primaryIndex: NonNullable<Snapshot['primaryIndex']>; operationIndex: string[]; omitted: NonNullable<Snapshot['omitted']>;
  agentEpochs: ReadonlyMap<string, number>;
  agentAvailability: ReadonlyMap<string, EventData['agent.availability']>;
  notices: NoticeView[]; noticeShelf: ReadonlyMap<string, NoticeView>;
  dismissedNotices: ReadonlySet<string>; readNotices: ReadonlySet<string>; editorSuggestions: ReadonlyMap<string, string>;
}
export function targetIdentity(target: Target): string {
  return target.kind === 'primary' ? JSON.stringify(['primary', target.key, target.epoch]) : JSON.stringify(['agent', target.identity]);
}
export function createState(): UiState {
  return { sequence: 0, needsResync: true, primaries: new Map(), conversations: new Map(),
    roster: new Map(), rosterOrder: [], rosterRevision: -1, targets: new Map(), targetIndex: new Map(), dialogs: createDialogs(),
    operations: new Map(), primaryIndex: [], operationIndex: [], omitted: [], agentEpochs: new Map(), agentAvailability: new Map(),
    notices: [], noticeShelf: new Map(), dismissedNotices: new Set(), readNotices: new Set(), editorSuggestions: new Map() };
}
function setNoticeShelf(state: UiState, incoming: readonly NoticeView[]): UiState {
  const shelf = new Map<string, NoticeView>();
  for (const notice of incoming) {
    if (notice.workspaceId && notice.workspaceId !== state.workspace?.id) continue;
    if (parseCursor(notice.id)?.bootId !== state.bootId) continue;
    if (!shelf.has(notice.id)) shelf.set(notice.id, state.noticeShelf.get(notice.id) ?? notice);
  }
  const noticeShelf = new Map([...shelf].slice(-32));
  const readNotices = new Set([...state.readNotices].filter(id => noticeShelf.has(id)));
  const notices = [...noticeShelf.values()].filter(notice => !state.dismissedNotices.has(notice.id));
  return { ...state, noticeShelf, readNotices, notices };
}
function appendEventNotice(state: UiState, event: UiEvent, value: EventData['notice']): UiState {
  if (!event.id || state.noticeShelf.has(event.id) || state.dismissedNotices.has(event.id)) return state;
  const notice: NoticeView = { ...value, id: event.id, target: event.target, workspaceId: event.workspaceId };
  return setNoticeShelf(state, [...state.noticeShelf.values(), notice]);
}
function restoreSnapshotNotices(state: UiState, previous: UiState, snapshot: Snapshot): UiState {
  const sameBoot = previous.bootId === snapshot.bootId;
  const base = sameBoot ? state : { ...state, noticeShelf: new Map<string, NoticeView>(),
    dismissedNotices: new Set<string>(), readNotices: new Set<string>(), notices: [] };
  if (sameBoot && snapshot.omitted?.includes('notices')) return base;
  return setNoticeShelf(base, snapshot.notices ?? []);
}
/** Dismissal is local presentation state, not a backend deletion or work cancellation. */
export function dismissNotice(state: UiState, id: string): UiState {
  if (!state.noticeShelf.has(id) || state.dismissedNotices.has(id)) return state;
  const dismissedNotices = new Set([...state.dismissedNotices, id].slice(-32));
  return { ...state, dismissedNotices, notices: state.notices.filter(notice => notice.id !== id) };
}
export function markReadNotices(state: UiState): UiState {
  if (!unreadNotices(state)) return state;
  const readNotices = new Set([...state.readNotices, ...state.notices.map(notice => notice.id)]);
  return { ...state, readNotices };
}
export function unreadNotices(state: UiState): number {
  return state.notices.filter(notice => !state.readNotices.has(notice.id)).length;
}
export function mergeRosterPage(state: UiState, page: CachedRoster): UiState {
  const roster = new Map(state.roster); const rosterOrder = state.rosterOrder.slice();
  for (const row of page.rows) {
    const previous = roster.get(row.identity);
    if (!previous) rosterOrder.push(row.identity);
    roster.set(row.identity, previous && JSON.stringify(previous) === JSON.stringify(row) ? previous : row);
  }
  return { ...state, roster, rosterOrder, rosterMeta: { observedAt: page.observedAt, scan: page.scan,
    stale: page.stale, error: page.error, nextCursor: page.nextCursor === undefined ? state.rosterMeta?.nextCursor : page.nextCursor } };
}
export function parseCursor(cursor: string): { bootId: string; sequence: number } | null {
  const match = /^([^:]+):(0|[1-9]\d*)$/.exec(cursor);
  if (!match) return null;
  const sequence = Number(match[2]);
  return Number.isSafeInteger(sequence) ? { bootId: match[1] ?? '', sequence } : null;
}
function emptyConversation(target: Target): Conversation {
  return { target, entries: new Map(), entryOrder: [], messages: new Map(), messageOrder: [], tools: new Map(), live: [], messageBlocks: new Map() };
}
function updateConversation(state: UiState, target: Target, update: (value: Conversation) => Conversation): UiState {
  const key = targetIdentity(target);
  const old = state.conversations.get(key) ?? emptyConversation(target);
  const value = update(old);
  if (old === value) return state;
  const conversations = new Map(state.conversations);
  conversations.set(key, value);
  return { ...state, conversations };
}
function mergeEntries(conversation: Conversation, incoming: EntryView[], prepend: boolean): Conversation {
  let entries: Map<string, EntryView> | undefined;
  const added: string[] = [];
  for (const entry of incoming) {
    const previous = (entries ?? conversation.entries).get(entry.id);
    if (previous === entry || previous && JSON.stringify(previous) === JSON.stringify(entry)) continue;
    entries ??= new Map(conversation.entries);
    if (!previous) added.push(entry.id); entries.set(entry.id, entry);
  }
  if (!entries) return conversation;
  const entryOrder = !added.length ? conversation.entryOrder : prepend ? [...added, ...conversation.entryOrder] : [...conversation.entryOrder, ...added];
  return { ...conversation, entries, entryOrder, live: reconcileLiveEntries(entries, conversation.live, conversation.live) };
}
function primaryCurrent(state: UiState, target: Target): boolean {
  return target.kind === 'primary' && state.primaries.get(target.key)?.epoch === target.epoch;
}
export function mergePrimaryPage(state: UiState, target: Target, entries: EntryView[], page?: {nextCursor: string | null; earlier: boolean}): UiState {
  if (!primaryCurrent(state, target)) return state;
  return updateConversation(state, target, value => {
    const retained = reconcileRetainedPage(value, state.primaries.get(target.kind === 'primary' ? target.key : ''), entries);
    const merged = mergeEntries(retained, entries, true);
    return page && (page.earlier || entries.length > 0 && retained.historyCursor === undefined) ? {...merged, historyCursor: page.nextCursor} : merged;
  });
}
export function mergeAgentPage(state: UiState, identity: string, entries: EntryView[]): UiState {
  return updateConversation(state, { kind: 'agent', identity }, value => mergeEntries(value, entries, true));
}
function calls(parts: PartView[]): Set<string> {
  const result = new Set<string>();
  for (const part of parts) {
    if (part.type === 'toolCall' || part.type === 'toolResult') result.add(part.callId);
    if (part.type === 'toolResult') for (const id of calls(part.parts)) result.add(id);
  }
  return result;
}
const messageCallKeys = new WeakMap<MessageView, Set<string>>();
function messageCalls(message: MessageView): Set<string> {
  let value = messageCallKeys.get(message);
  if (!value) { value = calls(message.parts); messageCallKeys.set(message, value); }
  return value;
}
function entryCalls(entry: EntryView): Set<string> {
  const result = new Set<string>();
  for (const message of entry.messages ?? []) for (const id of messageCalls(message)) result.add(id);
  return result;
}
interface CommittedKeys {messages: Set<string>; calls: Set<string>; order?: string[]; ordered?: EntryView[]}
const committedKeys = new WeakMap<ReadonlyMap<string, EntryView>, CommittedKeys>();
const blockViews = new WeakMap<Conversation, EntryView[]>();
function committed(entries: ReadonlyMap<string, EntryView>): CommittedKeys {
  let value = committedKeys.get(entries); if (value) return value;
  value = {messages: new Set(), calls: new Set()};
  for (const entry of entries.values()) {
    for (const message of entry.messages ?? []) value.messages.add(message.id);
    for (const call of entryCalls(entry)) value.calls.add(call);
  }
  committedKeys.set(entries, value); return value;
}
function representedMessage(message: MessageView, messageIds: Set<string>, callIds: Set<string>): boolean {
  if (messageIds.has(message.id)) return true;
  if (message.parts.some(part => part.type === 'text' || part.type === 'thinking')) return false;
  const ids = messageCalls(message);
  return ids.size > 0 && [...ids].every(id => callIds.has(id));
}
function reconcileLiveEntries(entries: ReadonlyMap<string, EntryView>, live: EntryView[], previous: EntryView[]): EntryView[] {
  const {messages: messageIds, calls: callIds} = committed(entries);
  const old = new Map(previous.map(entry => [entry.id, entry]));
  const result: EntryView[] = [];
  for (const entry of live) {
    if (entries.has(entry.id)) continue;
    const messages = entry.messages?.filter(message => !representedMessage(message, messageIds, callIds));
    if (entry.messages?.length && !messages?.length) continue;
    const value = messages?.length === entry.messages?.length ? entry : { ...entry, messages };
    const retained = old.get(entry.id);
    result.push(retained && JSON.stringify(retained) === JSON.stringify(value) ? retained : value);
  }
  return result;
}
/** Committed message/call keys remove matching temporary projections without comparing prose. */
export function conversationBlocks(conversation: Conversation): EntryView[] {
  const cached = blockViews.get(conversation); if (cached) return cached;
  const keys = committed(conversation.entries);
  if (keys.order !== conversation.entryOrder) {
    keys.order = conversation.entryOrder; keys.ordered = conversation.entryOrder.flatMap(id => {
      const entry = conversation.entries.get(id); return entry ? [entry] : [];
    });
  }
  const entries = keys.ordered ?? []; const messageIds = keys.messages; const callIds = keys.calls;
  const ordinaryCalls = new Set([...conversation.messages.values()].filter(message => !message.id.startsWith('tool:')).flatMap(message => [...messageCalls(message)]));
  const standalone = conversation.messageOrder.flatMap(id => {
    const message = conversation.messages.get(id);
    const block = conversation.messageBlocks.get(id);
    const duplicateTool = id.startsWith('tool:') && message && [...messageCalls(message)].some(call => ordinaryCalls.has(call) || callIds.has(call));
    return block && !messageIds.has(id) && !duplicateTool ? [block] : [];
  });
  const blocks = [...entries, ...standalone, ...conversation.live]; blockViews.set(conversation, blocks); return blocks;
}
export function primaryBlocks(state: UiState, key: string): EntryView[] {
  const primary = state.primaries.get(key);
  const conversation = primary && state.conversations.get(targetIdentity({ kind: 'primary', key, epoch: primary.epoch }));
  return conversation ? conversationBlocks(conversation) : [];
}
export function visibleTargets(workspace: Workspace, primary?: Target): Target[] {
  return paneLeaves(workspaceLayout(workspace).root).flatMap(pane => {
    const tab = pane.tabs.find(tab => tabKey(tab) === pane.active);
    return !tab ? [] : tab.kind === 'agent' ? [{kind: 'agent' as const, identity: tab.identity}] : primary ? [primary] : [];
  });
}
export function agentBlocks(state: UiState, identity: string): EntryView[] {
  const conversation = state.conversations.get(targetIdentity({kind: 'agent', identity}));
  return conversation ? conversationBlocks(conversation) : [];
}
function visibleAgent(state: UiState, identity: string): boolean {
  return !!state.workspace && visibleTargets(state.workspace).some(target => target.kind === 'agent' && target.identity === identity);
}
function admitAgentEpoch(state: UiState, identity: string, epoch: number): UiState | undefined {
  if (!visibleAgent(state, identity) || !Number.isSafeInteger(epoch) || epoch <= 0 || epoch < (state.agentEpochs.get(identity) ?? 0)) return;
  if (epoch === state.agentEpochs.get(identity)) return state.conversations.get(targetIdentity({kind: 'agent', identity}))?.connectionEpoch === epoch ? state : undefined;
  const agentEpochs = new Map(state.agentEpochs).set(identity, epoch);
  const agentAvailability = new Map(state.agentAvailability); agentAvailability.delete(identity);
  return updateConversation({...state, agentEpochs, agentAvailability}, {kind: 'agent', identity}, old => ({...old, tools:new Map(),live: [], frame: undefined, connectionEpoch: epoch}));
}
function applyFrame(state: UiState, identity: string, connectionEpoch: number, frame: ProjectedFrame): UiState {
  if (!Number.isSafeInteger(frame.revision) || frame.revision < 0 || frame.attachmentRevision !== undefined && (!Number.isSafeInteger(frame.attachmentRevision) || frame.attachmentRevision < 0)) return state;
  const next = admitAgentEpoch(state, identity, connectionEpoch); if (!next) return state;
  const old = next.conversations.get(targetIdentity({kind: 'agent', identity}));
  if (old?.frame && (frame.revision < old.frame.revision || frame.revision === old.frame.revision && (frame.attachmentRevision ?? 0) <= (old.frame.attachmentRevision ?? 0))) return next;
  return updateConversation(next, {kind: 'agent', identity}, old => {
    const merged = mergeEntries(old, frame.entries, false);
    const tools = new Map<string,ToolState>((frame.status.tools ?? []).map(tool=>[tool.callId,{callId:tool.callId,name:tool.name,phase:'update',nativeStatus:tool.status}]));
    return {...merged, tools,live: reconcileLiveEntries(merged.entries, frame.live, old.live), frame, connectionEpoch};
  });
}
function releaseInvisibleAgents(state: UiState): UiState {
  const visible = new Set(state.workspace ? visibleTargets(state.workspace).flatMap(target => target.kind === 'agent' ? [target.identity] : []) : []);
  let next = state;
  for (const conversation of state.conversations.values()) {
    const target = conversation.target;
    if (target.kind !== 'agent' || visible.has(target.identity) || conversation.connectionEpoch === undefined) continue;
    next = updateConversation(next, target, old => ({...old, tools:new Map(),live: [], frame: undefined, connectionEpoch: undefined}));
    const agentAvailability = new Map(next.agentAvailability); agentAvailability.delete(target.identity); next = {...next, agentAvailability};
  }
  return next;
}
function discardTransient(state: UiState): UiState {
  const conversations = new Map(state.conversations);
  for (const [key, value] of conversations) {
    const messages = new Map([...value.messages].filter(([, message]) => message.state === 'final'));
    const messageOrder = value.messageOrder.filter(id => messages.has(id));
    const messageBlocks = new Map([...value.messageBlocks].filter(([id]) => messages.has(id)));
    conversations.set(key, { ...value, messages, messageOrder, messageBlocks, tools: new Map(), live: [], frame: undefined });
  }
  return { ...state, conversations };
}
function snapshotTargets(state: UiState, snapshot: Snapshot): ReadonlyMap<string, TargetState> {
  const targets = new Map(state.targets);
  for (const target of snapshot.targets ?? []) {
    const old = targets.get(target.targetKey);
    if (!old) { targets.set(target.targetKey, target); continue; }
    targets.set(target.targetKey, { ...target,
      draft: old && old.draft.revision > target.draft.revision ? old.draft : target.draft,
      reading: old && old.reading.revision > target.reading.revision ? old.reading : target.reading,
      presentation: (old.presentation?.revision ?? 0) > (target.presentation?.revision ?? 0) ? old.presentation : target.presentation });
  }
  return targets;
}
/** Pending baselines retain receipts already known in the same backend boot. */
function snapshotOperations(state: UiState, snapshot: Snapshot): ReadonlyMap<string, OperationView> {
  let operations: ReadonlyMap<string, OperationView> = state.bootId === snapshot.bootId ? state.operations : new Map();
  for (const incoming of snapshot.pendingOperations) operations = mergeOperationMap(operations, incoming);
  return operations;
}
function snapshotMetadata(snapshot: Snapshot): Pick<UiState, 'primaryIndex' | 'operationIndex' | 'omitted'> {
  return { primaryIndex: snapshot.primaryIndex ?? [], operationIndex: snapshot.operationIndex ?? [], omitted: snapshot.omitted ?? [] };
}
function rosterEventsThroughCut(state: UiState, snapshot: Snapshot, buffered: UiEvent[], cut: number) {
  return buffered.flatMap(event => {
    if (event.name !== 'agent.roster') return [];
    const cursor = parseCursor(event.id ?? '');
    if (!cursor || cursor.bootId !== snapshot.bootId || cursor.sequence <= state.sequence || cursor.sequence > cut) return [];
    if (event.workspaceId && event.workspaceId !== snapshot.workspace.id) return [];
    return [{ event, sequence: cursor.sequence }];
  }).sort((a, b) => a.sequence - b.sequence);
}
function snapshotRoster(state: UiState, snapshot: Snapshot, buffered: UiEvent[], cut: number): Pick<UiState, 'roster' | 'rosterOrder' | 'rosterRevision' | 'rosterMeta'> {
  const omitted = snapshot.omitted?.includes('roster') ?? false;
  const partial = snapshot.roster.nextCursor != null || omitted;
  const retain = state.bootId === snapshot.bootId && partial;
  const rows = snapshot.roster.rows;
  const authoritative = new Set(rows.map(row => row.identity));
  const extras = new Set([...state.roster.keys()].filter(id => !authoritative.has(id)));
  let cached = retain ? state : { ...state, roster: new Map<string, AgentRow>(), rosterOrder: [], rosterRevision: -1, rosterMeta: undefined };
  if (retain) {
    let processed = state.sequence;
    for (const {event, sequence} of rosterEventsThroughCut(state, snapshot, buffered, cut)) {
      if (sequence <= processed) continue;
      processed = sequence;
      cached = applyRoster(cached, { ...event.data, changed: event.data.changed.filter(row => extras.has(row.identity)),
        removed: event.data.removed.filter(id => extras.has(id)) });
    }
  }
  const merged = mergeRosterPage(cached, { ...snapshot.roster, rows });
  return { roster: merged.roster, rosterOrder: merged.rosterOrder, rosterRevision: merged.rosterRevision,
    rosterMeta: retain && omitted ? cached.rosterMeta : merged.rosterMeta };
}
function historyContinues(old:Conversation,items:EntryView[]):boolean {
  const entries=old.retainedEntries??old.entries,leaf=old.retainedEntries?[...entries.keys()].at(-1):old.entryOrder.at(-1);
  return !!leaf&&items.some(item=>item.id===leaf)&&!items.some(item=>['compaction','branch_summary'].includes(item.kind)&&JSON.stringify(entries.get(item.id))!==JSON.stringify(item));
}
function reconcileRetainedPage(old:Conversation,primary:PrimaryView|undefined,items:EntryView[]):Conversation {
  const retained=old.retainedSession;if(!retained) return old;
  if(primary?.sessionId!==retained.id||primary.sessionFile!==retained.file) return emptyConversation(old.target);
  if(primary.lifecycle==='stopped'&&!items.length) return old;
  const current={...old,retainedSession:undefined,retainedEntries:undefined};
  if(historyContinues(old,items)) return current;
  const entries=new Map([...old.entries].filter(([id,value])=>old.retainedEntries&&old.retainedEntries.get(id)!==value));
  return {...current,entries,entryOrder:old.entryOrder.filter(id=>entries.has(id)),historyCursor:undefined};
}
function currentRetainedConversations(conversations:ReadonlyMap<string,Conversation>,primaries:ReadonlyMap<string,PrimaryView>):ReadonlyMap<string,Conversation> {
  let changed:Map<string,Conversation>|undefined;
  for(const [key,value] of conversations) {
    const retained=value.retainedSession;if(!retained) continue;
    const target=value.target,current=target.kind==='primary'?primaries.get(target.key):undefined;
    if(target.kind==='primary'&&current?.epoch===target.epoch&&current.sessionId===retained.id&&current.sessionFile===retained.file) continue;
    changed??=new Map(conversations);changed.delete(key);
  }
  return changed??conversations;
}
/** A stopped exact session keeps observed blocks, never old execution, cursors or transport authority. */
function stoppedPrimaryConversations(state:UiState,snapshot:Snapshot):ReadonlyMap<string,Conversation> {
  const retained=new Map<string,Conversation>();if(state.workspace?.id!==snapshot.workspace.id) return retained;
  for(const current of snapshot.primaries) {
    const previous=state.primaries.get(current.key);
    if(current.lifecycle!=='stopped'||!previous?.sessionId||!previous.sessionFile||previous.epoch!==current.epoch||previous.sessionId!==current.sessionId||previous.sessionFile!==current.sessionFile) continue;
    const target:Target={kind:'primary',key:current.key,epoch:current.epoch},blocks=primaryBlocks(state,current.key);
    if(!blocks.length) continue;
    const entries=new Map(blocks.map(entry=>[entry.id,entry]));
    retained.set(targetIdentity(target),{...emptyConversation(target),entries,entryOrder:blocks.map(entry=>entry.id),retainedSession:{id:previous.sessionId,file:previous.sessionFile},retainedEntries:entries});
  }
  return retained;
}
/** Keep cached primary pages only when the current history still contains their known leaf. */
function retainedPrimaryHistory(state: UiState, snapshot: Snapshot, target: Target, old: Conversation, items: EntryView[]): Conversation {
  const empty = emptyConversation(target);
  if (target.kind !== 'primary') return empty;
  const previous = state.primaries.get(target.key); const current = snapshot.primaries.find(item => item.key === target.key);
  if (!previous?.sessionId || !previous.sessionFile || previous.epoch !== target.epoch || current?.epoch !== target.epoch || previous.sessionId !== current.sessionId || previous.sessionFile !== current.sessionFile) return empty;
  if(old.retainedSession&&current.lifecycle==='stopped'&&!items.length) return old;
  if(state.bootId!==snapshot.bootId||!historyContinues(old,items)) return empty;
  return {...empty, entries: old.entries, entryOrder: old.entryOrder, historyCursor: old.historyCursor};
}
type ToolResult = Extract<PartView, {type: 'toolResult'}>;
function snapshotToolResults(items: EntryView[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  const collect = (parts: PartView[]) => {for (const part of parts) if (part.type === 'toolResult') {results.set(part.callId, part); collect(part.parts);}};
  for (const entry of items) for (const message of entry.messages ?? []) if (message.state === 'final') collect(message.parts);
  return results;
}
/** Final snapshot content owns result and status; only matching completed timing can supplement it. */
function snapshotToolTiming(tool: ToolState, result: ToolResult): ToolState | undefined {
  if (tool.phase !== 'end' || tool.durationMs === undefined || tool.name !== result.name || !!tool.isError !== result.isError) return;
  if (tool.parts !== undefined && JSON.stringify(tool.parts) !== JSON.stringify(result.parts) ||
    tool.output !== undefined && JSON.stringify(tool.output) !== JSON.stringify(result.output)) return;
  return {callId: result.callId, name: result.name, phase: 'end', durationMs: tool.durationMs, isError: result.isError};
}
/** History snapshots omit event-only tool metadata; matching unfinished calls retain observed state within one session. */
function retainedPrimaryTools(state: UiState, snapshot: Snapshot, target: Target, old: Conversation, items: EntryView[]): ReadonlyMap<string, ToolState> {
  if (target.kind !== 'primary' || state.bootId !== snapshot.bootId) return new Map();
  const previous = state.primaries.get(target.key); const current = snapshot.primaries.find(item => item.key === target.key);
  if (!previous?.sessionId || previous.epoch !== target.epoch || current?.epoch !== target.epoch || previous.sessionId !== current.sessionId || previous.sessionFile !== current.sessionFile) return new Map();
  if (items.some(item => ['compaction', 'branch_summary'].includes(item.kind) && JSON.stringify(old.entries.get(item.id)) !== JSON.stringify(item))) return new Map();
  const represented = new Set(items.flatMap(item => [...entryCalls(item)]));
  const results = snapshotToolResults(items), retained = new Map<string, ToolState>();
  const observed = [...old.tools].filter(([id, tool]) => represented.has(id) && (tool.phase === 'end' || current.activity === 'running' || current.activity === 'retrying'));
  for (const [id, tool] of observed) {
    const result = results.get(id), value = result ? snapshotToolTiming(tool, result) : tool;
    if (value) retained.set(id, value);
  }
  return retained;
}
function restoreSnapshotConversations(next: UiState, state: UiState, snapshot: Snapshot): UiState {
  for (const primary of snapshot.primaries) {
    const target: Target = { kind: 'primary', key: primary.key, epoch: primary.epoch };
    next = { ...next, dialogs: reconcileDialogs(expirePrimaryDialogs(next.dialogs, primary.key, primary.epoch), target, primary.pendingDialogs) };
  }
  if (state.bootId !== snapshot.bootId) next = discardTransient(next);
  const page = snapshot.selectedPage;
  if (page) {
    const items = 'items' in page ? page.items : page.entries;
    next = updateConversation(next, page.target, old => ({...mergeEntries(retainedPrimaryHistory(state, snapshot, page.target, old, items), items, false), tools: retainedPrimaryTools(state, snapshot, page.target, old, items)}));
  }
  for (const observation of snapshot.observations ?? []) {
    const availability = observation.availability;
    if (availability?.identity === observation.identity && availability.connectionEpoch === observation.connectionEpoch) next = applyAgentAvailability(next,availability);
    if (observation.frame) next = applyFrame(next, observation.identity, observation.connectionEpoch, observation.frame);
    else if (observation.connectionEpoch > 0) next = admitAgentEpoch(next, observation.identity, observation.connectionEpoch) ?? next;
  }
  return next;
}
export function replaceSnapshot(state: UiState, snapshot: Snapshot, buffered: UiEvent[] = []): UiState {
  const cursor = parseCursor(snapshot.cursor);
  if (!cursor || cursor.bootId !== snapshot.bootId) return { ...state, needsResync: true, resyncReason: 'invalid-snapshot' };
  if (state.bootId === snapshot.bootId && cursor.sequence < state.sequence) return state;
  const primaries = new Map(snapshot.primaries.map(primary => [primary.key, primary]));
  const sameWorkspace = state.bootId === snapshot.bootId && state.workspace?.id === snapshot.workspace.id;
  let next: UiState = { ...state, bootId: snapshot.bootId, cursor: snapshot.cursor, sequence: cursor.sequence,
    needsResync: false, resyncReason: undefined, workspace: snapshot.workspace, primaries,
    ...snapshotMetadata(snapshot), ...snapshotRoster(state, snapshot, buffered, cursor.sequence),
    operations: snapshotOperations(state, snapshot),
    targetIndex: new Map(snapshot.targetIndex?.map(target => [target.targetKey, target]) ?? []),
    agentEpochs: sameWorkspace ? state.agentEpochs : new Map(), agentAvailability: sameWorkspace ? state.agentAvailability : new Map(),
    conversations: sameWorkspace ? currentRetainedConversations(state.conversations,primaries) : stoppedPrimaryConversations(state,snapshot), targets: sameWorkspace ? state.targets : new Map() };
  next = releaseInvisibleAgents(next);
  next = restoreSnapshotNotices(next, state, snapshot);
  next = { ...next, targets: snapshotTargets(next, snapshot) };
  next = restoreSnapshotConversations(next, state, snapshot);
  for (const event of buffered) next = reduceEvent(next, event);
  return next;
}
function addToolResult(parts: PartView[], tool: ToolState): void {
  if (!tool.parts) return;
  const result: PartView = { type: 'toolResult', callId: tool.callId, name: tool.name, parts: tool.parts, isError: tool.isError ?? false,
    ...(tool.output !== undefined ? { output: tool.output } : {}) };
  const index = parts.findIndex(item => item.type === 'toolResult' && item.callId === tool.callId);
  if (index < 0) parts.push(result); else parts[index] = result;
}
function messageBlock(message: MessageView, tools: ReadonlyMap<string, ToolState>): EntryView {
  let parts = message.parts;
  for (const part of message.parts) {
    if (part.type !== 'toolCall') continue;
    const tool = tools.get(part.callId);
    if (!tool) continue;
    if (parts === message.parts) parts = parts.slice();
    const callIndex = parts.indexOf(part);
    if (tool.arguments) parts[callIndex] = { ...part, arguments: tool.arguments };
    addToolResult(parts, tool);
  }
  return { id: `message:${message.id}`, kind: 'message', messages: [parts === message.parts ? message : { ...message, parts }] };
}
function applyMessage(conversation: Conversation, message: MessageView): Conversation {
  const messages = new Map(conversation.messages); messages.set(message.id, message);
  const tools = new Map(conversation.tools);
  for (const part of message.parts) {
    if (part.type === 'toolCall') tools.set(part.callId, { ...tools.get(part.callId), callId: part.callId,
      name: part.name, arguments: part.arguments, phase: tools.get(part.callId)?.phase ?? 'start' });
    if (part.type === 'toolResult') tools.set(part.callId, { ...tools.get(part.callId), callId: part.callId,
      name: part.name, parts: part.parts, isError: part.isError, output: part.output, phase: message.state === 'final' ? 'end' : 'update' });
  }
  const messageBlocks = new Map(conversation.messageBlocks); messageBlocks.set(message.id, messageBlock(message, tools));
  return { ...conversation, messages, tools, messageBlocks,
    messageOrder: conversation.messages.has(message.id) ? conversation.messageOrder : [...conversation.messageOrder, message.id] };
}
function applyTool(conversation: Conversation, event: EventData['primary.tool']): Conversation {
  const previous = conversation.tools.get(event.callId);
  const tool: ToolState = { ...previous, ...event,
    observedStart: event.phase === 'start' ? previous?.phase === 'end' ? Date.now() : previous?.observedStart ?? Date.now() : previous?.observedStart };
  const tools = new Map(conversation.tools); tools.set(tool.callId, tool);
  let next: Conversation = { ...conversation, tools };
  let matches = [...conversation.messages.values()].filter(message => messageCalls(message).has(tool.callId));
  if (!matches.length) {
    const message: MessageView = { id: `tool:${tool.callId}`, role: 'tool', state: tool.phase === 'end' ? 'final' : 'partial',
      parts: [{ type: 'toolCall', callId: tool.callId, name: tool.name, arguments: tool.arguments ?? { value: {}, truncated: false } }],
      coverage: { complete: true, truncated: false, omitted: 0 } };
    next = applyMessage(next, message); matches = [message];
  }
  const messageBlocks = new Map(next.messageBlocks);
  const messages = new Map(next.messages);
  for (const message of matches) {
    const value = message.id === `tool:${tool.callId}` ? { ...message, state: tool.phase === 'end' ? 'final' as const : 'partial' as const } : message;
    messages.set(value.id, value); messageBlocks.set(value.id, messageBlock(value, tools));
  }
  return { ...next, messages, messageBlocks, tools };
}
function applyArgumentDelta(conversation: Conversation, message: MessageView, parts: PartView[], delta: EventData['primary.delta']): Conversation {
  if (!delta.callId) return conversation;
  const tool = conversation.tools.get(delta.callId);
  const tools = new Map(conversation.tools);
  const argumentText = (tool?.argumentText ?? '') + delta.delta;
  const name = delta.toolName ?? tool?.name ?? '';
  tools.set(delta.callId, { ...tool, callId: delta.callId, name, phase: tool?.phase ?? 'start', argumentText });
  parts[delta.index] = { type: 'toolCall', callId: delta.callId, name, arguments: { value: argumentText, truncated: false } };
  const next = applyMessage({ ...conversation, tools }, { ...message, parts });
  return { ...next, tools };
}
function applyDelta(conversation: Conversation, delta: EventData['primary.delta']): Conversation {
  if (!Number.isSafeInteger(delta.index) || delta.index < 0 || delta.index > 2048) return conversation;
  const old = conversation.messages.get(delta.messageId);
  if (old?.state === 'final') return conversation;
  const message: MessageView = old ?? { id: delta.messageId, role: 'assistant', state: 'partial', parts: [],
    coverage: { complete: true, truncated: false, omitted: 0 } };
  const parts = message.parts.slice();
  while (parts.length <= delta.index) parts.push({ type: 'omitted', label: 'Content has not arrived yet.' });
  const part = parts[delta.index] ?? { type: 'omitted' as const, label: 'Content has not arrived yet.' };
  if (delta.kind === 'toolArguments') return applyArgumentDelta(conversation, message, parts, delta);
  if (part.type !== 'omitted' && part.type !== delta.kind) return conversation;
  parts[delta.index] = { type: delta.kind, text: (part.type === delta.kind ? part.text : '') + delta.delta };
  return applyMessage(conversation, { ...message, parts });
}
function applyWorkspace(state: UiState, workspace: Workspace): UiState {
  if (state.workspace && (workspace.id !== state.workspace.id || workspace.revision <= state.workspace.revision)) return state;
  return releaseInvisibleAgents({...state, workspace});
}
function releaseChangedRetainedSession(state:UiState,previous:PrimaryView|undefined,current:PrimaryView):UiState {
  if(!previous) return state;
  const key=targetIdentity({kind:'primary',key:previous.key,epoch:previous.epoch}),retained=state.conversations.get(key)?.retainedSession;
  if(!retained||previous.epoch===current.epoch&&retained.id===current.sessionId&&retained.file===current.sessionFile) return state;
  const conversations=new Map(state.conversations);conversations.delete(key);return {...state,conversations};
}
function applyPrimaryEvent(state: UiState, event: UiEvent): UiState {
  if (event.name === 'primary.state') {
    const current = state.primaries.get(event.data.key);
    if (current && current.epoch > event.data.epoch) return state;
    const primaries = new Map(state.primaries); primaries.set(event.data.key, event.data);
    const target = { kind: 'primary' as const, key: event.data.key, epoch: event.data.epoch };
    const dialogs = reconcileDialogs(expirePrimaryDialogs(state.dialogs, target.key, target.epoch), target, event.data.pendingDialogs);
    return releaseChangedRetainedSession({ ...state, primaries, dialogs }, current, event.data);
  }
  if (!event.target || !primaryCurrent(state, event.target)) return state;
  const target = event.target;
  switch (event.name) {
    case 'primary.message': return updateConversation(state, target, value => applyMessage(value, event.data.message));
    case 'primary.delta': return updateConversation(state, target, value => applyDelta(value, event.data));
    case 'primary.tool': return updateConversation(state, target, value => applyTool(value, event.data));
    case 'primary.entry': return updateConversation(state, target, value => mergeEntries(value, [event.data.entry], false));
    case 'primary.queue': return updateConversation(state, target, value => ({ ...value, queue: event.data }));
    case 'primary.recovery': return updateConversation(state, target, value => ({ ...value, recovery: event.data }));
    default: return state;
  }
}
function applyRoster(state: UiState, data: EventData['agent.roster']): UiState {
  if (data.revision <= state.rosterRevision) return state;
  const roster = new Map(state.roster);
  const removed = new Set(data.removed);
  const rosterOrder = state.rosterOrder.filter(id => !removed.has(id));
  for (const id of removed) roster.delete(id);
  for (const row of data.changed) {
    if (!roster.has(row.identity)) rosterOrder.push(row.identity);
    roster.set(row.identity, row);
  }
  return { ...state, roster, rosterOrder, rosterRevision: data.revision,
    rosterMeta: { scan: data.scan, observedAt: data.observedAt, stale: data.stale, nextCursor: state.rosterMeta?.nextCursor } };
}
function applyAgentEvent(state: UiState, event: UiEvent): UiState {
  if (event.name === 'agent.frame') return applyFrame(state, event.data.identity, event.data.connectionEpoch, event.data.frame);
  if (event.name === 'agent.roster') return applyRoster(state, event.data);
  if (event.name !== 'agent.availability') return state;
  return applyAgentAvailability(state,event.data);
}
function applyAgentAvailability(state: UiState, data: EventData['agent.availability']): UiState {
  let next = admitAgentEpoch(state, data.identity, data.connectionEpoch); if (!next) return state;
  if (data.state !== 'live') next = updateConversation(next,{kind:'agent',identity:data.identity},old=>({...old,tools:new Map()}));
  const agentAvailability = new Map(next.agentAvailability).set(data.identity, data);
  const row = state.roster.get(data.identity);
  const roster = new Map(state.roster);
  if (row) roster.set(row.identity, { ...row, availability: data.state, capabilities: data.capabilities });
  return { ...next, roster, agentAvailability };
}
function applyTargetEvent(state: UiState, event: UiEvent): UiState {
  if (event.name !== 'draft.changed' && event.name !== 'reading.changed') return state;
  const old = state.targets.get(event.data.targetKey);
  if (!old) return state;
  const targets = new Map(state.targets);
  if (event.name === 'draft.changed' && event.data.draft.revision > old.draft.revision) {
    targets.set(old.targetKey, { ...old, draft: event.data.draft });
  } else if (event.name === 'reading.changed' && event.data.reading.revision > old.reading.revision) {
    targets.set(old.targetKey, { ...old, reading: event.data.reading });
  } else return state;
  return { ...state, targets };
}
function applyExtensionState(primary: PrimaryView, request: Exclude<EventData['extension.request'], { id: string }>): PrimaryView {
  const extension = { statuses: {}, widgets: {}, ...primary.extension };
  if (request.method === 'setStatus') {
    extension.statuses = { ...extension.statuses };
    if (request.statusText === undefined) delete extension.statuses[request.statusKey];
    else extension.statuses[request.statusKey] = request.statusText;
  }
  if (request.method === 'setWidget') {
    extension.widgets = { ...extension.widgets };
    if (request.widgetLines === undefined) delete extension.widgets[request.widgetKey];
    else extension.widgets[request.widgetKey] = { lines: request.widgetLines, placement: request.widgetPlacement };
  }
  if (request.method === 'setTitle') extension.title = request.title;
  return { ...primary, extension };
}
function applyExtensionEvent(state: UiState, event: UiEvent): UiState {
  if (event.target?.kind !== 'primary' || !primaryCurrent(state, event.target)) return state;
  const target = event.target;
  if (event.name === 'extension.expired') return { ...state, dialogs: expireDialog(state.dialogs, target, event.data.id, event.data.reason) };
  if (event.name !== 'extension.request') return state;
  const request = event.data;
  if ('id' in request) return { ...state, dialogs: enqueueDialog(state.dialogs, target, request) };
  if (request.method === 'set_editor_text') {
    const editorSuggestions = new Map(state.editorSuggestions); editorSuggestions.set(targetIdentity(target), request.text);
    return { ...state, editorSuggestions };
  }
  if (request.method === 'notify') {
    const notice: EventData['notice'] = { level: request.notifyType === 'error' ? 'error' : request.notifyType === 'warning' ? 'warning' : 'info', message: request.message };
    return appendEventNotice(state, event, notice);
  }
  const primary = state.primaries.get(target.key);
  if (!primary) return state;
  const primaries = new Map(state.primaries); primaries.set(primary.key, applyExtensionState(primary, request));
  return { ...state, primaries };
}
function applyDataEvent(state: UiState, event: UiEvent): UiState {
  if (event.name.startsWith('primary.')) return applyPrimaryEvent(state, event);
  if (event.name.startsWith('agent.')) return applyAgentEvent(state, event);
  if (event.name.startsWith('extension.')) return applyExtensionEvent(state, event);
  if (event.name === 'workspace.changed') return applyWorkspace(state, event.data);
  if (event.name === 'operation.changed') return { ...state, operations: mergeOperationMap(state.operations, event.data) };
  if (event.name === 'notice') return appendEventNotice(state, event, event.data);
  return applyTargetEvent(state, event);
}
/** Control cursors are advisory. Filtered sequence gaps are valid journal order. */
export function reduceEvent(state: UiState, event: UiEvent): UiState {
  if (event.name === 'resync') return { ...state, needsResync: true, resyncReason: event.data.reason };
  if (event.name === 'ready') return state.bootId && event.data.bootId !== state.bootId ?
    { ...state, needsResync: true, resyncReason: 'boot-changed' } : state;
  const cursor = event.id ? parseCursor(event.id) : null;
  if (!cursor) return { ...state, needsResync: true, resyncReason: 'invalid-cursor' };
  if (state.bootId !== cursor.bootId) return { ...state, needsResync: true, resyncReason: 'boot-changed' };
  if (state.needsResync || cursor.sequence <= state.sequence) return state;
  const next: UiState = { ...state, cursor: event.id, sequence: cursor.sequence };
  if (event.workspaceId && event.workspaceId !== state.workspace?.id) return next;
  return applyDataEvent(next, event);
}
