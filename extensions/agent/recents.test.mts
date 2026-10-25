import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {ROOT_CONVERSATION_ID,defineTask} from '@earendil-works/pi-durable';
import {AgentCatalog} from './catalog.ts';
import {AgentDeliveryDoc,AgentForkDoc} from './durable-controls.ts';
import {DurableHost} from './durable-host.ts';
import {DurableObservation} from './durable-observation.ts';
import {answerMessage, fixtureRegistry, fixtureRuntime, hostOptions} from './durable-host-fixture.mts';
import {fixtureMetadata} from './host-fixture.mts';
import {creationActor, RECENTS_OPERATION} from './recents.ts';
import {retainedRead, retainedReadDescriptor} from './retained-read.ts';
import {HOST_CONTRACT} from './version-contract.ts';
const id='00000000-0000-4000-8000-000000000001';
const request=(store='/synthetic',sessionId=id,conversationIds:number[]=[1])=>({version:'retained-read/1.0.0',id:'recents-check',store,sessionId,method:'recents',expected:{...RECENTS_OPERATION,durable:HOST_CONTRACT.upstream.durable},params:{conversationIds}});
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value));

test('creator identity alone never identifies the actor of ordinary commands or forks',async()=>{
  for(const ownerId of [undefined,id,`${id}:2`,'operator:malformed'])assert.equal(creationActor({ownerId}),'unknown');
  assert.equal(creationActor({ownerId:`operator:${'a'.repeat(64)}`}),'operator');
  let opens=0;
  const response=await retainedRead(bytes(request()),undefined,{readCatalog:()=>({storagePath:'/no-database',ownerId:id,createdAt:'2026-10-20T00:00:00.000Z'}),open:async()=>{opens++;throw Error('No snapshot for unknown origin');}});
  assert.equal(response.ok,true);if(!response.ok)return;
  assert.deepEqual(response.result,{items:[{conversationId:1,activity:{creator:'unknown',createdAt:Date.parse('2026-10-20T00:00:00.000Z')}}]});assert.equal(opens,0);
});

test('the retained Recents contract rejects invalid batches and version mismatch before source access',async()=>{
  let reads=0;const hooks={readCatalog:()=>{reads++;throw Error('No source access');}};
  for(const input of [{...request(),sessionId:`${id}:2`},{...request(),params:{cwd:'/other'}},{...request(),params:{conversationIds:[]}},{...request(),params:{conversationIds:[1,1]}},{...request(),params:{conversationIds:[0]}},{...request(),expected:{...request().expected,durable:'0.0.0'}}]){
    const response=await retainedRead(bytes(input),undefined,hooks);assert.equal(response.ok,false);
  }
  assert.equal(reads,0);
  const descriptor=retainedReadDescriptor('recents') as {operations:unknown};assert.deepEqual(descriptor.operations,{recents:request().expected});
});

