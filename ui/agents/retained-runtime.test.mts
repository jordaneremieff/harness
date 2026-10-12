import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { hostname } from "node:os";
import test from "node:test";
import { AgentService, HostLink, AgentError, type AgentCatalog, type CatalogRecord } from "./service-runtime.mts";
import type { RetainedReader } from "./retained-read.mts";

const ROOT="00000000-0000-4000-8000-000000000001";
const CHILD=`${ROOT}:2`;
const snapshot={entries:[{id:"7",kind:"message",model:[{role:"user",content:"retained"}]}],partial:false,revision:"retained:7",nextBefore:7,
  coverage:{complete:false,entries:1,bytes:8,hiddenExcluded:0,entryLimitReached:true,byteLimitReached:false}};
const exact={view:"exact",sessionId:CHILD,conversationId:2,entryId:7,offset:0,text:'{"id":7}',truncated:false,nextOffset:null};

for(const state of ["stored","incompatible"] as const) test(`${state} reads remain independent of live preparation, controls and observations`,async t=> {
  const record:CatalogRecord={storageId:ROOT,cwd:"/project",agentDir:"/untrusted/record",packageDir:"/untrusted/package",storagePath:"/untrusted/record.sqlite",model:{provider:"fixture",modelId:"inert"},thinkingLevel:"off",createdAt:"2026-01-01T00:00:00.000Z"};
  const claim=Buffer.from(JSON.stringify({sessionId:ROOT,cwd:record.cwd,host:hostname(),createdAt:record.createdAt,pid:1}));
  const opened=t.mock.method(fs,"open",async()=> {
    if(state==="stored") throw Object.assign(new Error("No claim"),{code:"ENOENT"});
    return {stat:async()=>({isFile:()=>true,size:claim.length}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>({bytesRead:claim.copy(buffer,offset,position,position+length),buffer}),close:async()=>{}};
  });syncBuiltinESMExports();t.after(()=>{opened.mock.restore();syncBuiltinESMExports();});t.mock.method(process,"kill",()=>true);
  let connections=0, readerClosed=0;const reads:unknown[][]=[];const availability:unknown[][]=[];
  t.mock.method(HostLink,"connect",async()=>{connections++;throw new AgentError("contract_mismatch","Host uses another contract");});
  const service=new AgentService({store:"/trusted/backend/store",installationId:"fixture",onAvailability:(...args)=>availability.push(args)},
    ()=>({get:()=>record,close:async()=>{}} as unknown as AgentCatalog),
    ()=>({request:async(method:string,identity:string,params:unknown)=>{reads.push([method,identity,params]);return method==="snapshot"?snapshot:exact;},close:async()=>{readerClosed++;}} as unknown as RetainedReader));
  t.after(()=>service.close());
  await assert.rejects(service.prepare(CHILD),{code:state==="stored"?"stored":"contract_mismatch"});
  await assert.rejects(service.select("workspace",CHILD,1));
  assert.equal(availability.at(-1)?.[3],state);
  assert.deepEqual(await service.history(CHILD,{before:9,limit:1,maxBytes:64}),snapshot);
  assert.deepEqual(await service.inspect(CHILD,{view:"exact",entryId:7,offset:0}),exact);
  assert.deepEqual(reads,[["snapshot",CHILD,{limit:1,maxBytes:64,before:9}],["inspect",CHILD,{view:"exact",entryId:7,offset:0}]]);
  assert.ok(connections===(state==="stored"?0:4));
  const count=reads.length;await service.hide("workspace");assert.equal(reads.length,count);
  await service.close();assert.equal(readerClosed,1);
});
test("compatible live snapshot preserves the live path without a reader call",async t=> {
  const record:CatalogRecord={storageId:ROOT,cwd:"/project",agentDir:"/agent",packageDir:"/package",storagePath:"/project.sqlite",model:{provider:"fixture",modelId:"inert"},thinkingLevel:"off",createdAt:"2026-01-01T00:00:00.000Z"};
  const claim=Buffer.from(JSON.stringify({sessionId:ROOT,cwd:record.cwd,host:hostname(),createdAt:record.createdAt,pid:1}));
  const opened=t.mock.method(fs,"open",async()=>({stat:async()=>({isFile:()=>true,size:claim.length}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>({bytesRead:claim.copy(buffer,offset,position,position+length),buffer}),close:async()=>{}}));
  syncBuiltinESMExports();t.after(()=>{opened.mock.restore();syncBuiltinESMExports();});t.mock.method(process,"kill",()=>true);
  const calls:string[]=[];
  t.mock.method(HostLink,"connect",async(endpoint:unknown)=>({endpoint,connected:true,request:async(member:string)=>{calls.push(member);return snapshot;},close:async()=>{}} as unknown as HostLink));
  const service=new AgentService({store:"/backend",installationId:"fixture"},()=>({get:()=>record,close:async()=>{}} as unknown as AgentCatalog),()=>({request:()=>{throw Error("No cold reader for compatible live read");},close:async()=>{}} as unknown as RetainedReader));
  t.after(()=>service.close());assert.deepEqual(await service.history(ROOT),snapshot);assert.deepEqual(calls,["snapshot"]);
});
test("retained refusal never becomes an empty snapshot and never loops",async()=> {
  let reads=0;
  const service=new AgentService({store:"/backend",installationId:"fixture"},()=>({get:()=>undefined,close:async()=>{}} as unknown as AgentCatalog),()=>({request:async()=>{reads++;throw new AgentError("source_changed","Source changed",false,true);},close:async()=>{}} as unknown as RetainedReader));
  try {await assert.rejects(service.history(ROOT),{code:"source_changed",retryable:true});assert.equal(reads,1);}
  finally {await service.close();}
});
