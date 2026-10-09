import type { AgentHistoryPage, AgentRow, Bootstrap, DraftView, EventData, HistoryPage, OperationView, PrimaryView, ProjectedFrame, Snapshot, Target, TargetState, Workspace } from '../shared/api.ts';
import { Actions } from './actions.ts';
import { ProjectPicker } from './picker.ts';
import type { SelectionChange } from './actions.ts';
import { Composer } from './composer.ts';
import { ConnectionRecovery, connectionSurface as connectionSurfaceFor, type ConnectionPhase } from './connection-state.ts';
import { announce, byId, button, copy, details, element, empty, rawText, setText } from './dom.ts';
import { ExtensionDialogs, extensionStatus } from './extensions.ts';
import { Modal } from './modal.ts';
import { installIcons } from './icons.ts';
import { Transcript } from './render.ts';
import { historyBecameReady } from './transcript-history.ts';
import { Roster } from './roster.ts';
import { Recovery, exactInput } from './recovery.ts';
import { agentBlocks, conversationBlocks, createState, dismissNotice, markReadNotices, unreadNotices, mergeRosterPage, mergeAgentPage, mergePrimaryPage, primaryBlocks, reduceEvent, replaceSnapshot, targetIdentity } from './state.ts';
import type { UiEvent } from './state.ts';
import { hydrateVisible, refreshVisible } from './hydrate.ts';
import { SelectionQueue, navigationState, visibleReceipt } from './selection-state.ts';
import { usageSummary } from './usage.ts';
import { entryVisible } from './entry-presentation.ts';
import { primaryBusy, primaryActivityLabel, primaryEmpty } from './primary-presentation.ts';
import { inputOperation, operationLabel } from './operation-label.ts';
import { PreferenceQueue } from './preference-queue.ts';
import { renderFacts } from './facts.ts';
import { newerOperation, mergeOperationMap } from './operation-state.ts';
import { ApiError, authenticate, connect, errorMessage, operation, request } from './transport.ts';
import type { ReceivedEvent } from './transport.ts';

installIcons();
let state = createState();
let snapshot: Bootstrap | Snapshot | undefined;
let source: EventSource | undefined;
let connected = false;
let drawerOpen = false;
let connectionPhase: ConnectionPhase = 'healthy';
let connectionError: unknown;
let connectionSurface = '';
let streamWait: {resolve: () => void; reject: (error: unknown) => void} | undefined;
let resynchronizing: Promise<void> | undefined;
let historyAbort = new AbortController();
let primaryCursor: string | null = null;
let agentBefore: number | null = null;
let primaryEarlier: {target: string; controller: AbortController} | undefined;
let agentEarlier: {target: string; controller: AbortController} | undefined;
let primaryTargetKey = '';
let historyReadyTarget = '';
let agentTargetKey = '';
let hiddenPanel = false;
let selecting = false;
let reloadTail = Promise.resolve();
const snapshotBuffers = new Set<{events: UiEvent[]; bytes: number; overflow: boolean}>();
let observationStart: {identity: string; at: number} | undefined;
const modal = new Modal();
const preferences = new PreferenceQueue();
const primaryComposer: Composer = new Composer('primary', {submitted: showOperation, unknownCommand: (text, literal): boolean => actions.unknown(text, literal), commands: () => actions.commandOptions(), recover: recover});
const agentComposer = new Composer('agent', {submitted: showOperation, unknownCommand: () => false, recover: recover});
const primaryTranscript = new Transcript('primary', {presentation: (expanded, showThinking) => { void savePresentation(primaryComposer, expanded, showThinking); }, reading: reading => { void saveReading(primaryComposer, reading); }, fork: (message, entry) => actions.fork(entry, rawText(message.parts)), output: loadPrimaryOutput});
async function loadPrimaryOutput(more: import('../shared/api.ts').OutputContinuation): Promise<import('../shared/api.ts').OutputPage> {
  const captured = primary(); if (!captured) throw new Error('Primary history is unavailable.');
  const page = await request<import('../shared/api.ts').OutputPage>(`/api/primaries/${encodeURIComponent(captured.key)}/history/output?epoch=${captured.epoch}&entry=${encodeURIComponent(more.entryId)}&part=${more.part}&offset=${more.offset}`, 'GET', undefined, undefined, historyAbort.signal);
  if (primary()?.key !== captured.key || primary()?.epoch !== captured.epoch) throw new Error('The primary conversation changed.');
  return page;
}
const agentTranscript = new Transcript('agent', {presentation: (expanded, showThinking) => { void savePresentation(agentComposer, expanded, showThinking); }, reading: reading => { void saveReading(agentComposer, reading); }});
const actions: Actions = new Actions({snapshot: currentSnapshot, primary, composer: primaryComposer, modal, selection, reload, result: showOperation, rosterRefresh: refreshRoster, find: query => primaryTranscript.find(query), recovery: () => recovery.open(), primaryEntries: () => primary() ? primaryBlocks(state, primary()?.key ?? '') : []});
const picker = new ProjectPicker({snapshot: currentSnapshot, primary, modal, selection, reload});
actions.projectPicker = () => picker.open();
const recovery = new Recovery({snapshot: currentSnapshot, reload, modal});
const roster = new Roster(row => { void selectAgent(row).catch(showError); }, action => { if (action === 'refresh') refreshRoster(); else moreRoster(); }, {
  load: (cursor, signal) => request<import('../shared/api.ts').CachedRoster>(`/api/agents?limit=20&cursor=${encodeURIComponent(cursor)}`, 'GET', undefined, undefined, signal),
  merge: page => { state = mergeRosterPage(state, page); renderRoster(); },
});
const extensionDialogs = new ExtensionDialogs(modal, () => state, next => { state = next; }, primary);
const connectionRecovery = new ConnectionRecovery({attempt: resync, unauthorized: error => error instanceof ApiError && error.view.code === 'unauthorized', paint: (phase, error) => {
  connectionPhase = phase; connectionError = error; connected = phase === 'healthy'; renderConnection();
  if (connected) renderAll(); else renderAvailability();
}});
const selectionQueue = new SelectionQueue({current: () => state.workspace, reload, save: (workspace, change) => request<Workspace>(`/api/workspaces/${encodeURIComponent(workspace.id)}/selection`, 'PUT', {expectedRevision: workspace.revision, ...change}), paint: (workspace, pending) => { selecting = pending; state = {...state, workspace}; renderAll(); }});

