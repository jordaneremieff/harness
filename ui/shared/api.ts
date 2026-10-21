import type {FileChanges} from './files.ts';
/** The bootstrap module family identifies exact immutable module, document and favicon bytes, excluding CSS. */
export type DevLeaseIdentity = {client:string;generation:string;cssGeneration:string;family:string};
/** Browser/backend contract. This module has no runtime or platform imports. */
export const LIMITS = {
  requestBytes: 128 * 1024, textBytes: 64 * 1024, displayBytes: 256 * 1024,
  pageBytes: 64 * 1024, pageItems: 100, pathChars: 4096, idChars: 256,
  cursorBytes: 4096, primaryBytes: 8 * 1024 * 1024, rosterBytes: 8 * 1024 * 1024,
  rosterRows: 2048, identityLookup: 16, agentCacheBytes: 1024 * 1024, primaries: 4, workspaces: Number.MAX_SAFE_INTEGER,
  targets: 128, draftPreviewChars: 240, rpcPending: 64, hostPending: 32, workspaceReservations: 16,
  operations: 2048, unconfirmed: 128, journalEvents: 4096,
  sidebarWidthMin: 200, sidebarWidthMax: 480, conversationTabs: 128,
  journalBytes: 8 * 1024 * 1024, clientQueueBytes: 512 * 1024, eventClients: 8,
  reservationMs: 10 * 60 * 1000, jsonDepth: 8, jsonNodes: 2048,
  imagesPerDraft: 4, imageBytes: 8 * 1024 * 1024, draftImageBytes: 8 * 1024 * 1024,
  imagePixels: 16_777_216, imageEdge: 8192, imageNameCodePoints: 240,
  imageBase64Bytes: Math.floor(11.2 * 1024 * 1024), inputFrameBytes: 12 * 1024 * 1024,
  blobStoreBytes: 256 * 1024 * 1024, imageUploads: 2, imageReceiveMs: 30_000,
  imageLeaseMs: 10 * 60 * 1000, stagedImages: 128, stagedImagesPerTarget: 16,
  blobEntries: 1024, agentPendingBytes: 16 * 1024 * 1024, imagePreparations: 1,
  preparedInputBytes: 12 * 1024 * 1024, textFileBytes: 32 * 1024,
  fileTextBytes: 1024 * 1024, fileResponseBytes: 6 * 1024 * 1024 + 64 * 1024,
  fileDirectoryEntries: 4096, fileScanBytes: 1024 * 1024, filePageItems: 200,
  fileRoots: 128, filePending: 16, fileReadMs: 15_000,
  fileWatchDirectories: 128, fileWatchHandles: 256, fileWatchFiles: 512,
  fileChangePaths: 128, fileChangeBytes: 32 * 1024, fileWatchCoalesceMs: 100,
} as const;
/** Exact target captured before dispatch. Epochs never transfer drafts. */
export type Target = {kind: 'primary'; key: string; epoch: number} | {kind: 'agent'; identity: string};
export type JsonDisplay = {value: unknown; truncated: boolean; omittedBytes?: number};
export type Retry = 'none' | 'read' | 'same-operation' | 'manual';
/** Bounded public error. Never includes stacks or raw upstream objects. */
export type ErrorView = {code: string; message: string; retry: Retry; operationId?: string; target?: Target; details?: JsonDisplay};
export type Success<T> = {ok: true; data: T};
export type Failure = {ok: false; error: ErrorView};
export type ApiResult<T> = Success<T> | Failure;
export type DisplayCoverage = {complete: boolean; truncated: boolean; omitted: number; reason?: string};
export type OutputContinuation = {entryId: string; part: number; offset: number};
export type OutputPage = {entryId: string; part: number; text: string; nextOffset: number | null; totalBytes: number};
export type ImageSource = {entryId: string; message: number; part: number};
/** Raster metadata only; the same-origin image route supplies bytes on demand. */
export type ImageView = {type: 'image'; mimeType: 'image/png' | 'image/jpeg'; digest: string;
  bytes: number; width: number; height: number; alt: string; source?: ImageSource;
  attachment?: {workspaceId: string; targetKey: string}};
/** Supplied output metadata only; a full-output path is inert text, not an access link. */
export type ToolOutputInfo = {truncation?: {truncated: true; truncatedBy?: 'lines' | 'bytes';
  totalLines?: number; outputLines?: number; totalBytes?: number; outputBytes?: number;
  maxLines?: number; maxBytes?: number; lastLinePartial?: true; firstLineExceedsLimit?: true}; fullOutputPath?: string};
