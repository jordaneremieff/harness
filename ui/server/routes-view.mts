import { LIMITS, type OperationKind } from '../shared/api.ts';
import type { Registry } from './registry.mts';
import type { RequestContext } from './http.mts';
import { ApiError } from './errors.mts';
import { execute } from './dispatch.mts';
import {ImageResponse} from './images.mts';
import * as v from './validate.mts';
import { validateConversationLayout } from './state.mts';

const KINDS:OperationKind[]=['primary.open','primary.input','primary.stop','primary.session','primary.control','primary.dialog','primary.handoff','agent.input','agent.abort','agent.configure'];
export async function dispatchView(registry:Registry,context:RequestContext):Promise<unknown> {
  const {parts,body,method}=context;
  if(parts[1]==='bootstrap'||parts[1]==='snapshot') return registry.snapshot(context.workspace,parts[1]==='bootstrap');
  if(parts[1]==='operations') return operations(registry,context);
  if(parts[1]!=='workspaces') throw new ApiError('invalid_request','The route does not exist.',404);
  if(parts.length===2) {v.fields(body,[]);return {workspace:await registry.store.createWorkspace()};}
  const workspace=v.string(parts[2],'workspace ID');
  if(parts[3]==='targets' && parts.length===4 && method==='POST') return prepareTarget(registry,workspace,body);
  await registry.store.workspace(workspace);
  if(parts[3]==='selection') return selection(registry,workspace,context);
  if(parts[3]==='unconfirmed') return unconfirmed(registry,workspace,context);
  return targetAction(registry, workspace, context);
}
async function targetAction(registry: Registry, workspace: string, context: RequestContext): Promise<unknown> {
  const {parts, body, method} = context;
  const key=v.string(parts[4],'target key');
  if (parts[5] === 'images' && method === 'GET') {
    if (context.url.searchParams.size) throw new ApiError('invalid_request', 'Saved image reads do not accept query fields.');
    const digest = v.string(parts[6], 'image digest', 64);
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new ApiError('invalid_request', 'Image digest is invalid.');
    return new ImageResponse(await registry.store.readDraftImage(workspace, key, digest));
  }
  if(method==='GET') return registry.store.getTarget(workspace,key);
  const expectedRevision=v.integer(body.expectedRevision,'revision');
  if(parts[5]==='draft') {
    v.fields(body,['expectedRevision','text','mode','images','recoverySource'],['text','mode','expectedRevision']);
    return registry.store.putDraft(workspace,key,{expectedRevision,text:v.text(body.text,true),mode:v.choice(body.mode,['prompt','steer','followUp'],'draft mode'),images:v.normalizeDraftImages(body.images),...(body.recoverySource !== undefined ? {recoverySource:v.string(body.recoverySource,'recovery source')} : {})});
  }
  if(parts[5]==='reading') {
    v.fields(body,['expectedRevision','anchorId','offsetPx','followTail'],['expectedRevision','anchorId','offsetPx','followTail']);
    return registry.store.putReading(workspace,key,{expectedRevision,anchorId:body.anchorId===null?null:v.string(body.anchorId,'anchor ID'),offsetPx:body.offsetPx as number,followTail:v.boolean(body.followTail,'follow tail')});
  }
  if(parts[5]==='presentation') {
    return presentation(registry,workspace,key,expectedRevision,body);
  }
  throw new ApiError('invalid_request','The view action does not exist.',404);
}
function presentation(registry:Registry,workspace:string,key:string,expectedRevision:number,body:Record<string,unknown>) {
  v.fields(body,['expectedRevision','expanded','showThinking','transcriptView'],['expectedRevision','expanded','showThinking']);
  return registry.store.putPresentation(workspace,key,{expectedRevision,expanded:body.expanded as string[],showThinking:v.boolean(body.showThinking,'thinking visibility'),...(body.transcriptView!==undefined?{transcriptView:v.choice(body.transcriptView,['chronological','grouped'],'transcript view')}:{})});
}
async function prepareTarget(registry:Registry,workspace:string,body:Record<string,unknown>) {
  await registry.workspace(workspace);
  v.fields(body,['target'],['target']);
  const target=v.target(body.target);
  if(target.kind!=='agent') throw new ApiError('invalid_request','Preparation requires an agent target.');
  return registry.prepareTarget(workspace,target);
}
async function unconfirmed(registry:Registry,workspace:string,context:RequestContext) {
  const {parts,body,method}=context;
  const id=v.string(parts[4],'operation ID');
  if(method==='GET') return registry.store.getRetainedInput(workspace,id);
  if(method==='DELETE') {await registry.store.discardRetainedInput(workspace,id);return {removed:true};}
  v.fields(body,['expectedDraftRevision'],['expectedDraftRevision']);
  return registry.store.restoreRetainedInput(workspace,id,v.integer(body.expectedDraftRevision,'draft revision'));
}
async function selection(registry:Registry,workspace:string,context:RequestContext) {
  const {body}=context;
  v.fields(body,['expectedRevision','primaryKey','selectedTarget','panelVisible','sidebarVisible','sidebarWidth','appearance','enterSendsMessages','agentControl','conversationLayout','filePositions','control'],['expectedRevision']);
  const selectedTarget=body.selectedTarget===undefined?undefined:body.selectedTarget===null?null:v.target(body.selectedTarget);
  const primaryKey=body.primaryKey===undefined?undefined:v.string(body.primaryKey,'primary key');
  if(primaryKey && !registry.saved.has(primaryKey)) throw new ApiError('invalid_request','The primary does not exist.',404);
  if(selectedTarget?.kind==='primary') {
    const view=registry.sessions.get(selectedTarget.key)?.view??registry.saved.get(selectedTarget.key);
    if(!view || selectedTarget.epoch!==view.epoch) throw new ApiError('stale_epoch','The primary conversation changed.',409,'read');
  }
  const input=selectionFields(body,primaryKey,selectedTarget);
  const result=body.control===undefined?await registry.store.updateSelection(workspace,input):await controlSelection(registry,workspace,context,input);
  await registry.control?.workspaceChanged(result);
  if(result.selectedTarget) await registry.store.target(workspace,result.selectedTarget);
  void registry.observe(workspace).catch(() => undefined);
  return result;
}
async function controlSelection(registry:Registry,workspace:string,context:RequestContext,input:ReturnType<typeof selectionFields>) {
  const broker=registry.control;if(!broker)throw new ApiError('not_ready','Presentation control is unavailable.',503);
  const {control,...change}=context.body;
  return broker.selection(workspace,control,change,guard=>registry.store.updateSelection(workspace,input,guard));
}
function selectionFields(body:Record<string,unknown>,primaryKey:string|undefined,selectedTarget:ReturnType<typeof v.target>|null|undefined) {
  const conversationLayout=body.conversationLayout;
  if(conversationLayout!==undefined) validateConversationLayout(conversationLayout);
  const sidebarWidth=body.sidebarWidth===undefined?undefined:v.integer(body.sidebarWidth,'sidebar width',LIMITS.sidebarWidthMin);
  if(sidebarWidth!==undefined && sidebarWidth>LIMITS.sidebarWidthMax) throw new ApiError('invalid_request','The sidebar width is invalid.');
  return {expectedRevision:v.integer(body.expectedRevision,'workspace revision'),
    ...(primaryKey!==undefined?{primaryKey}:{}),...(selectedTarget!==undefined?{selectedTarget}:{}),
    ...(body.panelVisible!==undefined?{panelVisible:v.boolean(body.panelVisible,'panel visibility')}:{}),
    ...(body.sidebarVisible!==undefined?{sidebarVisible:v.boolean(body.sidebarVisible,'sidebar visibility')}:{}),
    ...(sidebarWidth!==undefined?{sidebarWidth}:{}),
    ...(body.enterSendsMessages!==undefined?{enterSendsMessages:v.boolean(body.enterSendsMessages,'Enter preference')}:{}),
    ...(body.agentControl!==undefined?{agentControl:v.boolean(body.agentControl,'agent control setting')}:{}),
    ...(conversationLayout!==undefined?{conversationLayout:structuredClone(conversationLayout)}:{}),
    ...(body.filePositions!==undefined?{filePositions:structuredClone(body.filePositions) as import('../shared/api.ts').Workspace['filePositions']}:{}),
    ...(body.appearance!==undefined?{appearance:v.choice(body.appearance,['dark','light','system','latte','frappe','macchiato','mocha'],'appearance')}: {})};
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
  const images = structuredClone(input.images ?? []);
  const captured={message:input.text,mode:input.mode,draftRevision:input.submittedDraftRevision,...(images.length ? {images} : {})};
  return execute(registry,id,{workspaceId:record.workspaceId,kind:'agent.input',target,body:captured,
    input:{targetKey:input.targetKey,text:input.text,mode:input.mode,draftRevision:input.submittedDraftRevision,images},retryUncertainNative:true},async()=> {
    const admission=await registry.agents.retrySubmit(target.identity,{operationId:id,message:input.text,mode:input.mode as 'steer'|'followUp',targetKey:input.targetKey,images});
    return {state:'accepted',receipt:{kind:'durable',identity:admission.identity,submissionId:admission.submissionId,requestId:admission.result.requestId??'',deduped:admission.deduped}};
  });
}
