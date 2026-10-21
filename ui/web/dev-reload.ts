import {LIMITS, validFileTab, workspaceTabKey, type FileTab, type FilePosition, type DevLeaseIdentity} from '../shared/api.ts';
import {validInspectionCheckpoint, type InspectionCheckpoint} from '../shared/inspection.ts';
export type DevFileCheckpoint = {tab:FileTab;position:FilePosition;digest:string;focused:boolean;selection?:NonNullable<DevCheckpointEntry['selection']>};
export type DevBuild = {
  revision: number; generation: string; previous: string | null;
  change: 'css' | 'reload'; status: 'ready' | 'building' | 'failed' | 'held' | 'restart-required';
  code: 'none' | 'compile' | 'input-changed' | 'invalid-assets' | 'capacity' | 'backend-change' | 'io';
};
export type DevReloadHold = 'input' | 'ime' | 'selection' | 'resize' | 'modal' | 'offline' | 'conflict' | 'uncertain';
export type DevInteraction = {revision: number; safe: boolean; reason?: DevReloadHold};
export type DevCheckpointTarget =
  | {kind: 'primary'; key: string; epoch: number}
  | {kind: 'agent'; identity: string; connectionEpoch: number}
  | {kind: 'agent'; identity: string; retained: true};
export type DevCheckpointEntry = {
  targetKey: string; target: DevCheckpointTarget; draftRevision: number; imageFingerprint: string; readingRevision: number; presentationRevision: number;
  selection?: {start: number; end: number; direction: 'forward' | 'backward' | 'none'};
};
export type DevReloadView = {
  workspaceId: string; focusedPane: string; targets: DevCheckpointEntry[]; messageRecipient?: string;
  focusedControl?: {targetKey: string; kind: 'composer' | 'message'}; files?:DevFileCheckpoint[]; inspections?:InspectionCheckpoint[]; composerStateKey?:string;
};
export type DevReloadCheckpoint = DevReloadView & {
  version: 1; generation: string; oldClient: string; capturedAt: number; interactionRevision: number;
};
export type DevReloadError = {name: string; message: string; stack: string; truncated: Array<'name' | 'message' | 'stack'>};
export type DevReloadNotice = {
  retryable: boolean;
  error?: DevReloadError;
  state: DevBuild['status'] | 'idle' | 'deferred' | 'reconnecting' | 'offline' | 'applied' | 'navigating';
  code: DevBuild['code'] | DevReloadHold | 'checkpoint' | 'restore' | 'storage' | 'stylesheet' | 'drain' | 'timeout' | 'ack' | 'release' | 'host';
  build?: DevBuild;
};
/** Why an update that is ready waits, in words. */
const HOLD_SENTENCES: Record<DevReloadHold, string> = {input: 'Update waits while you type', ime: 'Update waits while you compose text', selection: 'Update waits while text is selected', resize: 'Update waits while you resize a pane',
  modal: 'Update waits while a dialog is open', offline: 'Update waits while the connection is offline', conflict: 'Update waits while a draft conflict is open', uncertain: 'Update waits until a sent message is confirmed'};
