import {Worker} from 'node:worker_threads';
import {LIMITS, type Retry} from '../shared/api.ts';
import {ApiError,fileIdentityUncertain} from './errors.mts';
import {movedFilePath, type FileRevision, type FileEncoding, type FileWatchScope, type FileChanges} from '../shared/files.ts';
export type FileJob = {kind:'open'; directory:string} | {kind:'roots'} | {kind:'selection'; workspace:string} |
  {kind:'select'; workspace:string; path:string; expectedRevision:number} |
  {kind:'directory'; rootId:string; path:string; limit:number; cursor?:string} |
  {kind:'search'; rootId:string; query:string} | {kind:'text'; rootId:string; path:string} | {kind:'draft'; rootId:string; path:string} |
  {kind:'put-draft'; rootId:string; path:string; expectedRevision:number; base:FileRevision; text:string; encoding:FileEncoding} |
  {kind:'save'; rootId:string; path:string; expectedRevision:number} |
  {kind:'watch'; workspace:string; clientId:string; roots:FileWatchScope[]} | {kind:'watch-state';workspace:string;clientId:string} | {kind:'unwatch';workspace:string;clientId:string} |
  {kind:'create';rootId:string;path:string;entryKind:'file'|'directory'} | {kind:'move';rootId:string;from:string;to:string} |
  {kind:'trash';rootId:string;path:string} | {kind:'close'};
