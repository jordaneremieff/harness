import type { AgentHistoryPage, AgentRow, Bootstrap, EventData, HistoryPage, OperationView, PrimaryView, ProjectedFrame, Snapshot, Target, TargetState, ThreadListItem, ThreadOverview, ThreadPageView, Workspace } from '../shared/api.ts';
import { draftHasContent, draftImageFingerprint, LIMITS, resolveAppearance } from '../shared/api.ts';
import { Actions } from './actions.ts';
import { AgentCommandInventory } from './agent-commands.ts';
import {InputEchoes} from './input-echoes.ts';
import {recallItems} from './message-recall.ts';
const inputEchoes=new InputEchoes();
import {AgentInspection} from './agent-inspection.ts';
import {taskReference, type ConversationTask} from './conversation-tasks.ts';
import type {AgentInspectionView, ResultSelector} from '../shared/inspection.ts';
import type { ConversationLayout, WorkspaceTab as ConversationTab, FileTab } from '../shared/api.ts';
import type {FileDirectoryPage, FileSearchResult, FileRootSelection, FileText, FileDraftState, FileDraft, FileSave, FileMutation, FileWatchState, FileWatchScope, FileChanges} from '../shared/files.ts';
import {FilesTree, type FileTreeAction} from './files-tree.ts';
import {FileWatch} from './file-watch.ts';
import {movedWorkspaceFiles, type FileMove} from './file-identity.ts';
import {FilesViews} from './files-views.ts';
import {FileRootChoice} from './file-root.ts';
import {chooseWorkingFile} from './working-file-chooser.ts';
import { activeTab, ConversationCaptions, conversationIdentityText, type CaptionRow, closeTab, duplicateTabTails, FileBrowseState, layoutTarget, openTab, switchTab, tabForTarget, tabKey, workspaceLayout } from './tabs.ts';
import { paneLeaves, paneById, activatePaneTab, movePaneTab, resizePaneSplit, minimumPaneSize, paneSplitGeometry, splitPane, normalizePaneLayout, samePaneLayout, type PaneLeaf } from './pane-layout.ts';
import { TabStrip } from './tabs-view.ts';
import { cardAction, controlIcon, type CardIcon } from './card-icons.ts';
import { thinkingExpanded } from './transcript-presentation.ts';
import { contextMenu, nativeEditingTarget, paneMenuItems, type ContextItem } from './context-menu.ts';
import { ProjectPicker } from './picker.ts';
import type { SelectionChange } from './actions.ts';
import { Composer, createComposerElements, validComposerReloadState, type ComposerReloadState } from './composer.ts';
import { includedText } from './composer-attachments.ts';
import {writeReloadState,readReloadState,deleteReloadState} from './reload-storage.ts';
import { WorkbenchStatus } from './workbench-status.ts';
import { VersionStatus } from './version-status.ts';
import { UpdateNotice } from './update-notice.ts';
import { HealthStatus } from './health-status.ts';
import { ConnectionRecovery, connectionSurface as connectionSurfaceFor, type ConnectionPhase } from './connection-state.ts';
import { announce, byId, button, copy, details, element, empty, placeRetained, rawText, setText } from './dom.ts';
import {StableViews} from './stable-views.ts';
import { ExtensionDialogs, extensionStatus } from './extensions.ts';
import { Modal } from './modal.ts';
import { openImagePreview } from './image-preview.ts';
import { Transcript, type ToolSubjectCaption } from './render.ts';
import { ReferenceResolver, type ReferenceDestination, type ReferenceQuery, type ReferenceResolution } from './references.ts';
import { imageUrl } from './image.ts';
import { historyBecameReady, pageToReadingAnchor } from './transcript-history.ts';
import { Roster } from './roster.ts';
import { ThreadExplorer, ThreadReader } from './threads-view.ts';
import { THREAD_PAGE_EVENTS } from './threads.ts';
import {noticeGroups, noticeTarget, type NoticeGroup} from './notice-presentation.ts';
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
import {DevReload, devReloadPresentation, type DevReloadCheckpoint, type DevReloadHooks, type DevCheckpointEntry, type DevReloadHold, type DevReloadNotice} from './dev-reload.ts';
import { conversationPresentation, presentationGlyph, presentationName, projectIdentity, composerFolder, agentHistoryNote, readsSavedMessages, agentComposerState, settingsLabel } from './conversation-presentation.ts';
import type { AgentComposerState, ConversationPresentation } from './conversation-presentation.ts';
import type { ComposerStateView } from './composer.ts';
import { newerOperation, mergeOperationMap } from './operation-state.ts';
import { ApiError, connect, errorMessage, operation, request, setRequestTiming } from './transport.ts';
import type { ReceivedEvent } from './transport.ts';
import {CONTROL_LIMITS, CONTROL_ROUTES, type ControlRequest} from '../shared/control.ts';
import {BrowserControl, ControlRefusal, controlLayout, controlPaneBox, controlProvenance} from './control.ts';

export let state = createState();
let snapshot: Bootstrap | Snapshot | undefined;
let launchCwd: string | undefined;
let source: EventSource | undefined;
let connected = false;
let connectionId: string | undefined;
const composingFields = new Set<EventTarget>();
let controlStatus = '';
let controlStatusWorkspace: string | undefined;
export let drawerOpen = false;
let connectionPhase: ConnectionPhase = 'healthy';
let connectionError: unknown;
let connectionSurface = '';
let streamWait: {resolve: () => void; reject: (error: unknown) => void} | undefined;
let resynchronizing: Promise<void> | undefined;

type TranscriptTarget = {workspaceId: string; saved: TargetState; controller: ConversationController};

let selecting = false;
type Pane = string;
export let focusedPane: Pane = 'pane-1';
export function focusPane(pane: Pane): void {
  const leaf = paneById(currentLayout(), pane); if (!leaf) return;
  const tab = leaf.tabs.find(tab => tabKey(tab) === leaf.active), target = tab ? controllerTarget(tab) : undefined;
  if(target&&!conversationController(target).inspection?.active)conversationController(target).passive = false;
  applyLayout({...currentLayout(), focusedPane: pane});
  if (tab?.kind === 'file' && state.workspace) filesViews.view(state.workspace,tab).focus();
  else if (target) {const controller=conversationController(target);if(controller.inspection?.active)controller.inspection.scroller.focus({preventScroll:true});else controller.composer.focus();}
}
function updatePaneFocus(pane: Pane, event?: Event): void {
  if (focusedPane === pane) return;
  if (event?.type === 'pointerdown') workbenchStatus.holdGeometry(event as PointerEvent);
  applyLayout({...currentLayout(), focusedPane: pane});
}
function markFocusedPane(): void {
  for (const [id, pane] of paneRegions) pane.node.dataset.focused = String(id === focusedPane);
  renderWorkbenchStatus();
}
let reloadTail = Promise.resolve();
const snapshotBuffers = new Set<{events: UiEvent[]; bytes: number; overflow: boolean}>();
const modal = new Modal(focusEditor);
const preferences = new PreferenceQueue();
const diagnostics = new BrowserDiagnostics();
const versionStatus = new VersionStatus(() => modal.open('Copy UI version identity'));
new UpdateNotice(versionStatus.identity, {storage: sessionStorage, before: byId('workbench-version'), details: (title, body) => {modal.open(title); modal.body.append(...body);}, copy: (text, anchor) => {void copy(text, anchor);}});
new HealthStatus(modal);
let diagnosticsActive = false;
let devReload: DevReload | undefined;
let devInteractionRevision = 0;
let selectionIntentRevision = 0;
let paneSelectionRevision = 0;
let devRestoreOwner: object | undefined;
let devRestoreWake: (() => void) | undefined;
let devNavigating = false;
let reloadStateKey:string|undefined;
let preparedReloadState:{key:string;revision:number;workspace:string}|undefined;
const devCheckpointKey = 'ui:dev-checkpoint';
type ConversationController = {workspaceId: string; target: Target; instanceId: string; root: HTMLElement; nodes: Map<string, HTMLElement>;
  elements: import('./composer.ts').ComposerElements; composer: Composer; transcript: Transcript; inspection?: AgentInspection; readingGeometry?: ReturnType<Transcript['captureGeometry']>; saved?: TargetState; geometry?: ReturnType<Transcript['captureGeometry']>; messageRetention?: object;
  abort: AbortController; historyAbort: AbortController; cursor: string | null; before: number | null; loading: boolean; preparing: boolean; passive?: boolean; historyReading?: TargetState['reading']; historyReady: boolean; historyBoundaryLoaded: boolean; historyComplete?: boolean; historyError?: {code?: string; message: string}; hasEntries?: boolean; initialized: boolean; showThinking: boolean; historyWork?: Promise<void>; connectionError?: string; connection?: Pick<import('../shared/api.ts').TargetPreparation, 'availability' | 'capabilities' | 'reason'> & {stale?: true}; refreshing?: boolean; resizer?: Resizer; fillingEarlier?: boolean};
const controllers = new Map<string, ConversationController>();
const agentStarts = new Map<string, {pending: boolean; reason?: string}>();
let controllerSerial = 0;
function controllerKey(workspace: string, target: Target): string { return JSON.stringify([workspace, targetIdentity(target)]); }
function controllerNode(controller: ConversationController, key: string): HTMLElement {
  const node = controller.nodes.get(key); if (!node) throw new Error('Conversation control is missing.'); return node;
}
function primaryNode<T extends HTMLElement = HTMLElement>(key: string): T { const target = primaryTarget(); if (!target) throw new Error('No Primary is selected.'); return controllerNode(conversationController(target), key) as T; }
function agentNode<T extends HTMLElement = HTMLElement>(key: string): T { const identity = selectedAgent(); if (!identity) throw new Error('No agent is selected.'); return controllerNode(conversationController({kind: 'agent', identity}), key) as T; }
function controllerTarget(tab: ConversationTab): Target | undefined { return tab.kind === 'file' ? undefined : tab.kind === 'agent' ? {kind: 'agent', identity: tab.identity} : primaryTarget(); }
export function primaryComposer(): Composer { const target = primaryTarget(); if (!target) throw new Error('No Primary is selected.'); return conversationController(target).composer; }
export function agentComposer(): Composer { const identity = selectedAgent(); if (!identity) throw new Error('No agent is selected.'); return conversationController({kind: 'agent', identity}).composer; }
function focusedTranscript(): Transcript | undefined {
  const target = layoutTarget(currentLayout(), primaryTarget());
  return target && state.workspace ? controllers.get(controllerKey(state.workspace.id, target))?.transcript : undefined;
}
function captureFind(controller?: ConversationController): ReturnType<Transcript['find']> | undefined {
  const target = layoutTarget(currentLayout(), primaryTarget());
  const captured = controller ?? (target && state.workspace ? controllers.get(controllerKey(state.workspace.id, target)) : undefined);
  if (!captured) return;
  return captured.transcript.find(() => !captured.abort.signal.aborted && captured.workspaceId === state.workspace?.id &&
    controllers.get(controllerKey(captured.workspaceId, captured.target)) === captured &&
    (captured.target.kind !== 'primary' || state.primaries.get(captured.target.key)?.epoch === captured.target.epoch));
}
let workspaceViews: StableViews | undefined;
export function stableViews(): StableViews {
  if (!workspaceViews) {const parent = byId('workspace').parentElement; if (!parent) throw new Error('Workspace layout is unavailable.'); workspaceViews = new StableViews(parent);
    const focusFile = (event:Event)=> {if ((event.target as HTMLElement).closest('.file-view')) {focusViewPane(event);renderWorkbenchStatus();}};
    workspaceViews.host.addEventListener('pointerdown',focusFile);workspaceViews.host.addEventListener('focusin',focusFile);
  }
  return workspaceViews;
}
function viewPane(node: HTMLElement): HTMLElement | null {return stableViews().slot(node)?.closest<HTMLElement>('.pane-leaf') ?? null;}
function focusViewPane(event:Event):void {const pane = viewPane(event.target as HTMLElement);if (pane?.dataset.paneId) updatePaneFocus(pane.dataset.paneId,event);}
function conversationController(target: Target, workspaceId = state.workspace?.id): ConversationController {
  if (!workspaceId) throw new Error('No workspace is selected.');
  const key = controllerKey(workspaceId, target); const existing = controllers.get(key); if (existing) return existing;
  collectControllers(); if (controllers.size >= LIMITS.conversationTabs) throw new Error('Close a settled conversation before opening another.');
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
  const latest = add('latest', 'button', 'latest') as HTMLButtonElement; latest.type = 'button'; latest.textContent = 'Latest'; latest.setAttribute('aria-label', 'Latest message'); latest.hidden = true;
  nodes.set('transcript-region',region);region.append(absent, scroller); const above = add('widgets-above', 'div', 'widgets'), below = add('widgets-below', 'div', 'widgets');
  const elements = createComposerElements(instanceId); elements.root.hidden = false;
  elements.meta?.prepend(latest);
  for (const [name, node] of Object.entries(elements)) if (node) nodes.set(name === 'root' ? 'composer' : name, node);
  const stop = elements.root.querySelector<HTMLButtonElement>('.stop'); if (!stop) throw new Error('Stop control is missing.'); nodes.set('stop', stop); nodes.set('abort', stop);
  const resize = elements.root.querySelector<HTMLElement>('.resizer'); if (resize) nodes.set('composer-resizer', resize);
  const activity = add('activity', 'p', 'exception'); activity.setAttribute('role', 'status'); const queued = element('ul', 'queued-list'); queued.hidden = true; queued.setAttribute('aria-label', 'Queued messages'); nodes.set('queued', queued); elements.root.prepend(activity, queued);
  root.append(observed, notice, region, above, elements.root, below); stableViews().mount(root);
  if (target.kind === 'agent') root.insertBefore(createHistoryNote(add), region);
  const controller = {workspaceId, target: {...target}, instanceId, root, nodes, elements, abort: new AbortController(), historyAbort: new AbortController(), cursor: null, before: null, loading: false, preparing: false, passive: true, historyReady: false, historyBoundaryLoaded: false, initialized: false, showThinking: true} as ConversationController;
  wireSettingPickers(target, elements);
  controller.composer = new Composer(elements, {workingFile:stage=>composerWorkingFile(controller,stage),recallItems:()=>recallItems(inputEchoes.entries(controller.workspaceId,controller.target,(()=>{const conversation=state.conversations.get(targetIdentity(controller.target));return conversation?conversationBlocks(conversation):[];})())),fileSearch:(query,signal)=>searchWorkingFiles(controller,query,signal),fileStage:(path,signal,present,stage)=>stageMentionedFile(controller,path,signal,present,stage),changed:()=>{devInteractionRevision++;},captured: submission=>{const conversation=state.conversations.get(targetIdentity(controller.target));inputEchoes.capture(workspaceId,submission,conversation?conversationBlocks(conversation):[]);renderController(controller);},failed:(id,uncertain)=>{inputEchoes.failed(id,uncertain);renderController(controller);},prepareInput: () => !controller.passive, imageState: refreshComposerImages, imageInput: captured => composerImageInput(controller, captured), recovery: () => recovery.open(), layoutHeight: () => stableViews().height(elements.root), enterSends: () => state.workspace?.enterSendsMessages === true, timing: (start, end) => {if (controller.workspaceId === state.workspace?.id && !elements.root.closest('[hidden],[inert]')) diagnostics.measure('editor-echo', start, end);}, submitted: result => {inputEchoes.settle(result);showOperation(result, workspaceId);renderController(controller);}, unknownCommand: (text, literal) => target.kind === 'primary' && sameTarget(primaryTarget(), target) ? actions.unknown(text, literal) : false,
    ...(target.kind === 'primary' ? {commands: () => actions.commandOptions(), moreCommands: (captured: Target) => actions.continueCommands(captured)} : {}),
    ...agentCommandHooks(controller),
    retained: (workspace, captured) => { if (workspace === state.workspace?.id && captured.kind === 'agent') renderMessageResume(captured.identity); }});
  controller.transcript = new Transcript({transcript: scroller, latest, earlier}, {earlier: () => loadEarlierRows(controller), operatorInput: target.kind === 'primary', references, subject: toolSubjectCaption, readTaskResult:async(reference,signal)=>{const value=await request<AgentInspectionView>(`/api/agents/${encodeURIComponent(reference.sessionId)}/inspect?workspace=${encodeURIComponent(workspaceId)}`,'POST',{view:'result',submissionId:reference.submissionId,...(reference.requestId?{requestId:reference.requestId}:{})},undefined,AbortSignal.any([signal,controller.abort.signal,AbortSignal.timeout(15_000)]));if(value.view!=='result')throw new Error('The task result view changed.');return value;}, activity:()=>{if (footerController === controller) renderWorkbenchStatus();}, cwd: () => target.kind === 'primary' ? state.primaries.get(target.key)?.cwd : state.roster.get(target.identity)?.cwd, timing: (metric, start, end) => {diagnostics.measure(metric, start, end);},
    presentation: (expanded, thinking, view) => { controller.showThinking = thinking; void savePresentation(controllerCapture(controller), expanded, thinking, view); },
    reading: reading => { void saveReading(controllerCapture(controller), reading); },
    ...(target.kind === 'primary' ? {fork: (message: import('../shared/api.ts').MessageView, entry: string) => { if (sameTarget(target, primaryTarget())) actions.fork(entry, rawText(message.parts)); }, output: (more: import('../shared/api.ts').OutputContinuation) => loadControllerOutput(controller, more)} : {}),
    image: part => imageUrl(part, controller.target, controller.workspaceId),preview: (part, url, invoker) => openImagePreview(modal, part, url, invoker),result:(identity,selector)=>inspectAgent(identity,'result',selector)});
  bindControllerReadingIntent(controller);
  earlier.addEventListener('click', () => { void loadControllerHistory(controller, true); });
  stop.addEventListener('click', () => { void stopController(controller); });
  root.addEventListener('pointerdown', focusViewPane); root.addEventListener('focusin', focusViewPane);
  elements.editor.addEventListener('focus', () => { footerController = controller; renderWorkbenchStatus(); });
  bindControllerInput(controller);
  controllers.set(key, controller);
  attachInspection(controller,region);return controller;
}
function attachInspection(controller:ConversationController,region:HTMLElement):void {
  const {target,workspaceId,root}=controller;
    const identity=target.kind==='agent'?target.identity:`primary:${target.key}`;
    const storageKey=`ui:inspection:${JSON.stringify([workspaceId,identity])}`;
    controller.inspection=new AgentInspection(identity,{
      read:(body,signal)=>target.kind==='agent'?request<AgentInspectionView>(`/api/agents/${encodeURIComponent(target.identity)}/inspect?workspace=${encodeURIComponent(workspaceId)}`,'POST',body,undefined,AbortSignal.any([signal,AbortSignal.timeout(15_000)])):Promise.reject(new Error('Primary tasks use recorded conversation history.')),
      readResult:async(identity,selector,signal)=>{const value=await request<AgentInspectionView>(`/api/agents/${encodeURIComponent(identity)}/inspect?workspace=${encodeURIComponent(workspaceId)}`,'POST',{view:'result',...selector},undefined,AbortSignal.any([signal,AbortSignal.timeout(15_000)]));if(value.view==='result')controller.transcript.acceptTaskResult(value);return value;},
      tasks:()=>inspectionTaskRows(controller),entryKey:id=>target.kind==='agent'?controller.transcript.loadedReference({text:String(id),owner:target.identity,field:'entryId'},target.identity):undefined,history:target.kind==='agent',showConversation:(entry,identity)=>{if(identity&&(controller.target.kind!=='agent'||identity!==controller.target.identity)){void navigateReference({target:{kind:'agent',identity},entryId:entry},true).catch(showError);return;}const owner=controller.target.kind==='agent'?controller.target.identity:state.primaries.get(controller.target.key)?.sessionId;const loaded=owner?controller.transcript.loadedReference({text:entry,owner,field:'entryId'},owner):undefined;controller.transcript.revealEntry(loaded??entry);},moreConversation:()=>{void loadControllerHistory(controller,true);},
      returned:()=>{controllerNode(controller,'transcript').focus({preventScroll:true});},changed:()=>{devInteractionRevision++;if(controller.inspection?.active)controller.passive=true;renderController(controller);},current:()=>controller.workspaceId===state.workspace?.id&&!controller.abort.signal.aborted,
      restore:()=>{const value=sessionStorage.getItem(storageKey);return value?JSON.parse(value):null;},save:value=>{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}});
    root.insertBefore(controller.inspection.node,region);
}
function inspectionTaskRows(controller:ConversationController):ConversationTask[]{
  const rows=[...controller.transcript.taskRows()];
  if(controller.target.kind==='agent')for(const operation of state.operations.values()){
    const receipt=operation.receipt;if(receipt?.kind!=='durable'||receipt.identity!==controller.target.identity)continue;
    const reference=taskReference({sessionId:receipt.identity,submissionId:receipt.submissionId,requestId:receipt.requestId});if(!reference)continue;
    const input=controller.saved?.retainedInputs.find(item=>item.operationId===operation.id);
    rows.push({key:`ui:${operation.id}`,entryId:'',reference,subject:input?.text.split(/\r?\n/,1)[0]?.slice(0,80)||'Message from this UI',state:'awaiting',asked:true,asker:'You',time:Date.parse(operation.createdAt)});
  }
  return rows;
}
function renderInspection(controller:ConversationController):void {
  const inspection=controller.inspection;if(!inspection)return;
  const projected=!!controller.elements.root.dataset.messagePanel;
  if(controller.target.kind==='agent')inspection.observe(state.conversations.get(targetIdentity(controller.target))?.frame,connected&&state.agentAvailability.get(controller.target.identity)?.state==='live');
  else inspection.observe(undefined,connected);
  const region=controllerNode(controller,'transcript-region');
  const covered=inspection.active||threadHost===controller;
  if(covered&&!region.hidden)controller.readingGeometry=controller.transcript.captureGeometry();
  region.hidden=covered;
  if(!covered&&controller.readingGeometry){const geometry=controller.readingGeometry;controller.readingGeometry=undefined;controller.transcript.applyGeometry(geometry);}
  controller.elements.root.hidden=!controller.saved||covered&&!projected;
  if(controller.target.kind==='agent')controllerNode(controller,'history-note').hidden=covered||!controllerNode(controller,'history-note-line').textContent;
  inspection.visibility(inspection.active&&!controller.root.hidden&&!controller.root.inert&&controller.workspaceId===state.workspace?.id);
  controller.root.classList.toggle('inspection-active',inspection.active);
}
function bindControllerInput(controller:ConversationController):void {
  for(const name of ['pointerdown','keydown','beforeinput'])controller.elements.root.addEventListener(name,()=> {if(controller.passive) {controller.passive = false;renderController(controller);}}, {capture:true});
}
function bindControllerReadingIntent(controller: ConversationController): void {
  const interrupt = (event: Event) => {
    if (!event.isTrusted) return;
    const reading = controller.historyReading ?? controller.saved?.reading;
    controller.historyReading = undefined; controller.transcript.abandonRestore(reading);
  };
  for (const name of ['pointerdown', 'keydown', 'beforeinput', 'input', 'change', 'compositionstart', 'compositionend', 'wheel']) controller.root.addEventListener(name, interrupt, {capture: true, passive: true, signal: controller.abort.signal});
}
function refreshComposerImages(workspace: string, saved: TargetState): void {
  if (workspace !== state.workspace?.id) return;
  const current = state.targets.get(saved.targetKey);
  if (!current || !sameTarget(current.target, saved.target)) return;
  state = {...state, targets: new Map(state.targets).set(saved.targetKey, {...current, imageAvailability: saved.imageAvailability, imageStorageError: saved.imageStorageError})};
}
function composerImageInput(controller: ConversationController, target: Target): {allowed: boolean; reason?: string} {
  if (!connected || controller.workspaceId !== state.workspace?.id || !sameTarget(controller.target, target)) return {allowed: false, reason: 'Reconnect this exact conversation before adding images.'};
  if (target.kind === 'primary') {
    const current = state.primaries.get(target.key);
    const pending = actions.modelChanging(target, state.operations.values()) || [...state.operations.values()].some(item => sameTarget(item.target, target) && item.kind === 'primary.control' && item.action === 'model' && ['reserved', 'dispatched', 'uncertain'].includes(item.state));
    if (pending) return {allowed: false, reason: 'The model change is not confirmed. Keep the images until it settles.'};
    if (current?.epoch !== target.epoch || current.lifecycle !== 'ready' || !current.model?.input.includes('image')) return {allowed: false, reason: 'The current model does not report image input. Choose an image-capable model before sending.'};
    return {allowed: true};
  }
  return {allowed: true};
}
function createHistoryNote(add: (name: string, tag: 'div' | 'p' | 'button', css?: string) => HTMLElement): HTMLElement {
  const note = add('history-note', 'div', 'history-note'); note.hidden = true;
  const line = add('history-note-line', 'p'); line.setAttribute('role', 'status');
  for (const [key, label] of [['history-reload', 'Reload messages'], ['history-details', 'Details']] as const) {
    const action = add(key, 'button') as HTMLButtonElement; action.type = 'button'; action.textContent = label; action.hidden = true; note.append(action);
  }
  note.prepend(line); return note;
}
function controllerCapture(controller: ConversationController): TranscriptTarget | undefined {
  return controller.saved ? {workspaceId: controller.workspaceId, saved: controller.saved, controller} : undefined;
}
function collectControllers(): void {
  const open = new Set(paneLeaves(currentLayout().root).flatMap(pane => pane.tabs).flatMap(tab => { const target = controllerTarget(tab); return target && state.workspace ? [controllerKey(state.workspace.id, target)] : []; }));
  const message = messageTarget.current; if (message) open.add(controllerKey(message.workspaceId, {kind: 'agent', identity: message.identity}));
  for (const [key, controller] of controllers) {
    const awaitingDraft = controller.workspaceId === state.workspace?.id && (controller.composer.serverDraftRevision ?? 0) > (targetState(controller.target)?.draft.revision ?? 0);
    const retainedMessage = controller.workspaceId === state.workspace?.id && !!controller.messageRetention;
    if (open.has(key) || retainedMessage || !controller.composer.canDispose || preferences.pending || awaitingDraft) continue;
    if (threadHost === controller) closeThread(false);
    controller.abort.abort(); controller.historyAbort.abort(); controller.resizer?.destroy(); controller.transcript.destroy(); controller.inspection?.destroy(); controller.composer.destroy(); stableViews().forget(controller.root); controller.root.remove(); controller.elements.root.remove(); controllers.delete(key);
  }
}
async function loadControllerOutput(controller: ConversationController, more: import('../shared/api.ts').OutputContinuation): Promise<import('../shared/api.ts').OutputPage> {
  const target = controller.target; if (target.kind !== 'primary') throw new Error('Output is unavailable.');
  const page = await request<import('../shared/api.ts').OutputPage>(`/api/primaries/${encodeURIComponent(target.key)}/history/output?epoch=${target.epoch}&entry=${encodeURIComponent(more.entryId)}&part=${more.part}&offset=${more.offset}`, 'GET', undefined, undefined, controller.abort.signal);
  if (controller.abort.signal.aborted || controller.workspaceId !== state.workspace?.id) throw new Error('The conversation changed.'); return page;
}
let footerController: ConversationController | undefined;
const workbenchStatus = new WorkbenchStatus();
const controlAttribution = element('span','secondary');controlAttribution.id = 'control-attribution';controlAttribution.setAttribute('role','status');controlAttribution.hidden = true;workbenchStatus.node.append(controlAttribution);
const messageTarget = new MessageTarget({workspace: () => state.workspace, prepare: prepareMessageTarget, paint: renderMessagePanel});
const references = new ReferenceResolver(resolveReference, destination => { void navigateReference(destination).catch(showError); });
const actions: Actions = new Actions({snapshot: currentSnapshot, primary, modelChanged: renderAvailability, get composer() { return primaryComposer(); }, commandsChanged: () => {const target = primaryTarget(); if (target && state.workspace) controllers.get(controllerKey(state.workspace.id, target))?.composer.commandsChanged();}, modal, selection, reload: reloadSelection, result: showOperation, rosterRefresh: refreshRoster, hasTranscript: () => !!focusedTranscript(), find: () => captureFind(), recovery: () => recovery.open(), primaryEntries: () => primary() ? primaryBlocks(state, primary()?.key ?? '') : [], agents: () => state.rosterOrder.flatMap(identity => { const row = agentRow(identity); return row ? [row] : []; }), selectedAgent: () => { const identity = selectedAgent(); return identity ? agentRow(identity) ?? {identity, storageId: '', cwd: '', availability: 'stored'} : undefined; }, selectAgent: row => { void selectAgent(row).catch(showError); }, notices, sidebar: toggleSidebar, view: (tools, expand) => focusedTranscript()?.expandLoaded(tools, expand), selectPrimary, agentCaption: identity => {return presentationCaptions().get(identity);}, agentStatus: row => presentation({kind: 'agent', identity: row.identity}).activity, agentPresentation:row=>presentation({kind:'agent',identity:row.identity}), conversationFacts: identity => agentFacts(agentRow(identity), state.conversations.get(targetIdentity({kind: 'agent', identity}))?.frame), copyAgent: () => { void copy(selectedAgent() ?? '', agentNode('view-notice')); }, inspectAgent,resultLookup:()=>{const target=layoutTarget(currentLayout(),primaryTarget());if(target)conversationController(target).inspection?.open('result');},
  tabs: {close: () => { const tab = activeTab(currentLayout()); if (tab) applyLayout(closeTab(currentLayout(), tabKey(tab))); }, switch: direction => applyLayout(switchTab(currentLayout(), direction)), layout: currentLayout},
});
const fileBrowse = new FileBrowseState();
const paneRegions = new Map<string, {node: HTMLElement; tabs: HTMLElement; content: HTMLElement; plus: HTMLButtonElement; menu: HTMLButtonElement; actions: HTMLButtonElement; previous: HTMLButtonElement; next: HTMLButtonElement}>();
const paneSplits = new Map<string, {node: HTMLElement; handle: HTMLElement; resizer?: Resizer; extent?: number}>();
const tabStrip = new TabStrip({layout: currentLayout, activate: activateConversationTab, close: key => applyLayout(closeTab(currentLayout(), key)),
  move: (key, pane, index) => {fileBrowse.keep(key);applyLayout(movePaneTab(currentLayout(), key, pane, index));}, label: tabLabel,unnamed:unnamedTab,keep:key=>fileBrowse.keep(key),
  identity: tab => tab.kind !== 'file' ? tabPresentation(tab).identityTail ?? '' : undefined,
  status: tab => { if (tab.kind === 'file') {const owner = state.workspace && filesViews.owner(state.workspace.id,tab);return {label:owner?.modified ? 'Modified' : '',glyph:owner?.modified ? '•' : '',tone:owner?.modified ? 'warning' : 'secondary'};}const view = tabPresentation(tab); return {label: [view.activity, view.tool?.name].filter(Boolean).join(' · '), glyph: presentationGlyph(view), tone:view.tone}; },
  overflow: (overflow, pane) => { const region = paneRegions.get(pane); if (region) region.menu.dataset.overflow = String(overflow); }},
  {panes: () => [...paneRegions].map(([id, pane]) => ({id, tabs: pane.tabs, controls: [...controllers.values()].find(owner => stableViews().slot(owner.root) === pane.content)?.root.id ?? pane.content.id})), conversations: byId('sidebar-conversations')});
