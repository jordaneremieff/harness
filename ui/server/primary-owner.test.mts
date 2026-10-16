import assert from 'node:assert/strict';
import {spawn,type SpawnOptions} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import test,{type TestContext} from 'node:test';
import {createPrimaryOwner,type PrimaryOwner} from './primary-owner.mts';
import {OWNER_PROTOCOL,type OwnerAction,type OwnerBaseline,type OwnerCapture,type OwnerCapturePage,type OwnerDescriptor,type OwnerLimits,type OwnerMutation,type OwnerNotice,type OwnerOutcome,type OwnerRecord,type OwnerReply,type OwnerRequest} from '../shared/owner.ts';

class FakeChild extends EventEmitter {
  pid=43210;stdout=new PassThrough();stderr=new PassThrough();writes:OwnerRecord[]=[];ended=false;
  onCommand:(record:OwnerRecord)=>void=record=>this.answer(record,record.type==='get_state'?{pendingMessageCount:0}:record.type==='clear_queue'?{steering:[],followUp:[]}:{disposition:'started'});
  stdin=new Writable({write:(chunk,_encoding,callback)=> {const record=JSON.parse(String(chunk)) as OwnerRecord;this.writes.push(record);queueMicrotask(()=>this.onCommand(record));callback();},final:callback=>{this.ended=true;queueMicrotask(()=>this.emit('exit',0,null));callback();}});
  answer(record:OwnerRecord,data:OwnerRecord[string]) {this.emitRecord({type:'response',id:record.id,command:record.type,success:true,data});}
  emitRecord(record:OwnerRecord) {this.stdout.write(`${JSON.stringify(record)}\n`);}
  exit() {this.emit('exit',0,null);}
}
const mutation=(operationId=randomUUID(),step='input'):OwnerMutation=>({operationId,digest:createHash('sha256').update(operationId).digest('hex'),step});
function value<T>(reply:OwnerReply):T {assert.equal(reply.ok,true,JSON.stringify(reply));return (reply as {ok:true;value:unknown}).value as T;}
async function call<T>(owner:PrimaryOwner,attachment:string,action:OwnerAction):Promise<T> {return value<T>(await owner.handle(attachment,{...action,protocol:OWNER_PROTOCOL,ownerIncarnation:owner.incarnation,requestId:randomUUID()}));}
async function fixture(t:TestContext,limits:Partial<OwnerLimits>={}) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-owner-')));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'project');await mkdir(cwd);
  const child=new FakeChild(),children=[child];let spawnOptions:SpawnOptions|undefined;
  const spawnChild=((_command:unknown,_args:unknown,options:SpawnOptions)=>{const next=spawnOptions?new FakeChild():child;if(spawnOptions){next.pid+=children.length;children.push(next);}spawnOptions=options;return next;}) as unknown as typeof spawn;
  const owner=await createPrimaryOwner({state:{root,instanceId:'fixture'},spawnChild,limits});const notices:OwnerNotice[]=[];
  owner.connect('old',notice=>{notices.push(notice);});owner.grant('old');
  const primary=await call<OwnerDescriptor>(owner,'old',{kind:'open',primary:{key:'primary',epoch:1,cwd,executable:'fake',recoveryWorkspaceId:'workspace'}});
  t.after(async()=>{for(const child of children)child.exit();await owner.dispose();await rm(root,{recursive:true,force:true});});
  const address={primaryKey:'primary',epoch:1};
  const command=(record:OwnerRecord,binding?:OwnerMutation,attachment='old')=>call<OwnerOutcome>(owner,attachment,{kind:'command',...address,record,...(binding?{mutation:binding}:{})});
  return {owner,child,children,root,cwd,notices,primary,address,command,get spawnOptions(){return spawnOptions;}};
}
async function baseline(owner:PrimaryOwner,attachment:string,address:{primaryKey:string;epoch:number}) {
  const begin=await call<{token:string;from:number}>(owner,attachment,{kind:'capture-begin',...address});
  const metadata=await call<OwnerCapture>(owner,attachment,{kind:'capture-finish',...address,token:begin.token});
  const chunks:Buffer[]=[];for(let index=0;index<metadata.pages;index++){const page=await call<OwnerCapturePage>(owner,attachment,{kind:'capture-page',...address,token:begin.token,index});chunks.push(Buffer.from(page.data,'base64'));}
  return {begin,metadata,value:JSON.parse(Buffer.concat(chunks).toString('utf8')) as OwnerBaseline};
}

