import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DiagnosticDisk, DiagnosticSink, diagnosticInput, DIAGNOSTIC_FILE_BYTES } from './diagnostics.mts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};
const memory=()=>{const rows:string[]=[];return {rows,writer:{append:async(row:string)=>{rows.push(row);},close:async()=>{}}};};

test('the closed schema rejects secret, body, identity, path and arbitrary error fields at construction',async()=> {
  const log=memory();const sink=new DiagnosticSink(log.writer,()=>0,()=>1000);
  const sentinel='SENSITIVE-BODY-SENTINEL';const forbidden=['body','prompt','toolData','headers','cookie','capability','error','path','agentId','sessionId','stack'];
  for(const key of forbidden) assert.equal(sink.emit({event:'connection',code:'failed',[key]:sentinel}),false);
  assert.equal(sink.emit({event:'connection',code:sentinel}),false);
  assert.equal(sink.emit({event:['connection'],code:'none'}),false);
  assert.equal(sink.emit({event:'measure',metric:'reducer',durationMs:NaN}),false);
  assert.equal(sink.emit({event:'measure',metric:'reducer',durationMs:4}),true);
  await sink.drain();assert.equal(log.rows.join('').includes(sentinel),false);
  const record=JSON.parse(log.rows[0]??'{}');assert.deepEqual(Object.keys(record).sort(),['at','boot','durationMs','event','metric','source','v'].sort());
  assert.equal(sink.state().dropped,forbidden.length+3);await sink.close();
});

test('the queue stays within both bounds and reports every dropped record after capacity returns',async()=> {
  let now=0;const hold=deferred();const rows:string[]=[];let first=true;
  const sink=new DiagnosticSink({append:async(row)=>{if(first) {first=false;await hold.promise;}rows.push(row);},close:async()=>{}},()=>now,()=>1000);
  let accepted=0;for(let index=0;index<400;index++) {now+=51;if(sink.emit({event:'connection',code:'none'})) accepted++;}
  assert.equal(accepted,256);assert.equal(sink.state().queued,256);assert.ok(sink.state().bytes<=256*1024);assert.equal(sink.state().dropped,144);
  await Promise.resolve();assert.equal(rows.length,0);assert.equal(sink.state().queued,256);
  hold.resolve();await sink.drain();
  const loss=rows.map(row=>JSON.parse(row)).filter(record=>record.event==='loss');assert.equal(loss.reduce((total,record)=>total+record.count,0),144);
  assert.equal(sink.state().queued,0);assert.equal(sink.state().written,257);await sink.close();
});

test('disk failure produces one stable failure state without blocking the producer or input',async()=> {
  let calls=0;const sink=new DiagnosticSink({append:async()=>{calls++;throw new Error('SENSITIVE-RAW-ERROR');},close:async()=>{}},()=>0);
  assert.equal(sink.emit({event:'connection',code:'none'}),true);
  let inputAccepted=false;inputAccepted=true;assert.equal(inputAccepted,true);
  await sink.drain();assert.equal(sink.state().failed,true);assert.equal(sink.state().dropped,1);assert.equal(calls,1);
  assert.equal(sink.emit({event:'connection',code:'none'}),false);await sink.drain();assert.equal(calls,1);assert.equal(sink.state().dropped,2);await sink.close();
});

test('batch, session cadence, global rate, and client loss counts are independent finite bounds',async()=> {
  let now=0;const log=memory();const sink=new DiagnosticSink(log.writer,()=>now);
  const records=Array.from({length:16},()=>({event:'connection',code:'none'}));
  assert.deepEqual(sink.ingest('session',{records,dropped:3},1000),{accepted:16,dropped:0,failed:false});
  assert.equal(sink.ingest('session',{records,dropped:0},1000).dropped,16);
  assert.equal(sink.ingest('other',{records,dropped:0},17000).accepted,0);
  assert.equal(sink.ingest('third',{records:Array(17).fill({event:'loss'}),dropped:0},1000).accepted,0);
  assert.equal(sink.ingest('invalid',{records:[],dropped:0},NaN).dropped,1);assert.equal(sink.ingest('prototype',Object.create({records:[],dropped:0}),100).dropped,1);
  assert.equal(sink.state().dropped,23);now=1000;assert.equal(sink.ingest('session',{records,dropped:0},1000).accepted,16);
  await sink.drain();sink.revoke('session');assert.equal(sink.ingest('session',{records:[],dropped:0},100).accepted,0);await sink.close();
  const flood=memory();const limited=new DiagnosticSink(flood.writer,()=>0);let count=0;
  for(let index=0;index<50;index++) if(limited.emit({event:'connection'})) count++;
  assert.equal(count,40);assert.equal(limited.state().dropped,10);await limited.close();
});

