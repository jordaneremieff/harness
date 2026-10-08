/** Browser/backend contract. This module has no runtime or platform imports. */
export const LIMITS = {
  requestBytes: 128 * 1024, textBytes: 64 * 1024, displayBytes: 256 * 1024,
  pageBytes: 64 * 1024, pageItems: 100, pathChars: 4096, idChars: 256,
  cursorBytes: 4096, primaryBytes: 8 * 1024 * 1024, rosterBytes: 8 * 1024 * 1024,
  rosterRows: 2048, agentCacheBytes: 1024 * 1024, primaries: 4, workspaces: 16,
  targets: 128, rpcPending: 64, hostPending: 32, workspaceReservations: 16,
  operations: 2048, unconfirmed: 128, journalEvents: 4096,
  journalBytes: 8 * 1024 * 1024, clientQueueBytes: 512 * 1024,
  reservationMs: 10 * 60 * 1000, jsonDepth: 8, jsonNodes: 2048,
} as const;
/** Exact target captured before dispatch. Epochs never transfer drafts. */
export type Target = {kind: 'primary'; key: string; epoch: number} | {kind: 'agent'; identity: string};
export type JsonDisplay = {value: unknown; truncated: boolean; omittedBytes?: number};
export type Retry = 'none' | 'read' | 'same-operation' | 'manual';
export type ErrorCode = 'unauthorized' | 'origin_rejected' | 'invalid_request' | 'payload_too_large' |
  'stale_revision' | 'stale_epoch' | 'unknown_operation' | 'operation_conflict' | 'capacity' |
  'not_ready' | 'unsupported' | 'host_unavailable' | 'contract_mismatch' | 'protocol_error' |
  'delivery_uncertain' | 'internal' | 'history_limit';
/** Bounded public error. Never includes stacks or raw upstream objects. */
export type ErrorView = {code: string; message: string; retry: Retry; operationId?: string; target?: Target; details?: JsonDisplay};
export type Success<T> = {ok: true; data: T};
export type Failure = {ok: false; error: ErrorView};
export type ApiResult<T> = Success<T> | Failure;
export type DisplayCoverage = {complete: boolean; truncated: boolean; omitted: number; reason?: string};
export type OutputContinuation = {entryId: string; part: number; offset: number};
export type OutputPage = {entryId: string; part: number; text: string; nextOffset: number | null; totalBytes: number};
export type PartView = {type: 'text' | 'thinking'; text: string; redacted?: boolean; more?: OutputContinuation} |
  {type: 'toolCall'; callId: string; name: string; arguments: JsonDisplay} |
  {type: 'toolResult'; callId: string; name: string; parts: PartView[]; isError: boolean} |
  {type: 'omitted'; label: string};
/** Stable adapter ID, not an array index. Final messages replace partial messages. */
export type MessageView = {id: string; role: string; timestamp?: number; parts: PartView[];
  state: 'partial' | 'final'; stopReason?: string; error?: string; coverage: DisplayCoverage};
export type EntryView = {id: string; kind: string; messages?: MessageView[]; data?: JsonDisplay; head?: string};
export type ModelChoice = {provider: string; id: string; name: string; reasoning: boolean; input: string[]; thinkingLevels?: string[]};
export type CommandView = {name: string; description: string; source: 'extension' | 'skill' | 'prompt'};
export type DialogView = {id: string; method: 'select' | 'confirm' | 'input' | 'editor'; title: string;
  options?: string[]; optionKeys?: string[]; message?: string; placeholder?: string; prefill?: string; deadline?: string};
export type ExtensionState = {method: 'notify'; message: string; notifyType: string} |
  {method: 'setStatus'; statusKey: string; statusText?: string} |
  {method: 'setWidget'; widgetKey: string; widgetLines?: string[]; widgetPlacement?: string} |
  {method: 'setTitle'; title: string} | {method: 'set_editor_text'; text: string};
/** Public process state. Stderr is available only through diagnostics. */
export type PrimaryView = {key: string; epoch: number; cwd: string;
  lifecycle: 'starting' | 'ready' | 'switching' | 'stopping' | 'stopped' | 'failed';
  activity: 'unknown' | 'idle' | 'running' | 'compacting' | 'retrying';
  sessionId?: string; sessionFile?: string; sessionName?: string; pid?: number;
  model?: ModelChoice; thinkingLevel?: string; pendingOperationIds: string[];
  contextUsage?: {tokens: number | null; contextWindow: number; percent: number | null};
  usage?: {tokens: {input: number; output: number; cacheRead: number; cacheWrite: number; total: number}; cost: number};
  pendingDialogs: DialogView[]; lastError?: ErrorView; capabilities: Record<string, boolean>;
  extension?: {title?: string; statuses: Record<string, string>; widgets: Record<string, {lines: string[]; placement?: string}>};
};
export type Appearance = 'dark' | 'light' | 'system';
/** Shared tabs use compare-and-set revisions for view state. */
export type Workspace = {id: string; revision: number; primaryKey?: string; selectedTarget?: Target;
  panelVisible?: boolean; appearance?: Appearance};
