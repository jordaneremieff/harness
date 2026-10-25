import assert from 'node:assert/strict';
import test from 'node:test';
import {cancelNativeRequest,stopNativeRun} from './native-control.ts';
const id='00000000-0000-4000-8000-000000000001';
test('Stop keeps the admitted group selector across a native generation change',async context=>{
  const calls:{path:string;body:unknown}[]=[];const runId=17;let taskId=44;
  context.mock.method(globalThis,'fetch',async(path:unknown,init?:RequestInit)=>{
    calls.push({path:String(path),body:init?.body?JSON.parse(String(init.body)):null});
    if(String(path).endsWith('/run-scope')){const observed=taskId;taskId=45;return Response.json({ok:true,data:{sessionId:id,runId,taskId:observed}});}
    if(String(path)==='/api/operations')return Response.json({ok:true,data:{operationId:'stop-run'}});
    return Response.json({ok:true,data:{kind:'agent.control',state:'completed'}});
  });
  await stopNativeRun(id);assert.equal(taskId,45);
  assert.deepEqual(calls.at(-1)?.body,{method:'run-stop',params:{runId:17}});assert.equal(calls.some(call=>call.path.endsWith('/abort')),false);
});
test('Stop never substitutes a newer independent input group',async context=>{
  let current=17,body:unknown;
  context.mock.method(globalThis,'fetch',async(path:unknown,init?:RequestInit)=>{
    if(String(path).endsWith('/run-scope')){const selected=current;current=18;return Response.json({ok:true,data:{sessionId:id,runId:selected,taskId:44}});}
    if(String(path)==='/api/operations')return Response.json({ok:true,data:{operationId:'stop-group'}});
    body=JSON.parse(String(init?.body));return Response.json({ok:true,data:{kind:'agent.control',state:'completed',receipt:{kind:'rpc',result:{value:{runId:17,state:'settled'},truncated:false}}}});
  });
  await stopNativeRun(id);assert.equal(current,18);assert.deepEqual(body,{method:'run-stop',params:{runId:17}});
});
test('a settled observed run performs no mutation',async context=>{
  let calls=0;context.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({ok:true,data:{sessionId:id,runId:null,taskId:null}});});
  assert.equal(await stopNativeRun(id),undefined);assert.equal(calls,1);
});
test('unknown Stop admission is not replayed',async context=>{
  let mutations=0;context.mock.method(globalThis,'fetch',async(path:unknown)=>{
    if(String(path).endsWith('/run-scope'))return Response.json({ok:true,data:{sessionId:id,runId:4,taskId:11}});
    if(String(path)==='/api/operations')return Response.json({ok:true,data:{operationId:'stop-run'}});
    mutations++;throw new Error('response lost');
  });
  await assert.rejects(stopNativeRun(id),/response lost/);assert.equal(mutations,1);
});
test('result cards request exact queued withdrawal rather than infer cancellation ownership',async context=>{
  const result={sessionId:id,submissionId:42,requestId:'exact-input'};let body:unknown;
  context.mock.method(globalThis,'fetch',async(path:unknown,init?:RequestInit)=>{
    if(String(path)==='/api/operations')return Response.json({ok:true,data:{operationId:'cancel-input'}});
    body=JSON.parse(String(init?.body));return Response.json({ok:true,data:{kind:'agent.control',state:'completed'}});
  });
  await cancelNativeRequest(result);assert.deepEqual(body,{method:'request-cancel',params:{result}});
});