let fileActionStatus = '';
export const fileWatch = new FileWatch({put:(workspace,roots,clientId)=>request<FileWatchState>(`/api/workspaces/${encodeURIComponent(workspace)}/files/watch`,'PUT',{clientId,roots}),changed:()=>renderWorkbenchStatus()});
function watchFiles(force = false):Promise<void> {
  const workspace = state.workspace;if (!workspace) return Promise.resolve();
  const roots = new Map<string,FileWatchScope>();for (const root of filesViews.scopes(workspace.id)) roots.set(root.rootId,{...root,directories:[]});
  const rootId = filesTree.rootId();if (rootId) {const root = roots.get(rootId) ?? {rootId,files:[],directories:[]};root.directories = filesTree.disclosed();roots.set(rootId,root);}
  return fileWatch.scope(workspace.id,[...roots.values()].sort((a,b)=>a.rootId.localeCompare(b.rootId)),force);
}
export const filesViews = new FilesViews(stableViews,(workspace,tab,signal)=>request<FileText>(`/api/files/roots/${encodeURIComponent(tab.rootId)}/text?path=${encodeURIComponent(tab.path)}&workspace=${encodeURIComponent(workspace)}`,'GET',undefined,undefined,signal),()=>state.workspace,
  (workspace,key,position)=> {if (state.workspace?.id === workspace) void selection({filePositions:{[key]:position}}).catch(showError);},()=> {if (state.workspace) for (const pane of paneLeaves(currentLayout().root)) for (const tab of pane.tabs) if (tab.kind === 'file' && filesViews.owner(state.workspace.id,tab)?.modified) fileBrowse.keep(tabKey(tab));tabStrip.render();renderWorkbenchStatus();}, {
    draft:(workspace,tab,signal)=>request<FileDraftState>(fileDocumentRoute(workspace,tab,'draft'),'GET',undefined,undefined,signal),
    put:(workspace,tab,expectedRevision,base,text,encoding)=>request<FileDraft>(fileDocumentRoute(workspace,tab,'draft'),'PUT',{expectedRevision,base,text,encoding}),
    save:(workspace,tab,expectedRevision)=>request<FileSave>(fileDocumentRoute(workspace,tab,'text'),'PUT',{expectedRevision}),
  });