test('internal loss summaries consume the same global record budget as producers',async()=> {
  let now=0;const log=memory();const sink=new DiagnosticSink(log.writer,()=>now);
  for(let index=0;index<40;index++) assert.equal(sink.emit({event:'connection'}),true);
  assert.equal(sink.emit({event:'connection'}),false);await sink.drain();assert.equal(log.rows.length,40);
  now=1000;assert.equal(sink.emit({event:'connection'}),true);await sink.drain();assert.equal(log.rows.length,42);
  const summary=JSON.parse(log.rows[41]??'{}');assert.equal(summary.event,'loss');assert.equal(summary.count,1);
  for(let index=0;index<18;index++) assert.equal(sink.emit({event:'connection'}),true);
  assert.equal(sink.emit({event:'connection'}),false);await sink.drain();assert.equal(log.rows.length,60);assert.equal(sink.state().dropped,2);await sink.close();
});

test('routine server requests aggregate by the server clock without a per-request log',async()=> {
  let now=0;const log=memory();const sink=new DiagnosticSink(log.writer,()=>now);
  for(let index=0;index<100;index++) sink.request(2);assert.equal(sink.state().accepted,0);
  now=5000;sink.request(4);await sink.drain();assert.equal(log.rows.length,1);const record=JSON.parse(log.rows[0]??'{}');
  assert.equal(record.event,'connection');assert.equal(record.count,101);assert.ok(Math.abs(record.durationMs-(204/101))<0.00001);await sink.close();
});

test('numeric shape and metric names reject nested payloads rather than string coercion',()=> {
  for(const candidate of [Object.create({event:'connection'}),{event:{toString:()=> 'loss'},body:'secret'},{event:'measure',metric:['reducer'],durationMs:1},{event:'loss',count:-1},{event:'loss',bytes:Infinity},{event:'loss',status:99},{event:'measure',metric:'private-timer',durationMs:1}]) assert.equal(diagnosticInput(candidate),undefined);
  assert.deepEqual(diagnosticInput({event:'measure',metric:'editor-echo',durationMs:0,count:0}),{event:'measure',metric:'editor-echo',durationMs:0,count:0});
});

test('rotation occurs before overflow and retains no more than four MiB across repeated boots',async context=> {
  const root=await mkdtemp(join(tmpdir(),'diagnostics-'));context.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'diagnostics');await mkdir(directory,{mode:0o700});
  for(const name of ['current.jsonl','1.jsonl','2.jsonl','3.jsonl']) await writeFile(join(directory,name),Buffer.alloc(DIAGNOSTIC_FILE_BYTES-Number(name==='current.jsonl')*512,0x20),{mode:0o600});
  const disk=await DiagnosticDisk.open(root);await disk.append(`${'x'.repeat(511)}\n`);assert.equal((await lstat(join(directory,'current.jsonl'))).size,DIAGNOSTIC_FILE_BYTES);
  await disk.append('{}\n');await disk.close();
  assert.equal((await lstat(join(directory,'current.jsonl'))).size,3);assert.equal((await lstat(join(directory,'1.jsonl'))).size,DIAGNOSTIC_FILE_BYTES);
  const names=await readdir(directory);assert.equal(names.length,4);let total=0;
  for(const name of names) {const metadata=await lstat(join(directory,name));total+=metadata.size;assert.equal(metadata.mode&0o777,0o600);assert.ok(metadata.size<=DIAGNOSTIC_FILE_BYTES);}
  assert.ok(total<=4*DIAGNOSTIC_FILE_BYTES);assert.equal((await lstat(directory)).mode&0o777,0o700);
  const again=await DiagnosticDisk.open(root);await again.append('{}\n');await again.close();assert.equal((await readFile(join(directory,'current.jsonl'),'utf8')),'{}\n{}\n');assert.equal((await readdir(directory)).length,4);
});

test('unexpected files, unsafe permissions and oversized existing files refuse the sink without touching unrelated bytes',async context=> {
  const root=await mkdtemp(join(tmpdir(),'diagnostics-refusal-'));context.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'diagnostics');await mkdir(directory,{mode:0o700});const unrelated=join(directory,'not-a-log');
  await writeFile(unrelated,'retain',{mode:0o600});await assert.rejects(()=>DiagnosticDisk.open(root),/diagnostics-unavailable/);assert.equal(await readFile(unrelated,'utf8'),'retain');
  await rm(unrelated);await writeFile(join(directory,'current.jsonl'),Buffer.alloc(DIAGNOSTIC_FILE_BYTES+1),{mode:0o600});await assert.rejects(()=>DiagnosticDisk.open(root),/diagnostics-unavailable/);
  await writeFile(join(directory,'current.jsonl'),'{}\n');await chmod(join(directory,'current.jsonl'),0o644);await assert.rejects(()=>DiagnosticDisk.open(root),/diagnostics-unavailable/);
});
