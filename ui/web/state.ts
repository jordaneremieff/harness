import type {
  AgentRow, CachedRoster, EntryView, EventData, EventName, JsonDisplay, MessageView,
  PartView, PrimaryView, ProjectedFrame, Snapshot, Target, TargetState, Workspace, OperationView, TargetIndex, NoticeView,
} from '../shared/api.ts';
import { createDialogs, enqueueDialog, expireDialog, expirePrimaryDialogs, reconcileDialogs } from './dialog-state.ts';
import type { DialogState } from './dialog-state.ts';
import { mergeOperationMap } from './operation-state.ts';

export type UiEvent = { [N in EventName]: { name: N; id?: string; target?: Target; workspaceId?: string; data: EventData[N] } }[EventName];
export interface ToolState {
  callId: string; name: string; phase: 'start' | 'update' | 'end'; arguments?: JsonDisplay;
  argumentText?: string; parts?: PartView[]; isError?: boolean; durationMs?: number;
}
export interface Conversation {
  target: Target; entries: ReadonlyMap<string, EntryView>; entryOrder: string[];
  messages: ReadonlyMap<string, MessageView>; messageOrder: string[];
  tools: ReadonlyMap<string, ToolState>; live: EntryView[]; messageBlocks: ReadonlyMap<string, EntryView>;
  queue?: EventData['primary.queue']; recovery?: EventData['primary.recovery']; frame?: ProjectedFrame;
}
export interface UiState {
  bootId?: string; cursor?: string; sequence: number; needsResync: boolean; resyncReason?: string;
  workspace?: Workspace; primaries: ReadonlyMap<string, PrimaryView>;
  conversations: ReadonlyMap<string, Conversation>; roster: ReadonlyMap<string, AgentRow>;
  rosterOrder: string[]; rosterRevision: number; rosterMeta?: Omit<CachedRoster, 'rows'>;
  targets: ReadonlyMap<string, TargetState>; targetIndex: ReadonlyMap<string, TargetIndex>; dialogs: DialogState;
  operations: ReadonlyMap<string, OperationView>;
  primaryIndex: NonNullable<Snapshot['primaryIndex']>; operationIndex: string[]; omitted: NonNullable<Snapshot['omitted']>;
  selectedAgent?: { identity: string; connectionEpoch: number; revision: number };
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
  const entries = new Map(conversation.entries);
  const added: string[] = [];
  for (const entry of incoming) {
    if (!entries.has(entry.id)) added.push(entry.id);
    const previous = entries.get(entry.id);
    entries.set(entry.id, previous && JSON.stringify(previous) === JSON.stringify(entry) ? previous : entry);
  }
  const entryOrder = prepend ? [...added, ...conversation.entryOrder] : [...conversation.entryOrder, ...added];
  return { ...conversation, entries, entryOrder, live: reconcileLiveEntries(entries, conversation.live, conversation.live) };
}
function primaryCurrent(state: UiState, target: Target): boolean {
  return target.kind === 'primary' && state.primaries.get(target.key)?.epoch === target.epoch;
}
export function mergePrimaryPage(state: UiState, target: Target, entries: EntryView[]): UiState {
  if (!primaryCurrent(state, target)) return state;
  return updateConversation(state, target, value => mergeEntries(value, entries, true));
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
function entryCalls(entry: EntryView): Set<string> {
  const result = new Set<string>();
  for (const message of entry.messages ?? []) for (const id of calls(message.parts)) result.add(id);
  return result;
}
function representedMessage(message: MessageView, messageIds: Set<string>, callIds: Set<string>): boolean {
  if (messageIds.has(message.id)) return true;
  if (message.parts.some(part => part.type === 'text' || part.type === 'thinking')) return false;
  const ids = calls(message.parts);
  return ids.size > 0 && [...ids].every(id => callIds.has(id));
}
function reconcileLiveEntries(entries: ReadonlyMap<string, EntryView>, live: EntryView[], previous: EntryView[]): EntryView[] {
  const committed = [...entries.values()];
  const messageIds = new Set(committed.flatMap(entry => (entry.messages ?? []).map(message => message.id)));
  const callIds = new Set(committed.flatMap(entry => [...entryCalls(entry)]));
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
  const entries = conversation.entryOrder.flatMap(id => {
    const entry = conversation.entries.get(id); return entry ? [entry] : [];
  });
  const messageIds = new Set(entries.flatMap(entry => (entry.messages ?? []).map(message => message.id)));
  const callIds = new Set(entries.flatMap(entry => [...entryCalls(entry)]));
  const ordinaryCalls = new Set([...conversation.messages.values()].filter(message => !message.id.startsWith('tool:')).flatMap(message => [...calls(message.parts)]));
  const standalone = conversation.messageOrder.flatMap(id => {
    const message = conversation.messages.get(id);
    const block = conversation.messageBlocks.get(id);
    const duplicateTool = id.startsWith('tool:') && message && [...calls(message.parts)].some(call => ordinaryCalls.has(call) || callIds.has(call));
    return block && !messageIds.has(id) && !duplicateTool ? [block] : [];
  });
  return [...entries, ...standalone, ...conversation.live];
}
export function primaryBlocks(state: UiState, key: string): EntryView[] {
  const primary = state.primaries.get(key);
  const conversation = primary && state.conversations.get(targetIdentity({ kind: 'primary', key, epoch: primary.epoch }));
  return conversation ? conversationBlocks(conversation) : [];
}
export function agentBlocks(state: UiState): EntryView[] {
  const identity = state.selectedAgent?.identity;
  const conversation = identity && state.conversations.get(targetIdentity({ kind: 'agent', identity }));
  return conversation ? conversationBlocks(conversation) : [];
}
export function selectAgent(state: UiState, identity?: string): UiState {
  if (state.selectedAgent?.identity === identity) return state;
  let next = state;
  if (state.selectedAgent) next = updateConversation(next, { kind: 'agent', identity: state.selectedAgent.identity }, value => ({ ...value, live: [] }));
  return { ...next, agentAvailability: new Map(), selectedAgent: identity ? { identity, connectionEpoch: -1, revision: -1 } : undefined };
}
function selectedIdentity(workspace: Workspace): string | undefined {
  return workspace.panelVisible !== false && workspace.selectedTarget?.kind === 'agent' ? workspace.selectedTarget.identity : undefined;
}
function applyFrame(state: UiState, identity: string, connectionEpoch: number, frame: ProjectedFrame): UiState {
  const selected = state.selectedAgent;
  if (!selected || selected.identity !== identity || !Number.isSafeInteger(connectionEpoch) || connectionEpoch < 0) return state;
  const seenEpoch = state.agentEpochs.get(identity) ?? -1;
  if (connectionEpoch < seenEpoch || (selected.connectionEpoch < 0 && connectionEpoch <= seenEpoch)) return state;
  if (connectionEpoch === selected.connectionEpoch && frame.revision <= selected.revision) return state;
  if (!Number.isSafeInteger(frame.revision) || frame.revision < 0) return state;
  const next = updateConversation(state, { kind: 'agent', identity }, old => {
    const merged = mergeEntries(old, frame.entries, false);
    return { ...merged, live: reconcileLiveEntries(merged.entries, frame.live,
      connectionEpoch === selected.connectionEpoch ? old.live : []), frame };
  });
  const agentEpochs = new Map(next.agentEpochs);
  agentEpochs.set(identity, connectionEpoch);
  return { ...next, agentEpochs, selectedAgent: { identity, connectionEpoch, revision: frame.revision } };
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
function restoreSnapshotAgent(next: UiState, previous: UiState, snapshot: Snapshot): UiState {
  if (!next.selectedAgent || previous.bootId !== snapshot.bootId || previous.selectedAgent?.identity !== next.selectedAgent.identity) return next;
  return { ...next, selectedAgent: { identity: next.selectedAgent.identity,
    connectionEpoch: previous.selectedAgent.connectionEpoch, revision: snapshot.selectedFrame?.revision ?? -1 } };
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
  const rows = [...snapshot.roster.rows, ...(snapshot.selectedAgent ? [snapshot.selectedAgent] : [])];
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
export function replaceSnapshot(state: UiState, snapshot: Snapshot, buffered: UiEvent[] = []): UiState {
  const cursor = parseCursor(snapshot.cursor);
  if (!cursor || cursor.bootId !== snapshot.bootId) return { ...state, needsResync: true, resyncReason: 'invalid-snapshot' };
  if (state.bootId === snapshot.bootId && cursor.sequence < state.sequence) return state;
  const primaries = new Map(snapshot.primaries.map(primary => [primary.key, primary]));
  let next: UiState = { ...state, bootId: snapshot.bootId, cursor: snapshot.cursor, sequence: cursor.sequence,
    needsResync: false, resyncReason: undefined, workspace: snapshot.workspace, primaries,
    ...snapshotMetadata(snapshot), ...snapshotRoster(state, snapshot, buffered, cursor.sequence),
    operations: snapshotOperations(state, snapshot),
    targetIndex: new Map(snapshot.targetIndex?.map(target => [target.targetKey, target]) ?? []),
    agentEpochs: state.bootId === snapshot.bootId ? state.agentEpochs : new Map(), selectedAgent: undefined };
  next = restoreSnapshotNotices(next, state, snapshot);
  next = { ...next, targets: snapshotTargets(state, snapshot) };
  for (const primary of snapshot.primaries) {
    const target: Target = { kind: 'primary', key: primary.key, epoch: primary.epoch };
    next = { ...next, dialogs: reconcileDialogs(expirePrimaryDialogs(next.dialogs, primary.key, primary.epoch), target, primary.pendingDialogs) };
  }
  next = selectAgent(next, selectedIdentity(snapshot.workspace));
  next = restoreSnapshotAgent(next, state, snapshot);
  if (snapshot.selectedAgent?.capabilities) next = {...next, agentAvailability: new Map([[snapshot.selectedAgent.identity, {identity: snapshot.selectedAgent.identity, state: snapshot.selectedAgent.availability, capabilities: snapshot.selectedAgent.capabilities}]])};
  if (state.bootId !== snapshot.bootId) next = discardTransient(next);
  const page = snapshot.selectedPage;
  if (page) {
    const items = 'items' in page ? page.items : page.entries;
    next = updateConversation(next, page.target, () => mergeEntries(emptyConversation(page.target), items, false));
  }
  if (next.selectedAgent && snapshot.selectedFrame) {
    const identity = next.selectedAgent.identity;
    // Snapshot frames lack a connection epoch. Keep their baseline outside epoch ordering.
    next = updateConversation(next, { kind: 'agent', identity }, old => ({
      ...mergeEntries(old, snapshot.selectedFrame?.entries ?? [], false),
      live: reconcileLiveEntries(new Map(snapshot.selectedFrame?.entries.map(entry => [entry.id, entry]) ?? []), snapshot.selectedFrame?.live ?? [], old.live), frame: snapshot.selectedFrame,
    }));
  }
  for (const event of buffered) next = reduceEvent(next, event);
  return next;
}
function addToolResult(parts: PartView[], tool: ToolState): void {
  if (!tool.parts) return;
  const result: PartView = { type: 'toolResult', callId: tool.callId, name: tool.name, parts: tool.parts, isError: tool.isError ?? false };
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
      name: part.name, parts: part.parts, isError: part.isError, phase: message.state === 'final' ? 'end' : 'update' });
  }
  const messageBlocks = new Map(conversation.messageBlocks); messageBlocks.set(message.id, messageBlock(message, tools));
  return { ...conversation, messages, tools, messageBlocks,
    messageOrder: conversation.messages.has(message.id) ? conversation.messageOrder : [...conversation.messageOrder, message.id] };
}
function applyTool(conversation: Conversation, event: EventData['primary.tool']): Conversation {
  const tool: ToolState = { ...conversation.tools.get(event.callId), ...event };
  const tools = new Map(conversation.tools); tools.set(tool.callId, tool);
  let next: Conversation = { ...conversation, tools };
  let matches = [...conversation.messages.values()].filter(message => calls(message.parts).has(tool.callId));
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
  while (parts.length <= delta.index) parts.push({ type: 'omitted', label: 'Part not yet received' });
  const part = parts[delta.index] ?? { type: 'omitted' as const, label: 'Part not yet received' };
  if (delta.kind === 'toolArguments') return applyArgumentDelta(conversation, message, parts, delta);
  if (part.type !== 'omitted' && part.type !== delta.kind) return conversation;
  parts[delta.index] = { type: delta.kind, text: (part.type === delta.kind ? part.text : '') + delta.delta };
  return applyMessage(conversation, { ...message, parts });
}
function applyWorkspace(state: UiState, workspace: Workspace): UiState {
  if (state.workspace && (workspace.id !== state.workspace.id || workspace.revision <= state.workspace.revision)) return state;
  return selectAgent({ ...state, workspace }, selectedIdentity(workspace));
}
function applyPrimaryEvent(state: UiState, event: UiEvent): UiState {
  if (event.name === 'primary.state') {
    const current = state.primaries.get(event.data.key);
    if (current && current.epoch > event.data.epoch) return state;
    const primaries = new Map(state.primaries); primaries.set(event.data.key, event.data);
    const target = { kind: 'primary' as const, key: event.data.key, epoch: event.data.epoch };
    const dialogs = reconcileDialogs(expirePrimaryDialogs(state.dialogs, target.key, target.epoch), target, event.data.pendingDialogs);
    return { ...state, primaries, dialogs };
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
  const agentAvailability = new Map(state.agentAvailability).set(event.data.identity, event.data);
  const row = state.roster.get(event.data.identity);
  const roster = new Map(state.roster);
  if (row) roster.set(row.identity, { ...row, availability: event.data.state, capabilities: event.data.capabilities });
  return { ...state, roster, agentAvailability };
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
