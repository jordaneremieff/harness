import assert from 'node:assert/strict';
import test from 'node:test';
import {dispatchAgent} from './routes-agent.mts';
import type {Registry} from './registry.mts';
import type {RequestContext} from './http.mts';
import type {ExecuteRequest,DispatchResult} from './operations.mts';
const identity='00000000-0000-4000-8000-000000000001';
const context=(body:Record<string,unknown>):RequestContext=>({method:'POST',parts:['api','agents',identity,'control'],body,url:new URL('http://localhost/api'),workspace:'workspace',operationId:'exact-operation'});
function fixture() {
  const calls:unknown[]=[];
  const registry={options:{},workspace:async()=> 'workspace',agents:{control:async(...args:unknown[])=>{calls.push(args);return {taskId:7};}},operations:{execute:async(id:string,request:ExecuteRequest,work:()=>Promise<DispatchResult>)=>{calls.push({id,request});return work();}}} as unknown as Registry;
  return {registry,calls};
}
test('native controls retain their operation identity and captured conversation',async()=>{
  const {registry,calls}=fixture();
  const result=await dispatchAgent(registry,context({method:'reset',params:{handoff:'Keep the fixed contract'}})) as DispatchResult;
  assert.equal(result.state,'completed');assert.deepEqual(calls[1],[identity,'reset',{handoff:'Keep the fixed contract',sessionId:identity,requestId:'ui:exact-operation'}]);
  assert.deepEqual((calls[0] as {request:ExecuteRequest}).request.target,{kind:'agent',identity});
});
test('browser parameters never replace server-owned native identity fields',async()=>{
  const {registry,calls}=fixture();
  for(const key of ['sessionId','requestId','senderIdentity'])await assert.rejects(dispatchAgent(registry,context({method:'reset',params:{[key]:'another'}})),{code:'invalid_request'});
  assert.deepEqual(calls,[]);
});
test('spawn and profile controls use the captured native sender, not a browser alias',async()=>{
  const {registry,calls}=fixture();
  await dispatchAgent(registry,context({method:'spawn',params:{name:'Fixture',preset:'worker'}}));
  assert.deepEqual(calls[1],[identity,'spawn',{name:'Fixture',preset:'worker',sessionId:identity,requestId:'ui:exact-operation',senderIdentity:identity}]);
  const params={expectedRevision:'a'.repeat(64),role:'',expertise:'Retained facts'};
  await dispatchAgent(registry,context({method:'profile-update',params}));
  assert.deepEqual(calls[3],[identity,'profile-update',{...params,sessionId:identity,requestId:'ui:exact-operation',senderIdentity:identity}]);
});
test('run-scope reads do not reserve or execute a browser mutation',async()=>{
  const {registry,calls}=fixture();await dispatchAgent(registry,{...context({}),method:'GET',parts:['api','agents',identity,'run-scope']});
  assert.deepEqual(calls,[[identity,'run-scope',{sessionId:identity}]]);
});
