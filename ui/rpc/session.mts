import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { LIMITS, type CommandView, type DialogResponse, type HandoffRequest, type HandoffView, type ModelChoice, type PrimaryControl, type PrimaryView, type SessionAction, type Target } from '../shared/api.ts';
import type { BlobReadSpec } from '../server/draft-images.mts';
import { createImagePreparation } from './input-preparation.mts';
import { randomUUID } from 'node:crypto';
import { safeText } from '../server/projection.mts';
import { FileHistory } from '../server/history.mts';
import { imageSource, imageDigest } from '../server/images.mts';
import type { ImageSource } from '../shared/api.ts';
import { StateError } from '../server/state.mts';
import { RpcClient, RpcError, type RpcRecord, type SpawnChild } from './client.mts';
import { Dialogs } from './dialogs.mts';
import { SessionStats } from './stats.mts';
import { EventProjection, identifier, model, object, text, rawMessageIdentity, type Publish } from './events.mts';
import type {PrimaryTransport, TransportFactory} from './transport.mts';
import type {OwnerBaseline, OwnerEvent} from '../shared/owner.ts';

export interface PrimarySessionOptions {
  key: string; executable: string; cwd: string; sessionFile?: string; epoch?: number;
  publish: Publish; onChange?: () => void; spawnChild?: SpawnChild;
  transport?: TransportFactory; attach?: boolean; recoveryWorkspaceId?: string; ownerIdentity?: string;
  onBeforeClearQueue?: (target: Extract<Target, {kind: 'primary'}>, pendingCount: number) => Promise<string>;
  onRecoveredQueue?: (clearOperationId: string, queue: {steering: string[]; followUp: string[]}) => Promise<void>;
  onQueueClearFailed?: (clearOperationId: string, uncertain: boolean) => Promise<void>;
  startupTimeoutMs?: number; shutdownTimeoutMs?: number;
  measure?: (stage: string, id: string, at: number, bytes?: number) => void;
}
export class PrimarySession {
  readonly view: PrimaryView;
  readonly client: PrimaryTransport;
  private attaching = false;
  private attachEvents: RpcRecord[] = [];
  private attachBytes = 0;
  commands: CommandView[] = [];
  models: ModelChoice[] = [];
  thinking: string[] = [];
  resourcesRevision = 0;
  private pendingRecovery?: {clearOperationId: string; response: unknown; queue?: {steering: string[]; followUp: string[]}};
  private recoveryFailure?: RpcError;
  private queueClearing?: Promise<unknown>;
  get recoveredQueue() { return this.pendingRecovery?.queue ?? {steering: [], followUp: []}; }
  get queueRecoveryPending() { return !!this.pendingRecovery || !!this.queueClearing; }
  get returnedQueueRecovery() {
    if (!this.pendingRecovery) return undefined;
    const {clearOperationId, response} = this.pendingRecovery;
    return {clearOperationId, response: structuredClone(response)};
  }
  private inputGeneration = 0;
  private imagePreparation?: ReturnType<typeof createImagePreparation>;
  private modelChanges = 0;
  private modelGeneration = 0;
  private modelUncertain = false;
  private projection: EventProjection;
  private fileHistory?: FileHistory;
  private fileClosing?: Promise<void>;
  private dialogs: Dialogs;
  private stats: SessionStats;
  private startupTimer?: NodeJS.Timeout;
  private remaining: number;
  private timerAt = 0;
  private rejectStartup?: (error: RpcError) => void;
  private frozen = false;
  private refreshing = false;
  private buffer: {event: RpcRecord; signature?: string}[] = [];
  private bufferBytes = 0;
  private settled = new Set<{ resolve: () => void; reject: (error: RpcError) => void }>();
  private started = false;
  private closing?: Promise<void>;
  private options: PrimarySessionOptions;
  constructor(options: PrimarySessionOptions) {
    this.options = options;
    this.remaining = options.startupTimeoutMs ?? 30_000;
    this.view = { key: options.key, epoch: options.epoch ?? 1, cwd: options.cwd, lifecycle: 'starting', activity: 'unknown',
      pendingOperationIds: [], pendingDialogs: [], capabilities: { input: false, control: false, handoff: false, history: false } };
    this.projection = new EventProjection(this.view, options.publish, () => options.onChange?.());
    const callbacks = {...options, onEvent: (event: RpcRecord) => this.event(event), onExit: (error?: RpcError) => this.exited(error), onProtocolError: (error: RpcError) => this.fail(error)};
    this.client = options.transport ? options.transport(callbacks) : new RpcClient(callbacks);
    this.dialogs = new Dialogs(this.view, this.projection, this.client, () => this.deadline());
    this.stats = new SessionStats(this.view, this.client, () => this.projection.state());
  }
  get entries() { return this.projection.entries; }
  get messages() { return this.projection.messages; }
  get coverage() { return this.projection.coverage; }
  get stderrTail(): string { return this.client.stderrTail; }
  get target() { return this.projection.target; }
  async start(): Promise<void> {
    if (this.started || this.closing || this.frozen) throw new RpcError('not_ready', 'Primary already started or closed.');
    this.started = true;
    try {
      if (!isAbsolute(this.options.cwd) || !(await stat(this.options.cwd)).isDirectory()) throw new RpcError('invalid_request', 'Project directory must exist and be absolute.');
      if (this.options.sessionFile) this.options.sessionFile = await this.sessionPath(this.options.sessionFile);
      if (this.closing || this.frozen) throw new RpcError('not_ready', 'Primary is closed.');
      const timeout = new Promise<never>((_, reject) => { this.rejectStartup = reject; });
      this.deadline(); await this.client.start(this.options.sessionFile); this.view.pid = this.client.child?.pid;
      await Promise.race([this.options.attach ? this.attach() : this.initialize(), timeout]);
      if (this.closing || this.frozen || this.view.lifecycle === 'failed' || this.view.lifecycle === 'stopped') throw new RpcError('host_unavailable', 'Primary exited during startup.');
      this.view.lifecycle = 'ready'; this.view.capabilities = { input: this.client.synchronized, control: true, handoff: this.client.synchronized, history: true };
      this.projection.state(); this.stats.refresh();
    } catch (error) {
      const failure = this.error(error);
      if (!this.closing) { this.fail(failure); this.view.lifecycle = 'failed'; this.projection.state(); }
      throw failure;
    }
    finally { this.rejectStartup = undefined; if (this.startupTimer) clearTimeout(this.startupTimer); this.startupTimer = undefined; }
  }
  private async attach(): Promise<void> {
    if (!this.client.captureBegin || !this.client.captureFinish || !this.client.captureAck) throw new RpcError('unsupported', 'The transport does not support attachment.');
    this.attaching = true;
    const capture = await this.client.captureBegin();
    try {
      await this.initialize();
      const baseline = await this.client.captureFinish(capture.token);
      this.hydrate(baseline);
      await this.client.captureAck(capture.token);
      const suffix = this.attachEvents.filter(event => Number(event.__ownerSequence) > baseline.cursor);
      this.attachEvents = []; this.attachBytes = 0; this.attaching = false;
      for (const event of suffix) this.event(event);
    } finally {this.attaching = false; this.attachEvents = []; this.attachBytes = 0;}
  }
  private ownerEvent({record,seq,at,messageStartSequence}:OwnerEvent):RpcRecord {return {...record,__ownerSequence:seq,__ownerStartSequence:messageStartSequence,__ownerAt:at,__ownerIdentity:this.options.ownerIdentity} as RpcRecord;}
  private hydrateCompleted(baseline:OwnerBaseline,committedThrough:number):void {
    const completed=baseline.overlap.filter(event=>event.seq>committedThrough&&event.record.type==='message_end'),occurrences=new Map<string,number>();
    for(const end of completed){
      const fingerprint=rawMessageIdentity(end.record.message),count=(occurrences.get(fingerprint)??0)+1;occurrences.set(fingerprint,count);
      if(this.projection.hasRawMessage(end.record.message,count))continue;
      const start=baseline.overlap.find(event=>event.record.type==='message_start'&&object(event.record.message).role===object(end.record.message).role&&object(event.record.message).timestamp===object(end.record.message).timestamp);
      if(start)this.projection.reduce(this.ownerEvent(start));this.projection.reduce(this.ownerEvent(end));
    }
    for(const event of baseline.overlap)if(event.seq>committedThrough&&event.record.type==='entry_appended')this.projection.reduce(this.ownerEvent(event));
  }
  private hydrateLive(baseline:OwnerBaseline):void {
    const tape=baseline.activeMessage;
    if(tape?.complete)for(const event of tape.events)this.projection.reduce(this.ownerEvent(event));
    else if(tape)this.projection.incomplete('owner-active-message-incomplete');
    for(const tool of baseline.tools){this.projection.reduce(this.ownerEvent(tool.start));if(tool.latest)this.projection.reduce(this.ownerEvent(tool.latest));}
    this.dialogs.restoreRaw(baseline.dialogs);
  }
  private hydrate(baseline:OwnerBaseline):void {
    if(baseline.descriptor.key!==this.view.key||baseline.descriptor.epoch!==this.view.epoch)throw new RpcError('stale_epoch','Owner baseline identifies another primary.');
    const leaf=this.projection.entries.at(-1)?.id,committedThrough=baseline.overlap.findLast(event=>event.record.type==='entry_appended'&&event.record.entry&&object(event.record.entry).id===leaf)?.seq??baseline.from;
    this.projection.silent=true;
    try{
      for(const event of baseline.state){const record=this.ownerEvent(event);if(record.type==='extension_ui_request')this.dialogs.accept(record);else this.projection.reduce(record);}
      this.hydrateCompleted(baseline,committedThrough);this.hydrateLive(baseline);
      if(!baseline.complete)this.projection.incomplete(`owner-baseline:${baseline.reasons.join(',')}`);
      this.client.synchronized=baseline.complete&&baseline.descriptor.synchronized;this.view.pid=baseline.descriptor.pid;
    }finally{this.projection.silent=false;}
  }
  private async initialize(): Promise<void> {
    await this.refreshState();
    if (this.closing) throw new RpcError('not_ready', 'Primary is closed.');
    const [commands, models, thinking] = await Promise.all([this.client.request('get_commands'), this.client.request('get_available_models'), this.client.request('get_available_thinking_levels')]);
    const commandData = object(commands).commands; const modelData = object(models).models;
    if (!Array.isArray(commandData) || !Array.isArray(modelData)) throw new RpcError('protocol_error', 'Invalid primary resource response.');
    this.commands = commandData.map((v) => {
      const c = object(v); const source = c.source;
      if (source !== 'extension' && source !== 'skill' && source !== 'prompt') throw new RpcError('protocol_error', 'Invalid command source.');
      return { name: identifier(c.name), description: typeof c.description === 'string' ? safeText(c.description, 1024) : '', source };
    });
    this.models = modelData.map(model); this.setThinking(thinking);
    if (Buffer.byteLength(JSON.stringify([this.commands, this.models, this.thinking])) > 1024 * 1024) throw new RpcError('capacity', 'Resource cache exceeds its limit.');
    this.resourcesRevision++; await this.resynchronize();
  }
  private deadline(): void {
    if (!this.rejectStartup) return;
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = undefined; this.remaining -= performance.now() - this.timerAt; }
    if (this.view.pendingDialogs.length) return;
    this.timerAt = performance.now();
    this.startupTimer = setTimeout(() => this.rejectStartup?.(new RpcError('host_unavailable', 'Primary startup deadline expired.')), Math.max(0, this.remaining));
  }
  async refreshState(manualCompaction = false): Promise<void> {
    const revision = this.projection.activityRevision; const epoch = this.view.epoch; const lifecycle = this.view.lifecycle;
    const modelGeneration = this.modelGeneration;
    const manualActivity = this.view.activity === 'compacting' && lifecycle === 'ready' && this.projection.manualCompactionEndRevision === revision;
    const state = object(await this.client.request('get_state')); this.epoch(epoch);
    if (this.view.lifecycle !== lifecycle) throw new RpcError('not_ready', 'Primary lifecycle changed during state refresh.');
    if (typeof state.isStreaming !== 'boolean' || typeof state.isCompacting !== 'boolean') throw new RpcError('protocol_error', 'Invalid primary state activity.');
    this.view.sessionId = identifier(state.sessionId);
    this.view.sessionFile = state.sessionFile === undefined ? undefined : text(state.sessionFile);
    this.view.sessionName = state.sessionName === undefined ? undefined : safeText(text(state.sessionName), 1024);
    if (modelGeneration === this.modelGeneration) {
      this.view.model = state.model === undefined ? undefined : model(state.model);
      if (!this.modelChanges) this.modelUncertain = false;
    }
    this.view.thinkingLevel = state.thinkingLevel === undefined ? undefined : identifier(state.thinkingLevel);
    if (revision === this.projection.activityRevision && (!manualCompaction || manualActivity)) this.refreshedActivity(state, manualCompaction);
    this.projection.state();
  }
  private refreshedActivity(state: Record<string, unknown>, manualCompaction: boolean): void {
    if (!state.isStreaming) delete this.view.retry;
    this.view.activity = state.isCompacting ? 'compacting' : state.isStreaming ? this.view.retry ? 'retrying' : 'running' : 'idle';
    if (manualCompaction && this.view.activity === 'idle') { for (const waiter of this.settled) waiter.resolve(); this.settled.clear(); }
  }
  async resynchronize(): Promise<void> {
    if (this.refreshing) throw new RpcError('not_ready', 'History refresh already in progress.');
    const epoch = this.view.epoch;
    this.refreshing = true; this.buffer = []; this.bufferBytes = 0;
    try {
      const source = await this.savedSource();
      const entries = source ? await source.history.page(source.path, source.leaf) : await this.client.request('get_entries'); this.epoch(epoch);
      this.projection.snapshot(entries);
      const buffer = this.buffer; this.buffer = []; this.refreshing = false;
      this.projection.silent = true;
      try { for (const {event, signature} of buffer) this.projection.reduce(event, signature); }
      finally { this.projection.silent = false; }
      this.projection.prune();
      if (this.dialogs.blocked) throw new RpcError('capacity', 'An extension dialog exceeds browser capacity; stop cancels the request.');
      this.client.markSynchronized();
      if (this.view.lifecycle === 'ready') this.view.capabilities.input = true;
      this.projection.state();
    } finally { this.refreshing = false; this.buffer = []; this.bufferBytes = 0; }
  }
  async historyWindow(beforeEntryId: string) {
    if (this.view.lifecycle !== 'ready') throw new RpcError('not_ready', 'Primary history is unavailable.');
    if (typeof beforeEntryId !== 'string' || !beforeEntryId || beforeEntryId.length > 256) throw new RpcError('invalid_request', 'Invalid history anchor.');
    const epoch = this.view.epoch;
    try {
      const source = await this.savedSource();
      const data = source ? await source.history.page(source.path, source.leaf, beforeEntryId) : object(await this.client.request('get_entries', {}, beforeEntryId));
      this.epoch(epoch);
      const temporary = new EventProjection(this.view, () => {}, () => {}); temporary.snapshot(data);
      return { entries: temporary.entries, coverage: temporary.coverage };
    } catch (error) {
      if (error instanceof RpcError && ['protocol_error', 'history_limit'].includes(error.code)) throw new RpcError('history_limit', 'History source or active-branch anchor is unavailable.');
      throw error;
    }
  }
  private async savedSource(): Promise<{history: FileHistory; path: string; leaf: string | null} | undefined> {
    const path = this.view.sessionFile; const epoch = this.view.epoch;
    if (!path) return undefined;
    if (!isAbsolute(path)) throw new RpcError('history_limit', 'The RPC saved history path is invalid.');
    try { if (!(await stat(path)).isFile()) throw new RpcError('history_limit', 'The saved history source is not a file.'); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
    if (this.closing || this.client.exited) throw new RpcError('not_ready', 'Primary is closed.');
    this.epoch(epoch);
    this.fileHistory ??= new FileHistory(); const history = this.fileHistory;
    const index = await history.index(path); this.epoch(epoch);
    const state = object(await this.client.request('get_entries', index.lastId ? {since: index.lastId} : {})); this.epoch(epoch);
    if (!(state.leafId === null || typeof state.leafId === 'string')) throw new RpcError('protocol_error', 'Invalid RPC history leaf.');
    if (this.view.sessionFile !== path) throw new RpcError('stale_epoch', 'The saved history source changed.');
    return {history, path, leaf: state.leafId as string | null};
  }
  async historyImage(sourcePart: ImageSource, digest: string) {
    if (this.view.lifecycle !== 'ready') throw new RpcError('not_ready', 'Primary history is unavailable.');
    imageSource(sourcePart); imageDigest(digest);
    const epoch = this.view.epoch; const source = await this.savedSource();
    if (!source) throw new RpcError('history_limit', 'This image has no saved source yet.');
    const image = await source.history.image(source.path, source.leaf, sourcePart, digest); this.epoch(epoch);
    if (this.view.sessionFile !== source.path) throw new RpcError('stale_epoch', 'The saved image source changed.');
    return image;
  }
  async historyOutput(entryId: string, part: number, offset: number) {
    if (this.view.lifecycle !== 'ready') throw new RpcError('not_ready', 'Primary history is unavailable.');
    if (typeof entryId !== 'string' || !entryId || entryId.length > 256 || !Number.isSafeInteger(part) || part < 0 || part >= 100 || !Number.isSafeInteger(offset) || offset < 0) throw new RpcError('invalid_request', 'Invalid output request.');
    const epoch = this.view.epoch; const source = await this.savedSource();
    if (!source) throw new RpcError('history_limit', 'This output has no saved source yet.');
    const page = await source.history.output(source.path, source.leaf, entryId, part, offset); this.epoch(epoch); return page;
  }
  async input(message: string, mode: 'prompt' | 'steer' | 'followUp', literal = false, imageSource?: BlobReadSpec): Promise<unknown> {
    this.admit();
    const hasImages = !!imageSource?.images.length;
    if (typeof message !== 'string' || (!message.trim() && !hasImages)) throw new RpcError('invalid_request', 'Input must contain text or images.');
    if (Buffer.byteLength(message) > 64 * 1024) throw new RpcError('payload_too_large', 'Input exceeds the text limit.');
    if (!['prompt', 'steer', 'followUp'].includes(mode)) throw new RpcError('invalid_request', 'Invalid input mode.');
    const invocation = message.match(/^\/(\S+)/)?.[1];
    if (!literal && invocation && !this.commands.some((c) => c.name === invocation)) throw new RpcError('unsupported', 'Command is not available through RPC; use a session control or send literal text.');
    const fields = {message, ...(mode === 'prompt' ? {} : {streamingBehavior: mode})};
    let raw: unknown;
    if (hasImages && imageSource) {
      if (message.trimStart().startsWith('/')) throw new RpcError('unsupported', 'Commands do not accept images.');
      raw = await this.imageInput(imageSource, fields);
    } else raw = await this.client.request('prompt', fields);
    const result = object(raw);
    if (!['started', 'queued', 'handled'].includes(String(result.disposition))) throw new RpcError('protocol_error', 'Invalid prompt admission response.', true);
    return result;
  }
  private async imageInput(imageSource: BlobReadSpec, fields: {message: string; streamingBehavior?: 'steer' | 'followUp'}): Promise<unknown> {
    this.requireQueuePersistence(); this.admitImages();
    const epoch = this.view.epoch, generation = this.inputGeneration;
    const source = structuredClone(imageSource);
    const preparation = createImagePreparation(); this.imagePreparation = preparation;
    const guard = () => {
      this.epoch(epoch); this.admit(); this.admitImages();
      if (generation !== this.inputGeneration) throw new RpcError('not_ready', 'Image input was cancelled by a session change.');
    };
    try { return await this.client.requestPrepared('prompt', id => preparation.prepare(source, {...fields, id, type: 'prompt'}), guard); }
    finally { await preparation.release(); if (this.imagePreparation === preparation) this.imagePreparation = undefined; }
  }
  private admitImages(): void {
    if (this.modelChanges || this.modelUncertain) throw new RpcError('not_ready', 'The model change is not confirmed.');
    if (!this.view.model?.input.includes('image')) throw new RpcError('unsupported', 'Image input is not available for the current model.');
  }
  private invalidatePreparation(): void { this.inputGeneration++; this.imagePreparation?.cancel(); }
  private requireQueuePersistence() {
    const {onBeforeClearQueue, onRecoveredQueue, onQueueClearFailed} = this.options;
    if (!onBeforeClearQueue || !onRecoveredQueue || !onQueueClearFailed) throw new RpcError('not_ready', 'Saved queue recovery is unavailable.');
    return {onBeforeClearQueue, onRecoveredQueue, onQueueClearFailed};
  }
  async stop(): Promise<unknown> {
    this.admit(true); this.frozen = true; this.invalidatePreparation();
    try { await this.dialogs.cancel(); const queue = await this.clearQueue(); await this.client.request('abort'); return queue; }
    finally { if (!this.closing) this.frozen = false; }
  }
  private async flushRecoveredQueue(): Promise<void> {
    if (!this.pendingRecovery) return;
    const {clearOperationId, queue} = this.pendingRecovery;
    try {
      if (this.recoveryFailure) throw this.recoveryFailure;
      if (!queue) throw new RpcError('protocol_error', 'Invalid cleared queue response.', true);
      if (!this.options.onRecoveredQueue) throw new RpcError('not_ready', 'The cleared messages must be saved before another queue clear.');
      await this.options.onRecoveredQueue(clearOperationId, structuredClone(queue));
      await this.client.queueAcknowledged?.(clearOperationId);
      this.pendingRecovery = undefined;
    } catch (error) { await this.options.onQueueClearFailed?.(clearOperationId, true); throw error; }
  }
  private clearQueue(): Promise<unknown> {
    this.queueClearing ??= this.clearQueueOnce().finally(() => { this.queueClearing = undefined; });
    return this.queueClearing;
  }
  private async clearQueueOnce(): Promise<unknown> {
    this.frozen = true; this.invalidatePreparation();
    await this.flushRecoveredQueue();
    const state = object(await this.client.request('get_state'));
    const pendingCount = state.pendingMessageCount;
    if (!Number.isSafeInteger(pendingCount) || (pendingCount as number) < 0 || (pendingCount as number) > LIMITS.unconfirmed)
      throw new RpcError('capacity', 'The pending queue count is invalid or exceeds recovery capacity.');
    const hooks = this.options.onBeforeClearQueue || this.options.onRecoveredQueue || this.options.onQueueClearFailed ? this.requireQueuePersistence() : undefined;
    const clearOperationId = hooks ? await hooks.onBeforeClearQueue(this.target, pendingCount as number) : randomUUID();
    if (typeof clearOperationId !== 'string' || !clearOperationId || clearOperationId.length > LIMITS.idChars)
      throw new RpcError('protocol_error', 'Queue recovery did not return a valid operation identity.');
    let nativeReturned = false;
    try {
      if (this.client.setQueueReservation) {
        if (!this.options.recoveryWorkspaceId) throw new RpcError('not_ready', 'Queue recovery workspace is unavailable.');
        this.client.setQueueReservation({id: clearOperationId, workspaceId: this.options.recoveryWorkspaceId, pendingCount: pendingCount as number});
      }
      const raw = await this.client.request('clear_queue'); nativeReturned = true;
      const queue = this.retainReturnedQueue(raw, clearOperationId, pendingCount as number);
      if (hooks) {
        await hooks.onRecoveredQueue(clearOperationId, structuredClone(queue)); await this.client.queueAcknowledged?.(clearOperationId); this.pendingRecovery = undefined;
      } else if (!queue.steering.length && !queue.followUp.length) this.pendingRecovery = undefined;
      this.projection.emit('primary.queue', {pending: 0, ...queue}); this.options.onChange?.(); return queue;
    } catch (error) {
      const uncertain = nativeReturned || !(error instanceof RpcError) || error.uncertain;
      await this.options.onQueueClearFailed?.(clearOperationId, uncertain);
      throw error;
    }
  }
  private retainReturnedQueue(raw: unknown, clearOperationId: string, pendingCount: number) {
    // Capture the native result before decoding; invalid positions still own recovery storage.
    this.pendingRecovery = {clearOperationId, response: raw};
    const result = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (!Array.isArray(result.steering) || !Array.isArray(result.followUp) ||
        result.steering.some(value => typeof value !== 'string') || result.followUp.some(value => typeof value !== 'string')) {
      this.recoveryFailure = new RpcError('protocol_error', 'Invalid cleared queue response.', true);
      throw this.recoveryFailure;
    }
    const queue = {steering: result.steering as string[], followUp: result.followUp as string[]};
    this.pendingRecovery.queue = queue;
    if (queue.steering.length + queue.followUp.length > pendingCount || Buffer.byteLength(JSON.stringify(queue)) > 1024 * 1024) {
      this.recoveryFailure = new RpcError('capacity', 'Cleared queue exceeds its reserved recovery capacity.', true);
      throw this.recoveryFailure;
    }
    return queue;
  }
  private controlCommand(body: PrimaryControl) {
    let type: string; let fields: Record<string, unknown> = {};
    switch (body.action) {
      case 'model': type = 'set_model'; fields = { provider: text(body.provider), modelId: text(body.modelId) }; break;
      case 'thinking': type = 'set_thinking_level'; fields = { level: text(body.level) }; break;
      case 'compact': type = 'compact'; if (body.customInstructions !== undefined) fields = { customInstructions: text(body.customInstructions) }; break;
      case 'autoCompaction': case 'autoRetry':
        if (typeof body.enabled !== 'boolean') throw new RpcError('invalid_request', 'Enabled must be a boolean.');
        type = body.action === 'autoRetry' ? 'set_auto_retry' : 'set_auto_compaction'; fields = { enabled: body.enabled }; break;
      case 'abortRetry': type = 'abort_retry'; break;
      case 'name': type = 'set_session_name'; fields = { name: text(body.name) }; break;
      case 'stats': type = 'get_session_stats'; break;
      case 'export': type = 'export_html'; break;
      default: throw new RpcError('unsupported', 'Unsupported primary control.');
    }
    if (Object.keys(body).some((k) => !['epoch', 'action', ...Object.keys(fields)].includes(k))) throw new RpcError('invalid_request', 'Invalid primary control fields.');
    return {type, fields};
  }
  async control(body: PrimaryControl): Promise<unknown> {
    this.epoch(body.epoch); this.admit(body.action === 'abortRetry');
    const {type, fields} = this.controlCommand(body);
    if (body.action === 'model') { this.modelChanges++; this.modelGeneration++; this.modelUncertain = true; this.invalidatePreparation(); }
    const modelGeneration = this.modelGeneration;
    const retryRevision = body.action === 'abortRetry' ? this.projection.captureRetry() : undefined;
    try {
      const result = await this.controlRequest(type, fields, body.epoch); this.epoch(body.epoch);
      if (body.action === 'abortRetry') this.projection.confirmRetryAbort(retryRevision);
      if (body.action === 'model' && modelGeneration === this.modelGeneration) {
        this.stats.clear(); this.view.model = model(result);
        const levels = await this.client.request('get_available_thinking_levels'); this.epoch(body.epoch);
        this.setThinking(levels); this.resourcesRevision++;
      }
      if (body.action !== 'export' && body.action !== 'stats') await this.refreshState(body.action === 'compact');
      if (body.action === 'model' && modelGeneration === this.modelGeneration) { this.modelUncertain = false; this.stats.refresh(); }
      return result;
    } catch (error) { if (body.action === 'model' && modelGeneration === this.modelGeneration) this.modelUncertain = true; throw error; }
    finally { if (body.action === 'model') this.modelChanges--; }
  }
  private async controlRequest(type: string, fields: Record<string, unknown>, epoch: number): Promise<unknown> {
    try { return await this.client.request(type, fields); }
    catch (error) {
      if (type === 'compact' && error instanceof RpcError && error.code === 'rpc_rejected' && this.view.epoch === epoch && this.view.lifecycle === 'ready') {
        try { await this.refreshState(true); }
        catch (refreshError) { if (this.view.epoch === epoch && this.view.lifecycle === 'ready') this.fail(this.error(refreshError)); }
      }
      throw error;
    }
  }
  private setThinking(value: unknown): void {
    const levels = object(value).levels;
    if (!Array.isArray(levels) || levels.length > 16 || levels.some((level) => typeof level !== 'string' || level.length > 256)) throw new RpcError('protocol_error', 'Invalid thinking-level response.');
    this.thinking = levels as string[];
  }
  async transition(body: SessionAction): Promise<unknown> {
    this.epoch(body.epoch); this.admit(); this.frozen = true; this.invalidatePreparation(); this.view.lifecycle = 'switching'; this.projection.state();
    try {
      let result: Record<string, unknown>;
      switch (body.action) {
        case 'new': result = object(await this.client.request('new_session')); break;
        case 'resume':
          result = object(await this.client.request('switch_session', { sessionPath: await this.sessionPath(body.sessionFile) })); break;
        case 'fork': result = object(await this.client.request('fork', { entryId: text(body.entryId) })); break;
        default: throw new RpcError('unsupported', 'Unsupported session transition.');
      }
      if (typeof result.cancelled !== 'boolean') throw new RpcError('protocol_error', 'Invalid session transition result.', true);
      if (!result.cancelled) {
        this.dialogs.expireAll('epoch-changed'); this.view.epoch++; this.stats.clear(); this.projection.reset(); this.view.activity = 'unknown';
        this.view.extension = { statuses: {}, widgets: {} }; await this.refreshState(); await this.client.setEpoch?.(this.view.epoch, this.view.sessionFile); await this.resynchronize();
      }
      return result;
    } finally { this.frozen = false; if (this.view.lifecycle === 'switching') this.view.lifecycle = 'ready'; this.projection.state(); this.stats.refresh(); }
  }
  respond(dialogId: string, body: DialogResponse): Promise<void> { return this.dialogs.respond(dialogId, body); }
  async handoff(body: HandoffRequest): Promise<HandoffView> {
    this.epoch(body.epoch); this.admit();
    if (!['settle', 'abort'].includes(body.mode) || typeof body.clearQueue !== 'boolean') throw new RpcError('invalid_request', 'Invalid handoff mode.');
    this.frozen = true; this.invalidatePreparation();
    try {
      if (this.pendingRecovery) await this.flushRecoveredQueue();
      if (body.mode === 'abort') await this.dialogs.cancel();
      if (body.clearQueue) await this.clearQueue();
      if (body.mode === 'abort') await this.client.request('abort'); else await this.waitForSettled();
      await this.refreshState();
      if (!this.view.sessionFile) throw new RpcError('not_ready', 'No saved session yet.');
      let sessionFile: string;
      try { sessionFile = await this.sessionPath(this.view.sessionFile); } catch { throw new RpcError('not_ready', 'No saved session yet.'); }
      this.view.lifecycle = 'stopping'; this.projection.state(); await this.client.close();
      if (String(this.view.lifecycle) !== 'stopped') throw new RpcError('handoff_blocked', 'RPC writer did not exit cleanly.');
      const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
      return { cwd: this.view.cwd, sessionFile, executable: this.options.executable, argv: ['--session', sessionFile],
        command: `cd ${quote(this.view.cwd)} && ${quote(this.options.executable)} --session ${quote(sessionFile)}` };
    } catch (error) { if (this.view.lifecycle === 'ready') this.frozen = false; throw error; }
  }
  private waitForSettled(): Promise<void> {
    if (this.view.activity === 'idle') return Promise.resolve();
    return new Promise((resolve, reject) => this.settled.add({ resolve, reject }));
  }
  async prepareDetach(): Promise<void> {
    if (!this.client.captureBegin || !this.client.captureFinish || !this.client.captureAck) throw new RpcError('unsupported', 'The Pi transport cannot survive backend replacement.');
    const capture = await this.client.captureBegin();
    try {const baseline = await this.client.captureFinish(capture.token); if (!baseline.complete) throw new RpcError('history_limit', `The raw owner cannot reconstruct this live primary: ${baseline.reasons.join(',')}`);}
    finally {await this.client.captureAck(capture.token);}
  }
  async detach(): Promise<void> {
    if (!this.client.detach) throw new RpcError('unsupported', 'A local Pi transport cannot detach.');
    this.frozen = true; this.invalidatePreparation(); this.dialogs.detach(); this.stats.clear();
    if (this.startupTimer) clearTimeout(this.startupTimer);
    await this.fileHistory?.close(); await this.client.detach();
  }
  close(): Promise<void> {
    this.closing ??= this.closeOnce().finally(async () => { this.fileClosing ??= this.fileHistory?.close(); await this.fileClosing; })
      .catch(error => { this.closing = undefined; throw error; });
    return this.closing;
  }
  private async closeOnce(): Promise<void> {
    this.frozen = true; this.invalidatePreparation(); this.rejectStartup?.(new RpcError('not_ready', 'Primary is closed.'));
    this.projection.clearRetry();
    this.view.capabilities.input = false; this.view.capabilities.control = false; this.view.capabilities.handoff = false;
    if (!this.client.child) { await this.client.close(); this.view.lifecycle = 'stopped'; this.projection.state(); return; }
    if (this.client.exited) { await this.flushRecoveredQueue(); await this.client.close(); return; }
    this.view.lifecycle = 'stopping'; this.projection.state();
    if (!this.client.available) { await this.flushRecoveredQueue(); await this.client.close(); return; }
    await this.dialogs.cancel(); await this.clearQueue(); await this.client.request('abort'); await this.client.close();
  }
  private bufferAttachment(event:RpcRecord):boolean {
    if(!this.attaching)return false;
    this.attachBytes+=Buffer.byteLength(JSON.stringify(event));
    if(this.attachBytes>40*1024*1024)this.fail(new RpcError('history_limit','Attachment event suffix exceeds its bound.'));
    else this.attachEvents.push(event);
    return true;
  }
  private eventSettled(type:string):void {
    if(type==='agent_settled'||type==='compaction_end')this.stats.refresh();
    if(type==='agent_settled'){for(const waiter of this.settled)waiter.resolve();this.settled.clear();}
  }
  private event(event: RpcRecord): void {
    if(this.bufferAttachment(event))return;
    try {
      if (event.type === 'extension_ui_request') this.dialogs.accept(event);
      else {
        this.projection.reduce(event);
        if (this.refreshing && ['message_start', 'message_update', 'message_end', 'entry_appended', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) {
          this.bufferBytes += Buffer.byteLength(JSON.stringify(event));
          if (this.bufferBytes > 8 * 1024 * 1024) throw new RpcError('history_limit', 'History refresh event buffer exceeded its limit.');
          this.buffer.push({ event, signature: this.projection.lastSignature });
        }
      }
      if (!this.refreshing) this.projection.prune();
      this.eventSettled(event.type);
    } catch (error) { this.fail(this.error(error)); }
  }
  private exited(error?: RpcError): void {
    this.invalidatePreparation();
    this.fileClosing ??= this.fileHistory?.close();
    this.projection.clearRetry();
    this.view.lifecycle = error ? 'failed' : 'stopped'; this.view.activity = 'unknown';
    this.view.capabilities.input = false; this.view.capabilities.control = false; this.view.capabilities.handoff = false;
    this.dialogs.expireAll('process-exit');
    const failure = error ?? new RpcError('delivery_uncertain', 'Primary process closed.', true);
    this.rejectStartup?.(failure);
    for (const waiter of this.settled) waiter.reject(failure); this.settled.clear();
    if (error) this.view.lastError = { code: error.code, message: error.message, retry: 'manual' };
    this.projection.state();
  }
  private fail(error: RpcError): void {
    this.invalidatePreparation();
    this.projection.clearRetry();
    this.client.synchronized = false; this.view.capabilities.input = false;
    this.view.lastError = { code: error.code, message: safeText(error.message), retry: 'manual' }; this.projection.state();
  }
  private epoch(epoch: number): void { if (epoch !== this.view.epoch) throw new RpcError('stale_epoch', 'Primary session epoch changed.'); }
  private admit(allowUnsynchronized = false): void {
    if (this.frozen || (this.view.lifecycle !== 'ready' && !(allowUnsynchronized && this.view.lifecycle === 'starting'))) throw new RpcError('not_ready', 'Primary does not accept controls.');
    if (!allowUnsynchronized && !this.client.synchronized) throw new RpcError('protocol_error', 'Primary requires an explicit history refresh.');
  }
  private async sessionPath(path: string): Promise<string> {
    if (!isAbsolute(path) || path.length > 4096) throw new RpcError('invalid_request', 'Saved session path must be absolute.');
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new RpcError('invalid_request', 'Saved session path must name a file.');
    return canonical;
  }
  private error(error: unknown): RpcError {
    if (error instanceof RpcError) return error;
    if (error instanceof StateError) return new RpcError(error.code, safeText(error.message, 512));
    return new RpcError('host_unavailable', 'Primary operation failed.');
  }
}
