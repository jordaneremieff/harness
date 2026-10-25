import assert from 'node:assert/strict';
import test from 'node:test';
import {HostLink} from './client.mts';
import {FakeHost,STORAGE,descriptor} from './fake-host.mts';
import {decodeInput,decodeResponse,type JsonObject} from './contract.mts';

test('an old abort-first compact contract never receives native compaction',async context=>{
  const contract=await descriptor();const operations=(contract as JsonObject).operations as JsonObject;
  operations.compact={request:'compact/1.0.0',response:'compact/1.0.0',durable:((operations.snapshot as JsonObject).durable)};
  const host=await FakeHost.start({descriptor:contract});context.after(()=>host.close());const link=await HostLink.connect(host.endpoint);context.after(()=>link.close());
  assert.equal(link.supports('compact'),false);await assert.rejects(link.request('compact',{sessionId:STORAGE,wait:false}),{code:'contract_mismatch'});assert.equal(host.calls.some(call=>call.member==='compact'),false);
});
test('run controls correlate the exact native run and input receipt',async context=>{
  let wrong=false;
  const host=await FakeHost.start({handler:call=>{
    if(call.member==='run-stop')return {sessionId:STORAGE,runId:wrong?9:8,state:'stopped',inputs:[],delegations:[],coverage:{complete:true,omitted:0},effects:'partial-effects-possible'};
    return undefined;
  }});context.after(()=>host.close());const link=await HostLink.connect(host.endpoint);context.after(()=>link.close());
  await link.request('run-stop',{sessionId:STORAGE,runId:8},{identity:STORAGE});wrong=true;
  await assert.rejects(link.request('run-stop',{sessionId:STORAGE,runId:8},{identity:STORAGE}),{code:'protocol_error'});
});
test('scope distinguishes the admitted group selector from the generation observation',async context=>{
  const scope={sessionId:STORAGE,runId:16,taskId:44,inputs:[{sessionId:STORAGE,submissionId:16}],delegations:[],coverage:{complete:true,omitted:0}};
  assert.deepEqual(decodeResponse('run-scope',scope,{identity:STORAGE}),scope);
  assert.throws(()=>decodeResponse('run-scope',{...scope,taskId:'44'},{identity:STORAGE}));
  const {taskId:_,...missing}=scope;assert.throws(()=>decodeResponse('run-scope',missing,{identity:STORAGE}));
  const host=await FakeHost.start({handler:call=>call.member==='run-scope'?scope:call.member==='run-stop'?{...scope,state:'stopped',effects:'partial-effects-possible'}:undefined});
  context.after(()=>host.close());const link=await HostLink.connect(host.endpoint);context.after(()=>link.close());
  const observed=await link.request('run-scope',{sessionId:STORAGE},{identity:STORAGE}) as typeof scope;
  await link.request('run-stop',{sessionId:STORAGE,runId:observed.runId},{identity:STORAGE});
  assert.equal(host.calls.find(call=>call.member==='run-stop')?.params?.runId,16);
});
test('queued cancellation never accepts a foreign selector or a malformed effect claim',()=>{
  assert.throws(()=>decodeInput('request-cancel',{sessionId:STORAGE,result:{sessionId:`${STORAGE}:2`,submissionId:4}}));
  assert.throws(()=>decodeResponse('request-cancel',{result:{sessionId:STORAGE,submissionId:4},state:'aborted',effects:'exactly-once'},{identity:STORAGE}));
  const value={result:{sessionId:STORAGE,submissionId:4,requestId:'input'},state:'already_placed',effects:'partial-effects-possible'};
  assert.deepEqual(decodeResponse('request-cancel',value,{identity:STORAGE}),value);
});