export type PartView = {type: 'text'; text: string; redacted?: boolean; more?: OutputContinuation; structured?: JsonDisplay} |
  {type: 'thinking'; text: string; redacted?: boolean; more?: OutputContinuation} |
  {type: 'toolCall'; callId: string; name: string; arguments: JsonDisplay; argumentsError?: string} |
  {type: 'toolResult'; callId: string; name: string; parts: PartView[]; isError: boolean; output?: ToolOutputInfo} |
  ImageView | {type: 'omitted'; label: string};
/** Supplied input-token counts for one assistant message; absent usage is unknown. */
export type AssistantUsage = {input: number; cacheRead: number; cacheWrite: number};
/** Producer-supplied communication facts, not authenticated instruction authority. */
export type CommunicationBody = {text: string; complete: boolean; redacted: boolean};
export type CommunicationSender = {identity: string; name?: string; kind?: 'agent' | 'session'};
export type CommunicationReference = {submissionId: number; requestId?: string; entryId?: string; answerEntryId?: string};
type CommunicationBase = {format: 'agent.communication/1'; sender: CommunicationSender; body: CommunicationBody; recordedAt: number};
export type Communication = CommunicationBase & (
  {kind: 'notice'; metadata: {threadId: string; event?: number; frameRevision?: number; eventKind?: string; title?: string; passive?: boolean}} |
  {kind: 'report'; metadata: {sourceId: string; requestId: string; replyTo?: string}} |
  {kind: 'result'; metadata: {status: 'done' | 'unanswered'; references: CommunicationReference[]; omittedReferences: number; reason?: string}} |
  {kind: 'check-in'; metadata: {sourceId: string; producerRequestId: string; elapsedMs: number; origin: 'operator' | 'model'}});
export type CommunicationInputLink = {mode: 'input'; storageId: string; conversationId: number; entryId: string; submissionId: number; requestId: string};
export type CommunicationPassiveLink = {mode: 'passive'; storageId: string; conversationId: number; entryId: string; requestId: string};
export type NativeOrigin = {kind: 'native'; recordEntryId: string; target: CommunicationInputLink | CommunicationPassiveLink};
export type OrdinaryOrigin = {kind: 'ordinary-custom'; customType: 'agent.peer'; renderEntryId: string; sourceEntryId?: string};
export type CommunicationPresentation = {state: 'ready'; origin: NativeOrigin | OrdinaryOrigin; value: Communication; rawDetails?: JsonDisplay} |
  {state: 'unresolved'} | {state: 'unavailable'; reason: 'limit' | 'invalid'};
/** Stable adapter ID, not an array index. Final messages replace partial messages. */
export type MessageView = {id: string; role: string; timestamp?: number; parts: PartView[];
  state: 'partial' | 'final'; stopReason?: string; error?: string; coverage: DisplayCoverage; usage?: AssistantUsage; communication?: CommunicationPresentation;
  attachments?: {part: number; start: number; end: number; image: ImageView}[]};
/** A native nested task is not a model-issued message. Its status and links come from the host. */
export type NestedToolView = {callId: string; name: string; taskId: number; parentTaskId: number; parentCallId: string;
  status: 'pending' | 'running' | 'done'; arguments: JsonDisplay; parts?: PartView[]; isError?: boolean;
  durationMs?: number; output?: ToolOutputInfo; coverage: DisplayCoverage};
export type TaskSender = {identity: string; name?: string};
export type EntryView = {id: string; kind: string; sender?: TaskSender; messages?: MessageView[]; data?: JsonDisplay; head?: string; tool?: NestedToolView};
export type ModelChoice = {provider: string; id: string; name: string; reasoning: boolean; input: string[]; thinkingLevels?: string[]};
export type CommandView = {name: string; description: string; source: 'extension' | 'skill' | 'prompt'};
export type DialogView = {id: string; method: 'select' | 'confirm' | 'input' | 'editor'; title: string;
  options?: string[]; optionKeys?: string[]; message?: string; placeholder?: string; prefill?: string; deadline?: string};
export type ExtensionState = {method: 'notify'; message: string; notifyType: string} |
  {method: 'setStatus'; statusKey: string; statusText?: string} |
  {method: 'setWidget'; widgetKey: string; widgetLines?: string[]; widgetPlacement?: string} |
  {method: 'setTitle'; title: string} | {method: 'set_editor_text'; text: string};
