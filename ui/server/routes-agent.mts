import {createAgent} from './create-agent.mts';
import {convertSaved} from './conversion.mts';
import type { AgentHistoryPage, Target } from '../shared/api.ts';
import { nativeControls, decodeInput, type JsonObject, RESERVED_COMMANDS, retainedTarget, type ConfigureResult } from '../agents/contract.mts';
import { AgentError } from '../agents/index.mts';
import { boundCommandResult, projectCommandList } from './agent-commands.mts';
import { projectJson, safeText } from './projection.mts';
import type { Registry } from './registry.mts';
import type { RequestContext } from './http.mts';
import { execute } from './dispatch.mts';
import type {DispatchResult} from './operations.mts';
import type {ConfigureInput} from '../agents/index.mts';
import type {ConfigurationReceipt} from '../shared/api.ts';
import { ApiError } from './errors.mts';
import { projectFrame, projectRoster } from './projection.mts';
import {inspectCursor, projectInspection} from './inspection.mts';
import * as v from './validate.mts';
import { LIMITS } from '../shared/api.ts';
import { ImageResponse } from './images.mts';
import { imageRequest, isImageRoute } from './image-request.mts';

export async function dispatchAgent(registry: Registry,context: RequestContext) {
  const {parts,body,method,url}=context;
  if(parts.length===2) {
    if(url.searchParams.has('identity')) return identityRows(registry,url);
    const page=registry.agents.roster({cursor:v.cursor(url.searchParams.get('cursor')),limit:v.limit(url,20)});
    const roster=projectRoster(page);
    return {rows:roster.rows,nextCursor:page.nextCursor,coverage:page.coverage,observedAt:roster.observedAt,stale:roster.stale,scan:roster.scan};
  }
  if(parts[2]==='refresh')return refreshRoots(registry,body);
  if(parts[2]==='create') return createAgent(registry,context);
  if(parts[2]==='convert') return convertSaved(registry,context);
  const identity=v.string(parts[2],'agent identity'); const target:Target={kind:'agent',identity};
  if(isImageRoute(method,parts)) {
    const request=imageRequest(url,false);
    try {retainedTarget(identity);} catch {throw new ApiError('invalid_request','Use the exact agent conversation identity.');}
    return new ImageResponse(await registry.agents.image(identity,request.source,request.digest));
  }
  if(method==='GET')return readAgent(registry,context,identity,target);
  if(parts[3]==='inspect') return inspect(registry,identity,body,context.signal);
  const workspace=await registry.workspace(context.workspace);
  if(parts[3]==='start') {
    v.fields(body,[]);
    return registry.startAgent(workspace,identity,v.string(context.operationId,'start request ID',128));
  }
  if(parts[3]==='inputs') {
    v.fields(body,['message','mode','draftRevision','images'],['message','mode','draftRevision']);
    const images = v.normalizeDraftImages(body.images);
    const message=v.text(body.message, images.length > 0); const mode=v.choice(body.mode,['steer','followUp'],'agent mode'); const draftRevision=v.integer(body.draftRevision,'draft revision');
    const state=await registry.store.target(workspace,target);
    return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.input',target,body,input:{targetKey:state.targetKey,text:message,mode,draftRevision,images}},async()=> {
      const admission=await registry.agents.submit(identity,{operationId:context.operationId ?? '',message,mode,targetKey:state.targetKey,images});
      return {state:'accepted',receipt:{kind:'durable',identity:admission.identity,submissionId:admission.submissionId,requestId:admission.result.requestId ?? '',deduped:admission.deduped},
        ...(typeof admission.sentImageMessageDigest === 'string' ? {sentImageMessageDigest: admission.sentImageMessageDigest} : {})};
    });
  }
  return controlAction(registry,context,workspace,target,identity);
}
function readAgent(registry:Registry,context:RequestContext,identity:string,target:Target) {
  if(context.parts[3]==='run-scope')return registry.agents.control(identity,'run-scope',{sessionId:identity});
  if(context.parts[3]==='commands')return commandList(registry,identity,context.url,context.signal);
  return history(registry,identity,target,context.url,context.workspace,context.signal);
}
async function refreshRoots(registry:Registry,body:Record<string,unknown>) {
  try{await registry.discoverManagedRoots();}catch{registry.journal.publish('notice',undefined,{level:'warning',message:'Managed native sessions are unavailable. Existing sessions remain available.',code:'runtime_unavailable'});}
  return refresh(registry,body);
}
/** Exact misses request bounded named record reads; answers retain request order and never start a host. */
async function identityRows(registry:Registry,url:URL) {
  if(url.searchParams.has('cursor')||url.searchParams.has('limit')) throw new ApiError('invalid_request','An identity lookup takes no paging fields.');
  const identities=[...new Set(url.searchParams.getAll('identity').map(value=>v.string(value,'agent identity')))];
  if(identities.length>LIMITS.identityLookup) throw new ApiError('invalid_request',`An identity lookup names at most ${LIMITS.identityLookup} identities.`);
  const cached=new Map(identities.map(identity=>[identity,registry.agents.rosterRow(identity)]));
  const missing=identities.filter(identity=>!cached.get(identity));
  if(missing.length) {
    try {await registry.agents.lookup(missing);} catch { /* A bounded read failure leaves cached answers intact. */ }
    for(const identity of missing) cached.set(identity,registry.agents.rosterRow(identity));
  }
  const rows=identities.flatMap(identity=>{const row=cached.get(identity);return row?[row]:[];});
  const page=registry.agents.roster({limit:1}),roster=projectRoster({...page,rows,nextCursor:null});
  return {rows:roster.rows,nextCursor:null,coverage:page.coverage,observedAt:roster.observedAt,stale:roster.stale,scan:roster.scan};
}
/** Actions on one agent that are not input: stop, run a host command, configure. */
function controlAction(registry:Registry,context:RequestContext,workspace:string,target:Extract<Target,{kind:'agent'}>,identity:string) {
  const {parts,body}=context;
  if(parts[3]==='control') {
    v.fields(body,['method','params'],['method','params']);
    const member=v.choice(body.method,nativeControls,'native control');
    if(!body.params||typeof body.params!=='object'||Array.isArray(body.params))throw new ApiError('invalid_request','The control parameters are invalid.');
    if(['sessionId','requestId','senderIdentity'].some(key=>Object.hasOwn(body.params as object,key)))throw new ApiError('invalid_request','Native identity fields belong to the server.');
    const params={...body.params as JsonObject,sessionId:identity,requestId:`ui:${context.operationId}`,...(['spawn','place','profile-update'].includes(member)?{senderIdentity:identity}:{})};
    try {decodeInput(member,params,{identity});} catch {throw new ApiError('invalid_request','The native control parameters are invalid.');}
    return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.control',target,body},async()=> {
      const result=await registry.agents.control(identity,member,params);
      return {state:'completed',receipt:{kind:'rpc',result:projectJson(result)}};
    });
  }
  if(parts[3]==='abort') {
    v.fields(body,['background'],['background']);if(body.background!==false) throw new ApiError('unsupported','Background ownership-tree abort is not exposed.');
    return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.abort',target,body},async()=> {
      await registry.agents.abort(identity);return {state:'completed'};
    });
  }
  if(parts[3]==='command') return runCommand(registry,context,workspace,target,identity);
  if(parts[3]==='configure') {
    v.fields(body,['name','model','thinkingLevel']);
    return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.configure',target,body},()=>configureAgent(registry,identity,{operationId:context.operationId ?? '',...body}));
  }
  throw new ApiError('invalid_request','The agent action does not exist.',404);
}
function configurationReceipt(result:ConfigureResult):ConfigurationReceipt {
  const receipt:ConfigurationReceipt={kind:'configuration',identity:result.sessionId,outcome:result.outcome,
    after:{name:safeText(result.after.name,256),model:result.after.model,thinkingLevel:result.after.thinkingLevel},afterSource:result.afterSource,persistence:result.persistence.nativeWrites};
  if(typeof result.reasoning?.clamped==='boolean')receipt.clamped=result.reasoning.clamped;
  if(result.persistence.note)receipt.note=safeText(result.persistence.note,2048);
  return receipt;
}
function configurationOutcome(result:ConfigureResult):DispatchResult {
  const receipt=configurationReceipt(result);
  if(result.persistence.nativeWrites!=='uncertain'&&result.outcome==='applied')return {state:'completed',receipt};
  const uncertain=result.persistence.nativeWrites==='uncertain';
  return {state:uncertain?'uncertain':'rejected',receipt,error:{code:uncertain?'configuration_uncertain':'configure_refused',message:safeText(result.error??result.persistence.note??'Configuration was not confirmed.',2048),retry:'none'}};
}
async function configureAgent(registry:Registry,identity:string,input:ConfigureInput):Promise<DispatchResult> {
  try{return configurationOutcome(await registry.agents.configure(identity,input));}
  catch(error){
    if(error instanceof AgentError&&error.code==='configure_refused')return {state:'rejected',error:{code:error.code,message:safeText(error.message,2048),retry:'none'}};
    throw error;
  }
}
const COMMAND_NAME=/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
/** The inventory belongs to the live host that answers. It is read only and never cached on the server. */
async function commandList(registry:Registry,identity:string,url:URL,signal?:AbortSignal) {
  for(const key of url.searchParams.keys()) if(key!=='workspace') throw new ApiError('invalid_request','The command list query is invalid.');
  try {retainedTarget(identity);} catch {throw new ApiError('invalid_request','Use the exact agent conversation identity.');}
  try {return projectCommandList(await registry.agents.inventory(identity,signal));}
  catch(error) {
    if(error instanceof AgentError&&error.code==='commands_unavailable') throw new ApiError('commands_unavailable',safeText(error.message,512),501);
    throw error;
  }
}
/** One run of one host command. The host call is never repeated: a lost connection is an unknown outcome, and a host refusal keeps its message. */
function runCommand(registry:Registry,context:RequestContext,workspace:string,target:Target,identity:string) {
  const body=context.body;
  v.fields(body,['name','args'],['name']);
  const name=v.string(body.name,'command name',128);
  if(!COMMAND_NAME.test(name)||RESERVED_COMMANDS.includes(name)) throw new ApiError('invalid_request','The command name is not available.');
  const args=body.args===undefined?undefined:v.text(body.args,true);
  return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.command',target,body},async()=> {
    try {
      const result=await registry.agents.command(identity,{operationId:context.operationId ?? '',name,...(args!==undefined?{args}:{})});
      return {state:'completed',receipt:{kind:'command',name:result.name,...boundCommandResult(result.text)}};
    } catch(error) {
      if(error instanceof AgentError&&error.code==='command_refused') return {state:'rejected',error:{code:'command_refused',message:safeText(error.message,512),retry:'none'}};
      throw error;
    }
  });
}
async function refresh(registry:Registry,body:Record<string,unknown>) {
  v.fields(body,['scanId','continue']);
  if(body.scanId!==undefined) {v.string(body.scanId,'scan ID');if(body.continue!==true) throw new ApiError('invalid_request','Confirm catalog continuation.');}
  return registry.agents.refresh(body.scanId as string | undefined);
}
async function history(registry:Registry,identity:string,target:Target,url:URL,workspaceId?:string,signal?:AbortSignal) {
  let binding: ReturnType<typeof retainedTarget>;
  try {binding=retainedTarget(identity);} catch {throw new ApiError('invalid_request','Use the exact agent conversation identity.');}
  const before=url.searchParams.get('before');
  const source=await registry.agents.history(identity,{limit:v.limit(url),...(before?{before:v.integer(Number(before),'history boundary',1)}:{})},signal);
  const frame=projectFrame({...source,...binding,observedAt:new Date().toISOString(),revision:0,live:[],status:{busy:false}});
  if (workspaceId !== undefined) {
    await registry.store.workspace(workspaceId);
    registry.store.enrichSentImages(workspaceId, target, frame.entries);
  }
  const page:AgentHistoryPage={target,entries:frame.entries,nextBefore:source.nextBefore,coverage:frame.coverage,revision:source.revision};
  return page;
}
async function inspect(registry:Registry,identity:string,body:Record<string,unknown>,signal?:AbortSignal) {
  v.fields(body,['view','source','cursor','entryId','offset','submissionId','requestId','operationId','limit'],['view']);
  const view=v.choice(body.view,['history','activity','exact','result'],'inspect view');
  if(body.source!==undefined&&view!=='history')throw new ApiError('invalid_request','Source selects history only.');
  const source=await registry.agents.inspect(identity,{view,
    ...(body.source!==undefined?{source:v.choice(body.source,['user'],'history source')} : {}),
    ...(body.cursor!==undefined?{cursor:requestInspectCursor(body.cursor)} : {}),
    ...(body.entryId!==undefined?{entryId:v.integer(body.entryId,'entry ID',1)}:{}),
    ...(body.offset!==undefined?{offset:v.integer(body.offset,'offset')}:{}),
    ...(body.submissionId!==undefined?{submissionId:v.integer(body.submissionId,'submission ID',1)}:{}),
    ...(body.requestId!==undefined?{requestId:v.string(body.requestId,'native request ID',1024)}:{}),
    ...(body.operationId!==undefined?{operationId:v.string(body.operationId,'native operation ID',1024)}:{}),
    ...(body.limit!==undefined?{limit:v.integer(body.limit,'page limit',1)}:{})},signal);
  return projectInspection(source,identity);
}
function requestInspectCursor(value:unknown) {
  try {const cursor=inspectCursor(value);if(cursor)return cursor;}
  catch { /* Native cursor shape refusal is a request error at this boundary. */ }
  throw new ApiError('invalid_request','The inspection cursor is invalid.');
}
