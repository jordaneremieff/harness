import type { DialogResponse, HandoffRequest, PrimaryControl, SessionAction, Target } from '../shared/api.ts';
import type { Registry } from './registry.mts';
import type { RequestContext } from './http.mts';
import { ApiError } from './errors.mts';
import { execute } from './dispatch.mts';
import { projectJson } from './projection.mts';
import { decodeHistoryCursor, pageEntries } from './history.mts';
import { StateError } from './state.mts';
import * as v from './validate.mts';

export async function dispatchPrimary(registry: Registry, context: RequestContext) {
  const {body,parts,method,url} = context; const workspace = await registry.workspace(context.workspace);
  if(parts.length === 2) return open(registry,context,workspace);
  const key = v.string(parts[2],'primary key');
  if(method === 'GET') return read(registry,key,parts,url);
  const epoch = v.integer(body.epoch,'epoch'); const target: Target = {kind:'primary',key,epoch};
  const action = parts[3];
  if(action === 'inputs') return input(registry,context,workspace,target);
  const kind = action === 'dialogs' ? 'primary.dialog' : action === 'stop' ? 'primary.stop' : action === 'session' ? 'primary.session' : action === 'handoff' ? 'primary.handoff' : 'primary.control';
  validateMutation(action,body);
  return execute(registry,context.operationId,{workspaceId:workspace,kind,target,body},async()=> {
    const session = registry.primary(key,epoch,true); registry.queueWorkspaces.set(key,workspace); let result: unknown;
    if(action === 'stop') result = await session.stop();
    else if(action === 'session') result = await transition(registry,session,key,body);
    else if(action === 'control') result = await control(session,body as PrimaryControl);
    else if(action === 'dialogs') { await session.respond(v.string(parts[4],'dialog ID'),body as DialogResponse); result={responded:true}; }
    else if(action === 'handoff') result = await session.handoff(body as HandoffRequest);
    else throw new ApiError('invalid_request','The primary action does not exist.',404);
    return {state:'completed',receipt:{kind:'rpc',result:projectJson(result ?? null)}};
  });
}
async function transition(registry: Registry, session: ReturnType<Registry['primary']>, key: string, body: Record<string,unknown>) {
  let claimed: string | undefined;
  const previous = session.view.sessionFile;
  if(body.action === 'resume') { claimed = await registry.validatePath(v.string(body.sessionFile,'session file',4096),false); await registry.claimPath(claimed,key); }
  try {
    const result = await session.transition({...body,...(claimed?{sessionFile:claimed}:{})} as SessionAction);
    if(previous && previous !== session.view.sessionFile) registry.releasePath(previous,key);
    return result;
  } finally { if(claimed && session.view.sessionFile !== claimed) registry.releasePath(claimed,key); }
}
async function control(session: ReturnType<Registry['primary']>, body: PrimaryControl) {
  if(body.action === 'resync') { await session.resynchronize(); return {synchronized:true}; }
  return session.control(body);
}
async function open(registry: Registry, context: RequestContext, workspace: string) {
  const {body} = context; v.fields(body,['cwd','sessionFile','writerReleased'],['cwd']);
  const cwd = await registry.validatePath(v.string(body.cwd,'project path',4096),true);
  const sessionFile = body.sessionFile === undefined ? undefined : await registry.validatePath(v.string(body.sessionFile,'session file',4096),false);
  if(sessionFile && body.writerReleased !== true) throw new ApiError('invalid_request','Confirm that no terminal or other writer owns this saved session.');
  const operation = await execute(registry,context.operationId,{workspaceId:workspace,kind:'primary.open',body},async()=> {
    const primaryKey = await registry.openPrimary(cwd,sessionFile,workspace);
    const current = await registry.store.workspace(workspace);
    const view = registry.primary(primaryKey).view;
    await registry.store.updateSelection(workspace,{expectedRevision:current.revision,primaryKey,selectedTarget:{kind:'primary',key:primaryKey,epoch:view.epoch}});
    await registry.store.target(workspace,{kind:'primary',key:primaryKey,epoch:view.epoch});
    return {state:'completed',receipt:{kind:'rpc',result:{value:{primaryKey},truncated:false}}};
  });
  const value = operation.receipt?.kind === 'rpc' ? operation.receipt.result?.value : undefined;
  const primaryKey = value && typeof value === 'object' && 'primaryKey' in value ? value.primaryKey : undefined;
  return {operationId:operation.id,primaryKey,operation};
}
function read(registry: Registry,key: string,parts: string[],url: URL) {
  const view = registry.sessions.get(key)?.view ?? registry.saved.get(key);
  if(!view) throw new ApiError('invalid_request','The primary does not exist.',404);
  if(parts.length === 3) return structuredClone(view);
  const session = registry.primary(key);
  if(parts[3] === 'history') {
    if(parts.length === 4) return readHistory(session,url);
    if(parts.length !== 5 || parts[4] !== 'output') throw new ApiError('invalid_request','The history read route does not exist.',404);
    if ([...url.searchParams.keys()].some(name => !['epoch','entry','part','offset','workspace'].includes(name))) throw new ApiError('invalid_request','The output request fields are invalid.');
    const integer = (name: string) => { const value = url.searchParams.get(name); if (value === null || !/^\d+$/.test(value)) throw new ApiError('invalid_request',`The ${name} is invalid.`); return v.integer(Number(value),name); };
    registry.primary(key,integer('epoch'),true);
    const part = integer('part'); if (part >= 100) throw new ApiError('invalid_request','The output part is invalid.');
    return session.historyOutput(v.string(url.searchParams.get('entry'),'entry'),part,integer('offset'));
  }
  if(parts[3] === 'diagnostics') return {stderr:projectJson(session.stderrTail),error:session.view.lastError};
  if(parts[3] !== 'resources') throw new ApiError('invalid_request','The primary read route does not exist.',404);
  return readResources(session,key,parts,url);
}
async function readHistory(session: ReturnType<Registry['primary']>,url: URL) {
  const cursor=v.cursor(url.searchParams.get('cursor')); const limit=v.limit(url); const target=session.target;
  try { return pageEntries(session.entries,target,session.coverage,{cursor,limit}); }
  catch(error) {
    if(!(error instanceof StateError) || error.code!=='history_limit' || !cursor) throw error;
    const {before}=decodeHistoryCursor(cursor,target);
    const window=await session.historyWindow(before);
    return pageEntries(window.entries,target,window.coverage,{limit});
  }
}
function readResources(session: ReturnType<Registry['primary']>,key: string,parts: string[],url: URL) {
  const kind = v.choice(parts[4],['commands','models','thinking'],'resource kind');
  const source = kind === 'commands' ? session.commands : kind === 'models' ? session.models : session.thinking;
  const cursor = v.cursor(url.searchParams.get('cursor')); let start=0;
  if(cursor) {
    let decoded: {key: string; kind: string; revision: number; offset: number};
    try { decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); } catch {throw new ApiError('invalid_request','The resource cursor is invalid.');}
    if(decoded.key!==key || decoded.kind!==kind || decoded.revision!==session.resourcesRevision || !Number.isSafeInteger(decoded.offset) || decoded.offset<0 || decoded.offset>source.length) throw new ApiError('stale_revision','The resource cache changed.',409,'read');
    start=decoded.offset;
  }
  const items=source.slice(start,start+v.limit(url)); const end=start+items.length;
  return {items,nextCursor:end<source.length?Buffer.from(JSON.stringify({key,kind,revision:session.resourcesRevision,offset:end})).toString('base64url'):null,revision:String(session.resourcesRevision)};
}
async function input(registry: Registry, context: RequestContext, workspace: string, target: Target & {kind:'primary'}) {
  const {body} = context; v.fields(body,['epoch','message','mode','draftRevision','literal'],['epoch','message','mode','draftRevision']);
  const message=v.text(body.message); const mode=v.choice(body.mode,['prompt','steer','followUp'],'input mode'); const draftRevision=v.integer(body.draftRevision,'draft revision');
  if(body.literal!==undefined) v.boolean(body.literal,'literal flag');
  const state=await registry.store.target(workspace,target);
  return execute(registry,context.operationId,{workspaceId:workspace,kind:'primary.input',target,body,input:{targetKey:state.targetKey,text:message,mode,draftRevision}},async()=> {
    const session=registry.primary(target.key,target.epoch,true);
    const result=await session.input(message,mode,body.literal===true) as {disposition:'started'|'queued'|'handled'};
    return {state:'accepted',receipt:{kind:'rpc',disposition:result.disposition,result:projectJson(result)}};
  });
}
function validateMutation(action: string | undefined,body: Record<string,unknown>) {
  if(action==='stop') {v.fields(body,['epoch'],['epoch']);return;}
  if(action==='session') {validateSession(body);return;}
  if(action==='handoff') {v.fields(body,['epoch','mode','clearQueue'],['epoch','mode','clearQueue']);v.choice(body.mode,['settle','abort'],'handoff mode');v.boolean(body.clearQueue,'queue choice');return;}
  if(action==='dialogs') {v.fields(body,['epoch','value','confirmed','cancelled'],['epoch']); if(['value','confirmed','cancelled'].filter(key=>key in body).length!==1) throw new ApiError('invalid_request','The dialog response is invalid.');return;}
  if(action==='control') {validateControl(body);return;}
  throw new ApiError('invalid_request','The primary action does not exist.',404);
}
function validateSession(body: Record<string,unknown>) {
  const selected=v.choice(body.action,['new','resume','fork'],'session action');
  v.fields(body,['epoch','action',...(selected==='resume'?['sessionFile','writerReleased']:selected==='fork'?['entryId']:[])],['epoch','action']);
  if(selected==='resume' && body.writerReleased!==true) throw new ApiError('invalid_request','Confirm that no other writer owns this saved session.');
  if(selected==='resume') v.string(body.sessionFile,'session file',4096);
  if(selected==='fork') v.string(body.entryId,'entry ID');
}
function validateControl(body: Record<string,unknown>) {
  const action=v.choice(body.action,['model','thinking','compact','autoCompaction','autoRetry','abortRetry','name','stats','export','resync'],'control action');
  const extra=controlFields(action);
  v.fields(body,['epoch','action',...extra],['epoch','action']);
  validateControlValues(action,body);
}
function controlFields(action: string) {
  if(action==='model') return ['provider','modelId'];
  if(action==='thinking') return ['level'];
  if(action==='compact') return ['customInstructions'];
  if(action==='autoCompaction'||action==='autoRetry') return ['enabled'];
  if(action==='name') return ['name'];
  return [];
}
function validateControlValues(action: string,body: Record<string,unknown>) {
  if(action==='model') {v.string(body.provider,'provider');v.string(body.modelId,'model ID');}
  if(action==='thinking') v.string(body.level,'thinking level');
  if(action==='compact' && body.customInstructions!==undefined) v.text(body.customInstructions,true);
  if(action==='autoCompaction'||action==='autoRetry') v.boolean(body.enabled,'enabled flag');
  if(action==='name') v.text(body.name,true);
}