export type ResponseOutcome = 'failed' | 'stopped';
export type GenerationRetry = {attempt: number; at: number; error: string};
export type PrimaryRetry = GenerationRetry & {maxAttempts: number; delayMs: number};
/** Public provider-limit evidence, separate from admission and connection state. */
export type ProviderBlock = {blockId: string; conversationId: number; providerSessionId: string; epoch: number;
  model: {provider: string; modelId: string}; error: string; errorRedacted: boolean; errorTruncated: boolean;
  source: 'provider' | 'host-block'; timestamp: number; originalResults: {sessionId: string; submissionId: number; requestId?: string}[]; omittedOriginalResults: number};
/** Public process state. Stderr is available only through diagnostics. */
export type PrimaryView = {key: string; epoch: number; cwd: string;
  lifecycle: 'starting' | 'ready' | 'switching' | 'stopping' | 'stopped' | 'failed';
  activity: 'unknown' | 'idle' | 'running' | 'compacting' | 'retrying';
  sessionId?: string; sessionFile?: string; sessionName?: string; pid?: number;
  model?: ModelChoice; thinkingLevel?: string; pendingOperationIds: string[];
  contextUsage?: {tokens: number | null; contextWindow: number; percent: number | null};
  usage?: {tokens: {input: number; output: number; cacheRead: number; cacheWrite: number; total: number}; cost: number};
  pendingDialogs: DialogView[]; lastError?: ErrorView; capabilities: Record<string, boolean>;
  retry?: PrimaryRetry; responseOutcome?: ResponseOutcome;
  extension?: {title?: string; statuses: Record<string, string>; widgets: Record<string, {lines: string[]; placement?: string}>};
};
export const APPEARANCES = ['dark', 'light', 'system'] as const;
export type Appearance = typeof APPEARANCES[number];
/** Earlier builds stored four more names. They read as the mode they looked like; the saved value stays as stored until a new choice. */
const storedAppearances: Readonly<Record<string, Appearance>> = {latte: 'light', frappe: 'dark', macchiato: 'dark', mocha: 'dark'};
/** Any stored or unknown appearance value becomes one of the three current choices; unknown values follow the OS. */
export function resolveAppearance(value: unknown): Appearance {
  if (typeof value !== 'string') return 'system';
  if ((APPEARANCES as readonly string[]).includes(value)) return value as Appearance;
  return Object.hasOwn(storedAppearances, value) ? storedAppearances[value] as Appearance : 'system';
}
/** Primary tabs follow the workspace primary; closing a tab never stops its conversation. */
export type ConversationTab = {kind: 'primary'} | {kind: 'agent'; identity: string};
export type FileTab = {kind: 'file'; rootId: string; path: string; view?: 'preview'};
/** A saved session place: a read-only view of one session file. Extra fields, such as the stored reading position, round-trip unchanged. */
export type SessionTab = {kind: 'session'; id: string; path: string; project: string; [field: string]: unknown};
export type WorkspaceTab = ConversationTab | FileTab | SessionTab;
export const LAYOUT_VERSION = 1;
export const LAYOUT_VERSION_HEADER = 'X-UI-Layout-Version';
function layoutScalar(value:unknown):boolean {return value===null||typeof value==='boolean'||typeof value==='string'||typeof value==='number'&&Number.isFinite(value);}
function layoutContainer(value:object):boolean {
  const prototype=Object.getPrototypeOf(value);
  return Array.isArray(value)?prototype===Array.prototype:prototype===Object.prototype||prototype===null;
}
function layoutKeysBound(value:object,keys:PropertyKey[],remaining:number):boolean {
  return keys.length<=remaining&&(!Array.isArray(value)||keys.length===value.length+1);
}
/** Opaque view metadata must remain bounded plain JSON, never executable properties. */
export function validLayoutData(value: unknown): boolean {
  let nodes = 0;
  const active = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > LIMITS.jsonNodes || depth > LIMITS.jsonDepth) return false;
    if(item===null||typeof item!=='object')return layoutScalar(item);
    if(active.has(item)||!layoutContainer(item))return false;
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(item);
    if(!layoutKeysBound(item,keys,LIMITS.jsonNodes-nodes+1))return false;
    active.add(item);
    const valid = keys.every(key => {
      if (Array.isArray(item) && key === 'length') return true;
      const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
      return typeof key === 'string' && !!descriptor?.enumerable && Object.hasOwn(descriptor,'value') && visit(descriptor.value,depth+1);
    });
    active.delete(item);return valid;
  };
  return visit(value,0) && new TextEncoder().encode(JSON.stringify(value)).length <= LIMITS.requestBytes;
}
export function validSessionTab(value: unknown): value is SessionTab {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tab = value as Record<string,unknown>;
  return tab.kind === 'session' && ['id','path','project'].every(key => typeof tab[key] === 'string' && !!tab[key] && (tab[key] as string).length <= (key === 'id' ? LIMITS.idChars : LIMITS.pathChars) && !/[\u0000-\u001f\u007f]/.test(tab[key] as string)) && (tab.path as string).startsWith('/') && (tab.project as string).startsWith('/') && validLayoutData(tab);
}
/** Known routing fields remain strict; additional inert fields round-trip unchanged. */
export function validWorkspaceTab(value: unknown): value is WorkspaceTab {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validLayoutData(value)) return false;
  const tab = value as Record<string,unknown>;
  if (tab.kind === 'session') return validSessionTab(tab);
  if (tab.kind === 'primary') return true;
  if (tab.kind === 'agent') return typeof tab.identity === 'string' && !!tab.identity && tab.identity.length <= LIMITS.idChars && !/[\u0000-\u001f\u007f]/.test(tab.identity);
  return tab.kind === 'file' && validFileTab({kind:'file',rootId:tab.rootId,path:tab.path,...(tab.view === undefined ? {} : {view:tab.view})});
}
export function validFileTab(value: unknown): value is FileTab {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tab = value as FileTab;
  if ((Object.keys(tab).length !== (tab.view === 'preview' ? 4 : 3)) || Object.keys(tab).some(key=>!['kind','rootId','path','view'].includes(key)) || tab.view !== undefined && tab.view !== 'preview' || tab.kind !== 'file' || typeof tab.rootId !== 'string' || !tab.rootId || tab.rootId.length > LIMITS.idChars || typeof tab.path !== 'string' || !tab.path || tab.path.length > LIMITS.pathChars || /[\\\\\u0000-\u001f\u007f]|%2f|%5c|%2e/i.test(tab.path) || /[\ud800-\udfff]/u.test(tab.path.replace(/[\ud800-\udbff][\udc00-\udfff]/g,''))) return false;
  const parts = tab.path.split('/');
  return parts.length <= 128 && parts.every(part=>!!part && part !== '.' && part !== '..' && !['.git','.hg','.svn','.bzr'].includes(part));
}
export function workspaceTabKey(tab: WorkspaceTab): string {
  return tab.kind === 'session' ? `session:${JSON.stringify([tab.id,tab.path,tab.project])}` : tab.kind === 'file' ? `${tab.view === 'preview' ? 'preview' : 'file'}:${JSON.stringify([tab.rootId, tab.path])}` : tab.kind === 'primary' ? 'primary' : `agent:${tab.identity}`;
}
export type FilePosition = {scrollTop: number; scrollLeft: number};
export type PaneNode = {kind: 'pane'; id: string; tabs: WorkspaceTab[]; active: string | null} |
  {kind: 'split'; id: string; axis: 'x' | 'y'; ratio: number; first: PaneNode; second: PaneNode};
