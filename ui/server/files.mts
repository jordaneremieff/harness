import {Worker} from 'node:worker_threads';
import {LIMITS, type Retry} from '../shared/api.ts';
import {ApiError} from './errors.mts';
export type FileJob = {kind:'open'; directory:string} | {kind:'selection'; workspace:string} |
  {kind:'select'; workspace:string; path:string; expectedRevision:number} |
  {kind:'directory'; rootId:string; path:string; limit:number; cursor?:string} |
  {kind:'text'; rootId:string; path:string} | {kind:'close'};
export class FileResponse {
  readonly json:string;readonly status:number;
  constructor(json:string,status:number) {this.json = json;this.status = status;}
}
type Reply = {id:number; json:string; status:number};
type Pending = {resolve:(value:FileResponse)=>void; reject:(error:unknown)=>void; clear:()=>void};
/** Deadlines end responses, not work ownership. Dispatched work retains admission until settlement. */
export class Files {
  private pending = new Map<number,Pending>();
  private serial = 0;
  private stopped = false;
  private failure?:Error;
  private closing?:Promise<void>;
  private exited:Promise<void>;
  private worker:Worker;
  constructor(options:{worker?:Worker; deadlineMs?:number} = {}) {
    this.worker = options.worker ?? new Worker(new URL('./files-worker.mts',import.meta.url));
    this.deadlineMs = options.deadlineMs ?? LIMITS.fileReadMs;
    this.worker.on('message',(reply:Reply)=> {
      const pending = this.pending.get(reply.id); if (!pending) return;
      this.pending.delete(reply.id); pending.clear();
      if (typeof reply.json !== 'string' || Buffer.byteLength(reply.json) > LIMITS.fileResponseBytes || !Number.isInteger(reply.status)) pending.reject(new ApiError('file_unavailable','The file response is invalid.',503,'read'));
      else pending.resolve(new FileResponse(reply.json,reply.status));
    });
    this.worker.on('error',error=>this.fail(error));
    this.exited = new Promise(resolve=>this.worker.once('exit',()=> {this.fail(new Error('File worker exited.'));resolve();}));
  }
  private deadlineMs:number;
  static async open(directory:string) {
    const files = new Files();
    try {const response = await files.request({kind:'open',directory}); const result = JSON.parse(response.json); if (!result.ok) throw new ApiError(result.error.code,result.error.message,response.status,result.error.retry as Retry); return files;}
    catch (error) {await files.close(); throw error;}
  }
  request(job:FileJob, signal?:AbortSignal):Promise<FileResponse> {
    if (this.stopped || this.failure) return Promise.reject(new ApiError('file_unavailable','File access is unavailable.',503,'read'));
    if (signal?.aborted) return Promise.reject(new ApiError('file_unavailable','The file request ended.',408,'read'));
    if (this.pending.size >= LIMITS.filePending) return Promise.reject(new ApiError('capacity','The file read queue is full.',429,'read'));
    return this.dispatch(job,signal);
  }
  private dispatch(job:FileJob, signal?:AbortSignal):Promise<FileResponse> {
    const id = ++this.serial;
    return new Promise((resolve,reject)=> {
      const expired = () => reject(new ApiError('file_unavailable','The file read did not complete. Refresh to retry.',408,'read'));
      const timer = job.kind === 'close' ? undefined : setTimeout(expired,this.deadlineMs); timer?.unref();
      const abort = () => reject(new ApiError('file_unavailable','The file request ended.',408,'read'));
      signal?.addEventListener('abort',abort,{once:true});
      const clear = () => {clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      this.pending.set(id,{resolve,reject,clear});
      try {this.worker.postMessage({id,job});} catch (error) {this.pending.delete(id);clear();reject(error);}
    });
  }
  private fail(error:Error) {
    this.failure = error;
    for (const pending of this.pending.values()) {pending.clear();pending.reject(new ApiError('file_unavailable','File access is unavailable.',503,'read'));}
    this.pending.clear();
  }
  close():Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = (async()=> {try {if (!this.failure) await this.dispatch({kind:'close'});} finally {await this.exited;}})();
    return this.closing;
  }
}