function pausedText(code: DevReloadNotice['code']): string { return Object.hasOwn(HOLD_SENTENCES, code) ? HOLD_SENTENCES[code as DevReloadHold] : 'Update paused'; }
type ReloadPresentation = {text: string; action: 'retry' | 'reload' | null};
function reloadWords(notice: DevReloadNotice): ReloadPresentation {
  if (notice.state === 'failed') {
    if (!notice.retryable || ['checkpoint', 'restore', 'release', 'invalid-assets', 'host', 'storage'].includes(notice.code)) return {text:'Automatic updates stopped.', action:'reload'};
    if (['compile', 'input-changed'].includes(notice.code)) return {text:'New version did not build.', action:null};
    if (notice.code === 'io') return {text:'Update check failed.', action:null};
    return {text:'Update did not finish.', action:['stylesheet', 'drain', 'ack'].includes(notice.code) ? 'retry' : null};
  }
  if (notice.state === 'held' || notice.state === 'deferred') return {text:pausedText(notice.code), action:notice.state === 'deferred' && notice.retryable ? 'retry' : null};
  const labels = {idle:'', applied:'', ready:'Updating', building:'Updating', navigating:'Updating', offline:'Reconnecting updates', 'restart-required':'Restart required', reconnecting:'Reconnecting updates'};
  return {text:labels[notice.state], action:null};
}
export function devReloadPresentation(notice: DevReloadNotice): ReloadPresentation & {detail: string} {
  const error = notice.error;
  const detail = `${notice.state} (${notice.code})${error ? `\nName: ${error.name}\nMessage: ${error.message}\nStack:\n${error.stack || '[not supplied]'}${error.truncated.length ? `\nTruncated fields: ${error.truncated.join(', ')}` : ''}` : ''}`;
  return {...reloadWords(notice), detail};
}
export interface DevReloadHooks {
  /** Revision advances for user interaction, target changes and writes, not restoration itself. */
  interaction(): DevInteraction;
  /** Drain every target's draft, layout, reading and presentation queues. Honor cancellation. */
  drain(signal: AbortSignal): Promise<void>;
  captureCheckpoint(): DevReloadView;
  writeCheckpoint(checkpoint: DevReloadCheckpoint): void;
  readCheckpoint(): unknown;
  /** Verify workspace, target epochs, saved revisions, recipient and newer interaction before focus/range restoration. */
  restoreCheckpoint(checkpoint: DevReloadCheckpoint, signal: AbortSignal): Promise<boolean>;
  clearCheckpoint(): void;
  captureCssState(): unknown;
  /** Invalidate entry heights and preserve anchors, tail intent and user scroll without replacing cards. */
  afterCssApply(state: unknown): void;
  status(notice: DevReloadNotice): void;
}
export type DevStylesheet = {apply(): void; discard(): void};
export interface DevReloadEnvironment {
  meta(name: 'ui-generation' | 'ui-client' | 'ui-module-family'): string | null;
  replaceClient(client: string): void;
  href(): string;
  navigate(url: string): void;
  events(url: string, build: (data: string) => void, lost: () => void): {close(): void};
  fetch(path: string, init: RequestInit): Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
  prepareStylesheet(url: string, signal: AbortSignal): Promise<DevStylesheet>;
  clock: {now(): number; set(callback: () => void, delay: number): number; clear(timer: number): void};
}
const GENERATION = /^[a-f0-9]{64}$/;
const CLIENT = /^[a-f0-9]{24}$/;
const ID = /^[A-Za-z0-9_.:@/-]{1,256}$/;
const RETRIES = [250, 1000, 3000, 6000];
const DEADLINE = 10_000;
const TTL = 15 * 60_000;
const HOLDS: readonly string[] = ['input', 'ime', 'selection', 'resize', 'modal', 'offline', 'conflict', 'uncertain'];
function integer(value: unknown): value is number {return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;}
function id(value: unknown): value is string {return typeof value === 'string' && ID.test(value);}
function record(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return required.every(key => Object.hasOwn(descriptors, key)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && (required.includes(key) || optional.includes(key)) && Object.hasOwn(descriptors[key] ?? {}, 'value'));
}
function filePosition(value:unknown):boolean {
  if (!record(value,['scrollTop','scrollLeft'])) return false;
  return ['scrollTop','scrollLeft'].every(key=>typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1e9);
}
function target(value: unknown): value is DevCheckpointTarget {
  if (record(value, ['kind', 'key', 'epoch']) && value.kind === 'primary') return id(value.key) && integer(value.epoch) && value.epoch > 0;
  if(record(value,['kind','identity','retained'])&&value.kind==='agent'&&id(value.identity)&&value.retained===true)return true;
  return record(value, ['kind', 'identity', 'connectionEpoch']) && value.kind === 'agent' && id(value.identity) && integer(value.connectionEpoch) && value.connectionEpoch > 0;
}
function entry(value: unknown): value is DevCheckpointEntry {
  if (!record(value, ['targetKey', 'target', 'draftRevision', 'imageFingerprint', 'readingRevision', 'presentationRevision'], ['selection'])) return false;
  if (!id(value.targetKey) || !target(value.target) || !integer(value.draftRevision) || !integer(value.readingRevision) || !integer(value.presentationRevision)) return false;
  if (typeof value.imageFingerprint !== 'string' || value.imageFingerprint.length > 8192) return false;
  if (value.selection === undefined) return true;
  return selection(value.selection,262144);
}
function selection(value:unknown,maximum:number):boolean {
  return record(value,['start','end','direction']) && integer(value.start) && integer(value.end) && value.start <= value.end && value.end <= maximum && typeof value.direction === 'string' && ['forward','backward','none'].includes(value.direction);
}
function fileList(value:unknown):value is DevFileCheckpoint[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  return Array.from({length:value.length},(_,index)=>descriptors[String(index)]).every(descriptor=> {
    if (!descriptor || !Object.hasOwn(descriptor,'value')) return false;
    const file:unknown = descriptor.value;
    return record(file,['tab','position','digest','focused'],['selection']) && record(file.tab,['kind','rootId','path'],['view']) && validFileTab(file.tab) && filePosition(file.position) && typeof file.digest === 'string' && GENERATION.test(file.digest) && typeof file.focused === 'boolean' && (file.tab.view === 'preview' ? file.selection === undefined : selection(file.selection,LIMITS.fileTextBytes));
  });
}
function targetList(value: unknown): value is DevCheckpointEntry[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 128) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  return Array.from({length: value.length}, (_, index) => descriptors[String(index)]).every(d => d && Object.hasOwn(d, 'value') && entry(d.value));
}
function control(value: unknown, keys: Set<string>, recipient: unknown): boolean {
  return value === undefined || record(value, ['targetKey', 'kind']) && id(value.targetKey) && keys.has(value.targetKey) &&
    (value.kind === 'composer' || value.kind === 'message' && value.targetKey === recipient);
}
function inspectionList(value:unknown):boolean {
  return value===undefined||Array.isArray(value)&&value.length<=128&&value.every(validInspectionCheckpoint)&&new Set(value.map(item=>item.identity)).size===value.length;
}
function checkpointViews(value:Record<string,unknown>):boolean {
  if(value.composerStateKey!==undefined&&(typeof value.composerStateKey!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.composerStateKey)))return false;
  if(!fileCheckpointState(value.files,value.focusedControl)||!inspectionList(value.inspections))return false;
  const inspections=(value.inspections??[]) as InspectionCheckpoint[];
  return (value.targets as DevCheckpointEntry[]).every(entry=>{const target=entry.target;return target.kind!=='agent'||!('retained' in target)||value.composerStateKey!==undefined||inspections.some(item=>item.identity===target.identity);});
}
function fileCheckpointState(files:unknown,focusedControl:unknown):boolean {
  if (files === undefined) return true;
  if (!fileList(files)) return false;
  if (new Set(files.map(file=>workspaceTabKey(file.tab))).size !== files.length || files.filter(file=>file.focused).length > 1) return false;
  return !files.some(file=>file.focused) || focusedControl === undefined;
}
/** Structural validation does not replace the host's checks against freshly hydrated state. */
export function validateDevReloadCheckpoint(value: unknown, generation: string, now: number): DevReloadCheckpoint | null {
  if (!record(value, ['version', 'generation', 'oldClient', 'capturedAt', 'interactionRevision', 'workspaceId', 'focusedPane', 'targets'], ['focusedControl', 'messageRecipient', 'files', 'inspections', 'composerStateKey'])) return null;
  if (value.version !== 1 || value.generation !== generation || !GENERATION.test(generation) || typeof value.oldClient !== 'string' || !CLIENT.test(value.oldClient)) return null;
  if (!integer(now) || !integer(value.capturedAt) || value.capturedAt > now || now - value.capturedAt > TTL || !integer(value.interactionRevision)) return null;
  if (!id(value.workspaceId) || value.workspaceId.length > 128 || !id(value.focusedPane) || value.focusedPane.length > 128 || !targetList(value.targets)) return null;
  const keys = new Set(value.targets.map(item => item.targetKey));
  const identities = new Set(value.targets.map(item => item.target.kind === 'primary' ? `primary:${item.target.key}` : `agent:${item.target.identity}`));
  if (keys.size !== value.targets.length || identities.size !== value.targets.length) return null;
  if (value.messageRecipient !== undefined && (!id(value.messageRecipient) || !keys.has(value.messageRecipient))) return null;
  if (!checkpointViews(value)) return null;
  if (!control(value.focusedControl, keys, value.messageRecipient) || new TextEncoder().encode(JSON.stringify(value)).length > 16384) return null;
  return JSON.parse(JSON.stringify(value)) as DevReloadCheckpoint;
}
function parseBuild(data: string): DevBuild | null {
  if (data.length > 4096) return null;
  try {
    const v: unknown = JSON.parse(data);
    if (!record(v, ['revision', 'generation', 'previous', 'change', 'status', 'code'])) return null;
    if (!integer(v.revision) || typeof v.generation !== 'string' || !GENERATION.test(v.generation) || !(v.previous === null || typeof v.previous === 'string' && GENERATION.test(v.previous))) return null;
    if (!['css', 'reload'].includes(String(v.change)) || !['ready', 'building', 'failed', 'held', 'restart-required'].includes(String(v.status)) || !['none', 'compile', 'input-changed', 'invalid-assets', 'capacity', 'backend-change', 'io'].includes(String(v.code))) return null;
    return v as DevBuild;
  } catch {return null;}
}
function parseLeaseResult(value: unknown): {lease: 'present' | 'missing'; build: DevBuild} | {lease: 'replaced'; client: string; build: DevBuild} | null {
  if (!record(value, ['ok', 'data']) || value.ok !== true || !record(value.data, ['lease', 'build'], ['client'])) return null;
  const data = value.data, build = parseBuild(JSON.stringify(data.build));
  if (!build) return null;
  if (data.lease === 'replaced') return typeof data.client === 'string' && CLIENT.test(data.client) ? {lease: 'replaced', client: data.client, build} : null;
  return (data.lease === 'present' || data.lease === 'missing') && !Object.hasOwn(data, 'client') ? {lease: data.lease, build} : null;
}
function validPostResult(value: unknown, release: boolean): boolean {
  if (!record(value, ['ok', 'data']) || value.ok !== true) return false;
  if (!release) return !!parseBuild(JSON.stringify(value.data));
  return record(value.data, ['release', 'build']) && ['released', 'absent'].includes(String(value.data.release)) && !!parseBuild(JSON.stringify(value.data.build));
}
class ReloadFailure extends Error {
  code: DevReloadNotice['code'];
  status?: number;
  constructor(code: DevReloadNotice['code'], status?: number, options?: ErrorOptions) {super(code, options); this.code = code; this.status = status;}
}
function isReloadFailure(error: unknown): error is ReloadFailure {
  try {return error instanceof ReloadFailure;} catch {return false;}
}
function exceptionField(error: unknown, field: 'name' | 'message' | 'stack', fallback: string): string {
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      const value: unknown = Reflect.get(error, field); return typeof value === 'string' ? value : fallback;
    }
  } catch {return `[${field} unavailable: property access threw]`;}
  return fallback;
}
/** Only detached bounded strings reach the notice; native DOMException getters remain readable. */
export function devReloadError(thrown: unknown): DevReloadError {
  let error = thrown;
  try {if (thrown instanceof ReloadFailure && Object.hasOwn(thrown, 'cause')) error = thrown.cause;} catch { /* Exotic exceptions still reach the guarded field reads. */ }
  const primitive = error === null || !['object', 'function'].includes(typeof error);
  const result: DevReloadError = {name: exceptionField(error, 'name', 'Thrown value'), message: exceptionField(error, 'message', primitive ? String(error) : '[no string message supplied]'), stack: exceptionField(error, 'stack', ''), truncated: []};
  for (const [field, limit] of [['name', 256], ['message', 4096], ['stack', 16384]] as const) {
    if (result[field].length <= limit) continue;
    let end = limit; const last = result[field].charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    result[field] = result[field].slice(0, end); result.truncated.push(field);
  }
  return result;
}