export type ConversationLayout = {root: PaneNode; focusedPane: string};
/** Shared tabs use compare-and-set revisions for view state. */
export type Workspace = {id: string; revision: number; layoutVersion?: number; primaryKey?: string; selectedTarget?: Target;
  panelVisible?: boolean; sidebarVisible?: boolean; sidebarWidth?: number; appearance?: Appearance; enterSendsMessages?: boolean; agentControl?: boolean;
  conversationLayout?: ConversationLayout; filePositions?: Record<string, FilePosition>};
export function validAgentViews(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= LIMITS.identityLookup && new Set(value).size === value.length && value.every(identity=>typeof identity === 'string' && identity.length > 0 && identity.length <= 256 && !/[\u0000-\u001f\u007f]/.test(identity));
}
export type WorkspaceSummary = {id: string; name: string; lastUsedAt?: string; archivedAt?: string; tabCount: number};
export type WorkspacePage = {items: WorkspaceSummary[]; nextCursor: string | null; total: number};
export type DraftImage = {digest: string; mimeType: 'image/png' | 'image/jpeg'; bytes: number; width: number; height: number; name: string};
export type DraftTuple = {text: string; mode: string; images: DraftImage[]};
export type QueueRecovery = {clearOperationId: string; mode: 'steer' | 'followUp'; index: number};
export type RecoveryOrigin = {clearOperationId: string; recoveryOperationId: string};
export type RecoverySendGuard = {state: 'clear' | 'blocked' | 'unavailable'; imageCopies: number};
export type StoredDraft = {revision: number; text: string; mode: string; persisted: true; images: DraftImage[]; recoveryOrigin?: RecoveryOrigin};
export type DraftView = Omit<StoredDraft, 'images'> & {images: DraftImage[]; recoverySendGuard?: RecoverySendGuard};
export type DraftPut = {expectedRevision: number; text: string; mode: string; images?: DraftImage[]; recoverySource?: string};
export type ImageUploadView = {targetKey: string; target: Target; image: DraftImage; leaseExpiresAt: string};
export type DraftImageAvailability = {digest: string; state: 'ready' | 'unavailable'; reason?: string};
export function draftImageFingerprint(images: readonly DraftImage[]): string {
  return JSON.stringify(images.map(image => [image.digest, image.mimeType, image.bytes, image.width, image.height, image.name]));
}
export function sameDraftImages(a: readonly DraftImage[], b: readonly DraftImage[]): boolean { return draftImageFingerprint(a) === draftImageFingerprint(b); }
export function sameDraftTuple(a: DraftTuple, b: DraftTuple): boolean { return a.text === b.text && a.mode === b.mode && sameDraftImages(a.images, b.images); }
export function draftHasContent(value: Pick<DraftTuple, 'text' | 'images'>): boolean { return !!value.text.length || !!value.images.length; }
export type ReadingView = {revision: number; anchorId: string | null; offsetPx: number; followTail: boolean};
export type TranscriptView = 'chronological' | 'grouped';
/** A reader's deliberate Show thinking or Hide thinking choice; the stored showThinking flag alone is not one. */
export type ThinkingChoice = 'shown' | 'hidden';
export type PresentationView = {revision: number; expanded: string[]; showThinking: boolean; thinking?: ThinkingChoice; transcriptView?: TranscriptView};
export type InputCopy = {operationId: string; target: Target; text: string; mode: string; images: DraftImage[];
  submittedDraftRevision: number; createdAt: string; reason: string; textTruncated?: true;
  queueRecovery?: QueueRecovery; recoveryOrigin?: RecoveryOrigin; differentMessage?: true};
