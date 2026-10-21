import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { RetainedReader } from "./retained-read.mts";
import { decodeRetainedDescriptor, decodeRetainedParams, decodeRetainedResponse } from "./contract.mts";

const ROOT = "00000000-0000-4000-8000-000000000001";
const CHILD = `${ROOT}:2`;
const durablePackage = createRequire(import.meta.url).resolve('@earendil-works/pi-durable/package.json');
const durableVersion: string = JSON.parse(await readFile(durablePackage, 'utf8')).version;
// Literal operation identities stay independent of the producer and supportedOperations.
const descriptor = {version:"retained-read/1.0.0",upstream:{codingAgent:"1.2.0",durable:durableVersion},operations:{
  snapshot:{request:"snapshot/1.0.0",response:"snapshot/2.0.0",durable:durableVersion},
  inspect:{request:"inspect/1.1.0",response:"d38d5e5a297d6b3738547ab0154cd494602f01c4a898423a076d2d946e430a6b",durable:durableVersion}}};
const empty = {entries:[],partial:false,revision:"empty",nextBefore:null,
  coverage:{complete:true,entries:0,bytes:0,hiddenExcluded:0,entryLimitReached:false,byteLimitReached:false}};
const history = {view:"history",sessionId:CHILD,conversationId:2,format:"compact",order:"newestFirst",entries:[],nextCursor:null,detail:""};
const script = (config: Record<string,unknown>) => `
const config=${JSON.stringify(config)};
const descriptor=config.descriptor??${JSON.stringify(descriptor)};
const empty=${JSON.stringify(empty)};
if(process.argv.includes('--contract')) {
  process.stdout.write(JSON.stringify(config.descriptor??descriptor)+'\\n');
  process.exit(config.descriptorExit??0);
}
let text='';for await(const chunk of process.stdin) text+=chunk;
const request=JSON.parse(text);
if(Object.keys(request).sort().join(',')!=='expected,id,method,params,sessionId,store,version'||request.version!=='retained-read/1.0.0'||!/^ui-retained:[0-9a-f-]+$/.test(request.id)||JSON.stringify(request.expected)!==JSON.stringify(descriptor.operations[request.method])||!request.store.startsWith('/')) throw new Error('Invalid request contract');
if(config.expectParams && JSON.stringify(request.params)!==JSON.stringify(config.expectParams)) throw new Error('Wrong read parameters');
if(config.hang) {process.stderr.write('READ_READY\\n');if(config.ignoreTerm) process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(99),10000);}
else {
  if(config.stderr) process.stderr.write(config.stderr);
  if(config.rawBytes) process.stdout.write(Buffer.from(config.rawBytes));
  else if(config.raw!==undefined) process.stdout.write(config.raw);
  else {
    let result=config.result??empty;
    if(config.pages) result=request.params.before?{...empty,entries:[{id:'1',kind:'message',model:[{role:'user',content:'first'}]}],revision:'earlier'}:
      {...empty,entries:[{id:'3',kind:'message',model:[{role:'assistant',content:[{type:'text',text:'latest'}],durationMs:0}]}],nextBefore:3,revision:'latest',coverage:{...empty.coverage,complete:false,entries:1,entryLimitReached:true}};
    const response=config.error?{version:request.version,id:request.id,ok:false,error:config.error}:
      {version:request.version,id:request.id,ok:true,method:request.method,sessionId:request.sessionId,storageId:request.sessionId.split(':')[0],conversationId:Number(request.sessionId.split(':')[1]??1),result};
    Object.assign(response,config.patch??{});
    process.stdout.write(JSON.stringify(response)+'\\n');
  }
  process.exitCode=config.exit??(config.error?1:0);
}
`;
async function fixture(t: TestContext, config: Record<string,unknown> = {}, bounds: {timeoutMs?:number;outputBytes?:number;stderrBytes?:number} = {}) {
  const dir=await mkdtemp(join(tmpdir(),"ui-retained-")); const path=join(dir,"reader.mjs");
  await writeFile(path,script(config));
  const calls: {command:string;args:string[];options:unknown}[]=[];
  const reader=new RetainedReader({store:join(dir,"store"),reader:async()=>path,...bounds,
    spawn:(command,args,options)=>{calls.push({command,args,options});return spawn(command,args,options);}});
  t.after(async()=>{await reader.close();await rm(dir,{recursive:true,force:true});});
  return {reader,calls,dir,path};
}

