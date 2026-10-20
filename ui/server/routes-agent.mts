import {convertSaved} from './conversion.mts';
import type { AgentHistoryPage, Target } from '../shared/api.ts';
import { RESERVED_COMMANDS, retainedTarget } from '../agents/contract.mts';
import { AgentError } from '../agents/index.mts';
import { boundCommandResult, projectCommandList } from './agent-commands.mts';
import { safeText } from './projection.mts';
import type { Registry } from './registry.mts';
import type { RequestContext } from './http.mts';
import { execute } from './dispatch.mts';
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
  if(parts[2]==='refresh') return refresh(registry,body);
  if(parts[2]==='convert') return convertSaved(registry,context);
  const identity=v.string(parts[2],'agent identity'); const target:Target={kind:'agent',identity};
  if(isImageRoute(method,parts)) {
    const request=imageRequest(url,false);
    try {retainedTarget(identity);} catch {throw new ApiError('invalid_request','Use the exact agent conversation identity.');}
    return new ImageResponse(await registry.agents.image(identity,request.source,request.digest));
  }
  if(method==='GET'&&parts[3]==='commands') return commandList(registry,identity,url,context.signal);
  if(method==='GET') return history(registry,identity,target,url,context.workspace,context.signal);
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
/** Rows for exact identities from the catalog already in memory, in request order. An identity the catalog does not hold has no row. Paging does not apply. */
function identityRows(registry:Registry,url:URL) {
  if(url.searchParams.has('cursor')||url.searchParams.has('limit')) throw new ApiError('invalid_request','An identity lookup takes no paging fields.');
  const identities=[...new Set(url.searchParams.getAll('identity').map(value=>v.string(value,'agent identity')))];
  if(identities.length>LIMITS.identityLookup) throw new ApiError('invalid_request',`An identity lookup names at most ${LIMITS.identityLookup} identities.`);
  const rows=identities.flatMap(identity=>{const row=registry.agents.rosterRow(identity);return row?[row]:[];});
  const page=registry.agents.roster({limit:1}),roster=projectRoster({...page,rows,nextCursor:null});
  return {rows:roster.rows,nextCursor:null,coverage:page.coverage,observedAt:roster.observedAt,stale:roster.stale,scan:roster.scan};
}
/** Actions on one agent that are not input: stop, run a host command, configure. */
function controlAction(registry:Registry,context:RequestContext,workspace:string,target:Extract<Target,{kind:'agent'}>,identity:string) {
  const {parts,body}=context;
  if(parts[3]==='abort') {
    v.fields(body,['background'],['background']);if(body.background!==false) throw new ApiError('unsupported','Background ownership-tree abort is not exposed.');
    return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.abort',target,body},async()=> {
      await registry.agents.abort(identity);return {state:'completed'};
    });
  }
  if(parts[3]==='command') return runCommand(registry,context,workspace,target,identity);
  if(parts[3]==='configure') {
    v.fields(body,['name','model','thinkingLevel']);
    return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.configure',target,body},async()=> {
      const result=registry.agents.configure(identity,body);
      return {state:'rejected',error:{code:'unsupported',message:result.reason,retry:'none'}};
    });
  }
  throw new ApiError('invalid_request','The agent action does not exist.',404);
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