export type UnconfirmedInput = InputCopy & {sendGuard?: RecoverySendGuard};
export type RetainedAdmission = 'queued-image' | 'handled-image' | 'refused';
export type RetainedInput = InputCopy & ({admission: 'queued-image' | 'handled-image'; receipt: NonNullable<OperationView['receipt']>} | {admission: 'refused'; error?: ErrorView});
export type RecoveryInput = (UnconfirmedInput & {admission: 'unconfirmed'}) | RetainedInput;
export type TargetIndex = {targetKey: string; target: Target; draftRevision: number; hasDraft: boolean; draftPreview?: string; draftPreviewTruncated?: boolean; unconfirmedOperationIds: string[]; retainedInputOperationIds: string[]};
export type TargetState = {targetKey: string; target: Target; draft: DraftView; reading: ReadingView;
  unconfirmed: UnconfirmedInput[]; retainedInputs: RetainedInput[]; imageAvailability: DraftImageAvailability[]; imageStorageError?: ErrorView; recoveryPreviewTruncated?: true; presentation?: PresentationView};
export type TargetPreparation = {targetState: TargetState; availability: 'live' | 'stored' | 'unavailable' | 'incompatible';
  capabilities: AgentCapabilities; reason?: string};
export type AgentCapabilities = {history: boolean; observe: boolean; input: boolean; abort: boolean; configure: boolean; inspect?: boolean; images?: boolean; commands?: boolean};
/** The commands one live agent host installed, flattened for the slash list. Each item names the host contribution that supplies it. */
export type AgentCommandList = {items: {name: string; description: string; source: string}[]; incomplete: boolean};
/** The most a command result keeps; a longer result is cut and says so. */
export const COMMAND_RESULT_BYTES = 16 * 1024;
/** Published metadata and claim state, not an assertion of fresh native idle state. */
export type AgentRow = {identity: string; storageId: string; cwd: string; name?: string; handle?: string; role?: string;
  modifiedAt: number; state: string; owner: 'here' | 'unavailable' | 'unknown';
  availability: 'live' | 'stored' | 'unavailable' | 'incompatible';
  model?: {provider: string; modelId: string; thinkingLevel?: string};
  thinkingLevel?: string; latestReply?: string; firstMessage?: string; error?: string;
  currentTool?: {name: string; argument: string}; partial: boolean; observedAt?: string;
  ownerLabel?: string; capabilities?: AgentCapabilities;
  attention?: {kind: 'provider-blocked' | 'task-blocked' | 'failed-turn'; reason?: 'missing_task' | 'task_too_old' | 'migration_failed' | 'restart_limit'};
  publishedRetry?: {attempt: number; maxAttempts: number; delayMs: number; error: string}};
