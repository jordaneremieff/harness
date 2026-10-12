import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const DIAGNOSTIC_FILE_BYTES=1024*1024;
export const DIAGNOSTIC_RECORD_BYTES=1024;
export const DIAGNOSTIC_QUEUE_RECORDS=256;
export const DIAGNOSTIC_QUEUE_BYTES=256*1024;
export const DIAGNOSTIC_BATCH_BYTES=16*1024;
export type DiagnosticInput={event:'measure'|'reload'|'connection'|'loss';code?:'none'|'failed'|'deferred'|'applied'|'offline'|'auth'|'overflow';metric?:'editor-echo'|'reducer'|'render'|'control-roundtrip'|'switch'|'stream-to-render';durationMs?:number;count?:number;bytes?:number;status?:number};
type RecordSource='server'|'browser'|'build';
type DiagnosticRecord=DiagnosticInput & {v:1;at:number;boot:string;source:RecordSource;build?:string;dropped?:number};
export type DiagnosticWriter={append(record:string):Promise<void>;close():Promise<void>};
const events=new Set(['measure','reload','connection','loss']);
const codes=new Set(['none','failed','deferred','applied','offline','auth','overflow']);
const metrics=new Set(['editor-echo','reducer','render','control-roundtrip','switch','stream-to-render']);
const bounded=(value:unknown,max:number,integer=false)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max&&(!integer||Number.isInteger(value));
const add=(left:number,right=1)=>Math.min(Number.MAX_SAFE_INTEGER,left+right);
const validators:Record<string,(value:unknown)=>boolean>={
  event:value=>typeof value==='string'&&events.has(value),code:value=>typeof value==='string'&&codes.has(value),metric:value=>typeof value==='string'&&metrics.has(value),
  durationMs:value=>bounded(value,60000),count:value=>bounded(value,Number.MAX_SAFE_INTEGER,true),bytes:value=>bounded(value,16*1024*1024,true),status:value=>bounded(value,599,true)&&(value as number)>=100
};
function validField(key:string,value:unknown) {const validate=Object.hasOwn(validators,key)?validators[key]:undefined;return !!validate&&(value===undefined?key!=='event':validate(value));}
/** Unknown fields are rejected. No arbitrary string reaches the stored record. */
export function diagnosticInput(value:unknown):DiagnosticInput|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value)) return;
  const object=value as Record<string,unknown>;
  if(!Object.hasOwn(object,'event')||typeof object.event!=='string'||!events.has(object.event)) return;
  if(!Object.entries(object).every(([key,value])=>validField(key,value))) return;
  if(object.event==='measure'&&(object.metric===undefined||object.durationMs===undefined)) return;
  return {...object} as DiagnosticInput;
}
/** One asynchronous queue owns every producer. Input never awaits a disk write. */
export class DiagnosticSink {
  private queue:string[]=[];
  private queueBytes=0;
  private working?:Promise<void>;
  private failed=false;
  private closed=false;
  private dropped=0;
  private pendingLoss=0;
  private accepted=0;
  private written=0;
  private tokens=40;
  private at:number;
  private boot=randomBytes(8).toString('hex');
  private sessions=new Map<string,number>();
  private requests={at:0,count:0,mean:0};
  private writer:DiagnosticWriter;
  private clock:()=>number;
  private wall:()=>number;
  private build:()=>string|undefined;
  constructor(writer:DiagnosticWriter,clock=()=>performance.now(),wall=Date.now,build=()=>undefined as string|undefined) {this.writer=writer;this.clock=clock;this.wall=wall;this.build=build;this.at=clock();this.requests.at=this.at;}
  state() {return {queued:this.queue.length,bytes:this.queueBytes,accepted:this.accepted,written:this.written,dropped:this.dropped,failed:this.failed};}
  private loss(count=1) {this.dropped=add(this.dropped,count);this.pendingLoss=add(this.pendingLoss,count);}
  emit(value:unknown,source:RecordSource='server') {
    const input=diagnosticInput(value);if(!input||this.closed||this.failed) {this.loss();return false;}
    if(!this.takeToken()) {this.loss();return false;}
    if(!this.enqueue(input,source)) {this.loss();return false;}
    this.accepted=add(this.accepted);return true;
  }
  ingest(session:string,body:unknown,bytes:number) {
    const prior=this.sessions.get(session);
    if(!body||typeof body!=='object'||Array.isArray(body)||!bounded(bytes,DIAGNOSTIC_BATCH_BYTES,true)) {this.loss();return {accepted:0,dropped:1,failed:this.failed};}
    const batch=body as Record<string,unknown>;
    if(!Object.hasOwn(batch,'records')||!Object.hasOwn(batch,'dropped')||Object.keys(batch).some(key=>key!=='records'&&key!=='dropped')||!Array.isArray(batch.records)||batch.records.length>16||!bounded(batch.dropped,Number.MAX_SAFE_INTEGER,true)) {this.loss();return {accepted:0,dropped:1,failed:this.failed};}
    const now=this.clock();
    if((prior!==undefined&&now-prior<1000)||(!this.sessions.has(session)&&this.sessions.size>=64)) {this.loss(batch.records.length);return {accepted:0,dropped:batch.records.length,failed:this.failed};}
    this.sessions.set(session,now);this.loss(batch.dropped as number);
    let accepted=0;for(const record of batch.records) if(this.emit(record,'browser')) accepted++;
    return {accepted,dropped:batch.records.length-accepted,failed:this.failed};
  }
  revoke(session:string) {this.sessions.delete(session);}
  request(durationMs:number) {
    if(!bounded(durationMs,60000)) return;
    const aggregate=this.requests;aggregate.count=add(aggregate.count);aggregate.mean+=(durationMs-aggregate.mean)/aggregate.count;
    const now=this.clock();if(now-aggregate.at<5000) return;
    this.requests={at:now,count:0,mean:0};this.emit({event:'connection',code:'none',durationMs:aggregate.mean,count:aggregate.count});
  }
  private takeToken() {
    const now=this.clock();this.tokens=Math.min(40,this.tokens+Math.max(0,now-this.at)*0.02);this.at=now;
    if(this.tokens<1) return false;this.tokens--;return true;
  }
  private enqueue(input:DiagnosticInput,source:RecordSource,dropped?:number) {
    const record:DiagnosticRecord={v:1,at:this.wall(),boot:this.boot,source,...input};
    const build=this.build();if(build&&/^[a-f0-9]{64}$/.test(build)) record.build=build;
    if(dropped!==undefined) record.dropped=dropped;
    const encoded=`${JSON.stringify(record)}\n`;const bytes=Buffer.byteLength(encoded);
    if(bytes>DIAGNOSTIC_RECORD_BYTES||this.queue.length>=DIAGNOSTIC_QUEUE_RECORDS||this.queueBytes+bytes>DIAGNOSTIC_QUEUE_BYTES) return false;
    this.queue.push(encoded);this.queueBytes+=bytes;
    this.kick();return true;
  }
  private kick() {this.working??=Promise.resolve().then(()=>this.run()).finally(()=>{this.working=undefined;if(this.queue.length&&!this.failed) this.kick();});}
  private async run() {
    while(this.queue.length&&!this.failed) {
      const record=this.queue[0];if(!record) break;
      try {await this.writer.append(record);this.written=add(this.written);this.queue.shift();this.queueBytes-=Buffer.byteLength(record);}
      catch {this.failed=true;this.loss(this.queue.length);this.queue=[];this.queueBytes=0;break;}
      if(this.pendingLoss&&this.takeToken()) {const count=this.pendingLoss;if(this.enqueue({event:'loss',code:'overflow',count},'server',count)) this.pendingLoss=0;}
    }
  }
  async drain() {while(this.working) await this.working;}
  async close() {this.closed=true;await this.drain();await this.writer.close().catch(()=>{this.failed=true;});}
}

