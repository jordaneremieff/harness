import type { OperationKind } from '../shared/api.ts';
import type { Registry } from './registry.mts';
import type { RequestContext } from './http.mts';
import { ApiError } from './errors.mts';
import { execute } from './dispatch.mts';
import * as v from './validate.mts';

const KINDS:OperationKind[]=['primary.open','primary.input','primary.stop','primary.session','primary.control','primary.dialog','primary.handoff','agent.input','agent.abort','agent.configure'];
export async function dispatchView(registry:Registry,context:RequestContext):Promise<unknown> {
  const {parts,body,method}=context;
  if(parts[1]==='bootstrap'||parts[1]==='snapshot') return registry.snapshot(context.workspace,parts[1]==='bootstrap');
  if(parts[1]==='operations') return operations(registry,context);
  if(parts[1]!=='workspaces') throw new ApiError('invalid_request','The route does not exist.',404);
  if(parts.length===2) {v.fields(body,[]);return {workspace:await registry.store.createWorkspace()};}
  const workspace=v.string(parts[2],'workspace ID');await registry.store.workspace(workspace);
  if(parts[3]==='selection') return selection(registry,workspace,body);
  if(parts[3]==='unconfirmed') return unconfirmed(registry,workspace,context);
  const key=v.string(parts[4],'target key');
  if(method==='GET') return registry.store.getTarget(workspace,key);
  const expectedRevision=v.integer(body.expectedRevision,'revision');
  if(parts[5]==='draft') {
    v.fields(body,['expectedRevision','text','mode'],['text','mode','expectedRevision']);
    return registry.store.putDraft(workspace,key,{expectedRevision,text:v.text(body.text,true),mode:v.choice(body.mode,['prompt','steer','followUp'],'draft mode')});
  }
  if(parts[5]==='reading') {
    v.fields(body,['expectedRevision','anchorId','offsetPx','followTail'],['expectedRevision','anchorId','offsetPx','followTail']);
    return registry.store.putReading(workspace,key,{expectedRevision,anchorId:body.anchorId===null?null:v.string(body.anchorId,'anchor ID'),offsetPx:body.offsetPx as number,followTail:v.boolean(body.followTail,'follow tail')});
  }
  if(parts[5]==='presentation') {
    v.fields(body,['expectedRevision','expanded','showThinking'],['expectedRevision','expanded','showThinking']);
    return registry.store.putPresentation(workspace,key,{expectedRevision,expanded:body.expanded as string[],showThinking:v.boolean(body.showThinking,'thinking visibility')});
  }
  throw new ApiError('invalid_request','The view action does not exist.',404);
}
async function unconfirmed(registry:Registry,workspace:string,context:RequestContext) {
  const {parts,body,method}=context;
  const id=v.string(parts[4],'operation ID');
  if(method==='GET') return registry.store.getUnconfirmed(workspace,id);
  if(method==='DELETE') {await registry.store.discardUnconfirmed(workspace,id);return {removed:true};}
  v.fields(body,['expectedDraftRevision'],['expectedDraftRevision']);
  return registry.store.restoreUnconfirmed(workspace,id,v.integer(body.expectedDraftRevision,'draft revision'));
}
async function selection(registry:Registry,workspace:string,body:Record<string,unknown>) {
  v.fields(body,['expectedRevision','primaryKey','selectedTarget','panelVisible','appearance'],['expectedRevision']);
  const selectedTarget=body.selectedTarget===undefined?undefined:body.selectedTarget===null?null:v.target(body.selectedTarget);
  const primaryKey=body.primaryKey===undefined?undefined:v.string(body.primaryKey,'primary key');
  if(primaryKey && !registry.saved.has(primaryKey)) throw new ApiError('invalid_request','The primary does not exist.',404);
  if(selectedTarget?.kind==='primary') {
    const view=registry.sessions.get(selectedTarget.key)?.view??registry.saved.get(selectedTarget.key);
    if(!view || selectedTarget.epoch!==view.epoch) throw new ApiError('stale_epoch','The primary conversation changed.',409,'read');
  }
  const result=await registry.store.updateSelection(workspace,selectionFields(body,primaryKey,selectedTarget));
  if(result.selectedTarget) await registry.store.target(workspace,result.selectedTarget);
  if(result.panelVisible===false || result.selectedTarget?.kind!=='agent') {await registry.agents.hide(workspace);registry.frames.delete(workspace);}
  else if(registry.journal.workspaceClients(workspace)) void registry.observe(workspace).catch(()=>{});
  return result;
}
function selectionFields(body:Record<string,unknown>,primaryKey:string|undefined,selectedTarget:ReturnType<typeof v.target>|null|undefined) {
  return {expectedRevision:v.integer(body.expectedRevision,'workspace revision'),
    ...(primaryKey!==undefined?{primaryKey}:{}),...(selectedTarget!==undefined?{selectedTarget}:{}),
    ...(body.panelVisible!==undefined?{panelVisible:v.boolean(body.panelVisible,'panel visibility')}:{}),
    ...(body.appearance!==undefined?{appearance:v.choice(body.appearance,['dark','light','system'],'appearance')}: {})};
}
async function operations(registry:Registry,context:RequestContext) {
  const {parts,body,method}=context;
  if(parts.length===2) {
    v.fields(body,['kind','target'],['kind']);const kind=v.choice(body.kind,KINDS,'operation kind');const target=body.target===undefined?undefined:v.target(body.target);
    const operation=await registry.operations.reserve(await registry.workspace(context.workspace),kind,target);
    return {operationId:operation.id,state:operation.state,operation};
  }
  const id=v.string(parts[2],'operation ID');
  if(method==='GET') return registry.operations.get(id);
  if(method==='DELETE') {await registry.operations.remove(id);return {removed:true};}
  v.fields(body,['retry']);
  if(body.retry!==true) return registry.operations.reconcile(id);
  const record=registry.store.record(id);
  if(record.view.kind!=='agent.input'||record.view.state!=='uncertain'||record.view.target?.kind!=='agent'||!record.input) throw new ApiError('unsupported','Only uncertain native inputs support explicit same-key retry.');
  const input=record.input; const target=record.view.target;
  const captured={message:input.text,mode:input.mode,draftRevision:input.submittedDraftRevision};
  return execute(registry,id,{workspaceId:record.workspaceId,kind:'agent.input',target,body:captured,
    input:{targetKey:input.targetKey,text:input.text,mode:input.mode,draftRevision:input.submittedDraftRevision},retryUncertainNative:true},async()=> {
    const admission=await registry.agents.retrySubmit(target.identity,{operationId:id,message:input.text,mode:input.mode as 'steer'|'followUp'});
    return {state:'accepted',receipt:{kind:'durable',identity:admission.identity,submissionId:admission.submissionId,requestId:admission.result.requestId??'',deduped:admission.deduped}};
  });
}
