import {isAbsolute,resolve,join} from 'node:path';
import type {PrimaryView,SessionMetadata,SessionMetadataRecord,SessionMetadataTarget} from '../shared/api.ts';
import type {Registry} from './registry.mts';
import type {RequestContext} from './http.mts';
import {ApiError} from './errors.mts';
import {execute} from './dispatch.mts';
import {validateSessionProject} from './sessions.mts';
import {readRecord,readClaim} from '../agents/catalog-record.mts';
import * as v from './validate.mts';

type MetadataAction='rename'|'archive'|'restore';
type MetadataResolution={canonical:SessionMetadataTarget;primary?:PrimaryView;stale:boolean};
function parseMetadataTarget(value:unknown):SessionMetadataTarget {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new ApiError('invalid_request','The session identity is invalid.');
  const row=value as Record<string,unknown>;
  if(row.kind==='primary') {v.fields(row,['kind','key','epoch'],['kind','key','epoch']);return {kind:'primary',key:v.string(row.key,'primary key'),epoch:v.integer(row.epoch,'epoch',1)};}
  if(row.kind==='agent') {v.fields(row,['kind','identity'],['kind','identity']);return {kind:'agent',identity:v.string(row.identity,'agent identity',512)};}
  v.fields(row,['kind','id','path','project'],['kind','id','path','project']);
  if(row.kind!=='session')throw new ApiError('invalid_request','The session identity is invalid.');
  const path=v.string(row.path,'session path',4096),project=v.string(row.project,'project path',4096);
  if(!isAbsolute(path)||!isAbsolute(project))throw new ApiError('invalid_request','The session paths must be absolute.');
  return {kind:'session',id:v.string(row.id,'session ID',512),path:resolve(path),project:resolve(project)};
}
function primaryMetadataTarget(view:PrimaryView):SessionMetadataTarget {
  return view.sessionId && view.sessionFile ? {kind:'session',id:view.sessionId,path:resolve(view.sessionFile),project:resolve(view.cwd)} : {kind:'primary',key:view.key,epoch:view.epoch};
}
function sessionMetadataKey(value:SessionMetadataTarget):string {
  return value.kind==='session'?JSON.stringify(['session',value.id,value.path,value.project]):value.kind==='agent'?JSON.stringify(['agent',value.identity]):JSON.stringify(['primary',value.key,value.epoch]);
}
function resolveMetadataTarget(registry:Registry,value:SessionMetadataTarget):MetadataResolution {
  const views=registry.views();
  if(value.kind==='primary') {
    const primary=views.find(view=>view.key===value.key);
    return primary?.epoch===value.epoch?{canonical:primaryMetadataTarget(primary),primary,stale:false}:{canonical:value,stale:true};
  }
  const primary=value.kind==='session'?views.find(view=>sessionMetadataKey(primaryMetadataTarget(view))===sessionMetadataKey(value)):undefined;
  return {canonical:value,...(primary?{primary}:{}),stale:false};
}
function sessionMetadataAliases(value:SessionMetadataTarget,primary?:PrimaryView,stale=false):string[] {
  return [...(primary?[`primary:${primary.key}`]:[]),...(value.kind==='session'?[`path:${value.path}`,`id:${value.id}`]:value.kind==='agent'?[`agent:${value.identity}`]:!stale&&!primary?[`primary:${value.key}`]:[])];
}
async function agentArchiveReason(registry:Registry,identity:string):Promise<string|undefined> {
  try {
    const {record}=await readRecord(join(registry.options.agentStore,'durable'),identity.split(':')[0] as string);
    if(!record.view?.rows.some(row=>row.id===identity))return 'Session state unavailable.';
    const claim=await readClaim(record);
    return claim.state==='absent'||claim.state==='dead'?undefined:claim.state==='live'?'Stop this session before archiving.':'Session state unavailable.';
  } catch {return 'Session state unavailable.';}
}
async function metadataArchiveReason(registry:Registry,found:MetadataResolution):Promise<string|undefined> {
  const value=found.canonical;
  if(found.stale)return 'Session state unavailable.';
  if(found.primary&&!registry.metadataPrimaryStopped(found.primary.key))return 'Stop this session before archiving.';
  if(value.kind==='session'&&await registry.metadataFileHeld(value.id,value.path))return 'Stop this session before archiving.';
  if(value.kind==='agent')return agentArchiveReason(registry,value.identity);
  return undefined;
}
function sessionMetadataTitle(values:(string|undefined)[]):string {
  return values.find(value=>value?.trim())?.trim().split(/\r?\n/,1)[0]?.slice(0,240)||'Untitled session';
}
async function readSessionMetadata(registry:Registry,input:SessionMetadataTarget):Promise<SessionMetadata> {
  const found=resolveMetadataTarget(registry,input),value=found.canonical;
  const saved=registry.store.getSessionMetadata(sessionMetadataKey(value));
  const agent=value.kind==='agent'?registry.agents.rosterRow(value.identity):undefined;
  const known=value.kind!=='agent'||!!agent||!!saved,reason=await metadataArchiveReason(registry,found);
  const name=saved?.name,title=sessionMetadataTitle([name,saved?.title,found.primary?.sessionName,agent?.name,agent?.firstMessage]);
  const archived=saved?.archived??false;
  return {target:found.primary?{kind:'primary',key:found.primary.key,epoch:found.primary.epoch}:value,aliases:sessionMetadataAliases(value,found.primary,found.stale),...(name?{name}:{}),title,archived,canRename:known&&!found.stale,canArchive:known&&!archived&&!reason,canRestore:archived,...(reason?{reason}:{})};
}
async function listSessionMetadata(registry:Registry):Promise<{items:SessionMetadata[]}> {
  const targets=new Map<string,SessionMetadataTarget>();
  for(const record of registry.store.readSessionMetadata())targets.set(record.key,record.target);
  for(const view of registry.views())targets.set(sessionMetadataKey(primaryMetadataTarget(view)),{kind:'primary',key:view.key,epoch:view.epoch});
  const items:SessionMetadata[]=[];
  for(const value of targets.values())items.push(await readSessionMetadata(registry,value));
  return {items};
}
async function validateMetadataSession(registry:Registry,found:MetadataResolution,action:MetadataAction):Promise<void> {
  const value=found.canonical;
  if(value.kind!=='session'||found.primary)return;
  if(action!=='archive'&&registry.store.getSessionMetadata(sessionMetadataKey(value)))return;
  if(await validateSessionProject(value.project,value.path)!==value.id)throw new ApiError('invalid_session','The saved session identity changed.',409,'read');
}
async function admitSessionMetadata(registry:Registry,selected:SessionMetadataTarget,expected:string,action:MetadataAction):Promise<void> {
  if(action==='archive') {
    const reason=await metadataArchiveReason(registry,resolveMetadataTarget(registry,selected));
    if(reason)throw new ApiError('not_ready',reason,409,'read');
  }
  const now=resolveMetadataTarget(registry,selected);
  if(sessionMetadataKey(now.canonical)!==expected||now.stale&&action!=='restore')throw new ApiError('stale_epoch','The session identity changed.',409,'read');
  if(action==='archive'&&now.primary&&!registry.metadataPrimaryStopped(now.primary.key))throw new ApiError('not_ready','Stop this session before archiving.',409,'read');
}
async function mutateSessionMetadata(registry:Registry,context:RequestContext):Promise<unknown> {
  const {body}=context,action=v.choice(body.action,['rename','archive','restore'],'metadata action');
  v.fields(body,['target','action','title',...(action==='rename'?['name']:[])],['target','action',...(action==='rename'?['name']:[])]);
  const title=body.title===undefined?undefined:v.string(body.title,'session caption',240).trim();
  const selected=parseMetadataTarget(body.target),name=action==='rename'?v.string(body.name,'session name',240).trim():undefined;
  if(name!==undefined&&!name)throw new ApiError('invalid_request','The session name must not be empty.');
  const workspace=await registry.workspace(context.workspace);
  return execute(registry,context.operationId,{workspaceId:workspace,kind:'session.metadata',body},async()=>{
    const before=await readSessionMetadata(registry,selected),found=resolveMetadataTarget(registry,selected),canonical=found.canonical;
    const permitted={rename:before.canRename,archive:before.canArchive,restore:before.canRestore}[action];
    if(!permitted)throw new ApiError('not_ready',before.reason??'The session action is unavailable.',409,'read');
    await validateMetadataSession(registry,found,action);
    const label=name??before.name;
    const record:SessionMetadataRecord={key:sessionMetadataKey(canonical),target:canonical,title:before.name??(title||before.title),archived:action==='rename'?before.archived:action==='archive',...(label?{name:label}:{})};
    await registry.store.putSessionMetadata(record,action,()=>admitSessionMetadata(registry,selected,record.key,action));
    const result=await readSessionMetadata(registry,canonical);
    registry.journal.publish('sessions.metadata',undefined,result);
    return {state:'completed',receipt:{kind:'rpc',result:{value:result,truncated:false}}};
  });
}
export async function dispatchSessionMetadata(registry:Registry,context:RequestContext):Promise<unknown> {
  if(context.parts[2]!=='metadata')throw new ApiError('invalid_request','The session route does not exist.',404);
  if(context.method==='GET'){v.fields(context.body,[]);return listSessionMetadata(registry);}
  if(context.parts[3]==='read') {
    v.fields(context.body,['targets'],['targets']);
    if(!Array.isArray(context.body.targets)||context.body.targets.length>100)throw new ApiError('invalid_request','Read at most 100 session identities.');
    const items:SessionMetadata[]=[];
    for(const value of context.body.targets)items.push(await readSessionMetadata(registry,parseMetadataTarget(value)));
    return {items};
  }
  return mutateSessionMetadata(registry,context);
}