export type DraftView = {revision: number; text: string; mode: string; persisted: true};
export type ReadingView = {revision: number; anchorId: string | null; offsetPx: number; followTail: boolean};
export type PresentationView = {revision: number; expanded: string[]; showThinking: boolean};
export type UnconfirmedInput = {operationId: string; target: Target; text: string; mode: string;
  submittedDraftRevision: number; createdAt: string; reason: string; textTruncated?: true};
export type TargetIndex = {targetKey: string; target: Target; draftRevision: number; hasDraft: boolean; unconfirmedOperationIds: string[]};
export type TargetState = {targetKey: string; target: Target; draft: DraftView; reading: ReadingView;
  unconfirmed: UnconfirmedInput[]; presentation?: PresentationView};
export type AgentCapabilities = {history: boolean; observe: boolean; input: boolean; abort: boolean; configure: boolean; inspect?: boolean};
/** Published metadata and claim state, not an assertion of fresh native idle state. */
export type AgentRow = {identity: string; storageId: string; cwd: string; name?: string; handle?: string;
  modifiedAt: number; state: string; owner: 'here' | 'unavailable' | 'unknown';
  availability: 'live' | 'stored' | 'unavailable' | 'incompatible';
  model?: {provider: string; modelId: string; thinkingLevel?: string};
  thinkingLevel?: string; latestReply?: string; firstMessage?: string; error?: string;
  currentTool?: {name: string; argument: string}; partial: boolean; observedAt?: string;
  ownerLabel?: string; capabilities?: AgentCapabilities};
export type ScanView = {state: 'not-started' | 'running' | 'ready' | 'failed'; complete: boolean;
  visited: number; skipped: number; omitted: number; scanId?: string};
export type CachedRoster = {rows: AgentRow[]; nextCursor?: string | null; observedAt?: string; scan: ScanView; stale: boolean; error?: ErrorView};
export type ProjectedFrame = {revision: number; observedAt: string; entries: EntryView[]; live: EntryView[];
  nextBefore: number | null; status: {busy: boolean; name?: string; model?: {provider: string; modelId: string};
  thinkingLevel?: string; lastText?: string; tasks?: JsonDisplay; submissions?: JsonDisplay}; coverage: DisplayCoverage};
export type OperationKind = 'primary.open' | 'primary.input' | 'primary.stop' | 'primary.session' |
  'primary.control' | 'primary.dialog' | 'primary.handoff' | 'agent.input' | 'agent.abort' | 'agent.configure';
/** Admission is separate from the eventual answer. Completed is a local control response. */
export type OperationView = {id: string; kind: OperationKind; target?: Target; action?: string;
  state: 'reserved' | 'dispatched' | 'accepted' | 'rejected' | 'uncertain' | 'completed';
  createdAt: string; updatedAt: string; receipt?: {kind: 'rpc'; disposition?: 'started' | 'queued' | 'handled'; result?: JsonDisplay} |
  {kind: 'durable'; identity: string; submissionId: number; requestId: string; deduped: boolean}; error?: ErrorView};
export type PrimaryInput = {epoch: number; message: string; mode: 'prompt' | 'steer' | 'followUp'; draftRevision: number; literal?: boolean};
export type PrimaryControl = {epoch: number} & ({action: 'model'; provider: string; modelId: string} |
  {action: 'thinking'; level: string} | {action: 'compact'; customInstructions?: string} |
  {action: 'autoCompaction' | 'autoRetry'; enabled: boolean} | {action: 'abortRetry'} |
  {action: 'name'; name: string} | {action: 'stats'} | {action: 'export'} | {action: 'resync'});
export type SessionAction = {epoch: number} & ({action: 'new'} | {action: 'resume'; sessionFile: string; writerReleased: true} | {action: 'fork'; entryId: string});
export type DialogResponse = {epoch: number} & ({value: string} | {confirmed: boolean} | {cancelled: true});
export type HandoffRequest = {epoch: number; mode: 'settle' | 'abort'; clearQueue: boolean};
export type HandoffView = {cwd: string; sessionFile: string; executable: string; argv: string[]; command: string};
export type HistoryPage = {target: Target; items: EntryView[]; nextCursor: string | null; coverage: DisplayCoverage};
export type AgentHistoryPage = {target: Target; entries: EntryView[]; nextBefore: number | null; coverage: DisplayCoverage; revision: string};
export type ResourcePage = {items: CommandView[] | ModelChoice[] | string[]; nextCursor: string | null; revision: string};
export type NoticeView = {id: string; target?: Target; workspaceId?: string; level: 'info' | 'warning' | 'error'; code?: string; message: string};
export type SnapshotSection = 'notices' | 'targets' | 'selectedPage' | 'selectedFrame' | 'primaries' | 'roster' | 'pendingOperations' | 'dialogs';
export type Snapshot = {notices?: NoticeView[]; omitted?: SnapshotSection[]; primaryIndex?: Pick<PrimaryView,'key'|'epoch'|'lifecycle'>[]; operationIndex?: string[]; bootId: string; cursor: string; workspace: Workspace; primaries: PrimaryView[];
  roster: CachedRoster; selectedAgent?: AgentRow; selectedPage?: HistoryPage | AgentHistoryPage; selectedFrame?: ProjectedFrame;
  dialogs: DialogView[]; pendingOperations: OperationView[]; targets?: TargetState[]; targetIndex?: TargetIndex[]};
