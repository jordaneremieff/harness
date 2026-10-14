import {parentPort} from 'node:worker_threads';
import {LIMITS} from '../shared/api.ts';
import {FileState} from './file-state.mts';
import {directoryPage, fileFailure, readText} from './file-access.mts';
import {ApiError, errorView,fileIdentityUncertain} from './errors.mts';
import type {FileJob} from './files.mts';
import {FileWatches} from './file-watch.mts';
let state:FileState|undefined, watches:FileWatches|undefined;
async function execute(job:FileJob):Promise<unknown> {
  if (job.kind === 'open') {const loaded = new FileState(job.directory);await loaded.load();state = loaded;watches = new FileWatches(id=>loaded.root(id),(change,workspace)=>parentPort?.postMessage({change,workspace}));return null;}
  if (job.kind === 'close') {watches?.close();return null;}
  if (!state || !watches) throw new ApiError('not_ready','File access is not ready.',503);
  if (job.kind === 'selection') return state.selection(job.workspace);
  if (job.kind === 'select') return state.select(job.workspace,job.path,job.expectedRevision);
  if (job.kind === 'draft') return state.draft(job.rootId,job.path);
  if (job.kind === 'put-draft') return state.putDraft(job.rootId,job.path,job.expectedRevision,job.base,job.text,job.encoding);
  if (job.kind === 'save') return state.saveDraft(job.rootId,job.path,job.expectedRevision);
  if (job.kind === 'watch') return watches.replace(job.workspace,job.clientId,job.roots);
  if (job.kind === 'watch-state') return watches.state(job.workspace,job.clientId);
  if (job.kind === 'unwatch') {await watches.release(job.workspace,job.clientId);return null;}
  if (job.kind === 'move') return moveEntry(state,watches,job);
  if (job.kind === 'create') {watches.assertMove(job.rootId,'',job.path);return state.create(job.rootId,job.path,job.entryKind);}
  if (job.kind === 'trash') return state.trash(job.rootId,job.path);
  return accessEntry(state,job);
}
async function moveEntry(state:FileState,watches:FileWatches,job:Extract<FileJob,{kind:'move'}>) {
  watches.assertMove(job.rootId,job.from,job.to);const result = await state.move(job.rootId,job.from,job.to);
  try {await watches.moved(job.rootId,job.from,job.to);} catch {state.poisonIdentity();throw fileIdentityUncertain();}return result;
}
function accessEntry(state:FileState,job:Extract<FileJob,{kind:'directory'|'text'}>) {
  const root = state.root(job.rootId);
  return job.kind === 'directory' ? directoryPage(root,job.path,job.limit,job.cursor) : readText(root,job.path);
}
let tail = Promise.resolve();
parentPort?.on('message',({id,job}:{id:number;job:FileJob})=> {
  tail = tail.then(async()=> {
    let json:string, status = 200,identityFailure = false,effected = false;
    try {const data = await execute(job);effected = ['move','create','trash','save'].includes(job.kind);json = JSON.stringify({ok:true,data});if (Buffer.byteLength(json) > LIMITS.fileResponseBytes) throw new ApiError('payload_too_large','The file response exceeds its bound.',413);}
    catch (error) {
      let failure = fileFailure(error);
      if (effected) {state?.poisonIdentity();failure = fileIdentityUncertain();}
      identityFailure = failure.code === 'file_identity_uncertain';status = failure.status;json = JSON.stringify({ok:false,error:errorView(failure)});
    }
    parentPort?.postMessage({id,json,status,identityFailure});
    if (job.kind === 'close') parentPort?.close();
  });
});
