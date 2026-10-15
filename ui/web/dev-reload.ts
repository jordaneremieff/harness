import {validFileTab, workspaceTabKey, type FileTab, type FilePosition} from '../shared/api.ts';
export type DevFileCheckpoint = {tab:FileTab;position:FilePosition;digest:string;focused:boolean};
export type DevBuild = {
  revision: number; generation: string; previous: string | null;
  change: 'css' | 'reload'; status: 'ready' | 'building' | 'failed' | 'held' | 'restart-required';
  code: 'none' | 'compile' | 'input-changed' | 'invalid-assets' | 'capacity' | 'backend-change' | 'io';
};
export type DevReloadHold = 'input' | 'ime' | 'selection' | 'resize' | 'modal' | 'offline' | 'auth' | 'conflict' | 'uncertain';
export type DevInteraction = {revision: number; safe: boolean; reason?: DevReloadHold};
export type DevCheckpointTarget =
  | {kind: 'primary'; key: string; epoch: number}
  | {kind: 'agent'; identity: string; connectionEpoch: number};
export type DevCheckpointEntry = {
  targetKey: string; target: DevCheckpointTarget; draftRevision: number; imageFingerprint: string; readingRevision: number; presentationRevision: number;
  selection?: {start: number; end: number; direction: 'forward' | 'backward' | 'none'};
};
export type DevReloadView = {
  workspaceId: string; focusedPane: string; targets: DevCheckpointEntry[]; messageRecipient?: string;
  focusedControl?: {targetKey: string; kind: 'composer' | 'message'}; files?:DevFileCheckpoint[];
};
export type DevReloadCheckpoint = DevReloadView & {
  version: 1; generation: string; oldClient: string; capturedAt: number; interactionRevision: number;
};
export type DevReloadNotice = {
  retryable: boolean;
  state: DevBuild['status'] | 'idle' | 'deferred' | 'reconnecting' | 'offline' | 'auth' | 'applied' | 'navigating';
  code: DevBuild['code'] | DevReloadHold | 'checkpoint' | 'restore' | 'storage' | 'stylesheet' | 'drain' | 'timeout' | 'ack' | 'release' | 'host';
  build?: DevBuild;
};
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
  meta(name: 'ui-generation' | 'ui-client'): string | null;
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
const HOLDS: readonly string[] = ['input', 'ime', 'selection', 'resize', 'modal', 'offline', 'auth', 'conflict', 'uncertain'];
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
  return record(value, ['kind', 'identity', 'connectionEpoch']) && value.kind === 'agent' && id(value.identity) && integer(value.connectionEpoch) && value.connectionEpoch > 0;
}
function entry(value: unknown): value is DevCheckpointEntry {
  if (!record(value, ['targetKey', 'target', 'draftRevision', 'imageFingerprint', 'readingRevision', 'presentationRevision'], ['selection'])) return false;
  if (!id(value.targetKey) || !target(value.target) || !integer(value.draftRevision) || !integer(value.readingRevision) || !integer(value.presentationRevision)) return false;
  if (typeof value.imageFingerprint !== 'string' || value.imageFingerprint.length > 8192) return false;
  if (value.selection === undefined) return true;
  const s = value.selection;
  return record(s, ['start', 'end', 'direction']) && integer(s.start) && integer(s.end) && s.start <= s.end && s.end <= 262144 && typeof s.direction === 'string' && ['forward', 'backward', 'none'].includes(s.direction);
}
function fileList(value:unknown):value is DevFileCheckpoint[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  return Array.from({length:value.length},(_,index)=>descriptors[String(index)]).every(descriptor=> {
    if (!descriptor || !Object.hasOwn(descriptor,'value')) return false;
    const file:unknown = descriptor.value;
    return record(file,['tab','position','digest','focused']) && record(file.tab,['kind','rootId','path'],['view']) && validFileTab(file.tab) && filePosition(file.position) && typeof file.digest === 'string' && GENERATION.test(file.digest) && typeof file.focused === 'boolean';
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
function fileCheckpointState(files:unknown,focusedControl:unknown):boolean {
  if (files === undefined) return true;
  if (!fileList(files)) return false;
  if (new Set(files.map(file=>workspaceTabKey(file.tab))).size !== files.length || files.filter(file=>file.focused).length > 1) return false;
  return !files.some(file=>file.focused) || focusedControl === undefined;
}
/** Structural validation does not replace the host's checks against freshly hydrated state. */
export function validateDevReloadCheckpoint(value: unknown, generation: string, now: number): DevReloadCheckpoint | null {
  if (!record(value, ['version', 'generation', 'oldClient', 'capturedAt', 'interactionRevision', 'workspaceId', 'focusedPane', 'targets'], ['focusedControl', 'messageRecipient', 'files'])) return null;
  if (value.version !== 1 || value.generation !== generation || !GENERATION.test(generation) || typeof value.oldClient !== 'string' || !CLIENT.test(value.oldClient)) return null;
  if (!integer(now) || !integer(value.capturedAt) || value.capturedAt > now || now - value.capturedAt > TTL || !integer(value.interactionRevision)) return null;
  if (!id(value.workspaceId) || value.workspaceId.length > 128 || !id(value.focusedPane) || value.focusedPane.length > 128 || !targetList(value.targets)) return null;
  const keys = new Set(value.targets.map(item => item.targetKey));
  const identities = new Set(value.targets.map(item => item.target.kind === 'primary' ? `primary:${item.target.key}` : `agent:${item.target.identity}`));
  if (keys.size !== value.targets.length || identities.size !== value.targets.length) return null;
  if (value.messageRecipient !== undefined && (!id(value.messageRecipient) || !keys.has(value.messageRecipient))) return null;
  if (!fileCheckpointState(value.files,value.focusedControl)) return null;
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
class ReloadFailure extends Error {
  code: DevReloadNotice['code'];
  constructor(code: DevReloadNotice['code']) {super(code); this.code = code;}
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
  private source?: {close(): void};
  private sourceToken = 0;
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
    this.cssGeneration = this.generation;
    this.active = GENERATION.test(this.generation) && CLIENT.test(this.client);
    this.ready = this.active ? this.run(signal => this.initialize(signal)) : Promise.resolve();
  }
  private notice(state: DevReloadNotice['state'], code: DevReloadNotice['code'] = 'none'): void {
    if (!this.stopped) {try {this.hooks.status({state, code, retryable: !this.fatal && !this.stopped, ...(this.latest ? {build: {...this.latest}} : {})});} catch {this.fatal = true;}}
  }
  private current(serial: number, signal: AbortSignal): boolean {return !this.stopped && !signal.aborted && serial === this.serial;}
  private async bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let timer: number | undefined;
    let abort: (() => void) | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
      abort = () => {if (timer !== undefined) this.env.clock.clear(timer); reject(new ReloadFailure('timeout'));};
      signal.addEventListener('abort', abort, {once: true});
      timer = this.env.clock.set(() => {this.notice('failed', 'timeout'); reject(new ReloadFailure('timeout')); this.controller?.abort();}, DEADLINE);
      if (signal.aborted) abort();
    });
    try {return await Promise.race([promise, limit]);}
    finally {if (timer !== undefined) this.env.clock.clear(timer); if (abort) signal.removeEventListener('abort', abort);}
  }
  private run(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.work) return this.work;
    const controller = new AbortController(); this.controller = controller;
    const task = Promise.resolve().then(() => this.stopped || controller.signal.aborted ? undefined : action(controller.signal)).catch(error => {
      if (!(error instanceof ReloadFailure)) this.fatal = true;
      if (!this.stopped && !controller.signal.aborted) this.notice(error instanceof ReloadFailure && error.code === 'auth' ? 'auth' : 'failed', error instanceof ReloadFailure ? error.code : 'host');
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
    if (!response.ok) throw new ReloadFailure(response.status === 401 ? 'auth' : code);
    if (this.stopped || signal.aborted) return;
    const result: unknown = await this.bounded(response.json(), signal);
    if (!record(result, ['ok', 'data']) || result.ok !== true || !parseBuild(JSON.stringify(result.data))) throw new ReloadFailure(code);
    } catch (error) {throw error instanceof ReloadFailure ? error : new ReloadFailure(code);}
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
    if (!state.safe || revision !== undefined && state.revision !== revision) {this.notice('deferred', state.reason ?? 'input'); return null;}
    return state;
  }
  private async initialize(signal: AbortSignal): Promise<void> {
    const raw = this.hooks.readCheckpoint();
    if (raw === null || raw === undefined) {this.pendingAck = true; await this.ack(signal);}
    else if (!await this.restore(raw, signal)) return;
    if (this.stopped || signal.aborted || this.fatal) return;
    this.initialized = true; this.notice('idle'); this.connect();
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
  private closeSource(): void {this.sourceToken++; this.source?.close(); this.source = undefined;}
  private clearRetry(): void {if (this.retry !== undefined) this.env.clock.clear(this.retry); this.retry = undefined;}
  private connect(): void {
    if (this.stopped || !this.initialized || this.fatal) return;
    this.clearRetry(); this.closeSource(); const token = this.sourceToken;
    try {
      this.source = this.env.events(`/api/dev/events?client=${this.client}`, data => {
        if (token !== this.sourceToken || this.stopped) return;
        this.receive(data);
      }, () => {if (token === this.sourceToken && !this.stopped) this.lost();});
    } catch {this.lost();}
  }
  private lost(): void {
    this.closeSource(); this.clearRetry();
    const delay = RETRIES[this.attempts++];
    if (delay === undefined) {this.notice('offline', 'offline'); return;}
    this.notice('reconnecting');
    this.retry = this.env.clock.set(() => {this.retry = undefined; this.connect();}, delay);
  }
  private receive(data: string): void {
    const build = parseBuild(data);
    if (!build) {
      this.latest = undefined; this.serial++; this.queued = false;
      if (!this.acknowledging) this.controller?.abort();
      this.closeSource(); this.clearRetry(); this.notice('failed', 'invalid-assets'); return;
    }
    if (this.latest && (build.revision < this.latest.revision || JSON.stringify(build) === JSON.stringify(this.latest))) return;
    this.attempts = 0; this.latest = build; this.serial++;
    if (!this.acknowledging) this.controller?.abort();
    this.notice(build.status, build.code);
    if (this.work) this.queued = true; else void this.applyLatest();
  }
  private applyLatest(): Promise<void> {
    if (!this.active || this.stopped || this.fatal || !this.initialized || this.work || this.ackBlocked) return this.work ?? Promise.resolve();
    const build = this.latest;
    if (build?.status !== 'ready') return Promise.resolve();
    const serial = this.serial;
    return this.run(async signal => {
      if (this.pendingAck) await this.ack(signal);
      if (!this.current(serial, signal)) return;
      if (build.generation === this.cssGeneration && build.change === 'css' || build.generation === this.generation && build.change === 'reload') return;
      const state = this.interaction(); if (!state) return;
      if (build.change === 'css') await this.css(build, state.revision, serial, signal);
      else await this.reload(build, state.revision, serial, signal);
    });
  }
  private async css(build: DevBuild, revision: number, serial: number, signal: AbortSignal): Promise<void> {
    const loading = this.env.prepareStylesheet(`/_ui/${build.generation}/style.css`, signal).then(candidate => {
      if (!this.current(serial, signal)) candidate.discard();
      return candidate;
    });
    let candidate: DevStylesheet;
    try {candidate = await this.bounded(loading, signal);} catch {if (this.current(serial, signal)) this.notice('failed', 'stylesheet'); return;}
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
    try {await this.bounded(this.hooks.drain(signal), signal);} catch {if (this.current(serial, signal)) this.notice('failed', 'drain'); return;}
    if (!this.current(serial, signal) || !this.interaction(revision)) return;
    const view = this.hooks.captureCheckpoint();
    if (!record(view, ['workspaceId', 'focusedPane', 'targets'], ['focusedControl', 'messageRecipient', 'files'])) {this.notice('failed', 'checkpoint'); return;}
    const checkpoint = validateDevReloadCheckpoint({...view, version: 1, generation: build.generation, oldClient: this.client, capturedAt: this.env.clock.now(), interactionRevision: revision}, build.generation, this.env.clock.now());
    const workspace = new URL(this.env.href()).searchParams.get('workspace');
    if (!checkpoint || checkpoint.workspaceId !== workspace) {this.notice('failed', 'checkpoint'); return;}
    try {this.hooks.writeCheckpoint(checkpoint);} catch {this.notice('failed', 'storage'); return;}
    if (!this.current(serial, signal) || !this.interaction(revision)) return;
    const url = new URL('/', this.env.href()); url.searchParams.set('generation', build.generation); url.searchParams.set('workspace', checkpoint.workspaceId);
    this.notice('navigating');
    if (!this.current(serial, signal) || !this.interaction(revision)) return;
    this.env.navigate(url.href); this.stop();
  }
  /** Retry a held update or uncertain CSS acknowledgment only on an explicit safe-point notification. */
  async resume(): Promise<void> {
    if (!this.active || this.stopped || this.fatal) return;
    if (this.work) {this.queued = true; await this.work; return;}
    this.ackBlocked = false;
    if (!this.initialized) {await this.run(signal => this.initialize(signal)); return;}
    if (this.pendingAck) await this.run(signal => this.ack(signal));
    await this.applyLatest();
  }
  reconnect(): void {if (!this.active || this.stopped || this.fatal) return; this.attempts = 0; this.connect();}
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