export class FileResponse {
  readonly json:string;readonly status:number;
  constructor(json:string,status:number) {this.json = json;this.status = status;}
}
type Reply = {id:number; json:string; status:number; identityFailure?:boolean};
type Pending = {resolve:(value:FileResponse)=>void; reject:(error:unknown)=>void; clear:()=>void;effect:boolean};
/** Read deadlines retain job ownership. An uncertain mutation permanently stops the file worker. */
export class Files {
  private pending = new Map<number,Pending>();
  private serial = 0;
  private stopped = false;
  private opened = false;
  private poisoned = false;
  private failure?:Error;
  private closing?:Promise<void>;
  private exited!:Promise<void>;
  private worker:Worker;
  private directory?:string;
  private restarting?:Promise<void>;
  private attempts = 0;
  private factory:()=>Worker;
  private listeners = new Set<(change:FileChanges,workspace:string)=>void>();
  private watching = new Map<string,Map<string,FileWatchScope[]>>();
  get available():boolean {return this.opened && !this.stopped && !this.failure && !this.restarting;}
  observe(listener:(change:FileChanges,workspace:string)=>void):()=>void {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  constructor(options:{worker?:Worker; workerFactory?:()=>Worker; deadlineMs?:number; identityFailed?:()=>void} = {}) {
    this.identityFailed = options.identityFailed;
    this.factory = options.workerFactory ?? (()=>new Worker(new URL('./files-worker.mts',import.meta.url)));
    this.worker = options.worker ?? this.factory();
    this.deadlineMs = options.deadlineMs ?? LIMITS.fileReadMs;
    this.bind(this.worker);
  }
  private bind(worker:Worker):void {
    worker.on('message',(reply:Reply & {change?:FileChanges;workspace?:string})=> {
      if (this.worker !== worker || this.failure) return;
      if (reply.change && typeof reply.workspace === 'string') {this.change(reply.change,reply.workspace);return;}
      const pending = this.pending.get(reply.id); if (!pending) return;
      this.pending.delete(reply.id); pending.clear();this.resolveReply(pending,reply);
    });
    worker.on('error',error=> {if (this.worker === worker) this.fail(error);});
    this.exited = new Promise(resolve=>worker.once('exit',()=> {if (this.worker === worker) this.fail(new Error('File worker exited.'));resolve();}));
  }
  private change(change:FileChanges,workspace:string):void {
    const move = change.move;
    if (move) for (const root of [...this.watching.values()].flatMap(clients=>[...clients.values()].flat()).filter(root=>root.rootId === change.rootId)) {
      root.directories = root.directories.map(path=>movedFilePath(path,move.from,move.to));
      root.files = root.files.map(path=>movedFilePath(path,move.from,move.to));
    }
    if (!this.stopped) for (const listener of this.listeners) listener(change,workspace);
  }
  private deadlineMs:number;
  private identityFailed?:(()=>void);
  static async open(directory:string,identityFailed?:()=>void) {
    const files = new Files({identityFailed});
    try {files.check(await files.request({kind:'open',directory}));return files;}
    catch (error) {await files.close(); throw error;}
  }
  private check(response:FileResponse):void {
    const result = JSON.parse(response.json);
    if (!result.ok) throw new ApiError(result.error.code,result.error.message,response.status,result.error.retry as Retry);
  }
  request(job:FileJob, signal?:AbortSignal):Promise<FileResponse> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.stopped || this.restarting) return Promise.reject(new ApiError('file_unavailable','File access is unavailable.',503,'read'));
    if (signal?.aborted) return Promise.reject(new ApiError('file_unavailable','The file request ended.',408,'read'));
    if (this.pending.size >= LIMITS.filePending) return Promise.reject(new ApiError('capacity','The file read queue is full.',429,'read'));
    const worker = this.worker;
    const roots = job.kind === 'watch' ? structuredClone(job.roots) : undefined;
    const response = this.dispatch(job,['move','create','trash','save'].includes(job.kind) ? undefined : signal);
    void response.then(value=> {
      if (this.worker !== worker || this.failure || this.stopped || value.status !== 200) return;
      if (job.kind === 'open') {this.directory = job.directory;this.opened = true;}
      if (job.kind === 'watch' && roots) {const clients = this.watching.get(job.workspace) ?? new Map<string,FileWatchScope[]>();clients.set(job.clientId,roots);this.watching.set(job.workspace,clients);}
      if (job.kind === 'unwatch') this.forgetWatch(job.workspace,job.clientId);
    }).catch(()=>{});
    return response;
  }
  poisonIdentity():void {this.fail(fileIdentityUncertain());}
  private forgetWatch(workspace:string,clientId:string):void {
    const clients = this.watching.get(workspace);clients?.delete(clientId);if (!clients?.size) this.watching.delete(workspace);
  }
  releaseWatch(workspace:string,clientId:string):void {
    if (this.failure || this.restarting || this.stopped) {this.forgetWatch(workspace,clientId);return;}
    void this.request({kind:'unwatch',workspace,clientId}).catch(()=> {this.fail(new Error('Watch cleanup did not complete.'));this.forgetWatch(workspace,clientId);});
  }
  /** Browser departure does not cancel an identity job; its service deadline still applies. */
  settled(job:Extract<FileJob,{kind:'move'}>):Promise<FileResponse> {return this.request(job);}
  private dispatch(job:FileJob, signal?:AbortSignal):Promise<FileResponse> {
    const id = ++this.serial;
    return new Promise((resolve,reject)=> {
      const effect = ['move','create','trash','save'].includes(job.kind);
      const expired = () => {if (effect) this.fail(fileIdentityUncertain());else reject(new ApiError('file_unavailable','The file read did not complete. Refresh to retry.',408,'read'));};
      const timer = job.kind === 'close' ? undefined : setTimeout(expired,this.deadlineMs); timer?.unref();
      const abort = () => reject(new ApiError('file_unavailable','The file request ended.',408,'read'));
      signal?.addEventListener('abort',abort,{once:true});
      const clear = () => {clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      this.pending.set(id,{resolve,reject,clear,effect});
      try {this.worker.postMessage({id,job});} catch {this.fail(effect ? fileIdentityUncertain() : new Error('File worker is unavailable.'));}
    });
  }
  private resolveReply(pending:Pending,reply:Reply) {
    if (typeof reply.json !== 'string' || Buffer.byteLength(reply.json) > LIMITS.fileResponseBytes || !Number.isInteger(reply.status)) {
      if (pending.effect) {pending.reject(fileIdentityUncertain());this.fail(fileIdentityUncertain());}
      else pending.reject(new ApiError('file_unavailable','The file response is invalid.',503,'read'));
    } else {pending.resolve(new FileResponse(reply.json,reply.status));if (reply.identityFailure) this.fail(fileIdentityUncertain());}
  }
  private publishUnavailable() {
    if (!this.stopped) for (const [workspace,clients] of this.watching) for (const rootId of new Set([...clients.values()].flat().map(root=>root.rootId))) for (const listener of this.listeners) listener({rootId,directories:[],files:[],rescan:false,watch:'unavailable',reason:'Live files are unavailable. Refresh files explicitly.'},workspace);
  }
  private fail(error:Error) {
    const uncertain = error instanceof ApiError && error.code === 'file_identity_uncertain' || [...this.pending.values()].some(pending=>pending.effect);
    if (uncertain && !this.poisoned) {this.poisoned = true;this.identityFailed?.();}
    if (this.failure) {if (this.poisoned) this.failure = fileIdentityUncertain();return;}
    this.opened = false;
    const failure = this.poisoned ? fileIdentityUncertain() : new ApiError('file_unavailable','File access is unavailable.',503,'read');
    this.failure = failure;
    this.publishUnavailable();
    for (const pending of this.pending.values()) {pending.clear();pending.reject(failure);}
    this.pending.clear();
    void this.worker.terminate().catch(()=>{});
    this.scheduleRecovery();
  }
  private scheduleRecovery():void {
    if (!this.stopped && !this.poisoned && this.directory && !this.restarting && this.attempts < 3) {
      this.restarting = Promise.resolve().then(()=>this.recover()).finally(()=> {
        this.restarting = undefined;if (this.failure) this.scheduleRecovery();
      });
    }
  }
  private async recover():Promise<void> {
    const directory = this.directory;if (!directory) return;
    while (!this.stopped && !this.poisoned && this.attempts < 3) {
      await this.exited;
      if (this.stopped || this.poisoned) return;
      this.attempts++;
      try {
        const worker = this.factory();if (worker === this.worker) throw new Error('File replacement requires a new worker.');
        this.worker = worker;this.failure = undefined;this.bind(worker);
        this.check(await this.dispatch({kind:'open',directory}));
        await this.restoreWatches();
        if (!this.stopped && !this.poisoned && !this.failure) {this.opened = true;return;}
      } catch {this.fail(new Error('File worker recovery failed.'));}
    }
  }
  private async restoreWatches():Promise<void> {
    for (const [workspace,clients] of this.watching) for (const [clientId,roots] of clients) {
      if (this.stopped || this.poisoned || this.failure) throw new Error('File recovery ended.');
      this.check(await this.dispatch({kind:'watch',workspace,clientId,roots}));
      if (clients.get(clientId) !== roots) this.check(await this.dispatch({kind:'unwatch',workspace,clientId}));
    }
  }
  close():Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = (async()=> {
      try {
        if (this.restarting) {this.fail(new Error('File service closed.'));await this.restarting;}
        else if (!this.failure) await this.dispatch({kind:'close'});
      } finally {await this.exited;this.listeners.clear();this.watching.clear();}
    })();
    return this.closing;
  }
}
