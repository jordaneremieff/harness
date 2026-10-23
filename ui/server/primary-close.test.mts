import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {spawn} from 'node:child_process';
import test,{type TestContext} from 'node:test';
import {FakeChild} from '../rpc/fake-child.mts';
import {LIMITS,ROUTES,type OperationView} from '../shared/api.ts';
import {Registry,type AgentAdapter} from './registry.mts';
import {StateStore} from './state.mts';
import {createPrimaryOwner} from './primary-owner.mts';
import {connectTestOwner} from './owner-test-fixture.mts';
const unavailable=async():Promise<never>=>{throw Error('No agent work belongs to this fixture.');};
const agents=():AgentAdapter=>({roster:()=>({rows:[],nextCursor:null,coverage:{complete:true,omitted:0},stale:false,scan:{state:'ready',complete:true,visited:0,skipped:0,omitted:0}}),rosterRow:()=>undefined,lookup:unavailable,imageInputAvailable:()=>false,prepare:unavailable,refresh:unavailable,select:unavailable,hide:unavailable,reconnect:unavailable,history:unavailable,image:unavailable,inspect:unavailable,inventory:unavailable,command:unavailable,threads:unavailable,thread:unavailable,submit:unavailable,retrySubmit:unavailable,abort:unavailable,configure:()=>{throw Error('No configuration belongs to this fixture.');},disconnectWorkspace:async()=>{},close:async()=>{}});
const settled=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-primary-close-'))),store=await StateStore.open(root),state={root:store.root,instanceId:store.instanceId};await store.close();
  const children:FakeChild[]=[];
  const owner=await createPrimaryOwner({state,spawnChild:((...args:Parameters<FakeChild['spawn']>)=>{const child=new FakeChild();child.pid+=children.length;child.onCommand=record=>child.defaults(record);children.push(child);return child.spawn(...args);}) as typeof spawn});
  const channels:ReturnType<typeof connectTestOwner>[]=[],registries:Registry[]=[];
  const open=async()=>{const channel=connectTestOwner(owner);channels.push(channel);const registry=await Registry.open({stateDir:root,cwd:root,executable:'fake',agentStore:join(root,'agents'),agents,owner:channel.connection});registries.push(registry);return registry;};
  t.after(async()=>{for(const child of children)if(!child.stdin.writableEnded)child.exit(0);for(const registry of registries)await registry.detach().catch(()=>{});for(const channel of channels){channel.connection.close();channel.detach();}await owner.dispose();await rm(root,{recursive:true,force:true});});
  return {root,children,owner,open};
}
async function close(registry:Registry,workspace:string,key:string,epoch=1,body:Record<string,unknown>={epoch}){
  const operation=await registry.dispatch({method:'POST',parts:['api','operations'],url:new URL('http://localhost/api/operations'),body:{kind:'primary.close',target:{kind:'primary',key,epoch}},workspace}) as {operationId:string};
  const context={method:'POST',parts:['api','primaries',key,'close'],url:new URL(`http://localhost/api/primaries/${key}/close`),body,workspace,operationId:operation.operationId};
  return {operation:await registry.dispatch(context) as OperationView,context};
}
test('close uses the existing owner after backend replacement, frees capacity only on exit, and keeps drafts and retained queues',async t=>{
  const f=await fixture(t);let registry=await f.open();const workspace=await registry.workspace(),keys:string[]=[];
  for(let index=0;index<LIMITS.primaries;index++){const key=await registry.openPrimary(f.root,undefined,workspace);await registry.waitPrimaryReady(key);keys.push(key);}
  await settled();await assert.rejects(registry.openPrimary(f.root,undefined,workspace),{code:'capacity'});
  const key=keys[0],target={kind:'primary' as const,key,epoch:1},state=await registry.store.target(workspace,target);
  await registry.store.putDraft(workspace,state.targetKey,{expectedRevision:0,text:'unsent draft',mode:'prompt'});
  const queue=await registry.operations.beginQueueClear(workspace,target,2);await registry.operations.retainQueue(queue,{steering:['retained steer'],followUp:['retained follow-up']});
  const before=await registry.store.getTarget(workspace,state.targetKey);
  await registry.detach();registry=await f.open();await settled();
  const child=f.children[0];child.autoExit=false;
  const ended=new Promise<void>(resolve=>child.stdin.once('finish',resolve)),pending=close(registry,workspace,key);
  await Promise.race([ended,pending.then(result=>{throw new Error(`Close ended before EOF: ${JSON.stringify(result.operation)}`);})]);
  assert.equal(child.stdin.writableEnded,true);assert.equal(registry.primary(key).client.exited,false);
  await assert.rejects(registry.openPrimary(f.root,undefined,workspace),{code:'capacity'});
  child.exit(0);const {operation,context}=await pending;
  assert.equal(operation.state,'completed');assert.equal(operation.receipt?.kind,'rpc');
  if(operation.receipt?.kind==='rpc')assert.equal(JSON.stringify(operation.receipt.result?.value),JSON.stringify({closed:true}));
  assert.equal(registry.primary(key).view.lifecycle,'stopped');assert.equal(f.owner.descriptors().find(view=>view.key===key)?.exited,true);
  assert.equal(JSON.stringify((await registry.dispatch(context) as OperationView).receipt),JSON.stringify(operation.receipt));
  const after=await registry.store.getTarget(workspace,state.targetKey);assert.deepEqual(after.draft,before.draft);
  const beforeRecords=new Map(before.unconfirmed.map(record=>[record.operationId,record])),afterRecords=new Map(after.unconfirmed.map(record=>[record.operationId,record]));
  assert.equal(beforeRecords.size,before.unconfirmed.length);assert.equal(afterRecords.size,after.unconfirmed.length);
  assert.equal(after.unconfirmed.length,before.unconfirmed.length);assert.deepEqual(afterRecords,beforeRecords);
  assert.equal(child.writes.some(record=>['abort','clear_queue'].includes(record.type)),false);
  const next=await registry.openPrimary(f.root,undefined,workspace);await registry.waitPrimaryReady(next);assert.equal(f.children.length,LIMITS.primaries+1);
  for(const other of keys.slice(1)){assert.equal(registry.primary(other).view.lifecycle,'ready');assert.equal(f.children[keys.indexOf(other)].stdin.writableEnded,false);}
  assert.ok(ROUTES.includes('POST /api/primaries/:key/close'));
});
test('close rejects wrong targets, stale epochs, busy primaries, queue work and extra fields',async t=>{
  const f=await fixture(t),registry=await f.open(),workspace=await registry.workspace(),key=await registry.openPrimary(f.root,undefined,workspace);await registry.waitPrimaryReady(key);await settled();
  const child=f.children[0];
  await assert.rejects(close(registry,workspace,'missing'),{code:'not_ready'});
  await assert.rejects(close(registry,workspace,key,2),{code:'stale_epoch'});
  registry.primary(key).view.activity='running';const busy=(await close(registry,workspace,key)).operation;assert.equal(busy.state,'rejected');assert.equal(busy.error?.code,'not_ready');
  registry.primary(key).view.activity='idle';child.pendingMessageCount=1;const queued=(await close(registry,workspace,key)).operation;assert.equal(queued.state,'rejected');assert.equal(queued.error?.code,'not_ready');assert.equal(child.pendingMessageCount,1);
  await assert.rejects(close(registry,workspace,key,1,{epoch:1,clearQueue:true}),{code:'invalid_request'});
  assert.equal(child.stdin.writableEnded,false);assert.equal(child.writes.some(record=>['abort','clear_queue'].includes(record.type)),false);
});
