import {LIMITS} from '../shared/api.ts';
import type {HttpBackend, RequestContext} from './http.mts';
import type {Files,FileResponse} from './files.mts';
import {filePath} from './file-access.mts';
import {searchQuery} from './file-search.mts';
import {ApiError} from './errors.mts';
import {validateFileRevision, validateFileDraftText, validateFileEncoding} from './file-state.mts';
import * as v from './validate.mts';
import type {FileWatchScope, FileMutation} from '../shared/files.ts';
import {dirname} from 'node:path';
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
function watchScope(value:unknown):FileWatchScope[] {
  if (!Array.isArray(value) || value.length > LIMITS.fileRoots) throw new ApiError('invalid_request','The watch scope is invalid.');
  return value.map(raw=> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('invalid_request','The watch root is invalid.');
    v.fields(raw,['rootId','directories','files'],['rootId','directories','files']);
    if (!Array.isArray(raw.directories) || !Array.isArray(raw.files) || raw.directories.length > LIMITS.fileWatchDirectories || raw.files.length > LIMITS.fileWatchFiles) throw new ApiError('capacity','The live-file scope exceeds its bound.',429,'read');
    return {rootId:v.string(raw.rootId,'root ID'),directories:raw.directories.map((path:unknown)=>filePath(path)),files:raw.files.map((path:unknown)=>filePath(path,false))};
  });
}
export function fileWatchClientId(value:unknown):string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new ApiError('invalid_request','The page scope ID is invalid.');return value;
}
async function watchRequest(files:Files,backend:HttpBackend,context:RequestContext) {
  queryFields(context.url,context.method === 'GET' ? ['workspace','clientId'] : ['workspace']);if (context.operationId) throw new ApiError('invalid_request','File requests do not accept an operation key.');
  const workspace = v.string(context.parts[2],'workspace ID'), query = context.url.searchParams.get('workspace');
  if (query !== null && query !== workspace) throw new ApiError('invalid_request','The workspace query does not match the route.');
  await backend.workspace(workspace);
  if (context.method !== 'GET' && context.method !== 'PUT') throw new ApiError('invalid_request','The watch route does not accept this request.',405);
  if (context.method === 'PUT') v.fields(context.body,['clientId','roots'],['clientId','roots']);
  const clientId = fileWatchClientId(context.method === 'GET' ? context.url.searchParams.get('clientId') : context.body.clientId);
  if (!backend.journal.hasClient(workspace,clientId)) throw new ApiError('file_unavailable','The page update stream is not active. Reconnect it before file watches.',503,'read');
  if (context.method === 'GET') return files.request({kind:'watch-state',workspace,clientId},context.signal);
  return files.request({kind:'watch',workspace,clientId,roots:watchScope(context.body.roots)},context.signal);
}
function moveRequest(files:Files,backend:HttpBackend,rootId:string,body:Record<string,unknown>) {
  v.fields(body,['from','to'],['from','to']);const from = filePath(body.from,false),to = filePath(body.to,false);
  if (!backend.moveFiles) throw new ApiError('not_ready','Workspace file moves are unavailable.',503,'read');
  return backend.moveFiles(rootId,from,to,async()=> {
    const response = await files.settled({kind:'move',rootId,from,to}),result = JSON.parse(response.json);
    if (!result.ok) throw new ApiError(result.error.code,result.error.message,response.status,result.error.retry);
    return result.data as FileMutation;
  }).catch(error=> {if (error?.code === 'file_identity_uncertain') files.poisonIdentity();throw error;});
}
async function createRequest(files:Files,backend:HttpBackend,rootId:string,body:Record<string,unknown>) {
  v.fields(body,['path','kind'],['path','kind']);if (body.kind !== 'file' && body.kind !== 'directory') throw new ApiError('invalid_request','The entry kind is invalid.');
  const path = filePath(body.path,false),entryKind = body.kind;
  if (!backend.createFiles) throw new ApiError('not_ready','Workspace file creation is unavailable.',503);
  const created = await backend.createFiles(rootId,path,async()=> {
    const reply = await files.request({kind:'create',rootId,path,entryKind}),result = JSON.parse(reply.json);
    if (!result.ok) throw new ApiError(result.error.code,result.error.message,reply.status,result.error.retry);return result.data as FileMutation;
  }).catch(error=> {if (error?.code === 'file_identity_uncertain') files.poisonIdentity();throw error;});
  const parent = dirname(created.path);backend.journal.publish('files.changed',undefined,{rootId,directories:[parent === '.' ? '' : parent],files:[created.path],rescan:false,watch:'live'});
  return created;
}
async function treeRequest(files:Files,backend:HttpBackend,context:RequestContext) {
  const {parts,method,url,body,signal} = context;queryFields(url,parts[4] === 'entry' ? ['workspace','path'] : ['workspace']);
  if (context.operationId) throw new ApiError('invalid_request','File requests do not accept an operation key.');
  await backend.workspace(v.string(url.searchParams.get('workspace'),'workspace ID'));const rootId = v.string(parts[3],'root ID');
  if (parts[4] === 'move' && method === 'POST') return moveRequest(files,backend,rootId,body);
  let response:FileResponse;
  if (parts[4] === 'entries' && method === 'POST') return createRequest(files,backend,rootId,body);
  if (parts[4] === 'entry' && method === 'DELETE') {v.fields(body,[],[]);response = await files.request({kind:'trash',rootId,path:filePath(url.searchParams.get('path'),false)},signal);}
  else throw new ApiError('invalid_request','The file route does not accept this request.',405);
  const result = JSON.parse(response.json);
  if (result.ok) {const value = result.data as FileMutation, parent = dirname(value.path);backend.journal.publish('files.changed',undefined,{rootId,directories:[parent === '.' ? '' : parent],files:[value.path],rescan:false,watch:'live'});}
  return response;
}
async function readRequest(files:Files,backend:HttpBackend,context:RequestContext) {
  const {parts,method,url,signal} = context;queryFields(url,parts[4] === 'directory' ? ['path','workspace','limit','cursor'] : parts[4] === 'search' ? ['q','workspace'] : ['path','workspace']);
  if (context.operationId) throw new ApiError('invalid_request','File requests do not accept an operation key.');
  await backend.workspace(v.string(url.searchParams.get('workspace'),'workspace ID'));
  if (parts[4] === 'search') {
    if (method !== 'GET') throw new ApiError('invalid_request','The file route does not accept this request.',405);
    return files.request({kind:'search',workspace:v.string(url.searchParams.get('workspace'),'workspace ID'),rootId:v.string(parts[3],'root ID'),query:searchQuery(url.searchParams.get('q') ?? '')},signal);
  }
  const rootId = v.string(parts[3],'root ID'),path = filePath(url.searchParams.get('path'),parts[4] === 'directory');
  if (method !== 'GET') return mutationRequest(files,rootId,path,context);
  if (parts[4] === 'text' || parts[4] === 'draft') return files.request({kind:parts[4],rootId,path},signal);
  return directoryRequest(files,rootId,path,url,signal);
}
export async function dispatchFiles(files:Files,backend:HttpBackend,context:RequestContext) {
  const {parts} = context;
  if (parts.length !== 5) throw new ApiError('invalid_request','The file route does not accept this request.',405);
  if (parts[1] === 'workspaces' && parts[3] === 'files') {
    if (parts[4] === 'watch') return watchRequest(files,backend,context);
    if (parts[4] === 'root') return rootRequest(files,backend,context);
  }
  if (parts[1] === 'files' && parts[2] === 'roots') {
    if (['entries','move','entry'].includes(parts[4] ?? '')) return treeRequest(files,backend,context);
    if (['directory','text','draft','search'].includes(parts[4] ?? '')) return readRequest(files,backend,context);
  }
  throw new ApiError('invalid_request','The file route does not accept this request.',405);
}