test('primary uses detached pipes, and backend detach does not close or abort Pi',async t=> {
  const f=await fixture(t);assert.equal(f.spawnOptions?.detached,true);assert.deepEqual(f.spawnOptions?.stdio,['pipe','pipe','pipe']);assert.equal(f.spawnOptions?.shell,false);
  f.owner.detach('old');assert.equal(f.child.ended,false);assert.equal(f.child.writes.length,0);
  await assert.rejects(f.owner.dispose(),/Live primary/);assert.equal(f.owner.descriptors()[0]?.pid,f.primary.pid);
});
test('a late old-attachment response reconciles under its exact identity without replay',async t=> {
  const f=await fixture(t);let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let input:OwnerRecord|undefined;
  f.child.onCommand=record=>{input=record;entered();};const binding=mutation();const pending=f.command({type:'prompt',message:'once'},binding);await ready;
  f.owner.detach('old');f.owner.connect('new',()=>{});f.owner.grant('new');assert.ok(input);f.child.answer(input,{disposition:'started'});
  const outcome=await pending;assert.equal(outcome.state,'complete');assert.equal(outcome.written,true);
  const found=await call<OwnerOutcome>(f.owner,'new',{kind:'outcome',...f.address,mutation:binding});assert.deepEqual(found,outcome);
  const duplicate=await f.command({type:'prompt',message:'once'},binding,'new');assert.deepEqual(duplicate,outcome);assert.equal(f.child.writes.length,1);
  const conflict=await f.owner.handle('new',{kind:'command',...f.address,record:{type:'prompt',message:'different'},mutation:binding,protocol:OWNER_PROTOCOL,ownerIncarnation:f.owner.incarnation,requestId:'conflict'});assert.equal(conflict.ok,false);
});
test('assistant end notices preserve the observed start sequence outside raw records',async t=> {
  const f=await fixture(t);f.child.emitRecord({type:'message_start',message:{role:'assistant',content:[]}});
  const raw={type:'message_end',message:{role:'assistant',content:[{type:'text',text:'final'}]}};
  f.child.emitRecord(raw);await f.command({type:'get_state'});
  const start=f.notices.find(notice=>notice.kind==='record'&&notice.event.record.type==='message_start');
  const end=f.notices.find(notice=>notice.kind==='record'&&notice.event.record.type==='message_end');
  assert.ok(start?.kind==='record');assert.ok(end?.kind==='record');
  assert.equal(end.event.messageStartSequence,start.event.seq);assert.deepEqual(end.event.record,raw);
});
test('unknown replies do not terminate Pi or misroute into a new pending command',async t=> {
  const f=await fixture(t);f.child.emitRecord({type:'response',id:'unknown',command:'prompt',success:true,data:{disposition:'started'}});
  const captured=await baseline(f.owner,'old',f.address);assert.equal(captured.value.descriptor.synchronized,false);assert.equal(f.child.ended,false);assert.ok(captured.value.reasons.includes('unknown-response'));
});
test('actual RPC deltas survive capture and overflow never aborts or pauses stdout',async t=> {
  const f=await fixture(t,{tapeBytes:200});f.child.emitRecord({type:'message_start',message:{role:'assistant',timestamp:1,content:[]}});
  for(let index=0;index<30;index++)f.child.emitRecord({type:'message_update',usage:{input:1},assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'stream'}});
  const captured=await baseline(f.owner,'old',f.address);assert.equal(captured.metadata.complete,false);assert.ok(captured.value.reasons.includes('active-message-overflow'));assert.equal(f.child.stdout.isPaused(),false);assert.equal(f.child.ended,false);assert.equal(f.child.writes.length,0);
  await call(f.owner,'old',{kind:'capture-ack',...f.address,token:captured.begin.token});
  f.child.emitRecord({type:'message_end',message:{role:'assistant',timestamp:1,content:[{type:'text',text:'complete'}]}});
  const next=await baseline(f.owner,'old',f.address);assert.equal(next.metadata.complete,true);assert.equal(f.owner.descriptors()[0]?.pid,f.primary.pid);
});
test('prepared input uses reserved correlation and is written exactly once across attachment loss',async t=> {
  const f=await fixture(t);const binding=mutation();const prepared=await call<OwnerOutcome>(f.owner,'old',{kind:'prepare',...f.address,mutation:binding,bytes:4096});
  const line=`${JSON.stringify({type:'prompt',id:prepared.id,message:'image',images:[{type:'image',mimeType:'image/png',data:'fixture'}]})}\n`;
  const result=await call<OwnerOutcome>(f.owner,'old',{kind:'prepared',...f.address,id:prepared.id,line});assert.equal(result.state,'complete');assert.equal(f.child.writes[0]?.id,prepared.id);
  f.owner.detach('old');f.owner.connect('new',()=>{});f.owner.grant('new');
  const repeated=await call<OwnerOutcome>(f.owner,'new',{kind:'prepared',...f.address,id:prepared.id,line});assert.equal(repeated.id,result.id);assert.equal(f.child.writes.length,1);
});
test('unadmitted prepared bytes are retired on detach without a Pi write',async t=> {
  const f=await fixture(t);const prepared=await call<OwnerOutcome>(f.owner,'old',{kind:'prepare',...f.address,mutation:mutation(),bytes:4096});
  f.owner.detach('old');f.owner.connect('new',()=>{});f.owner.grant('new');
  const outcome=await call<OwnerOutcome>(f.owner,'new',{kind:'outcome',...f.address,id:prepared.id});assert.equal(outcome.state,'refused');assert.equal(outcome.written,false);assert.equal(f.child.writes.length,0);
});
test('queue response persists separately before acknowledgment and survives owner reopen',async t=> {
  const f=await fixture(t);const reservation={id:'clear-1',workspaceId:'workspace',pendingCount:2};
  f.child.onCommand=record=>f.child.answer(record,{steering:['one'],followUp:['two']});
  const outcome=await call<OwnerOutcome>(f.owner,'old',{kind:'command',...f.address,record:{type:'clear_queue'},mutation:mutation(),recovery:reservation});assert.equal(outcome.state,'complete');
  const recoveries=await call<unknown[]>(f.owner,'old',{kind:'recoveries'});assert.equal(recoveries.length,1);assert.equal(f.owner.descriptors()[0]?.recoveryPending,true);
  f.child.exit();await f.owner.dispose();const next=await createPrimaryOwner({state:{root:f.root,instanceId:'fixture'}});t.after(()=>next.dispose());next.connect('next',()=>{});next.grant('next');
  assert.deepEqual(await call(next,'next',{kind:'recoveries'}),recoveries);await call(next,'next',{kind:'recovery-ack',id:'clear-1'});assert.deepEqual(await call(next,'next',{kind:'recoveries'}),[]);
});
test('absent-backend shutdown preserves queue before abort and EOF',async t=> {
  const f=await fixture(t);f.owner.detach('old');
  f.child.onCommand=record=>f.child.answer(record,record.type==='get_state'?{pendingMessageCount:1}:record.type==='clear_queue'?{steering:['retained'],followUp:[]}:{});
  await f.owner.shutdownPrimary('primary');assert.deepEqual(f.child.writes.map(record=>record.type),['get_state','clear_queue','abort']);assert.equal(f.child.ended,true);
  f.owner.connect('inspect',()=>{});const recoveries=await call<unknown[]>(f.owner,'inspect',{kind:'recoveries'});assert.equal(recoveries.length,1);
});
test('stale attachment cannot dispatch a mutation or answer a dialog',async t=> {
  const f=await fixture(t);f.owner.connect('new',()=>{});f.owner.grant('new');
  const request={kind:'command',...f.address,record:{type:'prompt',message:'no'},mutation:mutation(),protocol:OWNER_PROTOCOL,ownerIncarnation:f.owner.incarnation,requestId:'stale'} as OwnerRequest;
  const result=await f.owner.handle('old',request);assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'stale_attachment');assert.equal(f.child.writes.length,0);
});
test('large wire records decode outside the owner callback and remain bounded',async t=> {
  const f=await fixture(t);f.child.emitRecord({type:'tool_execution_start',toolCallId:'tool',toolName:'read',args:{}});
  f.child.emitRecord({type:'tool_execution_update',toolCallId:'tool',toolName:'read',args:{},partialResult:{content:[{type:'text',text:'x'.repeat(300000)}]}});
  const captured=await baseline(f.owner,'old',f.address);assert.equal(captured.metadata.complete,true);assert.equal(captured.value.tools.length,1);
});
test('original-epoch receipts survive transition while old-epoch effects remain fenced',async t=> {
  const f=await fixture(t),binding=mutation();const outcome=await f.command({type:'new_session'},binding);
  await call(f.owner,'old',{kind:'epoch',...f.address,next:2});
  await call(f.owner,'old',{kind:'operation-complete',...f.address,mutation:binding,result:{cancelled:false}});
  assert.deepEqual(await call(f.owner,'old',{kind:'operation-result',...f.address,operationId:binding.operationId,digest:binding.digest}),{cancelled:false});
  assert.equal((await call<OwnerOutcome>(f.owner,'old',{kind:'outcome',...f.address,id:outcome.id})).id,outcome.id);
  assert.equal(await call(f.owner,'old',{kind:'ack',...f.address,id:outcome.id}),true);
  const response=await f.owner.handle('old',{kind:'command',...f.address,record:{type:'prompt',message:'stale'},mutation:mutation(),protocol:OWNER_PROTOCOL,ownerIncarnation:f.owner.incarnation,requestId:'old-epoch'});
  assert.equal(response.ok,false);assert.equal(f.child.writes.length,1);
});
test('durable acknowledgments release lifetime capacity without evicting unacknowledged outcomes',async t=> {
  const f=await fixture(t,{outcomes:4}),held=await f.command({type:'prompt',message:'unacknowledged'},mutation());
  let last=mutation();
  for(let index=0;index<12;index++) {
    const read=await f.command({type:'get_state'});await call(f.owner,'old',{kind:'ack',...f.address,id:read.id});
    last=mutation();await f.command({type:'prompt',message:'once'},last);
    await call(f.owner,'old',{kind:'operation-complete',...f.address,mutation:last,result:{done:true}});
    assert.equal(await call(f.owner,'old',{kind:'ack',...f.address,id:last.operationId}),true);
  }
  assert.deepEqual(await call(f.owner,'old',{kind:'outcome',...f.address,id:held.id}),held);
  const writes=f.child.writes.length;
  await assert.rejects(f.command({type:'prompt',message:'once'},last),/operation_conflict/);
  await assert.rejects(f.command({type:'prompt',message:'another step'},{...last,step:'later'}),/operation_conflict/);
  assert.equal(f.child.writes.length,writes);
  assert.equal(await call(f.owner,'old',{kind:'operation-result',...f.address,operationId:last.operationId,digest:last.digest}),null);
});
test('operation retirement waits for every step and keeps original epoch identities',async t=> {
  const f=await fixture(t),binding=mutation(),first=await f.command({type:'prompt',message:'first'},binding);
  let entered!:()=>void,record:OwnerRecord|undefined;const ready=new Promise<void>(resolve=>{entered=resolve;});
  f.child.onCommand=value=>{record=value;entered();};
  const pending=f.command({type:'prompt',message:'second'},{...binding,step:'second'});await ready;
  await call(f.owner,'old',{kind:'operation-complete',...f.address,mutation:binding,result:{done:true}});
  await call(f.owner,'old',{kind:'epoch',...f.address,next:2});
  await assert.rejects(call(f.owner,'old',{kind:'ack',...f.address,id:binding.operationId}),/unsettled step/);
  await call(f.owner,'old',{kind:'ack',...f.address,id:first.id});
  assert.deepEqual(await call(f.owner,'old',{kind:'operation-result',...f.address,operationId:binding.operationId,digest:binding.digest}),{done:true});
  assert.ok(record);f.child.answer(record,{disposition:'started'});const second=await pending;
  assert.equal(await call(f.owner,'old',{kind:'ack',...f.address,id:second.id}),true);
  assert.equal(await call(f.owner,'old',{kind:'operation-result',...f.address,operationId:binding.operationId,digest:binding.digest}),null);
  await assert.rejects(call(f.owner,'old',{kind:'operation-complete',...f.address,mutation:binding,result:{done:true}}),/durably acknowledged/);
});
test('completed operations without raw steps retire through their operation identity',async t=> {
  const f=await fixture(t,{outcomes:2});
  for(let index=0;index<6;index++) {
    const binding=mutation();await call(f.owner,'old',{kind:'operation-complete',...f.address,mutation:binding,result:{refused:true}});
    assert.equal(await call(f.owner,'old',{kind:'ack',...f.address,id:binding.operationId}),true);
  }
});
test('same-key reopen requires prior exit and durable queue recovery import',async t=> {
  const f=await fixture(t),description={key:'primary',epoch:1,cwd:f.cwd,executable:'fake',recoveryWorkspaceId:'workspace'};
  await assert.rejects(call(f.owner,'old',{kind:'open',primary:description}),/still owns/);
  await call(f.owner,'old',{kind:'command',...f.address,record:{type:'clear_queue'},mutation:mutation(),recovery:{id:'reopen-queue',workspaceId:'workspace',pendingCount:0}});
  f.child.exit();await assert.rejects(call(f.owner,'old',{kind:'open',primary:description}),/still owns/);
  const before=f.owner.descriptors()[0]?.sequence;await call(f.owner,'old',{kind:'recovery-ack',id:'reopen-queue'});
  const reopened=await call<OwnerDescriptor>(f.owner,'old',{kind:'open',primary:description});
  assert.notEqual(reopened.pid,f.primary.pid);assert.equal(reopened.sequence,before);assert.equal(reopened.exited,false);
  await f.command({type:'get_state'});assert.ok((f.owner.descriptors()[0]?.sequence??0)>(before??0));
});
test('successful get_state claims the canonical saved file before another writer opens',async t=> {
  const f=await fixture(t),file=join(f.cwd,'session.jsonl');await writeFile(file,'{}\n');
  f.child.onCommand=record=>f.child.answer(record,{pendingMessageCount:0,sessionFile:file});
  const state=await f.command({type:'get_state'});assert.equal(state.state,'complete');assert.equal(f.owner.descriptors()[0]?.sessionFile,await realpath(file));
  await assert.rejects(call(f.owner,'old',{kind:'open',primary:{key:'other',epoch:1,cwd:f.cwd,executable:'fake',sessionFile:`${f.cwd}/../project/session.jsonl`,recoveryWorkspaceId:'workspace'}}),/another owner/);
  assert.equal(f.children.length,1);
});
test('an isolated supervisor group SIGINT leaves detached fake Pi alive until deliberate close',{timeout:15000},async t=> {
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-owner-signal-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const fake=`let text='';process.stdin.on('data',chunk=>{text+=chunk;let at;while((at=text.indexOf('\\n'))>=0){const line=text.slice(0,at);text=text.slice(at+1);const value=JSON.parse(line);const data=value.type==='get_state'?{pendingMessageCount:0}:value.type==='clear_queue'?{steering:[],followUp:[]}:{};process.stdout.write(JSON.stringify({type:'response',id:value.id,command:value.type,success:true,data})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`;
  const script=`import {spawn} from 'node:child_process';import {createPrimaryOwner} from ${JSON.stringify(new URL('./primary-owner.mts',import.meta.url).href)};import {OWNER_PROTOCOL} from ${JSON.stringify(new URL('../shared/owner.ts',import.meta.url).href)};
    const owner=await createPrimaryOwner({state:{root:${JSON.stringify(root)},instanceId:'signal'},spawnChild:(_command,_args,options)=>spawn(process.execPath,['-e',${JSON.stringify(fake)}],options)});owner.connect('backend',()=>{});owner.grant('backend');
    const request=(action)=>owner.handle('backend',{...action,protocol:OWNER_PROTOCOL,ownerIncarnation:owner.incarnation,requestId:'request'});
    const opened=await request({kind:'open',primary:{key:'primary',epoch:1,cwd:${JSON.stringify(root)},executable:'fake',recoveryWorkspaceId:'workspace'}});if(!opened.ok)throw new Error('open');
    await request({kind:'command',primaryKey:'primary',epoch:1,record:{type:'get_state'}});
    process.on('SIGINT',()=>{void(async()=>{let alive=true;try{process.kill(opened.value.pid,0);}catch{alive=false;}process.stdout.write(JSON.stringify({survived:alive})+'\\n');owner.detach('backend');await owner.shutdownPrimary('primary',3000);await owner.dispose();process.stdout.write(JSON.stringify({closed:true})+'\\n');})().catch(()=>process.exit(2));});
    process.stdout.write(JSON.stringify({ready:true,pid:opened.value.pid})+'\\n');`;
  const parent=spawn(process.execPath,['--input-type=module','-e',script],{detached:true,stdio:['ignore','pipe','pipe']});
  let pi:number|undefined,output='',errors='';const records:Record<string,unknown>[]=[];let notify!:()=>void;
  const ready=new Promise<void>(resolve=>{notify=resolve;});
  parent.stdout.on('data',chunk=>{output+=String(chunk);let index=output.indexOf('\n');while(index>=0){const line=output.slice(0,index);output=output.slice(index+1);const record=JSON.parse(line) as Record<string,unknown>;records.push(record);if(record.ready===true){pi=Number(record.pid);notify();}index=output.indexOf('\n');}});
  parent.stderr.on('data',chunk=>{errors=(errors+String(chunk)).slice(-8192);});
  t.after(()=>{if(parent.pid)try{process.kill(-parent.pid,'SIGKILL');}catch{}if(pi)try{process.kill(pi,'SIGKILL');}catch{}});
  const exited=new Promise<number|null>((resolve,reject)=>{parent.once('error',reject);parent.once('exit',resolve);});
  const timer=setTimeout(()=>{parent.kill('SIGKILL');},10000);t.after(()=>clearTimeout(timer));
  await Promise.race([ready,exited.then(code=>{throw new Error(`Supervisor exited before ready: ${code} ${errors}`);})]);
  assert.ok(parent.pid);process.kill(-parent.pid,'SIGINT');assert.equal(await exited,0,errors);
  assert.ok(records.some(record=>record.survived===true));assert.ok(records.some(record=>record.closed===true));
});
test('owner runtime import closure excludes projections, state and external packages',async()=> {
  const files=['primary-owner.mts','owner-records.mts','owner-recovery.mts','owner-decode-worker.mts'];const allowed=new Set(files.map(name=>`./${name}`).concat(['../shared/owner.ts']));
  for(const file of files) {const text=await readFile(new URL(file,import.meta.url),'utf8');for(const match of text.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)){const specifier=match[2]??'';assert.ok(specifier.startsWith('node:')||allowed.has(specifier),`${file}: ${specifier}`);}}
  const shared=await readFile(new URL('../shared/owner.ts',import.meta.url),'utf8');assert.equal(/\bimport\s/.test(shared),false);
});