export type Bootstrap = Snapshot & {limits: typeof LIMITS; launchCwd?: string};
export type EventData = {
  ready: {bootId: string; cursor: string};
  resync: {reason: 'initial' | 'expired' | 'boot-changed' | 'invalid-cursor' | 'slow-client'; snapshotUrl: string; cursor: string};
  'primary.state': PrimaryView;
  'primary.message': {message: MessageView};
  'primary.delta': {messageId: string; index: number; kind: 'text' | 'thinking' | 'toolArguments'; delta: string; callId?: string; toolName?: string};
  'primary.tool': {callId: string; name: string; phase: 'start' | 'update' | 'end'; arguments?: JsonDisplay; parts?: PartView[]; isError?: boolean; durationMs?: number};
  'primary.entry': {entry: EntryView};
  'primary.queue': {pending: number; steering?: string[]; followUp?: string[]};
  'primary.recovery': {kind: 'compaction' | 'retry' | 'summarizationRetry'; phase: 'start' | 'scheduled' | 'attempt' | 'end';
    attempt?: number; maxAttempts?: number; delayMs?: number; error?: string; success?: boolean};
  'extension.request': DialogView | ExtensionState;
  'extension.expired': {id: string; reason: 'answered' | 'timeout' | 'epoch-changed' | 'process-exit' | 'cancelled'};
  'agent.roster': {revision: number; changed: AgentRow[]; removed: string[]; scan: ScanView; observedAt?: string; stale: boolean};
  'agent.frame': {identity: string; connectionEpoch: number; frame: ProjectedFrame};
  'agent.availability': {identity: string; state: 'live' | 'stored' | 'unavailable' | 'incompatible'; reason?: string; capabilities: AgentCapabilities};
  'workspace.changed': Workspace;
  'draft.changed': {targetKey: string; target: Target; draft: DraftView};
  'reading.changed': {targetKey: string; reading: ReadingView};
  'operation.changed': OperationView;
  notice: {level: 'info' | 'warning' | 'error'; message: string; code?: string};
};
export type EventName = keyof EventData;
/** Control events have no journal ID and do not advance browser replay cursors. */
export type EventEnvelope<N extends EventName = EventName> = {at: string; workspaceId?: string; target?: Target; data: EventData[N]};
/** Closed HTTP route vocabulary. Dynamic segments are encoded single path segments. */
export const ROUTES = [
  'GET /', 'POST /api/auth/launch', 'POST /api/auth/logout', 'GET /api/bootstrap', 'GET /api/events', 'GET /api/snapshot',
  'POST /api/workspaces', 'POST /api/operations', 'GET /api/operations/:id', 'POST /api/operations/:id/reconcile', 'DELETE /api/operations/:id',
  'POST /api/primaries', 'GET /api/primaries/:key', 'GET /api/primaries/:key/history', 'GET /api/primaries/:key/history/output', 'GET /api/primaries/:key/resources/:kind',
  'GET /api/primaries/:key/diagnostics', 'POST /api/primaries/:key/inputs', 'POST /api/primaries/:key/stop',
  'POST /api/primaries/:key/session', 'POST /api/primaries/:key/control', 'POST /api/primaries/:key/dialogs/:dialogId', 'POST /api/primaries/:key/handoff',
  'GET /api/agents', 'POST /api/agents/refresh', 'GET /api/agents/:identity/history', 'POST /api/agents/:identity/inspect',
  'POST /api/agents/:identity/inputs', 'POST /api/agents/:identity/abort', 'POST /api/agents/:identity/configure',
  'PUT /api/workspaces/:id/selection', 'GET /api/workspaces/:id/targets/:targetKey', 'PUT /api/workspaces/:id/targets/:targetKey/draft',
  'PUT /api/workspaces/:id/targets/:targetKey/reading', 'PUT /api/workspaces/:id/targets/:targetKey/presentation',
  'GET /api/workspaces/:id/unconfirmed/:operationId', 'POST /api/workspaces/:id/unconfirmed/:operationId/restore', 'DELETE /api/workspaces/:id/unconfirmed/:operationId',
] as const;

export type SavedSession = {id: string; path: string; revision: string; project: string; title: string; titleState?: 'pending' | 'ready' | 'unavailable'; modifiedAt: string; size: number};
export type RecentProject = {path: string; name: string; modifiedAt: string};
export type SavedSessionPage = {items: SavedSession[]; total: number; omitted: number; nextCursor: string | null; titleCursor: string | null; observedAt: string};
export type RecentProjectPage = {items: RecentProject[]; total: number; omitted: number; nextCursor: string | null; observedAt: string};
