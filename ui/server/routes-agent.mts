import type { AgentHistoryPage, Target } from '../shared/api.ts';
import type { Registry } from './registry.mts';
import type { RequestContext } from './http.mts';
import { execute } from './dispatch.mts';
import { ApiError } from './errors.mts';
import { projectFrame, projectJson, projectRoster } from './projection.mts';
import * as v from './validate.mts';

export async function dispatchAgent(registry: Registry,context: RequestContext) {
  const {parts,body,method,url}=context;
  if(parts.length===2) {
    const page=registry.agents.roster({cursor:v.cursor(url.searchParams.get('cursor')),limit:v.limit(url,20)});
    const roster=projectRoster(page);
    return {rows:roster.rows,nextCursor:page.nextCursor,coverage:page.coverage,observedAt:roster.observedAt,stale:roster.stale,scan:roster.scan};
  }
  if(parts[2]==='refresh') {
    v.fields(body,['scanId','continue']);
    if(body.scanId!==undefined) {v.string(body.scanId,'scan ID');if(body.continue!==true) throw new ApiError('invalid_request','Confirm catalog continuation.');}
    return registry.agents.refresh(body.scanId as string | undefined);
  }
  const identity=v.string(parts[2],'agent identity'); const target:Target={kind:'agent',identity};
  if(method==='GET') return history(registry,identity,target,url);
  if(parts[3]==='inspect') return inspect(registry,identity,body);
  const workspace=await registry.workspace(context.workspace);
  if(parts[3]==='inputs') {
    v.fields(body,['message','mode','draftRevision'],['message','mode','draftRevision']);
    const message=v.text(body.message); const mode=v.choice(body.mode,['steer','followUp'],'agent mode'); const draftRevision=v.integer(body.draftRevision,'draft revision');
    const state=await registry.store.target(workspace,target);
    return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.input',target,body,input:{targetKey:state.targetKey,text:message,mode,draftRevision}},async()=> {
      const admission=await registry.agents.submit(identity,{operationId:context.operationId ?? '',message,mode});
      return {state:'accepted',receipt:{kind:'durable',identity:admission.identity,submissionId:admission.submissionId,requestId:admission.result.requestId ?? '',deduped:admission.deduped}};
    });
  }
  if(parts[3]==='abort') {
    v.fields(body,['background'],['background']);if(body.background!==false) throw new ApiError('unsupported','Background ownership-tree abort is not exposed.');
    return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.abort',target,body},async()=> {
      await registry.agents.abort(identity);return {state:'completed'};
    });
  }
  if(parts[3]==='configure') {
    v.fields(body,['name','model','thinkingLevel']);
    return execute(registry,context.operationId,{workspaceId:workspace,kind:'agent.configure',target,body},async()=> {
      const result=registry.agents.configure(identity,body);
      return {state:'rejected',error:{code:'unsupported',message:result.reason,retry:'none'}};
    });
  }
  throw new ApiError('invalid_request','The agent action does not exist.',404);
}
async function history(registry:Registry,identity:string,target:Target,url:URL) {
  const before=url.searchParams.get('before');
  const source=await registry.agents.history(identity,{limit:v.limit(url),...(before?{before:v.integer(Number(before),'history boundary',1)}:{})});
  const frame=projectFrame({...source,observedAt:new Date().toISOString(),revision:0,live:[],status:{busy:false}});
  const page:AgentHistoryPage={target,entries:frame.entries,nextBefore:source.nextBefore,coverage:frame.coverage,revision:source.revision};
  return page;
}
async function inspect(registry:Registry,identity:string,body:Record<string,unknown>) {
  v.fields(body,['view','cursor','entryId','offset','submissionId','requestId','limit'],['view']);
  const view=v.choice(body.view,['history','activity','exact','result'],'inspect view');
  const source=await registry.agents.inspect(identity,{view,
    ...(body.cursor!==undefined?{cursor:body.cursor as Record<string,never>} : {}),
    ...(body.entryId!==undefined?{entryId:v.integer(body.entryId,'entry ID',1)}:{}),
    ...(body.offset!==undefined?{offset:v.integer(body.offset,'offset')}:{}),
    ...(body.submissionId!==undefined?{submissionId:v.integer(body.submissionId,'submission ID',1)}:{}),
    ...(body.limit!==undefined?{limit:v.integer(body.limit,'page limit',1)}:{})});
  const display=projectJson(source);
  return {projection:display};
}
