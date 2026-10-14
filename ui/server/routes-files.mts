import {LIMITS} from '../shared/api.ts';
import type {HttpBackend, RequestContext} from './http.mts';
import type {Files} from './files.mts';
import {filePath} from './file-access.mts';
import {ApiError} from './errors.mts';
import {validateFileRevision, validateFileDraftText, validateFileEncoding} from './file-state.mts';
import * as v from './validate.mts';
export function isFileRoute(parts:string[]):boolean {return parts[1] === 'files' || parts[1] === 'workspaces' && parts[3] === 'files';}
function queryFields(url:URL,allowed:string[]):void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new ApiError('invalid_request','The file query has unknown or repeated fields.');
}
async function rootRequest(files:Files,backend:HttpBackend,context:RequestContext) {
  const {parts,method,body,url,signal} = context;
  queryFields(url,['workspace']);
  if (context.operationId) throw new ApiError('invalid_request','Working-folder requests do not accept an operation key.');
  const id = v.string(parts[2],'workspace ID');
  const query = url.searchParams.get('workspace');
  if (query !== null && v.string(query,'workspace ID') !== id) throw new ApiError('invalid_request','The workspace query does not match the route.');
  const workspace = await backend.workspace(id);
  if (method === 'GET') return files.request({kind:'selection',workspace},signal);
  if (method === 'PUT') {
    v.fields(body,['path','expectedRevision'],['path','expectedRevision']);
    return files.request({kind:'select',workspace,path:v.string(body.path,'working folder',LIMITS.pathChars),expectedRevision:v.integer(body.expectedRevision,'file selection revision')},signal);
  }
  throw new ApiError('invalid_request','The file route does not accept this request.',405);
}
function directoryRequest(files:Files,rootId:string,path:string,url:URL,signal?:AbortSignal) {
  const raw = url.searchParams.get('limit'), limit = raw === null ? LIMITS.filePageItems : Number(raw);
  if (raw !== null && !/^[1-9][0-9]{0,2}$/.test(raw) || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.filePageItems) throw new ApiError('invalid_request','The directory page size is invalid.');
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && (!cursor || cursor.length > LIMITS.cursorBytes)) throw new ApiError('invalid_request','The directory cursor is invalid.');
  return files.request({kind:'directory',rootId,path,limit,...(cursor ? {cursor} : {})},signal);
}
function mutationRequest(files:Files,rootId:string,path:string,context:RequestContext) {
  const {parts,method,body,signal} = context;
  if (method === 'PUT' && parts[4] === 'draft') {
    v.fields(body,['expectedRevision','base','text','encoding'],['expectedRevision','base','text','encoding']);validateFileRevision(body.base);validateFileDraftText(body.text);validateFileEncoding(body.encoding);
    return files.request({kind:'put-draft',rootId,path,expectedRevision:v.integer(body.expectedRevision,'file draft revision'),base:body.base,text:body.text,encoding:body.encoding},signal);
  }
  if (method === 'PUT' && parts[4] === 'text') {
    v.fields(body,['expectedRevision'],['expectedRevision']);return files.request({kind:'save',rootId,path,expectedRevision:v.integer(body.expectedRevision,'file draft revision')},signal);
  }
  throw new ApiError('invalid_request','The file route does not accept this request.',405);
}
export async function dispatchFiles(files:Files,backend:HttpBackend,context:RequestContext) {
  const {parts,method,url,signal} = context;
  if (parts[1] === 'workspaces' && parts.length === 5 && parts[3] === 'files' && parts[4] === 'root') return rootRequest(files,backend,context);
  if (parts[1] === 'files' && parts[2] === 'roots' && parts.length === 5 && (parts[4] === 'directory' || parts[4] === 'text' || parts[4] === 'draft')) {
    queryFields(url,parts[4] === 'directory' ? ['path','workspace','limit','cursor'] : ['path','workspace']);
    if (context.operationId) throw new ApiError('invalid_request','File requests do not accept an operation key.');
    await backend.workspace(v.string(url.searchParams.get('workspace'),'workspace ID'));
    const rootId = v.string(parts[3],'root ID'), path = filePath(url.searchParams.get('path'),parts[4] === 'directory');
    if (method === 'GET') {
      if (parts[4] === 'text' || parts[4] === 'draft') return files.request({kind:parts[4],rootId,path},signal);
      return directoryRequest(files,rootId,path,url,signal);
    }
    return mutationRequest(files,rootId,path,context);
  }
  throw new ApiError('invalid_request','The file route does not accept this request.',405);
}
