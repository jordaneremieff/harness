import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {AgentError} from '../agents/index.mts';
import {configurationReply,STORAGE} from '../agents/fake-host.mts';
import {decodeResponse} from '../agents/contract.mts';
import type {OperationView,Target} from '../shared/api.ts';
import {Operations} from './operations.mts';
import {StateStore} from './state.mts';
import {dispatchAgent} from './routes-agent.mts';
import type {Registry} from './registry.mts';

function assertConfigurationOperation(mode:string,first:OperationView):void {
  assert.equal(first.state,mode==='busy'?'rejected':mode==='uncertain'||mode==='lost'?'uncertain':'completed');
  if(mode==='applied'||mode==='retained') {assert.equal(first.receipt?.kind,'configuration');if(first.receipt?.kind==='configuration'){assert.equal(first.receipt.after.model,'fixture/new');assert.equal(first.receipt.afterSource,mode==='retained'?'retained':'live');}}
  if(mode==='busy')assert.match(first.error?.message??'',/busy/);
  if(mode==='uncertain'){assert.equal(first.receipt?.kind,'configuration');assert.equal(first.error?.retry,'none');}
}

test('configure stores authoritative after values and dispatches once for repeated operation keys',async t=> {
  const root=await mkdtemp(join(tmpdir(),'ui-configure-'));const store=await StateStore.open(root);t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});
  const operations=new Operations(store),workspace=(await store.workspace()).id,target:Target={kind:'agent',identity:STORAGE};let calls=0;
  let mode='applied';
  const registry={store,operations,options:{},workspace:async()=>workspace,agents:{configure:async(identity:string,input:{operationId:string;thinkingLevel:string})=> {
    calls++;assert.equal(identity,STORAGE);assert.ok(input.operationId);
    if(mode==='lost')throw new AgentError('host_unavailable','Connection lost after dispatch',true);
    if(mode==='busy')throw new AgentError('configure_refused','conversation is busy; configuration requires an idle conversation');
    const value=configurationReply(identity);value.afterSource=mode==='retained'?'retained':'live';
    if(mode==='uncertain'){value.outcome='failed';value.error='The model update was not retained.';(value.persistence as Record<string,unknown>).nativeWrites='uncertain';}
    return decodeResponse('configure',value,{identity});
  }}} as unknown as Registry;
  const run=async(id:string)=>await dispatchAgent(registry,{parts:['api','agents',STORAGE,'configure'],method:'POST',url:new URL('http://localhost/api'),workspace,body:{thinkingLevel:'high'},operationId:id}) as OperationView;
  for(mode of ['applied','retained','busy','uncertain','lost']) {
    const reserved=await operations.reserve(workspace,'agent.configure',target),before=calls;
    const first=await run(reserved.id),again=await run(reserved.id);
    assert.equal(calls,before+1);assert.deepEqual(again,first);
    assertConfigurationOperation(mode,first);
  }
});
