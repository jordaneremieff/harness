import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { AgentService, HostLink, AgentError, deriveEndpoint, readClaim, type AgentCatalog, type CatalogRecord } from "./service-runtime.mts";
import { deferred, FakeHost, frame } from "./fake-host.mts";
import type { RetainedReader } from "./retained-read.mts";
import type { ConversationFrame, Snapshot } from "./contract.mts";

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
  const service=new AgentService({store:"/trusted/backend/store",stateDir:"/fixture/state",installationId:"fixture",onAvailability:(...args)=>availability.push(args)},
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
  t.mock.method(HostLink,"connect",async(endpoint:unknown)=>({endpoint,connected:true,onDisconnect:()=>()=>{},request:async(member:string)=>{calls.push(member);return snapshot;},close:async()=>{}} as unknown as HostLink));
  const service=new AgentService({store:"/backend",stateDir:"/fixture/state",installationId:"fixture"},()=>({get:()=>record,close:async()=>{}} as unknown as AgentCatalog),()=>({request:()=>{throw Error("No cold reader for compatible live read");},close:async()=>{}} as unknown as RetainedReader));
  t.after(()=>service.close());assert.deepEqual(await service.history(ROOT),snapshot);assert.deepEqual(calls,["snapshot"]);
});
for (const failed of [false, true]) test(`service shutdown ${failed ? "reports failed" : "awaits acknowledged"} token cleanup before link cancellation`, async t => {
  const record:CatalogRecord={storageId:ROOT,cwd:"/project",agentDir:"/agent",packageDir:"/package",storagePath:"/project.sqlite",model:{provider:"fixture",modelId:"inert"},thinkingLevel:"off",createdAt:"2026-01-01T00:00:00.000Z"};
  const claim=Buffer.from(JSON.stringify({sessionId:ROOT,cwd:record.cwd,host:hostname(),createdAt:record.createdAt,pid:1}));
  const opened=t.mock.method(fs,"open",async()=>({stat:async()=>({isFile:()=>true,size:claim.length}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>({bytesRead:claim.copy(buffer,offset,position,position+length),buffer}),close:async()=>{}}));
  syncBuiltinESMExports();t.after(()=>{opened.mock.restore();syncBuiltinESMExports();});t.mock.method(process,"kill",()=>true);
  const pending=deferred<Snapshot>();const subscribed=deferred<void>();const entered=deferred<void>();const acknowledgement=deferred<void>();
  const events:string[]=[];let connected=true;let catalogClosed=false;let readerClosed=false;
  const link={get connected(){return connected;},require:()=>{},capabilities:()=>({}),onDisconnect:()=>()=>{},
    request:async(member:string)=>{
      if(member==="snapshot") return pending.promise;
      if(member==="observe-close") {events.push("observe-close");entered.resolve();await acknowledgement.promise;
        if(!connected) throw new AgentError("host_unavailable","Link closed during cleanup");
        if(failed) throw Error("Native cleanup failed");events.push("acknowledged");return {closed:false};}
      return {};
    },
    subscribeObservation:async()=>({baseline:frame(1) as ConversationFrame,start:()=>{subscribed.resolve();},dispose:async()=>{events.push("release");}}),
    close:async()=>{events.push("disconnect");connected=false;pending.reject(new AgentError("host_unavailable","Link closed"));},
  } as unknown as HostLink;
  t.mock.method(HostLink,"connect",async()=>link);
  const service=new AgentService({store:"/backend",stateDir:"/fixture/state",installationId:"fixture"},()=>({get:()=>record,close:async()=>{catalogClosed=true;}} as unknown as AgentCatalog),
    ()=>({close:async()=>{readerClosed=true;}} as unknown as RetainedReader));
  const selected=service.select("w",ROOT,1);const setupRejected=assert.rejects(selected,{code:"host_unavailable"});await subscribed.promise;await turn();
  const closed=service.close();const outcome=Promise.allSettled([closed]);
  try {
    await entered.promise;assert.equal(connected,true);assert.deepEqual(events,["release","observe-close"]);
    acknowledgement.resolve();const [result]=await outcome;await setupRejected;
    if(failed) {assert.equal(result.status,"rejected");if(result.status==="rejected") assert.match(String(result.reason),/Native cleanup failed/);}
    else assert.equal(result.status,"fulfilled");
    assert.equal(connected,false);assert.equal(catalogClosed,true);assert.equal(readerClosed,true);
    assert.deepEqual(events,failed?["release","observe-close","disconnect"]:["release","observe-close","acknowledged","disconnect"]);
  } finally {acknowledgement.resolve();await outcome;await setupRejected;}
});

async function claimedService(t: TestContext) {
  const dir=await fs.mkdtemp(join(tmpdir(),"ui-retained-link-"));
  const record:CatalogRecord={storageId:ROOT,cwd:dir,agentDir:dir,packageDir:dir,storagePath:join(dir,`${ROOT}.sqlite`),model:{provider:"fixture",modelId:"inert"},thinkingLevel:"off",createdAt:"2026-01-01T00:00:00.000Z"};
  const endpoint=deriveEndpoint(record);
  await fs.mkdir(dirname(endpoint.claimPath),{recursive:true});
  await fs.mkdir(dirname(endpoint.socketPath),{recursive:true});
  await fs.writeFile(endpoint.claimPath,JSON.stringify({sessionId:ROOT,cwd:dir,host:hostname(),createdAt:record.createdAt,pid:process.pid}));
  const reads:unknown[][]=[];const availability:unknown[][]=[];
  const service=new AgentService({store:dir,stateDir:dir,installationId:"fixture",onAvailability:(...args)=>availability.push(args)},
    ()=>({get:()=>record,close:async()=>{}} as unknown as AgentCatalog),
    ()=>({request:async(method:string,identity:string,params:unknown)=>{reads.push([method,identity,params]);return method==="snapshot"?snapshot:exact;},close:async()=>{}} as unknown as RetainedReader));
  t.after(async()=>{await service.close();await fs.rm(endpoint.socketPath,{force:true});await fs.rm(dir,{recursive:true,force:true});});
  assert.equal((await readClaim(record)).state,"live");
  return {service,endpoint,reads,availability};
}
for(const socket of ["absent","non-socket"] as const) test(`live claim with ${socket} endpoint reads retained evidence without live capability`,async t=> {
  const {service,endpoint,reads,availability}=await claimedService(t);
  if(socket==="non-socket") await fs.writeFile(endpoint.socketPath,"");
  assert.deepEqual(await service.history(CHILD,{before:9,limit:1,maxBytes:64}),snapshot);
  const expected={code:"host_unavailable",...(socket==="absent"?{message:`connect ENOENT ${endpoint.socketPath}`}:{})};
  await assert.rejects(service.prepare(CHILD),expected);
  await assert.rejects(service.select("workspace",CHILD,1),expected);
  assert.equal(availability.at(-1)?.[3],"unavailable");
  if(socket==="absent") assert.equal(availability.at(-1)?.[4],expected.message);
  assert.deepEqual(await service.inspect(CHILD,{view:"exact",entryId:7,offset:0}),exact);
  assert.deepEqual(reads,[["snapshot",CHILD,{limit:1,maxBytes:64,before:9}],["inspect",CHILD,{view:"exact",entryId:7,offset:0}]]);
  await assert.rejects(service.abort(CHILD),{code:"host_unavailable"});
  assert.equal(reads.length,2);
});
test("malformed runtime descriptor disables live access without disabling independent retained reads",async t=> {
  const {service,endpoint,reads}=await claimedService(t);
  const host=await FakeHost.start({endpoint,descriptor:null});t.after(()=>host.close());
  await assert.rejects(service.prepare(CHILD),{code:"protocol_error"});
  assert.deepEqual(await service.history(CHILD),snapshot);
  assert.deepEqual(await service.inspect(CHILD,{view:"exact",entryId:7,offset:0}),exact);
  assert.deepEqual(reads,[["snapshot",CHILD,{limit:50,maxBytes:65536}],["inspect",CHILD,{view:"exact",entryId:7,offset:0}]]);
  assert.deepEqual(host.calls,[]);
});
for(const member of ["snapshot","inspect"] as const) test(`malformed negotiated ${member} refuses retained dispatch`,async t=> {
  const {service,endpoint,reads}=await claimedService(t);
  const host=await FakeHost.start({endpoint,handler:()=>null});t.after(()=>host.close());
  const read=()=>member==="snapshot"?service.history(CHILD):service.inspect(CHILD,{view:"exact",entryId:7});
  await assert.rejects(read(),{code:"protocol_error"});
  await assert.rejects(read(),{code:"protocol_error"});
  assert.deepEqual(reads,[]);assert.deepEqual(host.calls.map(call=>call.member),[member]);
});
test("retained refusal never becomes an empty snapshot and never loops",async()=> {
  let reads=0;
  const service=new AgentService({store:"/backend",stateDir:"/fixture/state",installationId:"fixture"},()=>({get:()=>undefined,close:async()=>{}} as unknown as AgentCatalog),()=>({request:async()=>{reads++;throw new AgentError("source_changed","Source changed",false,true);},close:async()=>{}} as unknown as RetainedReader));
  try {await assert.rejects(service.history(ROOT),{code:"source_changed",retryable:true});assert.equal(reads,1);}
  finally {await service.close();}
});