test("literal descriptor and parameter grammar retain exact native identities",()=> {
  assert.deepEqual(decodeRetainedDescriptor(descriptor),descriptor);
  assert.deepEqual(decodeRetainedParams("snapshot",{before:9,limit:2,maxBytes:65536},CHILD),{before:9,limit:2,maxBytes:65536});
  for(const identity of ["AAAAAAAA-0000-4000-8000-000000000001",`${ROOT}:1`,`${ROOT}:02`,`${ROOT}:9007199254740992`,"@agent","../store"])
    if(identity!==ROOT) assert.throws(()=>decodeRetainedParams("snapshot",{},identity));
  for(const params of [{sessionId:ROOT},{conversationId:2},{cwd:"/project"},{ownerId:ROOT},{limit:101},{before:"7"}])
    assert.throws(()=>decodeRetainedParams("snapshot",params,ROOT));
  for(const params of [{view:"exact"},{view:"search"},{view:"result"},{view:"history",requestId:"native"},{view:"history",cursor:{text:"x".repeat(4096)}},{view:"result",requestId:"bad\nselector"}])
    assert.throws(()=>decodeRetainedParams("inspect",params,ROOT));
  assert.deepEqual(decodeRetainedParams("inspect",{view:"result",requestId:"native id",submissionId:2,operationId:"same operation"},ROOT),{view:"result",requestId:"native id",submissionId:2,operationId:"same operation"});
});
test("collaboration uses a separate descriptor and bare storage targets", async t => {
  const collaboration = {version: descriptor.version, upstream: descriptor.upstream, operations: {
    'collaboration-list': {request: 'collaboration-list/1.0.0', response: 'collaboration-list/1.0.0'},
    'collaboration-read': {request: 'collaboration-read/1.0.0', response: 'collaboration-read/1.0.0'}}};
  assert.deepEqual(decodeRetainedDescriptor(collaboration, true), collaboration);
  assert.throws(() => decodeRetainedDescriptor(collaboration));
  assert.throws(() => decodeRetainedParams('collaboration-list', {}, CHILD));
  assert.throws(() => decodeRetainedParams('collaboration-list', {limit: 21}, ROOT));
  assert.throws(() => decodeRetainedParams('collaboration-read', {threadId: `${CHILD}/${'a'.repeat(32)}`}, ROOT));
  const list = {items: [{id: `${ROOT}/${'a'.repeat(32)}`, title: 'Plan', purpose: 'Read', updatedAt: 1, closed: false, members: 1}], nextCursor: null, coverage: {complete: true, visited: 1, omitted: 0}};
  const f = await fixture(t, {descriptor: collaboration, result: list, expectParams: {limit: 20}});
  assert.deepEqual(await f.reader.request('collaboration-list', ROOT, {limit: 20}), list);
  assert.deepEqual(f.calls.map(call => call.args), [[f.path, '--contract', 'collaboration'], [f.path]]);
  const foreign = {...list, items: [{...list.items[0], id: `00000000-0000-4000-8000-000000000099/${'a'.repeat(32)}`}]};
  assert.throws(() => decodeRetainedResponse('collaboration-list', {version: descriptor.version, id: 'one', ok: true, method: 'collaboration-list', sessionId: ROOT, storageId: ROOT, conversationId: 1, result: foreign}, 'one', ROOT));
});