export type ScanView = {state: 'not-started' | 'running' | 'ready' | 'failed'; complete: boolean;
  visited: number; skipped: number; omitted: number; scanId?: string};
export type CachedRoster = {rows: AgentRow[]; nextCursor?: string | null; observedAt?: string; scan: ScanView; stale: boolean; error?: ErrorView};
export type ProjectedFrame = {revision: number; attachmentRevision?: number; observedAt: string; entries: EntryView[]; live: EntryView[];
  nextBefore: number | null; status: {busy: boolean; name?: string; model?: {provider: string; modelId: string};
  thinkingLevel?: string; lastText?: string; tasks?: JsonDisplay; submissions?: JsonDisplay;
  tools?: {callId:string;name:string;status:'pending'|'running'|'done'}[]; toolsOmitted?:number;
  compactions?: JsonDisplay; compactionFailure?: JsonDisplay; retry?: GenerationRetry; providerBlock?: ProviderBlock}; coverage: DisplayCoverage};
export type ConfigurationReceipt = {kind: 'configuration'; identity: string; outcome: 'applied' | 'failed';
  after: {name: string; model: string | null; thinkingLevel: string | null}; afterSource: 'live' | 'retained';
  persistence: 'completed' | 'uncertain' | 'not-attempted'; clamped?: boolean; note?: string};
export type OperationKind = 'primary.open' | 'primary.input' | 'primary.stop' | 'primary.session' |
  'primary.control' | 'primary.dialog' | 'primary.handoff' | 'agent.input' | 'agent.abort' | 'agent.configure' | 'agent.convert' | 'agent.command';
/** Admission is separate from the eventual answer. Completed is a local control response. */
export type OperationView = {id: string; kind: OperationKind; target?: Target; action?: string;
  state: 'reserved' | 'dispatched' | 'accepted' | 'rejected' | 'uncertain' | 'completed';
  createdAt: string; updatedAt: string; retainedInput?: RetainedAdmission; receipt?: {kind: 'rpc'; disposition?: 'started' | 'queued' | 'handled'; result?: JsonDisplay} |
  {kind: 'durable'; identity: string; submissionId: number; requestId: string; deduped: boolean} |
  {kind: 'command'; name: string; text: string; truncated: boolean} | ConfigurationReceipt; error?: ErrorView};
export type PrimaryControl = {epoch: number} & ({action: 'model'; provider: string; modelId: string} |
  {action: 'thinking'; level: string} | {action: 'compact'; customInstructions?: string} |
  {action: 'autoCompaction' | 'autoRetry'; enabled: boolean} | {action: 'abortRetry'} |
  {action: 'name'; name: string} | {action: 'stats'} | {action: 'export'} | {action: 'resync'});
export type SessionAction = {epoch: number} & ({action: 'new'} | {action: 'resume'; sessionFile: string} | {action: 'fork'; entryId: string});
export type DialogResponse = {epoch: number} & ({value: string} | {confirmed: boolean} | {cancelled: true});
export type HandoffRequest = {epoch: number; mode: 'settle' | 'abort'; clearQueue: boolean};
export type HandoffView = {cwd: string; sessionFile: string; executable: string; argv: string[]; command: string};
export type HistoryPage = {target: Target; items: EntryView[]; nextCursor: string | null; coverage: DisplayCoverage};
export type AgentHistoryPage = {target: Target; entries: EntryView[]; nextBefore: number | null; coverage: DisplayCoverage; revision: string};
/** Threads belong to the storage that created them. Identities are external conversation identities; display names come from the roster. */
export type ThreadListItem = {id: string; storageId: string; title: string; purpose: string; updatedAt: number; closed: boolean; members: number};
/** `unavailable` means the host does not offer the exact thread operations; `failed` means the host did not answer or answered invalidly. */
export type ThreadHostState = {storageId: string; state: 'answered' | 'unavailable' | 'failed'; threads: number; truncated: boolean; code?: string; message?: string};
/** Open threads first, then newest update first. Bounds are stated so a cut list reports itself. */
export type ThreadOverview = {items: ThreadListItem[]; /** `total` counts queried storages. `notRunning` counts known storages without a live host, read from saved storage. */
  hosts: {total: number; answered: number; unavailable: number; failed: number; notRunning: number}; storages: ThreadHostState[];
  rosterComplete: boolean; truncated: boolean; omitted: number; bounds: {perHost: number; total: number}; observedAt: string};
