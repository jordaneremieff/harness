import type { AgentHistoryPage, AgentRow, Bootstrap, EventData, HistoryPage, OperationView, PrimaryView, ProjectedFrame, Snapshot, Target, TargetState, Workspace } from '../shared/api.ts';
import { Actions } from './actions.ts';
import type { ConversationLayout } from '../shared/api.ts';
import { activeTab, closeTab, layoutTarget, openTab, splitGeometry, splitPercent, switchTab, tabForTarget, tabKey, toggleSplit, workspaceLayout, type SplitGeometry } from './tabs.ts';
import { TabStrip } from './tabs-view.ts';
import { contextMenu, nativeEditingTarget, type ContextItem } from './context-menu.ts';
import { ProjectPicker } from './picker.ts';
import type { SelectionChange } from './actions.ts';
import { Composer } from './composer.ts';
import { ConnectionRecovery, connectionSurface as connectionSurfaceFor, type ConnectionPhase } from './connection-state.ts';
import { announce, byId, button, copy, details, element, empty, rawText, setText } from './dom.ts';
import { ExtensionDialogs, extensionStatus } from './extensions.ts';
import { Modal } from './modal.ts';
import { Transcript } from './render.ts';
import { imageUrl } from './image.ts';
import { historyBecameReady } from './transcript-history.ts';
import { Roster } from './roster.ts';
import { Recovery } from './recovery.ts';
import { conversationBlocks, createState, dismissNotice, markReadNotices, unreadNotices, mergeRosterPage, mergeAgentPage, mergePrimaryPage, primaryBlocks, reduceEvent, replaceSnapshot, targetIdentity } from './state.ts';
import type { UiEvent } from './state.ts';
import { hydrateVisible, refreshVisible } from './hydrate.ts';
import { MessageTarget, SelectionQueue, navigationState, visibleReceipt } from './selection-state.ts';
import { usageFacts } from './usage.ts';
import { createResizer, type Resizer } from './resize.ts';
import { entryVisible } from './entry-presentation.ts';
import { primaryBusy, primaryEmpty } from './primary-presentation.ts';
import { inputOperation, operationLabel } from './operation-label.ts';
import { PreferenceQueue } from './preference-queue.ts';
import { renderFacts } from './facts.ts';
import { newerOperation, mergeOperationMap } from './operation-state.ts';
import { ApiError, authenticate, connect, errorMessage, operation, request } from './transport.ts';
import type { ReceivedEvent } from './transport.ts';

