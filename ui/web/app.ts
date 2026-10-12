import type { AgentHistoryPage, AgentRow, Bootstrap, EventData, HistoryPage, OperationView, PrimaryView, ProjectedFrame, Snapshot, Target, TargetState, Workspace } from '../shared/api.ts';
import { Actions } from './actions.ts';
import type { ConversationLayout, ConversationTab } from '../shared/api.ts';
import { activeTab, closeTab, duplicateIdentityTails, layoutTarget, openTab, switchTab, tabForTarget, tabKey, workspaceLayout } from './tabs.ts';
import { paneLeaves, paneById, activatePaneTab, movePaneTab, resizePaneSplit, minimumPaneSize, paneSplitGeometry, splitPane, normalizePaneLayout, samePaneLayout, type PaneLeaf } from './pane-layout.ts';
import { TabStrip } from './tabs-view.ts';
import { cardAction, cardIcon, controlIcon, type CardIcon } from './card-icons.ts';
import { contextMenu, nativeEditingTarget, paneMenuItems, type ContextItem } from './context-menu.ts';
import { ProjectPicker } from './picker.ts';
import type { SelectionChange } from './actions.ts';
import { Composer, createComposerElements } from './composer.ts';
import { WorkbenchStatus } from './workbench-status.ts';
import { VersionStatus } from './version-status.ts';
import { ConnectionRecovery, accessViewVisible, connectionSurface as connectionSurfaceFor, type ConnectionPhase } from './connection-state.ts';
import { announce, byId, button, copy, details, element, empty, rawText, setText } from './dom.ts';
import { ExtensionDialogs, extensionStatus } from './extensions.ts';
import { Modal } from './modal.ts';
import { Transcript } from './render.ts';
import { ReferenceResolver, type ReferenceDestination, type ReferenceQuery, type ReferenceResolution } from './references.ts';
import { imageUrl } from './image.ts';
import { historyBecameReady, pageToReadingAnchor } from './transcript-history.ts';
import { Roster } from './roster.ts';
import { Recovery } from './recovery.ts';
import { conversationBlocks, createState, dismissNotice, markReadNotices, unreadNotices, mergeRosterPage, mergeAgentPage, mergePrimaryPage, primaryBlocks, reduceEvent, replaceSnapshot, targetIdentity } from './state.ts';
import type { UiEvent } from './state.ts';
import { hydrateVisible, refreshVisible } from './hydrate.ts';
import { MessageTarget, SelectionQueue, navigationState } from './selection-state.ts';
import { usageFacts } from './usage.ts';
import { createResizer, type Resizer } from './resize.ts';
import { entryVisible } from './entry-presentation.ts';
import { primaryBusy, primaryEmpty } from './primary-presentation.ts';
import { inputOperation, operationLabel } from './operation-label.ts';
import { PreferenceQueue } from './preference-queue.ts';
import { BrowserDiagnostics } from './diagnostics.ts';
import {DevReload, type DevReloadCheckpoint, type DevReloadHooks, type DevCheckpointEntry, type DevReloadHold} from './dev-reload.ts';
import { conversationPresentation, presentationGlyph, projectIdentity, composerFolder, agentViewStatus } from './conversation-presentation.ts';
import type { ConversationPresentation } from './conversation-presentation.ts';
import { newerOperation, mergeOperationMap } from './operation-state.ts';
import { ApiError, authenticate, connect, errorMessage, operation, request, setUnauthorizedHandler, setRequestTiming } from './transport.ts';
import type { ReceivedEvent } from './transport.ts';

export let state = createState();
let snapshot: Bootstrap | Snapshot | undefined;
let launchCwd: string | undefined;
let source: EventSource | undefined;
let connected = false;
export let drawerOpen = false;
let connectionPhase: ConnectionPhase = 'healthy';
let connectionError: unknown;
let connectionSurface = '';
let accessRequired = false;
let accessFocus: HTMLElement | undefined;
let streamWait: {resolve: () => void; reject: (error: unknown) => void} | undefined;
let resynchronizing: Promise<void> | undefined;

type TranscriptTarget = {workspaceId: string; saved: TargetState; controller: ConversationController};

let selecting = false;
type Pane = string;
export let focusedPane: Pane = 'pane-1';
export function focusPane(pane: Pane): void {
  const leaf = paneById(currentLayout(), pane); if (!leaf) return;
  applyLayout({...currentLayout(), focusedPane: pane});
  const tab = leaf.tabs.find(tab => tabKey(tab) === leaf.active), target = tab ? controllerTarget(tab) : undefined;
  if (target) conversationController(target).composer.focus();
}
function updatePaneFocus(pane: Pane): void { if (focusedPane !== pane) applyLayout({...currentLayout(), focusedPane: pane}); }
function markFocusedPane(): void {
  for (const [id, pane] of paneRegions) pane.node.dataset.focused = String(id === focusedPane);
  renderWorkbenchStatus();
}
let reloadTail = Promise.resolve();
const snapshotBuffers = new Set<{events: UiEvent[]; bytes: number; overflow: boolean}>();
const modal = new Modal(focusEditor);
const preferences = new PreferenceQueue();
const diagnostics = new BrowserDiagnostics();
new VersionStatus(() => modal.open('Copy UI version identity'));
let diagnosticsActive = false;
let devReload: DevReload | undefined;
let devInteractionRevision = 0;
let devNavigating = false;
const devCheckpointKey = 'ui:dev-checkpoint';
type ConversationController = {workspaceId: string; target: Target; instanceId: string; root: HTMLElement; nodes: Map<string, HTMLElement>;
  elements: import('./composer.ts').ComposerElements; composer: Composer; transcript: Transcript; saved?: TargetState; geometry?: ReturnType<Transcript['captureGeometry']>;
  abort: AbortController; historyAbort: AbortController; cursor: string | null; before: number | null; loading: boolean; preparing: boolean; historyReady: boolean; historyComplete?: boolean; historyError?: {code?: string; message: string}; hasEntries?: boolean; initialized: boolean; showThinking: boolean; historyWork?: Promise<void>; connectionError?: string; resizer?: Resizer};
const controllers = new Map<string, ConversationController>();
let controllerSerial = 0;
function controllerKey(workspace: string, target: Target): string { return JSON.stringify([workspace, targetIdentity(target)]); }
function controllerNode(controller: ConversationController, key: string): HTMLElement {
  const node = controller.nodes.get(key); if (!node) throw new Error('Conversation control is missing.'); return node;
}
function primaryNode<T extends HTMLElement = HTMLElement>(key: string): T { const target = primaryTarget(); if (!target) throw new Error('No Primary is selected.'); return controllerNode(conversationController(target), key) as T; }
function agentNode<T extends HTMLElement = HTMLElement>(key: string): T { const identity = selectedAgent(); if (!identity) throw new Error('No agent is selected.'); return controllerNode(conversationController({kind: 'agent', identity}), key) as T; }
function controllerTarget(tab: ConversationTab): Target | undefined { return tab.kind === 'agent' ? {kind: 'agent', identity: tab.identity} : primaryTarget(); }
export function primaryComposer(): Composer { const target = primaryTarget(); if (!target) throw new Error('No Primary is selected.'); return conversationController(target).composer; }
export function agentComposer(): Composer { const identity = selectedAgent(); if (!identity) throw new Error('No agent is selected.'); return conversationController({kind: 'agent', identity}).composer; }
function focusedTranscript(): Transcript | undefined {
  const target = layoutTarget(currentLayout(), primaryTarget());
  return target && state.workspace ? controllers.get(controllerKey(state.workspace.id, target))?.transcript : undefined;
}
function conversationController(target: Target): ConversationController {
  const workspaceId = state.workspace?.id; if (!workspaceId) throw new Error('No workspace is selected.');
  const key = controllerKey(workspaceId, target); const existing = controllers.get(key); if (existing) return existing;
  collectControllers(); if (controllers.size >= 16) throw new Error('Close a settled conversation before opening another.');
  const instanceId = `conversation-${++controllerSerial}`; const root = element('section', 'conversation'); root.id = instanceId; root.hidden = true; root.inert = true;
  const nodes = new Map<string, HTMLElement>(); const add = (name: string, tag: 'div' | 'p' | 'h2' | 'button', css?: string): HTMLElement => {
    const node = element(tag, css); node.id = `${instanceId}-${name}`; nodes.set(name, node); return node;
  };
  const observed = add('observed', 'div', 'last-observed'); observed.textContent = 'Last observed'; observed.hidden = true;
  const notice = add('view-notice', 'div', 'availability'); notice.setAttribute('role', 'status');
  const earlier = add('earlier', 'button') as HTMLButtonElement; earlier.type = 'button'; controlIcon(earlier, 'earlier', 'Earlier messages'); earlier.hidden = true;
  const region = element('div', 'transcript-region'); const absent = add('empty', 'div', 'empty-state'); absent.hidden = true;
  if (target.kind === 'primary') absent.append(add('empty-heading', 'h2'), add('empty-caption', 'p'));
  const scroller = add('transcript', 'div', 'transcript'); scroller.tabIndex = 0; scroller.setAttribute('aria-label', 'Conversation messages');
  const latest = add('latest', 'button', 'latest') as HTMLButtonElement; latest.type = 'button'; controlIcon(latest, 'latest', 'Latest message'); latest.hidden = true;
  region.append(absent, scroller, latest); const above = add('widgets-above', 'div', 'widgets'), below = add('widgets-below', 'div', 'widgets');
  const elements = createComposerElements(instanceId); elements.root.hidden = false;
  for (const [name, node] of Object.entries(elements)) if (node) nodes.set(name === 'root' ? 'composer' : name, node);
  const stop = elements.root.querySelector<HTMLButtonElement>('.stop'); if (!stop) throw new Error('Stop control is missing.'); nodes.set('stop', stop); nodes.set('abort', stop);
  const resize = elements.root.querySelector<HTMLElement>('.resizer'); if (resize) nodes.set('composer-resizer', resize);
  const activity = add('activity', 'p', 'exception'); activity.setAttribute('role', 'status'); const queued = element('ul', 'queued-list'); queued.hidden = true; queued.setAttribute('aria-label', 'Queued messages'); nodes.set('queued', queued); elements.root.prepend(activity, queued);
  root.append(observed, notice, region, above, elements.root, below);
  if (target.kind === 'agent') root.insertBefore(createAgentState(add), region);
  const controller = {workspaceId, target: {...target}, instanceId, root, nodes, elements, abort: new AbortController(), historyAbort: new AbortController(), cursor: null, before: null, loading: false, preparing: false, historyReady: false, initialized: false, showThinking: false} as ConversationController;
  controller.composer = new Composer(elements, {timing: (start, end) => {if (controller.workspaceId === state.workspace?.id && !elements.root.closest('[hidden],[inert]')) diagnostics.measure('editor-echo', start, end);}, submitted: result => showOperation(result, workspaceId), unknownCommand: (text, literal) => target.kind === 'primary' && sameTarget(primaryTarget(), target) ? actions.unknown(text, literal) : false,
    ...(target.kind === 'primary' ? {commands: () => actions.commandOptions(), moreCommands: (captured: Target) => actions.continueCommands(captured)} : {}),
    retained: (workspace, captured) => { if (workspace === state.workspace?.id && captured.kind === 'agent') renderMessageResume(captured.identity); }});
  controller.transcript = new Transcript({transcript: scroller, latest, earlier}, {references, timing: (metric, start, end) => {diagnostics.measure(metric, start, end);},
    presentation: (expanded, thinking, view) => { controller.showThinking = thinking; void savePresentation(controllerCapture(controller), expanded, thinking, view); },
    reading: reading => { void saveReading(controllerCapture(controller), reading); },
    ...(target.kind === 'primary' ? {fork: (message: import('../shared/api.ts').MessageView, entry: string) => { if (sameTarget(target, primaryTarget())) actions.fork(entry, rawText(message.parts)); }, output: (more: import('../shared/api.ts').OutputContinuation) => loadControllerOutput(controller, more)} : {}),
    image: part => imageUrl(part, controller.target, controller.workspaceId)});
  earlier.addEventListener('click', () => { void loadControllerHistory(controller, true); });
  stop.addEventListener('click', () => { void stopController(controller); });
  elements.editor.addEventListener('focus', () => { footerController = controller; renderWorkbenchStatus(); });
  controllers.set(key, controller); return controller;
}
function createAgentState(add: (name: string, tag: 'div' | 'p' | 'button', css?: string) => HTMLElement): HTMLElement {
  const status = add('agent-state', 'div', 'agent-state'); status.hidden = true; status.setAttribute('aria-label', 'Agent status');
  const line = add('agent-state-line', 'p'); line.setAttribute('role', 'status');
  const row = add('agent-state-actions', 'div', 'agent-state-actions');
  for (const [key, label] of [['history-retry', 'Retry'], ['start', 'Start agent'], ['start-in-pi', 'Start in Pi']] as const) {
    const action = add(key, 'button') as HTMLButtonElement; action.type = 'button'; action.textContent = label; row.append(action);
    if (key === 'start') action.title = 'Start agent. This can resume unfinished work before the agent is ready.';
  }
  status.append(line, row); return status;
}
function controllerCapture(controller: ConversationController): TranscriptTarget | undefined {
  return controller.saved ? {workspaceId: controller.workspaceId, saved: controller.saved, controller} : undefined;
}
function collectControllers(): void {
  const open = new Set(paneLeaves(currentLayout().root).flatMap(pane => pane.tabs).flatMap(tab => { const target = controllerTarget(tab); return target && state.workspace ? [controllerKey(state.workspace.id, target)] : []; }));
  const message = messageTarget.current; if (message) open.add(controllerKey(message.workspaceId, {kind: 'agent', identity: message.identity}));
  for (const [key, controller] of controllers) {
    const awaitingDraft = controller.workspaceId === state.workspace?.id && (controller.composer.serverDraftRevision ?? 0) > (targetState(controller.target)?.draft.revision ?? 0);
    if (open.has(key) || !controller.composer.canDispose || preferences.pending || awaitingDraft) continue;
    controller.abort.abort(); controller.historyAbort.abort(); controller.resizer?.destroy(); controller.transcript.destroy(); controller.composer.destroy(); controller.root.remove(); controller.elements.root.remove(); controllers.delete(key);
  }
}
async function loadControllerOutput(controller: ConversationController, more: import('../shared/api.ts').OutputContinuation): Promise<import('../shared/api.ts').OutputPage> {
  const target = controller.target; if (target.kind !== 'primary') throw new Error('Output is unavailable.');
  const page = await request<import('../shared/api.ts').OutputPage>(`/api/primaries/${encodeURIComponent(target.key)}/history/output?epoch=${target.epoch}&entry=${encodeURIComponent(more.entryId)}&part=${more.part}&offset=${more.offset}`, 'GET', undefined, undefined, controller.abort.signal);
  if (controller.abort.signal.aborted || controller.workspaceId !== state.workspace?.id) throw new Error('The conversation changed.'); return page;
}
let footerController: ConversationController | undefined;
const workbenchStatus = new WorkbenchStatus();
const messageTarget = new MessageTarget({workspace: () => state.workspace, prepare: (workspaceId, target) => request(`/api/workspaces/${encodeURIComponent(workspaceId)}/targets`, 'POST', {target}), paint: renderMessagePanel});
const references = new ReferenceResolver(resolveReference, destination => { void navigateReference(destination).catch(showError); });
const actions: Actions = new Actions({snapshot: currentSnapshot, primary, get composer() { return primaryComposer(); }, commandsChanged: () => {const target = primaryTarget(); if (target && state.workspace) controllers.get(controllerKey(state.workspace.id, target))?.composer.commandsChanged();}, modal, selection, reload: reloadSelection, result: showOperation, rosterRefresh: refreshRoster, find: query => focusedTranscript()?.find(query), recovery: () => recovery.open(), primaryEntries: () => primary() ? primaryBlocks(state, primary()?.key ?? '') : [], agents: () => state.rosterOrder.flatMap(identity => { const row = agentRow(identity); return row ? [row] : []; }), selectedAgent: () => { const identity = selectedAgent(); return identity ? agentRow(identity) ?? {identity, storageId: '', cwd: '', availability: 'stored'} : undefined; }, selectAgent: row => { void selectAgent(row).catch(showError); }, notices, sidebar: toggleSidebar, view: (tools, expand) => focusedTranscript()?.expandLoaded(tools, expand), selectPrimary, agentStatus: row => presentation({kind: 'agent', identity: row.identity}).activity, conversationFacts: identity => agentFacts(agentRow(identity), state.conversations.get(targetIdentity({kind: 'agent', identity}))?.frame), copyAgent: () => { void copy(selectedAgent() ?? '', agentNode('view-notice')); }, inspectAgent,
  tabs: {close: () => { const tab = activeTab(currentLayout()); if (tab) applyLayout(closeTab(currentLayout(), tabKey(tab))); }, switch: direction => applyLayout(switchTab(currentLayout(), direction)), layout: currentLayout},
});
const paneRegions = new Map<string, {node: HTMLElement; tabs: HTMLElement; content: HTMLElement; plus: HTMLButtonElement; menu: HTMLButtonElement; previous: HTMLButtonElement; next: HTMLButtonElement}>();
const paneSplits = new Map<string, {node: HTMLElement; handle: HTMLElement; resizer?: Resizer; extent?: number}>();
const tabStrip = new TabStrip({layout: currentLayout, activate: activateConversationTab, close: key => applyLayout(closeTab(currentLayout(), key)),
  move: (key, pane, index) => applyLayout(movePaneTab(currentLayout(), key, pane, index)), label: tabLabel,
  status: tab => { const view = tabPresentation(tab); return {label: [view.activity, view.tool?.name].filter(Boolean).join(' · '), glyph: presentationGlyph(view)}; },
  overflow: (overflow, pane) => { const region = paneRegions.get(pane); if (region) region.menu.dataset.overflow = String(overflow); }},
  {panes: () => [...paneRegions].map(([id, pane]) => ({id, tabs: pane.tabs, controls: pane.content.id})), conversations: byId('sidebar-conversations')});