test("one-shot fake executable returns a confirmed empty snapshot, not live capability",async t=> {
  const f=await fixture(t,{stderr:'diagnostic only\n'});
  assert.deepEqual(await f.reader.request("snapshot",ROOT,{}),empty);
  assert.equal(f.calls.length,2);
  assert.equal(f.calls[0].command,process.execPath);
  assert.deepEqual(f.calls.map(call=>call.args),[[f.path,"--contract"],[f.path]]);
  assert.ok(f.calls.every(call=>(call.options as {shell:boolean;detached:boolean}).shell===false && (call.options as {detached:boolean}).detached===false));
  assert.ok(f.calls.every(call=>!call.args.some(arg=>arg.includes("durable-runner") || arg.includes("createDurableRuntime"))));
});
test("snapshot pagination keeps anchors, native message durations and chronological IDs",async t=> {
  const f=await fixture(t,{pages:true});
  const latest=await f.reader.request("snapshot",CHILD,{limit:1,maxBytes:65536});
  assert.equal(latest.nextBefore,3);assert.deepEqual(latest.entries.map(entry=>entry.id),["3"]);
  assert.equal(((latest.entries[0].model as Record<string,unknown>[])[0]).durationMs,0);
  const earlier=await f.reader.request("snapshot",CHILD,{before:latest.nextBefore,limit:1,maxBytes:65536});
  assert.equal(earlier.nextBefore,null);assert.deepEqual(earlier.entries.map(entry=>entry.id),["1"]);
  assert.equal(f.calls.length,4);
});
test("exact and unavailable result inspection retain their native semantics",async t=> {
  const exact={view:"exact",sessionId:CHILD,conversationId:2,entryId:7,offset:0,text:'{"id":7}',truncated:false,nextOffset:null};
  const f=await fixture(t,{result:exact});
  assert.deepEqual(await f.reader.request("inspect",CHILD,{view:"exact",entryId:7,offset:0}),exact);
  const missing={view:"result",sessionId:CHILD,conversationId:2,status:"unavailable",requestId:"native",reason:"No retained submission",usage:{models:{},tools:{}}};
  const g=await fixture(t,{result:missing});
  assert.deepEqual(await g.reader.request("inspect",CHILD,{view:"result",requestId:"native"}),missing);
});
for(const patch of [{id:"other"},{version:"retained-read/2.0.0"},{method:"inspect"},{sessionId:ROOT},{storageId:"00000000-0000-4000-8000-000000000099"},{conversationId:1},{live:true}])
  test(`response mismatch ${Object.keys(patch)[0]} never yields an empty page`,async t=> {
    const f=await fixture(t,{patch});await assert.rejects(f.reader.request("snapshot",CHILD,{}),{code:"protocol_error"});assert.equal(f.calls.length,2);
  });
for(const raw of ["",JSON.stringify(empty),"{}\n{}\n","not json\n",`${JSON.stringify({version:"retained-read/1.0.0",id:null,ok:false,error:{code:"not_found",message:"Missing",retryable:false}})}\n`])
  test("missing, malformed, trailing or uncorrelated output is not retained-empty",async t=> {
    const f=await fixture(t,{raw});await assert.rejects(f.reader.request("snapshot",ROOT,{}),{code:"protocol_error"});assert.equal(f.calls.length,2);
  });
for(const field of ["request","response","durable"] as const)
  test(`descriptor ${field} mismatch refuses before the read child`,async t=> {
    const bad=structuredClone(descriptor);bad.operations.snapshot[field]="wrong";
    if(field==="durable") bad.operations.snapshot.durable="1.0.3";
    const f=await fixture(t,{descriptor:bad});await assert.rejects(f.reader.request("snapshot",ROOT,{}));assert.equal(f.calls.length,1);
  });
test("unknown descriptor fields and missing operations fail closed",async t=> {
  for(const bad of [{...descriptor,live:true},{...descriptor,operations:{snapshot:descriptor.operations.snapshot}}]) {
    const f=await fixture(t,{descriptor:bad});await assert.rejects(f.reader.request("snapshot",ROOT,{}),{code:"protocol_error"});assert.equal(f.calls.length,1);
  }
});
for(const [code,retryable] of [["not_found",false],["source_unreadable",false],["source_changed",true],["timeout",true],["incompatible",false]] as const)
  test(`structured ${code} preserves refusal and explicit retry policy without replay`,async t=> {
    const f=await fixture(t,{error:{code,message:"Retained read refused",retryable}});
    await assert.rejects(f.reader.request("snapshot",ROOT,{}),{code,retryable});assert.equal(f.calls.length,2);
  });