export let state = createState();
let snapshot: Bootstrap | Snapshot | undefined;
let source: EventSource | undefined;
let connected = false;
export let drawerOpen = false;
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
type TranscriptTarget = {workspaceId: string; saved: TargetState; prefix: 'primary' | 'agent'};
let primaryTranscriptTarget: TranscriptTarget | undefined;
let agentTranscriptTarget: TranscriptTarget | undefined;
let hiddenPanel = false;
let selecting = false;
let scrollbarPending = false;
let reloadTail = Promise.resolve();
const snapshotBuffers = new Set<{events: UiEvent[]; bytes: number; overflow: boolean}>();
let observationStart: {identity: string; at: number} | undefined;
const modal = new Modal();
const preferences = new PreferenceQueue();
export const primaryComposer: Composer = new Composer('primary', {submitted: showOperation, unknownCommand: (text, literal): boolean => actions.unknown(text, literal), commands: () => actions.commandOptions()});
export const agentComposer = new Composer('agent', {submitted: showOperation, unknownCommand: () => false, retained: (workspace, target) => {
  if (workspace === state.workspace?.id && target.kind === 'agent') renderMessageResume(target.identity);
}});
const messageTarget = new MessageTarget({workspace: () => state.workspace, prepare: (workspaceId, target) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/targets`, 'POST', {target}), paint: renderMessagePanel});
const primaryTranscript = new Transcript('primary', {presentation: (expanded, showThinking) => { void savePresentation(primaryTranscriptTarget, expanded, showThinking); }, reading: reading => { void saveReading(primaryTranscriptTarget, reading); }, fork: (message, entry) => actions.fork(entry, rawText(message.parts)), output: loadPrimaryOutput, image: part => { const target = primaryTarget(); return target ? imageUrl(part, target, state.workspace?.id) : undefined; }});
async function loadPrimaryOutput(more: import('../shared/api.ts').OutputContinuation): Promise<import('../shared/api.ts').OutputPage> {
  const captured = primary(); if (!captured) throw new Error('Primary history is unavailable.');
  const page = await request<import('../shared/api.ts').OutputPage>(`/api/primaries/${encodeURIComponent(captured.key)}/history/output?epoch=${captured.epoch}&entry=${encodeURIComponent(more.entryId)}&part=${more.part}&offset=${more.offset}`, 'GET', undefined, undefined, historyAbort.signal);
  if (primary()?.key !== captured.key || primary()?.epoch !== captured.epoch) throw new Error('The primary conversation changed.');
  return page;
}
const agentTranscript = new Transcript('agent', {presentation: (expanded, showThinking) => { void savePresentation(agentTranscriptTarget, expanded, showThinking); }, reading: reading => { void saveReading(agentTranscriptTarget, reading); }, image: part => agentTranscriptTarget ? imageUrl(part, agentTranscriptTarget.saved.target, agentTranscriptTarget.workspaceId) : undefined});
const actions: Actions = new Actions({snapshot: currentSnapshot, primary, composer: primaryComposer, modal, selection, reload: reloadSelection, result: showOperation, rosterRefresh: refreshRoster, find: query => primaryTranscript.find(query), recovery: () => recovery.open(), primaryEntries: () => primary() ? primaryBlocks(state, primary()?.key ?? '') : [], agents: () => state.rosterOrder.flatMap(identity => { const row = agentRow(identity); return row ? [row] : []; }), selectedAgent: () => { const identity = selectedAgent(); return identity ? agentRow(identity) ?? {identity, storageId: '', cwd: '', availability: 'stored'} : undefined; }, selectAgent: row => { void selectAgent(row).catch(showError); }, notices, sidebar: toggleSidebar, view: (tools, expand) => primaryTranscript.expandLoaded(tools, expand), selectPrimary, copyAgent: () => { void copy(selectedAgent() ?? '', byId('agent-view-notice')); }, inspectAgent,
  tabs: {close: () => { const layout = currentLayout(); if (layout.active !== null) applyLayout(closeTab(layout, layout.active)); }, switch: direction => applyLayout(switchTab(currentLayout(), direction)), split: () => applyLayout(toggleSplit(currentLayout())), canSplit: () => activeTab(currentLayout())?.kind === 'agent'},
});
const tabStrip = new TabStrip(byId('conversation-tabs'), {layout: currentLayout, change: applyLayout, label: tab => tab.kind === 'primary' ? primary()?.extension?.title ?? primary()?.sessionName ?? 'Primary' : agentRow(tab.identity)?.name ?? agentRow(tab.identity)?.handle ?? tab.identity, status: tab => tab.kind === 'agent' ? agentState(agentRow(tab.identity)) : ''});
const picker = new ProjectPicker({snapshot: currentSnapshot, primary, modal, selection, reload: reloadSelection});
actions.projectPicker = () => picker.open();
const recovery = new Recovery({snapshot: currentSnapshot, reload, modal});
const roster = new Roster(row => { void selectAgent(row).catch(showError); }, action => { if (action === 'refresh') refreshRoster(); else moreRoster(); }, {
  load: (cursor, signal) => request<import('../shared/api.ts').CachedRoster>(`/api/agents?limit=20&cursor=${encodeURIComponent(cursor)}`, 'GET', undefined, undefined, signal),
  merge: page => { state = mergeRosterPage(state, page); renderRoster(); },
}, openAgentMessage);
function openAgentMessage(identity: string): void {
  const preparing = messageTarget.open(identity); const captured = messageTarget.current;
  if (agentComposer.target?.kind === 'agent' && agentComposer.target.identity === identity) agentComposer.editor.focus(); else byId('agent-message-close').focus();
  void preparing.then(() => { if (captured && messageTarget.valid(captured) && captured.prepared && document.activeElement === byId('agent-message-close')) agentComposer.editor.focus(); });
}
const extensionDialogs = new ExtensionDialogs(modal, () => state, next => { state = next; }, primary);
const connectionRecovery = new ConnectionRecovery({attempt: resync, unauthorized: error => error instanceof ApiError && error.view.code === 'unauthorized', paint: (phase, error) => {
  connectionPhase = phase; connectionError = error; connected = phase === 'healthy'; renderConnection();
  if (connected) renderAll(); else renderAvailability();
}});
export const selectionQueue = new SelectionQueue({current: () => state.workspace, reload, save: (workspace, change) => request<Workspace>(`/api/workspaces/${encodeURIComponent(workspace.id)}/selection`, 'PUT', {expectedRevision: workspace.revision, ...change}), paint: (workspace, pending) => { selecting = pending; state = {...state, workspace}; renderAll(); }});

let paneWorkspace = '';
let paneResizers: Resizer[] = [];
export function tabSize(key: string, min: number, max: number): number | undefined {
  try { const text = sessionStorage.getItem(key); if (text === null) return undefined; const value = Number(text); return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined; } catch { return undefined; }
}
export function storeTabSize(key: string, value: number | undefined): void {
  try { if (value === undefined) sessionStorage.removeItem(key); else sessionStorage.setItem(key, String(value)); } catch { /* The current tab retains its in-memory size. */ }
}
function composerResizer(workspace: string, prefix: 'primary' | 'agent', composer: Composer): Resizer {
  const key = `ui:pane:${workspace}:${prefix}-composer`;
  let preferred = tabSize(key, 40, 640);
  const form = byId(`${prefix}-composer`);
  composer.setManualHeight(preferred);
  if (preferred === undefined) form.style.removeProperty('--composer-height');
  return createResizer({handle: byId(`${prefix}-composer-resizer`), axis: 'y', direction: -1,
    min: 40, max: 640, defaultValue: 144, applyInitial: preferred !== undefined,
    read: () => preferred ?? composer.editor.offsetHeight,
    write: value => {form.style.setProperty('--composer-height', `${value}px`); composer.setManualHeight(value);},
    onCommit: value => {preferred = value; storeTabSize(key, value);},
    onReset: () => {preferred = undefined; storeTabSize(key, undefined); form.style.removeProperty('--composer-height'); composer.setManualHeight(undefined);},
  });
}
function refreshPaneSizes(): void {
  const workspace = state.workspace; if (!workspace) return;
  if (workspace.id !== paneWorkspace) {
    for (const resizer of paneResizers) resizer.destroy();
    paneWorkspace = workspace.id;
    const app = byId('app'); const panel = byId('agent-message-panel');
    const panelKey = `ui:pane:${workspace.id}:message-panel`;
    let panelHeight = tabSize(panelKey, 160, 640) ?? 320;
    paneResizers = [
      createResizer({handle: byId('sidebar-resizer'), axis: 'x', min: 200, max: 480, defaultValue: 272,
        read: () => state.workspace?.sidebarWidth ?? 272,
        write: value => app.style.setProperty('--sidebar-width', `${value}px`),
        onCommit: value => {void selectionQueue.select({sidebarWidth: value}).catch(showError);}}),
      composerResizer(workspace.id, 'primary', primaryComposer),
      composerResizer(workspace.id, 'agent', agentComposer),
      createResizer({handle: byId('message-panel-resizer'), axis: 'y', direction: -1,
        min: 160, max: 640, defaultValue: 320, read: () => panelHeight,
        write: value => panel.style.setProperty('--panel-height', `${value}px`),
        onCommit: value => {panelHeight = value; storeTabSize(panelKey, value);}}),
    ];
  }
  paneResizers[0]?.refresh();
}

let sidebarSectionWorkspace = '';
const sidebarSections = {primary: false, agents: false};
function sidebarSectionKey(section: 'primary' | 'agents'): string { return `ui:sections:${state.workspace?.id ?? ''}:${section}`; }
export function renderSidebarSections(): void {
  const workspace = state.workspace?.id ?? '';
  if (sidebarSectionWorkspace !== workspace) {
    sidebarSectionWorkspace = workspace;
    for (const section of ['primary', 'agents'] as const) { try { sidebarSections[section] = sessionStorage.getItem(sidebarSectionKey(section)) === 'true'; } catch { sidebarSections[section] = false; } }
  }
  for (const section of ['primary', 'agents'] as const) {
    byId(`${section}-heading`).setAttribute('aria-expanded', String(!sidebarSections[section]));
    byId(`${section}-section-body`).hidden = sidebarSections[section];
    byId(section === 'primary' ? 'primary-section' : 'roster-section').dataset.collapsed = String(sidebarSections[section]);
  }
}
export function setSidebarSection(section: 'primary' | 'agents', collapsed: boolean): void {
  renderSidebarSections(); sidebarSections[section] = collapsed;
  try { sessionStorage.setItem(sidebarSectionKey(section), String(collapsed)); } catch { /* The current tab retains its in-memory section state. */ }
  renderSidebarSections(); roster.schedule();
}
export function focusAgentSearch(): void {
  setSidebarSection('agents', false); if (byId('sidebar').hidden) toggleSidebar(true); byId('agent-search').focus();
}

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
function currentLayout(): ConversationLayout { return workspaceLayout(state.workspace); }
export function splitActive(): boolean { return byId('conversation-panes').classList.contains('is-split'); }
const SPLIT_NOTICE = 'Split needs 320 px per pane. Widen the window.';
let splitNoticeKey = '';
let splitCorrectionKey = '';
function measureSplit(layout: ConversationLayout): SplitGeometry | undefined {
  const pane = byId('conversation-panes'); const style = getComputedStyle(pane);
  const edges = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((total, value) => total + Number.parseFloat(value), 0);
  return splitGeometry(pane.getBoundingClientRect().width - edges, Number.parseFloat(getComputedStyle(byId('conversation-splitter')).width), layout.splitRatio);
}
function constrainSplit(layout: ConversationLayout): {layout: ConversationLayout; sidebarVisible?: false; size?: SplitGeometry} {
  const tab = activeTab(layout); const key = `${state.workspace?.id}:${tab?.kind === 'agent' ? tab.identity : ''}`;
  if (tab?.kind !== 'agent' || !tab.split) {
    if (splitNoticeKey !== key || measureSplit(layout)) splitNoticeKey = '';
    return {layout};
  }
  let size = measureSplit(layout); let sidebarVisible: false | undefined;
  if (!size && (!byId('sidebar').hidden || drawerOpen)) {
    drawerOpen = false; byId('app').classList.remove('drawer-open'); byId('sidebar').hidden = true;
    byId('sidebar-show').hidden = false; byId('sidebar-show').setAttribute('aria-expanded', 'false');
    sidebarVisible = false; size = measureSplit(layout);
  }
  if (size) {splitNoticeKey = ''; return {layout, sidebarVisible, size};}
  if (splitNoticeKey !== key) {splitNoticeKey = key; announce(SPLIT_NOTICE);}
  return {layout: toggleSplit(layout), sidebarVisible};
}
function renderSplitNotice(): void {
  const node = byId('agent-view-notice');
  if (splitNoticeKey === `${state.workspace?.id}:${selectedAgent()}`) setText(node, SPLIT_NOTICE);
  else if (node.textContent === SPLIT_NOTICE) setText(node, '');
}
function persistSplitConstraint(original: ConversationLayout, fitted: ReturnType<typeof constrainSplit>): void {
  const workspace = state.workspace; if (!workspace || !connected) return;
  const change: SelectionChange = {};
  if (fitted.layout !== original) change.conversationLayout = fitted.layout;
  if (fitted.sidebarVisible === false && workspace.sidebarVisible !== false) change.sidebarVisible = false;
  if (!Object.keys(change).length) return;
  const key = `${workspace.id}:${workspace.revision}:${JSON.stringify(change)}`;
  // SelectionQueue paints before it appends its save; corrections must follow that original save.
  queueMicrotask(() => {
    if (state.workspace !== workspace || splitCorrectionKey === key) return;
    splitCorrectionKey = key;
    void selectionQueue.select(change).catch(showError);
  });
}
export function applyLayout(layout: ConversationLayout): void {
  const fitted = constrainSplit(layout); layout = fitted.layout;
  const target = layoutTarget(layout, primaryTarget());
  const changedTarget = !sameTarget(target ?? undefined, state.workspace?.selectedTarget);
  const change = {conversationLayout: layout, selectedTarget: target, panelVisible: target?.kind === 'agent', ...(fitted.sidebarVisible === false ? {sidebarVisible: false} : {})};
  const task = changedTarget ? selection(change) : selectionQueue.select(change);
  void task.catch(showError);
}
let splitResizer: Resizer | undefined;
let splitWidth = 0;
function refreshSplitSize(size?: SplitGeometry): void {
  const pane = byId('conversation-panes');
  if (!splitActive() || !size) { splitResizer?.destroy(); splitResizer = undefined; splitWidth = 0; return; }
  const {width, min, max} = size;
  if (width === splitWidth && splitResizer) { splitResizer.refresh(); return; }
  splitResizer?.destroy(); splitWidth = width;
  const save = (ratio: number): void => { void selectionQueue.select({conversationLayout: {...currentLayout(), splitRatio: ratio}}).catch(showError); };
  splitResizer = createResizer({handle: byId('conversation-splitter'), axis: 'x',
    min, max, defaultValue: Math.round(width / 2),
    read: () => width * currentLayout().splitRatio / 100,
    write: pixels => pane.style.setProperty('--split-primary', `${pixels}px`),
    onCommit: pixels => save(splitPercent(pixels, width)), onReset: () => save(50),
  });
}
function selection(change: SelectionChange): Promise<void> {
  if (change.selectedTarget && !change.conversationLayout) {
    try { change = {...change, conversationLayout: openTab(currentLayout(), tabForTarget(change.selectedTarget))}; }
    catch (error) { return Promise.reject(error); }
  }
  if (change.selectedTarget !== undefined) drawerOpen = false;
  if (change.sidebarVisible !== undefined && !matchMedia('(min-width: 900px)').matches) {
    drawerOpen = change.sidebarVisible; const {sidebarVisible: _visible, ...rest} = change; change = rest; renderNavigation(); roster.schedule();
    if (!Object.keys(change).length) return Promise.resolve();
  }
  historyAbort.abort(); historyAbort = new AbortController(); const startedAt = performance.now();
  const task = selectionQueue.select(change);
  requestAnimationFrame(() => performance.measure('ui:cached-target-switch', {start: startedAt, end: performance.now()})); return task;
}
let focusPrimaryKey: string | undefined;
export async function reloadSelection(): Promise<void> {
  await reload(); focusPrimaryKey = state.workspace?.primaryKey;
  focusSelectedPrimary();
}
function focusSelectedPrimary(): void {
  if (selectedAgent()) { focusPrimaryKey = undefined; return; }
  if (!focusPrimaryKey || focusPrimaryKey !== primary()?.key || primary()?.lifecycle !== 'ready' || primaryComposer.editor.disabled) return;
  focusPrimaryKey = undefined; modal.restoreFocus(primaryComposer.editor);
}
export function reload(): Promise<void> {
  const task = reloadTail.then(() => refreshVisible(refreshSnapshot, loadPrimaryHistory, showError)); reloadTail = task.catch(() => undefined); return task;
}
async function refreshSnapshot(): Promise<void> {
  if (!state.workspace) return;
  const before = state; const buffered = {events: [] as UiEvent[], bytes: 0, overflow: false}; snapshotBuffers.add(buffered);
  try {
    const explicit = messageTarget.current;
    const current = await hydrateVisible(await request<Snapshot>(`/api/snapshot?workspace=${encodeURIComponent(state.workspace.id)}`), request, explicit ? {kind: 'agent', identity: explicit.identity} : undefined);
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
  const {owner, visible} = connectionSurfaceFor(connectionPhase, true);
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
      if (messageTarget.current && !messageTarget.current.invalidated) await messageTarget.open(messageTarget.current.identity);
      await stream(); renderAll();
    } finally { resynchronizing = undefined; }
  })();
  return resynchronizing;
}
export function receive(event: ReceivedEvent): void {
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
  if (name === 'primary.delta' || name === 'primary.message' || name === 'primary.entry' || name === 'primary.tool') renderPrimaryEvent(event);
  else if (name === 'primary.state') { renderPrimary(); extensionDialogs.update(); }
  else if (name === 'primary.recovery' || name === 'primary.queue') renderPrimary();
  else if (name === 'agent.frame') renderObservedAgent(event.envelope.data as EventData['agent.frame']);
  else if (name === 'agent.roster' || name === 'agent.availability') renderRosterEvent(event);
  else if (name === 'workspace.changed') { renderAll(); void loadPrimaryHistory(); }
  else if (name === 'draft.changed') updateDraft(event.envelope.data as EventData['draft.changed']);
  else if (name === 'operation.changed') showOperation(event.envelope.data as OperationView);
  else if (name === 'notice') noticesBadge();
  else if (name === 'extension.request') applyExtension(event);
  else if (name === 'extension.expired') extensionDialogs.update();
}
function renderPrimaryEvent(event: ReceivedEvent): void {
  renderPrimaryTranscript();
  if (event.name === 'primary.message' && (event.envelope.data as EventData['primary.message']).message.state === 'final') renderPrimaryUsage(primary());
}
function renderRosterEvent(event: ReceivedEvent): void {
  if (event.name === 'agent.roster') messageTarget.rosterChanged(event.envelope.data as EventData['agent.roster']);
  else messageTarget.availabilityChanged(event.envelope.data as EventData['agent.availability']);
  renderRoster(); renderAgent(); renderMessagePanel();
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
  if (messageTarget.current && !messageTarget.valid(messageTarget.current)) closeMessagePanel(false);
  renderPrimary(); renderRoster(); renderAgent(); renderMessagePanel(); refreshPaneSizes(); noticesBadge(); extensionDialogs.update();
}
export function renderNavigation(): void {
  const narrow = !matchMedia('(min-width: 900px)').matches;
  const {sidebarVisible: visible, agentSelected} = navigationState(state.workspace, narrow, drawerOpen);
  byId('app').classList.toggle('drawer-open', narrow && drawerOpen);
  byId('sidebar').hidden = !visible;
  byId('sidebar-show').hidden = visible;
  byId('sidebar-show').setAttribute('aria-expanded', String(visible));
  const original = currentLayout(); byId('conversation-panes').hidden = !activeTab(original);
  const fitted = constrainSplit(original); const layout = fitted.layout; const tab = activeTab(layout); const split = tab?.kind === 'agent' && tab.split;
  byId('primary').hidden = !tab || (agentSelected && !split);
  byId('agent-detail').hidden = !tab || !agentSelected;
  byId('tabs-empty').hidden = !!tab;
  byId('conversation-panes').hidden = !tab;
  byId('conversation-panes').classList.toggle('is-split', split);
  if (fitted.size && (!byId('conversation-splitter').hasAttribute('data-dragging') || splitWidth !== fitted.size.width)) byId('conversation-panes').style.setProperty('--split-primary', `${fitted.size.primary}px`);
  byId('conversation-splitter').hidden = !split;
  const splitButton = byId<HTMLButtonElement>('tab-split'); splitButton.disabled = tab?.kind !== 'agent';
  splitButton.setAttribute('aria-pressed', String(split)); setText(splitButton, split ? 'Unsplit' : 'Split');
  splitButton.title = tab?.kind === 'agent' ? 'Show this agent beside Primary' : 'Open an agent tab to split beside Primary';
  tabStrip.render(); renderTabActions(); renderStatusbarState(); refreshSplitSize(fitted.size); persistSplitConstraint(original, fitted); renderSplitNotice();
  byId('primary-row').setAttribute('aria-current', agentSelected ? 'false' : 'page');
  renderSidebarSections(); renderConnection(); measureScrollbar();
}
/** Transcript entries widen by the scrollbar gutters so they align with the pane and composer column. */
function measureScrollbar(): void {
  if (scrollbarPending) return; scrollbarPending = true;
  requestAnimationFrame(() => {
    scrollbarPending = false;
    const node = byId(selectedAgent() ? 'agent-transcript' : 'primary-transcript'); if (!node.offsetWidth) return;
    const width = `${(node.offsetWidth - node.clientWidth) / 2}px`;
    if (byId('workspace').style.getPropertyValue('--scrollbar') !== width) byId('workspace').style.setProperty('--scrollbar', width);
  });
}
function focusEditor(): void { byId(navigationState(state.workspace, false).editor).focus(); }
export function toggleSidebar(visible: boolean): void {
  if (!matchMedia('(min-width: 900px)').matches) {
    drawerOpen = visible; renderNavigation(); roster.schedule(); byId(visible ? 'project-button' : 'sidebar-show').focus(); return;
  }
  const applied = selection({sidebarVisible: visible});
  byId(visible ? 'project-button' : 'sidebar-show').focus();
  void applied.catch(showError);
}
function selectPrimary(): void {
  const origin = document.activeElement; drawerOpen = false;
  let layout: ConversationLayout;
  try { layout = openTab(currentLayout(), {kind: 'primary'}); } catch (error) { showError(error); return; }
  const applied = selection({selectedTarget: primaryTarget() ?? null, conversationLayout: layout});
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
  primaryTranscriptTarget = saved && state.workspace ? {workspaceId: state.workspace.id, saved, prefix: 'primary'} : undefined;
  primaryComposer.attach(state.workspace?.id ?? '', saved); primaryComposer.receipts(state.operations.values());
  byId('primary-composer').hidden = !saved; byId('primary-status').hidden = !item;
  primaryChrome(item); primaryActivity(item, target);
  extensionStatus(item); renderPrimaryTranscript(); renderAvailability(); focusSelectedPrimary();
  byId('primary-transcript').hidden = !item;
  if (!item) document.title = 'Pi · Open a project';
}
export function primaryChrome(item?: PrimaryView): void {
  tabStrip.render();
  setText(byId('project-name'), item?.cwd.split('/').filter(Boolean).at(-1) ?? 'open a project');
  primaryNavigation(item);
  renderTabActions();
  if (item && !selectedAgent()) document.title = `Pi · ${item.extension?.title ?? item.sessionName ?? item.sessionId ?? 'Primary'} · ${primaryState(item)}`;
  const model = byId<HTMLButtonElement>('model-button'); model.disabled = item?.lifecycle !== 'ready'; model.hidden = !item?.model && item?.lifecycle !== 'ready'; setText(model, item?.model ? item.model.id : 'Model'); model.title = item?.model ? `${item.model.provider}/${item.model.id} · Primary` : 'Choose Primary model'; model.setAttribute('aria-label', item?.model ? `Model for Primary: ${item.model.provider}/${item.model.id}` : 'Choose Primary model');
  renderPrimaryUsage(item);
  const thinking = byId<HTMLButtonElement>('thinking-button'); thinking.hidden = !item?.thinkingLevel; thinking.disabled = item?.lifecycle !== 'ready'; setText(thinking, item?.thinkingLevel ? `[${item.thinkingLevel}]` : ''); thinking.setAttribute('aria-label', item?.thinkingLevel ? `Thinking level for Primary: ${item.thinkingLevel}` : 'Choose Primary thinking level');
}
function renderPrimaryUsage(item?: PrimaryView): void {
  const usage = usageFacts(item, item ? primaryBlocks(state, item.key) : undefined);
  renderStatusbarPrimary(item);
  byId('primary-usage').replaceChildren(...usageNodes(usage, !!item?.model || item?.lifecycle === 'ready' || !!item?.thinkingLevel));
}
export function usageNodes(usage: ReturnType<typeof usageFacts>, settings: boolean): HTMLElement[] {
  const bar = element('meter', 'context-bar');
  bar.min = 0; bar.max = 1; bar.low = 0.6; bar.high = 0.8; bar.optimum = 0;
  bar.value = usage.contextFraction ?? 0; bar.hidden = usage.contextFraction === null;
  bar.setAttribute('aria-label', 'Context usage');
  const groups: HTMLElement[] = []; let cache: HTMLElement | undefined;
  for (const fact of usage.facts) {
    const node = element('span', 'usage-fact', fact.text); node.dataset.key = fact.key; node.title = fact.title; node.setAttribute('aria-label', fact.title);
    if (fact.key.startsWith('cache')) {
      if (!cache) { cache = element('span', 'usage-group'); groups.push(cache); }
      cache.append(node); continue;
    }
    const group = element('span', 'usage-group');
    if (fact.key === 'context') group.append(bar);
    group.append(node); groups.push(group);
  }
  const nodes: HTMLElement[] = [];
  for (const group of groups) {
    if (nodes.length || settings) { const separator = element('span', 'usage-separator', '│'); separator.setAttribute('aria-hidden', 'true'); nodes.push(separator); }
    nodes.push(group);
  }
  return nodes;
}
export function renderStatusbarPrimary(item?: PrimaryView): void {
  renderStatusbarState(item);
  const folder = item?.cwd.split('/').filter(Boolean).at(-1);
  const node = byId('statusbar-folder'); setText(node, folder ?? ''); node.title = item?.cwd ?? ''; node.hidden = !folder;
}
function agentState(row?: AgentRow): string { return row?.availability !== 'live' ? row?.availability ?? 'stored' : row?.state ?? 'idle'; }
export function renderStatusbarState(item = primary()): void {
  const word = item ? primaryState(item) : 'no session';
  const node = byId('statusbar-state'); setText(node, `Primary · ${word}`); node.dataset.state = word;
  node.title = item?.sessionName ?? 'Primary';
}
export function renderTabActions(): void {
  const tab = activeTab(currentLayout()); const control = byId<HTMLButtonElement>('session-actions');
  control.disabled = !tab || (tab.kind === 'primary' && !primary());
  const label = tab?.kind === 'agent' ? 'Agent actions' : 'Session actions';
  control.setAttribute('aria-label', label); control.title = label;
}
export function openTabActions(): void {
  const tab = activeTab(currentLayout()); if (!tab) return;
  const origin = byId('session-actions'); const box = origin.getBoundingClientRect();
  contextMenu.open(origin, {x: box.right, y: box.bottom}, tab.kind === 'agent' ? 'Agent actions' : 'Session actions', tab.kind === 'agent' ? agentMenuItems(tab.identity) : primaryMenuItems(), captureMenuTarget());
}
export function renderStatusbarAgents(): void {
  const live = [...state.roster.values()].filter(row => row.availability === 'live');
  const working = live.filter(row => row.state === 'working').length;
  setText(byId('statusbar-agents'), `${live.length} live${working ? ` · ${working} working` : ''}`);
}
function primaryState(item: PrimaryView): string { return item.lifecycle !== 'ready' ? item.lifecycle : item.lastError ? 'failed' : item.activity; }
function primaryNavigation(item?: PrimaryView): void {
  const glyph = !item ? '○' : item.lifecycle === 'failed' || item.lastError ? '!' : primaryBusy(item) ? '●' : '○';
  const status = byId('primary-row-state'); setText(status, glyph);
  status.dataset.state = !item ? 'none' : ({'!': 'failed', '●': 'running', '○': 'idle'} as const)[glyph];
  setText(byId('primary-row-title'), item?.extension?.title ?? item?.sessionName ?? item?.sessionId ?? 'no session');
  setText(byId('primary-row-meta'), item ? primaryState(item) : '');
}
function primaryActivity(item?: PrimaryView, target?: Target): void {
  const conversation = target ? state.conversations.get(targetIdentity(target)) : undefined;
  const recovery = conversation?.recovery;
  renderPrimaryQueue(conversation?.queue);
  setText(byId('primary-activity'), item?.lifecycle === 'ready' && recovery?.kind === 'retry' && recovery.phase !== 'end' ? `Retrying${recovery.error ? ` after ${recovery.error}` : ''}${recovery.attempt ? ` · attempt ${recovery.attempt}` : ''}` : item?.lastError?.message ?? (item?.activity === 'retrying' ? 'Retrying' : ''));
  if (item?.lastError) byId('primary-activity').append(button('Review retry prompt…', () => actions.retryOutput()));
  byId('primary-stop').hidden = !(connected && primaryBusy(item, conversation?.queue?.pending));
}
export function renderPrimaryQueue(queue?: EventData['primary.queue']): void {
  const list = byId('primary-queued'); const rows: HTMLElement[] = [];
  for (const [mode, messages] of [['steer', queue?.steering], ['followUp', queue?.followUp]] as const) for (const text of messages ?? []) {
    const row = element('li', 'queued-message', `${mode === 'steer' ? 'steer' : 'follow-up'}: ${text}`);
    row.dataset.mode = mode; row.title = text; rows.push(row);
  }
  list.replaceChildren(...rows); list.hidden = !rows.length;
}
function renderPrimaryTranscript(): void {
  if (selectedAgent() && !splitActive()) return;
  const item = primary(); const target = primaryTarget();
  const blocks = item ? primaryBlocks(state, item.key) : [];
  if (item) primaryTranscript.set(blocks, target ? state.conversations.get(targetIdentity(target))?.tools : undefined);
  const presentation = primaryEmpty(item, blocks.some(entry => !['model_change', 'thinking_level_change'].includes(entry.kind) && entryVisible(entry)), !!target && historyReadyTarget === targetIdentity(target));
  const empty = byId('primary-empty'); empty.hidden = !presentation;
  if (presentation) {
    setText(byId('primary-empty-caption'), !item ? state.workspace?.primaryKey ? 'Loading the selected session' : 'No session. Open a project from the sidebar.' : presentation.caption);
  }
}
function renderRoster(): void {
  tabStrip.render(); renderStatusbarAgents();
  setText(byId('agent-count'), String(state.roster.size)); roster.set(state.rosterOrder.flatMap(id => { const row = state.roster.get(id); return row ? [row] : []; }), state.rosterMeta, selectedAgent());
  for (const identity of state.roster.keys()) renderMessageResume(identity);
}
function renderMessageResume(identity: string): void {
  const target = {kind: 'agent' as const, identity};
  const index = [...state.targetIndex.values()].find(item => sameTarget(item.target, target));
  roster.resume(identity, agentComposer.retained(state.workspace?.id ?? '', target, index) ?? false);
}
function renderMessagePanel(): void {
  const captured = messageTarget.current; const panel = byId('agent-message-panel');
  panel.hidden = !captured; if (!captured) return;
  const row = agentRow(captured.identity);
  setText(byId('agent-message-name'), row?.name ?? row?.handle ?? 'Agent');
  setText(byId('agent-message-identity'), captured.identity);
  byId('agent-message-identity').title = captured.identity;
  setText(byId('agent-message-status'), captured.error ?? captured.prepared?.reason ?? (captured.prepared ? '' : 'Preparing message…'));
  const form = byId('agent-composer'); if (form.parentElement !== panel) panel.append(form);
  agentComposer.placement(true); agentComposer.availability(connected, messageTarget.ready, false, selecting);
  if (captured.prepared) {
    const prepared = captured.prepared.targetState; const current = state.targets.get(prepared.targetKey);
    const saved = current && current.draft.revision >= prepared.draft.revision ? current : prepared;
    agentComposer.attach(captured.workspaceId, saved); agentComposer.receipts(state.operations.values());
  } else agentComposer.attachRetained(captured.workspaceId, {kind: 'agent', identity: captured.identity});
  byId('agent-status').hidden = true;
  byId('agent-abort').hidden = true; byId('agent-acquire').hidden = true;
}
function closeMessagePanel(focus = true): void {
  const identity = messageTarget.current?.identity; messageTarget.close();
  byId('agent-message-panel').hidden = true;
  agentComposer.attach(state.workspace?.id ?? '');
  renderRoster();
  if (focus && (!identity || byId('sidebar').hidden || !roster.focusMessage(identity))) primaryComposer.editor.focus();
}
function renderAgent(): void {
  const identity = selectedAgent(); if (!identity) return;
  const row = agentRow(identity); const saved = targetState({kind: 'agent', identity});
  if (saved?.targetKey !== agentTargetKey) {
    agentTargetKey = saved?.targetKey ?? ''; agentBefore = null; agentEarlier = undefined; earlierFeedback('agent', false); byId('agent-view-notice').replaceChildren(); byId('agent-facts').replaceChildren(); agentTranscript.reset(); agentTranscript.configure(saved?.presentation, saved?.reading);
  }
  agentTranscriptTarget = saved && state.workspace ? {workspaceId: state.workspace.id, saved, prefix: 'agent'} : undefined;
  const form = byId('agent-composer'); const detail = byId('agent-detail'); if (form.parentElement !== detail) detail.append(form);
  byId('agent-status').hidden = false;
  agentComposer.placement(false);
  agentComposer.availability(connected, row?.availability === 'live' && row.capabilities?.input === true, false, selecting);
  agentComposer.attach(state.workspace?.id ?? '', saved); agentComposer.receipts(state.operations.values());
  agentChrome(identity, row);
  agentAvailability(row); renderAvailability(); renderSplitNotice();
}
function agentTitle(identity: string, row?: AgentRow): void {
  tabStrip.render();
  document.title = `Pi · ${row?.name ?? row?.handle ?? identity} · ${agentState(row)}`;
}
export function agentChrome(identity: string, row?: AgentRow): void {
  agentTitle(identity, row);
  const conversation = state.conversations.get(targetIdentity({kind: 'agent', identity})); const frame = conversation?.frame;
  agentTranscript.set(conversation ? conversationBlocks(conversation) : []);
  setText(byId('agent-status'), frame?.status.model ? `${frame.status.model.provider}/${frame.status.model.modelId}${frame.status.thinkingLevel ? ` · ${frame.status.thinkingLevel}` : ''}` : row?.model ? `${row.model.provider}/${row.model.modelId}${row.thinkingLevel ? ` · ${row.thinkingLevel}` : ''}` : '');
  agentBefore = frame?.nextBefore ?? agentBefore; byId('agent-earlier').hidden = agentBefore === null;
  byId('agent-abort').hidden = !connected || row?.availability !== 'live' || !row?.capabilities?.input || !row?.capabilities?.abort;
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
function agentAvailability(row?: AgentRow): void {
  const availability = byId('agent-availability');
  if (row?.availability === 'live') setText(availability, '');
  else {
    setText(availability, row?.availability === 'incompatible' ? 'Host contract mismatch. This agent control is unavailable.' : 'Stored · no live compatible host');
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
  agentComposer.availability(connected, messageTarget.current ? messageTarget.ready : row?.availability === 'live' && row.capabilities?.input === true, frame?.status.busy ?? false, selecting);
  if (messageTarget.current) { byId('agent-abort').hidden = true; byId('agent-acquire').hidden = true; }
  if (!connected && (connectionPhase === 'offline' || connectionPhase === 'auth')) {
    if (identity) setText(byId('agent-availability'), 'Last observed');
  }
}
export async function selectAgent(row: AgentRow): Promise<void> {
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
  state = mergePrimaryPage(state, target, page.items); primaryCursor = page.nextCursor; byId('primary-earlier').hidden = !primaryCursor; renderPrimaryTranscript(); renderPrimaryUsage(primary());
  if (cursor) historyFeedback('primary', `Loaded earlier history · ${page.items.length} entries`);
  else if (!selectedAgent() || splitActive()) primaryTranscript.restore(targetState(target)?.reading);
}
function primaryHistoryFailure(error: unknown, controller: AbortController, cursor?: string): void {
  if (controller.signal.aborted) return;
  if (cursor) historyFeedback('primary', `Earlier history unavailable: ${errorMessage(error)}`); else showError(error);
}
function earlierFeedback(prefix: 'primary' | 'agent', pending: boolean): void {
  const control = byId<HTMLButtonElement>(`${prefix}-earlier`); control.disabled = pending;
  setText(control, pending ? '↑ earlier…' : '↑ earlier');
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
function saveReading(captured: TranscriptTarget | undefined, reading: TargetState['reading']): Promise<void> {
  return saveView(captured, 'reading', {anchorId: reading.anchorId, offsetPx: reading.offsetPx, followTail: reading.followTail});
}
function savePresentation(captured: TranscriptTarget | undefined, expanded: string[], showThinking: boolean): Promise<void> {
  return saveView(captured, 'presentation', {expanded: expanded.slice(), showThinking});
}
async function saveView(captured: TranscriptTarget | undefined, kind: 'reading' | 'presentation', values: object): Promise<void> {
  if (!captured || !connected || captured.workspaceId !== state.workspace?.id) return;
  const {saved, workspaceId, prefix} = captured;
  const notice = byId(`${prefix}-view-notice`);
  try { await preferences.save(`${workspaceId}/${saved.targetKey}/${kind}`, async () => {
    const latest = state.targets.get(saved.targetKey) ?? saved;
    const result = await request<TargetState['reading'] | NonNullable<TargetState['presentation']>>(`/api/workspaces/${encodeURIComponent(workspaceId)}/targets/${encodeURIComponent(saved.targetKey)}/${kind}`, 'PUT', {expectedRevision: latest[kind]?.revision ?? 0, ...values});
    const current = state.targets.get(saved.targetKey) ?? saved;
    if (result.revision >= (current[kind]?.revision ?? 0)) state = {...state, targets: new Map(state.targets).set(saved.targetKey, {...current, [kind]: result})};
    if (notice.dataset.kind === kind) notice.replaceChildren();
  }); } catch (error) {
    notice.dataset.kind = kind; notice.replaceChildren(element('p', 'error', `View not saved for ${targetIdentity(saved.target)}: ${errorMessage(error)}`), button('Reload saved view', () => { void reload().then(() => {
      if ((prefix === 'primary' ? primaryTranscriptTarget : agentTranscriptTarget)?.saved.targetKey !== saved.targetKey) return;
      const latest = state.targets.get(saved.targetKey); const transcript = prefix === 'primary' ? primaryTranscript : agentTranscript;
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
function noticesBadge(): void { const unread = unreadNotices(state); setText(byId('notices-count'), String(unread)); byId('notices-count').hidden = !unread; byId('notices-button').setAttribute('aria-label', unread ? `Notifications (${unread} unread)` : 'Notifications'); }
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
function inspectAgent(identity = selectedAgent()): void {
  if (!identity || !agentRow(identity)?.capabilities?.inspect) return;
  modal.open('Agent activity').append(element('p', 'identity', identity)); const token = modal.token;
  void modal.run(async () => {
    const data = await request(`/api/agents/${encodeURIComponent(identity)}/inspect`, 'POST', {view: 'activity', limit: 20});
    if (modal.owns(token)) modal.body.append(details('Reported activity', rawText(data)));
  }, false);
}
function captureMenuTarget(): () => boolean {
  const workspace = state.workspace?.id; const target = state.workspace?.selectedTarget ? targetIdentity(state.workspace.selectedTarget) : '';
  const primaryKey = primary()?.key; const epoch = primary()?.epoch; const active = currentLayout().active;
  return () => workspace === state.workspace?.id && target === (state.workspace?.selectedTarget ? targetIdentity(state.workspace.selectedTarget) : '') &&
    primaryKey === primary()?.key && epoch === primary()?.epoch && active === currentLayout().active;
}
function primaryMenuItems(): ContextItem[] {
  return actions.sessionMenuEntries().filter(item => !['Resume saved session', 'Appearance', 'Help', 'Saved drafts and input copies'].includes(item.name))
    .map(item => ({label: item.name, enabled: item.enabled, run: item.run}));
}
function agentMenuItems(identity: string): ContextItem[] {
  const row = agentRow(identity); if (!row) return [];
  const items: ContextItem[] = [
    {label: 'Open', run: () => { void selectAgent(row).catch(showError); }},
    {label: 'Open beside Primary', run: () => { try { const layout = openTab(currentLayout(), {kind: 'agent', identity, split: true}); applyLayout({...layout, tabs: layout.tabs.map(tab => tab.kind === 'agent' && tab.identity === identity ? {...tab, split: true} : tab)}); } catch (error) { showError(error); } }},
    {label: 'Message', enabled: connected && row.availability === 'live' && row.capabilities?.input === true, run: () => openAgentMessage(identity)},
    {label: 'Copy identity', run: () => { void copy(identity, byId('agent-view-notice')); }},
  ];
  if (row.capabilities?.inspect) items.push({label: 'Inspect activity…', run: () => inspectAgent(identity)});
  if (row.availability !== 'live' && primary()?.lifecycle === 'ready') items.push({label: 'Reconnect through Primary', run: () => actions.prepareText(`/agent attach ${identity}`)});
  return items;
}
function tabMenuItems(key: string): ContextItem[] {
  const layout = currentLayout(); const tab = layout.tabs.find(item => tabKey(item) === key); if (!tab) return [];
  const locate = () => currentLayout().tabs.findIndex(item => tabKey(item) === key);
  const items: ContextItem[] = [
    {label: 'Activate', run: () => { const index = locate(); if (index >= 0) applyLayout({...currentLayout(), active: index}); }},
    {label: 'Close', run: () => applyLayout(closeTab(currentLayout(), locate()))},
    {label: 'Close others', enabled: layout.tabs.length > 1, run: () => { const current = currentLayout(); const item = current.tabs[locate()]; if (item) applyLayout({...current, tabs: [item], active: 0}); }},
  ];
  if (tab.kind === 'agent') items.push({label: tab.split ? 'Unsplit' : 'Split beside Primary', run: () => { const current = currentLayout(); const index = locate(); if (index >= 0) applyLayout(toggleSplit({...current, active: index})); }});
  return items;
}
function paneMenuItems(pane: HTMLElement): ContextItem[] {
  const prefix = pane.id === 'primary' ? 'primary' : 'agent';
  const active = activeTab(currentLayout());
  const items: ContextItem[] = [{label: 'Focus message box', run: () => byId(`${prefix}-editor`).focus()}];
  if (active?.kind === 'agent') items.push({label: active.split ? 'Unsplit' : 'Split beside Primary', run: () => applyLayout(toggleSplit(currentLayout()))});
  const identity = selectedAgent();
  items.push(...(prefix === 'primary' ? primaryMenuItems() : identity ? agentMenuItems(identity) : []));
  return items;
}
function contextItems(origin: HTMLElement): {label: string; items: ContextItem[]} {
  if (origin.classList.contains('conversation-tab')) return {label: 'Tab actions', items: tabMenuItems(origin.dataset.tabKey ?? '')};
  if (origin.classList.contains('agent-row')) return {label: 'Agent actions', items: agentMenuItems(origin.dataset.identity ?? '')};
  if (origin.id === 'primary-row') return {label: 'Primary actions', items: [{label: 'Open', run: selectPrimary}, ...primaryMenuItems()]};
  return {label: 'Pane actions', items: paneMenuItems(origin)};
}
export function appContextMenu(event: MouseEvent): void {
  if (event.defaultPrevented || nativeEditingTarget(event.target) || modal.openNow) return;
  const target = event.target as HTMLElement | null;
  const tab = target?.closest<HTMLElement>('.conversation-tab');
  const row = target?.closest<HTMLElement>('.agent-row');
  const primaryRow = target?.closest<HTMLElement>('#primary-row');
  const pane = target?.closest<HTMLElement>('.conversation');
  const origin = tab ?? row ?? primaryRow ?? pane; if (!origin) return;
  const {items, label} = contextItems(origin);
  if (!items.length) return;
  event.preventDefault(); event.stopPropagation();
  if (row || pane) origin.tabIndex = -1;
  const captured = captureMenuTarget();
  contextMenu.open(origin, {x: event.clientX, y: event.clientY}, label, items, () => origin.isConnected && captured());
}
function paletteModeForKey(event: KeyboardEvent): 'commands' | 'goto' | undefined {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'p') return event.shiftKey ? 'commands' : 'goto';
  if (key === 'k' && !event.shiftKey) return 'commands';
  return undefined;
}
export function appKey(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || contextMenu.openNow) return;
  if (event.key === 'Escape' && messageTarget.current && !modal.openNow) { event.preventDefault(); closeMessagePanel(); return; }
  if (event.key === 'Escape' && drawerOpen && !modal.openNow) { event.preventDefault(); toggleSidebar(false); return; }
  if (!modal.openNow && event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'PageUp' || event.key === 'PageDown')) {
    event.preventDefault(); applyLayout(switchTab(currentLayout(), event.key === 'PageDown' ? 1 : -1)); tabStrip.focusActive(); return;
  }
  const mode = paletteModeForKey(event); if (!mode) return;
  event.preventDefault(); if (!event.repeat && !modal.openNow) actions.palette(mode);
}
function bind(): void {
  document.addEventListener('contextmenu', appContextMenu);
  byId('session-actions').setAttribute('aria-haspopup', 'menu');
  byId('tab-split').addEventListener('click', () => applyLayout(toggleSplit(currentLayout())));
  byId('tabs-open-primary').addEventListener('click', selectPrimary);
  new ResizeObserver(renderNavigation).observe(byId('conversation-panes'));
  matchMedia('(pointer: coarse)').addEventListener('change', renderNavigation);
  byId('project-button').addEventListener('click', () => actions.projectPicker());
  byId('session-new').addEventListener('click', () => { if (primary()) actions.newSession(); else actions.projectPicker(); });
  byId('agent-refresh').addEventListener('click', refreshRoster);
  byId('agent-new').addEventListener('click', () => actions.prepareText('/agent new'));
  byId('appearance-button').addEventListener('click', () => actions.appearance());
  byId('session-actions').addEventListener('click', openTabActions);
  byId('commands-button').addEventListener('click', () => actions.palette());
  byId('primary-heading').addEventListener('click', () => setSidebarSection('primary', !sidebarSections.primary));
  byId('agents-heading').addEventListener('click', () => setSidebarSection('agents', !sidebarSections.agents));
  byId('statusbar-agents').addEventListener('click', focusAgentSearch);
  byId('model-button').addEventListener('click', () => actions.modelPicker()); byId('thinking-button').addEventListener('click', () => actions.thinkingPicker());
  byId('notices-button').addEventListener('click', notices);
  byId('agent-message-close').addEventListener('click', () => closeMessagePanel());
  byId('agent-acquire').addEventListener('click', () => { if (messageTarget.current) return; const identity = selectedAgent(); if (connected && identity) actions.prepareText(`/agent attach ${identity}`); });
  byId('primary-row').addEventListener('click', selectPrimary);
  byId('sidebar-show').addEventListener('click', () => toggleSidebar(true));
  byId('skip-composer').addEventListener('click', event => { event.preventDefault(); focusEditor(); });
  byId('agent-facts').addEventListener('toggle', renderAgent, true);
  byId('primary-earlier').addEventListener('click', () => { void loadPrimaryHistory(primaryCursor ?? undefined); }); byId('agent-earlier').addEventListener('click', () => { void loadAgentHistory().catch(showError); });
  byId('primary-stop').addEventListener('click', () => { const target = primaryTarget(); if (target?.kind !== 'primary') return; setText(byId('primary-receipt'), 'Stop requested'); void operation('primary.stop', `/api/primaries/${encodeURIComponent(target.key)}/stop`, {epoch: target.epoch}, target).then(showOperation).catch(showError); });
  byId('agent-abort').addEventListener('click', () => { if (messageTarget.current) return; const identity = selectedAgent(); if (!identity) return; modal.confirm('Abort selected agent', `${identity}\nThis requests foreground abort only. Background work and timers remain separate.`, async () => { setText(byId('agent-receipt'), 'Abort requested'); showOperation(await operation('agent.abort', `/api/agents/${encodeURIComponent(identity)}/abort`, {background: false}, {kind: 'agent', identity})); }, 'Abort'); });
  document.addEventListener('keydown', appKey);
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