export type ThreadFrameView = {title: string; purpose: string; authority: string; source: string; restrictions: string; acceptance: string; integrator: string};
export type ThreadMemberView = {identity: string; contribution: string; joinedAt: number};
/** A create or revise event carries its frame in `frame` and leaves `message` empty; every other event carries prose in `message`. */
export type ThreadEventView = {sequence: number; at: number; sender: string; origin: "model" | "operator"; kind: string; message: string; source: string;
  replyTo: number | null; revision: number; notify: string[]; frame?: ThreadFrameView};
export type ThreadView = ThreadFrameView & {id: string; creator: string; createdAt: number; updatedAt: number; revision: number; closed: boolean; sequence: number; members: ThreadMemberView[]};
export type ThreadPageView = {storageId: string; source?: 'live' | 'retained'; thread: ThreadView; events: ThreadEventView[]; nextBefore: number | null; pending: number; coverage: {complete: boolean}; observedAt: string};
export type ResourcePage = {items: CommandView[] | ModelChoice[] | string[]; nextCursor: string | null; revision: string};
export type NoticeView = {id: string; target?: Target; workspaceId?: string; level: 'info' | 'warning' | 'error'; code?: string; message: string};
export type AgentObservationView = {identity: string; connectionEpoch: number; availability?: EventData['agent.availability']; frame?: ProjectedFrame; omitted?: true};
export type SnapshotSection = 'notices' | 'targets' | 'selectedPage' | 'observations' | 'primaries' | 'roster' | 'pendingOperations' | 'dialogs';
export type Snapshot = {notices?: NoticeView[]; omitted?: SnapshotSection[]; primaryIndex?: Pick<PrimaryView,'key'|'epoch'|'lifecycle'>[]; operationIndex?: string[]; bootId: string; cursor: string; workspace: Workspace; primaries: PrimaryView[];
  roster: CachedRoster; observations?: AgentObservationView[]; selectedPage?: HistoryPage | AgentHistoryPage;
  dialogs: DialogView[]; pendingOperations: OperationView[]; targets?: TargetState[]; targetIndex?: TargetIndex[]};