test('a current reader derives root activity without changing a live host or its old publication',async t=>{
  const root=mkdtempSync(join(tmpdir(),'agent-recents-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const catalog=new AgentCatalog(root),{storageId:_storageId,storagePath:_storagePath,...metadata}=fixtureMetadata(root);
  const record=catalog.create({...metadata,ownerId:`operator:${'b'.repeat(64)}`});
  const host=await DurableHost.open({...hostOptions(record.storagePath,await fixtureRuntime('answer'),fixtureRegistry()),storageId:record.storageId,resume:false});t.after(()=>host.close());
  await host.harness.commit(async tx=>{
    const prompt=await tx.appendEntry(ROOT_CONVERSATION_ID,{kind:'pi.user',model:[{role:'user',content:'Operator prompt',timestamp:100}]});
    const answer=await tx.appendEntry(ROOT_CONVERSATION_ID,{kind:'pi.assistant',model:[{...answerMessage('Actual answer'),timestamp:200}]});
    await tx.appendEntry(ROOT_CONVERSATION_ID,{kind:'pi.assistant',model:[{...answerMessage('Tool commentary'),timestamp:300,stopReason:'toolUse',content:[{type:'text',text:'Tool commentary'},{type:'toolCall',id:'call',name:'read',arguments:{}}]}]});
    const peer=await tx.appendEntry(ROOT_CONVERSATION_ID,{kind:'pi.user',model:[{role:'user',content:'Agent message',timestamp:400}]});
    await tx.appendEntry(ROOT_CONVERSATION_ID,{kind:'agent.status',data:{timestamp:999}});
    const delivery=await tx.doc(AgentDeliveryDoc);
    const receipt={requestId:'operator-request',ownerId:record.storageId,conversationId:ROOT_CONVERSATION_ID,operationId:null,status:'done' as const,answerEntryId:answer.id,answer:'Actual answer',reason:null,acknowledged:true};
    delivery.receipts['1']={...receipt,submissionId:1 as never,origin:'operator',entryId:prompt.id};
    delivery.receipts['2']={...receipt,submissionId:2 as never,origin:'model',entryId:peer.id};
  },BACKGROUND_CONTEXT);
  const oldPublication={updatedAt:'2026-10-25T00:00:00.000Z',rows:await host.request('dashboard'),coverage:{complete:true,omitted:0}};
  catalog.updateView(record.storageId,oldPublication as never);
  assert.equal((oldPublication.rows as {recents?:unknown}[])[0].recents,undefined);
  const before=createHash('sha256').update(readFileSync(catalog.path(record.storageId))).digest('hex');
  const nativeBefore=await host.harness.inspect(BACKGROUND_CONTEXT);
  const response=await retainedRead(bytes(request(root,record.storageId)));
  assert.equal(response.ok,true,JSON.stringify(response));if(!response.ok)return;
  assert.deepEqual(response.result,{items:[{conversationId:1,activity:{creator:'operator',createdAt:Date.parse(record.createdAt),hasMessages:true,lastUserAt:100,lastAnswerAt:200}}]});
  assert.equal(createHash('sha256').update(readFileSync(catalog.path(record.storageId))).digest('hex'),before);
  assert.deepEqual(await host.harness.inspect(BACKGROUND_CONTEXT),nativeBefore);
});

test('one retained snapshot classifies operator rewind, task-owned and unknown children before activity reads',async t=>{
  const root=mkdtempSync(join(tmpdir(),'agent-recents-batch-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const catalog=new AgentCatalog(root),{storageId:_id,storagePath:_path,...metadata}=fixtureMetadata(root),record=catalog.create({...metadata,ownerId:id});
  const anchor=defineTask<null,{phase:'hold'},null>({name:'recents-fixture-anchor',version:1,initial:()=>({phase:'hold'}),phases:{hold:async()=>{}},abort:(_task,runtime,context)=>runtime.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),context)});
  const registry=fixtureRegistry();registry.install({name:'recents-fixture-anchor',tasks:[anchor]});
  const host=await DurableHost.open({...hostOptions(record.storagePath,await fixtureRuntime('answer'),registry),storageId:record.storageId,resume:false});t.after(()=>host.close());
  const parent=await host.harness.commit(tx=>tx.appendEntry(ROOT_CONVERSATION_ID,{kind:'pi.assistant',model:[{...answerMessage('Inherited answer'),timestamp:9000}]}),BACKGROUND_CONTEXT);
  const children=await host.harness.commit(async tx=>{
    const operator=await tx.forkConversation(ROOT_CONVERSATION_ID,parent.id,{ownership:{kind:'ownerless'}});
    const task=await tx.createTask(anchor,null,{ownership:{kind:'conversation'},conversationId:ROOT_CONVERSATION_ID,background:true});
    const model=await tx.forkConversation(ROOT_CONVERSATION_ID,parent.id,{ownership:{kind:'task',taskId:task}});
    const plain=await tx.forkConversation(ROOT_CONVERSATION_ID,parent.id,{ownership:{kind:'ownerless'}});
    const forks=await tx.doc(AgentForkDoc);forks.forks['operator-rewind']=operator.id;forks.forks['model-proof']=model.id;forks.forks['plain-fork']=plain.id;
    const delivery=await tx.doc(AgentDeliveryDoc);
    for(const [conversation,requestId,at] of [[operator,'operator-rewind',600],[model,'model-proof',800],[plain,'later-operator-input',1000]] as const){
      const input=await tx.appendEntry(conversation.id,{kind:'pi.user',model:[{role:'user',content:'Operator input',timestamp:at}]});
      const answer=await tx.appendEntry(conversation.id,{kind:'pi.assistant',model:[{...answerMessage('Own answer'),timestamp:at+100}]});
      delivery.receipts[String(at)]={submissionId:at as never,requestId,ownerId:id,conversationId:conversation.id,operationId:null,origin:'operator',entryId:input.id,answerEntryId:answer.id,status:'done',answer:'Own answer',reason:null,acknowledged:true};
    }
    return {operator:operator.id,model:model.id,plain:plain.id};
  },BACKGROUND_CONTEXT);
  const nativeBefore=await host.harness.inspect(BACKGROUND_CONTEXT),before=createHash('sha256').update(readFileSync(catalog.path(record.storageId))).digest('hex');
  let copies=0;const activityReads:number[]=[],open=DurableObservation.open;
  t.mock.method(DurableObservation,'open',async(...args:Parameters<typeof DurableObservation.open>)=>{
    copies++;const observation=await open(...args),conversation=observation.harness.conversation.bind(observation.harness);
    t.mock.method(observation.harness,'conversation',async(...input:Parameters<typeof conversation>)=>{activityReads.push(input[0]);return conversation(...input);});return observation;
  });
  const response=await retainedRead(bytes(request(root,record.storageId,[1,children.operator,children.model,children.plain])));
  assert.equal(response.ok,true,JSON.stringify(response));if(!response.ok)return;
  assert.deepEqual(response.result,{items:[
    {conversationId:1,activity:{creator:'unknown',createdAt:Date.parse(record.createdAt)}},
    {conversationId:children.operator,activity:{creator:'operator',hasMessages:true,lastUserAt:600,lastAnswerAt:700}},
    {conversationId:children.model,activity:{creator:'agent'}},
    {conversationId:children.plain,activity:{creator:'unknown'}},
  ]});
  assert.equal(copies,1);assert.deepEqual(activityReads,[children.operator]);
  assert.equal(createHash('sha256').update(readFileSync(catalog.path(record.storageId))).digest('hex'),before);
  assert.deepEqual(await host.harness.inspect(BACKGROUND_CONTEXT),nativeBefore);
});