/** One dev page, one stream and one newest update. Construct only after app hydration. */
export class DevReload {
  readonly ready: Promise<void>;
  readonly active: boolean;
  private hooks: DevReloadHooks;
  private env: DevReloadEnvironment;
  private generation: string;
  private client: string;
  private cssGeneration: string;
  private family: string;
  private source?: {close(): void};
  private sourceToken = 0;
  private linkController?: AbortController;
  private leaseMissing = false;
  private retry?: number;
  private attempts = 0;
  private stopped = false;
  private initialized = false;
  private fatal = false;
  private serial = 0;
  private latest?: DevBuild;
  private controller?: AbortController;
  private work?: Promise<void>;
  private pendingAck = false;
  private ackBlocked = false;
  private acknowledging = false;
  private queued = false;
  constructor(hooks: DevReloadHooks, env: DevReloadEnvironment = browserDevReloadEnvironment()) {
    this.hooks = hooks; this.env = env;
    this.generation = env.meta('ui-generation') ?? ''; this.client = env.meta('ui-client') ?? '';
    this.cssGeneration = this.generation; this.family = env.meta('ui-module-family') ?? '';
    this.active = GENERATION.test(this.generation) && CLIENT.test(this.client) && GENERATION.test(this.family);
    this.ready = this.active ? this.run(signal => this.initialize(signal)) : Promise.resolve();
  }
  private notice(state: DevReloadNotice['state'], code: DevReloadNotice['code'] = 'none', error?: DevReloadError): void {
    if (!this.stopped) {try {this.hooks.status({state, code, retryable: !this.fatal && !this.stopped, ...(error ? {error} : {}), ...(this.latest ? {build: {...this.latest}} : {})});} catch {this.fatal = true;}}
  }
  private current(serial: number, signal: AbortSignal): boolean {return !this.stopped && !signal.aborted && serial === this.serial;}
  private async bounded<T>(promise: Promise<T>, signal: AbortSignal, controller = this.controller): Promise<T> {
    let timer: number | undefined;
    let abort: (() => void) | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
      abort = () => {if (timer !== undefined) this.env.clock.clear(timer); reject(new ReloadFailure('timeout'));};
      signal.addEventListener('abort', abort, {once: true});
      timer = this.env.clock.set(() => {const error = new ReloadFailure('timeout'); this.notice('failed', 'timeout', devReloadError(error));this.retryRecovery(); reject(error); controller?.abort();}, DEADLINE);
      if (signal.aborted) abort();
    });
    try {return await Promise.race([promise, limit]);}
    finally {if (timer !== undefined) this.env.clock.clear(timer); if (abort) signal.removeEventListener('abort', abort);}
  }
  private run(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.work) return this.work;
    const controller = new AbortController(); this.controller = controller;
    const task = Promise.resolve().then(() => this.stopped || controller.signal.aborted ? undefined : action(controller.signal)).catch(error => {
      const known = isReloadFailure(error);
      if (!known) this.fatal = true;
      if (!this.stopped && !controller.signal.aborted) this.notice('failed', known ? error.code : 'host', devReloadError(error));
      if(known&&['ack','drain','stylesheet','offline','capacity','timeout'].includes(error.code))this.retryRecovery();
    }).finally(() => {
      if (this.controller === controller) this.controller = undefined;
      if (this.work === task) this.work = undefined;
      if (this.queued) {this.queued = false; void this.applyLatest();}
    });
    this.work = task; return task;
  }
  private async post(path: '/api/dev/ack' | '/api/dev/release', body: object, signal: AbortSignal): Promise<void> {
    const code = path === '/api/dev/ack' ? 'ack' : 'release';
    try {
    const response = await this.bounded(this.env.fetch(path, {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal}), signal);
    if (!response.ok) throw new ReloadFailure(response.status === 429 ? 'capacity' : code, response.status);
    if (this.stopped || signal.aborted) return;
    const result: unknown = await this.bounded(response.json(), signal);
    if (!validPostResult(result, path === '/api/dev/release')) throw new ReloadFailure(code);
    } catch (error) {throw isReloadFailure(error) ? error : new ReloadFailure(code, undefined, {cause: error});}
  }
  private async ack(signal: AbortSignal): Promise<void> {
    this.acknowledging = true;
    try {
      await this.post('/api/dev/ack', {client: this.client, generation: this.generation, cssGeneration: this.cssGeneration}, signal);
      if (!this.stopped && !signal.aborted) {this.pendingAck = false; this.ackBlocked = false;}
    } catch (error) {this.ackBlocked = true; throw error;}
    finally {this.acknowledging = false;}
  }
  private interaction(revision?: number): DevInteraction | null {
    const state = this.hooks.interaction();
    if (!integer(state.revision) || typeof state.safe !== 'boolean' || state.reason !== undefined && !HOLDS.includes(state.reason)) throw new ReloadFailure('host');
    if (!state.safe || revision !== undefined && state.revision !== revision) {this.notice('deferred', state.reason ?? 'input');this.retryHeldBuild(); return null;}
    return state;
  }
  private retryRecovery():void {
    if(this.retry!==undefined||this.stopped||this.fatal)return;
    const delay=RETRIES[Math.min(this.attempts++,RETRIES.length-1)]??6000;
    this.retry=this.env.clock.set(()=>{this.retry=undefined;void this.resume();},delay);
  }
  private retryHeldBuild():void{
    const build=this.latest;
    if(this.retry!==undefined||this.stopped||this.fatal||!this.initialized||this.ackBlocked||!build||build.status!=='ready'||this.upToDate(build))return;
    this.retry=this.env.clock.set(()=>{this.retry=undefined;if(this.work)this.queued=true;else void this.applyLatest();},250);
  }
  private async initialize(signal: AbortSignal): Promise<void> {
    const raw = this.hooks.readCheckpoint();
    if (raw === null || raw === undefined) await this.initialLease(signal);
    else if (!await this.restore(raw, signal)) return;
    if (this.stopped || signal.aborted || this.fatal) return;
    this.initialized = true; this.notice('idle');
    if(this.leaseMissing)this.queued=true;else this.connect();
  }
  private async initialLease(signal:AbortSignal):Promise<void>{
    this.pendingAck=true;
    try{await this.ack(signal);return;}catch(error){if(!(error instanceof ReloadFailure&&error.status===409))throw error;}
    const controller=this.controller;if(!controller)throw new ReloadFailure('host');
    const result=await this.readLease(controller);if(this.stopped||signal.aborted)return;
    if(result.lease==='missing'){
      this.leaseMissing=true;this.pendingAck=false;this.ackBlocked=false;this.latest=result.build;this.serial++;return;
    }
    if(result.lease==='replaced'){
      if(result.client===this.client)throw new ReloadFailure('invalid-assets');
      this.env.replaceClient(result.client);this.client=result.client;
    }
    await this.ack(signal);
  }
  private async restore(raw: unknown, signal: AbortSignal): Promise<boolean> {
      const checkpoint = validateDevReloadCheckpoint(raw, this.generation, this.env.clock.now());
      const workspace = new URL(this.env.href()).searchParams.get('workspace');
      if (!checkpoint || checkpoint.oldClient === this.client || checkpoint.workspaceId !== workspace) {this.fatal = true; throw new ReloadFailure('checkpoint');}
      const state = this.interaction();
      if (!state) {this.fatal = true; this.notice('failed', 'restore'); return false;}
      this.fatal = true;
      const restored = await this.bounded(this.hooks.restoreCheckpoint(checkpoint, signal), signal);
      if (this.stopped || signal.aborted) return false;
      if (!restored || !this.interaction(state.revision)) {this.fatal = true; throw new ReloadFailure('restore');}
      // A lost release response is not proof of release. Keep the checkpoint and stop automatic updates.
      this.fatal = true;
      await this.ack(signal);
      if (this.stopped || signal.aborted) return false;
      await this.post('/api/dev/release', {client: checkpoint.oldClient}, signal);
      if (this.stopped || signal.aborted) return false;
      this.hooks.clearCheckpoint(); this.fatal = false; return true;
  }
  private closeSource(): void {this.sourceToken++; this.source?.close(); this.source = undefined; this.linkController?.abort(); this.linkController = undefined;}
  private clearRetry(): void {if (this.retry !== undefined) this.env.clock.clear(this.retry); this.retry = undefined;}
  private connect(checkLease = false): void {
    if (this.stopped || !this.initialized || this.fatal) return;
    this.clearRetry(); this.closeSource(); const token = this.sourceToken;
    if (checkLease) {void this.checkLink(token); return;}
    this.openSource(token);
  }
  private async checkLink(token: number): Promise<void> {
    const controller = new AbortController(); this.linkController = controller;
    try {
      const result = await this.readCurrentLease(token, controller);
      if (!result || token !== this.sourceToken || this.stopped || this.fatal) return;
      if (result.lease !== 'missing') {
        if (result.lease === 'replaced') {this.latest = undefined; this.serial++;}
        this.openSource(token); return;
      }
      this.leaseMissing = true; this.pendingAck = false; this.ackBlocked = false;
      this.latest = result.build; this.serial++; if (!this.acknowledging) this.controller?.abort();
      this.notice(result.build.status, result.build.code);
      if (this.work) this.queued = true; else await this.applyLatest();
    } catch (error) {
      if (token === this.sourceToken && !this.stopped && !this.fatal) this.linkFailed(error);
    } finally {if (this.linkController === controller) this.linkController = undefined;}
  }
  private async readCurrentLease(token: number, controller: AbortController): Promise<ReturnType<typeof parseLeaseResult> | undefined> {
    const current = (signal?: AbortSignal) => token === this.sourceToken && !this.stopped && !this.fatal && !controller.signal.aborted && !signal?.aborted;
    while (this.work) {await this.work; if (!current()) return;}
    if (!current()) return;
    let result: ReturnType<typeof parseLeaseResult> | undefined;
    let failure: {error: unknown} | undefined;
    await this.run(async signal => {
      try {
        await this.retryPendingAck(signal);
        if (!current(signal)) return;
        const lease = await this.readLease(controller);
        if (!current(signal)) return;
        result = lease;
        if (result.lease === 'replaced') {
          if (result.client === this.client) throw new ReloadFailure('invalid-assets');
          this.env.replaceClient(result.client); this.client = result.client; this.pendingAck = true;
          await this.ack(signal); if (current(signal)) this.notice('applied');
        }
      }
      catch (error) {failure = {error};}
    });
    if (failure) throw failure.error;
    return result;
  }
  private async retryPendingAck(signal: AbortSignal): Promise<void> {
    if (!this.pendingAck) return;
    try {await this.ack(signal); if (!this.stopped && !signal.aborted) this.notice('applied');}
    catch (error) {
      // Only a refused acknowledgment proceeds to a separate proof of lease absence.
      if (!(error instanceof ReloadFailure && error.status === 409)) throw error;
    }
  }
  private async readLease(controller: AbortController): Promise<NonNullable<ReturnType<typeof parseLeaseResult>>> {
    const {signal} = controller;
    const identity: DevLeaseIdentity = {client: this.client, generation: this.generation, cssGeneration: this.cssGeneration, family: this.family};
    const response = await this.bounded(this.env.fetch('/api/dev/lease', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(identity), signal}), signal, controller);
    if (!response.ok) throw new ReloadFailure(response.status === 429 ? 'capacity' : response.status >= 500 ? 'offline' : 'invalid-assets');
    const result = parseLeaseResult(await this.bounded(response.json(), signal, controller));
    if (!result) throw new ReloadFailure('invalid-assets');
    return result;
  }
  private linkFailed(error: unknown): void {
    const code = isReloadFailure(error) ? error.code : 'offline';
    if (code === 'invalid-assets') {this.fatal = true; this.notice('failed', code, devReloadError(error)); return;}
    this.lost(code, devReloadError(error));
  }
  private openSource(token: number): void {
    if (token !== this.sourceToken || this.stopped || this.fatal) return;
    try {
      this.source = this.env.events(`/api/dev/events?client=${this.client}`, data => {
        if (token !== this.sourceToken || this.stopped) return;
        this.receive(data);
      }, () => {if (token === this.sourceToken && !this.stopped) this.lost();});
      void this.applyLatest();
    } catch (error) {this.lost('offline', devReloadError(error));}
  }
  private lost(code: DevReloadNotice['code'] = 'offline', error?: DevReloadError): void {
    if (this.fatal) return;
    this.closeSource(); this.clearRetry();
    const delay = RETRIES[Math.min(this.attempts++,RETRIES.length-1)]??6000;
    this.notice('reconnecting', code === 'capacity' ? code : 'none', error);
    this.retry = this.env.clock.set(() => {this.retry = undefined; this.connect(true);}, delay);
  }
  private receive(data: string): void {
    if (this.fatal) return;
    const build = parseBuild(data);
    if (!build) {
      this.latest = undefined; this.serial++; this.queued = false;
      if (!this.acknowledging) this.controller?.abort();
      this.closeSource(); this.clearRetry(); this.notice('failed', 'invalid-assets'); return;
    }
    if (this.latest && (build.revision < this.latest.revision || JSON.stringify(build) === JSON.stringify(this.latest))) return;
    this.attempts = 0; this.latest = build; this.serial++;
    if (!this.acknowledging) this.controller?.abort();
    if (!this.ackBlocked) this.notice(build.status, build.code);
    if (this.work) this.queued = true; else void this.applyLatest();
  }
  private applyLatest(): Promise<void> {
    if (!this.active || this.stopped || this.fatal || !this.initialized || this.work || this.ackBlocked) return this.work ?? Promise.resolve();
    const build = this.latest;
    if (!build || build.status !== 'ready' && !this.leaseMissing) return Promise.resolve();
    const serial = this.serial;
    return this.run(async signal => {
      if (this.pendingAck) await this.ack(signal);
      if (!this.current(serial, signal)) return;
      if (this.upToDate(build)) {this.notice('idle'); return;}
      const state = this.interaction(); if (!state) return;
      if (build.change === 'css' && !this.leaseMissing) await this.css(build, state.revision, serial, signal);
      else await this.reload(build, state.revision, serial, signal);
    });
  }
  private upToDate(build: DevBuild): boolean {
    if (this.leaseMissing) return false;
    return build.generation === this.cssGeneration;
  }
  private async css(build: DevBuild, revision: number, serial: number, signal: AbortSignal): Promise<void> {
    const loading = this.env.prepareStylesheet(`/_ui/${build.generation}/style.css`, signal).then(candidate => {
      if (!this.current(serial, signal)) candidate.discard();
      return candidate;
    });
    let candidate: DevStylesheet;
    try {candidate = await this.bounded(loading, signal);} catch (error) {if (this.current(serial, signal)) this.notice('failed', 'stylesheet', devReloadError(error)); return;}
    if (!this.current(serial, signal)) {candidate.discard(); return;}
    try {
      if (!this.interaction(revision)) return;
      const geometry = this.hooks.captureCssState();
      if (!this.current(serial, signal) || !this.interaction(revision)) return;
      candidate.apply(); this.cssGeneration = build.generation; this.pendingAck = true;
      this.hooks.afterCssApply(geometry);
      await this.ack(signal);
      if (this.current(serial, signal)) this.notice('applied');
    } finally {candidate.discard();}
  }
  private async reload(build: DevBuild, revision: number, serial: number, signal: AbortSignal): Promise<void> {
    try {await this.bounded(this.hooks.drain(signal), signal);} catch (error) {if (this.current(serial, signal)) {this.notice('failed', 'drain', devReloadError(error));this.retryRecovery();} return;}
    if (!this.current(serial, signal) || !this.interaction(revision)) return;
    const view = this.hooks.captureCheckpoint();
    if (!record(view, ['workspaceId', 'focusedPane', 'targets'], ['focusedControl', 'messageRecipient', 'files', 'inspections', 'composerStateKey'])) {this.notice('failed', 'checkpoint'); return;}
    const checkpoint = validateDevReloadCheckpoint({...view, version: 1, generation: build.generation, oldClient: this.client, capturedAt: this.env.clock.now(), interactionRevision: revision}, build.generation, this.env.clock.now());
    const workspace = new URL(this.env.href()).searchParams.get('workspace');
    if (!checkpoint || checkpoint.workspaceId !== workspace) {this.notice('failed', 'checkpoint'); return;}
    try {this.hooks.writeCheckpoint(checkpoint);} catch (error) {this.notice('failed', 'storage', devReloadError(error)); return;}
    if (!this.current(serial, signal) || !this.interaction(revision)) return;
    const url = new URL('/', this.env.href()); url.searchParams.set('generation', build.generation); url.searchParams.set('workspace', checkpoint.workspaceId);
    this.notice('navigating');
    if (!this.current(serial, signal) || !this.interaction(revision)) return;
    this.env.navigate(url.href); this.stop();
  }
  /** Host safe points and explicit acknowledgment recovery share the same guarded update path. */
  async resume(): Promise<void> {
    if (!this.active || this.stopped || this.fatal) return;
    if (this.work) {this.queued = true; await this.work; return;}
    this.ackBlocked = false;
    if (!this.initialized) {await this.run(signal => this.initialize(signal)); return;}
    if (this.pendingAck) await this.run(signal => this.ack(signal));
    await this.applyLatest();
  }
  reconnect(): void {if (!this.active || this.stopped || this.fatal) return; this.attempts = 0; this.connect(true);}
  private stop(): void {this.stopped = true; this.serial++; this.closeSource(); this.clearRetry(); this.controller?.abort();}
  /** The host calls this only for a known abandoned page, not transient stream loss or reload navigation. */
  destroy(): void {
    if (this.stopped) return;
    this.stop();
    if (this.active) {
      try {void this.env.fetch('/api/dev/release', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({client: this.client}), keepalive: true}).catch(() => {});}
      catch { /* Abandonment cleanup never prevents local disposal. */ }
    }
  }
}

