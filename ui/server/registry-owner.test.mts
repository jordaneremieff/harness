import assert from 'node:assert/strict';
import test from 'node:test';
import type {spawn} from 'node:child_process';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Registry,type AgentAdapter} from './registry.mts';
import {StateStore} from './state.mts';
import {createPrimaryOwner} from './primary-owner.mts';
import {connectTestOwner} from './owner-test-fixture.mts';
import {PrimarySession} from '../rpc/session.mts';
import {FakeChild} from '../rpc/fake-child.mts';
import {withPrimaryOperation} from '../rpc/primary-operation.mts';
const unavailable=async():Promise<never>=>{throw Error('No agent work belongs to an owned-primary fixture.');};
const agents=():AgentAdapter=>({roster:()=>({rows:[],nextCursor:null,coverage:{complete:true,omitted:0},stale:false,scan:{state:'ready',complete:true,visited:0,skipped:0,omitted:0}}),rosterRow:()=>undefined,imageInputAvailable:()=>false,prepare:unavailable,refresh:unavailable,select:unavailable,hide:unavailable,reconnect:unavailable,history:unavailable,image:unavailable,inspect:unavailable,inventory:unavailable,command:unavailable,threads:unavailable,thread:unavailable,submit:unavailable,retrySubmit:unavailable,abort:unavailable,configure:()=>{throw Error('No agent configuration belongs to this fixture.');},disconnectWorkspace:unavailable,close:async()=>{}});
async function fixture(context:test.TestContext,order:'owner'|'metadata'|'identity'|'conflict'|'file'){
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-owner-epoch-'))),store=await StateStore.open(root),workspace=await store.workspace(),child=new FakeChild(),otherChild=new FakeChild();let nativeId='native-old',spawns=0;
  child.onCommand=record=>{if(record.type==='get_state')child.response(record,{sessionId:nativeId,isStreaming:false,isCompacting:false,pendingMessageCount:0});else if(record.type==='new_session'){nativeId='native-new';child.response(record,{cancelled:false});}else child.defaults(record);};
  const owner=await createPrimaryOwner({state:{root:store.root,instanceId:store.instanceId},spawnChild:((...args:Parameters<FakeChild['spawn']>)=>(spawns++?otherChild:child).spawn(...args)) as typeof spawn}),first=connectTestOwner(owner),key=randomUUID();
  const primary={key,epoch:1,cwd:root,executable:'unused',recoveryWorkspaceId:workspace.id},transport=first.connection.factory(primary)({});await transport.start();
  const operationId=randomUUID(),digest='a'.repeat(64),target={kind:'primary' as const,key,epoch:1},at=new Date().toISOString();
  await store.writeOperation({workspaceId:workspace.id,digest,view:{id:operationId,kind:'primary.session',target,state:'dispatched',createdAt:at,updatedAt:at}});
  await withPrimaryOperation(operationId,digest,()=>transport.request('new_session'));await transport.request('get_state');
  if(order==='owner')await transport.setEpoch?.(2);
  const previous=new PrimarySession({key,cwd:root,executable:'unused',epoch:order==='owner'?1:2,publish:()=>{}}).view;previous.sessionId=order==='metadata'?'native-new':'native-old';
  if(order==='conflict'||order==='file'){previous.epoch=2;previous.sessionId=order==='file'?'native-new':'unrelated';if(order==='file')previous.sessionFile=join(root,'another-session.jsonl');await store.deleteOperation(operationId);await store.writeOperation({workspaceId:workspace.id,digest,view:{id:randomUUID(),kind:'primary.input',target:{...target,epoch:2},state:'dispatched',createdAt:at,updatedAt:at}});}
  const views=[previous];let otherKey:string|undefined;
  if(order==='conflict'||order==='file'){
    otherKey=randomUUID();otherChild.onCommand=record=>otherChild.defaults(record);const other=first.connection.factory({...primary,key:otherKey})({});await other.start();
    const view=new PrimarySession({key:otherKey,cwd:root,executable:'unused',publish:()=>{}}).view;view.sessionId='fixture';views.push(view);await other.detach?.();
  }
  await store.savePrimaries(views);
  const old=await store.target(workspace.id,target),next=await store.target(workspace.id,{...target,epoch:2});
  await store.putDraft(workspace.id,old.targetKey,{expectedRevision:0,text:'old draft',mode:'prompt'});await store.putDraft(workspace.id,next.targetKey,{expectedRevision:0,text:'new draft',mode:'prompt'});
  await store.close();await transport.detach?.();first.connection.close();first.detach();const channel=connectTestOwner(owner);
  let registry:Registry|undefined;context.after(async()=>{await registry?.detach();child.exit(0);otherChild.exit(0);channel.connection.close();channel.detach();await owner.dispose();await rm(root,{recursive:true,force:true});});
  registry=await Registry.open({stateDir:root,cwd:root,executable:'unused',agentStore:join(root,'agents'),agents,owner:channel.connection});
  return{registry,owner,child,key,otherKey,workspace:workspace.id,target,old,next};
}
for(const order of ['owner','metadata','identity'] as const)test(`owned attachment reconciles the ${order}-first epoch crash without replay or draft loss`,async context=>{
  const {registry,owner,child,key,workspace,target,old,next}=await fixture(context,order),session=registry.primary(key,2,true);
  assert.equal(session.view.sessionId,'native-new');assert.equal(owner.descriptors()[0]?.epoch,2);assert.equal((await registry.store.readPrimaries())[0]?.epoch,2);
  assert.equal((await registry.store.target(workspace,target)).draft.text,'old draft');assert.equal((await registry.store.target(workspace,{...target,epoch:2})).draft.text,'new draft');assert.notEqual(old.targetKey,next.targetKey);
  assert.throws(()=>registry.primary(key,1,true),{code:'stale_epoch'});assert.equal(child.writes.filter(record=>record.type==='new_session').length,1);assert.equal(child.stdin.writableEnded,false);
});
for(const conflict of ['conflict','file'] as const)test(`an owned ${conflict} quarantines one primary instead of failing backend startup`,async context=>{
  const {registry,key,otherKey,child}=await fixture(context,conflict);assert.ok(otherKey);assert.equal(registry.primary(otherKey,1,true).view.lifecycle,'ready');assert.equal(registry.primary(key).view.lifecycle,'failed');assert.equal(registry.primary(key).view.lastError?.code,'operation_conflict');assert.equal(registry.primary(key).view.capabilities.input,false);assert.equal(child.stdin.writableEnded,false);
  const workspace=await registry.workspace();assert.ok(workspace);assert.equal(child.writes.filter(record=>record.type==='new_session').length,1);assert.ok(registry.store.operationMetadata().every(record=>['dispatched','uncertain'].includes(record.view.state)));
  await assert.rejects(()=>registry.close(),{code:'not_ready'});assert.equal(child.writes.some(record=>['clear_queue','abort'].includes(record.type)),false);assert.equal(child.stdin.writableEnded,false);
});