export type Bootstrap = Snapshot & {limits: typeof LIMITS; launchCwd?: string};
export type EventData = {
  ready: {bootId: string; cursor: string; connectionId?:string};
  'control.request': import('./control.ts').ControlRequest;
  resync: {reason: 'initial' | 'expired' | 'boot-changed' | 'invalid-cursor' | 'slow-client'; snapshotUrl: string; cursor: string};
  'primary.state': PrimaryView;
  'primary.message': {message: MessageView};
  'primary.delta': {messageId: string; index: number; kind: 'text' | 'thinking' | 'toolArguments'; delta: string; callId?: string; toolName?: string};
  'primary.tool': {callId: string; name: string; phase: 'start' | 'update' | 'end'; arguments?: JsonDisplay; parts?: PartView[]; isError?: boolean; durationMs?: number; output?: ToolOutputInfo};
  'primary.entry': {entry: EntryView};
  'primary.queue': {pending: number; steering?: string[]; followUp?: string[]};
  'primary.recovery': {kind: 'compaction' | 'retry' | 'summarizationRetry'; phase: 'start' | 'scheduled' | 'attempt' | 'end';
    attempt?: number; maxAttempts?: number; delayMs?: number; error?: string; success?: boolean};
  'extension.request': DialogView | ExtensionState;
  'extension.expired': {id: string; reason: 'answered' | 'timeout' | 'epoch-changed' | 'process-exit' | 'cancelled'};
  'agent.roster': {revision: number; changed: AgentRow[]; removed: string[]; scan: ScanView; observedAt?: string; stale: boolean};
  'agent.frame': {identity: string; connectionEpoch: number; frame: ProjectedFrame};
  'agent.availability': {identity: string; connectionEpoch: number; state: 'live' | 'stored' | 'unavailable' | 'incompatible'; reason?: string; capabilities: AgentCapabilities};
  'files.changed': FileChanges;
  /** Terminal sessions that had a saved file held no longer do; the picker re-reads its rows. */
  'sessions.writers': {released: string[]};
  'workspace.changed': Workspace;
  'draft.changed': {targetKey: string; target: Target; draft: DraftView};
  'reading.changed': {targetKey: string; reading: ReadingView};
  'operation.changed': OperationView;
  notice: {level: 'info' | 'warning' | 'error'; message: string; code?: string};
};
export type EventName = keyof EventData;
/** Transport lifecycle events (`ready` and `resync`) have no journal ID and do not advance browser replay cursors. */
export type EventEnvelope<N extends EventName = EventName> = {at: string; workspaceId?: string; target?: Target; data: EventData[N]};
/** Closed HTTP route vocabulary. Dynamic segments are encoded single path segments. */
export const ROUTES = [
  'POST /api/agents/convert', 'GET /api/sessions/published', 'GET /api/sessions/history',
  'GET /api/control/layout', 'POST /api/control/requests', 'GET /api/control/requests/:id', 'POST /api/control/ack',
  'POST /api/dev/lease',
  'GET /', 'GET /api/bootstrap', 'GET /api/events', 'GET /api/snapshot',
  'GET /api/workspaces', 'POST /api/workspaces', 'POST /api/workspaces/:id/restore', 'POST /api/workspaces/:id/observation', 'POST /api/operations', 'GET /api/operations/:id', 'POST /api/operations/:id/reconcile', 'DELETE /api/operations/:id',
  'POST /api/primaries', 'GET /api/primaries/:key', 'GET /api/primaries/:key/history', 'GET /api/primaries/:key/history/output', 'GET /api/primaries/:key/history/image', 'GET /api/primaries/:key/resources/:kind',
  'GET /api/primaries/:key/diagnostics', 'POST /api/primaries/:key/inputs', 'POST /api/primaries/:key/stop',
  'POST /api/primaries/:key/session', 'POST /api/primaries/:key/control', 'POST /api/primaries/:key/dialogs/:dialogId', 'POST /api/primaries/:key/handoff',
  'GET /api/agents', 'POST /api/agents/refresh', 'GET /api/agents/:identity/history', 'GET /api/agents/:identity/history/image', 'POST /api/agents/:identity/inspect',
  'GET /api/threads', 'GET /api/threads/read',
  'POST /api/agents/:identity/inputs', 'POST /api/agents/:identity/abort', 'POST /api/agents/:identity/configure',
  'GET /api/agents/:identity/commands', 'POST /api/agents/:identity/command',
  'POST /api/workspaces/:id/targets', 'PUT /api/workspaces/:id/selection', 'GET /api/workspaces/:id/targets/:targetKey', 'PUT /api/workspaces/:id/targets/:targetKey/draft',
  'POST /api/workspaces/:id/targets/:targetKey/images', 'GET /api/workspaces/:id/targets/:targetKey/images/:digest',
  'PUT /api/workspaces/:id/targets/:targetKey/reading', 'PUT /api/workspaces/:id/targets/:targetKey/presentation',
  'GET /api/workspaces/:id/unconfirmed/:operationId', 'POST /api/workspaces/:id/unconfirmed/:operationId/restore', 'DELETE /api/workspaces/:id/unconfirmed/:operationId',
] as const;

/** `writer: 'live'` means a terminal session may still be writing the file; its absence is proof of release for the files this backend does not own. */
export type SavedSession = {writer?: 'live'; id: string; path: string; revision: string; project: string; title: string; titleSource?: 'name' | 'prompt'; titleState?: 'pending' | 'ready' | 'unavailable'; modifiedAt: string; size: number};
export type SavedSessionRead = {session: SavedSession; entries: EntryView[]; coverage: DisplayCoverage; leaf: string | null; before: string | null; observedAt: string};
export type RecentProject = {path: string; name: string; modifiedAt: string};
export type SavedSessionPage = {items: SavedSession[]; total: number; omitted: number; nextCursor: string | null; titleCursor: string | null; observedAt: string};
export type RecentProjectPage = {items: RecentProject[]; total: number; omitted: number; nextCursor: string | null; observedAt: string};