function requireLogFile(stat:Stats) {
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o600||stat.size>DIAGNOSTIC_FILE_BYTES) throw new Error('diagnostics-unavailable');
}
/** A fixed four-file set survives boots; overflow rotates before the next record. */
export class DiagnosticDisk implements DiagnosticWriter {
  private file:FileHandle;
  private size:number;
  private directory:string;
  private constructor(directory:string,file:FileHandle,size:number) {this.directory=directory;this.file=file;this.size=size;}
  static async open(stateDir:string) {
    const state=await lstat(stateDir);if(!state.isDirectory()||state.isSymbolicLink()||state.uid!==process.getuid?.()) throw new Error('diagnostics-unavailable');
    const directory=join(resolve(stateDir),'diagnostics');
    await mkdir(directory,{mode:0o700}).catch(error=>{if(!(error&&typeof error==='object'&&'code'in error&&error.code==='EEXIST')) throw error;});
    return DiagnosticDisk.existing(directory);
  }
  private static async existing(directory:string) {
    const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||stat.uid!==process.getuid?.()) throw new Error('diagnostics-unavailable');
    const directoryHandle=await opendir(directory,{bufferSize:1});let count=0;
    for await(const entry of directoryHandle) {
      if(++count>4||!['current.jsonl','1.jsonl','2.jsonl','3.jsonl'].includes(entry.name)) throw new Error('diagnostics-unavailable');
      await DiagnosticDisk.check(join(directory,entry.name));
    }
    const path=join(directory,'current.jsonl');let file:FileHandle;
    try {file=await open(path,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);}
    catch(error) {if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')) throw error;file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
    try {const stat=await file.stat();requireLogFile(stat);return new DiagnosticDisk(directory,file,stat.size);}
    catch(error) {await file.close();throw error;}
  }
  private static async check(path:string) {
    requireLogFile(await lstat(path));
  }
  async append(record:string) {
    const bytes=Buffer.byteLength(record);if(bytes>DIAGNOSTIC_RECORD_BYTES) throw new Error('diagnostics-unavailable');
    if(this.size+bytes>DIAGNOSTIC_FILE_BYTES) await this.rotate();
    const result=await this.file.write(record);if(result.bytesWritten!==bytes) throw new Error('diagnostics-unavailable');this.size+=bytes;
  }
  private async rotate() {
    await this.file.close();await rm(join(this.directory,'3.jsonl'),{force:true});
    for(let index=2;index>=0;index--) await this.moveRotation(index);
    this.file=await open(join(this.directory,'current.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);this.size=0;
  }
  private async moveRotation(index:number) {
    const from=join(this.directory,index===0?'current.jsonl':`${index}.jsonl`);
    try {await DiagnosticDisk.check(from);await rename(from,join(this.directory,`${index+1}.jsonl`));}
    catch(error) {if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')) throw error;}
  }
  close() {return this.file.close();}
}