function fileDocumentRoute(workspace:string,tab:FileTab,kind:'draft'|'text'):string {return `/api/files/roots/${encodeURIComponent(tab.rootId)}/${kind}?path=${encodeURIComponent(tab.path)}&workspace=${encodeURIComponent(workspace)}`;}
export const filesTree = new FilesTree(byId('files-tree'),{
  page:(rootId,path,cursor)=> {const workspace = state.workspace?.id;if (!workspace) return Promise.reject(new Error('No workspace is selected.'));return request<FileDirectoryPage>(`/api/files/roots/${encodeURIComponent(rootId)}/directory?path=${encodeURIComponent(path)}&workspace=${encodeURIComponent(workspace)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);},
  select:chooseFile,keep:(rootId,path)=>fileBrowse.keep(tabKey({kind:'file',rootId,path})),addToMessage:addFileToMessage,escape:focusEditor,scope:()=>{renderSectionCounts();return watchFiles();},status:message=> {fileActionStatus = message;renderWorkbenchStatus();},operation:fileTreeOperation});
export const fileRoot = new FileRootChoice({get:workspace=>request<FileRootSelection>(`/api/workspaces/${encodeURIComponent(workspace)}/files/root`),put:(workspace,path,revision)=>request<FileRootSelection>(`/api/workspaces/${encodeURIComponent(workspace)}/files/root`,'PUT',{path,expectedRevision:revision})},()=> {renderFiles();renderIdentity();});
export function chooseFile(rootId:string,path:string,focus = true):void {
  if (!state.workspace) return;
  try {applyLayout(fileBrowse.choose(currentLayout(),{kind:'file',rootId,path},key=> {const tab = paneLeaves(currentLayout().root).flatMap(pane=>pane.tabs).find(tab=>tabKey(tab) === key);if (tab?.kind !== 'file') return false;const owner = filesViews.owner(state.workspace?.id ?? '',tab);return !!owner && (owner.loading || owner.modified || owner.unsaved);}));if (focus) focusEditor();} catch (error) {showError(error);}
}
type FileMessageDestination = {target:Target; key:string; caption:string; controller?:ConversationController; reason?:string};
function fileMessageDestinations(workspace:string):FileMessageDestination[] {
  const targets = new Map<string,Target>();
  for (const pane of paneLeaves(currentLayout().root)) for (const tab of pane.tabs) {const target = controllerTarget(tab); if (target) targets.set(targetIdentity(target), target);}
  const destinations = [...targets].map(([key,target]) => {
    const controller = controllers.get(controllerKey(workspace,target));
    const loaded = controller?.workspaceId === workspace && !controller.abort.signal.aborted && sameTarget(controller.composer.target,target) && !!controller.composer.state;
    return {key,target:{...target},caption:presentationName(presentation(target)),controller,reason:loaded ? undefined : 'Draft is not loaded. Open this conversation first.'};
  });
  return destinations.map(item => destinations.some(other => other.key !== item.key && other.caption === item.caption)
    ? {...item,caption:`${item.caption} · ${item.target.kind === 'primary' ? 'Ordinary Primary' : 'Durable'}`} : item);
}
function fileMessageCurrent(workspace:string,destination:FileMessageDestination):boolean {
  return state.workspace?.id === workspace && fileMessageDestinations(workspace).some(item => item.key === destination.key && item.controller === destination.controller && !item.reason);
}
function fileMessageIdentity(target:Target):HTMLDetailsElement {
  const disclosure = element('details', 'file-message-identity');
  const primary = target.kind === 'primary' ? state.primaries.get(target.key) : undefined;
  const identity = target.kind === 'agent' ? `Durable conversation ID: ${target.identity}`
    : `Ordinary Primary\nSession ID: ${primary?.key === target.key && primary.epoch === target.epoch ? primary.sessionId ?? 'Unavailable' : 'Unavailable'}\nPrimary key: ${target.key}\nEpoch: ${target.epoch}\nTogether these identify the exact Primary target.`;
  disclosure.append(element('summary', undefined, 'Conversation identity'), element('p', 'secondary file-message-fact', identity));
  return disclosure;
}
export function addFileToMessage(rootId:string,path:string):void {
  const workspace = state.workspace?.id; if (!workspace) return;
  const abort = new AbortController(); modal.open('Add file to message',undefined,()=>abort.abort()); const token = modal.token;
  const destinations = fileMessageDestinations(workspace), select = element('select','file-message-destination'), label = element('label',undefined,'Destination conversation');
  const rootPath = fileRoot.selection?.root?.id === rootId ? fileRoot.selection.root.path : rootId, sourcePath = `${rootPath.endsWith('/') ? rootPath : `${rootPath}/`}${path}`;
  select.id = 'file-message-destination'; label.htmlFor = select.id;
  const placeholder = element('option',undefined,'Choose an open conversation'); placeholder.value = ''; select.append(placeholder);
  for (const item of destinations) {const option = element('option',undefined,`${item.caption}${item.reason ? ` · ${item.reason}` : ''}`); option.value = item.key; option.disabled = !!item.reason; option.title = item.caption; select.append(option);}
  const tab = activeTab(currentLayout()), focused = tab && controllerTarget(tab);
  const preferred = focused && destinations.find(item => sameTarget(item.target,focused) && !!item.controller && item.controller.root.isConnected && !item.controller.root.closest('[hidden],[inert]'));
  select.value = preferred?.key ?? '';
  const destinationDetail = element('div','file-message-detail');
  const current = ():FileMessageDestination|undefined => destinations.find(item => item.key === select.value);
  const add = button('Add file',()=> {const destination = current(); if (destination && !destination.reason) void stageFileMessage(workspace,rootId,path,sourcePath,destination,token,abort,add,select);});
  const paint = ():void => {
    const item = current(); add.disabled = !item || !!item.reason; destinationDetail.replaceChildren();
    if (item) {destinationDetail.append(fileMessageIdentity(item.target));if (item.reason) destinationDetail.append(element('p','secondary',item.reason));}
    else destinationDetail.append(element('p','secondary',destinations.length ? 'Choose an existing open conversation.' : 'No open conversation is available.'));
  };
  select.addEventListener('change',paint); paint();
  modal.body.append(element('p','file-message-fact',`Saved file: ${sourcePath}`),element('p','secondary','Uses the saved file. Unsaved editor changes are not included. Text files up to 32 KiB. After adding, use Include text in the selected conversation. Nothing is sent.'),label,select,destinationDetail);
  modal.actions(button('Cancel',()=>modal.close()),add); select.focus();
}
/** The placeholder names the recipient and the typed trigger that currently works. */
function messagePlaceholder(name:string,target:Target):string {return `Message ${name}${fileRoot.selection?.root?' · @ files':''}${commandsLive(target)?' · / commands':''}`;}
/** The slash list is offered when the recipient can answer it: a ready Primary, or a live agent whose host lists commands. */
function commandsLive(target:Target):boolean {
  if(target.kind==='primary')return state.primaries.get(target.key)?.lifecycle==='ready';
  const row=agentRow(target.identity);return connected&&row?.availability==='live'&&row.capabilities?.commands===true;
}
/** An agent composer reads its host's commands on the first deliberate slash and keeps them for the connection epoch. */
function agentCommandHooks(controller:ConversationController):{commands?:(deliberate:boolean)=>import('./command-menu-state.ts').CommandInventory} {
  const {target,workspaceId}=controller;if(target.kind!=='agent')return {};
  const inventory=new AgentCommandInventory(signal=>request<import('../shared/api.ts').AgentCommandList>(`/api/agents/${encodeURIComponent(target.identity)}/commands?workspace=${encodeURIComponent(workspaceId)}`,'GET',undefined,undefined,signal),()=>controller.composer.commandsChanged());
  return {commands:deliberate=>inventory.inventory(agentCommandSource(controller),deliberate)};
}
function agentCommandSource(controller:ConversationController):import('./agent-commands.ts').CommandSource {
  const target=controller.target;if(target.kind!=='agent')return {live:false,supported:false,epoch:0};
  const row=agentRow(target.identity);
  return {live:connected&&row?.availability==='live',supported:row?.capabilities?.commands===true,epoch:state.conversations.get(targetIdentity(target))?.connectionEpoch??0};
}
/** The working folder, workspace and a freshness check shared by the folder chooser and typed file suggestions. */
function workingFileContext(controller:ConversationController) {
  const workspace=controller.workspaceId,selection=fileRoot.selection,root=selection?.root;
  const target={...controller.target},layout=JSON.stringify(currentLayout()),revision=paneSelectionRevision;
  const message=controller.elements.root.dataset.messagePanel?messageTarget.current:undefined;
  const current=()=>state.workspace?.id===workspace&&!controller.abort.signal.aborted&&controllers.get(controllerKey(workspace,target))===controller
    &&sameTarget(controller.composer.target,target)&&!!controller.composer.state&&fileRoot.selection===selection&&!fileRoot.loading
    &&paneSelectionRevision===revision&&JSON.stringify(currentLayout())===layout&&(!message||messageTarget.current===message&&messageTarget.valid(message));
  return {workspace,root,target,current};
}
function composerWorkingFile(controller:ConversationController,stage:(files:readonly File[])=>boolean):void {
  const {workspace,root,target,current}=workingFileContext(controller);
  if(!root||!current()) {
    modal.open('Choose working-folder file').append(element('p','secondary',fileRoot.loading?'Loading working folder. Try again after it loads.':fileRoot.error??(!root?'Choose a working folder first.':'Draft is not loaded or its destination changed. Open this conversation first.')));
    modal.actions(button('Close',()=>modal.close()));return;
  }
  const caption=presentationName(presentation(target));
  chooseWorkingFile(modal,root,caption,fileMessageIdentity(target),{current,
    page:(path,cursor,signal)=>request<FileDirectoryPage>(`/api/files/roots/${encodeURIComponent(root.id)}/directory?path=${encodeURIComponent(path)}&workspace=${encodeURIComponent(workspace)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,'GET',undefined,undefined,signal),
    stage:(path,signal,presented)=>stageSavedFile(workspace,root.id,path,signal,()=>current()&&presented(),stage)});
}
/** Typed `@` suggestions search the saved working folder only when it is loaded for this exact conversation. */
function searchWorkingFiles(controller:ConversationController,query:string,signal:AbortSignal):Promise<FileSearchResult>|undefined {
  const {workspace,root,current}=workingFileContext(controller); if(!root||!current())return undefined;
  return request<FileSearchResult>(`/api/files/roots/${encodeURIComponent(root.id)}/search?q=${encodeURIComponent(query)}&workspace=${encodeURIComponent(workspace)}`,'GET',undefined,undefined,signal).then(result=> {
    if(result.rootId!==root.id||!current())throw new Error('The working folder or destination changed. Type the file name again.');return result;
  });
}
function stageMentionedFile(controller:ConversationController,path:string,signal:AbortSignal,present:()=>boolean,stage:(files:readonly File[])=>boolean):Promise<boolean> {
  const {workspace,root,current}=workingFileContext(controller); if(!root||!current())return Promise.resolve(false);
  return stageSavedFile(workspace,root.id,path,signal,()=>current()&&present(),stage);
}
async function stageSavedFile(workspace:string,rootId:string,path:string,signal:AbortSignal,current:()=>boolean,stage:(files:readonly File[])=>boolean):Promise<boolean> {
  const check=()=>{if(fileRoot.selection?.root?.id!==rootId||!current())throw new Error('The file folder or destination changed. Choose Add to message again.');};
  if(signal.aborted)return false;check();
  const saved=await request<FileText>(`/api/files/roots/${encodeURIComponent(rootId)}/text?path=${encodeURIComponent(path)}&workspace=${encodeURIComponent(workspace)}`,'GET',undefined,undefined,signal);
  if(signal.aborted)return false;check();
  if(saved.rootId!==rootId||saved.path!==path)throw new Error('The file folder or destination changed. Choose Add to message again.');
  const name=path.split('/').at(-1)??'';includedText(new TextEncoder().encode(saved.text),name);
  if(!stage([new File([saved.text],name,{type:'text/plain'})]))throw new Error('The file was not staged. Review the selected conversation draft.');
  return true;
}
async function stageFileMessage(workspace:string,rootId:string,path:string,sourcePath:string,destination:FileMessageDestination,token:number,abort:AbortController,add:HTMLButtonElement,select:HTMLSelectElement):Promise<void> {
  if (!modal.owns(token) || add.disabled) return;
  add.disabled = true; select.disabled = true; modal.node.querySelector('#modal-error')?.replaceChildren();
  try {
    if(!await stageSavedFile(workspace,rootId,path,abort.signal,()=>modal.owns(token)&&fileMessageCurrent(workspace,destination),files=>destination.controller?.composer.addFiles(files)??false))return;
    const receipt = `File staged for ${destination.caption}. Use Include text in that conversation. Nothing was sent.`;
    modal.open('Add file to message');
    modal.body.append(element('p','file-message-fact',`Saved file: ${sourcePath}`),fileMessageIdentity(destination.target),element('p','file-message-fact',receipt));
    const close = button('Close',()=>modal.close()); modal.actions(close); close.focus(); announce(receipt);
  } catch(error) {if (modal.owns(token)) modal.error(error,'The file was not added.');}
  finally {if (modal.owns(token)) {add.disabled = false; select.disabled = false;}}
}
function renderFiles():void {
  const workspace = state.workspace;if (!workspace) return;
  fileRoot.observe(workspace.id,primary()?.cwd ?? launchCwd);
  filesTree.setRoot(fileRoot.selection?.root ?? undefined,workspace.id);
  if (!fileRoot.selection?.root) filesTree.unavailable(fileRoot.loading ? 'Loading folder…' : fileRoot.error ?? 'Choose a working folder.');
  const tab = activeTab(currentLayout());filesTree.selectFile(tab?.kind === 'file' ? tab.rootId : undefined,tab?.kind === 'file' ? tab.path : undefined);
}
function remapFileViews(workspace:string,move:FileMove):void {
  filesViews.remap(workspace,move);fileBrowse.remap(move);filesTree.remap(move);
  if (state.workspace?.id === workspace) state = {...state,workspace:selectionQueue.remapFiles(workspace,move) ?? movedWorkspaceFiles(state.workspace,move)};
}
function fileChanges(change:FileChanges,workspaceId?:string):void {
  const workspace = state.workspace;if (!workspace || workspaceId && workspaceId !== workspace.id) return;
  if (change.move) remapFileViews(workspace.id,{rootId:change.rootId,...change.move});
  fileWatch.change(change);filesTree.invalidate(change.rootId,change.directories,change.rescan);
  void filesViews.refresh(workspace.id,change.rootId,change.files,change.rescan);if (change.move) renderAll();
}
async function mutateFile(workspace:string,rootId:string,action:FileTreeAction,path:string,value?:string,current?:()=>boolean):Promise<undefined|(()=>void)> {
  let release:(()=>void)|undefined;fileActionStatus = action === 'trash' ? 'Moving to Trash…' : 'Updating files…';renderWorkbenchStatus();
  try {
    if (action === 'rename' || action === 'move') {await filesViews.drain();await selectionQueue.drain();release = await filesViews.prepareMove(workspace,{rootId,from:path,to:value ?? ''});}
    const result = await requestFileMutation(workspace,rootId,action,path,value);
    if (result.rootId !== rootId) throw new Error('The file action response identity changed.');
    return await applyFileMutation(workspace,result,current);
  } catch(error) {fileActionStatus = `File action not confirmed. ${errorMessage(error)}`;throw error;}
  finally {release?.();renderWorkbenchStatus();void watchFiles();}
}
function requestFileMutation(workspace:string,rootId:string,action:FileTreeAction,path:string,value?:string):Promise<FileMutation> {
  const route = `/api/files/roots/${encodeURIComponent(rootId)}`,query = `workspace=${encodeURIComponent(workspace)}`;
  if (action === 'file' || action === 'directory') return request<FileMutation>(`${route}/entries?${query}`,'POST',{path:[path,value].filter(Boolean).join('/'),kind:action});
  if (action === 'trash') return request<FileMutation>(`${route}/entry?${query}&path=${encodeURIComponent(path)}`,'DELETE');
  const target = action === 'rename' ? [...path.split('/').slice(0,-1),value ?? ''].join('/') : value;return request<FileMutation>(`${route}/move?${query}`,'POST',{from:path,to:target});
}
async function showCreatedFile(workspace:string,result:FileMutation,current?:()=>boolean):Promise<undefined|(()=>void)> {
  if (!current?.()) return;
  const pane = currentLayout().focusedPane;
  chooseFile(result.rootId,result.path,false);await filesViews.owner(workspace,{kind:'file',rootId:result.rootId,path:result.path})?.load();
  return ()=> {
    const layout = currentLayout(),tab = activeTab(layout);
    if (state.workspace?.id !== workspace || layout.focusedPane !== pane || tab?.kind !== 'file' || tab.rootId !== result.rootId || tab.path !== result.path || tab.view === 'preview') return;
    const view = filesViews.view(state.workspace,tab);if (!view.editor || view.editor.hidden || view.editor.readOnly) return;
    stableViews().sync();view.focus();
  };
}
async function applyFileMutation(workspace:string,result:FileMutation,current?:()=>boolean):Promise<undefined|(()=>void)> {
  if (result.operation === 'move' && result.previousPath) remapFileViews(workspace,{rootId:result.rootId,from:result.previousPath,to:result.path});
  if (state.workspace?.id !== workspace) return;
  const parent = result.path.split('/').slice(0,-1).join('/');filesTree.reveal(result.rootId,parent,result.operation === 'create' && result.kind === 'directory' ? result.path : undefined);
  const completed = result.operation === 'create' && result.kind === 'file' ? await showCreatedFile(workspace,result,current) : undefined;
  if (result.operation === 'trash') void filesViews.refresh(workspace,result.rootId,[result.path],true);
  fileActionStatus = '';await reload();return completed;
}
function fileTreeOperation(rootId:string,action:FileTreeAction,path:string,value?:string):Promise<undefined|(()=>void)> {
  const workspace = state.workspace?.id;if (!workspace) return Promise.reject(new Error('No workspace is selected.'));
  if (action === 'trash') {modal.confirm('Move to Trash?',`Move “${path}” to the Trash? Unsaved drafts stay available.`,async()=> {await mutateFile(workspace,rootId,action,path);},'Move to Trash');return Promise.resolve(undefined);}
  const pane = currentLayout().focusedPane,input = document.activeElement;
  return mutateFile(workspace,rootId,action,path,value,()=>state.workspace?.id === workspace && currentLayout().focusedPane === pane && document.activeElement === input);
}
const picker = new ProjectPicker({snapshot: currentSnapshot, primary, modal, agentPresentation:row=>presentation({kind:'agent',identity:row.identity}), selection:change=>{if(change.selectedTarget?.kind==='agent')conversationController(change.selectedTarget).passive=false;return selection(change);}, reload, selectOpened:capturePrimarySelection, selectConverted:captureNativeSelection, project: projectPath, projectsChanged: renderIdentity,titlesChanged:primaryTitlesChanged,workingFolder:path=>fileRoot.choose(path)});
actions.projectPicker = () => picker.open(projectPath());
const recovery = new Recovery({snapshot: currentSnapshot, reload, modal});
const roster = new Roster(row => { void selectAgent(row).catch(showError); }, action => { if (action === 'refresh') refreshRoster(); else moreRoster(); }, {
  load: (cursor, signal) => request<import('../shared/api.ts').CachedRoster>(`/api/agents?limit=20&cursor=${encodeURIComponent(cursor)}`, 'GET', undefined, undefined, signal),
  merge: page => { state = mergeRosterPage(state, page); renderRoster(); },
}, openAgentMessage, row => { const view = presentation({kind: 'agent', identity: row.identity}); return {glyph: presentationGlyph(view), label: view.activity, hideVisibleState: view.hideVisibleState, activity: state.workspace ? controllers.get(controllerKey(state.workspace.id,{kind:'agent',identity:row.identity}))?.transcript.activitySentence() : undefined, tool: view.tool, tone:view.tone, name:view.name, tail:view.identityTail}; });
/** Threads: the sidebar explorer, and one reader placed in the pane that was focused when a thread was opened. It is not part of the saved layout. */
let threadHost: ConversationController | undefined, threadOpener: string | undefined;
/** Known name, then a Pi session title the browser already holds, then the short identity. Never a kind the browser does not know. */
function threadName(identity: string): string {
  const caption = toolSubjectCaption(identity);
  if (caption?.name) return caption.name;
  if (caption && !/^(Unresolved|Unnamed)\b/.test(caption.text)) return caption.text;
  return identityFallback(identity);
}
function identityFallback(identity: string): string { return picker.sessionTitle(identity) ?? `Conversation ${identity.slice(0, 8)}`; }
const threadReader = new ThreadReader({
  page: (threadId, before, signal) => request<ThreadPageView>(`/api/threads/read?threadId=${encodeURIComponent(threadId)}&limit=${THREAD_PAGE_EVENTS}${before === undefined ? '' : `&before=${before}`}`, 'GET', undefined, undefined, AbortSignal.any([signal, AbortSignal.timeout(30_000)])),
  name: threadName,
  openMember: identity => openThreadMember(identity),
  back: () => closeThread(true),
});
const threadExplorer = new ThreadExplorer({
  overview: signal => request<ThreadOverview>('/api/threads', 'GET', undefined, undefined, AbortSignal.any([signal, AbortSignal.timeout(45_000)])),
  name: threadName,
  open: item => openThread(item),
});
/** The reader sits on a conversation: the focused pane's, else the pane that last showed one while focused, else any pane that shows one. */
let lastConversationPane: string | undefined;
function threadHostController(): ConversationController | undefined {
  const workspace = state.workspace; if (!workspace) return undefined;
  const layout = currentLayout(), focused = paneById(layout, layout.focusedPane), last = lastConversationPane ? paneById(layout, lastConversationPane) : undefined;
  for (const pane of [...(focused ? [focused] : []), ...(last ? [last] : []), ...paneLeaves(layout.root)]) {
    const tab = pane.tabs.find(item => tabKey(item) === pane.active), target = tab ? controllerTarget(tab) : undefined;
    const controller = target ? controllers.get(controllerKey(workspace.id, target)) : undefined;
    if (controller) return controller;
  }
  return undefined;
}
function openThread(item: ThreadListItem): void {
  const controller = threadHostController();
  if (!controller) { modal.open('Open a conversation first').append(element('p', undefined, 'A thread opens beside a conversation. Open one, then choose the thread again.')); return; }
  if (threadHost && threadHost !== controller) closeThread(false);
  if (controller.inspection?.active) controller.inspection.conversation();
  threadHost = controller; threadOpener = item.id;
  controller.root.insertBefore(threadReader.node, controllerNode(controller, 'transcript-region'));
  threadExplorer.setCurrent(item.id); renderInspection(controller);
  threadReader.open(item); threadReader.focus();
}
function closeThread(restoreFocus: boolean): void {
  const controller = threadHost, opener = threadOpener;
  threadReader.close(); threadReader.node.remove(); threadHost = undefined; threadOpener = undefined; threadExplorer.setCurrent(undefined);
  if (controller && controllers.has(controllerKey(controller.workspaceId, controller.target))) renderInspection(controller);
  if (!restoreFocus) return;
  if (opener && threadExplorer.focusRow(opener)) return;
  if (controller) controllerNode(controller, 'transcript').focus({preventScroll: true});
}
function openThreadMember(identity: string): void {
  if (!conversationIdentityText(identity)) return;
  const destinations = referenceIdentities(identity);
  const destination: ReferenceDestination = destinations.length === 1 && destinations[0] ? destinations[0] : {target: {kind: 'agent', identity}};
  closeThread(false);
  void navigateReference(destination, true).catch(showError);
}
function syncThreadHost(): void {
  if (threadHost && (threadHost.workspaceId !== state.workspace?.id || controllers.get(controllerKey(threadHost.workspaceId, threadHost.target)) !== threadHost)) closeThread(false);
}
function openAgentMessage(identity: string): void {
  let controller: ConversationController; try {controller = conversationController({kind: 'agent', identity});} catch (error) {showError(error); return;}
  controller.messageRetention = {};
  const preparing = messageTarget.open(identity), captured = messageTarget.current;
  if (captured?.prepared) controller.composer.editor.focus(); else byId('agent-message-close').focus();
  void preparing.then(() => { if (captured && messageTarget.valid(captured) && captured.prepared && document.activeElement === byId('agent-message-close')) controller.composer.editor.focus(); }).catch(showError);
}
function preparationCurrent(connection: EventSource | undefined): boolean {
  return !!connection && connection === source && connected;
}
function requireCurrentPreparation(connection: EventSource | undefined): void {
  if (!preparationCurrent(connection)) throw new Error('The browser connection changed. Check the agent connection again.');
}
async function prepareMessageTarget(workspaceId: string, target: Extract<Target, {kind: 'agent'}>): Promise<import('../shared/api.ts').TargetPreparation> {
  const captured = messageTarget.current, controller = conversationController(target), connection = source;
  controller.passive = false;
  try {
    const prepared = await request<import('../shared/api.ts').TargetPreparation>(`/api/workspaces/${encodeURIComponent(workspaceId)}/targets`, 'POST', {target});
    requireCurrentPreparation(connection);
    if (!sameTarget(prepared.targetState.target, target)) throw new Error('The message recipient changed. Your draft is unchanged.');
    if (captured && messageTarget.valid(captured)) {controller.connection = prepared; controller.connectionError = undefined; renderRoster();}
    return prepared;
  } catch (error) {
    requireCurrentPreparation(connection);
    if (captured && messageTarget.valid(captured)) {controller.connection = undefined; controller.connectionError = errorMessage(error); renderRoster();}
    throw error;
  }
}
const extensionDialogs = new ExtensionDialogs(modal, () => state, next => { state = next; }, primary);
const connectionRecovery = new ConnectionRecovery({attempt: resync, paint: (phase, error) => {
  connectionPhase = phase; connectionError = error; connected = phase === 'healthy'; renderConnection();
  if (connected) {renderAll(); void finishStartup().catch(showError);} else renderAvailability();
}});
export const selectionQueue = new SelectionQueue({current: () => state.workspace, reload, save: (workspace, change, control) => request<Workspace>(`/api/workspaces/${encodeURIComponent(workspace.id)}/selection`, 'PUT', {expectedRevision: workspace.revision, ...change,...(control ? {control} : {})},undefined,control ? AbortSignal.timeout(CONTROL_LIMITS.executionMs) : undefined), paint: (workspace, pending) => { selecting = pending; state = {...state, workspace}; renderAll(); }});

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
      createResizer({handle: byId('sidebar-resizer'), axis: 'x', min: 200, max: 480, defaultValue: 224,
        read: () => state.workspace?.sidebarWidth ?? (innerWidth <= 1100 ? 200 : 224),
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
const sidebarSections = {agents: true,files:false};
function sidebarSectionKey(section: 'agents' | 'files'): string { return `ui:sections:${state.workspace?.id ?? ''}:${section}`; }
export function renderSidebarSections(): void {
  const workspace = state.workspace?.id ?? '';
  if (sidebarSectionWorkspace !== workspace) {
    sidebarSectionWorkspace = workspace;
    for (const section of ['agents','files'] as const) { try {const saved = sessionStorage.getItem(sidebarSectionKey(section));sidebarSections[section] = saved === null ? section === 'agents' : saved !== 'false';} catch {sidebarSections[section] = section === 'agents';} }
  }
  for (const section of ['agents','files'] as const) {
    byId(section === 'agents' ? 'roster-section' : 'files-section').dataset.collapsed = String(sidebarSections[section]);
    byId(`${section}-heading`).setAttribute('aria-expanded', String(!sidebarSections[section]));
    byId(`${section}-section-body`).hidden = sidebarSections[section];
  }
  renderSectionCounts();
}
/** A collapsed heading carries the size of what it hides; an expanded one shows the list itself. */
export function renderSectionCounts(): void {
  const files = filesTree.rootCount(), agents = state.rosterOrder.length;
  const labels = {files: files ? `${files.count}${files.more ? '+' : ''}` : '', agents: agents ? `${agents}${state.rosterMeta?.nextCursor ? '+' : ''}` : ''};
  for (const section of ['files', 'agents'] as const) {
    const count = byId(`${section}-count`); setText(count, labels[section]); count.hidden = !sidebarSections[section] || !labels[section];
  }
}
export function setSidebarSection(section: 'agents' | 'files', collapsed: boolean): void {
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
/** A connection kept across a browser disconnect is evidence of the old stream and is ignored until it is prepared again. */
function liveConnection(controller?: ConversationController): NonNullable<ConversationController['connection']> | undefined {
  return controller?.connection?.stale ? undefined : controller?.connection;
}
function agentNegotiation(target: Target | undefined, controller?: ConversationController) {
  const live = liveConnection(controller);
  return target?.kind === 'agent' && live ? {identity: target.identity, ...live} : undefined;
}
function agentRow(identity: string): AgentRow | undefined {
  const row = state.roster.get(identity), controller = state.workspace ? controllers.get(controllerKey(state.workspace.id, {kind: 'agent', identity})) : undefined;
  if (row && controller?.connectionError) return {...row, availability: 'unavailable'};
  const negotiated = liveConnection(controller);
  if (row && negotiated) return {...row, availability: negotiated.availability, capabilities: negotiated.capabilities};
  const availability = state.agentAvailability.get(identity);
  return row && availability ? {...row, availability: availability.state, capabilities: availability.capabilities} : row;
}
const conversationCaptions = new ConversationCaptions();
let namesRoster: typeof state.roster | undefined, namesConversations: typeof state.conversations | undefined, namesWorkspace: typeof state.workspace;
function presentationCaptions(): ConversationCaptions {
  if (namesRoster === state.roster && namesConversations === state.conversations && namesWorkspace === state.workspace) return conversationCaptions;
  namesRoster = state.roster; namesConversations = state.conversations; namesWorkspace = state.workspace;
  const names = new Map<string, CaptionRow>([...state.roster.values()].map(row => [row.identity, row]));
  for (const pane of paneLeaves(currentLayout().root)) for (const tab of pane.tabs) if (tab.kind === 'agent' && !names.has(tab.identity)) names.set(tab.identity, {identity: tab.identity});
  for (const conversation of state.conversations.values()) if (conversation.target.kind === 'agent') {const identity = conversation.target.identity; names.set(identity, {...state.roster.get(identity), identity, reported: conversation.frame?.status.name});}
  conversationCaptions.update([...names.values()]); return conversationCaptions;
}
let captionPaintRevision = -1, captionReferenceRoster: typeof state.roster | undefined, captionReferencePrimaries: typeof state.primaries | undefined;
let captionReferenceKey = '', paintedCaptionReferenceKey = '';
function captionReferences(): string {
  if (captionReferenceRoster !== state.roster || captionReferencePrimaries !== state.primaries) {
    captionReferenceRoster = state.roster; captionReferencePrimaries = state.primaries;
    captionReferenceKey = JSON.stringify([[...state.roster.keys()].sort(), [...state.primaries.values()].map(value => [value.key, value.epoch, value.sessionId, presentationName(presentation({kind:'primary',key:value.key,epoch:value.epoch}))]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
  }
  return captionReferenceKey;
}
function primaryTitlesChanged(): void { captionReferencePrimaries = undefined; refreshCaptionConsumers(); primaryNavigation(primary()); }
function refreshCaptionConsumers(): void {
  const captions = presentationCaptions(), references = captionReferences();
  if (captionPaintRevision === captions.revision && paintedCaptionReferenceKey === references) return;
  captionPaintRevision = captions.revision; paintedCaptionReferenceKey = references;
  for (const controller of controllers.values()) {
    if (controller.workspaceId !== state.workspace?.id) continue;
    controller.transcript.refreshSubjects();
    const view = presentation(controller.target);
    renderComposerSettings(controller, view);
  controller.composer.recipient((view.input ? 'Message ' : 'Draft for ') + presentationName(view), controllerGuidance(controller, view), messagePlaceholder(presentationName(view), controller.target));
  }
  const captured = messageTarget.current;
  if (captured && messageTarget.valid(captured)) {
    const name = presentationName(presentation({kind: 'agent', identity: captured.identity})), ready = messageTarget.ready;
    setText(byId('agent-message-name'), name);
    const controller = controllers.get(controllerKey(captured.workspaceId, {kind: 'agent', identity: captured.identity}));
    controller?.composer.recipient((ready ? 'Message ' : 'Draft for ') + name, ready || !captured.prepared || captured.invalidated ? '' : 'This agent is not ready for messages.', messagePlaceholder(name, {kind: 'agent', identity: captured.identity}));
  }
  tabStrip.render(); roster.schedule(); renderIdentity(); threadExplorer.refreshNames(); threadReader.refreshNames();
}
function targetCaption(target?: Target) {return target?.kind === 'agent' ? presentationCaptions().get(target.identity) : undefined;}
function startAttempt(target?: Target): {pending: boolean; reason?: string} | undefined {
  return target?.kind === 'agent' && state.workspace ? agentStarts.get(agentStartKey(state.workspace.id, target.identity)) : undefined;
}
function presentation(target?: Target): ConversationPresentation {
  const row = target?.kind === 'agent' ? agentRow(target.identity) : undefined;
  const controller = target && state.workspace ? controllers.get(controllerKey(state.workspace.id, target)) : undefined;
  const conversation = target ? state.conversations.get(targetIdentity(target)) : undefined;
  const tool = target?.kind === 'primary' ? [...conversation?.tools.values() ?? []].findLast(item => item.phase !== 'end') : undefined;
  const item = target?.kind === 'primary' ? state.primaries.get(target.key) : undefined;
  return conversationPresentation({target, primary: item, savedSession: picker.savedSession(item),
    row, caption: targetCaption(target), availability: target?.kind === 'agent' && !liveConnection(controller) && !controller?.connectionError ? state.agentAvailability.get(target.identity) : undefined,
    negotiated: agentNegotiation(target, controller),
    entries: conversation ? conversationBlocks(conversation) : undefined,
    start: startAttempt(target),
    frame: target ? state.conversations.get(targetIdentity(target))?.frame : undefined, tool: tool ? {name: tool.name, argument: tool.argumentText ?? ''} : undefined, connected});
}
function tabPresentation(tab: ConversationTab): ConversationPresentation { return presentation(controllerTarget(tab)); }
function activePresentation(): ConversationPresentation { return presentation(layoutTarget(currentLayout(), primaryTarget()) ?? undefined); }
function projectPath(): string | undefined { return fileRoot.selection?.root?.path ?? primary()?.cwd ?? launchCwd; }
function renderControlAttribution():void {
  if(controlStatusWorkspace !== state.workspace?.id)controlStatus = '';
  setText(controlAttribution,controlStatus);controlAttribution.hidden = !controlStatus;
}
function fileStatusNotice():string {return fileActionStatus || fileWatch.status;}
function updateConversationStatus(target: Target | undefined, view: ConversationPresentation, notice: string): void {
  const controller = target && state.workspace ? controllers.get(controllerKey(state.workspace.id, target)) : undefined;
  const action = view.busy && view.activity === 'Working' ? controller?.transcript.activitySentence() : undefined;
  workbenchStatus.update(target?.kind ?? 'primary', presentationName(view), notice || view.activity, target?.kind === 'agent' ? target.identity : target?.key, notice ? undefined : action);
  const activity = byId('workbench-activity'); if (!notice && view.detail) activity.title += `\n${view.detail}`;
  if (notice && notice === fileWatch.status && fileWatch.detail) activity.title += `\n${fileWatch.detail}`;
  activity.dataset.busy = String(!notice && view.busy); activity.dataset.tone = view.tone;
  activity.setAttribute('role', 'status');
}
function renderWorkbenchStatus(): void {
  renderControlAttribution();
  const notice = fileStatusNotice();
  byId('workbench-activity').dataset.notice = String(!!notice);
  const retained = byId<HTMLButtonElement>('file-retained-drafts');retained.hidden = !filesViews.retained().length;setText(retained,'Review retained draft');retained.onclick = reviewRetainedDrafts;
  const tab = activeTab(currentLayout());
  const editingMessage = footerController && messageTarget.current?.identity === (footerController.target.kind === 'agent' ? footerController.target.identity : undefined) && footerController.elements.root.contains(document.activeElement);
  if (tab?.kind === 'file' && !editingMessage) {renderFileWorkbenchStatus(tab);return;}
  const selected = layoutTarget(currentLayout(), primaryTarget()) ?? undefined;
  const target = editingMessage ? footerController?.target : selected;
  const controller = target ? conversationController(target) : undefined; footerController = controller;
  const skip = byId<HTMLAnchorElement>('skip-composer'); skip.href = controller ? `#${controller.composer.editor.id}` : '#session-new';
  const view = presentation(target); updateConversationStatus(target, view, notice);
  const slot = byId('focused-composer-status'), nodes = controller ? [controller.elements.save, controller.elements.receiptDetails] : [];
  if (slot.children.length !== nodes.length || nodes.some((node, index) => slot.children[index] !== node)) slot.replaceChildren(...nodes);
  if (target?.kind === 'agent') renderAgentSettings(view, target);
}
function reviewRetainedDrafts():void {
  const owners = filesViews.retained();if (!owners.length) return;
  const body = modal.open('Retained draft');let first:HTMLTextAreaElement|undefined;
  for (const owner of owners) {
    const section = element('section'),text = element('textarea');text.readOnly = true;text.value = owner.text ?? '';text.setAttribute('aria-label',`Retained draft: ${owner.tab.path}`);first ??= text;
    section.append(element('p',undefined,`${owner.tab.path} (${owner.tab.rootId}, ${owner.workspace}). Copy this text before you discard it. This retained text does not write to disk.`),text,
      button('Discard retained draft',()=>modal.confirm('Discard retained draft?',`Discard retained text for “${owner.tab.path}”? This cannot be undone.`,async()=> {filesViews.discardRetained(owner);},'Discard retained draft'),'danger'));
    body.append(section);
  }
  modal.actions(button('Close',()=>modal.close()));first?.focus();first?.setSelectionRange(0,first.value.length);
}
function renderFileWorkbenchStatus(tab:FileTab):void {
  footerController = undefined;byId('workbench-activity').dataset.busy = 'false';const owner = state.workspace && filesViews.owner(state.workspace.id,tab);workbenchStatus.update('file',tab.path,fileActionStatus || owner?.status || fileWatch.status,tab.path);
  if (fileWatch.detail && !fileActionStatus && !owner?.status) {const activity = byId('workbench-activity');activity.title = `${activity.title}\n${fileWatch.detail}`;}
  const slot = byId('focused-composer-status');slot.replaceChildren();
  if (owner?.conflict) {const controls = element('span','file-status-actions');controls.append(button('Re-read file',()=> {void owner.reread();}),button('Keep editing',()=>focusEditor()));slot.append(controls);}
  byId<HTMLAnchorElement>('skip-composer').href = '#files-tree';
}
function renderIdentity(): void {
  renderWorkbenchStatus();
  const view = activePresentation(); const project = projectIdentity({cwd:projectPath()}, launchCwd, picker.projectPaths());
  for (const prefix of ['', 'compact-']) {
    const name = byId(`${prefix}project-name`), control = byId(`${prefix}project-button`);
    setText(name, project.name); name.title = project.path ?? 'No working folder selected';
    control.title = project.path ? `Working folder: ${project.path}` : 'Choose working folder';
    control.setAttribute('aria-label', 'Choose working folder');
    control.setAttribute('aria-description', project.path ?? 'No working folder selected');
  }
  document.title = view.activity ? `Pi · ${presentationName(view)} · ${view.activity}` : `Pi · ${project.name}`;
  for (const controller of controllers.values()) renderObserved(controller, connected || !presentation(controller.target).activity);
}
function renderObserved(controller:ConversationController, hide:boolean):void {
  controllerNode(controller,'observed').hidden=!state.conversations.get(targetIdentity(controller.target))?.retainedSession&&hide;
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
  const old = currentLayout();if (paneLeaves(old.root).length !== paneLeaves(layout.root).length) fileBrowse.hold();
  const workspace = state.workspace?.id, remaining = new Set(paneLeaves(layout.root).flatMap(pane => pane.tabs.map(tabKey)));
  // A close acknowledgment must not release a newer Message intent or a reopened tab.
  const closed = paneLeaves(old.root).flatMap(pane => pane.tabs).flatMap(tab => {
    const key = tabKey(tab), target = controllerTarget(tab), controller = workspace && target ? controllers.get(controllerKey(workspace, target)) : undefined;
    return controller?.messageRetention && !remaining.has(key) ? [{key, controller, retention: controller.messageRetention}] : [];
  });
  for (const pane of paneLeaves(old.root)) for (const tab of pane.tabs) if (tab.kind === 'file' && !paneById(layout,pane.id)?.tabs.some(current=>tabKey(current) === tabKey(tab))) fileBrowse.keep(tabKey(tab));
  devInteractionRevision++; drawerOpen = false; tabStrip.requestReveal();
  const target = layoutTarget(layout, primaryTarget());
  void selection({conversationLayout: layout,...(activeTab(layout)?.kind === 'file' ? {} : {selectedTarget:target,panelVisible:target?.kind === 'agent'}),...(state.workspace ? {filePositions:Object.fromEntries(Object.entries(filesViews.positions(state.workspace)).filter(([key])=>paneLeaves(layout.root).some(pane=>pane.tabs.some(tab=>tabKey(tab) === key))))} : {})}).then(() => {
    if (!closed.length || state.workspace?.id !== workspace) return;
    const open = new Set(paneLeaves(currentLayout().root).flatMap(pane => pane.tabs.map(tabKey)));
    for (const {key, controller, retention} of closed) if (!open.has(key) && controller.messageRetention === retention) delete controller.messageRetention;
    collectControllers(); renderRoster();
  }).catch(showError);
}
function activateConversationTab(pane: string, key: string): void {
  const layout = activatePaneTab(currentLayout(), pane, key); if (paneById(layout, pane)?.active !== key) return;
  const target = layoutTarget(layout, primaryTarget()); if (target&&!conversationController(target).inspection?.active) conversationController(target).passive = false;
  applyLayout(layout); focusEditor();
}
function moveRetained(node: HTMLElement, parent: HTMLElement): void {
  if (node.parentElement === parent) return;
  const focused = document.activeElement instanceof HTMLElement && node.contains(document.activeElement) ? document.activeElement : undefined;
  const selection = document.getSelection(); const ranges: Range[] = [];
  if (selection && node.contains(selection.anchorNode) && node.contains(selection.focusNode)) for (let index = 0; index < selection.rangeCount; index++) ranges.push(selection.getRangeAt(index).cloneRange());
  const top = node.scrollTop; placeRetained(node, parent); node.scrollTop = top;
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
    byId('conversation-panes').append(root); split = {node: root, handle}; paneSplits.set(node.id, split);
  }
  split.node.dataset.axis = node.axis; split.handle.dataset.axis = node.axis; split.handle.setAttribute('aria-orientation', node.axis === 'x' ? 'vertical' : 'horizontal');
  const first = mountPaneNode(node.first, layout, visited), second = mountPaneNode(node.second, layout, visited); first.dataset.slot = 'first'; second.dataset.slot = 'second';
  if (split.node.firstChild !== first) placeRetained(first, split.node, split.node.firstChild);
  if (first.nextSibling !== split.handle) placeRetained(split.handle, split.node, first.nextSibling);
  if (split.handle.nextSibling !== second) placeRetained(second, split.node, split.handle.nextSibling);
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
    const actions = cardAction('more', 'Conversation actions', () => openConversationActions(leaf.id, undefined, actions), 'icon-button pane-actions pane-conversation-actions'); actions.setAttribute('aria-haspopup', 'menu'); actions.setAttribute('aria-expanded', 'false');
    bar.append(previous, next, tabs, plus, menu, actions); node.append(bar, content); byId('conversation-panes').append(node); pane = {node, tabs, content, plus, menu, actions, previous, next}; paneRegions.set(leaf.id, pane);
    node.addEventListener('contextmenu', event => {
      if (event.defaultPrevented || !(event.target instanceof HTMLElement) || nativeEditingTarget(event.target) || event.target.closest('.transcript,.file-reading')) return;
      event.preventDefault(); openPaneMenu(leaf.id, event, event.target.closest<HTMLElement>('.conversation-tab')?.dataset.tabKey);
    });
    content.addEventListener('pointerdown', event => updatePaneFocus(leaf.id, event));
    content.addEventListener('focusin', () => updatePaneFocus(leaf.id));
  }
  const activeIndex = leaf.tabs.findIndex(tab => tabKey(tab) === leaf.active);
  // Step arrows exist only for a direction that has a tab to reach.
  // An unreachable direction keeps its space so the tab row does not shift under the pointer; a single tab needs neither arrow.
  pane.previous.disabled = activeIndex <= 0; pane.next.disabled = activeIndex < 0 || activeIndex >= leaf.tabs.length - 1;
  pane.previous.dataset.unreachable = String(pane.previous.disabled); pane.next.dataset.unreachable = String(pane.next.disabled);
  pane.previous.hidden = pane.next.hidden = leaf.tabs.length <= 1;
  pane.plus.disabled = !state.workspace; pane.menu.disabled = !leaf.tabs.length;
  const activeTab = leaf.tabs[activeIndex]; pane.actions.hidden = !activeTab || activeTab.kind === 'file'; pane.actions.disabled = pane.actions.hidden || !state.workspace;
  pane.node.dataset.focused = String(leaf.id === layout.focusedPane);
  return pane.node;
}
function placePaneContent(leaf:PaneLeaf):void {
  const pane = paneRegions.get(leaf.id);if(!pane)throw new Error(`Missing pane region for ${leaf.id}.`);
  const tab = leaf.tabs.find(tab => tabKey(tab) === leaf.active), target = tab ? controllerTarget(tab) : undefined;
  if (tab?.kind === 'file' && state.workspace) {const view = filesViews.view(state.workspace,tab);view.root.dataset.paneId = leaf.id;stableViews().place(view.root,pane.content);}
  else if (target) { const owner = conversationController(target); stableViews().place(owner.root, pane.content); owner.root.dataset.paneId = leaf.id; delete owner.root.dataset.messageOnly;
    if (messageTarget.current?.identity !== (target.kind === 'agent' ? target.identity : undefined)) stableViews().project(owner.elements.root);
  }
}
let renderedPaneLayout = '';
function renderPaneTree(layout: ConversationLayout): void {
  const signature = JSON.stringify([state.workspace?.id, layout.root]); const changed = renderedPaneLayout !== signature; renderedPaneLayout = signature;
  focusedPane = layout.focusedPane; const container = byId('conversation-panes'); container.classList.add('pane-tree');
  const navigation = byId('navigation-access');
  if ([...paneRegions].some(([id, pane]) => !paneById(layout, id) && pane.node.contains(navigation))) moveRetained(navigation, byId('workspace'));
  retainPaneGeometry();
  if (state.workspace) filesViews.reconcile(state.workspace,paneLeaves(layout.root).flatMap(pane=>pane.tabs).filter((tab):tab is FileTab=>tab.kind === 'file'),paneLeaves(layout.root).flatMap(pane=>pane.tabs.filter(tab=>tabKey(tab) === pane.active)).filter((tab):tab is FileTab=>tab.kind === 'file'));
  const visited = new Set<string>(); const root = mountPaneNode(layout.root, layout, visited); if (container.firstChild !== root) placeRetained(root, container, container.firstChild);
  for(const leaf of paneLeaves(layout.root))placePaneContent(leaf);
  hideInactiveControllers(layout);
  for (const [id, pane] of paneRegions) if (!visited.has(id)) {pane.node.remove(); paneRegions.delete(id);}
  for (const [id, split] of paneSplits) if (!visited.has(id)) {split.resizer?.destroy(); split.node.remove(); paneSplits.delete(id);}
  for (const controller of controllers.values()) if (controller.root.hidden && !controller.historyAbort.signal.aborted) controller.historyAbort.abort();
  refreshTreeGeometry();
  if (changed) restorePaneGeometry();
  markFocusedPane(); collectControllers();void watchFiles();
}
function hideInactiveControllers(layout:ConversationLayout):void {
  const shown = new Set(paneLeaves(layout.root).flatMap(pane=>pane.tabs.filter(tab=>tabKey(tab) === pane.active)).flatMap(tab=> {const target = controllerTarget(tab);return target && state.workspace ? [controllerKey(state.workspace.id,target)] : [];}));
  for (const [key,controller] of controllers) if (!shown.has(key))hideController(controller);
}
function hideController(controller:ConversationController):void {
  const projected = controller.workspaceId === state.workspace?.id && messageTarget.current?.identity === (controller.target.kind === 'agent' ? controller.target.identity : undefined) && !!controller.elements.root.dataset.messagePanel;
  stableViews().place(controller.root,projected ? byId('agent-message-panel') : undefined);delete controller.root.dataset.paneId;
  if(projected)controller.root.dataset.messageOnly = 'true';
  else {delete controller.root.dataset.messageOnly;stableViews().project(controller.elements.root);}
}
function retainPaneGeometry(): void {
  for (const controller of controllers.values()) {
    const pane = viewPane(controller.root);
    if (!controller.root.hidden && !controller.root.inert && !pane?.hidden && !pane?.inert) controller.geometry = controller.transcript.captureGeometry();
  }
}
function restorePaneGeometry(): void {
  for (const controller of controllers.values()) if (controller.geometry) controller.transcript.applyGeometry(controller.geometry);
}
function refreshTreeGeometry(): void {
  const layout = currentLayout(), root = byId('conversation-panes'), box = root.getBoundingClientRect(), minimum = minimumPaneSize(layout.root);
  const focusOnly = matchMedia('(max-width: 599px)').matches || box.width < minimum.width || box.height < minimum.height; root.dataset.focusOnly = String(focusOnly);
  for (const [id, pane] of paneRegions) {pane.node.hidden = focusOnly && id !== layout.focusedPane; pane.node.inert = pane.node.hidden;}
  if (!focusOnly) refreshPaneSplit(layout.root);
  for (const controller of controllers.values()) if (controller.elements.root.dataset.messagePanel) placeMessageRoot(controller, byId('agent-message-panel'));
  stableViews().sync();filesViews.attached();
  for (const controller of controllers.values()) {controller.transcript.visibilityChanged();renderInspection(controller);}
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
  if (change.primaryKey !== undefined || change.selectedTarget !== undefined || change.conversationLayout !== undefined) paneSelectionRevision++;
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
export const browserControl = new BrowserControl({
  page:()=>state.workspace && state.bootId ? {bootId:state.bootId,workspaceId:state.workspace.id,pageId:fileWatch.clientId,connectionId,revision:state.workspace.revision,enabled:state.workspace.agentControl !== false,connected:connected && !document.hidden} : undefined,
  busy:controlBusy,
  apply:applyControl,
  ack:ack=>request(CONTROL_ROUTES.ack,'POST',ack,undefined,AbortSignal.timeout(CONTROL_LIMITS.executionMs)),
});
function controlBusy():string|undefined {
  if(document.hidden || !connected || resynchronizing || devNavigating || devRestoreOwner)return 'page_busy';
  if(selectionQueue.unsettled || preferences.pending || messageTarget.current?.preparing)return 'selection_busy';
  if(modal.openNow || contextMenu.openNow)return 'modal';
  if(composingFields.size || [...controllers.values()].some(controller=>!!controller.composer.reloadHold))return 'input_busy';
  if(document.documentElement.classList.contains('resizing'))return 'resize';
  if(document.getSelection()?.isCollapsed === false)return 'selection';
  return undefined;
}
function controlTarget(command:ControlRequest):void {
  const view = command.intent.action === 'split' || command.intent.action === 'focus' ? command.intent.view : undefined;
  if(view?.kind === 'agent' && !state.roster.has(view.identity))throw new ControlRefusal('agent_missing');
  if(view?.kind === 'primary' && (!command.primary || !sameTarget(command.primary,primaryTarget())))throw new ControlRefusal('primary_changed');
}
function controlNativeOwner(native:HTMLElement,next:ConversationLayout):void {
  const root = native.closest<HTMLElement>('.conversation,.file-view');if(!root)return;
  const slot = stableViews().slot(root),id = slot?.closest<HTMLElement>('.pane-leaf')?.dataset.paneId;
  if(!id) {if(!byId('agent-message-panel').contains(slot ?? null))throw new ControlRefusal('native_owner_hidden');return;}
  const old = paneById(currentLayout(),id),proposed = paneById(next,id);
  if(!old || !proposed || old.active !== proposed.active)throw new ControlRefusal('native_owner_hidden');
  controlPaneGeometry(id,next,'native_owner_geometry');
}
function controlPaneGeometry(id:string,next:ConversationLayout,code:string):void {
  const box = byId('conversation-panes').getBoundingClientRect(),space = {width:box.width,height:box.height,divider:4};
  const before = controlPaneBox(currentLayout().root,id,space),after = controlPaneBox(next.root,id,space);
  if(!before || !after || JSON.stringify(before) !== JSON.stringify(after))throw new ControlRefusal(code);
}
function controlReadingGeometry(next:ConversationLayout):void {
  for(const controller of controllers.values()) {
    if(controller.workspaceId !== state.workspace?.id || controller.root.hidden || controller.root.inert)continue;
    const pane = controller.root.dataset.paneId;if(!pane)continue;
    const reading = controller.transcript.captureGeometry();
    // Reflow can shorten the anchored entry and clamp its offset before a receipt.
    if(!reading.followTail && reading.anchor)controlPaneGeometry(pane,next,'reading_owner_geometry');
  }
}
function nativeSignature(native:HTMLTextAreaElement):string {return JSON.stringify([native.value,native.selectionStart,native.selectionEnd,native.selectionDirection,native.scrollTop,native.scrollLeft]);}
function captureControlNative(next:ConversationLayout):()=>void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const native = active && nativeEditingTarget(active) ? active as HTMLTextAreaElement : undefined;
  if(native)controlNativeOwner(native,next);
  const signature = native && nativeSignature(native),parent = native?.parentElement;
  return ()=> {
    if(active && document.activeElement !== active)throw new Error('The native focus changed before its receipt.');
    if(native && (!native.isConnected || native.parentElement !== parent || native.closest('[hidden],[inert]') || nativeSignature(native) !== signature))throw new Error('The native input changed before its receipt.');
  };
}
function controlPaneSpace(id:string):{width:number;height:number;divider:number} {const box = paneRegions.get(id)?.node.getBoundingClientRect();return {width:box?.width ?? 0,height:box?.height ?? 0,divider:4};}
function controlSelection(next:ConversationLayout):SelectionChange {
  const target = layoutTarget(next,primaryTarget());
  return {conversationLayout:next,...(activeTab(next)?.kind === 'file' ? {} : {selectedTarget:target,panelVisible:target?.kind === 'agent'})};
}
async function controlFiles(command:ControlRequest,workspace:Workspace):Promise<void> {
  const intent = command.intent,view:ConversationTab|undefined = intent.action === 'show' ? {kind:'file',rootId:intent.rootId,path:intent.path,...(intent.preview ? {view:'preview'} : {})} : intent.action === 'split' || intent.action === 'focus' ? intent.view : undefined;
  if(view?.kind !== 'file')return;
  const owner = filesViews.view(workspace,view).owner;await owner.load();
  if(owner.text === undefined || owner.loading || owner.error)throw new Error('The presented file is not ready.');
}
function controlFrame():Promise<void> {return new Promise<void>((resolve,reject)=> {const timer = window.setTimeout(()=>reject(new Error('The presentation frame did not render.')),250);requestAnimationFrame(()=> {window.clearTimeout(timer);resolve();});});}
function verifyControlPane(pane:PaneLeaf,workspace:Workspace):void {
  const region = paneRegions.get(pane.id);if(!region || region.node.hidden || region.node.inert)throw new Error('The pane is not rendered.');
  const tab = pane.tabs.find(tab=>tabKey(tab) === pane.active),target = tab && controllerTarget(tab);
  const root = tab?.kind === 'file' ? filesViews.view(workspace,tab).root : target ? controllers.get(controllerKey(workspace.id,target))?.root : undefined;
  if(root && (!root.isConnected || root.hidden || root.inert || stableViews().slot(root) !== region.content))throw new Error('The native view is not placed.');
}
async function applyControl(command:ControlRequest):Promise<number> {
  const workspace = state.workspace;if(!workspace)throw new ControlRefusal('workspace_missing');
  const busy = controlBusy();if(busy)throw new ControlRefusal(busy);
  if(command.intent.action === 'notice')return workspace.revision;
  controlTarget(command);const box = byId('conversation-panes').getBoundingClientRect();
  const next = controlLayout(currentLayout(),command.intent,{width:box.width,height:box.height,divider:4},controlPaneSpace),verifyNative = captureControlNative(next);
  controlReadingGeometry(next);
  let revision = workspace.revision;
  if(!samePaneLayout(currentLayout(),next))revision = (await selectionQueue.selectControl(controlSelection(next),controlProvenance(command))).revision;
  await controlFiles(command,workspace);await controlFrame();stableViews().sync();
  if(state.workspace?.id !== workspace.id || !samePaneLayout(currentLayout(),next))throw new Error('The presentation changed before its receipt.');
  for(const pane of paneLeaves(next.root))verifyControlPane(pane,state.workspace);
  verifyNative();return revision;
}
function captureNativeSelection():(identity:string)=>Promise<void> {
  const workspace=state.workspace?.id,layout=JSON.stringify(state.workspace?.conversationLayout),chosen=paneSelectionRevision;
  const previousKey=state.workspace?.primaryKey,previousTarget=JSON.stringify(state.workspace?.selectedTarget),token=modal.token,dialog=modal.openNow;
  return async identity=> {
    if(state.workspace?.id!==workspace||paneSelectionRevision!==chosen||JSON.stringify(state.workspace?.conversationLayout)!==layout||state.workspace?.primaryKey!==previousKey||JSON.stringify(state.workspace?.selectedTarget)!==previousTarget||(dialog?!modal.owns(token):modal.openNow))return;
    const target={kind:'agent' as const,identity};conversationController(target).passive=false;
    await selection({panelVisible:true,selectedTarget:target});
  };
}
export function capturePrimarySelection():(key:string)=>Promise<void> {
  const workspace = state.workspace?.id,layout = JSON.stringify(state.workspace?.conversationLayout),chosen = paneSelectionRevision;
  const previousKey = state.workspace?.primaryKey,previousTarget = JSON.stringify(state.workspace?.selectedTarget);
  const revision = selectionIntentRevision,token = modal.token,dialog = modal.openNow;
  const current = (target:Extract<Target,{kind:'primary'}>)=>state.workspace?.id === workspace && paneSelectionRevision === chosen && JSON.stringify(state.workspace?.conversationLayout) === layout &&
    (state.workspace?.primaryKey === previousKey || state.workspace?.primaryKey === target.key) &&
    (JSON.stringify(state.workspace?.selectedTarget) === previousTarget || sameTarget(state.workspace?.selectedTarget,target)) && (dialog ? modal.owns(token) : !modal.openNow);
  return async key=> {
    const item = state.primaries.get(key);if (!item) return;
    const target = {kind:'primary' as const,key,epoch:item.epoch};if (!current(target)) return;
    const applied = selection({primaryKey:key,selectedTarget:target}),selectedLayout = JSON.stringify(currentLayout()),selected = paneSelectionRevision;
    await applied;
    if (state.workspace?.id !== workspace || paneSelectionRevision !== selected || selectionIntentRevision !== revision || JSON.stringify(currentLayout()) !== selectedLayout || !sameTarget(primaryTarget(),target) || activeTab(currentLayout())?.kind !== 'primary' || (dialog ? !modal.owns(token) : modal.openNow)) return;
    focusPrimaryKey = key;focusPrimaryCurrent = ()=>state.workspace?.id === workspace && paneSelectionRevision === selected && selectionIntentRevision === revision && JSON.stringify(currentLayout()) === selectedLayout && sameTarget(primaryTarget(),target) && modal.token === token;
    focusSelectedPrimary();
  };
}
let focusPrimaryKey: string | undefined;
let focusPrimaryCurrent:(()=>boolean)|undefined;
export async function reloadSelection(): Promise<void> {
  await reload(); focusPrimaryKey = state.workspace?.primaryKey;focusPrimaryCurrent = undefined;
  focusSelectedPrimary();
}
function focusSelectedPrimary(): void {
  if (selectedAgent() || focusPrimaryCurrent && !focusPrimaryCurrent()) { focusPrimaryKey = undefined;focusPrimaryCurrent = undefined; return; }
  if (!focusPrimaryKey || focusPrimaryKey !== primary()?.key || primary()?.lifecycle !== 'ready' || primaryComposer().editor.disabled) return;
  focusPrimaryKey = undefined;focusPrimaryCurrent = undefined;stableViews().sync();modal.restoreFocus(primaryComposer().editor);
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
    const pending = read<Snapshot>(`/api/snapshot?workspace=${encodeURIComponent(state.workspace.id)}`).then(value => hydrateVisible(value, read, explicit?.workspaceId === value.workspace.id ? {kind: 'agent', identity: explicit.identity} : undefined));
    const current = await (signal ? waitForSignal(pending, signal) : pending); signal?.throwIfAborted();
    if (buffered.overflow) throw new Error('Current view changed too quickly during restore. Reconnect to request a fresh baseline.');
    updateDiagnostics(); snapshot = current; state = replaceSnapshot({...before, dismissedNotices: state.dismissedNotices, readNotices: state.readNotices}, current, buffered.events); if (state.workspace) state = {...state, workspace: selectionQueue.observe(state.workspace)};
    if(before.bootId!==current.bootId) for(const controller of controllers.values()) if(state.conversations.get(targetIdentity(controller.target))?.retainedSession) {controller.cursor=null;controller.historyBoundaryLoaded=false;controller.transcript.historyAvailable(false);}
    renderAll();
  } finally { snapshotBuffers.delete(buffered); }
}
function stream(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  source?.close(); connectionId = undefined;
  if (!state.workspace || !state.cursor) return Promise.reject(new Error('No current workspace baseline.'));
  const ready = {resolve: () => {}, reject: (_error: unknown) => {}};
  const promise = new Promise<void>((resolve, reject) => { ready.resolve = resolve; ready.reject = reject; }); streamWait = ready;
  const current = connect(state.workspace.id, state.cursor, event => { if (source === current) receive(event); }, () => { if (source === current) disconnected(); },fileWatch.clientId);
  source = current;
  const timer = window.setTimeout(() => { if (source === current) disconnected(new Error('The event stream did not become ready.')); }, 15_000);
  return (signal ? waitForSignal(promise, signal) : promise).finally(() => { window.clearTimeout(timer); if (streamWait === ready) streamWait = undefined; });
}
function disconnected(error: unknown = new Error('The event stream closed.')): void {
  source?.close(); connectionId = undefined; connected = false; renderAvailability(); devRestoreWake?.();
  if (streamWait) streamWait.reject(error);
  else connectionRecovery.lost(error);
}
function connectionDetails(): void {
  const body = modal.open('Connection details');
  if (connectionError) body.append(element('p', 'error', errorMessage(connectionError)));
}
export function renderConnection(): void {
  const {visible} = connectionSurfaceFor(connectionPhase);
  const key = `${connectionPhase}`; if (connectionSurface === key) return; connectionSurface = key;
  const node = byId('connection'); node.hidden = !visible; node.replaceChildren();
  if (!visible) return;
  if (connectionPhase === 'offline') node.append(element('span', undefined, 'Disconnected. Your draft is still in this tab.'), button('Reconnect', () => connectionRecovery.reconnect()), button('Details', connectionDetails));
  else setText(node, 'Connection lost. Reconnecting…');
}
async function resync(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (resynchronizing) return resynchronizing;
  source?.close(); connected = false; renderAvailability(); devRestoreWake?.();
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
  try {
    const old = state;
    const reduced = {id: event.id, name: event.name, target: event.envelope.target, workspaceId: event.envelope.workspaceId, data: event.envelope.data} as UiEvent;
    bufferSnapshotEvent(reduced,event.bytes);
    const reducerStartedAt = performance.now(); state = reduceEvent(state, reduced);
    diagnostics.measure('reducer', reducerStartedAt, performance.now());
    if (state.needsResync) { disconnected(new Error('The event baseline needs a refresh.')); return; }
    if (event.name === 'workspace.changed' && state.workspace) state = {...state, workspace: selectionQueue.observe(state.workspace)};
    if (event.name === 'ready') { connectionId = (event.envelope.data as EventData['ready']).connectionId;streamWait?.resolve();refreshFileConnection();return; }
    if (old === state) return;
    if (event.name === 'control.request') {void browserControl.receive(event.envelope.data as ControlRequest);return;}
    applyEvent(event); refreshCaptionConsumers();
    if (event.name === 'primary.state') {
      const current = event.envelope.data as PrimaryView; refreshReadyHistory(old.primaries.get(current.key),current);
    }
  } finally {devRestoreWake?.();}
}
function refreshReadyHistory(previous:PrimaryView|undefined,current:PrimaryView):void {
  if(!historyBecameReady(previous,current,state.workspace?.primaryKey))return;
  const target = primaryTarget(), controller = target && state.workspace ? controllers.get(controllerKey(state.workspace.id,target)) : undefined;
  if(controller)controller.historyReady = false;
  void loadVisibleHistory();
}
function bufferSnapshotEvent(event:UiEvent,bytes = 512):void {
  for(const buffer of snapshotBuffers) {
    buffer.bytes += bytes;
    if(buffer.bytes > 1_048_576 || buffer.events.length >= 256)buffer.overflow = true;
    if(!buffer.overflow)buffer.events.push(event);
  }
}
function refreshFileConnection():void {void watchFiles(true);filesTree.refresh();const workspace = state.workspace;if (workspace) for (const root of filesViews.scopes(workspace.id)) void filesViews.refresh(workspace.id,root.rootId,root.files);}
function applyEvent(event: ReceivedEvent): void {
  const name = event.name;
  if (name === 'primary.delta' || name === 'primary.message' || name === 'primary.entry' || name === 'primary.tool') renderPrimaryEvent(event);
  else if (name === 'primary.state') { renderPrimary(); extensionDialogs.update(); }
  else if (name === 'primary.recovery' || name === 'primary.queue') renderPrimary();
  else if (name === 'agent.frame') renderObservedAgent(event.envelope.data as EventData['agent.frame'], event.receivedAt);
  else if (name === 'agent.roster' || name === 'agent.availability') renderRosterEvent(event);
  else applyShellEvent(event);
}
function applyShellEvent(event:ReceivedEvent):void {
  switch (event.name) {
    case 'workspace.changed': renderAll();void loadVisibleHistory();break;
    case 'files.changed': fileChanges(event.envelope.data as FileChanges,event.envelope.workspaceId);break;
    case 'sessions.writers': picker.writersChanged();break;
    case 'draft.changed': updateDraft(event.envelope.data as EventData['draft.changed']);break;
    case 'operation.changed': showOperation(event.envelope.data as OperationView);break;
    case 'notice': {const notice = event.envelope.data as EventData['notice'];if (notice.code?.startsWith('control_')) {controlStatus = notice.message;controlStatusWorkspace = state.workspace?.id;renderWorkbenchStatus();}noticesBadge();break;}
    case 'extension.request': applyExtension(event);break;
    case 'extension.expired': extensionDialogs.update();break;
  }
}
function renderPrimaryEvent(event: ReceivedEvent): void {
  const target = event.envelope.target; const controller = target && state.workspace ? controllers.get(controllerKey(state.workspace.id, target)) : undefined;
  if (controller) controller.transcript.defer(() => renderController(controller), event.receivedAt);
  if (event.name === 'primary.tool') { tabStrip.render(); renderIdentity(); }
  if (event.name === 'primary.message' && (event.envelope.data as EventData['primary.message']).message.state === 'final') renderPrimaryUsage(primary());
}
function renderRosterEvent(event: ReceivedEvent): void {
  if (event.name === 'agent.roster') messageTarget.rosterChanged(event.envelope.data as EventData['agent.roster']);
  else {
    const data = event.envelope.data as EventData['agent.availability'];
    if (!Number.isSafeInteger(data.connectionEpoch) || data.connectionEpoch <= 0 || data.connectionEpoch < (state.agentEpochs.get(data.identity) ?? 0)) return;
    const controller = state.workspace ? controllers.get(controllerKey(state.workspace.id, {kind: 'agent', identity: data.identity})) : undefined;
    if (controller) {
      controller.connection = {availability: data.state, capabilities: data.capabilities, reason: data.reason}; controller.connectionError = undefined;
      renderComposerSettings(controller, presentation(controller.target));
    }
    messageTarget.availabilityChanged(data);
  }
  renderRoster(); renderAgent(); renderMessagePanel();
}
function renderObservedAgent(data: EventData['agent.frame'], receivedAt?: number): void {
  const target = {kind: 'agent' as const, identity: data.identity}; const controller = state.workspace ? controllers.get(controllerKey(state.workspace.id, target)) : undefined;
  const conversation = state.conversations.get(targetIdentity(target)); if (conversation?.connectionEpoch !== data.connectionEpoch || conversation.frame?.revision !== data.frame.revision || (conversation.frame.attachmentRevision ?? 0) !== (data.frame.attachmentRevision ?? 0)) return;
  if (controller) renderController(controller, true, receivedAt);
  tabStrip.render(); renderIdentity();
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
  document.documentElement.dataset.appearance = resolveAppearance(state.workspace.appearance);
  renderNavigation();
  if (messageTarget.current && !messageTarget.valid(messageTarget.current)) closeMessagePanel(false);
  syncThreadHost(); renderPrimary(); renderRoster(); renderAgent(); renderMessagePanel(); refreshPaneSizes(); noticesBadge(); extensionDialogs.update(); refreshCaptionConsumers();
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
  if (tab && tab.kind !== 'file') lastConversationPane = layout.focusedPane;
  renderPaneTree(layout); renderSessionEntry(!!tab); byId('conversation-panes').hidden = !hasConversation();
  tabStrip.render(); renderIdentity();
  byId('primary-row').hidden = !primary() || paneLeaves(layout.root).some(pane => pane.tabs.some(tab => tab.kind === 'primary'));
  byId('primary-section').hidden = !hasConversation(); byId('primary-section-body').hidden = false;
  byId('primary-row').setAttribute('aria-label', 'Return to Primary'); byId('primary-row').setAttribute('aria-current', agentSelected ? 'false' : 'page');
  const navigation = byId('navigation-access'); const leading = paneRegions.get(layout.focusedPane)?.node.querySelector<HTMLElement>('.tab-bar') ?? byId('workspace');
  if (navigation.parentElement !== leading) leading.prepend(navigation);
  renderSidebarSections();renderFiles(); renderConnection();
}
function renderSessionEntry(hasTab: boolean): void {
  const firstUse = !hasConversation();
  byId('tabs-empty').hidden = hasTab || firstUse; byId('tabs-open-primary').hidden = !primary();
  const chooser = byId('session-chooser'); chooser.hidden = !firstUse;
  if (firstUse && snapshot) picker.mount(chooser, projectPath()); else picker.unmount();
}
function focusEditor(): void {const selected=layoutTarget(currentLayout(),primaryTarget());const owner=selected&&state.workspace?controllers.get(controllerKey(state.workspace.id,selected)):undefined;if(owner&&threadHost===owner){threadReader.focus();return;}if(owner?.inspection?.active){owner.inspection.scroller.focus({preventScroll:true});return;}const tab = activeTab(currentLayout());if (tab?.kind === 'file' && state.workspace) {filesViews.view(state.workspace,tab).focus();return;}const target = layoutTarget(currentLayout(), primaryTarget()); if (target) conversationController(target).composer.focus(); }
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
  const target = primaryTarget();if(target) conversationController(target).passive = false;
  const applied = selection({selectedTarget: target ?? null, conversationLayout: layout});
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
    clearPreparationError(controller);
    if (!controller.initialized) {controller.initialized = true; controller.showThinking = thinkingExpanded(saved.presentation); controller.transcript.configure(saved.presentation, saved.reading);}
    controller.composer.attach(controller.workspaceId, saved);
  } else prepareController(controller);
  controller.composer.receipts(state.operations.values());
  const view = presentation(controller.target); controller.composer.recipient((view.input ? 'Message ' : 'Draft for ') + presentationName(view), controllerGuidance(controller, view), messagePlaceholder(presentationName(view), controller.target));
  controller.composer.availability(connected, !!saved && (controller.target.kind === 'agent' || view.input), view.busy, selecting, view.input);
  if (firstDraft && !controller.passive && !controller.root.hidden && sameTarget(layoutTarget(currentLayout(), primaryTarget()) ?? undefined, controller.target) && document.activeElement === document.body) controller.composer.focus();
  controller.elements.root.hidden = !saved;renderInspection(controller); renderObserved(controller, controller.target.kind === 'agent' || connected || !view.activity);
  controllerNode(controller, 'stop').hidden = !canStopController(controller);
  if (controller.root.hidden) return;
  refreshStaleConnection(controller);
  const paint = () => {
    const conversation = state.conversations.get(targetIdentity(controller.target)); const entries = inputEchoes.entries(controller.workspaceId,controller.target,conversation ? conversationBlocks(conversation) : []);
    controller.transcript.set(entries, conversation?.tools, conversation?.thinking); const hasEntries = entries.some(entry => !['model_change', 'thinking_level_change'].includes(entry.kind) && entryVisible(entry));
    controller.hasEntries = hasEntries; renderControllerEmpty(controller);
    if (controller.target.kind === 'agent') {
      if (!controller.historyBoundaryLoaded && conversation?.frame) controller.before = conversation.frame.nextBefore;
      controller.transcript.historyAvailable(controller.before !== null);
    }
  };
  if (deferred) controller.transcript.defer(()=>{paint();renderInspection(controller);}, receivedAt); else {paint();renderInspection(controller);}
}
function clearPreparationError(controller: ConversationController): void {
  const notice = controllerNode(controller, 'view-notice'); if (notice.querySelector('.preparation-error')) notice.replaceChildren();
}
function renderControllerEmpty(controller: ConversationController): void {
  if (controller.target.kind === 'agent') {renderAgentState(controller); return;}
  const emptyView = primaryEmpty(state.primaries.get(controller.target.key), !!controller.hasEntries, controller.historyReady);
  controllerNode(controller, 'empty').hidden = !emptyView; setText(controllerNode(controller, 'empty-heading'), emptyView?.heading ?? ''); setText(controllerNode(controller, 'empty-caption'), emptyView?.caption ?? '');
}
function prepareController(controller: ConversationController): void {
  if (controller.passive) {controller.composer.attachRetained(controller.workspaceId, controller.target); return;}
  if (controller.preparing || controller.abort.signal.aborted) return; controller.preparing = true;
  const connection = source;
  void request<import('../shared/api.ts').TargetPreparation>(`/api/workspaces/${encodeURIComponent(controller.workspaceId)}/targets`, 'POST', {target: controller.target}, undefined, controller.abort.signal).then(prepared => applyPreparation(controller, prepared, connection)).catch(error => {if (preparationCurrent(connection) && !controller.abort.signal.aborted) controllerPreparationFailed(controller, error);}).finally(() => {controller.preparing = false; if (!controller.historyReady && !controller.root.hidden) void loadControllerHistory(controller);});
}
function applyPreparation(controller: ConversationController, prepared: import('../shared/api.ts').TargetPreparation, connection: EventSource | undefined): void {
  if (controller.workspaceId !== state.workspace?.id || controller.abort.signal.aborted || !sameTarget(prepared.targetState.target, controller.target)) return;
  const current = state.targets.get(prepared.targetState.targetKey); const saved = current && current.draft.revision >= prepared.targetState.draft.revision ? current : prepared.targetState;
  state = {...state, targets: new Map(state.targets).set(saved.targetKey, saved)}; controller.saved = saved;
  // Saved drafts outlive the stream; negotiated capabilities belong to its current lifetime.
  if (preparationCurrent(connection)) {
    controller.connectionError = undefined;
    if (controller.target.kind === 'agent') controller.connection = prepared;
  }
  renderController(controller); renderRoster(); renderWorkbenchStatus();
}
/** Model and thinking sit under the composer: pickers for the Primary, passive facts for an agent. */
function wireSettingPickers(target: Target, elements: import('./composer.ts').ComposerElements): void {
  if (target.kind !== 'primary') return;
  elements.model?.addEventListener('click', () => actions.modelPicker()); elements.thinking?.addEventListener('click', () => actions.thinkingPicker());
}
function renderComposerSettings(controller: ConversationController, view: ConversationPresentation): void {
  const {model, thinking, settings} = controller.elements; const text = settings?.querySelector<HTMLElement>('.composer-settings-text'), separator = settings?.querySelector<HTMLElement>('.composer-settings-separator');
  if (!model || !thinking || !text || !separator) return;
  if (controller.target.kind === 'primary') renderPrimarySettings(model, thinking, view); else renderAgentSettingsText(model, thinking, view, text);
  separator.hidden = model.hidden || thinking.hidden;
  if (controller.target.kind === 'primary') text.hidden = true;
}
function renderPrimarySettings(model: HTMLButtonElement, thinking: HTMLButtonElement, view: ConversationPresentation): void {
  const ready = view.input, id = view.model ? `${view.model.provider}/${view.model.modelId}` : '';
  model.hidden = !view.model && !ready; model.disabled = !ready; setText(model, view.model?.modelId ?? 'Choose model'); model.title = id ? `${id} · Primary` : 'Choose Primary model'; model.setAttribute('aria-label', id ? `Model for Primary: ${id}` : 'Choose Primary model');
  thinking.hidden = !view.thinking; thinking.disabled = !ready; setText(thinking, view.thinking ?? ''); thinking.title = view.thinking ? `Thinking level: ${view.thinking}` : 'Choose thinking level'; thinking.setAttribute('aria-label', view.thinking ? `Thinking level for Primary: ${view.thinking}` : 'Choose Primary thinking level');
}
function renderAgentSettingsText(model: HTMLButtonElement, thinking: HTMLButtonElement, view: ConversationPresentation, text: HTMLElement): void {
  model.hidden = thinking.hidden = true; const full = settingsLabel(view, true);
  setText(text, [view.model?.modelId, view.thinking].filter(Boolean).join(' · ')); text.hidden = !text.textContent; text.title = full; text.setAttribute('aria-label', full);
}
function controllerPreparationFailed(controller: ConversationController, error: unknown): void {
  if (controller.target.kind === 'agent') {controller.connectionError = errorMessage(error); renderAgentState(controller);}
  else if (!targetState(controller.target)) showStatusError(controllerNode(controller, 'view-notice'), 'Conversation could not be prepared.', error, 'preparation-error');
}
export function primaryChrome(item?: PrimaryView): void {
  tabStrip.render();
  renderIdentity();
  primaryNavigation(item);
  renderTabActions();
  const owner = item && state.workspace ? controllers.get(controllerKey(state.workspace.id, {kind: 'primary', key: item.key, epoch: item.epoch})) : undefined;
  if (owner) renderComposerSettings(owner, presentation(owner.target));
  renderPrimaryUsage(item);
  const settings = byId('primary-settings-detail'); setText(settings, [item?.model ? `Model ${item.model.provider}/${item.model.id}` : '', item?.thinkingLevel ? `Thinking ${item.thinkingLevel}` : ''].filter(Boolean).join(' · ')); settings.hidden = !settings.textContent;
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
  status.dataset.tone = view.tone;
  setText(byId('primary-row-title'), item ? view.name : 'no session');
  const detail = item ? [view.name, item.sessionId ? `Session ID: ${item.sessionId}` : '', view.nameDetail].filter(Boolean).join('\n') : 'No session';
  const row = byId('primary-row'); row.title = detail; row.setAttribute('aria-description', detail);
  setText(byId('primary-row-meta'), item && view.activity !== 'Ready' ? primaryState(item) : '');
}
function primaryActivity(item?: PrimaryView, target?: Target): void {
  const conversation = target ? state.conversations.get(targetIdentity(target)) : undefined;
  const view = presentation(target);
  renderPrimaryQueue(conversation?.queue);
  primaryNode('activity').replaceChildren();
  if (item?.lastError) {
    setText(primaryNode('activity'), item.lifecycle === 'ready' ? 'This session reported an error.' : 'This session is not ready. Your draft is unchanged.');
    primaryNode('activity').append(button('Sessions', () => picker.open(projectPath())), details('Details', item.lastError.message));
    if (item.lifecycle === 'ready') primaryNode('activity').append(button('Review message', () => actions.retryOutput()));
  }
  else if (!view.busy && view.responseOutcome === 'failed' && item?.lifecycle === 'ready') primaryNode('activity').append(button('Review message', () => actions.retryOutput()));
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
  renderSectionCounts();
  roster.set(state.rosterOrder.flatMap(id => { const row = state.roster.get(id); return row ? [row] : []; }), state.rosterMeta, selectedAgent());
  for (const identity of state.roster.keys()) renderMessageResume(identity);
  refreshCaptionConsumers();
}
function renderMessageResume(identity: string): void {
  const target = {kind: 'agent' as const, identity}; const workspace = state.workspace?.id ?? '';
  const index = [...state.targetIndex.values()].find(item => sameTarget(item.target, target)); const controller = controllers.get(controllerKey(workspace, target));
  const saved = targetState(target), stored = !!saved && (draftHasContent(saved.draft) || !!saved.unconfirmed.length || !!saved.retainedInputs.length);
  roster.resume(identity, !!controller?.messageRetention || (controller?.composer.retained(workspace, target, index) ?? (stored || !!index?.hasDraft || !!index?.unconfirmedOperationIds.length || !!index?.retainedInputOperationIds.length)));
}
function placeMessageRoot(controller: ConversationController, panel: HTMLElement): void {
  const pane = viewPane(controller.root);
  if (!pane || pane.closest('[hidden],[inert]')) {stableViews().place(controller.root, panel); controller.root.dataset.messageOnly = 'true';}
}
function clearMessageProjections(keep?: ConversationController): void {
  for (const controller of controllers.values()) if (controller !== keep && controller.elements.root.dataset.messagePanel) {
    delete controller.elements.root.dataset.messagePanel; stableViews().project(controller.elements.root);
    const pane = viewPane(controller.root); if (!pane || pane.closest('[hidden],[inert]')) hideController(controller);
    controller.composer.placement(false);
  }
}
function placeMessageEditor(controller: ConversationController, panel: HTMLElement): void {
  clearMessageProjections(controller);
  let slot = panel.querySelector<HTMLElement>('.message-editor-slot'); if (!slot) {slot = element('div', 'message-editor-slot'); slot.id = 'agent-message-editor-slot'; panel.append(slot);}
  placeMessageRoot(controller, panel);
  controller.elements.root.dataset.messagePanel = 'true'; stableViews().project(controller.elements.root, slot); stableViews().sync(); controller.composer.placement(true);
}
function renderMessagePanel(): void {
  const captured = messageTarget.current, panel = byId('agent-message-panel'); panel.hidden = !captured;
  if (!captured) {clearMessageProjections(); workspaceViews?.sync(); return;}
  if (!messageTarget.valid(captured)) {closeMessagePanel(false); return;}
  const target = {kind: 'agent' as const, identity: captured.identity}, controller = conversationController(target), view = presentation(target), name = presentationName(view);
  setText(byId('agent-message-name'), name); setText(byId('agent-message-identity'), captured.identity); byId('agent-message-identity').title = captured.identity;
  renderMessageStatus(captured); renderMessageRecovery(captured.preparing === true);
  if (captured.prepared) {
    const prepared = captured.prepared.targetState, current = state.targets.get(prepared.targetKey);
    const saved = current && current.draft.revision >= prepared.draft.revision ? current : prepared;
    state = {...state, targets: new Map(state.targets).set(saved.targetKey, saved)}; controller.saved = saved; controller.composer.attach(captured.workspaceId, saved);
  } else controller.composer.attachRetained(captured.workspaceId, target);
  placeMessageEditor(controller, panel);
  const ready = messageTarget.ready; controller.composer.recipient((ready ? 'Message ' : 'Draft for ') + name, ready || !captured.prepared || captured.invalidated ? '' : 'This agent is not ready for messages.', messagePlaceholder(name, target));
  controller.composer.availability(connected, !!controller.saved, view.busy, selecting, view.input); controller.composer.receipts(state.operations.values()); controllerNode(controller, 'stop').hidden = true;
  renderWorkbenchStatus();
}
function renderMessageStatus(captured: import('./selection-state.ts').MessageCapture): void {
  const status = byId('agent-message-status'); status.title = captured.error ?? captured.prepared?.reason ?? '';
  let text = captured.prepared ? '' : 'Preparing message…';
  if (captured.prepared?.reason) text = 'Agent connection is unavailable.';
  if (captured.error) text = 'Message connection is unavailable. Your draft is unchanged.';
  if (captured.invalidated) text = 'Message access changed. Your draft is unchanged.';
  setText(status, text);
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
  clearMessageProjections();
  renderNavigation(); renderRoster(); collectControllers(); stableViews().sync();
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
  const full = settingsLabel(view, true), owner = state.workspace ? controllers.get(controllerKey(state.workspace.id, target)) : undefined;
  if (owner) renderComposerSettings(owner, view);
  const phone = matchMedia('(max-width: 599px)').matches, detail = byId('agent-settings-detail');
  const retained = !!view.model && view.retainedModel || !!view.thinking && view.retainedThinking;
  setText(detail, [full, retained ? 'Last observed settings are not confirmed current.' : '', view.detail].filter(Boolean).join('\n')); detail.hidden = !detail.textContent;
  const conversation = state.conversations.get(targetIdentity(target)); const usage = usageFacts(undefined, conversation ? conversationBlocks(conversation) : []);
  byId('agent-usage-summary').replaceChildren(...usageNodes(usage, true)); byId('agent-usage').replaceChildren(...usageNodes(usage, false));
  byId('agent-usage-details').hidden = !phone && !usage.facts.length && !view.cwd && !view.model && !view.thinking && !view.detail;
  setText(byId('agent-usage-note'), 'Loaded finalized assistant messages only; earlier and omitted usage is not included.');
  renderComposerFolder('agent-folder', composerFolder(view, true));
}
let checkingAgent: string | undefined;
function agentStartKey(workspace: string, identity: string): string { return JSON.stringify([workspace, identity]); }
function controllerGuidance(controller: ConversationController, view: ConversationPresentation): string {
  return controller.target.kind === 'agent' ? '' : view.guidance;
}
function renderAgentRecipient(identity: string, view: ConversationPresentation = presentation({kind: 'agent', identity})): void {
  agentComposer().recipient(`${view.input ? 'Message' : 'Draft for'} ${presentationName(view)}`, '', messagePlaceholder(presentationName(view), {kind: 'agent', identity}));
}
function renderStoredAgent(identity: string, _row?: AgentRow): void {
  renderAgentState(conversationController({kind: 'agent', identity}));
  if (!messageTarget.current) renderAgentRecipient(identity);
  renderWorkbenchStatus(); tabStrip.render();
}
/** The availability that decides whether this agent's messages are read from saved records. */
function agentReadAvailability(controller: ConversationController): AgentRow['availability'] | undefined {
  if (controller.target.kind !== 'agent') return undefined;
  const negotiated = liveConnection(controller);
  const availability = negotiated || controller.connectionError ? undefined : state.agentAvailability.get(controller.target.identity);
  return negotiated?.availability ?? availability?.state ?? agentRow(controller.target.identity)?.availability;
}
function renderAgentState(controller: ConversationController): void {
  if (controller.target.kind !== 'agent') return;
  const {identity} = controller.target, workspace = controller.workspaceId;
  const negotiated = liveConnection(controller);
  const availability = negotiated || controller.connectionError ? undefined : state.agentAvailability.get(identity), row = agentRow(identity), attempt = agentStarts.get(agentStartKey(workspace, identity));
  const history = agentHistoryNote({hasEntries: !!controller.hasEntries, connected, loading: controller.loading, ready: controller.historyReady, complete: controller.historyComplete, error: controller.historyError, availability: agentReadAvailability(controller)});
  const note = controllerNode(controller, 'history-note'), line = controllerNode(controller, 'history-note-line');
  setText(line, history.text); note.hidden = !history.text || !!controller.inspection?.active;
  const reload = controllerNode(controller, 'history-reload') as HTMLButtonElement, details = controllerNode(controller, 'history-details') as HTMLButtonElement;
  setText(reload, history.label); reload.hidden = !history.reload; reload.disabled = !connected || controller.loading || !!checkingAgent || attempt?.pending === true; reload.onclick = () => {void retryAgentRead(controller);};
  details.hidden = !history.detail; details.onclick = () => showDetails('Saved messages', history.detail);
  const current = presentation(controller.target);
  const composerState = agentComposerState({connected, availability: availability?.state ?? row?.availability, input: current.input, checked: !!negotiated || !!availability, reason: negotiated?.reason ?? availability?.reason, startAttempt: attempt, connectionError: controller.connectionError, checking: !!controller.refreshing, blocked: current.activity === 'Provider blocked' ? current.detail : undefined});
  controllerNode(controller, 'empty').hidden = true; controller.root.classList.toggle('agent-empty', !controller.hasEntries);
  controller.composer.setState(composerState && composerStateView(composerState, () => {
    if (composerState.kind === 'unreachable') prepareAgentConnection(controller);
    else void (attempt && !attempt.pending ? checkAgentConnection(workspace, identity) : startStoredAgent(workspace, identity));
  }));
  controller.composer.commandsChanged();
}
/** Repeats the target preparation for an agent whose connection facts belong to a closed stream. */
function prepareAgentConnection(controller: ConversationController): void {
  if (controller.target.kind !== 'agent' || controller.refreshing || controller.abort.signal.aborted || !connected || controller.workspaceId !== state.workspace?.id) return;
  controller.refreshing = true; controller.connectionError = undefined; renderAgentState(controller);
  const connection = source;
  void request<import('../shared/api.ts').TargetPreparation>(`/api/workspaces/${encodeURIComponent(controller.workspaceId)}/targets`, 'POST', {target: controller.target}, undefined, controller.abort.signal)
    .then(prepared => applyPreparation(controller, prepared, connection))
    .catch(error => {if (preparationCurrent(connection) && !controller.abort.signal.aborted) controllerPreparationFailed(controller, error);})
    .finally(() => {controller.refreshing = false; renderAgentState(controller);});
}
function refreshStaleConnection(controller: ConversationController): void {
  if (controller.connection?.stale && !controller.connectionError && !controller.root.hidden && !controller.root.inert) prepareAgentConnection(controller);
}
const ACTION_TITLES: Partial<Record<AgentComposerState['kind'], string>> = {start: 'Start agent. This can resume unfinished work before the agent is ready.', failed: 'Check whether the agent started.'};
function composerStateView(view: AgentComposerState, run: () => void): ComposerStateView {
  const {action} = view;
  return {line: view.line, blocksSend: view.kind === 'read-only' || view.kind === 'checking', detail: view.detail || undefined, showDetail: () => showDetails('Agent details', view.detail),
    ...(action ? {action: {...action, ...(ACTION_TITLES[view.kind] ? {title: ACTION_TITLES[view.kind]} : {}), disabled: action.disabled || !connected || !!checkingAgent, run}} : {})};
}
function showDetails(title: string, detail: string): void {
  modal.open(title); modal.body.append(element('pre', undefined, detail));
}
async function retryAgentRead(controller: ConversationController): Promise<void> {
  if (!connected || controller.target.kind !== 'agent' || controller.workspaceId !== state.workspace?.id || controller.loading) return;
  await loadControllerHistory(controller);
}
function showAgentCommand(identity: string): void {
  const command = `/agent attach ${identity}`; modal.open('Open in Pi terminal');
  modal.body.append(element('pre', undefined, command), button('Copy command', () => {void copy(command, modal.body);}));
}
function focusStoredEditor(): void {
  if (agentNode('start').contains(document.activeElement)) agentComposer().editor.focus({preventScroll: true});
}
export async function startStoredAgent(workspace: string, identity: string): Promise<void> {
  const key = agentStartKey(workspace, identity);
  if (!connected || workspace !== state.workspace?.id || identity !== selectedAgent() || agentRow(identity)?.availability !== 'stored' || checkingAgent || agentStarts.has(key)) return;
  const connection = source;
  agentStarts.set(key, {pending: true}); focusStoredEditor(); renderStoredAgent(identity, agentRow(identity));
  const current = () => workspace === state.workspace?.id && identity === selectedAgent();
  try {
    const result = await request<import('../shared/api.ts').TargetPreparation>(`/api/agents/${encodeURIComponent(identity)}/start?workspace=${encodeURIComponent(workspace)}`, 'POST', {}, crypto.randomUUID());
    requireCurrentPreparation(connection);
    if (result.targetState.target.kind !== 'agent' || result.targetState.target.identity !== identity || result.availability !== 'live' || !result.capabilities.input) throw new Error(result.reason ?? 'A usable connection was not confirmed.');
    if (!current()) { agentStarts.delete(key); return; }
    await reload();
    if (!current()) { agentStarts.delete(key); return; }
    requireCurrentPreparation(connection);
    agentStarts.delete(key); const controller = conversationController({kind: 'agent', identity}); controller.connection = result; controller.connectionError = undefined; renderRoster();
  } catch (error) { agentStarts.set(key, {pending: false, reason: errorMessage(error)}); }
  finally { if (current()) renderStoredAgent(identity, agentRow(identity)); }
}
async function confirmCheckedAgent(result: import('../shared/api.ts').TargetPreparation, identity: string, key: string, current: () => boolean, connection: EventSource | undefined): Promise<void> {
  requireCurrentPreparation(connection);
  if (result.targetState.target.kind !== 'agent' || result.targetState.target.identity !== identity) throw new Error('The prepared conversation changed.');
  if (result.availability === 'live' && result.capabilities.input) {
    await selection({selectedTarget: {kind: 'agent', identity}});
    if (!current()) return;
    requireCurrentPreparation(connection);
    agentStarts.delete(key);
  } else {
    await reload();
    if (agentRow(identity)?.availability === 'stored') agentStarts.delete(key);
  }
  requireCurrentPreparation(connection);
  if (current()) {const controller = conversationController({kind: 'agent', identity}); controller.connection = result; controller.connectionError = undefined;renderController(controller);renderRoster();}
}
export async function checkAgentConnection(workspace: string, identity: string): Promise<void> {
  const key = agentStartKey(workspace, identity);
  if (!connected || workspace !== state.workspace?.id || identity !== selectedAgent() || checkingAgent || agentStarts.get(key)?.pending) return;
  const connection = source;
  conversationController({kind:'agent',identity}).passive = false;
  checkingAgent = identity; focusStoredEditor(); renderStoredAgent(identity, agentRow(identity));
  const current = () => workspace === state.workspace?.id && identity === selectedAgent();
  try {
    const result = await request<import('../shared/api.ts').TargetPreparation>(`/api/workspaces/${encodeURIComponent(workspace)}/targets`, 'POST', {target: {kind: 'agent', identity}});
    if (!current()) return;
    await confirmCheckedAgent(result, identity, key, current, connection);
  } catch (error) { if (preparationCurrent(connection) && current()) conversationController({kind: 'agent', identity}).connectionError = errorMessage(error); }
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
  if (frame?.status.compactions) facts.push({key: 'compactions', label: 'Context compaction', text: rawText(frame.status.compactions.value)});
  if (frame?.status.compactionFailure) facts.push({key: 'compaction-failure', label: 'Last compaction error', text: rawText(frame.status.compactionFailure.value)});
  if (row?.currentTool) facts.push({key: 'tool', label: 'Last reported tool', text: `${row.currentTool.name} · ${row.currentTool.argument}`});
  facts.push({key: 'context', label: 'Context', text: 'Context not reported'});
  return facts;
}
function renderAvailability(): void {
  for (const controller of controllers.values()) {
    if (!connected && controller.connection?.availability === 'live') controller.connection = {...controller.connection, stale: true};
    const view = presentation(controller.target), current = controller.workspaceId === state.workspace?.id; controller.composer.availability(connected && current, current && !!controller.saved && (controller.target.kind === 'agent' || view.input), current && view.busy, selecting, view.input);
    controllerNode(controller, 'stop').hidden = !canStopController(controller); renderControllerEmpty(controller);
  }
  if (!connected && messageTarget.current) {messageTarget.current.invalidated = true; messageTarget.current.preparing = false; messageTarget.current.error = 'The browser connection changed. Check the agent connection again.';}
  if (messageTarget.current) renderMessagePanel(); renderIdentity(); tabStrip.render();
}
export async function selectAgent(row: AgentRow): Promise<void> {
  conversationController({kind: 'agent', identity: row.identity}).passive = false;
  const origin = document.activeElement; drawerOpen = false;
  const applied = selection({panelVisible: true, selectedTarget: {kind: 'agent', identity: row.identity}});
  focusEditor(); await applied;
  if (selectedAgent() === row.identity && (document.activeElement === origin || document.activeElement === document.body)) focusEditor();
}
async function loadVisibleHistory(): Promise<void> {
  await Promise.all(paneLeaves(currentLayout().root).flatMap(pane => { const tab = pane.tabs.find(tab => tabKey(tab) === pane.active), target = tab ? controllerTarget(tab) : undefined; return target ? [loadControllerHistory(conversationController(target))] : []; }));
}
function historyPath(controller: ConversationController, earlier: boolean): string {
  const target = controller.target, base = target.kind === 'primary' ? `/api/primaries/${encodeURIComponent(target.key)}/history?limit=50` : `/api/agents/${encodeURIComponent(target.identity)}/history?limit=50&workspace=${encodeURIComponent(controller.workspaceId)}`;
  if (!earlier) return base;
  return base + (target.kind === 'primary' ? controller.cursor ? `&cursor=${encodeURIComponent(controller.cursor)}` : '' : controller.before !== null ? `&before=${controller.before}` : '');
}
function historyCurrent(controller: ConversationController, abort: AbortController): boolean {
  const target = controller.target; return !abort.signal.aborted && !controller.abort.signal.aborted && controller.workspaceId === state.workspace?.id && (target.kind !== 'primary' || state.primaries.get(target.key)?.epoch === target.epoch);
}
function claimHistoryBoundary(controller: ConversationController, earlier: boolean, entries: number, next: string | number | null): boolean {
  if (!earlier && controller.historyBoundaryLoaded) return false;
  controller.historyBoundaryLoaded = earlier || entries > 0 || next !== null;
  return true;
}
function mergeControllerHistory(controller: ConversationController, page: HistoryPage | AgentHistoryPage, earlier: boolean): void {
  const target = controller.target;
  if (target.kind === 'primary' && 'items' in page) {
    // Empty startup history confirms readiness but does not own the resumed pagination boundary.
    if (claimHistoryBoundary(controller, earlier, page.items.length, page.nextCursor)) controller.cursor = page.nextCursor;
    state = mergePrimaryPage(state, target, page.items, {nextCursor: controller.cursor, earlier});
  }
  else if (target.kind === 'agent' && 'entries' in page) {
    state = mergeAgentPage(state, target.identity, page.entries);
    if (claimHistoryBoundary(controller, earlier, page.entries.length, page.nextBefore)) controller.before = page.nextBefore;
  }
  else throw new Error('History response does not match its target.');
  controller.historyReady = true; controller.historyComplete = page.coverage.complete && !page.coverage.truncated && page.coverage.omitted === 0; controller.historyError = undefined; controller.transcript.historyAvailable(target.kind === 'primary' ? controller.cursor !== null : controller.before !== null); renderController(controller);
  if (target.kind === 'primary' && sameTarget(target, primaryTarget())) renderPrimaryUsage(primary());
}
/** Rows one upward trigger tries to add, and the pages it may read to get them. */
const EARLIER_FILL = {rows: 10, pages: 3};
function earlierBoundary(controller: ConversationController): string | number | null {return controller.target.kind === 'primary' ? controller.cursor : controller.before;}
function hasEarlierHistory(controller: ConversationController): boolean {return earlierBoundary(controller) !== null;}
/** One upward scroll near the top keeps reading 50-entry pages until they add enough rows, the page limit is reached, or no earlier history remains. */
function loadEarlierRows(controller: ConversationController): void {
  if (controller.fillingEarlier || controller.abort.signal.aborted || !hasEarlierHistory(controller)) return;
  controller.fillingEarlier = true;
  void (async () => {
    let rows = 0;
    try {
      for (let pages = 0; pages < EARLIER_FILL.pages && rows < EARLIER_FILL.rows && hasEarlierHistory(controller) && !controller.abort.signal.aborted; pages++) {
        const before = controller.transcript.rowCount(), boundary = earlierBoundary(controller);
        await loadControllerHistory(controller, true);
        if (earlierBoundary(controller) === boundary) break;
        rows += Math.max(0, controller.transcript.rowCount() - before);
      }
    } finally {controller.fillingEarlier = false;}
  })();
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
  // Saved positions initialize history; refreshes preserve the transcript's newer intent.
  const abort = controller.historyAbort, reading = earlier || restoring || controller.historyReady ? undefined : controller.saved?.reading ?? targetState(controller.target)?.reading;
  const more = controller.target.kind === 'primary' ? controller.cursor !== null : controller.before !== null;
  if (earlier && !more) return;
  const release = ownControllerReading(controller, reading); let loaded = false;
  try {loaded = await requestControllerHistory(controller, abort, earlier, restoring, reading);}
  finally {release(loaded);}
}
function ownControllerReading(controller: ConversationController, reading?: TargetState['reading']): (loaded: boolean) => void {
  if (!reading || reading.followTail || controller.root.hidden) return () => {};
  const abort = controller.historyAbort;
  // Empty or partial history can emit layout scrolls before the acknowledged anchor returns.
  controller.historyReading = reading; controller.transcript.restore(reading);
  const cancel = () => {
    if (controller.historyReading !== reading) return;
    controller.historyReading = undefined; controller.transcript.abandonRestore(reading);
  };
  abort.signal.addEventListener('abort', cancel, {once: true}); controller.abort.signal.addEventListener('abort', cancel, {once: true});
  return loaded => {
    abort.signal.removeEventListener('abort', cancel); controller.abort.signal.removeEventListener('abort', cancel);
    if (!loaded || !historyCurrent(controller, abort) || controller.root.hidden) cancel();
    else if (controller.historyReading === reading) controller.historyReading = undefined;
  };
}
async function requestControllerHistory(controller: ConversationController, abort: AbortController, earlier: boolean, restoring: boolean, reading?: TargetState['reading']): Promise<boolean> {
  startControllerHistory(controller); const control = controllerNode(controller, 'earlier') as HTMLButtonElement; historyLoadingFeedback(control, earlier); let loaded = false;
  try {
    const page = await request<HistoryPage | AgentHistoryPage>(historyPath(controller, earlier), 'GET', undefined, undefined, AbortSignal.any([abort.signal, controller.abort.signal, AbortSignal.timeout(15_000)]));
    if (!historyCurrent(controller, abort)) return false;
    if (controller.historyReading) controller.transcript.restore(controller.historyReading);
    mergeControllerHistory(controller, page, earlier); loaded = true; historyLoadedFeedback(earlier, restoring);
  } catch (error) {controllerHistoryFailed(controller, abort, error);}
  finally {if (controller.historyAbort === abort) {controller.loading = false; renderControllerEmpty(controller); control.disabled = false; control.setAttribute('aria-label', 'Earlier messages'); control.title = 'Earlier messages'; control.removeAttribute('aria-busy');}}
  if (loaded && reading && controller.historyReading === reading) await restoreControllerHistory(controller, reading);
  return loaded;
}
function startControllerHistory(controller: ConversationController): void {
  controller.loading = true; if (controller.historyError) controllerNode(controller, 'view-notice').replaceChildren(); controller.historyError = undefined; renderControllerEmpty(controller);
}
function controllerHistoryFailed(controller: ConversationController, abort: AbortController, error: unknown): void {
  if (!historyCurrent(controller, abort)) return;
  controller.historyError = {message: errorMessage(error), ...(error instanceof ApiError ? {code: error.view.code} : {})};
  if (controller.target.kind === 'agent') renderAgentState(controller);
  else {
    const actions = element('div', 'history-actions'); actions.append(historyDetails(error), cardAction('restart', 'Retry history', () => {void loadControllerHistory(controller);}));
    controllerNode(controller, 'view-notice').replaceChildren(element('p', undefined, 'History could not be loaded.'), actions);
  }
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
    loadEarlier: () => loadControllerHistory(controller, true, true), current: () => !controller.abort.signal.aborted && !controller.historyAbort.signal.aborted && controller.workspaceId === state.workspace?.id && !controller.root.hidden && (controller.historyReading === reading || controller.transcript.restorationCurrent(reading))});
  if (result !== 'exhausted' && result !== 'unavailable') return;
  controller.transcript.abandonRestore(reading); setText(controllerNode(controller, 'view-notice'), result === 'exhausted' ? 'Saved position is not in the available history. Showing the start.' : 'Your saved place is unavailable. Select Earlier to try again.');
}
function canStopController(controller: ConversationController): boolean {
  if (!connected || controller.workspaceId !== state.workspace?.id || controller.abort.signal.aborted) return false;
  if (controller.target.kind === 'agent' && messageTarget.current?.workspaceId === controller.workspaceId && messageTarget.current.identity === controller.target.identity) return false;
  if (controller.target.kind === 'primary') return presentation(controller.target).busy;
  const row = agentRow(controller.target.identity), view = presentation(controller.target); return !!row?.capabilities?.abort && view.input && view.busy;
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
  catch (error) {showStatusError(controller.elements.receipt, 'Stop could not be confirmed.', error);}
}
function saveReading(captured: TranscriptTarget | undefined, reading: TargetState['reading']): Promise<void> {
  if (!captured || captured.controller.historyReading) return Promise.resolve();
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
    const reading = kind === 'reading' ? values as Omit<TargetState['reading'], 'revision'> : undefined;
    if (reading && latest.reading.anchorId === reading.anchorId && latest.reading.offsetPx === reading.offsetPx && latest.reading.followTail === reading.followTail) return;
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
      controller.showThinking = thinkingExpanded(latest?.presentation); transcript.configure(latest?.presentation, latest?.reading); notice.replaceChildren();
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
  for (const group of noticeGroups(state.notices)) renderNoticeGroup(group);
}
function renderNoticeGroup(group: NoticeGroup): void {
  const row = element('div', `notification ${group.level}`); row.dataset.noticeCount = String(group.items.length);
  row.append(cardAction('close', group.items.length > 1 ? 'Dismiss these notifications' : 'Dismiss notification', () => {
    for (const notice of group.items) state = dismissNotice(state, notice.id);
    notices(); noticesBadge();
  }), element('p', undefined, group.message), details('Details', rawText(group.items)));
  const seen = new Set<string>(), workspace = state.workspace?.id, boot = state.bootId;
  for (const notice of group.items) {
    const target = noticeTarget(state, notice); if (!target || seen.has(targetIdentity(target))) continue;
    seen.add(targetIdentity(target)); const epoch = target.kind === 'agent' ? state.agentEpochs.get(target.identity) : target.epoch;
    const destination = button(`Open ${presentation(target).name}`, () => {
      if (state.workspace?.id !== workspace || state.bootId !== boot || !noticeTarget(state, notice) || target.kind === 'agent' && state.agentEpochs.get(target.identity) !== epoch) {announce('This conversation is no longer available.'); return;}
      modal.close(false); void navigateReference({target}).catch(showError);
    }, 'notice-destination'); destination.dataset.noticeId = notice.id; row.append(destination);
  }
  modal.body.append(row); references.decorate(row, () => group.items.every(notice => state.noticeShelf.get(notice.id) === notice && !state.dismissedNotices.has(notice.id)));
}
function showStatusError(node: HTMLElement, text: string, error: unknown, className = 'status-error'): void {
  const caption = element('span', className, text); caption.title = errorMessage(error); node.replaceChildren(caption);
}
function showError(error: unknown): void {
  const message = 'Action could not be completed.'; announce(message);
  if (footerController && footerController.workspaceId === state.workspace?.id) showStatusError(footerController.elements.receipt, message, error);
  else modal.open(message).append(details('Details', errorMessage(error)));
}
function showRosterError(error: unknown): void { const message = 'Agents could not be refreshed.'; announce(message); byId('roster-footer').replaceChildren(element('p', 'error', message), details('Details', errorMessage(error)), cardAction('restart', 'Refresh agent roster', () => { void reload().catch(showRosterError); })); }
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
/** A child conversation without a name of its own reads as its parent's name plus its number. */
function derivedChildName(identity: string): string | undefined {
  const split = identity.lastIndexOf(':'); if (split < 0 || !conversationIdentityText(identity)) return undefined;
  const parent = presentationCaptions().knownName(identity.slice(0, split))?.name;
  return parent ? `${parent} · ${identity.slice(split + 1)}` : undefined;
}
export function toolSubjectCaption(value: string): ToolSubjectCaption | undefined {
  const caption = subjectCaption(value), derived = caption?.name ? undefined : derivedChildName(value);
  if (derived) return {...caption, text: derived, title: value, derived: true};
  return caption && !caption.name && conversationIdentityText(value) ? {...caption, fallback: identityFallback(value)} : caption;
}
function subjectCaption(value: string): ToolSubjectCaption | undefined {
  const loadedName=presentationCaptions().knownName(value);
  const destinations = referenceIdentities(value), destination = destinations.length === 1 ? destinations[0] : undefined;
  if (!destination) return loadedName?{text:loadedName.name,...loadedName,title:value}:destinations.length || conversationIdentityText(value) ? {text: 'Unresolved conversation', title: value} : undefined;
  const primary = destination.target.kind === 'primary' ? state.primaries.get(destination.target.key) : undefined;
  const supplied = primary?.extension?.title || primary?.sessionName;
  const known = destination.target.kind === 'agent' ? loadedName : supplied && supplied !== value && !conversationIdentityText(supplied) ? {name:supplied,provenance:'supplied' as const} : undefined;
  return {text: presentationName(presentation(destination.target)), ...known, title: value, open: () => {
    const current = referenceIdentities(value);
    if (current.length === 1 && current[0] && sameTarget(current[0].target, destination.target)) void navigateReference(current[0]).catch(showError);
  }};
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
async function navigateReference(destination: ReferenceDestination, knownTaskReference = false): Promise<void> {
  const {target, entryId} = destination; const workspace = state.workspace?.id;
  if (!workspace) return;
  if (target.kind === 'agent') {
    if (!state.roster.has(target.identity) && selectedAgent() !== target.identity && !knownTaskReference) return;
    conversationController(target);
    await selection({panelVisible: true, selectedTarget: target, conversationLayout: openTab(currentLayout(), {kind: 'agent', identity: target.identity})});
    if (workspace !== state.workspace?.id || selectedAgent() !== target.identity) return;
    focusReference(conversationController(target).transcript, entryId);
  } else {
    if (state.primaries.get(target.key)?.epoch !== target.epoch) return;
    conversationController(target);
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
export function inspectAgent(identity = selectedAgent(), mode:'result'='result', selector?:ResultSelector): void {
  if(!identity||!state.workspace)return;
  const target={kind:'agent' as const,identity},controller=conversationController(target);controller.passive=true;
  const layout=currentLayout(),key=`agent:${identity}`,existing=paneLeaves(layout.root).find(pane=>pane.tabs.some(tab=>tabKey(tab)===key));
  const primaryPane=paneLeaves(layout.root).find(pane=>pane.tabs.some(tab=>tab.kind==='primary'));let next=layout;
  if(existing&&existing.id!==primaryPane?.id)next=activatePaneTab(primaryPane?activatePaneTab(layout,primaryPane.id,'primary'):layout,existing.id,key);
  else {
    const source=existing??primaryPane??paneById(layout,layout.focusedPane);
    if(source){const added=openTab({...layout,focusedPane:source.id},{kind:'agent',identity});const split=splitPane(added,source.id,'x',paneSpace(source.id),key);
      next=split;if(split===added&&primaryPane)announce('Tasks use this pane. Keep Primary available in its tab.');}
  }
  controller.inspection?.open(mode,selector);applyLayout(next);renderInspection(controller);
}
function conversationMenuItems(target: Target): ContextItem[] {
  const controller = conversationController(target), shown = controller.showThinking;
  const local: Record<string, () => void> = {
    ...(target.kind === 'primary' ? {'Conversation details': () => actions.sessionDetails(state.primaries.get(target.key))} : {}),
    'Expand loaded tools': () => controller.transcript.expandLoaded(true, true),
    'Collapse loaded tools': () => controller.transcript.expandLoaded(true, false),
    'Show thinking': () => controller.transcript.expandLoaded(false, !shown),
    'Find text': () => actions.find(() => captureFind(controller)),
  };
  return actions.sessionMenuEntries(target.kind === 'agent').filter(item => !['Sessions', 'Appearance', 'Help', 'Hide thinking', 'Model', 'Thinking'].includes(item.name))
    .map(item => ({label: item.name, enabled: local[item.name] ? true : item.enabled, run: local[item.name] ?? item.run, description: item.description, disabledReason: item.disabledReason,
      ...(item.name === 'Show thinking' ? {checked: shown, checkbox: true} : {})}));
}
/** A saved-message refresh is offered only where messages cannot update live; it runs the same history read as the note's Load action. */
function savedMessagesItem(identity: string): ContextItem[] {
  const controller = conversationController({kind: 'agent', identity});
  if (!readsSavedMessages({connected, availability: agentReadAvailability(controller)})) return [];
  return [{label: 'Refresh messages', enabled: !controller.loading && !checkingAgent, run: () => { void retryAgentRead(controller); }}];
}
function agentMenuItems(identity: string): ContextItem[] {
  const row = agentRow(identity);
  const items: ContextItem[] = [
    ...(row ? [
      {label: 'Show conversation', run: () => { void selectAgent(row).catch(showError); }},
      {label: 'Message', enabled: connected && row.availability === 'live' && row.capabilities?.input === true, run: () => openAgentMessage(identity)},
    ] : []),
    ...savedMessagesItem(identity),
    {label: 'Copy agent ID', run: () => { void copy(identity, agentNode('view-notice')); }},
    {label: 'Conversation details', run: () => actions.conversationDetails(identity)},
  ];
  items.push({label: 'Sent and received tasks…', run: () => inspectAgent(identity)}, {label: 'Open in Pi terminal…', run: () => showAgentCommand(identity)});
  items.push(...conversationMenuItems({kind: 'agent', identity}).filter(item => !items.some(existing => existing.label === item.label)));
  return items;
}
export function openConversationActions(paneId: string = focusedPane, key?: string, origin?: HTMLElement): void {
  const workspace = state.workspace?.id, layout = currentLayout(), pane = paneById(layout, paneId);
  const tab = pane?.tabs.find(tab => tabKey(tab) === (key ?? pane.active)), target = tab && controllerTarget(tab);
  if (!workspace || !tab || !target) return;
  const current = layout, owner = conversationController(target), rowAtOpen = target.kind === 'agent' && state.roster.has(target.identity), trigger = origin ?? paneRegions.get(paneId)?.actions;
  if (!trigger) return;
  const view = owner.transcript.node.dataset.view === 'grouped' ? 'grouped' : 'chronological';
  const choices: ContextItem[] = (['chronological', 'grouped'] as const).map(mode => ({label: mode === 'chronological' ? 'Conversation' : 'Grouped', description: mode === 'chronological' ? 'View: Conversation' : 'View: Grouped', checked: view === mode, run: () => owner.transcript.setView(mode)}));
  const entries = (tab.kind === 'agent' ? agentMenuItems(tab.identity) : conversationMenuItems(target)).filter(item => item.label !== 'Show conversation');
  const groups: [string, ContextItem[]][] = [
    ['View', [...choices, ...['Show thinking', 'Find text', 'Expand loaded tools', 'Collapse loaded tools'].flatMap(name => entries.filter(item => item.label === name))]],
    ['Messages and tasks', ['Message', 'Refresh messages', 'Review message', 'Sent and received tasks…', 'Saved drafts and messages', 'Message input…'].flatMap(name => entries.filter(item => item.label === name))],
    ['Session', ['New session', 'Fork from message…', 'Compact…', 'Automatic retry…', 'Automatic compaction…', 'Continue in terminal…', 'Open in Pi terminal…'].flatMap(name => entries.filter(item => item.label === name))],
    ['Details', ['Conversation details', 'Copy agent ID'].flatMap(name => entries.filter(item => item.label === name))],
  ];
  const grouped = groups.flatMap(([heading, items], group) => items.map((item, index) => index === 0 ? {...item, heading, separatorBefore: group > 0} : item));
  const box = trigger.getBoundingClientRect(); contextMenu.open(trigger, {x: box.right, y: box.bottom}, 'Conversation actions', [...grouped, {label: 'Commands…', separatorBefore: true, run: () => actions.palette()}],
    () => state.workspace?.id === workspace && samePaneLayout(currentLayout(), current) && sameTarget(controllerTarget(tab), target) && (target.kind === 'primary' || state.roster.has(target.identity) === rowAtOpen));
}
function paneSpace(id: string): {width: number; height: number; divider: number} { const box = paneRegions.get(id)?.node.getBoundingClientRect(); return {width: box?.width ?? 0, height: box?.height ?? 0, divider: 4}; }
function paneTabChoices(leaf: PaneLeaf, layout: ConversationLayout): ContextItem[] {
  const tabs = paneLeaves(layout.root).flatMap(pane => pane.tabs);
  const tails = duplicateTabTails(tabs,tabLabel);
  return leaf.tabs.map(tab => {
    const name = tabLabel(tab), tail = tab.kind === 'file' ? tails.get(tabKey(tab)) : tabPresentation(tab).identityTail;
    return {label: tail ? `${name} · ${tail}` : name, description: tab.kind === 'file' ? tab.path : tabPresentation(tab).activity, checked: tabKey(tab) === leaf.active, run: () => activateConversationTab(leaf.id, tabKey(tab))};
  });
}
function paneSwitchItems(layout:ConversationLayout,valid:()=>boolean):ContextItem[] {
  if (byId('conversation-panes').dataset.focusOnly !== 'true') return [];
  const panes = paneLeaves(layout.root);
  return panes.filter(pane=>pane.id !== layout.focusedPane).map((pane,index)=> {
    const active = pane.tabs.find(item=>tabKey(item) === pane.active);
    return {label:`Switch to ${active ? tabLabel(active) : 'Empty'} (pane ${panes.indexOf(pane) + 1})`,separatorBefore:index === 0,
      run:()=> {if (valid()) focusPane(pane.id);}};
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
    conversation: openConversationActions,
    overflow: purpose === 'context' && region.menu.dataset.overflow === 'true'});
  if (tab?.kind === 'file') items.push(...fileMenuItems(workspace,tab,valid));
  if (leaf) items.push(...closeViewMenuItems(leaf,key ?? leaf.active,valid));
  items.push(...paneSwitchItems(layout,valid));
  if (purpose === 'list' && leaf) {
    const first = items[0]; if (first) items[0] = {...first, heading: 'Pane actions', separatorBefore: true};
    items.unshift(...paneTabChoices(leaf, layout));
  }
  const trigger = region.menu; const box = trigger.getBoundingClientRect(); contextMenu.open(trigger, event ? {x: event.clientX, y: event.clientY} : {x: box.right, y: box.bottom}, purpose === 'list' ? 'Tabs in this pane' : 'Tab and view actions', items, () => valid() && (!owner || owner.workspaceId === state.workspace?.id));
}
function fileMenuItems(workspace:Workspace,tab:FileTab,valid:()=>boolean):ContextItem[] {
  const items:ContextItem[] = [{label:'Keep tab',separatorBefore:true,run:()=> {if (valid()) fileBrowse.keep(tabKey(tab));}},
    {label:'Re-read file',run:()=> {if (valid()) void filesViews.view(workspace,tab).owner.reread();}}];
  if (/\.(md|markdown|mdown)$/i.test(tab.path)) items.push({label:tab.view === 'preview' ? 'File source' : 'Markdown preview',run:()=> {
    if (!valid()) return;fileBrowse.keep(tabKey(tab));applyLayout(openTab(currentLayout(),{kind:'file',rootId:tab.rootId,path:tab.path,...(tab.view === 'preview' ? {} : {view:'preview'})}));focusEditor();
  }});return items;
}
function closeViewMenuItems(leaf:PaneLeaf,key:string|null,valid:()=>boolean):ContextItem[] {
  const close = (keep:string|null):void=> {if (!valid()) return;let next = currentLayout();for (const tab of leaf.tabs) if (tabKey(tab) !== keep) next = closeTab(next,tabKey(tab));applyLayout(next);};
  return [{label:'Close others',enabled:leaf.tabs.length > 1,run:()=>close(key)},{label:'Close all',run:()=>close(null)}];
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
function unnamedTab(tab:ConversationTab):boolean{
  if(tab.kind!=='agent')return false;const captions=presentationCaptions(),caption=captions.get(tab.identity);
  return caption.name==='Unnamed conversation'&&caption.source!=='first-message'&&!captions.knownName(tab.identity);
}
function tabLabel(tab: ConversationTab): string { return tab.kind === 'file' ? `${tab.path.split('/').at(-1) ?? tab.path}${tab.view === 'preview' ? ' preview' : ''}` : tabPresentation(tab).name; }
let dismissedPointer = false;
export function dismissDrawerPointer(event: PointerEvent): void {
  dismissedPointer = false;
  const target = event.target as HTMLElement | null;
  if (!drawerOpen || modal.openNow || contextMenu.openNow || target?.closest?.('#sidebar, dialog, .context-menu, .command-menu')) return;
  if (target && workspaceViews?.slot(target)?.closest('#sidebar')) return;
  event.preventDefault(); event.stopImmediatePropagation(); dismissedPointer = true; toggleSidebar(false);
}
export function consumeDrawerClick(event: MouseEvent): void {
  if (!dismissedPointer) return; dismissedPointer = false; if (event.detail === 0) return; event.preventDefault(); event.stopImmediatePropagation();
}
function appContextMenu(event: MouseEvent): void {
  if (event.defaultPrevented || nativeEditingTarget(event.target)) return;
  const target = event.target as HTMLElement | null, pane = target?.closest<HTMLElement>('.pane-leaf') ?? (target ? viewPane(target) : null);
  if (!pane?.dataset.paneId || target?.closest('.transcript,.file-reading')) return;
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
  document.addEventListener('compositionstart', event=> {if(event.target)composingFields.add(event.target);},true);
  document.addEventListener('compositionend', event=> {if(event.target)composingFields.delete(event.target);},true);
  for (const node of document.querySelectorAll<HTMLElement>('[data-control-icon]')) {
    const count = node.querySelector<HTMLElement>('#notices-count');
    controlIcon(node, node.dataset.controlIcon as CardIcon, node.getAttribute('aria-label') ?? node.textContent ?? '');
    if (count) node.append(count);
  }
  byId('files-heading').addEventListener('click',()=>setSidebarSection('files',!sidebarSections.files));
  byId('files-refresh').addEventListener('click',()=>filesTree.refresh());
  // Programmatic restoration also emits trusted scroll/select events; input intent must still change the revision.
  for (const name of ['input', 'change', 'keydown', 'pointerdown', 'wheel', 'select', 'scroll', 'compositionstart', 'compositionend'] as const) document.addEventListener(name, event => {
    if (!event.isTrusted || devRestoreOwner && (name === 'select' || name === 'scroll')) return;
    devInteractionRevision++;if (name !== 'select' && name !== 'scroll') selectionIntentRevision++;
    devRestoreWake?.();
  }, {capture: true, passive: true});
  window.addEventListener('pagehide', event => {if (!event.persisted && !devNavigating) devReload?.destroy();});
  setRequestTiming((start, end) => {diagnostics.measure('control-roundtrip', start, end);});
  diagnostics.setHidden(document.hidden);
  document.addEventListener('contextmenu', appContextMenu);

  byId('tabs-open-primary').addEventListener('click', selectPrimary);
  let navigationFrame = 0;
  // Navigation places observed native views, so geometry writes belong outside resize delivery.
  new ResizeObserver(() => {
    if (!navigationFrame) navigationFrame = requestAnimationFrame(() => {navigationFrame = 0; renderNavigation();});
  }).observe(byId('conversation-panes'));
  matchMedia('(pointer: coarse)').addEventListener('change', renderNavigation);
  for (const id of ['project-button', 'compact-project-button']) byId(id).addEventListener('click', () => picker.openProject(byId(id)));
  byId('commands-button').addEventListener('click', () => actions.palette());
  byId('notifications-button').addEventListener('click', notices);
  byId('appearance-button').addEventListener('click', () => actions.appearance());
  for (const id of ['session-open', 'tabs-open-session']) byId(id).addEventListener('click', () => picker.open(projectPath()));
  byId('session-new').addEventListener('click', () => picker.newSession(projectPath()));
  byId('agent-refresh').addEventListener('click', refreshRoster);
  byId('agent-new').addEventListener('click', () => actions.prepareText('/agent new'));

  byId('agents-heading').addEventListener('click', () => setSidebarSection('agents', !sidebarSections.agents));

  byId('agent-message-close').addEventListener('click', () => closeMessagePanel());
  byId('primary-row').addEventListener('click', selectPrimary);
  byId('sidebar-show').addEventListener('click', () => toggleSidebar(matchMedia('(min-width: 900px)').matches ? byId('sidebar').hidden : !drawerOpen));
  byId('sidebar-close').addEventListener('click', () => toggleSidebar(false));

  document.addEventListener('pointerdown', dismissDrawerPointer, true);
  document.addEventListener('click', consumeDrawerClick, true);
  byId('skip-composer').addEventListener('click', event => { event.preventDefault(); focusEditor(); });

  document.addEventListener('keydown', appKey);
  window.addEventListener('resize', () => { renderNavigation(); for (const controller of controllers.values()) controller.composer.resize(); roster.schedule(); });
  window.addEventListener('beforeunload', event => { if (!(devNavigating&&preparedReloadState?.revision===devInteractionRevision&&preparedReloadState.workspace===state.workspace?.id) && (!filesViews.canDispose || [...controllers.values()].some(controller => !controller.composer.canDispose))) event.preventDefault(); });
  document.addEventListener('visibilitychange', () => {
    diagnostics.setHidden(document.hidden); for (const controller of controllers.values()) controller.transcript.visibilityChanged();
    if (!document.hidden && !uiReady) void finishStartup().catch(showError);
    if (!document.hidden) { threadExplorer.refreshIfStale(); threadReader.refreshIfStale(); picker.writersChanged(); }
  });
  window.addEventListener('focus', () => picker.writersChanged());
}
export function devHold(): DevReloadHold | undefined {
  if (browserControl.applying || selectionQueue.unsettled) return 'input';
  if (composingFields.size) return 'ime';
  if (!connected&&!document.hidden || resynchronizing) return 'offline';
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
  signal.throwIfAborted();await waitForSignal(filesViews.drain(),signal); await waitForSignal(selectionQueue.drain(), signal);
  await waitForSignal(preferences.drain(), signal); signal.throwIfAborted();
  if (selectionQueue.unsettled || preferences.pending || [...controllers.values()].some(controller => controller.composer.reloadHold)) throw new Error('Retained writes changed during the drain.');
  const revision=devInteractionRevision,workspace=state.workspace?.id,key=reloadStateKey??crypto.randomUUID();
  if(!workspace)throw new Error('No workspace owns the preserved draft.');
  const snapshots=[...controllers.values()].flatMap(controller=>controller.composer.captureReload());
  reloadStateKey=key;
  await writeReloadState(key,snapshots,signal);signal.throwIfAborted();
  if(revision!==devInteractionRevision||workspace!==state.workspace?.id)throw new Error('The draft changed during preservation.');
  reloadStateKey=key;preparedReloadState={key,revision,workspace};
}
function devEntry(controller: ConversationController): DevCheckpointEntry {
  const saved = controller.saved; if (!saved || !sameTarget(saved.target, controller.target)) throw new Error('Target preservation metadata is unavailable.');
  const epoch = controller.target.kind === 'agent' ? state.conversations.get(targetIdentity(controller.target))?.connectionEpoch : undefined;
  const retained=controller.target.kind==='agent'&&(!epoch||!Number.isSafeInteger(epoch)||epoch<1);
  const editor = controller.composer.editor;
  return {targetKey: saved.targetKey, target: controller.target.kind === 'primary' ? {...controller.target} : retained?{...controller.target,retained:true}:{...controller.target, connectionEpoch: epoch as number},
    draftRevision: controller.composer.serverDraftRevision ?? saved.draft.revision, imageFingerprint: draftImageFingerprint(controller.composer.state?.draft.images ?? saved.draft.images), readingRevision: saved.reading.revision, presentationRevision: saved.presentation?.revision ?? 0,
    selection: {start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection}};
}
export function captureDevCheckpoint(): ReturnType<DevReloadHooks['captureCheckpoint']> {
  const workspaceId = state.workspace?.id; if (!workspaceId) throw new Error('No workspace is hydrated.');
  const all=[...controllers.values()].filter(controller=>controller.workspaceId===workspaceId);
  const owned = all.filter(controller=>!!controller.saved||!controller.inspection?.active), targets = owned.map(devEntry);
  const inspections=all.flatMap(controller=>{const value=controller.inspection?.checkpoint();return value?[value]:[];});
  const recipient = messageTarget.current;
  const messageRecipient = recipient ? owned.find(controller => controller.target.kind === 'agent' && controller.target.identity === recipient.identity)?.saved?.targetKey : undefined;
  if (recipient && (!messageTarget.valid(recipient) || !messageRecipient)) throw new Error('Message preservation metadata changed.');
  const focused = owned.find(controller => controller.composer.editor === document.activeElement);
  return {workspaceId, focusedPane: currentLayout().focusedPane, targets,...(preparedReloadState?.revision===devInteractionRevision&&preparedReloadState.workspace===workspaceId?{composerStateKey:preparedReloadState.key}:{}),files:filesViews.checkpoint(state.workspace as Workspace),...(inspections.length?{inspections}:{}), ...(messageRecipient ? {messageRecipient} : {}),
    ...(focused?.saved ? {focusedControl: {targetKey: focused.saved.targetKey, kind: focused.saved.targetKey === messageRecipient ? 'message' : 'composer'}} : {})};
}
function devTargetMatches(entry: DevCheckpointEntry, saved: TargetState, preservedDraft=false): boolean {
  if (saved.targetKey !== entry.targetKey || !sameTarget(saved.target, entry.target.kind === 'primary' ? entry.target : {kind: 'agent', identity: entry.target.identity})) return false;
  if (!preservedDraft&&saved.draft.revision !== entry.draftRevision || saved.reading.revision !== entry.readingRevision || (saved.presentation?.revision ?? 0) !== entry.presentationRevision || saved.unconfirmed.length) return false;
  if (!preservedDraft&&entry.imageFingerprint !== draftImageFingerprint(saved.draft.images)) return false;
  if (entry.target.kind === 'primary') return state.primaries.get(entry.target.key)?.epoch === entry.target.epoch;
  if('retained' in entry.target)return true;
  const epoch = state.conversations.get(targetIdentity(saved.target))?.connectionEpoch;
  return !!epoch && Number.isSafeInteger(epoch) && epoch > 0;
}
function devRecordsCurrent(entries: DevCheckpointEntry[], values: TargetState[], preserved:ComposerReloadState[]=[]): boolean {
  return entries.length === values.length && entries.every((entry, index) => {const saved = values[index]; return !!saved && devTargetMatches(entry, saved,preserved.some(value=>value.workspace===state.workspace?.id&&value.targetKey===entry.targetKey));});
}
function devRestoreSourceCurrent(entry: DevCheckpointEntry, preserved=false): boolean {
  const target: Target = entry.target.kind === 'primary' ? entry.target : {kind: 'agent', identity: entry.target.identity};
  const saved = targetState(target); if (saved && !devTargetMatches(entry, saved,preserved)) return false;
  const controller = controllers.get(controllerKey(state.workspace?.id ?? '', target));
  return !controller || !controller.composer.unsaved && (preserved||(controller.composer.serverDraftRevision ?? entry.draftRevision) === entry.draftRevision);
}
async function readPreservedComposers(checkpoint:DevReloadCheckpoint,signal:AbortSignal):Promise<ComposerReloadState[]> {
  if(!checkpoint.composerStateKey)return [];
  const value=await readReloadState(checkpoint.composerStateKey,signal);
  if(!Array.isArray(value)||value.length>LIMITS.conversationTabs||!value.every(validComposerReloadState)||new Set(value.map(item=>JSON.stringify([item.workspace,item.targetKey]))).size!==value.length)throw new Error('Preserved draft bytes are unavailable.');
  for(const entry of checkpoint.targets){const target=entry.target;
    if(target.kind==='agent'&&'retained' in target&&!checkpoint.inspections?.some(item=>item.identity===target.identity)&&!value.some(item=>item.workspace===checkpoint.workspaceId&&item.targetKey===entry.targetKey&&sameTarget(item.target,target)))throw new Error('The preserved Agent target is unavailable.');}
  return value;
}
export function currentPreservedTarget(saved:TargetState,preserved:ComposerReloadState[],workspace:string):TargetState {
  const current=state.targets.get(saved.targetKey);
  return workspace===state.workspace?.id&&current&&current.draft.revision>saved.draft.revision&&preserved.some(value=>value.workspace===workspace&&value.targetKey===saved.targetKey)?{...saved,draft:current.draft}:saved;
}
async function restorePreservedComposers(values:ComposerReloadState[],acknowledged:TargetState[],signal:AbortSignal,current:()=>boolean):Promise<boolean> {
  const saved:TargetState[]=[];
  for(const value of values){
    const existing=value.workspace===state.workspace?.id?acknowledged.find(saved=>saved.targetKey===value.targetKey):undefined;
    const target=existing??await request<TargetState>(`/api/workspaces/${encodeURIComponent(value.workspace)}/targets/${encodeURIComponent(value.targetKey)}`,'GET',undefined,undefined,signal);
    if(!current()||target.targetKey!==value.targetKey||!sameTarget(target.target,value.target))return false;
    saved.push(target);
  }
  if(!current())return false;
  for(const [index,value] of values.entries()){
    const captured=saved[index];if(!captured)return false;const target=currentPreservedTarget(captured,values,value.workspace);
    if(value.workspace===state.workspace?.id)state={...state,targets:new Map(state.targets).set(target.targetKey,target)};
    const controller=conversationController(target.target,value.workspace);controller.saved=target;controller.composer.restoreReload(value,target);
  }
  return current();
}
async function restoreDevRecipient(checkpoint: DevReloadCheckpoint, values: TargetState[], signal: AbortSignal): Promise<boolean> {
  if (!checkpoint.messageRecipient) return !messageTarget.current;
  const recipient = values.find(saved => saved.targetKey === checkpoint.messageRecipient); if (recipient?.target.kind !== 'agent') return false;
  await waitForSignal(messageTarget.open(recipient.target.identity), signal);
  const captured = messageTarget.current;
  return !!captured && messageTarget.valid(captured) && captured.prepared?.targetState.targetKey === checkpoint.messageRecipient;
}
async function restoreDevReading(owned: ConversationController[], signal: AbortSignal, current: () => boolean, checkpoint:DevReloadCheckpoint): Promise<boolean> {
  for (const controller of owned) {
    if(checkpoint.targets.some(entry=>entry.targetKey===controller.saved?.targetKey&&entry.target.kind==='agent'&&'retained' in entry.target))continue;
    const reading = controller.saved?.reading;
    if (controller.root.hidden || !reading?.anchorId || reading.followTail) continue;
    await waitForSignal(loadControllerHistory(controller), signal);
    if (!current() || !controller.historyReady || !state.conversations.get(targetIdentity(controller.target))?.entries.has(reading.anchorId)) return false;
  }
  return current();
}
export function restoredDevSelection(entry:DevCheckpointEntry,text:string,revision:number|undefined,preserved:ComposerReloadState[]):DevCheckpointEntry['selection'] {
  const captured=preserved.find(value=>value.workspace===state.workspace?.id&&value.targetKey===entry.targetKey);
  return captured&&captured.data.text!==text&&entry.draftRevision!==revision?undefined:entry.selection;
}
function restoreDevControls(checkpoint: DevReloadCheckpoint, owned: ConversationController[],preserved:ComposerReloadState[]): boolean {
  const ranges=checkpoint.targets.map((entry,index)=>{const controller=owned[index];return controller?restoredDevSelection(entry,controller.composer.editor.value,controller.composer.serverDraftRevision,preserved):entry.selection;});
  if (ranges.some((selection,index) => !!selection && (!owned[index] || selection.end > (owned[index]?.composer.editor.value.length ?? 0)))) return false;
  const control = checkpoint.focusedControl, focused = control ? owned.find(controller => controller.saved?.targetKey === control.targetKey) : undefined;
  if (control && (!focused?.elements.root.isConnected || focused.elements.root.closest('[hidden],[inert]') || control.kind === 'message' && control.targetKey !== checkpoint.messageRecipient)) return false;
  for (const [index, controller] of owned.entries()) {const selection = ranges[index]; if (selection) controller.composer.restoreRange(selection);}
  focused?.composer.editor.focus({preventScroll: true}); return true;
}
export async function restoreDevCheckpoint(checkpoint: DevReloadCheckpoint, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || devRestoreOwner) return false;
  const owner = {}; devRestoreOwner = owner;
  const release = () => {if (devRestoreOwner === owner) devRestoreOwner = undefined;};
  signal.addEventListener('abort', release, {once: true});
  try {return await restoreDevState(checkpoint, signal, owner);}
  finally {signal.removeEventListener('abort', release); release();}
}
async function restoreDevState(checkpoint: DevReloadCheckpoint, signal: AbortSignal, owner: object): Promise<boolean> {
  const revision = devInteractionRevision, connection = source;
  const original = () => {
    if (signal.aborted || devRestoreOwner !== owner || !connection || source !== connection || !connected || document.hidden || revision !== devInteractionRevision || checkpoint.workspaceId !== state.workspace?.id || devHold()) return false;
    const layout = currentLayout();
    return layout.focusedPane === checkpoint.focusedPane && !!paneById(layout, checkpoint.focusedPane);
  };
  const epochs = new Map<string, number | undefined>(checkpoint.targets.flatMap(entry => entry.target.kind === 'agent' && 'connectionEpoch' in entry.target && !('retained' in entry.target) ? [[entry.target.identity, undefined] as const] : []));
  const epochFor = (identity: string) => {
    const epoch = state.conversations.get(targetIdentity({kind: 'agent', identity}))?.connectionEpoch;
    return epoch !== undefined && Number.isSafeInteger(epoch) && epoch > 0 ? epoch : undefined;
  };
  const pinned = () => [...epochs].every(([identity, epoch]) => epoch === undefined || epochFor(identity) === epoch);
  const readiness = (): boolean | undefined => {
    if (!original() || !pinned()) return false;
    for (const [identity, epoch] of epochs) if (epoch === undefined) epochs.set(identity, epochFor(identity));
    return [...epochs.values()].every(epoch => epoch !== undefined) ? true : undefined;
  };
  const ready = readiness();
  if (ready === false) return false;
  if (ready === undefined && !await new Promise<boolean>(resolve => {
    const finish = (value: boolean) => {
      if (devRestoreWake === wake) devRestoreWake = undefined;
      signal.removeEventListener('abort', abort); resolve(value);
    };
    const wake = () => {const value = readiness(); if (value !== undefined) finish(value);};
    const abort = () => finish(false);
    devRestoreWake = wake; signal.addEventListener('abort', abort, {once: true}); wake();
  })) return false;
  const current = () => original() && [...epochs].every(([identity, epoch]) => epoch !== undefined && epochFor(identity) === epoch);
  const preserved=checkpoint.composerStateKey?await readPreservedComposers(checkpoint,signal):[];
  if (!current()) return false;
  let savedTargets = await Promise.all(checkpoint.targets.map(entry => request<TargetState>(
    `/api/workspaces/${encodeURIComponent(checkpoint.workspaceId)}/targets/${encodeURIComponent(entry.targetKey)}`, 'GET', undefined, undefined, signal)));
  if (!current() || !devRecordsCurrent(checkpoint.targets, savedTargets,preserved)) return false;
  if (!checkpoint.targets.every(entry=>devRestoreSourceCurrent(entry,preserved.some(value=>value.workspace===checkpoint.workspaceId&&value.targetKey===entry.targetKey)))) return false;
  savedTargets=savedTargets.map(saved=>currentPreservedTarget(saved,preserved,checkpoint.workspaceId));
  const owned = savedTargets.map(saved => {state = {...state, targets: new Map(state.targets).set(saved.targetKey, saved)}; const controller = conversationController(saved.target); controller.saved = saved; return controller;});
  if (!await restoreDevRecipient(checkpoint, savedTargets, signal) || !current()) return false;
  if(!restoreDevInspections(checkpoint))return false;
  renderAll(); if (!await restoreDevReading(owned, signal, current, checkpoint)) return false;
  if (!state.workspace || !await waitForSignal(filesViews.restore(state.workspace,checkpoint.files ?? [],current),signal) || !current()) return false;
  return finishDevRestore(checkpoint,owned,savedTargets,preserved,signal,current);
}
async function finishDevRestore(checkpoint:DevReloadCheckpoint,owned:ConversationController[],savedTargets:TargetState[],preserved:ComposerReloadState[],signal:AbortSignal,current:()=>boolean):Promise<boolean> {
  if(preserved.length){if(!await restorePreservedComposers(preserved,savedTargets,signal,current)||!current())return false;renderAll();}
  const refreshed=savedTargets.flatMap(saved=>{const value=targetState(saved.target);return value?[value]:[];});
  return current()&&devRecordsCurrent(checkpoint.targets,refreshed,preserved)&&restoreDevControls(checkpoint,owned,preserved)&&current();
}
function restoreDevInspections(checkpoint:DevReloadCheckpoint):boolean {
  const tabs=paneLeaves(currentLayout().root).flatMap(pane=>pane.tabs).filter(tab=>tab.kind==='agent');
  for(const value of checkpoint.inspections??[]){if(!tabs.some(tab=>tab.identity===value.identity))return false;
    if(!conversationController({kind:'agent',identity:value.identity}).inspection?.restore(value))return false;}
  return true;
}
let cssState: Array<{controller: ConversationController; geometry: ReturnType<Transcript['captureGeometry']>; inspectionTop?:number}> = [];
export function captureDevCssState(): unknown {
  cssState = [...controllers.values()].filter(controller => controller.workspaceId === state.workspace?.id && !controller.root.hidden && !controller.root.inert).map(controller => ({controller, geometry: controller.transcript.captureGeometry(),...(controller.inspection?.active?{inspectionTop:controller.inspection.scroller.scrollTop}:{})})); return cssState;
}
export function applyDevCssState(captured: unknown): void {
  if (captured !== cssState) return; refreshPaneSizes();
  for (const {controller, geometry,inspectionTop} of cssState) {controller.transcript.applyGeometry(geometry); controller.composer.resize();if(controller.inspection&&inspectionTop!==undefined)controller.inspection.scroller.scrollTop=inspectionTop;}
}
let uiReady = false;
async function finishStartup(): Promise<void> {
  const connection = source,current = ()=>!!connection && connection === source && connected && !document.hidden;
  if (!current()) return;
  await initializeDevReload(current);
  if (uiReady || !current()) return;
  uiReady = true; document.dispatchEvent(new Event('ui-ready')); renderNavigation();
}
async function initializeDevReload(current:()=>boolean): Promise<void> {
  if (devReload) {await devReload.ready; if (!current()) return; devReload.reconnect(); await devReload.resume(); return;}
  const notice = element('span', 'secondary workbench-update'); notice.setAttribute('role', 'status');
  devReload = new DevReload({interaction: () => {const reason = devHold(); return {revision: devInteractionRevision, safe: !reason, ...(reason ? {reason} : {})};}, drain: drainDev,
    captureCheckpoint: captureDevCheckpoint, writeCheckpoint: checkpoint => sessionStorage.setItem(devCheckpointKey, JSON.stringify(checkpoint)),
    readCheckpoint: () => {const value = sessionStorage.getItem(devCheckpointKey);if(value===null)return null;const checkpoint=JSON.parse(value);reloadStateKey=checkpoint?.composerStateKey;return checkpoint;}, restoreCheckpoint: restoreDevCheckpoint, clearCheckpoint: () => {sessionStorage.removeItem(devCheckpointKey);const key=reloadStateKey;reloadStateKey=undefined;preparedReloadState=undefined;if(key)void deleteReloadState(key).catch(()=>{});},
    captureCssState: captureDevCssState, afterCssApply: applyDevCssState,
    status: status => renderDevReloadNotice(notice, status)});
  await devReload.ready;
}
export function renderDevReloadNotice(notice: HTMLElement, status: DevReloadNotice): void {
  devNavigating = status.state === 'navigating'; notice.replaceChildren();
  const view = devReloadPresentation(status); notice.hidden = !view.text && !view.retry; notice.title = view.detail;
  if (status.error) notice.dataset.reloadError = JSON.stringify(status.error); else delete notice.dataset.reloadError;
  // A retry never stands alone: the sentence it acts on shares its container, and the technical detail stays in the title.
  if (view.text) notice.append(element('span', undefined, view.retry ? `${view.text}.` : view.text));
  if (view.retry) notice.append(button('Retry update', () => {if (status.state === 'offline') devReload?.reconnect(); void devReload?.resume();}));
  if (!notice.isConnected) workbenchStatus.node.append(notice);
}
function updateDiagnostics(): void {
  const generation = document.querySelector('meta[name="ui-generation"]')?.getAttribute('content') ?? '', client = document.querySelector('meta[name="ui-client"]')?.getAttribute('content') ?? '';
  const active = /^[a-f0-9]{64}$/.test(generation) && /^[a-f0-9]{24}$/.test(client);
  if (active !== diagnosticsActive) {diagnosticsActive = active; diagnostics.setActive(active);}
}
async function bootstrap(signal?: AbortSignal): Promise<void> {
  const workspace = new URL(location.href).searchParams.get('workspace');
  const read = <T>(path: string, method = 'GET', body?: unknown) => request<T>(path, method, body, undefined, signal && (method === 'GET' ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : signal));
  const pending = read<Bootstrap>(`/api/bootstrap${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`).then(value => hydrateVisible(value, read));
  const data = await (signal ? waitForSignal(pending, signal) : pending); signal?.throwIfAborted();
  snapshot = data; launchCwd = data.launchCwd; state = replaceSnapshot(state, data); updateDiagnostics();
  const url = new URL(location.href); url.searchParams.set('workspace', data.workspace.id); history.replaceState(null, '', url);
}
async function start(): Promise<void> {
  bind(); renderNavigation();
  try {
    await refreshVisible(bootstrap, loadVisibleHistory, showError);
    renderAll(); await stream(); connectionRecovery.healthy();
  } catch (error) {
    connectionRecovery.lost(error);
  }
}
void start();
