import {parentPort} from 'node:worker_threads';
import {LIMITS} from '../shared/api.ts';
import {FileState} from './file-state.mts';
import {directoryPage, fileFailure, readText} from './file-access.mts';
import {ApiError, errorView} from './errors.mts';
import type {FileJob} from './files.mts';
let state:FileState|undefined;
async function execute(job:FileJob):Promise<unknown> {
  if (job.kind === 'open') {state = new FileState(job.directory); await state.load(); return null;}
  if (job.kind === 'close') return null;
  if (!state) throw new ApiError('not_ready','File access is not ready.',503);
  if (job.kind === 'selection') return state.selection(job.workspace);
  if (job.kind === 'select') return state.select(job.workspace,job.path,job.expectedRevision);
  const root = state.root(job.rootId);
  return job.kind === 'directory' ? directoryPage(root,job.path,job.limit,job.cursor) : readText(root,job.path);
}
let tail = Promise.resolve();
parentPort?.on('message',({id,job}:{id:number;job:FileJob})=> {
  tail = tail.then(async()=> {
    let json:string, status = 200;
    try {json = JSON.stringify({ok:true,data:await execute(job)}); if (Buffer.byteLength(json) > LIMITS.fileResponseBytes) throw new ApiError('payload_too_large','The file response exceeds its bound.',413);}
    catch (error) {const failure = fileFailure(error); status = failure.status; json = JSON.stringify({ok:false,error:errorView(failure)});}
    parentPort?.postMessage({id,json,status});
    if (job.kind === 'close') parentPort?.close();
  });
});