const picker = new ProjectPicker({snapshot: currentSnapshot, primary, modal, selection, reload: reloadSelection, project: projectPath, projectsChanged: renderIdentity});
actions.projectPicker = () => picker.open(projectPath());
const recovery = new Recovery({snapshot: currentSnapshot, reload, modal});
const roster = new Roster(row => { void selectAgent(row).catch(showError); }, action => { if (action === 'refresh') refreshRoster(); else moreRoster(); }, {
  load: (cursor, signal) => request<import('../shared/api.ts').CachedRoster>(`/api/agents?limit=20&cursor=${encodeURIComponent(cursor)}`, 'GET', undefined, undefined, signal),
  merge: page => { state = mergeRosterPage(state, page); renderRoster(); },
}, openAgentMessage, row => { const view = presentation({kind: 'agent', identity: row.identity}); return {glyph: presentationGlyph(view), label: view.activity, tool: view.tool}; });
function openAgentMessage(identity: string): void {
  let controller: ConversationController; try {controller = conversationController({kind: 'agent', identity});} catch (error) {showError(error); return;}
  const preparing = messageTarget.open(identity), captured = messageTarget.current;
  if (captured?.prepared) controller.composer.editor.focus(); else byId('agent-message-close').focus();
  void preparing.then(() => { if (captured && messageTarget.valid(captured) && captured.prepared && document.activeElement === byId('agent-message-close')) controller.composer.editor.focus(); }).catch(showError);
}
const extensionDialogs = new ExtensionDialogs(modal, () => state, next => { state = next; }, primary);
const connectionRecovery = new ConnectionRecovery({attempt: resync, unauthorized: error => error instanceof ApiError && error.view.code === 'unauthorized', paint: (phase, error) => {
  connectionPhase = phase; connectionError = error; connected = phase === 'healthy'; renderConnection();
  if (connected) {renderAll(); void finishStartup().catch(showError);} else renderAvailability();
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
function composerResizer(controller: ConversationController): Resizer {
  const composer = controller.composer, key = `ui:pane:${controller.workspaceId}:${targetIdentity(controller.target)}:composer`; let preferred = tabSize(key, 40, 640); composer.setManualHeight(preferred);
  return createResizer({handle: controllerNode(controller, 'composer-resizer'), axis: 'y', direction: -1, min: 40, max: 640, defaultValue: 144, applyInitial: preferred !== undefined,
    read: () => preferred ?? composer.editor.offsetHeight, write: value => composer.setManualHeight(value), onCommit: value => {preferred = value; storeTabSize(key, value);},
    onReset: () => {preferred = undefined; storeTabSize(key, undefined); composer.setManualHeight(undefined);}});
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
      createResizer({handle: byId('sidebar-resizer'), axis: 'x', min: 200, max: 480, defaultValue: 248,
        read: () => state.workspace?.sidebarWidth ?? 248,
        write: value => app.style.setProperty('--sidebar-width', `${value}px`),
        onCommit: value => {void selectionQueue.select({sidebarWidth: value}).catch(showError);}}),

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
function presentation(target?: Target): ConversationPresentation {
  const row = target?.kind === 'agent' ? agentRow(target.identity) : undefined;
  const tool = target?.kind === 'primary' ? [...state.conversations.get(targetIdentity(target))?.tools.values() ?? []].findLast(item => item.phase !== 'end') : undefined;
  return conversationPresentation({target, primary: target?.kind === 'primary' ? state.primaries.get(target.key) : undefined,
    row, availability: target?.kind === 'agent' ? state.agentAvailability.get(target.identity) : undefined,
    frame: target ? state.conversations.get(targetIdentity(target))?.frame : undefined, tool: tool ? {name: tool.name, argument: tool.argumentText ?? ''} : undefined, connected});
}
function tabPresentation(tab: ConversationTab): ConversationPresentation { return presentation(controllerTarget(tab)); }
function activePresentation(): ConversationPresentation { return presentation(layoutTarget(currentLayout(), primaryTarget()) ?? undefined); }
function projectPath(): string | undefined { return projectIdentity(activePresentation(), launchCwd).path; }
function renderWorkbenchStatus(): void {
  const selected = layoutTarget(currentLayout(), primaryTarget()) ?? undefined;
  const editingMessage = footerController && messageTarget.current?.identity === (footerController.target.kind === 'agent' ? footerController.target.identity : undefined) && footerController.elements.root.contains(document.activeElement);
  const target = editingMessage ? footerController?.target : selected;
  const controller = target ? conversationController(target) : undefined; footerController = controller;
  const skip = byId<HTMLAnchorElement>('skip-composer'); skip.href = controller ? `#${controller.composer.editor.id}` : '#session-new';
  const view = presentation(target); workbenchStatus.update(target?.kind ?? 'primary', view.name, view.activity, target?.kind === 'agent' ? target.identity : target?.key);
  const slot = byId('focused-composer-status'), nodes = controller ? [controller.elements.save, controller.elements.receiptDetails] : [];
  if (slot.children.length !== nodes.length || nodes.some((node, index) => slot.children[index] !== node)) slot.replaceChildren(...nodes);
  if (target?.kind === 'agent') renderAgentSettings(view, target);
}
function renderIdentity(): void {
  renderWorkbenchStatus();
  const view = activePresentation(); const project = projectIdentity(view, launchCwd, picker.projectPaths());
  for (const prefix of ['', 'compact-']) {
    const name = byId(`${prefix}project-name`), control = byId(`${prefix}project-button`);
    setText(name, project.name); name.title = project.path ?? 'No working folder selected';
    control.title = project.path ? `Working folder: ${project.path}` : 'Choose working folder';
    control.setAttribute('aria-label', 'Choose working folder');
    control.setAttribute('aria-description', project.path ?? 'No working folder selected');
  }
  document.title = accessRequired ? 'Pi · Browser access required' : view.activity ? `Pi · ${view.name} · ${view.activity}` : `Pi · ${project.name}`;
  for (const controller of controllers.values()) controllerNode(controller, 'observed').hidden = connected || !presentation(controller.target).activity;
}
function selectedAgent(): string | undefined { return state.workspace?.selectedTarget?.kind === 'agent' ? state.workspace.selectedTarget.identity : undefined; }
function targetState(target?: Target): TargetState | undefined {
  if (!target) return undefined; const identity = targetIdentity(target);
  return [...state.targets.values()].find(item => targetIdentity(item.target) === identity);
}
function sameTarget(a?: Target, b?: Target): boolean { return !!a && !!b && targetIdentity(a) === targetIdentity(b); }
function currentLayout(): ConversationLayout { return workspaceLayout(state.workspace); }
export function splitActive(): boolean { return paneLeaves(currentLayout().root).length > 1; }
function hasConversation(): boolean { return !!primary() || paneLeaves(currentLayout().root).some(pane => !!pane.active); }
export function applyLayout(layout: ConversationLayout): void {
  devInteractionRevision++; drawerOpen = false; tabStrip.requestReveal();
  const target = layoutTarget(layout, primaryTarget());
  void selection({conversationLayout: layout, selectedTarget: target, panelVisible: target?.kind === 'agent'}).catch(showError);
}
function activateConversationTab(pane: string, key: string): void {
  const layout = activatePaneTab(currentLayout(), pane, key); if (paneById(layout, pane)?.active !== key) return;
  applyLayout(layout); focusEditor();
}
function moveRetained(node: HTMLElement, parent: HTMLElement): void {
  if (node.parentElement === parent) return;
  const focused = document.activeElement instanceof HTMLElement && node.contains(document.activeElement) ? document.activeElement : undefined;
  const selection = document.getSelection(); const ranges: Range[] = [];
  if (selection && node.contains(selection.anchorNode) && node.contains(selection.focusNode)) for (let index = 0; index < selection.rangeCount; index++) ranges.push(selection.getRangeAt(index).cloneRange());
  const top = node.scrollTop; parent.append(node); node.scrollTop = top;
  focused?.focus({preventScroll: true});
  if (ranges.length && selection) {selection.removeAllRanges(); for (const range of ranges) selection.addRange(range);}
}
function mountPaneNode(node: import('../shared/api.ts').PaneNode, layout: ConversationLayout, visited: Set<string>): HTMLElement {
  visited.add(node.id);
  if (node.kind === 'pane') return mountPaneLeaf(node, layout);
  let split = paneSplits.get(node.id);
  if (!split) {
    const root = element('div', 'pane-split'), handle = element('div', 'resizer pane-divider'); root.dataset.splitId = node.id;
    handle.tabIndex = 0; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-label', 'Resize panes'); root.append(handle);
    split = {node: root, handle}; paneSplits.set(node.id, split);
  }
  split.node.dataset.axis = node.axis; split.handle.dataset.axis = node.axis; split.handle.setAttribute('aria-orientation', node.axis === 'x' ? 'vertical' : 'horizontal');
  const first = mountPaneNode(node.first, layout, visited), second = mountPaneNode(node.second, layout, visited); first.dataset.slot = 'first'; second.dataset.slot = 'second';
  if (split.node.firstChild !== first) split.node.prepend(first);
  if (first.nextSibling !== split.handle) first.after(split.handle); if (split.handle.nextSibling !== second) split.handle.after(second);
  return split.node;
}
function mountPaneLeaf(leaf: PaneLeaf, layout: ConversationLayout): HTMLElement {
  let pane = paneRegions.get(leaf.id);
  if (!pane) {
    const node = element('section', 'pane-leaf'); node.dataset.paneId = leaf.id;
    const bar = element('div', 'tab-bar'), tabs = element('div', 'conversation-tabs'), content = element('div', 'pane-content'); content.id = `pane-content-${leaf.id}`;
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Conversations');
    const previous = cardAction('previous', 'Previous tab', () => tabStrip.step(leaf.id, -1), 'icon-button pane-tab-nav');
    const next = cardAction('next', 'Next tab', () => tabStrip.step(leaf.id, 1), 'icon-button pane-tab-nav');
    const plus = cardAction('plus', 'New tab', () => choosePaneTarget(leaf.id), 'icon-button pane-actions'); plus.setAttribute('aria-haspopup', 'dialog');
    const menu = cardAction('chevron', 'Tabs in this pane', () => openTabsList(leaf.id), 'icon-button pane-menu'); menu.setAttribute('aria-haspopup', 'menu');
    bar.append(previous, next, tabs, plus, menu); node.append(bar, content); pane = {node, tabs, content, plus, menu, previous, next}; paneRegions.set(leaf.id, pane);
    node.addEventListener('contextmenu', event => {
      if (event.defaultPrevented || !(event.target instanceof HTMLElement) || nativeEditingTarget(event.target) || event.target.closest('.transcript')) return;
      event.preventDefault(); openPaneMenu(leaf.id, event, event.target.closest<HTMLElement>('.conversation-tab')?.dataset.tabKey);
    });
    content.addEventListener('pointerdown', () => updatePaneFocus(leaf.id));
    content.addEventListener('focusin', () => updatePaneFocus(leaf.id));
  }
  const activeIndex = leaf.tabs.findIndex(tab => tabKey(tab) === leaf.active);
  pane.previous.disabled = activeIndex <= 0; pane.next.disabled = activeIndex < 0 || activeIndex >= leaf.tabs.length - 1;
  pane.plus.disabled = !state.workspace; pane.menu.disabled = !leaf.tabs.length;
  pane.node.dataset.focused = String(leaf.id === layout.focusedPane);
  const tab = leaf.tabs.find(tab => tabKey(tab) === leaf.active), target = tab ? controllerTarget(tab) : undefined;
  for (const child of [...pane.content.children]) if (!target || child !== conversationController(target).root) child.remove();
  if (target) { const owner = conversationController(target); moveRetained(owner.root, pane.content); owner.root.hidden = false; owner.root.inert = false;
    if (messageTarget.current?.identity !== (target.kind === 'agent' ? target.identity : undefined)) moveRetained(owner.elements.root, owner.root);
  }
  return pane.node;
}
let renderedPaneLayout = '';
function renderPaneTree(layout: ConversationLayout): void {
  const signature = JSON.stringify([state.workspace?.id, layout.root]); const changed = renderedPaneLayout !== signature; renderedPaneLayout = signature;
  focusedPane = layout.focusedPane; const container = byId('conversation-panes'); container.classList.add('pane-tree');
  const navigation = byId('navigation-access');
  if ([...paneRegions].some(([id, pane]) => !paneById(layout, id) && pane.node.contains(navigation))) moveRetained(navigation, byId('workspace'));
  retainPaneGeometry();
  const visited = new Set<string>(); const root = mountPaneNode(layout.root, layout, visited); if (container.firstChild !== root) container.replaceChildren(root);
  for (const [id, pane] of paneRegions) if (!visited.has(id)) {pane.node.remove(); paneRegions.delete(id);}
  for (const [id, split] of paneSplits) if (!visited.has(id)) {split.resizer?.destroy(); split.node.remove(); paneSplits.delete(id);}
  for (const controller of controllers.values()) if (controller.root.hidden && !controller.historyAbort.signal.aborted) controller.historyAbort.abort();
  refreshTreeGeometry();
  if (changed) restorePaneGeometry();
  markFocusedPane(); collectControllers();
}
function retainPaneGeometry(): void {
  for (const controller of controllers.values()) {
    const pane = controller.root.closest<HTMLElement>('.pane-leaf');
    if (!controller.root.hidden && !controller.root.inert && !pane?.hidden && !pane?.inert) controller.geometry = controller.transcript.captureGeometry();
    controller.root.hidden = true; controller.root.inert = true;
  }
}
function restorePaneGeometry(): void {
  for (const controller of controllers.values()) if (controller.geometry) controller.transcript.applyGeometry(controller.geometry);
}
function refreshTreeGeometry(): void {
  const layout = currentLayout(), root = byId('conversation-panes'), box = root.getBoundingClientRect(), minimum = minimumPaneSize(layout.root);
  const focusOnly = box.width < minimum.width || box.height < minimum.height; root.dataset.focusOnly = String(focusOnly);
  for (const [id, pane] of paneRegions) {pane.node.hidden = focusOnly && id !== layout.focusedPane; pane.node.inert = pane.node.hidden;}
  if (!focusOnly) refreshPaneSplit(layout.root);
  for (const controller of controllers.values()) controller.transcript.visibilityChanged();
}
function refreshPaneSplit(node: import('../shared/api.ts').PaneNode): void {
  if (node.kind !== 'split') return; const split = paneSplits.get(node.id); if (!split) return;
  const box = split.node.getBoundingClientRect(), size = paneSplitGeometry(node, {width: box.width, height: box.height, divider: 4});
  if (!size) return;
  if (split.extent !== size.extent) {
    split.resizer?.destroy(); split.extent = size.extent;
    split.resizer = createResizer({handle: split.handle, axis: node.axis, min: size.min, max: size.max, defaultValue: Math.round(size.extent / 2),
      read: () => size.extent * ((paneSplits.get(node.id)?.node.style.getPropertyValue('--pane-first') ? Number.parseFloat(split.node.style.getPropertyValue('--pane-first')) / size.extent : node.ratio / 100)),
      write: pixels => split.node.style.setProperty('--pane-first', `${pixels}px`),
      onCommit: pixels => applyLayout(resizePaneSplit(currentLayout(), node.id, Math.round(pixels / size.extent * 100))), onReset: () => applyLayout(resizePaneSplit(currentLayout(), node.id, 50))});
  }
  if (!split.handle.hasAttribute('data-dragging')) split.node.style.setProperty('--pane-first', `${size.first}px`); split.resizer?.refresh();
  refreshPaneSplit(node.first); refreshPaneSplit(node.second);
}
function selection(change: SelectionChange): Promise<void> {
  if (change.selectedTarget && !change.conversationLayout) {
    try { change = {...change, conversationLayout: openTab(currentLayout(), tabForTarget(change.selectedTarget))}; }
    catch (error) { return Promise.reject(error); }
  }
  if (change.selectedTarget !== undefined) { drawerOpen = false; tabStrip.requestReveal(); }
  if (change.sidebarVisible !== undefined && !matchMedia('(min-width: 900px)').matches) {
    drawerOpen = change.sidebarVisible; const {sidebarVisible: _visible, ...rest} = change; change = rest; renderNavigation(); roster.schedule();
    if (!Object.keys(change).length) return Promise.resolve();
  }
  devInteractionRevision++; const startedAt = performance.now();
  const task = selectionQueue.select(change);
  requestAnimationFrame(() => {diagnostics.measure('switch', startedAt, performance.now());}); return task;
}
let focusPrimaryKey: string | undefined;
export async function reloadSelection(): Promise<void> {
  await reload(); focusPrimaryKey = state.workspace?.primaryKey;
  focusSelectedPrimary();
}
function focusSelectedPrimary(): void {
  if (selectedAgent()) { focusPrimaryKey = undefined; return; }
  if (!focusPrimaryKey || focusPrimaryKey !== primary()?.key || primary()?.lifecycle !== 'ready' || primaryComposer().editor.disabled) return;
  focusPrimaryKey = undefined; modal.restoreFocus(primaryComposer().editor);
}
export function reload(signal?: AbortSignal): Promise<void> {
  const task = reloadTail.then(() => {signal?.throwIfAborted(); return refreshVisible(() => refreshSnapshot(signal), loadVisibleHistory, showError);}); reloadTail = task.catch(() => undefined); return task;
}
async function refreshSnapshot(signal?: AbortSignal): Promise<void> {
  if (!state.workspace) return;
  const before = state; const buffered = {events: [] as UiEvent[], bytes: 0, overflow: false}; snapshotBuffers.add(buffered);
  try {
    const explicit = messageTarget.current;
    const read = <T>(path: string, method = 'GET', body?: unknown) => request<T>(path, method, body, undefined, signal && (method === 'GET' ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : signal));
    const pending = read<Snapshot>(`/api/snapshot?workspace=${encodeURIComponent(state.workspace.id)}`).then(value => hydrateVisible(value, read, explicit ? {kind: 'agent', identity: explicit.identity} : undefined));
    const current = await (signal ? waitForSignal(pending, signal) : pending); signal?.throwIfAborted();
    if (buffered.overflow) throw new Error('Current view changed too quickly during restore. Reconnect to request a fresh baseline.');
    updateDiagnostics(true); snapshot = current; state = replaceSnapshot({...before, dismissedNotices: state.dismissedNotices, readNotices: state.readNotices}, current, buffered.events); if (state.workspace) state = {...state, workspace: selectionQueue.observe(state.workspace)}; renderAll();
  } finally { snapshotBuffers.delete(buffered); }
}
function stream(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (document.hidden) return Promise.reject(new Error('The page is hidden.'));
  source?.close();
  if (!state.workspace || !state.cursor) return Promise.reject(new Error('No current workspace baseline.'));
  const ready = {resolve: () => {}, reject: (_error: unknown) => {}};
  const promise = new Promise<void>((resolve, reject) => { ready.resolve = resolve; ready.reject = reject; }); streamWait = ready;
  const current = connect(state.workspace.id, state.cursor, event => { if (source === current) receive(event); }, () => { if (source === current) disconnected(); });
  source = current;
  const timer = window.setTimeout(() => { if (source === current) disconnected(new Error('The event stream did not become ready.')); }, 15_000);
  return (signal ? waitForSignal(promise, signal) : promise).finally(() => { window.clearTimeout(timer); if (streamWait === ready) streamWait = undefined; });
}
function disconnected(error: unknown = new Error('The event stream closed.')): void {
  source?.close(); connected = false; renderAvailability();
  if (streamWait) streamWait.reject(error);
  else connectionRecovery.lost(error);
}
function connectionDetails(): void {
  const body = modal.open('Connection details');
  if (connectionError) body.append(element('p', 'error', errorMessage(connectionError)));
}
function renderAccessView(): boolean {
  const app = byId('app');
  if (connectionPhase === 'auth' && !accessRequired) { accessRequired = true; if (document.activeElement instanceof HTMLElement && app.contains(document.activeElement)) accessFocus = document.activeElement; }
  accessRequired = accessViewVisible(connectionPhase, accessRequired);
  const auth = accessRequired; const restored = app.hidden && !auth;
  byId('app').hidden = auth; byId('access-view').hidden = !auth; byId('skip-composer').hidden = auth;
  if (restored && accessFocus?.isConnected) { accessFocus.focus({preventScroll: true}); accessFocus = undefined; }
  return auth;
}
export function renderConnection(): void {
  const auth = renderAccessView();
  if (auth) { document.title = 'Pi · Browser access required'; contextMenu.close(); modal.close(); setText(byId('access-error'), connectionError ? errorMessage(connectionError) : ''); if (!byId('access-view').contains(document.activeElement)) byId('access-retry').focus({preventScroll: true}); }
  const {visible} = connectionSurfaceFor(connectionPhase);
  const key = `${connectionPhase}`; if (connectionSurface === key) return; connectionSurface = key;
  const node = byId('connection'); node.hidden = auth || !visible; node.replaceChildren();
  if (auth || !visible) return;
  if (connectionPhase === 'offline') node.append(element('span', undefined, 'Disconnected. Your draft is still in this tab.'), button('Reconnect', () => connectionRecovery.reconnect()), button('Details', connectionDetails));
  else setText(node, 'Connection lost. Reconnecting…');
}
async function resync(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted(); if (document.hidden) throw new Error('The page is hidden.');
  if (resynchronizing) return resynchronizing;
  source?.close(); connected = false; renderAvailability();
  const task = (async () => {
    if (state.workspace) await reload(signal); else await refreshVisible(() => bootstrap(signal), loadVisibleHistory, showError);
    signal.throwIfAborted();
    if (messageTarget.current && !messageTarget.current.invalidated) await waitForSignal(messageTarget.open(messageTarget.current.identity), signal);
    signal.throwIfAborted(); await stream(signal); renderAll();
  })();
  const pending = task.finally(() => { if (resynchronizing === pending) resynchronizing = undefined; });
  resynchronizing = pending; return pending;
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
  diagnostics.measure('reducer', reducerStartedAt, performance.now());
  if (state.needsResync) { disconnected(new Error('The event baseline needs a refresh.')); return; }
  if (event.name === 'workspace.changed' && state.workspace) state = {...state, workspace: selectionQueue.observe(state.workspace)};
  if (event.name === 'ready') { streamWait?.resolve(); return; }
  if (old === state) return;
  applyEvent(event);
  if (event.name === 'primary.state') {
    const current = event.envelope.data as PrimaryView; const previous = old.primaries.get(current.key);
    if (historyBecameReady(previous, current, state.workspace?.primaryKey)) void loadVisibleHistory();
  }
}
function applyEvent(event: ReceivedEvent): void {
  const name = event.name;
  if (name === 'primary.delta' || name === 'primary.message' || name === 'primary.entry' || name === 'primary.tool') renderPrimaryEvent(event);
  else if (name === 'primary.state') { renderPrimary(); extensionDialogs.update(); }
  else if (name === 'primary.recovery' || name === 'primary.queue') renderPrimary();
  else if (name === 'agent.frame') renderObservedAgent(event.envelope.data as EventData['agent.frame'], event.receivedAt);
  else if (name === 'agent.roster' || name === 'agent.availability') renderRosterEvent(event);
  else if (name === 'workspace.changed') { renderAll(); void loadVisibleHistory(); }
  else if (name === 'draft.changed') updateDraft(event.envelope.data as EventData['draft.changed']);
  else if (name === 'operation.changed') showOperation(event.envelope.data as OperationView);
  else if (name === 'notice') noticesBadge();
  else if (name === 'extension.request') applyExtension(event);
  else if (name === 'extension.expired') extensionDialogs.update();
}
function renderPrimaryEvent(event: ReceivedEvent): void {
  const target = event.envelope.target; const controller = target && state.workspace ? controllers.get(controllerKey(state.workspace.id, target)) : undefined;
  if (controller) controller.transcript.defer(() => renderController(controller), event.receivedAt);
  if (event.name === 'primary.tool') { tabStrip.render(); renderIdentity(); }
  if (event.name === 'primary.message' && (event.envelope.data as EventData['primary.message']).message.state === 'final') renderPrimaryUsage(primary());
}
function renderRosterEvent(event: ReceivedEvent): void {
  if (event.name === 'agent.roster') messageTarget.rosterChanged(event.envelope.data as EventData['agent.roster']);
  else messageTarget.availabilityChanged(event.envelope.data as EventData['agent.availability']);
  renderRoster(); renderAgent(); renderMessagePanel();
}
function renderObservedAgent(data: EventData['agent.frame'], receivedAt?: number): void {
  const target = {kind: 'agent' as const, identity: data.identity}; const controller = state.workspace ? controllers.get(controllerKey(state.workspace.id, target)) : undefined;
  const conversation = state.conversations.get(targetIdentity(target)); if (conversation?.connectionEpoch !== data.connectionEpoch || conversation.frame?.revision !== data.frame.revision) return;
  if (controller) renderController(controller, true, receivedAt);
  if (footerController?.target.kind === 'agent' && footerController.target.identity === data.identity) renderAgentSettings(presentation(target), target);
}
function applyExtension(event: ReceivedEvent): void {
  const data = event.envelope.data as EventData['extension.request'];
  if ('id' in data) { extensionDialogs.update(); return; }
  if (data.method === 'notify') noticesBadge();
  else if (data.method === 'set_editor_text' && sameTarget(event.envelope.target, primaryTarget())) primaryComposer().suggest(data.text);
  else if (sameTarget(event.envelope.target, primaryTarget())) renderPrimaryExtensions();
}
function updateDraft(event: EventData['draft.changed']): void {
  for (const controller of controllers.values()) if (controller.workspaceId === state.workspace?.id && sameTarget(event.target, controller.target)) controller.composer.updateDraft(event.draft);
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
  const drawerClosed = !narrow && drawerOpen;
  if (!narrow) drawerOpen = false;
  const {sidebarVisible: visible, agentSelected} = navigationState(state.workspace, narrow, drawerOpen);
  byId('app').classList.toggle('drawer-open', narrow && drawerOpen);
  byId('sidebar').hidden = !visible;
  byId('sidebar-show').hidden = false; byId('navigation-access').hidden = visible;
  byId('sidebar-show').setAttribute('aria-expanded', String(visible));
  if (drawerClosed && !visible && byId('sidebar').contains(document.activeElement)) byId('sidebar-show').focus({preventScroll: true});
  const layout = currentLayout(); const tab = activeTab(layout);
  renderPaneTree(layout); renderSessionEntry(!!tab); byId('conversation-panes').hidden = !hasConversation();
  tabStrip.render(); renderIdentity();
  byId('primary-row').hidden = !primary() || paneLeaves(layout.root).some(pane => pane.tabs.some(tab => tab.kind === 'primary'));
  byId('primary-row').setAttribute('aria-label', 'Return to Primary'); byId('primary-row').setAttribute('aria-current', agentSelected ? 'false' : 'page');
  const navigation = byId('navigation-access'); const leading = paneRegions.get(layout.focusedPane)?.node.querySelector<HTMLElement>('.tab-bar') ?? byId('workspace');
  if (navigation.parentElement !== leading) leading.prepend(navigation);
  renderSidebarSections(); renderConnection();
}
function renderSessionEntry(hasTab: boolean): void {
  const firstUse = !hasConversation();
  byId('tabs-empty').hidden = hasTab || firstUse; byId('tabs-open-primary').hidden = !primary();
  const chooser = byId('session-chooser'); chooser.hidden = !firstUse;
  if (firstUse && snapshot) picker.mount(chooser, projectPath()); else picker.unmount();
}
function focusEditor(): void { const target = layoutTarget(currentLayout(), primaryTarget()); if (target) conversationController(target).composer.focus(); }
export function toggleSidebar(visible: boolean): void {
  if (!matchMedia('(min-width: 900px)').matches) {
    drawerOpen = visible; renderNavigation(); roster.schedule(); byId(visible ? 'session-open' : 'sidebar-show').focus(); return;
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
  const item = primary(), target = primaryTarget(); actions.warm(); byId<HTMLButtonElement>('agent-new').disabled = item?.lifecycle !== 'ready';
  const open = paneLeaves(currentLayout().root).some(pane => pane.tabs.some(tab => tab.kind === 'primary'));
  const controller = target && open ? conversationController(target) : undefined;
  if (controller) renderController(controller);
  primaryChrome(item); renderPrimaryExtensions(item);
  if (target && open) primaryActivity(item, target); if (open) focusSelectedPrimary();
}
function renderPrimaryExtensions(item = primary()): void {
  const target = primaryTarget(), controller = target && state.workspace ? controllers.get(controllerKey(state.workspace.id, target)) : undefined;
  extensionStatus(item, controller ? {above: controllerNode(controller, 'widgets-above'), below: controllerNode(controller, 'widgets-below')} : undefined);
}
function renderController(controller: ConversationController, deferred = false, receivedAt?: number): void {
  const saved = targetState(controller.target); controller.saved = saved; controller.resizer ??= composerResizer(controller);
  const firstDraft = !!saved && !controller.initialized;
  if (saved) {
    if (!controller.initialized) {controller.initialized = true; controller.showThinking = saved.presentation?.showThinking ?? false; controller.transcript.configure(saved.presentation, saved.reading);}
    controller.composer.attach(controller.workspaceId, saved);
  } else prepareController(controller);
  controller.composer.receipts(state.operations.values());
  const view = presentation(controller.target); controller.composer.recipient((view.input ? 'Message ' : 'Draft for ') + view.name, controllerGuidance(controller, view));
  controller.composer.availability(connected, !!saved && view.input, view.busy, selecting);
  if (firstDraft && !controller.root.hidden && sameTarget(layoutTarget(currentLayout(), primaryTarget()) ?? undefined, controller.target) && document.activeElement === document.body) controller.composer.focus();
  controller.elements.root.hidden = !saved; controllerNode(controller, 'observed').hidden = controller.target.kind === 'agent' || connected || !view.activity;
  controllerNode(controller, 'stop').hidden = !canStopController(controller);
  if (controller.root.hidden) return;
  const paint = () => {
    const conversation = state.conversations.get(targetIdentity(controller.target)); const entries = conversation ? conversationBlocks(conversation) : [];
    controller.transcript.set(entries, conversation?.tools); const hasEntries = entries.some(entry => !['model_change', 'thinking_level_change'].includes(entry.kind) && entryVisible(entry));
    controller.hasEntries = hasEntries; renderControllerEmpty(controller);
    if (controller.target.kind === 'agent') {controller.before = conversation?.frame?.nextBefore ?? controller.before; controller.transcript.historyAvailable(controller.before !== null);}
  };
  if (deferred) controller.transcript.defer(paint, receivedAt); else paint();
}
function renderControllerEmpty(controller: ConversationController): void {
  if (controller.target.kind === 'agent') {renderAgentState(controller); return;}
  const emptyView = primaryEmpty(state.primaries.get(controller.target.key), !!controller.hasEntries, controller.historyReady);
  controllerNode(controller, 'empty').hidden = !emptyView; setText(controllerNode(controller, 'empty-heading'), emptyView?.heading ?? ''); setText(controllerNode(controller, 'empty-caption'), emptyView?.caption ?? '');
}
function prepareController(controller: ConversationController): void {
  if (controller.preparing || controller.abort.signal.aborted) return; controller.preparing = true;
  void request<import('../shared/api.ts').TargetPreparation>(`/api/workspaces/${encodeURIComponent(controller.workspaceId)}/targets`, 'POST', {target: controller.target}, undefined, controller.abort.signal).then(prepared => {
    if (controller.workspaceId !== state.workspace?.id || controller.abort.signal.aborted || !sameTarget(prepared.targetState.target, controller.target)) return;
    const current = state.targets.get(prepared.targetState.targetKey); const saved = current && current.draft.revision >= prepared.targetState.draft.revision ? current : prepared.targetState;
    state = {...state, targets: new Map(state.targets).set(saved.targetKey, saved)}; controller.saved = saved; controller.connectionError = undefined; renderController(controller);
  }).catch(error => {if (!controller.abort.signal.aborted) controllerPreparationFailed(controller, error);}).finally(() => {controller.preparing = false; if (!controller.historyReady && !controller.root.hidden) void loadControllerHistory(controller);});
}
function controllerPreparationFailed(controller: ConversationController, error: unknown): void {
  if (controller.target.kind === 'agent') {controller.connectionError = errorMessage(error); renderAgentState(controller);}
  else setText(controllerNode(controller, 'view-notice'), errorMessage(error));
}
export function primaryChrome(item?: PrimaryView): void {
  tabStrip.render();
  renderIdentity();
  primaryNavigation(item);
  renderTabActions();
  const model = byId<HTMLButtonElement>('model-button'); model.disabled = item?.lifecycle !== 'ready'; model.hidden = !item?.model && item?.lifecycle !== 'ready'; setText(model, item?.model ? item.model.id : 'Choose model'); model.title = item?.model ? `${item.model.provider}/${item.model.id} · Primary` : 'Choose Primary model'; model.setAttribute('aria-label', item?.model ? `Model for Primary: ${item.model.provider}/${item.model.id}` : 'Choose Primary model');
  renderPrimaryUsage(item);
  const thinking = byId<HTMLButtonElement>('thinking-button'); thinking.hidden = !item?.thinkingLevel; thinking.disabled = item?.lifecycle !== 'ready'; setText(thinking, item?.thinkingLevel ?? ''); thinking.title = item?.thinkingLevel ? `Thinking level: ${item.thinkingLevel}` : 'Choose thinking level'; thinking.setAttribute('aria-label', item?.thinkingLevel ? `Thinking level for Primary: ${item.thinkingLevel}` : 'Choose Primary thinking level');
}
function renderPrimaryUsage(item?: PrimaryView): void {
  const usage = usageFacts(item, item ? primaryBlocks(state, item.key) : undefined);
  byId('primary-context').replaceChildren(...usageNodes({facts: usage.facts.filter(fact => fact.key === 'context' || fact.key === 'contextTokens'), contextFraction: usage.contextFraction}, true));
  byId('primary-usage-summary').replaceChildren(...usageNodes({facts: usage.facts.filter(fact => fact.key !== 'context' && fact.key !== 'contextTokens'), contextFraction: null}, true));
  byId('primary-usage').replaceChildren(...usageNodes(usage, false));
  byId('primary-usage-details').hidden = !item;
  renderComposerFolder('primary-folder', composerFolder({cwd: item?.cwd}, false));
}
/** Summary groups keep numeric scope together; details expose exact reported text. */
export function usageNodes(usage: ReturnType<typeof usageFacts>, summary: boolean): HTMLElement[] {
  if (!summary) return usage.facts.map(fact => { const node = element('p', 'usage-detail', fact.detail); node.dataset.key = fact.key; return node; });
  const groups = new Map<string, HTMLElement>();
  for (const fact of usage.facts) {
    if (!fact.summary) continue;
    const key = fact.key === 'context' || fact.key === 'contextTokens' ? 'context' : fact.key.startsWith('cache') ? 'cache' : fact.key;
    let group = groups.get(key); if (!group) { group = element('span', 'usage-group'); group.dataset.group = key; groups.set(key, group); }
    const node = element('span', 'usage-fact', fact.text); node.dataset.key = fact.key; node.title = fact.title; node.setAttribute('aria-label', fact.title); group.append(node);
  }
  return [...groups.values()];
}
function renderComposerFolder(id: 'primary-folder' | 'agent-folder', folder: ReturnType<typeof composerFolder>): void {
  const node = byId(id); setText(node, folder?.text ?? ''); node.hidden = !folder; node.title = folder?.title ?? '';
}
export function renderTabActions(): void { for (const pane of paneRegions.values()) pane.plus.disabled = false; }
export function openTabActions(pane: Pane = focusedPane): void { openPaneMenu(pane); }
function primaryState(item: PrimaryView): string { return presentation({kind: 'primary', key: item.key, epoch: item.epoch}).activity; }
function primaryNavigation(item?: PrimaryView): void {
  const view = presentation(item ? {kind: 'primary', key: item.key, epoch: item.epoch} : undefined);
  const glyph = presentationGlyph(view);
  const status = byId('primary-row-state'); setText(status, glyph);
  status.dataset.state = view.busy ? 'running' : glyph === '!' ? 'failed' : view.input ? 'idle' : 'none';
  setText(byId('primary-row-title'), item?.extension?.title ?? item?.sessionName ?? item?.sessionId ?? 'no session');
  setText(byId('primary-row-meta'), item && view.activity !== 'Ready' ? primaryState(item) : '');
}
function primaryActivity(item?: PrimaryView, target?: Target): void {
  const conversation = target ? state.conversations.get(targetIdentity(target)) : undefined;
  const recovery = conversation?.recovery;
  renderPrimaryQueue(conversation?.queue);
  setText(primaryNode('activity'), item?.lifecycle === 'ready' && recovery?.kind === 'retry' && recovery.phase !== 'end' ? `Retrying${recovery.error ? ` after ${recovery.error}` : ''}${recovery.attempt ? ` · attempt ${recovery.attempt}` : ''}` : item?.lastError?.message ?? (item?.activity === 'retrying' ? 'Retrying' : ''));
  if (item?.lastError) { setText(primaryNode('activity'), item.lifecycle === 'failed' ? 'This session failed. Your draft is unchanged. Pi did not confirm that its process exited. Choose another session.' : 'The response failed.'); primaryNode('activity').append(button('Sessions', () => picker.open(projectPath())), details('Details', item.lastError.message), button('Review message', () => actions.retryOutput())); }
  primaryNode('stop').hidden = !(connected && primaryBusy(item, conversation?.queue?.pending));
}
export function renderPrimaryQueue(queue?: EventData['primary.queue']): void {
  const list = primaryNode('queued'); const rows: HTMLElement[] = [];
  for (const [mode, messages] of [['steer', queue?.steering], ['followUp', queue?.followUp]] as const) for (const text of messages ?? []) {
    const row = element('li', 'queued-message', `${mode === 'steer' ? 'Next step' : 'After response'}: ${text}`);
    row.dataset.mode = mode; row.title = text; rows.push(row);
  }
  list.replaceChildren(...rows); list.hidden = !rows.length;
}
function renderRoster(): void {
  tabStrip.render(); renderIdentity();
  roster.set(state.rosterOrder.flatMap(id => { const row = state.roster.get(id); return row ? [row] : []; }), state.rosterMeta, selectedAgent());
  for (const identity of state.roster.keys()) renderMessageResume(identity);
}
function renderMessageResume(identity: string): void {
  const target = {kind: 'agent' as const, identity}; const workspace = state.workspace?.id ?? '';
  const index = [...state.targetIndex.values()].find(item => sameTarget(item.target, target)); const controller = controllers.get(controllerKey(workspace, target));
  roster.resume(identity, controller?.composer.retained(workspace, target, index) ?? (!!index?.hasDraft || !!index?.unconfirmedOperationIds.length));
}
function renderMessagePanel(): void {
  const captured = messageTarget.current, panel = byId('agent-message-panel'); panel.hidden = !captured; if (!captured) return;
  const target = {kind: 'agent' as const, identity: captured.identity}, controller = conversationController(target), row = agentRow(captured.identity);
  setText(byId('agent-message-name'), row?.name ?? row?.handle ?? 'Agent'); setText(byId('agent-message-identity'), captured.identity); byId('agent-message-identity').title = captured.identity;
  setText(byId('agent-message-status'), captured.error ?? captured.prepared?.reason ?? (captured.prepared ? '' : 'Preparing message…')); renderMessageRecovery(captured.preparing === true);
  if (captured.prepared) {
    const prepared = captured.prepared.targetState, current = state.targets.get(prepared.targetKey);
    const saved = current && current.draft.revision >= prepared.draft.revision ? current : prepared;
    state = {...state, targets: new Map(state.targets).set(saved.targetKey, saved)}; controller.saved = saved; controller.composer.attach(captured.workspaceId, saved);
  } else controller.composer.attachRetained(captured.workspaceId, target);
  moveRetained(controller.elements.root, panel); controller.elements.root.hidden = false; controller.composer.placement(true);
  const ready = messageTarget.ready; controller.composer.recipient((ready ? 'Message ' : 'Draft for ') + (row?.name ?? row?.handle ?? captured.identity), ready || !captured.prepared || captured.invalidated ? '' : 'Connect this agent to send.');
  controller.composer.availability(connected, ready, false, selecting); controller.composer.receipts(state.operations.values()); controllerNode(controller, 'stop').hidden = true;
  renderWorkbenchStatus();
}
function renderMessageRecovery(preparing: boolean): void {
  const retry = byId<HTMLButtonElement>('agent-message-retry');
  if (preparing) { retry.disabled = true; return; }
  const recovery = messageTarget.recovery(); const captured = messageTarget.current;
  setText(retry, recovery?.label ?? ''); retry.hidden = !recovery; retry.disabled = !connected;
  retry.onclick = recovery ? () => {
    if (!connected || messageTarget.current !== captured) return;
    const controller = captured ? controllers.get(controllerKey(captured.workspaceId, {kind: 'agent', identity: captured.identity})) : undefined;
    if (document.activeElement === retry && controller && !controller.composer.editor.disabled) controller.composer.editor.focus();
    void recovery.run().catch(showError);
  } : null;
}
function closeMessagePanel(focus = true): void {
  const identity = messageTarget.current?.identity; messageTarget.close(); byId('agent-message-panel').hidden = true;
  renderNavigation(); renderRoster(); collectControllers();
  if (focus && (!identity || byId('sidebar').hidden || !roster.focusMessage(identity))) focusEditor();
}
function renderAgent(deferredTranscript = false): void {
  for (const leaf of paneLeaves(currentLayout().root)) {
    const tab = leaf.tabs.find(tab => tabKey(tab) === leaf.active); if (tab?.kind !== 'agent') continue;
    const target = {kind: 'agent' as const, identity: tab.identity}; renderController(conversationController(target), deferredTranscript);
  }
  const identity = selectedAgent(); if (identity) renderStoredAgent(identity, agentRow(identity));
  if (identity && footerController?.target.kind === 'agent' && footerController.target.identity === identity) renderAgentSettings(presentation(footerController.target), footerController.target);
}
export function agentChrome(identity: string, _row?: AgentRow): void { renderController(conversationController({kind: 'agent', identity})); renderIdentity(); }
function renderAgentSettings(view: ConversationPresentation, target: Extract<Target, {kind: 'agent'}>): void {
  setText(byId('agent-status'), [view.model ? `Model ${view.model.modelId}${view.retainedModel ? ' (retained)' : ''}` : '', view.thinking ? `Thinking ${view.thinking}${view.retainedThinking ? ' (retained)' : ''}` : ''].filter(Boolean).join(' · '));
  byId('agent-status').hidden = !view.model && !view.thinking; byId('agent-status').title = view.model ? `${view.model.provider}/${view.model.modelId}` : '';
  const conversation = state.conversations.get(targetIdentity(target)); const usage = usageFacts(undefined, conversation ? conversationBlocks(conversation) : []);
  byId('agent-usage-summary').replaceChildren(...usageNodes(usage, true)); byId('agent-usage').replaceChildren(...usageNodes(usage, false));
  byId('agent-usage-details').hidden = !usage.facts.length && !view.cwd && !view.model && !view.thinking;
  setText(byId('agent-usage-note'), 'Loaded finalized assistant messages only; earlier and omitted usage is not included.');
  renderComposerFolder('agent-folder', composerFolder(view, true));
}
let checkingAgent: string | undefined;
const agentStarts = new Map<string, {pending: boolean; reason?: string}>();
function agentStartKey(workspace: string, identity: string): string { return JSON.stringify([workspace, identity]); }
function controllerGuidance(controller: ConversationController, view: ConversationPresentation): string {
  return controller.target.kind === 'agent' ? '' : view.guidance;
}
function renderAgentRecipient(identity: string, view: ConversationPresentation = presentation({kind: 'agent', identity})): void {
  agentComposer().recipient(`${view.input ? 'Message' : 'Draft for'} ${view.name}`, '');
}
function renderStoredAgent(identity: string, _row?: AgentRow): void {
  renderAgentState(conversationController({kind: 'agent', identity}));
  if (!messageTarget.current) renderAgentRecipient(identity);
}
function renderAgentState(controller: ConversationController): void {
  if (controller.target.kind !== 'agent') return;
  const {identity} = controller.target, workspace = controller.workspaceId;
  const availability = state.agentAvailability.get(identity), row = agentRow(identity), attempt = agentStarts.get(agentStartKey(workspace, identity));
  const view = agentViewStatus({hasEntries: !!controller.hasEntries, connected, loading: controller.loading, ready: controller.historyReady, complete: controller.historyComplete, error: controller.historyError, availability: availability?.state ?? row?.availability, input: presentation(controller.target).input, reason: availability?.reason, startAttempt: attempt, connectionError: controller.connectionError});
  const status = controllerNode(controller, 'agent-state'), line = controllerNode(controller, 'agent-state-line');
  status.hidden = !view.text; setText(line, view.text); line.title = view.detail; controller.elements.send.setAttribute('aria-describedby', line.id);
  controllerNode(controller, 'empty').hidden = true; controller.root.classList.toggle('agent-empty', !controller.hasEntries);
  const start = controllerNode(controller, 'start') as HTMLButtonElement; start.hidden = !view.start; start.disabled = !connected || !!checkingAgent;
  start.onclick = () => {void startStoredAgent(workspace, identity);};
  const terminal = controllerNode(controller, 'start-in-pi') as HTMLButtonElement; terminal.hidden = (availability?.state ?? row?.availability) === 'live' || !!attempt; terminal.disabled = !connected;
  terminal.onclick = () => {if (workspace === state.workspace?.id && selectedAgent() === identity) showAgentCommand(identity);};
  const retry = controllerNode(controller, 'history-retry') as HTMLButtonElement;
  retry.disabled = !connected || controller.loading || !!checkingAgent || attempt?.pending === true;
  retry.onclick = () => {void retryAgentRead(controller);};
}
async function retryAgentRead(controller: ConversationController): Promise<void> {
  if (!connected || controller.target.kind !== 'agent' || controller.workspaceId !== state.workspace?.id || controller.loading) return;
  await loadControllerHistory(controller);
}
function showAgentCommand(identity: string): void {
  const command = `/agent attach ${identity}`; modal.open('Start in Pi');
  modal.body.append(element('pre', undefined, command), button('Copy command', () => {void copy(command, modal.body);}));
}
function focusStoredEditor(): void {
  if (agentNode('agent-state').contains(document.activeElement)) agentComposer().editor.focus({preventScroll: true});
}
export async function startStoredAgent(workspace: string, identity: string): Promise<void> {
  const key = agentStartKey(workspace, identity);
  if (!connected || workspace !== state.workspace?.id || identity !== selectedAgent() || agentRow(identity)?.availability !== 'stored' || checkingAgent || agentStarts.has(key)) return;
  agentStarts.set(key, {pending: true}); focusStoredEditor(); renderStoredAgent(identity, agentRow(identity));
  const current = () => workspace === state.workspace?.id && identity === selectedAgent();
  try {
    const result = await request<import('../shared/api.ts').TargetPreparation>(`/api/agents/${encodeURIComponent(identity)}/start?workspace=${encodeURIComponent(workspace)}`, 'POST', {}, crypto.randomUUID());
    if (result.targetState.target.kind !== 'agent' || result.targetState.target.identity !== identity || result.availability !== 'live' || !result.capabilities.input) throw new Error(result.reason ?? 'A usable connection was not confirmed.');
    if (!current()) { agentStarts.delete(key); return; }
    await reload();
    if (!current()) { agentStarts.delete(key); return; }
    if (!agentInputConfirmed(identity)) throw new Error('A usable connection was not confirmed.');
    agentStarts.delete(key); conversationController({kind: 'agent', identity}).connectionError = undefined;
  } catch (error) { agentStarts.set(key, {pending: false, reason: errorMessage(error)}); }
  finally { if (current()) renderStoredAgent(identity, agentRow(identity)); }
}
function agentInputConfirmed(identity: string): boolean {
  const row = agentRow(identity); return row?.availability === 'live' && row.capabilities?.input === true;
}
async function confirmCheckedAgent(result: import('../shared/api.ts').TargetPreparation, identity: string, key: string, current: () => boolean): Promise<void> {
  if (result.targetState.target.kind !== 'agent' || result.targetState.target.identity !== identity) throw new Error('The prepared conversation changed.');
  if (result.availability === 'live' && result.capabilities.input) {
    await selection({selectedTarget: {kind: 'agent', identity}});
    if (!current()) return;
    if (!agentInputConfirmed(identity)) throw new Error('A usable connection was not confirmed.');
    agentStarts.delete(key);
  } else await reload();
  if (current()) conversationController({kind: 'agent', identity}).connectionError = undefined;
}
export async function checkAgentConnection(workspace: string, identity: string): Promise<void> {
  const key = agentStartKey(workspace, identity);
  if (!connected || workspace !== state.workspace?.id || identity !== selectedAgent() || checkingAgent || agentStarts.get(key)?.pending) return;
  checkingAgent = identity; focusStoredEditor(); renderStoredAgent(identity, agentRow(identity));
  const current = () => workspace === state.workspace?.id && identity === selectedAgent();
  try {
    const result = await request<import('../shared/api.ts').TargetPreparation>(`/api/workspaces/${encodeURIComponent(workspace)}/targets`, 'POST', {target: {kind: 'agent', identity}});
    if (!current()) return;
    await confirmCheckedAgent(result, identity, key, current);
  } catch (error) { if (current()) conversationController({kind: 'agent', identity}).connectionError = errorMessage(error); }
  finally {
    checkingAgent = undefined; const currentIdentity = selectedAgent();
    if (currentIdentity) renderStoredAgent(currentIdentity, agentRow(currentIdentity));
  }
}
function agentFacts(row?: AgentRow, frame?: ProjectedFrame): {key: string; label: string; text: string}[] {
  const facts: {key: string; label: string; text: string}[] = [];
  if (!frame && row?.firstMessage) facts.push({key: 'first', label: 'First message · retained metadata', text: row.firstMessage});
  if (!frame && row?.latestReply) facts.push({key: 'reply', label: 'Last reply · retained metadata', text: row.latestReply});
  if (frame?.status.tasks) facts.push({key: 'tasks', label: 'Reported tasks', text: rawText(frame.status.tasks.value)});
  if (frame?.status.submissions) facts.push({key: 'submissions', label: 'Reported submissions', text: rawText(frame.status.submissions.value)});
  if (row?.currentTool) facts.push({key: 'tool', label: 'Last reported tool', text: `${row.currentTool.name} · ${row.currentTool.argument}`});
  facts.push({key: 'context', label: 'Context', text: 'Context not reported'});
  return facts;
}
function renderAvailability(): void {
  for (const controller of controllers.values()) {
    const view = presentation(controller.target), current = controller.workspaceId === state.workspace?.id; controller.composer.availability(connected && current, current && !!controller.saved && view.input, current && view.busy, selecting);
    controllerNode(controller, 'stop').hidden = !canStopController(controller); renderControllerEmpty(controller);
  }
  if (messageTarget.current) renderMessagePanel(); renderIdentity();
}
export async function selectAgent(row: AgentRow): Promise<void> {
  const origin = document.activeElement; drawerOpen = false;
  const applied = selection({panelVisible: true, selectedTarget: {kind: 'agent', identity: row.identity}});
  focusEditor(); await applied;
  if (selectedAgent() === row.identity && (document.activeElement === origin || document.activeElement === document.body)) focusEditor();
}
async function loadVisibleHistory(): Promise<void> {
  await Promise.all(paneLeaves(currentLayout().root).flatMap(pane => { const tab = pane.tabs.find(tab => tabKey(tab) === pane.active), target = tab ? controllerTarget(tab) : undefined; return target ? [loadControllerHistory(conversationController(target))] : []; }));
}
function historyPath(controller: ConversationController, earlier: boolean): string {
  const target = controller.target, base = target.kind === 'primary' ? `/api/primaries/${encodeURIComponent(target.key)}/history?limit=50` : `/api/agents/${encodeURIComponent(target.identity)}/history?limit=50`;
  if (!earlier) return base;
  return base + (target.kind === 'primary' ? controller.cursor ? `&cursor=${encodeURIComponent(controller.cursor)}` : '' : controller.before !== null ? `&before=${controller.before}` : '');
}
function historyCurrent(controller: ConversationController, abort: AbortController): boolean {
  const target = controller.target; return !abort.signal.aborted && !controller.abort.signal.aborted && controller.workspaceId === state.workspace?.id && (target.kind !== 'primary' || state.primaries.get(target.key)?.epoch === target.epoch);
}
function mergeControllerHistory(controller: ConversationController, page: HistoryPage | AgentHistoryPage, earlier: boolean): void {
  const target = controller.target;
  if (target.kind === 'primary' && 'items' in page) {
    if (earlier || !controller.historyReady) controller.cursor = page.nextCursor;
    state = mergePrimaryPage(state, target, page.items, {nextCursor: controller.cursor, earlier});
  }
  else if (target.kind === 'agent' && 'entries' in page) {state = mergeAgentPage(state, target.identity, page.entries); controller.before = page.nextBefore;}
  else throw new Error('History response does not match its target.');
  controller.historyReady = true; controller.historyComplete = page.coverage.complete && !page.coverage.truncated && page.coverage.omitted === 0; controller.historyError = undefined; controller.transcript.historyAvailable(target.kind === 'primary' ? controller.cursor !== null : controller.before !== null); renderController(controller);
  if (target.kind === 'primary' && sameTarget(target, primaryTarget())) renderPrimaryUsage(primary());
}
function loadControllerHistory(controller: ConversationController, earlier = false, restoring = false): Promise<void> {
  if (restoring && !controller.loading) return runControllerHistory(controller, earlier, true);
  if (controller.historyWork) return controller.historyWork;
  if (controller.historyAbort.signal.aborted) controller.historyAbort = new AbortController();
  const abort = controller.historyAbort;
  const task = runControllerHistory(controller, earlier, restoring).finally(() => {
    if (controller.historyWork !== task) return; controller.historyWork = undefined;
    if (abort.signal.aborted && !controller.abort.signal.aborted && !controller.root.hidden && !controller.historyReady) void loadControllerHistory(controller);
  });
  controller.historyWork = task; return task;
}
async function runControllerHistory(controller: ConversationController, earlier = false, restoring = false): Promise<void> {
  if (controller.loading || controller.abort.signal.aborted || controller.workspaceId !== state.workspace?.id) return;
  if (controller.historyAbort.signal.aborted) controller.historyAbort = new AbortController();
  const abort = controller.historyAbort, reading = controller.saved?.reading ?? targetState(controller.target)?.reading;
  const more = controller.target.kind === 'primary' ? controller.cursor !== null : controller.before !== null;
  if (earlier && !more) return;
  startControllerHistory(controller); const control = controllerNode(controller, 'earlier') as HTMLButtonElement; historyLoadingFeedback(control, earlier); let loaded = false;
  try {
    const page = await request<HistoryPage | AgentHistoryPage>(historyPath(controller, earlier), 'GET', undefined, undefined, AbortSignal.any([abort.signal, controller.abort.signal, AbortSignal.timeout(15_000)]));
    if (!historyCurrent(controller, abort)) return; mergeControllerHistory(controller, page, earlier); loaded = true; historyLoadedFeedback(earlier, restoring);
  } catch (error) {controllerHistoryFailed(controller, abort, error);}
  finally {if (controller.historyAbort === abort) {controller.loading = false; renderControllerEmpty(controller); control.disabled = false; control.setAttribute('aria-label', 'Earlier messages'); control.title = 'Earlier messages'; control.removeAttribute('aria-busy');}}
  if (loaded && !earlier && !restoring && reading && !reading.followTail) await restoreControllerHistory(controller, reading);
}
function startControllerHistory(controller: ConversationController): void {
  controller.loading = true; if (controller.historyError) controllerNode(controller, 'view-notice').replaceChildren(); controller.historyError = undefined; renderControllerEmpty(controller);
}
function controllerHistoryFailed(controller: ConversationController, abort: AbortController, error: unknown): void {
  if (!historyCurrent(controller, abort)) return;
  controller.historyError = {message: errorMessage(error), ...(error instanceof ApiError ? {code: error.view.code} : {})};
  if (controller.target.kind === 'agent') renderAgentState(controller);
  else controllerNode(controller, 'view-notice').replaceChildren(element('p', undefined, 'History could not be loaded.'), historyDetails(error), cardAction('restart', 'Retry history', () => {void loadControllerHistory(controller);}));
}
function historyDetails(error: unknown): HTMLElement {
  const disclosure = details('History error details', errorMessage(error)); disclosure.classList.add('history-details');
  const summary = disclosure.querySelector<HTMLElement>('summary'); if (summary) controlIcon(summary, 'info', 'History error details'); return disclosure;
}
function historyLoadingFeedback(control: HTMLButtonElement, earlier: boolean): void {control.disabled = true; if (earlier) {control.setAttribute('aria-label', 'Loading earlier messages'); control.title = 'Loading earlier messages'; control.setAttribute('aria-busy', 'true');}}
function historyLoadedFeedback(earlier: boolean, restoring: boolean): void {if (earlier && !restoring) announce('Earlier entries loaded.');}
async function restoreControllerHistory(controller: ConversationController, reading: TargetState['reading']): Promise<void> {
  const result = await pageToReadingAnchor(reading, {hasEntry: id => state.conversations.get(targetIdentity(controller.target))?.entries.has(id) ?? false,
    nextCursor: () => controller.target.kind === 'primary' ? controller.cursor : controller.before === null ? null : String(controller.before),
    loadEarlier: () => loadControllerHistory(controller, true, true), current: () => !controller.abort.signal.aborted && !controller.historyAbort.signal.aborted && controller.workspaceId === state.workspace?.id && !controller.root.hidden && controller.transcript.restorationCurrent(reading)});
  if (result !== 'exhausted' && result !== 'unavailable') return;
  controller.transcript.abandonRestore(reading); setText(controllerNode(controller, 'view-notice'), result === 'exhausted' ? 'Saved position is not in the available history. Showing the start.' : 'Your saved place is unavailable. Select Earlier to try again.');
}
function canStopController(controller: ConversationController): boolean {
  if (!connected || controller.workspaceId !== state.workspace?.id || controller.abort.signal.aborted) return false;
  if (controller.target.kind === 'agent' && messageTarget.current?.workspaceId === controller.workspaceId && messageTarget.current.identity === controller.target.identity) return false;
  if (controller.target.kind === 'primary') return presentation(controller.target).busy;
  const row = agentRow(controller.target.identity); return !!row?.capabilities?.abort && !!row.capabilities.input && row.availability === 'live';
}
async function stopController(controller: ConversationController): Promise<void> {
  const target = controller.target;
  if (!canStopController(controller) || controller.root.hidden || controller.root.inert || controllerNode(controller, 'stop').hidden) return;
  if (target.kind === 'agent') {
    modal.confirm(`Stop ${presentation(target).name}?`, 'This stops the current response. Background work and scheduled actions continue.', async () => {
      if (!canStopController(controller) || controller.root.hidden || controller.root.inert || controllerNode(controller, 'stop').hidden) return;
      setText(controller.elements.receipt, 'Stop requested'); showOperation(await operation('agent.abort', `/api/agents/${encodeURIComponent(target.identity)}/abort`, {background: false}, target), controller.workspaceId);
    }, 'Stop'); return;
  }
  if (controller.workspaceId !== state.workspace?.id || controller.root.hidden || controller.abort.signal.aborted) return;
  setText(controller.elements.receipt, 'Stop requested');
  try { showOperation(await operation('primary.stop', `/api/primaries/${encodeURIComponent(target.key)}/stop`, {epoch: target.epoch}, target), controller.workspaceId); }
  catch (error) {setText(controller.elements.receipt, errorMessage(error));}
}
function saveReading(captured: TranscriptTarget | undefined, reading: TargetState['reading']): Promise<void> {
  return saveView(captured, 'reading', {anchorId: reading.anchorId, offsetPx: reading.offsetPx, followTail: reading.followTail});
}
function savePresentation(captured: TranscriptTarget | undefined, expanded: string[], showThinking: boolean, transcriptView: import('../shared/api.ts').TranscriptView = 'chronological'): Promise<void> {
  return saveView(captured, 'presentation', {expanded: expanded.slice(), showThinking, transcriptView});
}
function savedControllerView(captured: TranscriptTarget): TargetState {
  const saved = captured.workspaceId === state.workspace?.id ? state.targets.get(captured.saved.targetKey) : captured.controller.saved;
  return saved && sameTarget(saved.target, captured.saved.target) && saved.targetKey === captured.saved.targetKey ? saved : captured.saved;
}
async function saveView(captured: TranscriptTarget | undefined, kind: 'reading' | 'presentation', values: object): Promise<void> {
  if (!captured || !connected || captured.workspaceId !== state.workspace?.id) return;
  const {saved, workspaceId, controller} = captured;
  const notice = controllerNode(controller, 'view-notice');
  try { await preferences.save(`${workspaceId}/${saved.targetKey}/${kind}`, async () => {
    const latest = savedControllerView(captured);
    const result = await request<TargetState['reading'] | NonNullable<TargetState['presentation']>>(`/api/workspaces/${encodeURIComponent(workspaceId)}/targets/${encodeURIComponent(saved.targetKey)}/${kind}`, 'PUT', {expectedRevision: latest[kind]?.revision ?? 0, ...values});
    const current = savedControllerView(captured);
    if (result.revision >= (current[kind]?.revision ?? 0)) {
      const updated = {...current, [kind]: result}; controller.saved = updated;
      if (workspaceId === state.workspace?.id) state = {...state, targets: new Map(state.targets).set(saved.targetKey, updated)};
    }
    if (currentTranscriptTarget(captured) && notice.dataset.kind === kind) notice.replaceChildren();
  }); } catch (error) {
    if (!currentTranscriptTarget(captured)) return;
    notice.dataset.kind = kind; notice.replaceChildren(element('p', 'error', 'View preferences not saved.'), details('Details', errorMessage(error)), button('Restore saved view', () => {
      if (!currentTranscriptTarget(captured)) return;
      void reload().then(() => {
      if (!currentTranscriptTarget(captured)) return;
      const latest = state.targets.get(saved.targetKey); const transcript = controller.transcript;
      controller.showThinking = latest?.presentation?.showThinking ?? false; transcript.configure(latest?.presentation, latest?.reading); notice.replaceChildren();
    }).catch(showError); }));
  }
}
function currentTranscriptTarget(captured: TranscriptTarget): boolean {
  return captured.workspaceId === state.workspace?.id && controllers.get(controllerKey(captured.workspaceId, captured.saved.target)) === captured.controller && captured.controller.saved?.targetKey === captured.saved.targetKey;
}
function updateRetainedOperation(result: OperationView, workspaceId: string | undefined): void {
  for (const controller of controllers.values()) if (controller.workspaceId === workspaceId) controller.composer.updateOperation(result); collectControllers();
}
function showOperation(result: OperationView, workspaceId = state.workspace?.id): void {
  if (workspaceId !== state.workspace?.id) {updateRetainedOperation(result, workspaceId); return;}
  if (newerOperation(state.operations.get(result.id), result) !== result) return;
  state = {...state, operations: mergeOperationMap(state.operations, result)};
  if (result.kind === 'primary.handoff') actions.handoffResult(result);
  if (inputOperation(result)) {
    if (['accepted', 'rejected', 'uncertain'].includes(result.state)) for (const controller of controllers.values()) controller.composer.updateOperation(result);
  }
  for (const controller of controllers.values()) controller.composer.receipts(state.operations.values()); collectControllers();
  if (result.state !== 'reserved' && result.state !== 'dispatched') announce(operationLabel(result));
}
function notificationsLabel(): string { const unread = unreadNotices(state); return unread ? `Notifications (${unread} unread)` : 'Notifications'; }
function noticesBadge(): void {
  const unread = unreadNotices(state); setText(byId('notices-count'), String(unread)); byId('notices-count').hidden = !unread;
  const label = notificationsLabel(); byId('notifications-button').setAttribute('aria-label', label); byId('notifications-button').title = label;
}
function notices(): void {
  state = markReadNotices(state); noticesBadge(); modal.open('Notifications'); if (!state.notices.length) modal.body.append(empty('No notifications'));
  for (const notice of state.notices) {
    const row = element('div', `notification ${notice.level}`); row.append(cardAction('close', 'Dismiss notification', () => { state = dismissNotice(state, notice.id); notices(); noticesBadge(); }), element('p', undefined, notice.message));
    if (notice.target) row.append(element('p', 'target-label', presentation(notice.target).name), details('Details', rawText(notice.target)));
    modal.body.append(row); references.decorate(row, () => state.noticeShelf.get(notice.id) === notice && !state.dismissedNotices.has(notice.id));
  }
}
function showError(error: unknown): void { const message = errorMessage(error); announce(message); if (footerController && footerController.workspaceId === state.workspace?.id) setText(footerController.elements.receipt, message); }
function showRosterError(error: unknown): void { const message = errorMessage(error); announce(message); byId('roster-footer').replaceChildren(element('p', 'error', message), cardAction('restart', 'Refresh agent roster', () => { void reload().catch(showRosterError); })); }
function refreshRoster(): void { void request('/api/agents/refresh', 'POST', {}).catch(showRosterError); }
function moreRoster(): void {
  const cursor = state.rosterMeta?.nextCursor;
  if (cursor) { void request<import('../shared/api.ts').CachedRoster>(`/api/agents?limit=20&cursor=${encodeURIComponent(cursor)}`).then(page => {
    state = mergeRosterPage(state, page); renderRoster();
  }).catch(showRosterError); return; }
  const scanId = state.rosterMeta?.scan.scanId;
  void request('/api/agents/refresh', 'POST', scanId ? {scanId, continue: true} : {}).catch(showRosterError);
}
function referenceIdentities(query: ReferenceQuery): ReferenceDestination[] {
  if (typeof query !== 'string' && query.field !== 'identity') return [];
  const text = typeof query === 'string' ? query : query.text; const destinations: ReferenceDestination[] = [];
  if (state.roster.has(text)) destinations.push({target: {kind: 'agent', identity: text}});
  for (const view of state.primaries.values()) if (view.sessionId === text || view.key === text) destinations.push({target: {kind: 'primary', key: view.key, epoch: view.epoch}});
  return destinations;
}
function resolveReference(query: ReferenceQuery): ReferenceResolution {
  const destinations = referenceIdentities(query);
  for (const controller of controllers.values()) {
    if (controller.workspaceId !== state.workspace?.id) continue;
    const owner = controller.target.kind === 'agent' ? controller.target.identity : state.primaries.get(controller.target.key)?.sessionId;
    if (typeof query !== 'string' && (query.owner !== owner || query.field === 'identity')) continue;
    const entryId = controller.transcript.loadedReference(query, owner); if (entryId) destinations.push({target: controller.target, entryId});
  }
  const first = destinations[0]; if (destinations.length === 1 && first) return {destination: first};
  return {reason: destinations.length ? 'Reference has more than one loaded destination.' : 'Reference is not resolved by the loaded public identities.'};
}
async function navigateReference(destination: ReferenceDestination): Promise<void> {
  const {target, entryId} = destination; const workspace = state.workspace?.id;
  if (!workspace) return;
  if (target.kind === 'agent') {
    if (!state.roster.has(target.identity) && selectedAgent() !== target.identity) return;
    await selection({panelVisible: true, selectedTarget: target, conversationLayout: openTab(currentLayout(), {kind: 'agent', identity: target.identity})});
    if (workspace !== state.workspace?.id || selectedAgent() !== target.identity) return;
    focusReference(conversationController(target).transcript, entryId);
  } else {
    if (state.primaries.get(target.key)?.epoch !== target.epoch) return;
    await selection({primaryKey: target.key, selectedTarget: target, conversationLayout: openTab(currentLayout(), {kind: 'primary'})});
    if (!referencePrimaryCurrent(workspace, target)) return;
    focusReference(conversationController(target).transcript, entryId);
  }
}
function focusReference(transcript: Transcript, entryId?: string): void {
  if (entryId) transcript.revealEntry(entryId); else transcript.node.focus({preventScroll: true});
}
function referencePrimaryCurrent(workspace: string, target: Extract<Target, {kind: 'primary'}>): boolean {
  const selected = primaryTarget();
  return workspace === state.workspace?.id && selected?.kind === 'primary' && selected.key === target.key && selected.epoch === target.epoch;
}
function inspectAgent(identity = selectedAgent()): void {
  if (!identity || !agentRow(identity)?.capabilities?.inspect) return;
  modal.open('Agent activity').append(element('p', 'identity', identity)); const token = modal.token;
  void modal.run(async () => {
    const data = await request(`/api/agents/${encodeURIComponent(identity)}/inspect`, 'POST', {view: 'activity', limit: 20});
    if (modal.owns(token)) modal.body.append(details('Reported activity', rawText(data)));
  }, false);
}
function primaryMenuItems(): ContextItem[] {
  const target = primaryTarget(); const controller = target && state.workspace ? controllers.get(controllerKey(state.workspace.id, target)) : undefined;
  const entries = actions.sessionMenuEntries(); const shown = controller?.showThinking ?? false;
  const toggle = entries.find(item => item.name === (shown ? 'Hide thinking' : 'Show thinking'));
  return entries.filter(item => !['Sessions', 'Appearance', 'Help', 'Hide thinking'].includes(item.name))
    .map(item => item.name === 'Show thinking' ? {label: 'Show thinking', checked: shown, checkbox: true, enabled: item.enabled, run: toggle?.run ?? item.run} : {label: item.name, enabled: item.enabled, run: item.run});
}
function agentMenuItems(identity: string): ContextItem[] {
  const row = agentRow(identity); if (!row) return [];
  const items: ContextItem[] = [
    {label: 'Show conversation', run: () => { void selectAgent(row).catch(showError); }},

    {label: 'Message', enabled: connected && row.availability === 'live' && row.capabilities?.input === true, run: () => openAgentMessage(identity)},
    {label: 'Copy agent ID', run: () => { void copy(identity, agentNode('view-notice')); }},
    {label: 'Conversation details', run: () => actions.conversationDetails(identity)},
  ];
  if (row.capabilities?.inspect) items.push({label: 'View activity…', run: () => inspectAgent(identity)});
  return items;
}
function paneSpace(id: string): {width: number; height: number; divider: number} { const box = paneRegions.get(id)?.node.getBoundingClientRect(); return {width: box?.width ?? 0, height: box?.height ?? 0, divider: 4}; }
function paneTabChoices(leaf: PaneLeaf, layout: ConversationLayout): ContextItem[] {
  const tabs = paneLeaves(layout.root).flatMap(pane => pane.tabs);
  const tails = duplicateIdentityTails(tabs.map(tab => ({name: tabLabel(tab), identity: tab.kind === 'agent' ? tab.identity : 'primary'})));
  return leaf.tabs.map(tab => {
    const name = tabLabel(tab), tail = tails.get(tab.kind === 'agent' ? tab.identity : 'primary');
    return {label: tail ? `${name} · ${tail}` : name, description: tabPresentation(tab).activity, checked: tabKey(tab) === leaf.active, run: () => activateConversationTab(leaf.id, tabKey(tab))};
  });
}
function openPaneMenu(paneId: string, event?: MouseEvent, key?: string, purpose: 'list' | 'context' = 'context'): void {
  const region = paneRegions.get(paneId), workspace = state.workspace; if (!region || !workspace) return;
  const layout = currentLayout(), leaf = paneById(layout, paneId), tab = leaf?.tabs.find(tab => tabKey(tab) === (key ?? leaf.active));
  const target = tab ? controllerTarget(tab) : undefined, owner = target ? conversationController(target) : undefined;
  const valid = () => state.workspace?.id === workspace.id && state.workspace.revision === workspace.revision && samePaneLayout(currentLayout(), layout);
  const items = paneMenuItems({paneId, ...(key ? {tabKey: key} : {})}, {layout: currentLayout, valid,
    space: paneSpace,
    label: key => {const tab = paneLeaves(currentLayout().root).flatMap(pane => pane.tabs).find(tab => tabKey(tab) === key); return tab ? tabLabel(tab) : key;}, change: applyLayout,
    newTab: pane => choosePaneTarget(pane), split: (pane, axis, key) => {
      const current = paneById(currentLayout(), pane); if (!current) return;
      if (key && current.tabs.length > 1) applyLayout(splitPane(currentLayout(), pane, axis, paneSpace(pane), key)); else choosePaneTarget(pane, axis);
    }, closeTab: key => applyLayout(closeTab(currentLayout(), key)), activate: activateConversationTab,
    view: key => {const tab = paneLeaves(currentLayout().root).flatMap(pane => pane.tabs).find(tab => tabKey(tab) === key); const target = tab ? controllerTarget(tab) : undefined; return target ? conversationController(target).transcript.node.dataset.view === 'grouped' ? 'grouped' : 'chronological' : 'chronological';},
    setView: (key, view) => {const tab = paneLeaves(currentLayout().root).flatMap(pane => pane.tabs).find(tab => tabKey(tab) === key); const target = tab ? controllerTarget(tab) : undefined; if (target) conversationController(target).transcript.setView(view);},
    overflow: purpose === 'context' && region.menu.dataset.overflow === 'true', sessionItems: tab?.kind === 'primary' ? primaryMenuItems() : tab?.kind === 'agent' ? agentMenuItems(tab.identity) : []});
  if (purpose === 'list' && leaf) {
    const first = items[0]; if (first) items[0] = {...first, heading: 'Pane actions', separatorBefore: true};
    items.unshift(...paneTabChoices(leaf, layout));
  }
  const trigger = region.menu; const box = trigger.getBoundingClientRect(); contextMenu.open(trigger, event ? {x: event.clientX, y: event.clientY} : {x: box.right, y: box.bottom}, purpose === 'list' ? 'Tabs in this pane' : 'Tab and view actions', items, () => valid() && (!owner || owner.workspaceId === state.workspace?.id));
}
function choosePaneTarget(pane: string, axis?: 'x' | 'y'): void {
  const workspace = state.workspace, layout = currentLayout(); if (!workspace || !paneById(layout, pane)) return;
  actions.palette('goto', target => {
    if (state.workspace?.id !== workspace.id || state.workspace.revision !== workspace.revision || !samePaneLayout(currentLayout(), layout)) {announce('This pane changed. Choose the action again.'); return;}
    try {conversationController(target);} catch (error) {showError(error); return;}
    let next = {...layout, focusedPane: pane};
    if (axis) {
      const key = tabKey(tabForTarget(target)); if (paneLeaves(layout.root).some(leaf => leaf.tabs.some(tab => tabKey(tab) === key))) {announce('This conversation is already open. Choose another conversation for this split.'); return;}
      const proposed = splitPane(next, pane, axis, paneSpace(pane)); if (proposed.root === next.root) {announce('This pane no longer has space for the split.'); return;} next = proposed;
    }
    next = normalizePaneLayout(openTab(next, tabForTarget(target))); applyLayout(next);
  });
}
export function openTabsList(pane: Pane = focusedPane): void { openPaneMenu(pane, undefined, undefined, 'list'); }
function tabLabel(tab: ConversationTab): string { return tabPresentation(tab).name; }
let dismissedPointer = false;
export function dismissDrawerPointer(event: PointerEvent): void {
  dismissedPointer = false;
  if (!drawerOpen || modal.openNow || contextMenu.openNow || (event.target as HTMLElement | null)?.closest?.('#sidebar, dialog, .context-menu, .command-menu')) return;
  event.preventDefault(); event.stopImmediatePropagation(); dismissedPointer = true; toggleSidebar(false);
}
export function consumeDrawerClick(event: MouseEvent): void {
  if (!dismissedPointer) return; dismissedPointer = false; if (event.detail === 0) return; event.preventDefault(); event.stopImmediatePropagation();
}
function appContextMenu(event: MouseEvent): void {
  if (event.defaultPrevented || nativeEditingTarget(event.target)) return;
  const target = event.target as HTMLElement | null, pane = target?.closest<HTMLElement>('.pane-leaf');
  if (!pane?.dataset.paneId || target?.closest('.transcript')) return;
  const tab = target?.closest<HTMLElement>('[data-tab-key]'); event.preventDefault(); openPaneMenu(pane.dataset.paneId, event, tab?.dataset.tabKey);
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
  for (const node of document.querySelectorAll<HTMLElement>('[data-control-icon]')) {
    const count = node.querySelector<HTMLElement>('#notices-count');
    controlIcon(node, node.dataset.controlIcon as CardIcon, node.getAttribute('aria-label') ?? node.textContent ?? '');
    if (count) node.append(count);
  }
  for (const id of ['primary-heading', 'agents-heading']) byId(id).prepend(cardIcon('chevron'));
  for (const name of ['input', 'change', 'keydown', 'pointerdown', 'select', 'scroll', 'compositionstart', 'compositionend'] as const) document.addEventListener(name, event => {if (event.isTrusted) devInteractionRevision++;}, {capture: true, passive: true});
  window.addEventListener('pagehide', event => {if (!event.persisted && !devNavigating) devReload?.destroy();});
  setRequestTiming((start, end) => {diagnostics.measure('control-roundtrip', start, end);});
  diagnostics.setHidden(document.hidden); if (document.hidden) connectionRecovery.suspend();
  setUnauthorizedHandler(error => {
    updateDiagnostics(false); source?.close(); streamWait?.reject(error); contextMenu.close(); modal.close(); connectionRecovery.auth(error);
  });
  document.addEventListener('contextmenu', appContextMenu);

  byId('tabs-open-primary').addEventListener('click', selectPrimary);
  new ResizeObserver(renderNavigation).observe(byId('conversation-panes'));
  matchMedia('(pointer: coarse)').addEventListener('change', renderNavigation);
  for (const id of ['project-button', 'compact-project-button']) byId(id).addEventListener('click', () => picker.openProject(byId(id)));
  byId('commands-button').addEventListener('click', () => actions.palette());
  byId('notifications-button').addEventListener('click', notices);
  byId('appearance-button').addEventListener('click', () => actions.appearance());
  for (const id of ['session-open', 'tabs-open-session']) byId(id).addEventListener('click', () => picker.open(projectPath()));
  byId('access-retry').addEventListener('click', () => connectionRecovery.reconnect());
  byId('session-new').addEventListener('click', () => picker.newSession(projectPath()));
  byId('agent-refresh').addEventListener('click', refreshRoster);
  byId('agent-new').addEventListener('click', () => actions.prepareText('/agent new'));

  byId('primary-heading').addEventListener('click', () => setSidebarSection('primary', !sidebarSections.primary));
  byId('agents-heading').addEventListener('click', () => setSidebarSection('agents', !sidebarSections.agents));
  byId('model-button').addEventListener('click', () => actions.modelPicker()); byId('thinking-button').addEventListener('click', () => actions.thinkingPicker());
  byId('agent-message-close').addEventListener('click', () => closeMessagePanel());
  byId('primary-row').addEventListener('click', selectPrimary);
  byId('sidebar-show').addEventListener('click', () => toggleSidebar(matchMedia('(min-width: 900px)').matches ? byId('sidebar').hidden : !drawerOpen));
  byId('sidebar-close').addEventListener('click', () => toggleSidebar(false));

  document.addEventListener('pointerdown', dismissDrawerPointer, true);
  document.addEventListener('click', consumeDrawerClick, true);
  byId('skip-composer').addEventListener('click', event => { event.preventDefault(); focusEditor(); });

  document.addEventListener('keydown', appKey);
  window.addEventListener('resize', () => { renderNavigation(); for (const controller of controllers.values()) controller.composer.resize(); roster.schedule(); });
  window.addEventListener('beforeunload', event => { if ([...controllers.values()].some(controller => !controller.composer.canDispose)) event.preventDefault(); });
  document.addEventListener('visibilitychange', () => {
    diagnostics.setHidden(document.hidden); for (const controller of controllers.values()) controller.transcript.visibilityChanged();
    if (document.hidden) {
      connectionRecovery.suspend(); source?.close(); source = undefined;
      streamWait?.reject(new Error('The page is hidden.')); streamWait = undefined; resynchronizing = undefined;
      connected = false; renderAvailability();
    } else connectionRecovery.resume();
  });
}
export function devHold(): DevReloadHold | undefined {
  if (accessRequired) return 'auth';
  if (!connected || resynchronizing) return 'offline';
  if (modal.openNow || contextMenu.openNow) return 'modal';
  if (document.documentElement.classList.contains('resizing')) return 'resize';
  const selection = document.getSelection(); if (selection && !selection.isCollapsed) return 'selection';
  if (messageTarget.current?.preparing) return 'input';
  for (const controller of controllers.values()) {const hold = controller.composer.reloadHold; if (hold) return hold;}
  return undefined;
}
async function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {abort = () => reject(signal.reason); signal.addEventListener('abort', abort, {once: true}); if (signal.aborted) abort();});
  try {return await Promise.race([promise, cancelled]);} finally {signal.removeEventListener('abort', abort);}
}
export async function drainDev(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted(); await waitForSignal(selectionQueue.drain(), signal);
  await Promise.all([...controllers.values()].map(controller => controller.composer.drain(signal)));
  await waitForSignal(preferences.drain(), signal); signal.throwIfAborted();
  if (selectionQueue.unsettled || preferences.pending || [...controllers.values()].some(controller => controller.composer.unsaved || controller.composer.reloadHold)) throw new Error('Retained writes changed during the drain.');
}
function devEntry(controller: ConversationController): DevCheckpointEntry {
  const saved = controller.saved; if (!saved || !sameTarget(saved.target, controller.target)) throw new Error('Target preservation metadata is unavailable.');
  const epoch = controller.target.kind === 'agent' ? state.conversations.get(targetIdentity(controller.target))?.connectionEpoch : undefined;
  if (controller.target.kind === 'agent' && (!epoch || !Number.isSafeInteger(epoch))) throw new Error('Agent observation metadata is unavailable.');
  const editor = controller.composer.editor;
  return {targetKey: saved.targetKey, target: controller.target.kind === 'primary' ? {...controller.target} : {...controller.target, connectionEpoch: epoch as number},
    draftRevision: controller.composer.serverDraftRevision ?? saved.draft.revision, readingRevision: saved.reading.revision, presentationRevision: saved.presentation?.revision ?? 0,
    selection: {start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection}};
}
export function captureDevCheckpoint(): ReturnType<DevReloadHooks['captureCheckpoint']> {
  const workspaceId = state.workspace?.id; if (!workspaceId) throw new Error('No workspace is hydrated.');
  const owned = [...controllers.values()].filter(controller => controller.workspaceId === workspaceId), targets = owned.map(devEntry);
  const recipient = messageTarget.current;
  const messageRecipient = recipient ? owned.find(controller => controller.target.kind === 'agent' && controller.target.identity === recipient.identity)?.saved?.targetKey : undefined;
  if (recipient && (!messageTarget.valid(recipient) || !messageRecipient)) throw new Error('Message preservation metadata changed.');
  const focused = owned.find(controller => controller.composer.editor === document.activeElement);
  return {workspaceId, focusedPane: currentLayout().focusedPane, targets, ...(messageRecipient ? {messageRecipient} : {}),
    ...(focused?.saved ? {focusedControl: {targetKey: focused.saved.targetKey, kind: focused.saved.targetKey === messageRecipient ? 'message' : 'composer'}} : {})};
}
function devTargetMatches(entry: DevCheckpointEntry, saved: TargetState): boolean {
  if (saved.targetKey !== entry.targetKey || !sameTarget(saved.target, entry.target.kind === 'primary' ? entry.target : {kind: 'agent', identity: entry.target.identity})) return false;
  if (saved.draft.revision !== entry.draftRevision || saved.reading.revision !== entry.readingRevision || (saved.presentation?.revision ?? 0) !== entry.presentationRevision || saved.unconfirmed.length) return false;
  if (entry.target.kind === 'primary') return state.primaries.get(entry.target.key)?.epoch === entry.target.epoch;
  const epoch = state.conversations.get(targetIdentity(saved.target))?.connectionEpoch;
  return !!epoch && Number.isSafeInteger(epoch) && epoch > 0;
}
function devRecordsCurrent(entries: DevCheckpointEntry[], values: TargetState[]): boolean {
  return entries.length === values.length && entries.every((entry, index) => {const saved = values[index]; return !!saved && devTargetMatches(entry, saved);});
}
function devRestoreSourceCurrent(entry: DevCheckpointEntry): boolean {
  const target: Target = entry.target.kind === 'primary' ? entry.target : {kind: 'agent', identity: entry.target.identity};
  const saved = targetState(target); if (saved && !devTargetMatches(entry, saved)) return false;
  const controller = controllers.get(controllerKey(state.workspace?.id ?? '', target));
  return !controller || !controller.composer.unsaved && (controller.composer.serverDraftRevision ?? entry.draftRevision) === entry.draftRevision;
}
async function restoreDevRecipient(checkpoint: DevReloadCheckpoint, values: TargetState[], signal: AbortSignal): Promise<boolean> {
  if (!checkpoint.messageRecipient) return !messageTarget.current;
  const recipient = values.find(saved => saved.targetKey === checkpoint.messageRecipient); if (recipient?.target.kind !== 'agent') return false;
  await waitForSignal(messageTarget.open(recipient.target.identity), signal);
  const captured = messageTarget.current;
  return !!captured && messageTarget.valid(captured) && captured.prepared?.targetState.targetKey === checkpoint.messageRecipient;
}
async function restoreDevReading(owned: ConversationController[], signal: AbortSignal, current: () => boolean): Promise<boolean> {
  for (const controller of owned) {
    const reading = controller.saved?.reading;
    if (controller.root.hidden || !reading?.anchorId || reading.followTail) continue;
    await waitForSignal(loadControllerHistory(controller), signal);
    if (!current() || !controller.historyReady || !state.conversations.get(targetIdentity(controller.target))?.entries.has(reading.anchorId)) return false;
  }
  return current();
}
function restoreDevControls(checkpoint: DevReloadCheckpoint, owned: ConversationController[]): boolean {
  if (checkpoint.targets.some((entry, index) => !!entry.selection && (!owned[index] || entry.selection.end > (owned[index]?.composer.editor.value.length ?? 0)))) return false;
  const control = checkpoint.focusedControl, focused = control ? owned.find(controller => controller.saved?.targetKey === control.targetKey) : undefined;
  if (control && (!focused?.elements.root.isConnected || focused.elements.root.closest('[hidden],[inert]') || control.kind === 'message' && control.targetKey !== checkpoint.messageRecipient)) return false;
  for (const [index, controller] of owned.entries()) {const selection = checkpoint.targets[index]?.selection; if (selection) controller.composer.editor.setSelectionRange(selection.start, selection.end, selection.direction);}
  focused?.composer.editor.focus({preventScroll: true}); return true;
}
export async function restoreDevCheckpoint(checkpoint: DevReloadCheckpoint, signal: AbortSignal): Promise<boolean> {
  const revision = devInteractionRevision;
  const epochs = new Map(checkpoint.targets.flatMap(entry => entry.target.kind === 'agent' ? [[entry.target.identity, state.conversations.get(targetIdentity({kind: 'agent', identity: entry.target.identity}))?.connectionEpoch] as const] : []));
  const current = () => !signal.aborted && revision === devInteractionRevision && checkpoint.workspaceId === state.workspace?.id && !devHold() && [...epochs].every(([identity, epoch]) => !!epoch && state.conversations.get(targetIdentity({kind: 'agent', identity}))?.connectionEpoch === epoch);
  if (!current() || currentLayout().focusedPane !== checkpoint.focusedPane || !paneById(currentLayout(), checkpoint.focusedPane)) return false;
  const savedTargets = await Promise.all(checkpoint.targets.map(entry => request<TargetState>(
    `/api/workspaces/${encodeURIComponent(checkpoint.workspaceId)}/targets/${encodeURIComponent(entry.targetKey)}`, 'GET', undefined, undefined, signal)));
  if (!current() || !devRecordsCurrent(checkpoint.targets, savedTargets)) return false;
  if (!checkpoint.targets.every(devRestoreSourceCurrent)) return false;
  const owned = savedTargets.map(saved => {state = {...state, targets: new Map(state.targets).set(saved.targetKey, saved)}; const controller = conversationController(saved.target); controller.saved = saved; return controller;});
  if (!await restoreDevRecipient(checkpoint, savedTargets, signal) || !current()) return false;
  renderAll(); if (!await restoreDevReading(owned, signal, current)) return false;
  const refreshed = savedTargets.flatMap(saved => {const value = targetState(saved.target); return value ? [value] : [];});
  return current() && devRecordsCurrent(checkpoint.targets, refreshed) && restoreDevControls(checkpoint, owned) && current();
}
let cssState: Array<{controller: ConversationController; geometry: ReturnType<Transcript['captureGeometry']>}> = [];
export function captureDevCssState(): unknown {
  cssState = [...controllers.values()].filter(controller => controller.workspaceId === state.workspace?.id && !controller.root.hidden && !controller.root.inert).map(controller => ({controller, geometry: controller.transcript.captureGeometry()})); return cssState;
}
export function applyDevCssState(captured: unknown): void {
  if (captured !== cssState) return; refreshPaneSizes();
  for (const {controller, geometry} of cssState) {controller.transcript.applyGeometry(geometry); controller.composer.resize();}
}
let uiReady = false;
async function finishStartup(): Promise<void> {
  await initializeDevReload();
  if (uiReady || !connected || document.hidden) return;
  uiReady = true; document.dispatchEvent(new Event('ui-ready')); renderNavigation();
}
async function initializeDevReload(): Promise<void> {
  if (devReload) {await devReload.ready; return;}
  const notice = element('span', 'secondary'); notice.setAttribute('role', 'status');
  devReload = new DevReload({interaction: () => {const reason = devHold(); return {revision: devInteractionRevision, safe: !reason, ...(reason ? {reason} : {})};}, drain: drainDev,
    captureCheckpoint: captureDevCheckpoint, writeCheckpoint: checkpoint => sessionStorage.setItem(devCheckpointKey, JSON.stringify(checkpoint)),
    readCheckpoint: () => {const value = sessionStorage.getItem(devCheckpointKey); return value === null ? null : JSON.parse(value);}, restoreCheckpoint: restoreDevCheckpoint, clearCheckpoint: () => sessionStorage.removeItem(devCheckpointKey),
    captureCssState: captureDevCssState, afterCssApply: applyDevCssState,
    status: status => {
      devNavigating = status.state === 'navigating'; notice.replaceChildren();
      if (!['idle', 'applied'].includes(status.state)) notice.append(element('span', undefined, `Development update: ${status.state} (${status.code})`));
      if (status.retryable && (status.state === 'deferred' || status.state === 'offline' || status.state === 'failed' && ['stylesheet', 'drain', 'ack'].includes(status.code))) notice.append(button('Retry update', () => {if (status.state === 'offline') devReload?.reconnect(); void devReload?.resume();}));
      if (!notice.isConnected) workbenchStatus.node.append(notice);
    }});
  await devReload.ready;
}
function updateDiagnostics(authorized: boolean): void {
  const generation = document.querySelector('meta[name="ui-generation"]')?.getAttribute('content') ?? '', client = document.querySelector('meta[name="ui-client"]')?.getAttribute('content') ?? '';
  const active = authorized && /^[a-f0-9]{64}$/.test(generation) && /^[a-f0-9]{24}$/.test(client);
  if (active !== diagnosticsActive) {diagnosticsActive = active; diagnostics.setActive(active);}
}
async function bootstrap(signal?: AbortSignal): Promise<void> {
  const workspace = new URL(location.href).searchParams.get('workspace');
  const read = <T>(path: string, method = 'GET', body?: unknown) => request<T>(path, method, body, undefined, signal && (method === 'GET' ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : signal));
  const pending = read<Bootstrap>(`/api/bootstrap${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`).then(value => hydrateVisible(value, read));
  const data = await (signal ? waitForSignal(pending, signal) : pending); signal?.throwIfAborted();
  snapshot = data; launchCwd = data.launchCwd; state = replaceSnapshot(state, data); updateDiagnostics(true);
  const url = new URL(location.href); url.searchParams.set('workspace', data.workspace.id); history.replaceState(null, '', url);
}
async function start(): Promise<void> {
  bind(); renderNavigation();
  try {
    await authenticate(); await refreshVisible(bootstrap, loadVisibleHistory, showError);
    renderAll(); await stream(); connectionRecovery.healthy();
  } catch (error) {
    connectionRecovery.lost(error);
  }
}
void start();