test("failure exit policy, error policy, native payload and inspection view are checked",async t=> {
  for(const config of [{exit:1},{error:{code:"not_found",message:"Missing",retryable:false},exit:0},{error:{code:"not_found",message:"Missing",retryable:true}},{error:{code:"unknown",message:"Unknown",retryable:false}},{result:{...empty,entries:[{id:"1",kind:"system"}]}},{result:{...empty,nextBefore:0}}]) {
    const f=await fixture(t,config);await assert.rejects(f.reader.request("snapshot",ROOT,{}),{code:"protocol_error"});
  }
  const f=await fixture(t,{result:{...history,view:"activity"}});await assert.rejects(f.reader.request("inspect",CHILD,{view:"history"}),{code:"protocol_error"});
});
test("stdout and stderr bounds fail rather than truncate JSON or parse diagnostics",async t=> {
  const f=await fixture(t,{raw:"x".repeat(2048)},{outputBytes:1024});await assert.rejects(f.reader.request("snapshot",ROOT,{}),{code:"limit_exceeded"});
  const g=await fixture(t,{stderr:"x".repeat(100)},{stderrBytes:64});await assert.rejects(g.reader.request("snapshot",ROOT,{}),{code:"limit_exceeded"});
});
test("invalid UTF-8 output fails the transport decoder",async t=> {
  const f=await fixture(t,{rawBytes:[123,195,40,125,10]});
  await assert.rejects(f.reader.request("snapshot",ROOT,{}),{code:"protocol_error"});
});
test("inspect history passes opaque cursors and native result selectors unchanged",async t=> {
  const cursor={kind:"history",before:7};
  const f=await fixture(t,{result:history,expectParams:{view:"history",cursor,limit:2}});
  assert.deepEqual(await f.reader.request("inspect",CHILD,{view:"history",cursor,limit:2}),history);
  const result={view:"result",sessionId:CHILD,conversationId:2,status:"unavailable",requestId:"different",reason:"No retained submission",usage:{models:{},tools:{}}};
  const g=await fixture(t,{result});
  await assert.rejects(g.reader.request("inspect",CHILD,{view:"result",requestId:"native"}),{code:"protocol_error"});
});
test("missing executable and pre-dispatch cancellation do not succeed or retry",async t=> {
  const f=await fixture(t);await rm(f.path);
  await assert.rejects(f.reader.request("snapshot",ROOT,{}));assert.equal(f.calls.length,1);
  const controller=new AbortController();controller.abort();
  await assert.rejects(f.reader.request("snapshot",ROOT,{},controller.signal),{code:"cancelled"});assert.equal(f.calls.length,1);
});
test("caller deadline kills an unresponsive reader; no envelope means transport failure",{timeout:4000},async t=> {
  const f=await fixture(t,{hang:true,ignoreTerm:true},{timeoutMs:1000});
  await assert.rejects(f.reader.request("snapshot",ROOT,{}),{code:"timeout",retryable:true});assert.equal(f.calls.length,2);
});
test("close and explicit caller abort release the owned read process only",{timeout:4000},async t=> {
  for(const close of [false,true]) {
    const f=await fixture(t,{hang:true});const controller=new AbortController();
    let ready!:()=>void;const boundary=new Promise<void>(resolve=>{ready=resolve;});
    const reader=new RetainedReader({store:join(f.dir,"store"),reader:async()=>f.path,spawn:(command,args,options)=> {
      const child=spawn(command,args,options);child.stderr?.on("data",()=>ready());return child;
    }});t.after(()=>reader.close());
    const read=reader.request("snapshot",ROOT,{},controller.signal);
    const outcome=assert.rejects(read,{code:"cancelled"});await boundary;
    if(close) await reader.close();else controller.abort();await outcome;
  }
});
test("invalid target or request never reaches executable discovery",async()=> {
  let discoveries=0;
  const reader=new RetainedReader({store:"/synthetic",reader:async()=>{discoveries++;return "/synthetic/reader";}});
  await assert.rejects(reader.request("snapshot",`${ROOT}:1`,{}),{code:"invalid_request"});
  await assert.rejects(reader.request("inspect",ROOT,{view:"history",cursor:{text:"x".repeat(4096)}}),{code:"invalid_request"});
  assert.equal(discoveries,0);await reader.close();
});
test("literal failure decoder excludes target fields and incorrect retryable values",()=> {
  const envelope={version:"retained-read/1.0.0",id:"literal",ok:false,error:{code:"source_changed",message:"Source changed",retryable:true}};
  assert.deepEqual(decodeRetainedResponse("snapshot",envelope,"literal",ROOT),{ok:false,error:envelope.error});
  assert.throws(()=>decodeRetainedResponse("snapshot",{...envelope,method:"snapshot"},"literal",ROOT));
});