function currentSnapshot(): Snapshot | undefined {
  return snapshot ? {...snapshot, workspace: state.workspace ?? snapshot.workspace, primaries: [...state.primaries.values()], primaryIndex: state.primaryIndex, targetIndex: [...state.targetIndex.values()]} : undefined;
}
function primary(): PrimaryView | undefined { return state.workspace?.primaryKey ? state.primaries.get(state.workspace.primaryKey) : undefined; }
function primaryTarget(): Target | undefined { const item = primary(); return item ? {kind: 'primary', key: item.key, epoch: item.epoch} : undefined; }
function agentRow(identity: string): AgentRow | undefined {
  const row = state.roster.get(identity); const availability = state.agentAvailability.get(identity);
  return row && availability ? {...row, availability: availability.state, capabilities: availability.capabilities} : row;
}
function selectedAgent(): string | undefined { return state.workspace?.selectedTarget?.kind === 'agent' ? state.workspace.selectedTarget.identity : undefined; }
function targetState(target?: Target): TargetState | undefined {
  if (!target) return undefined; const identity = targetIdentity(target);
  return [...state.targets.values()].find(item => targetIdentity(item.target) === identity);
}
function sameTarget(a?: Target, b?: Target): boolean { return !!a && !!b && targetIdentity(a) === targetIdentity(b); }
function selection(change: SelectionChange): Promise<void> {
  if (change.selectedTarget !== undefined) drawerOpen = false;
  if (change.sidebarVisible !== undefined && !matchMedia('(min-width: 900px)').matches) {
    drawerOpen = change.sidebarVisible; const {sidebarVisible: _visible, ...rest} = change; change = rest; renderNavigation(); roster.schedule();
    if (!Object.keys(change).length) return Promise.resolve();
  }
  historyAbort.abort(); historyAbort = new AbortController(); const startedAt = performance.now();
  const task = selectionQueue.select(change);
  requestAnimationFrame(() => performance.measure('ui:cached-target-switch', {start: startedAt, end: performance.now()})); return task;
}
function reload(): Promise<void> {
  const task = reloadTail.then(() => refreshVisible(refreshSnapshot, loadPrimaryHistory, showError)); reloadTail = task.catch(() => undefined); return task;
}
async function refreshSnapshot(): Promise<void> {
  if (!state.workspace) return;
  const before = state; const buffered = {events: [] as UiEvent[], bytes: 0, overflow: false}; snapshotBuffers.add(buffered);
  try {
    const current = await hydrateVisible(await request<Snapshot>(`/api/snapshot?workspace=${encodeURIComponent(state.workspace.id)}`));
    if (buffered.overflow) throw new Error('Current view changed too quickly during restore. Reconnect to request a fresh baseline.');
    snapshot = current; state = replaceSnapshot({...before, dismissedNotices: state.dismissedNotices, readNotices: state.readNotices}, current, buffered.events); if (state.workspace) state = {...state, workspace: selectionQueue.observe(state.workspace)}; renderAll();
  } finally { snapshotBuffers.delete(buffered); }
}
function stream(): Promise<void> {
  source?.close();
  if (!state.workspace || !state.cursor) return Promise.reject(new Error('No current workspace baseline.'));
  const ready = {resolve: () => {}, reject: (_error: unknown) => {}};
  const promise = new Promise<void>((resolve, reject) => { ready.resolve = resolve; ready.reject = reject; }); streamWait = ready;
  const current = connect(state.workspace.id, state.cursor, event => { if (source === current) receive(event); }, () => { if (source === current) disconnected(); });
  source = current;
  const timer = window.setTimeout(() => { if (source === current) disconnected(new Error('The event stream did not become ready.')); }, 15_000);
  return promise.finally(() => { window.clearTimeout(timer); if (streamWait === ready) streamWait = undefined; });
}
function disconnected(error: unknown = new Error('The event stream closed.')): void {
  source?.close(); connected = false; renderAvailability();
  if (streamWait) streamWait.reject(error);
  else connectionRecovery.lost(error);
}
function connectionDetails(): void {
  modal.open('Connection details').append(element('p', undefined, 'Last observed primary and agent state stays readable. Unsaved text stays in this tab. No input resends automatically.'));
  if (connectionError) modal.body.append(element('p', 'error', errorMessage(connectionError)));
}
function renderConnection(): void {
  const persistent = connectionPhase === 'offline' || connectionPhase === 'auth';
  const {owner, visible} = connectionSurfaceFor(connectionPhase, !byId('sidebar').hidden);
  const key = `${owner}/${connectionPhase}`; if (connectionSurface === key) return; connectionSurface = key;
  for (const id of ['connection', 'workspace-alert']) { byId(id).hidden = true; byId(id).replaceChildren(); }
  if (!visible) return;
  const node = byId(owner); node.hidden = false;
  if (connectionPhase === 'auth') node.append(element('span', undefined, 'Open the launch link from this Mac'), button('Retry', () => location.reload()), button('Details', connectionDetails));
  else if (persistent) node.append(element('span', undefined, 'Offline'), button('Reconnect', () => connectionRecovery.reconnect()), button('Details', connectionDetails));
  else setText(node, 'Reconnecting…');
}
async function resync(): Promise<void> {
  if (resynchronizing) return resynchronizing;
  source?.close(); connected = false; renderAvailability();
  resynchronizing = (async () => {
    try {
      if (state.workspace) await reload(); else await refreshVisible(bootstrap, loadPrimaryHistory, showError);
      await stream(); renderAll();
    } finally { resynchronizing = undefined; }
  })();
  return resynchronizing;
}
function receive(event: ReceivedEvent): void {
  const old = state;
  const reduced = {id: event.id, name: event.name, target: event.envelope.target, workspaceId: event.envelope.workspaceId, data: event.envelope.data} as UiEvent;
  for (const buffer of snapshotBuffers) {
    buffer.bytes += event.bytes ?? 512;
    if (buffer.bytes > 1_048_576 || buffer.events.length >= 256) buffer.overflow = true;
    if (!buffer.overflow) buffer.events.push(reduced);
  }
  const reducerStartedAt = performance.now(); state = reduceEvent(state, reduced);
  performance.measure('ui:reducer', {start: reducerStartedAt, end: performance.now()});
  if (state.needsResync) { disconnected(new Error('The event baseline needs a refresh.')); return; }
  if (event.name === 'workspace.changed' && state.workspace) state = {...state, workspace: selectionQueue.observe(state.workspace)};
  if (event.name === 'ready') { streamWait?.resolve(); return; }
  if (old === state) return;
  applyEvent(event);
  if (event.name === 'primary.state') {
    const current = event.envelope.data as PrimaryView; const previous = old.primaries.get(current.key);
    if (historyBecameReady(previous, current, state.workspace?.primaryKey)) { historyAbort.abort(); historyAbort = new AbortController(); void loadPrimaryHistory(); }
  }
}
function applyEvent(event: ReceivedEvent): void {
  const name = event.name;
  if (name === 'primary.delta' || name === 'primary.message' || name === 'primary.entry' || name === 'primary.tool') renderPrimaryTranscript();
  else if (name === 'primary.state') { renderPrimary(); extensionDialogs.update(); }
  else if (name === 'primary.recovery' || name === 'primary.queue') renderPrimary();
  else if (name === 'agent.frame') renderObservedAgent(event.envelope.data as EventData['agent.frame']);
  else if (name === 'agent.roster' || name === 'agent.availability') { renderRoster(); renderAgent(); }
  else if (name === 'workspace.changed') { renderAll(); void loadPrimaryHistory(); }
  else if (name === 'draft.changed') updateDraft(event.envelope.data as EventData['draft.changed']);
  else if (name === 'operation.changed') showOperation(event.envelope.data as OperationView);
  else if (name === 'notice') noticesBadge();
  else if (name === 'extension.request') applyExtension(event);
  else if (name === 'extension.expired') extensionDialogs.update();
}
function renderObservedAgent(data: EventData['agent.frame']): void {
  renderAgent();
  if (observationStart?.identity !== data.identity) return;
  const start = observationStart.at; observationStart = undefined;
  requestAnimationFrame(() => performance.measure('ui:agent-observation-startup', {start, end: performance.now(), detail: {identity: data.identity}}));
}
function applyExtension(event: ReceivedEvent): void {
  const data = event.envelope.data as EventData['extension.request'];
  if ('id' in data) { extensionDialogs.update(); return; }
  if (data.method === 'notify') noticesBadge();
  else if (data.method === 'set_editor_text' && sameTarget(event.envelope.target, primaryTarget())) primaryComposer.suggest(data.text);
  else if (sameTarget(event.envelope.target, primaryTarget())) extensionStatus(primary());
}
function updateDraft(event: EventData['draft.changed']): void {
  if (sameTarget(event.target, primaryComposer.target)) primaryComposer.updateDraft(event.draft);
  if (sameTarget(event.target, agentComposer.target)) agentComposer.updateDraft(event.draft);
}
function renderAll(): void {
  if (!state.workspace) return;
  document.documentElement.dataset.appearance = state.workspace.appearance ?? 'dark';
  renderNavigation();
  renderPrimary(); renderRoster(); renderAgent(); noticesBadge(); extensionDialogs.update();
}
function renderNavigation(): void {
  const narrow = !matchMedia('(min-width: 900px)').matches;
  const {sidebarVisible: visible, agentSelected} = navigationState(state.workspace, narrow, drawerOpen);
  byId('app').classList.toggle('drawer-open', narrow && drawerOpen);
  byId('sidebar').hidden = !visible;
  byId('sidebar-show').hidden = visible;
  byId('sidebar-show').setAttribute('aria-expanded', String(visible));
  byId('primary').hidden = agentSelected;
  byId('agent-detail').hidden = !agentSelected;
  byId('primary-row').setAttribute('aria-current', agentSelected ? 'false' : 'page');
  renderConnection();
}
function focusEditor(): void { byId(navigationState(state.workspace, false).editor).focus(); }
function toggleSidebar(visible: boolean): void {
  if (!matchMedia('(min-width: 900px)').matches) {
    drawerOpen = visible; renderNavigation(); roster.schedule(); byId(visible ? 'sidebar-hide' : 'sidebar-show').focus(); return;
  }
  const applied = selection({sidebarVisible: visible});
  byId(visible ? 'sidebar-hide' : 'sidebar-show').focus();
  void applied.catch(showError);
}
function selectPrimary(): void {
  const origin = document.activeElement; drawerOpen = false;
  const applied = selection({selectedTarget: primaryTarget() ?? null});
  focusEditor(); void applied.then(() => {
    if (!selectedAgent() && (document.activeElement === origin || document.activeElement === document.body)) focusEditor();
  }).catch(showError);
}
function renderPrimary(): void {
  const item = primary(); const target = primaryTarget(); const saved = targetState(target);
  actions.warm();
  if (saved?.targetKey !== primaryTargetKey) {
    primaryTargetKey = saved?.targetKey ?? ''; primaryCursor = null; primaryEarlier = undefined; earlierFeedback('primary', false); byId('primary-view-notice').replaceChildren(); primaryTranscript.reset(); primaryTranscript.configure(saved?.presentation, saved?.reading);
  }
  primaryComposer.attach(state.workspace?.id ?? '', saved); primaryComposer.receipts(state.operations.values());
  byId('primary-composer').hidden = !saved; byId('primary-status').hidden = !item;
  byId('session-title').hidden = !item;
  primaryChrome(item); primaryActivity(item, target);
  extensionStatus(item); renderPrimaryTranscript(); renderAvailability();
  byId('primary-transcript').hidden = !item;
  if (!item) document.title = 'Pi · Open a project';
}
function primaryChrome(item?: PrimaryView): void {
  setText(byId('project-name'), item?.cwd.split('/').filter(Boolean).at(-1) ?? 'Open a project');
  primaryNavigation(item);
  setText(byId('session-title'), item?.extension?.title ?? item?.sessionName ?? item?.sessionId ?? 'Pi');
  if (item) document.title = `Pi · ${item.sessionName ?? item.sessionId ?? 'Primary'}`;
  const model = byId<HTMLButtonElement>('model-button'); model.disabled = item?.lifecycle !== 'ready'; model.hidden = !item?.model && item?.lifecycle !== 'ready'; setText(model, item?.model ? `${item.model.provider}/${item.model.id} ▾` : 'Model');
  setText(byId('primary-usage'), usageSummary(item));
  const thinking = byId<HTMLButtonElement>('thinking-button'); thinking.hidden = !item?.thinkingLevel; setText(thinking, item?.thinkingLevel ? `${item.thinkingLevel} ▾` : '');
}
function primaryNavigation(item?: PrimaryView): void {
  const glyph = !item ? '◌' : item.lifecycle === 'failed' || item.lastError ? '!' : primaryBusy(item) ? '●' : '○';
  const status = byId('primary-row-state'); setText(status, glyph);
  status.dataset.state = ({'◌': 'none', '!': 'failed', '●': 'running', '○': 'idle'} as const)[glyph];
  setText(byId('primary-row-title'), item?.extension?.title ?? item?.sessionName ?? item?.sessionId ?? 'No primary session');
  setText(byId('primary-row-meta'), item ? [item.model?.id, item.lifecycle === 'ready' ? item.activity : item.lifecycle].filter(Boolean).join(' · ') : 'Open a project');
}
function primaryActivity(item?: PrimaryView, target?: Target): void {
  const conversation = target ? state.conversations.get(targetIdentity(target)) : undefined;
  const recovery = conversation?.recovery;
  setText(byId('primary-activity'), item?.lifecycle === 'ready' && recovery?.kind === 'retry' && recovery.phase !== 'end' ? `Retrying${recovery.error ? ` after ${recovery.error}` : ''}${recovery.attempt ? ` · attempt ${recovery.attempt}` : ''}` : primaryActivityLabel(item));
  if (item?.lastError) byId('primary-activity').append(button('Review retry prompt…', () => actions.retryOutput()));
  byId('primary-stop').hidden = !(connected && primaryBusy(item, conversation?.queue?.pending));
}
function renderPrimaryTranscript(): void {
  if (selectedAgent()) return;
  const item = primary(); const target = primaryTarget();
  const blocks = item ? primaryBlocks(state, item.key) : [];
  if (item) primaryTranscript.set(blocks, target ? state.conversations.get(targetIdentity(target))?.tools : undefined);
  const presentation = primaryEmpty(item, blocks.some(entry => !['model_change', 'thinking_level_change'].includes(entry.kind) && entryVisible(entry)), !!target && historyReadyTarget === targetIdentity(target));
  const empty = byId('primary-empty'); empty.hidden = !presentation;
  if (presentation) {
    const heading = empty.querySelector('h2'); if (heading) setText(heading, presentation.heading);
    setText(byId('primary-empty-caption'), !item && state.workspace?.primaryKey ? 'Loading the selected session' : presentation.caption);
  }
  byId('primary-open-project').hidden = !!item || !!state.workspace?.primaryKey;
}
function renderRoster(): void { setText(byId('agent-count'), String(state.roster.size)); roster.set(state.rosterOrder.flatMap(id => { const row = state.roster.get(id); return row ? [row] : []; }), state.rosterMeta, selectedAgent()); }
function renderAgent(): void {
  const identity = selectedAgent(); if (!identity) return;
  const row = agentRow(identity); const saved = targetState({kind: 'agent', identity});
  if (saved?.targetKey !== agentTargetKey) {
    agentTargetKey = saved?.targetKey ?? ''; agentBefore = null; agentEarlier = undefined; earlierFeedback('agent', false); byId('agent-view-notice').replaceChildren(); byId('agent-facts').replaceChildren(); agentTranscript.reset(); agentTranscript.configure(saved?.presentation, saved?.reading);
  }
  agentComposer.attach(state.workspace?.id ?? '', saved); agentComposer.receipts(state.operations.values());
  agentChrome(identity, row);
  agentAvailability(identity, row); renderAvailability();
}
function agentChrome(identity: string, row?: AgentRow): void {
  setText(byId('agent-name'), row?.name ?? row?.handle ?? identity); setText(byId('agent-identity'), identity);
  const conversation = state.conversations.get(targetIdentity({kind: 'agent', identity})); const frame = conversation?.frame;
  agentTranscript.set(conversation ? conversationBlocks(conversation) : agentBlocks(state));
  setText(byId('agent-status'), frame?.status.model ? `${frame.status.model.provider}/${frame.status.model.modelId}${frame.status.thinkingLevel ? ` · ${frame.status.thinkingLevel}` : ''}` : row?.model ? `${row.model.provider}/${row.model.modelId}${row.thinkingLevel ? ` · ${row.thinkingLevel}` : ''}` : '');
  agentBefore = frame?.nextBefore ?? agentBefore; byId('agent-earlier').hidden = agentBefore === null;
  byId('agent-abort').hidden = !connected || row?.availability !== 'live' || !row?.capabilities?.input || !row?.capabilities?.abort;
  byId('agent-inspect').hidden = !row?.capabilities?.inspect;
  agentFacts(row, frame);
}
function agentFacts(row?: AgentRow, frame?: ProjectedFrame): void {
  const facts: {key: string; label: string; text: string}[] = [];
  if (!frame && row?.firstMessage) facts.push({key: 'first', label: 'First message · retained metadata', text: row.firstMessage});
  if (!frame && row?.latestReply) facts.push({key: 'reply', label: 'Last reply · retained metadata', text: row.latestReply});
  if (frame?.status.tasks) facts.push({key: 'tasks', label: 'Reported tasks', text: rawText(frame.status.tasks.value)});
  if (frame?.status.submissions) facts.push({key: 'submissions', label: 'Reported submissions', text: rawText(frame.status.submissions.value)});
  renderFacts(byId('agent-facts'), facts);
}
function agentAvailability(identity: string, row?: AgentRow): void {
  const frame = state.conversations.get(targetIdentity({kind: 'agent', identity}))?.frame;
  const availability = byId('agent-availability');
  if (row?.availability === 'live') setText(availability, !frame ? 'Loading history' : frame.status.busy ? '● Working' : 'Last observed · live host');
  else {
    setText(availability, row?.availability === 'incompatible' ? 'Host contract mismatch. This agent control is unavailable.' : 'Stored metadata; no live compatible host');
  }

}
function renderAvailability(): void {
  const item = primary(); const identity = selectedAgent(); const row = identity ? agentRow(identity) : undefined;
  const frame = identity ? state.conversations.get(targetIdentity({kind: 'agent', identity}))?.frame : undefined;
  const conversation = item ? state.conversations.get(targetIdentity({kind: 'primary', key: item.key, epoch: item.epoch})) : undefined;
  const busy = primaryBusy(item, conversation?.queue?.pending);
  primaryComposer.availability(connected, item?.lifecycle === 'ready', busy, selecting);
  byId('primary-stop').hidden = !connected || !busy;
  byId('agent-abort').hidden = !connected || row?.availability !== 'live' || !row?.capabilities?.input || !row?.capabilities?.abort;
  agentComposer.availability(connected, row?.availability === 'live' && row.capabilities?.input === true, frame?.status.busy ?? false, selecting);
  if (!connected && (connectionPhase === 'offline' || connectionPhase === 'auth')) {
    setText(byId('primary-activity'), 'Last observed');
    if (identity) setText(byId('agent-availability'), 'Last observed');
  }
}
async function selectAgent(row: AgentRow): Promise<void> {
  const origin = document.activeElement; drawerOpen = false;
  observationStart = {identity: row.identity, at: performance.now()};
  const applied = selection({panelVisible: true, selectedTarget: {kind: 'agent', identity: row.identity}});
  focusEditor(); await applied;
  if (selectedAgent() === row.identity && (document.activeElement === origin || document.activeElement === document.body)) focusEditor();
}
async function loadPrimaryHistory(cursor?: string): Promise<void> {
  const item = primary(); const target = primaryTarget(); if (!item || !target) return;
  const captured = targetIdentity(target); const controller = historyAbort;
  if (cursor && primaryEarlier?.target === captured && primaryEarlier.controller === controller) return;
  const pending = {target: captured, controller};
  if (cursor) { primaryEarlier = pending; earlierFeedback('primary', true); }
  try {
    const page = await request<HistoryPage>(`/api/primaries/${encodeURIComponent(item.key)}/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
    if (controller.signal.aborted || !sameTarget(target, primaryTarget())) return;
    applyPrimaryHistoryPage(target, page, cursor);
  } catch (error) {
    primaryHistoryFailure(error, controller, cursor);
  } finally {
    if (cursor && primaryEarlier === pending) { primaryEarlier = undefined; earlierFeedback('primary', false); }
  }
}
function applyPrimaryHistoryPage(target: Target, page: HistoryPage, cursor?: string): void {
  historyReadyTarget = targetIdentity(target);
  state = mergePrimaryPage(state, target, page.items); primaryCursor = page.nextCursor; byId('primary-earlier').hidden = !primaryCursor; renderPrimaryTranscript();
  if (cursor) historyFeedback('primary', `Loaded earlier history · ${page.items.length} entries`);
  else if (!selectedAgent()) primaryTranscript.restore(targetState(target)?.reading);
}
function primaryHistoryFailure(error: unknown, controller: AbortController, cursor?: string): void {
  if (controller.signal.aborted) return;
  if (cursor) historyFeedback('primary', `Earlier history unavailable: ${errorMessage(error)}`); else showError(error);
}
function earlierFeedback(prefix: 'primary' | 'agent', pending: boolean): void {
  const control = byId<HTMLButtonElement>(`${prefix}-earlier`); control.disabled = pending;
  setText(control, pending ? 'Loading earlier messages…' : 'Load earlier messages');
}
function historyFeedback(prefix: 'primary' | 'agent', text: string): void {
  const notice = byId(`${prefix}-view-notice`); notice.dataset.kind = 'history'; setText(notice, text);
}
async function loadAgentHistory(): Promise<void> {
  const identity = selectedAgent(); const controller = historyAbort;
  if (!identity || (agentEarlier?.target === identity && agentEarlier.controller === controller)) return;
  const pending = {target: identity, controller}; agentEarlier = pending; earlierFeedback('agent', true);
  try {
    const page = await request<AgentHistoryPage>(`/api/agents/${encodeURIComponent(identity)}/history?limit=50${agentBefore ? `&before=${agentBefore}` : ''}`, 'GET', undefined, undefined, controller.signal);
    if (controller.signal.aborted || selectedAgent() !== identity) return;
    state = mergeAgentPage(state, identity, page.entries); agentBefore = page.nextBefore; renderAgent();
    historyFeedback('agent', `Loaded earlier history · ${page.entries.length} entries`);
  } catch (error) { if (!controller.signal.aborted && selectedAgent() === identity) historyFeedback('agent', `Earlier history unavailable: ${errorMessage(error)}`); }
  finally { if (agentEarlier === pending) { agentEarlier = undefined; earlierFeedback('agent', false); } }
}
function saveReading(composer: Composer, reading: TargetState['reading']): Promise<void> {
  return saveView(composer, 'reading', {anchorId: reading.anchorId, offsetPx: reading.offsetPx, followTail: reading.followTail});
}
function savePresentation(composer: Composer, expanded: string[], showThinking: boolean): Promise<void> {
  return saveView(composer, 'presentation', {expanded: expanded.slice(), showThinking});
}
async function saveView(composer: Composer, kind: 'reading' | 'presentation', values: object): Promise<void> {
  const saved = composer.state; const workspace = state.workspace; if (!saved || !workspace || !connected) return;
  const notice = byId(`${composer.prefix}-view-notice`);
  try { await preferences.save(`${workspace.id}/${saved.targetKey}/${kind}`, async () => {
    const latest = state.targets.get(saved.targetKey) ?? saved;
    const result = await request<TargetState['reading'] | NonNullable<TargetState['presentation']>>(`/api/workspaces/${encodeURIComponent(workspace.id)}/targets/${encodeURIComponent(saved.targetKey)}/${kind}`, 'PUT', {expectedRevision: latest[kind]?.revision ?? 0, ...values});
    const current = state.targets.get(saved.targetKey) ?? saved;
    if (result.revision >= (current[kind]?.revision ?? 0)) state = {...state, targets: new Map(state.targets).set(saved.targetKey, {...current, [kind]: result})};
    if (notice.dataset.kind === kind) notice.replaceChildren();
  }); } catch (error) {
    notice.dataset.kind = kind; notice.replaceChildren(element('p', 'error', `View not saved for ${targetIdentity(saved.target)}: ${errorMessage(error)}`), button('Reload saved view', () => { void reload().then(() => {
      if (composer.state?.targetKey !== saved.targetKey) return;
      const latest = state.targets.get(saved.targetKey); const transcript = composer.prefix === 'primary' ? primaryTranscript : agentTranscript;
      transcript.configure(latest?.presentation, latest?.reading); notice.replaceChildren();
    }).catch(showError); }));
  }
}
function showOperation(result: OperationView): void {
  if (newerOperation(state.operations.get(result.id), result) !== result) return;
  state = {...state, operations: mergeOperationMap(state.operations, result)};
  if (result.kind === 'primary.handoff') actions.handoffResult(result);
  if (inputOperation(result)) {
    if (['accepted', 'rejected', 'uncertain'].includes(result.state)) { primaryComposer.updateOperation(result); agentComposer.updateOperation(result); }
  }
  primaryComposer.receipts(state.operations.values()); agentComposer.receipts(state.operations.values());
  if (result.state !== 'reserved' && result.state !== 'dispatched') announce(operationLabel(result));
}
function recover(saved: TargetState): void {
  const prefix = saved.target.kind === 'primary' ? 'primary' : 'agent'; const receipt = byId(`${prefix}-receipt`); receipt.replaceChildren();
  for (const item of saved.unconfirmed) {
    const row = element('div'); row.append(element('p', 'warning', 'Send not confirmed'), element('pre', undefined, item.text));
    row.append(button('Check receipt', () => { void request<OperationView>(`/api/operations/${encodeURIComponent(item.operationId)}/reconcile`, 'POST', {}).then(showOperation).catch(showError); }), button('Copy', () => { void exactInput(state.workspace?.id ?? '', item).then(exact => copy(exact.text, row)).catch(showError); }), button('Restore to draft', () => {
      void request<DraftView>(`/api/workspaces/${encodeURIComponent(state.workspace?.id ?? '')}/unconfirmed/${encodeURIComponent(item.operationId)}/restore`, 'POST', {expectedDraftRevision: saved.draft.revision}).then(() => reload()).catch(showError);
    }), button('Discard copy…', () => modal.confirm('Discard input copy', 'This deletes only the local copy. It does not cancel work or prove non-admission.', async () => { await request(`/api/workspaces/${encodeURIComponent(state.workspace?.id ?? '')}/unconfirmed/${encodeURIComponent(item.operationId)}`, 'DELETE'); await reload(); }, 'Discard copy'))); receipt.append(row);
  }
}
function noticesBadge(): void { const unread = unreadNotices(state); setText(byId('notices-count'), unread ? String(unread) : ''); byId('notices-count').hidden = !unread; byId('notices-button').setAttribute('aria-label', unread ? `Notifications (${unread} unread)` : 'Notifications'); }
function notices(): void {
  state = markReadNotices(state); noticesBadge(); modal.open('Notifications'); if (!state.notices.length) modal.body.append(empty('No notifications'));
  for (const notice of state.notices) {
    const row = element('div', `notification ${notice.level}`); row.append(button('Dismiss', () => { state = dismissNotice(state, notice.id); notices(); noticesBadge(); }), element('p', undefined, notice.message));
    if (notice.target) row.append(element('p', 'target-label', notice.target.kind === 'primary' ? `Primary ${notice.target.key} · conversation ${notice.target.epoch}` : `Agent ${notice.target.identity}`));
    modal.body.append(row);
  }
}
function showError(error: unknown): void { const message = errorMessage(error); announce(message); setText(byId(visibleReceipt(state.workspace)), message); }
function showRosterError(error: unknown): void { const message = errorMessage(error); announce(message); byId('roster-footer').replaceChildren(element('p', 'error', message), button('Retry roster read', () => { void reload().catch(showRosterError); })); }
function refreshRoster(): void { void request('/api/agents/refresh', 'POST', {}).catch(showRosterError); }
function moreRoster(): void {
  const cursor = state.rosterMeta?.nextCursor;
  if (cursor) { void request<import('../shared/api.ts').CachedRoster>(`/api/agents?limit=20&cursor=${encodeURIComponent(cursor)}`).then(page => {
    state = mergeRosterPage(state, page); renderRoster();
  }).catch(showRosterError); return; }
  const scanId = state.rosterMeta?.scan.scanId;
  void request('/api/agents/refresh', 'POST', scanId ? {scanId, continue: true} : {}).catch(showRosterError);
}
function inspectAgent(): void {
  const identity = selectedAgent(); if (!identity) return;
  modal.open('Agent activity').append(element('p', 'identity', identity)); const token = modal.token;
  void modal.run(async () => {
    const data = await request(`/api/agents/${encodeURIComponent(identity)}/inspect`, 'POST', {view: 'activity', limit: 20});
    if (modal.owns(token)) modal.body.append(details('Reported activity', rawText(data)));
  }, false);
}
function viewActions(): void {
  modal.open('Loaded conversation view');
  for (const [label, tools, expand] of [['Expand loaded tools', true, true], ['Collapse loaded tools', true, false], ['Show thinking', false, true], ['Hide thinking', false, false]] as const) modal.body.append(button(label, () => { primaryTranscript.expandLoaded(tools, expand); modal.close(); }));
  modal.body.append(button('Find in loaded messages', () => actions.find()));
}
function bind(): void {
  byId('primary-open-project').addEventListener('click', () => actions.projectPicker());
  byId('project-button').addEventListener('click', () => actions.projectPicker()); byId('session-title').addEventListener('click', () => actions.sessionDetails());
  byId('session-actions').addEventListener('click', () => { actions.sessionMenu(); modal.body.append(button('Conversation view…', viewActions)); }); byId('commands-button').addEventListener('click', () => actions.palette());
  byId('model-button').addEventListener('click', () => actions.modelPicker()); byId('thinking-button').addEventListener('click', () => actions.thinkingPicker());
  byId('notices-button').addEventListener('click', notices);
  byId('agent-acquire').addEventListener('click', () => { const identity = selectedAgent(); if (connected && identity) actions.prepareText(`/agent attach ${identity}`); });
  byId('primary-row').addEventListener('click', selectPrimary);
  byId('sidebar-hide').addEventListener('click', () => toggleSidebar(false));
  byId('sidebar-show').addEventListener('click', () => toggleSidebar(true));
  byId('sessions-button').addEventListener('click', () => actions.projectPicker());
  byId('appearance-button').addEventListener('click', () => actions.appearance());
  byId('skip-composer').addEventListener('click', event => { event.preventDefault(); focusEditor(); });
  byId('agent-copy').addEventListener('click', () => { void copy(selectedAgent() ?? '', byId('agent-availability')); });
  byId('agent-inspect').addEventListener('click', inspectAgent); byId('agent-facts').addEventListener('toggle', renderAgent, true);
  byId('agent-refresh').addEventListener('click', refreshRoster); byId('agent-new').addEventListener('click', () => actions.prepareText('/agent new'));
  byId('primary-earlier').addEventListener('click', () => { void loadPrimaryHistory(primaryCursor ?? undefined); }); byId('agent-earlier').addEventListener('click', () => { void loadAgentHistory().catch(showError); });
  byId('primary-stop').addEventListener('click', () => { const target = primaryTarget(); if (target?.kind !== 'primary') return; setText(byId('primary-receipt'), 'Stop requested'); void operation('primary.stop', `/api/primaries/${encodeURIComponent(target.key)}/stop`, {epoch: target.epoch}, target).then(showOperation).catch(showError); });
  byId('agent-abort').addEventListener('click', () => { const identity = selectedAgent(); if (!identity) return; modal.confirm('Abort selected agent', `${identity}\nThis requests foreground abort only. Background work and timers remain separate.`, async () => { setText(byId('agent-receipt'), 'Abort requested'); showOperation(await operation('agent.abort', `/api/agents/${encodeURIComponent(identity)}/abort`, {background: false}, {kind: 'agent', identity})); }, 'Abort'); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && drawerOpen && !modal.openNow) { event.preventDefault(); toggleSidebar(false); return; } if (event.metaKey && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!modal.openNow) actions.palette(); } });
  window.addEventListener('resize', () => { renderNavigation(); primaryComposer.resize(); agentComposer.resize(); roster.schedule(); });
  window.addEventListener('beforeunload', event => { if (primaryComposer.unsaved || agentComposer.unsaved) event.preventDefault(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.workspace?.panelVisible) { hiddenPanel = true; void selection({panelVisible: false}).catch(showError); }
    else if (!document.hidden && hiddenPanel) { hiddenPanel = false; void selection({panelVisible: true}).catch(showError); }
  });
}
async function bootstrap(): Promise<void> {
  const workspace = new URL(location.href).searchParams.get('workspace');
  const data = await hydrateVisible(await request<Bootstrap>(`/api/bootstrap${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`));
  snapshot = data; state = replaceSnapshot(state, data);
  const url = new URL(location.href); url.searchParams.set('workspace', data.workspace.id); history.replaceState(null, '', url);
}
async function start(): Promise<void> {
  bind(); renderNavigation();
  try {
    await authenticate(); await refreshVisible(bootstrap, loadPrimaryHistory, showError);
    renderAll(); await stream(); connectionRecovery.healthy();
    document.dispatchEvent(new Event('ui-ready')); if (!primary()) actions.projectPicker();
  } catch (error) {
    connectionRecovery.lost(error);
  }
}
void start();