/** Browser effects are deferred until the coordinator validates both dev metadata tags. */
export function browserDevReloadEnvironment(): DevReloadEnvironment {
  return {
    meta: name => typeof document === 'undefined' ? null : document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null,
    replaceClient: client => {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="ui-client"]');
      if (!meta) throw new ReloadFailure('host');
      meta.content = client;
    },
    href: () => location.href, navigate: url => location.assign(url),
    events: (url, build, lost) => {
      const source = new EventSource(url);
      source.addEventListener('build', (event: MessageEvent<string>) => build(event.data));
      source.onerror = lost; return source;
    },
    fetch: (path, init) => fetch(path, init),
    prepareStylesheet: (url, signal) => prepareBrowserStylesheet(document, location.href, url, signal),
    clock: {now: () => Date.now(), set: (callback, delay) => window.setTimeout(callback, delay), clear: timer => window.clearTimeout(timer)},
  };
}
function prepareBrowserStylesheet(doc: Document, href: string, path: string, signal: AbortSignal): Promise<DevStylesheet> {
  const url = new URL(path, href);
  const old = [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find(link => {
    const current = new URL(link.href, href);
    return current.origin === url.origin && /^\/_ui\/[a-f0-9]{64}\/style\.css$/.test(current.pathname) && !current.search && !current.hash && link.media !== 'not all';
  });
  if (!old?.parentNode || url.origin !== new URL(href).origin) return Promise.reject(new ReloadFailure('stylesheet'));
  const candidate = old.cloneNode(false) as HTMLLinkElement;
  const media = old.media; candidate.href = url.href; candidate.media = 'not all';
  return new Promise((resolve, reject) => {
    let applied = false;
    const discard = () => {if (!applied) candidate.remove();};
    const cleanup = () => {candidate.onload = null; candidate.onerror = null; signal.removeEventListener('abort', abort);};
    const abort = () => {cleanup(); discard(); reject(new ReloadFailure('stylesheet'));};
    candidate.onload = () => {
      cleanup();
      if (signal.aborted) {discard(); reject(new ReloadFailure('stylesheet')); return;}
      resolve({apply: () => {if (signal.aborted || !old.isConnected) throw new ReloadFailure('stylesheet'); candidate.media = media; old.remove(); applied = true;}, discard});
    };
    candidate.onerror = abort; signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort(); else old.after(candidate);
  });
}
