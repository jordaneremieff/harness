import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {realpath,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {Worker} from 'node:worker_threads';
import {OWNER_LIMITS,OWNER_PROTOCOL,type OwnerAction,type OwnerDescriptor,type OwnerError,type OwnerHello,type OwnerJson,type OwnerLimits,type OwnerMutation,type OwnerNotice,type OwnerOutcome,type OwnerPrimary,type OwnerRecord,type OwnerReply,type OwnerRequest,type OwnerStateIdentity} from '../shared/owner.ts';
import {OwnerRecords} from './owner-records.mts';
import {OwnerRecoveryStore} from './owner-recovery.mts';

export interface PrimaryOwnerOptions {
  state:OwnerStateIdentity; recoveryDir?:string; spawnChild?:typeof spawn;
  limits?:Partial<OwnerLimits>; now?:()=>number;
}
class OwnerFailure extends Error {
  readonly code:string;readonly uncertain:boolean;
  constructor(code:string,message:string,uncertain=false) {super(message);this.code=code;this.uncertain=uncertain;}
}
function failure(code:string,message:string,uncertain=false):never {throw new OwnerFailure(code,message,uncertain);}
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const readCommands=new Set(['get_state','get_entries','get_tree','get_messages','get_commands','get_available_models','get_available_thinking_levels','get_session_stats','get_last_assistant_text','get_fork_messages']);
const effectCommands=new Set(['prompt','steer','follow_up','abort','clear_queue','new_session','switch_session','fork','set_model','set_thinking_level','set_auto_compaction','set_auto_retry','abort_retry','set_session_name','compact','export_html']);
const actionKeys:Record<string,readonly string[]>={hello:[],open:['primary'],command:['record','mutation','recovery'],prepare:['mutation','bytes'],prepared:['id','line'],'ui-response':['record'],'capture-begin':[],'capture-finish':['token'],'capture-page':['token','index'],'capture-ack':['token'],outcome:['id','mutation'],ack:['id'],'operation-complete':['mutation','result'],'operation-result':['operationId','digest'],epoch:['next','sessionFile'],'close-primary':['timeoutMs'],recoveries:[],'recovery-ack':['id'],detach:[]};
const commandKeys:Record<string,readonly string[]>={
  get_entries:['since'],get_fork_messages:[],prompt:['message','images','streamingBehavior'],steer:['message','images'],follow_up:['message','images'],
  new_session:['parentSession'],switch_session:['sessionPath'],fork:['entryId'],set_model:['provider','modelId'],set_thinking_level:['level'],
  set_auto_compaction:['enabled'],set_auto_retry:['enabled'],set_session_name:['name'],compact:['customInstructions'],export_html:['outputPath'],
};
function canonical(value:unknown,depth=0):string {
  if(depth>32)failure('invalid_request','Owner JSON nesting exceeds its bound.');
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(item=>canonical(item,depth+1)).join(',')}]`;
  if(object(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key],depth+1)}`).join(',')}}`;
  return failure('invalid_request','Owner commands require JSON values.');
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function mutationKey(key:string,epoch:number,mutation:OwnerMutation) {return JSON.stringify([key,epoch,mutation.operationId,mutation.step]);}
function checkMutation(value:OwnerMutation|undefined):OwnerMutation {
  if(!value||!id(value.operationId)||!id(value.step)||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||Object.keys(value).some(key=>!['operationId','digest','step'].includes(key)))return failure('invalid_request','Mutation identity is invalid.');
  return structuredClone(value);
}
function validateRecord(record:OwnerRecord) {
  if(!object(record)||typeof record.type!=='string'||!readCommands.has(record.type)&&!effectCommands.has(record.type))failure('unsupported','The owner does not support this RPC command.');
  const allowed=['type',...(commandKeys[record.type]??[])];
  if(Object.keys(record).some(key=>!allowed.includes(key)))failure('invalid_request','The RPC command has unsupported fields.');
}
type Pending={value:OwnerOutcome;bodyDigest:string;attachment:string;promise:Promise<OwnerOutcome>;resolve:(value:OwnerOutcome)=>void;line?:string;reservedBytes?:number;recoveryId?:string;settling?:boolean};
type Attachment={notify:(notice:OwnerNotice)=>unknown;paused:Set<string>;failed:Set<string>};
type Primary={descriptor:OwnerPrimary;child:ChildProcessWithoutNullStreams;exited:boolean;available:boolean;synchronized:boolean;
  records:OwnerRecords;stderr:Buffer;accumulator:Buffer;discarding:boolean;decodeTail:Promise<void>;decodeBytes:number;
  writeTail:Promise<void>;exit:Promise<void>;resolveExit:()=>void;close?:Promise<void>;openingAttachment:string};
type ParseWaiter={resolve:(value:unknown)=>void;reject:(error:Error)=>void};

/** Holds ordinary Pi pipes independently of replaceable presentation backends. */
export class PrimaryOwner {
  readonly incarnation=randomUUID();
  readonly limits:OwnerLimits;
  private primaries=new Map<string,Primary>();
  private attachments=new Map<string,Attachment>();
  private mutator?:string;
  private pending=new Map<string,Pending>();
  private mutations=new Map<string,string>();
  private operations=new Map<string,{digest:string;result:OwnerJson}>();
  private tombstones=new Map<string,{command:string}>();
  private retiredMutations=new Map<string,true>();
  private retiredOperations=new Map<string,true>();
  private opening=new Set<string>();
  private fileClaims=new Map<string,string>();
  private counter=0;
  private decoder?:Worker;
  private decodeId=0;
  private parseWaiters=new Map<number,ParseWaiter>();
  private disposed=false;
  private now:()=>number;
  private options:PrimaryOwnerOptions;private recovery:OwnerRecoveryStore;
  constructor(options:PrimaryOwnerOptions,recovery:OwnerRecoveryStore) {this.options=options;this.recovery=recovery;this.limits={...OWNER_LIMITS,...options.limits};this.now=options.now??Date.now;}
  connect(attachmentId:string,notify:(notice:OwnerNotice)=>unknown):OwnerHello {
    if(this.disposed||!id(attachmentId)||this.attachments.has(attachmentId)||this.attachments.size>=4)failure('capacity','Owner attachment is unavailable.');
    this.attachments.set(attachmentId,{notify,paused:new Set(),failed:new Set()});return this.hello(attachmentId);
  }
  grant(attachmentId:string) {this.attachment(attachmentId);this.mutator=attachmentId;}
  detach(attachmentId:string) {
    this.attachments.delete(attachmentId);if(this.mutator===attachmentId)this.mutator=undefined;
    for(const primary of this.primaries.values())primary.records.detach(attachmentId);
    for(const pending of this.pending.values())if(pending.attachment===attachmentId&&pending.value.state==='prepared')this.settle(pending,'refused','The preparing backend detached before admission.');
  }
  descriptors():OwnerDescriptor[] {return [...this.primaries.values()].map(primary=>this.describe(primary));}
  private describe(primary:Primary):OwnerDescriptor {return {...structuredClone(primary.descriptor),...(primary.child.pid?{pid:primary.child.pid}:{}),exited:primary.exited,available:primary.available,synchronized:primary.synchronized,sequence:primary.records.cursor,stderr:primary.stderr.toString('utf8'),recoveryPending:this.recovery.hasPrimary(primary.descriptor.key)};}
  private hello(attachmentId:string):OwnerHello {return {protocol:OWNER_PROTOCOL,ownerIncarnation:this.incarnation,state:structuredClone(this.options.state),attachmentId,mutator:this.mutator===attachmentId,primaries:this.descriptors()};}
  private attachment(id:string):Attachment {const value=this.attachments.get(id);return value??failure('not_ready','The owner attachment is absent.');}
  private writable(attachment:string) {this.attachment(attachment);if(this.mutator!==attachment)failure('stale_attachment','The backend no longer owns mutation admission.');}
  private primary(key:string,epoch:number,retained=false):Primary {const value=this.primaries.get(key);if(!value)failure('not_ready','The primary is not owned.');if(value.descriptor.epoch!==epoch&&(!retained||epoch<1||epoch>value.descriptor.epoch))failure('stale_epoch','The primary epoch changed.');return value;}
  async handle(attachment:string,request:OwnerRequest):Promise<OwnerReply> {
    try {
      this.attachment(attachment);
      if(!object(request)||request.protocol!==OWNER_PROTOCOL||request.ownerIncarnation!==this.incarnation||!id(request.requestId))failure('contract_mismatch','The owner request identity is invalid.');
      const keys=actionKeys[request.kind];if(!keys)failure('unsupported','The owner operation is unsupported.');
      const allowed=['protocol','ownerIncarnation','requestId','kind',...(['hello','open','recoveries','recovery-ack','detach'].includes(request.kind)?[]:['primaryKey','epoch']),...keys];
      if(Object.keys(request).some(key=>!allowed.includes(key)))failure('invalid_request','The owner request contains unknown fields.');
      if(Buffer.byteLength(JSON.stringify(request))>this.limits.inputBytes+4096)failure('capacity','The owner request exceeds its byte bound.');
      return {ok:true,value:await this.dispatch(attachment,structuredClone(request))};
    }catch(error) {
      const known=error instanceof OwnerFailure;
      const view:OwnerError={code:known?error.code:'owner_unavailable',message:known?error.message:'The owner operation could not complete.',uncertain:known?error.uncertain:true};
      return {ok:false,error:view};
    }
  }
  private async dispatch(attachment:string,request:OwnerAction):Promise<unknown> {
    if(request.kind==='hello')return this.hello(attachment);
    if(request.kind==='detach'){this.detach(attachment);return true;}
    if(request.kind==='open'){this.writable(attachment);return this.open(attachment,request.primary);}
    if(request.kind==='recoveries')return this.recovery.list();
    if(request.kind==='recovery-ack'){this.writable(attachment);return this.recovery.ack(request.id);}
    if(!('primaryKey' in request)||!id(request.primaryKey)||!Number.isSafeInteger(request.epoch))failure('invalid_request','The primary address is invalid.');
    const retained=['outcome','operation-complete','operation-result','ack'].includes(request.kind);
    const primary=this.primary(request.primaryKey,request.epoch,retained);
    switch(request.kind) {
      case 'command':return this.command(attachment,primary,request.record,request.mutation,request.recovery);
      case 'prepare':return this.prepare(attachment,primary,request.mutation,request.bytes);
      case 'prepared':return this.prepared(attachment,primary,request.id,request.line);
      case 'ui-response':return this.uiResponse(attachment,primary,request.record);
      case 'capture-begin':{const result=primary.records.begin(attachment);this.attachment(attachment).paused.add(request.primaryKey);return result;}
      case 'capture-finish':await primary.decodeTail;return primary.records.finish(attachment,request.token,this.describe(primary));
      case 'capture-page':return primary.records.page(attachment,request.token,request.index);
      case 'capture-ack': {
        const records=primary.records.ack(attachment,request.token),target=this.attachment(attachment);target.paused.delete(request.primaryKey);target.failed.delete(request.primaryKey);
        for(const event of records)this.deliver(attachment,{kind:'record',primaryKey:request.primaryKey,epoch:request.epoch,event});return true;
      }
      case 'outcome':return this.lookup(primary,request.epoch,request.id,request.mutation);
      case 'ack':this.writable(attachment);return this.ack(primary,request.epoch,request.id);
      case 'operation-complete':this.writable(attachment);return this.completeOperation(request);
      case 'operation-result':return this.operationResult(request);
      case 'epoch':this.writable(attachment);return this.changeEpoch(primary,request);
      case 'close-primary':this.writable(attachment);await this.close(primary,request.timeoutMs);return this.describe(primary);
    }
    return failure('unsupported','The owner operation is unsupported.');
  }
  private completeOperation(request:Extract<OwnerAction,{kind:'operation-complete'}>) {
    const mutation=checkMutation(request.mutation),key=JSON.stringify([request.primaryKey,request.epoch,mutation.operationId]);
    if(this.retiredOperations.has(key))failure('operation_conflict','The operation was durably acknowledged.');
    const previous=this.operations.get(key);if(previous&&(previous.digest!==mutation.digest||canonical(previous.result)!==canonical(request.result)))failure('operation_conflict','The completed operation differs.');
    if(!previous&&this.operations.size>=this.limits.outcomes)failure('capacity','The owner operation capacity is full.');
    const bytes=Buffer.byteLength(canonical(request.result));if(bytes>256*1024||this.outcomeBytes()+bytes>this.limits.outcomeBytes)failure('capacity','The operation result exceeds its bound.');
    this.operations.set(key,{digest:mutation.digest,result:structuredClone(request.result)});return true;
  }
  private operationResult(request:Extract<OwnerAction,{kind:'operation-result'}>) {
    const value=this.operations.get(JSON.stringify([request.primaryKey,request.epoch,request.operationId]));if(value&&value.digest!==request.digest)failure('operation_conflict','The operation digest differs.');return value?structuredClone(value.result):null;
  }
  private async changeEpoch(primary:Primary,request:Extract<OwnerAction,{kind:'epoch'}>) {
    if(request.next!==request.epoch+1)failure('invalid_request','The epoch must advance once.');
    let sessionFile:string|undefined;
    if(request.sessionFile!==undefined)sessionFile=await this.claimFile(request.sessionFile,request.primaryKey);
    for(const [path,key]of this.fileClaims)if(key===request.primaryKey&&path!==sessionFile)this.fileClaims.delete(path);
    primary.descriptor={...primary.descriptor,epoch:request.next,sessionFile};primary.records.reset();return this.describe(primary);
  }
  private async claimFile(path:string,key:string) {
    if(!isAbsolute(path))failure('invalid_request','Session file must be absolute.');const canonical=await realpath(path);if(!(await stat(canonical)).isFile())failure('invalid_request','The session file is invalid.');
    const claimed=this.fileClaims.get(canonical);if(claimed&&claimed!==key)failure('operation_conflict','The session file has another owner.');this.fileClaims.set(canonical,key);return canonical;
  }
  private validatePrimary(description:OwnerPrimary) {
    if(!object(description)||!id(description.key)||!id(description.recoveryWorkspaceId)||!Number.isSafeInteger(description.epoch)||description.epoch<1||!isAbsolute(description.cwd)||!id(description.executable))failure('invalid_request','The primary descriptor is invalid.');
    if(Object.keys(description).some(key=>!['key','epoch','cwd','executable','sessionFile','recoveryWorkspaceId'].includes(key)))failure('invalid_request','The primary descriptor contains unknown fields.');
  }
  private admitOpen(description:OwnerPrimary):Primary|undefined {
    this.validatePrimary(description);const previous=this.primaries.get(description.key);
    if(previous&&!previous.exited||this.opening.has(description.key)||this.recovery.hasPrimary(description.key))failure('operation_conflict','The primary key still owns a writer or recovery.');
    if(previous&&description.epoch<previous.descriptor.epoch)failure('stale_epoch','The retained primary epoch changed.');
    if([...this.primaries.values()].filter(value=>!value.exited).length+this.opening.size>=this.limits.primaries)failure('capacity','The primary capacity is full.');
    return previous;
  }
  private async open(attachment:string,description:OwnerPrimary):Promise<OwnerDescriptor> {
    const previous=this.admitOpen(description);this.opening.add(description.key);let claimed:string|undefined;
    try {
      const cwd=await realpath(description.cwd);if(!(await stat(cwd)).isDirectory())failure('invalid_request','The project directory is invalid.');
      let sessionFile:string|undefined;
      if(description.sessionFile!==undefined) {sessionFile=await this.claimFile(description.sessionFile,description.key);claimed=sessionFile;}
      this.writable(attachment);
      const args=['--mode','rpc'];if(sessionFile)args.push('--session',sessionFile);
      const child=(this.options.spawnChild??spawn)(description.executable,args,{cwd,stdio:['pipe','pipe','pipe'],shell:false,detached:true}) as ChildProcessWithoutNullStreams;
      let resolveExit!:()=>void;const exit=new Promise<void>(resolve=>{resolveExit=resolve;});
      const primary:Primary={descriptor:{...description,cwd,...(sessionFile?{sessionFile}:{})},child,exited:false,available:true,synchronized:true,records:new OwnerRecords(this.limits,this.now,previous?.records.cursor??0),stderr:Buffer.alloc(0),accumulator:Buffer.alloc(0),discarding:false,decodeTail:Promise.resolve(),decodeBytes:0,writeTail:Promise.resolve(),exit,resolveExit,openingAttachment:attachment};
      this.primaries.set(description.key,primary);
      child.stdout.on('data',(chunk:Buffer)=>this.consume(primary,Buffer.from(chunk)));
      child.stderr.on('data',(chunk:Buffer)=>{primary.stderr=Buffer.concat([primary.stderr,chunk]).subarray(-this.limits.stderrBytes);});
      child.stdin.on('error',()=>this.transportFailed(primary,'RPC input pipe failed.'));
      child.on('error',()=>{this.transportFailed(primary,'RPC process failed.');if(child.pid===undefined)this.exited(primary);});
      child.once('exit',()=>this.exited(primary));child.once('close',()=>this.exited(primary));
      return this.describe(primary);
    }catch(error){if(claimed)this.fileClaims.delete(claimed);throw error;}
    finally{this.opening.delete(description.key);}
  }
  private consume(primary:Primary,chunk:Buffer) {
    let start=0;
    while(start<chunk.length) {
      const lf=chunk.indexOf(10,start),end=lf<0?chunk.length:lf,segment=chunk.subarray(start,end);
      if(!primary.discarding) {
        if(primary.accumulator.length+segment.length>this.limits.recordBytes) {primary.accumulator=Buffer.alloc(0);primary.discarding=true;this.unsynchronized(primary,'record-limit');}
        else primary.accumulator=Buffer.concat([primary.accumulator,segment]);
      }
      if(lf<0)break;
      if(!primary.discarding)this.enqueue(primary,primary.accumulator);
      primary.accumulator=Buffer.alloc(0);primary.discarding=false;start=lf+1;
    }
  }
  private enqueue(primary:Primary,bytes:Buffer) {
    if(primary.decodeBytes+bytes.length>this.limits.decodeBytes) {this.unsynchronized(primary,'decode-capacity');return;}
    primary.decodeBytes+=bytes.length;
    primary.decodeTail=primary.decodeTail.then(async()=> {
      try {
        const record=await this.decode(bytes);
        if(!object(record)||typeof record.type!=='string')throw new Error('invalid-record');
        await this.record(primary,record as OwnerRecord);
      }catch{this.unsynchronized(primary,'invalid-rpc-record');}
      finally{primary.decodeBytes-=bytes.length;}
    });
  }
  private decode(bytes:Buffer):unknown|Promise<unknown> {
    if(bytes.length<=256*1024)return JSON.parse(bytes.toString('utf8').replace(/\r$/,''));
    if(!this.decoder) {
      const worker=new Worker(new URL('./owner-decode-worker.mts',import.meta.url));this.decoder=worker;
      worker.on('message',(message:{id:number;value?:unknown;error?:boolean})=>{const waiter=this.parseWaiters.get(message.id);if(!waiter)return;this.parseWaiters.delete(message.id);if(message.error)waiter.reject(new Error('decode'));else waiter.resolve(message.value);});
      const fail=()=>{if(this.decoder===worker)this.decoder=undefined;for(const waiter of this.parseWaiters.values())waiter.reject(new Error('decoder-exit'));this.parseWaiters.clear();};
      worker.on('error',fail);worker.on('exit',fail);
    }
    const worker=this.decoder,request=++this.decodeId;
    return new Promise((resolve,reject)=>{this.parseWaiters.set(request,{resolve,reject});worker.postMessage({id:request,bytes});});
  }
  private async record(primary:Primary,record:OwnerRecord) {
    const event=primary.records.advance(record);
    if(record.type!=='response') {this.broadcast({kind:'record',primaryKey:primary.descriptor.key,epoch:primary.descriptor.epoch,event});return;}
    const pending=typeof record.id==='string'?this.pending.get(record.id):undefined;
    if(!pending) {
      if(typeof record.id==='string'&&this.tombstones.get(record.id)?.command===record.command)return;
      this.unsynchronized(primary,'unknown-response');return;
    }
    if(!this.validResponse(primary,record,pending)) {this.unsynchronized(primary,'invalid-response');this.settle(pending,'uncertain','Pi returned an invalid response.');return;}
    if(pending.value.state!=='pending'||pending.settling)return;
    pending.settling=true;pending.value.sequence=event.seq;
    if(!await this.retainSessionFile(primary,record,pending))return;
    if(pending.recoveryId) {
      try {await this.recovery.returned(pending.recoveryId,record);}
      catch {pending.value.response=record;this.settle(pending,'uncertain','Queue recovery persistence failed.');return;}
    }
    const bytes=Buffer.byteLength(JSON.stringify(record));
    if(this.outcomeBytes()+bytes>this.limits.outcomeBytes) {this.settle(pending,'uncertain','Owner outcome retention exceeds its bound.');return;}
    pending.value.response=record;this.settle(pending,'complete');
  }
  private validResponse(primary:Primary,record:OwnerRecord,pending:Pending):boolean {
    return pending.value.primaryKey===primary.descriptor.key&&record.command===pending.value.command&&typeof record.success==='boolean'&&(record.success||typeof record.error==='string');
  }
  private async retainSessionFile(primary:Primary,record:OwnerRecord,pending:Pending):Promise<boolean> {
    if(record.command!=='get_state'||record.success!==true||!object(record.data)||typeof record.data.sessionFile!=='string')return true;
    try {primary.descriptor.sessionFile=await this.claimFile(record.data.sessionFile,primary.descriptor.key);return true;}
    catch {this.unsynchronized(primary,'session-file-conflict');this.settle(pending,'uncertain','The saved session writer identity is unavailable.');return false;}
  }
  private outcomeBytes() {let bytes=0;for(const pending of this.pending.values())if(pending.value.response)bytes+=Buffer.byteLength(JSON.stringify(pending.value.response));for(const value of this.operations.values())bytes+=Buffer.byteLength(JSON.stringify(value));return bytes;}
  private unsynchronized(primary:Primary,reason:string) {primary.synchronized=false;primary.records.incomplete(reason);this.broadcast({kind:'resync',primaryKey:primary.descriptor.key,reason});}
  private transportFailed(primary:Primary,message:string) {primary.available=false;this.unsynchronized(primary,'transport-unavailable');for(const pending of this.pending.values())if(pending.value.primaryKey===primary.descriptor.key&&['pending','prepared'].includes(pending.value.state)&&!pending.settling)this.settle(pending,pending.value.written?'uncertain':'refused',message);}
  private exited(primary:Primary) {
    if(primary.exited)return;primary.exited=true;primary.available=false;primary.resolveExit();
    for(const [path,key]of this.fileClaims)if(key===primary.descriptor.key)this.fileClaims.delete(path);
    void primary.decodeTail.finally(()=> {for(const pending of this.pending.values())if(pending.value.primaryKey===primary.descriptor.key&&['pending','prepared'].includes(pending.value.state))this.settle(pending,pending.value.written?'uncertain':'refused','Pi exited before its response.');this.broadcast({kind:'exit',primaryKey:primary.descriptor.key,epoch:primary.descriptor.epoch,descriptor:this.describe(primary)});});
  }
  private deliver(attachment:string,notice:OwnerNotice) {
    const target=this.attachments.get(attachment);if(!target||target.paused.has(notice.primaryKey)||target.failed.has(notice.primaryKey))return;
    try {if(target.notify(structuredClone(notice))===false)target.failed.add(notice.primaryKey);}catch{target.failed.add(notice.primaryKey);}
  }
  private broadcast(notice:OwnerNotice) {for(const id of this.attachments.keys())this.deliver(id,notice);}
  private register(attachment:string,primary:Primary,record:OwnerRecord,mutation?:OwnerMutation):{pending:Pending;existing:boolean} {
    validateRecord(record);const effect=effectCommands.has(record.type);
    if(effect)this.writable(attachment);
    if(!primary.available||primary.exited)failure('not_ready','The Pi pipe is unavailable.');
    if(effect&&!primary.synchronized&&!['abort','clear_queue','abort_retry'].includes(record.type))failure('not_ready','The Pi protocol requires resynchronization.');
    const binding=effect?checkMutation(mutation):undefined;
    if(!effect&&mutation)failure('invalid_request','Read commands do not use mutation identities.');
    const hash=digest(record);
    if(binding) {const existing=this.existingMutation(primary,binding,hash);if(existing)return {pending:existing,existing:true};}
    if(this.pending.size>=this.limits.outcomes||[...this.pending.values()].filter(value=>['pending','prepared'].includes(value.value.state)).length>=this.limits.pending)failure('capacity','Owner command capacity is full.');
    const id=`owner:${this.incarnation}:${++this.counter}`;let resolve!:(value:OwnerOutcome)=>void;const promise=new Promise<OwnerOutcome>(done=>{resolve=done;});
    const value:OwnerOutcome={id,primaryKey:primary.descriptor.key,epoch:primary.descriptor.epoch,command:record.type,...(binding?{mutation:binding}:{}),state:'pending',written:false};
    const pending:Pending={value,bodyDigest:hash,attachment,promise,resolve};this.pending.set(id,pending);
    if(binding)this.mutations.set(mutationKey(primary.descriptor.key,primary.descriptor.epoch,binding),id);
    return {pending,existing:false};
  }
  private existingMutation(primary:Primary,binding:OwnerMutation,hash:string):Pending|undefined {
    const key=mutationKey(primary.descriptor.key,primary.descriptor.epoch,binding);
    const reference=this.mutations.get(key);
    const existing=reference?this.pending.get(reference):undefined;
    if(existing) {if(existing.bodyDigest!==hash||existing.value.mutation?.digest!==binding.digest)failure('operation_conflict','The mutation body differs from its retained identity.');return existing;}
    const operation=JSON.stringify([primary.descriptor.key,primary.descriptor.epoch,binding.operationId]);
    if(reference||this.retiredMutations.has(key)||this.retiredOperations.has(operation)||this.operations.has(operation))failure('operation_conflict','The mutation or operation already completed.');
    if(this.mutations.size>=this.limits.outcomes)failure('capacity','The mutation identity capacity is full.');
  }
  private settle(pending:Pending,state:OwnerOutcome['state'],error?:string) {pending.value.state=state;if(error)pending.value.error=error;pending.line=undefined;pending.reservedBytes=undefined;pending.resolve(structuredClone(pending.value));}
  private async command(attachment:string,primary:Primary,record:OwnerRecord,mutation?:OwnerMutation,reservation?:import('../shared/owner.ts').OwnerQueueReservation):Promise<OwnerOutcome> {
    const {pending,existing}=this.register(attachment,primary,record,mutation);if(existing)return pending.promise;
    try {
      if(record.type==='clear_queue') {
        if(!reservation)failure('invalid_request','Queue clearing requires recovery reservation.');
        await this.recovery.reserve(this.incarnation,primary.descriptor,reservation);pending.recoveryId=reservation.id;
      }else if(reservation)failure('invalid_request','Recovery reservation belongs only to clear_queue.');
      this.attachment(attachment);if(effectCommands.has(record.type))this.writable(attachment);
      const line=`${JSON.stringify({...record,id:pending.value.id})}\n`;
      if(Buffer.byteLength(line)>this.limits.inputBytes)failure('capacity','The command exceeds its input bound.');
      this.write(primary,pending,line);
    }catch(error){this.settle(pending,'refused',error instanceof Error?error.message:'Command preparation failed.');}
    return pending.promise;
  }
  private prepare(attachment:string,primary:Primary,mutation:OwnerMutation,bytes:number):OwnerOutcome {
    this.writable(attachment);checkMutation(mutation);
    if(!Number.isSafeInteger(bytes)||bytes<1||bytes>this.limits.inputBytes)failure('capacity','The prepared input reservation is invalid.');
    const reference=this.mutations.get(mutationKey(primary.descriptor.key,primary.descriptor.epoch,mutation));
    if(reference) {const pending=this.pending.get(reference);if(!pending||pending.value.mutation?.digest!==mutation.digest||pending.reservedBytes!==bytes&&pending.value.state==='prepared')failure('operation_conflict','The prepared input reservation differs.');return structuredClone(pending.value);}
    if([...this.pending.values()].filter(value=>value.value.state==='prepared').length>=this.limits.prepared)failure('capacity','Another image command owns the preparation slot.');
    const {pending}=this.register(attachment,primary,{type:'prompt'},mutation);pending.value.state='prepared';pending.reservedBytes=bytes;return structuredClone(pending.value);
  }
  private async prepared(attachment:string,primary:Primary,id:string,line:string):Promise<OwnerOutcome> {
    this.writable(attachment);const pending=this.pending.get(id);
    if(!pending||pending.value.primaryKey!==primary.descriptor.key||pending.value.epoch!==primary.descriptor.epoch)failure('invalid_request','The prepared command does not belong to this primary.');
    if(pending.value.state!=='prepared') {
      if(pending.bodyDigest!==createHash('sha256').update(line).digest('hex'))failure('operation_conflict','The prepared command bytes differ.');return pending.promise;
    }
    if(pending.attachment!==attachment||typeof line!=='string'||!line.endsWith('\n')||line.slice(0,-1).includes('\n')||Buffer.byteLength(line)>(pending.reservedBytes??0))failure('invalid_request','The prepared command framing or reservation is invalid.');
    let record:unknown;try{record=await this.decode(Buffer.from(line));}catch{return failure('invalid_request','The prepared input is not JSON.');}
    if(!object(record)||record.id!==id||record.type!=='prompt')failure('invalid_request','The prepared input identity is invalid.');
    const {id:_id,...fields}=record;validateRecord(fields as OwnerRecord);
    this.writable(attachment);if(pending.value.state!=='prepared')failure('not_ready','The prepared input was retired.');
    pending.bodyDigest=createHash('sha256').update(line).digest('hex');pending.value.state='pending';pending.line=line;this.write(primary,pending,line);return pending.promise;
  }
  private write(primary:Primary,pending:Pending,line:string) {
    const job=primary.writeTail.then(async()=> {
      if(pending.value.state!=='pending'||!primary.available||primary.exited)throw new Error('RPC input is unavailable.');
      // Admission owns these bytes; later backend detachment must not cancel their single write.
      pending.value.written=true;await this.writeBytes(primary,line);
    });
    primary.writeTail=job.catch(error=>{if(pending.value.state==='pending')this.settle(pending,pending.value.written?'uncertain':'refused',error instanceof Error?error.message:'RPC write failed.');});
  }
  private writeBytes(primary:Primary,line:string):Promise<void> {
    return new Promise((resolve,reject)=> {
      const stream=primary.child.stdin;let callback=false,drained=true,done=false;
      const clean=()=>{stream.off('error',fail);stream.off('close',closed);stream.off('drain',drain);};
      const finish=()=>{if(!done&&callback&&drained){done=true;clean();resolve();}};
      const fail=(error:Error)=>{if(!done){done=true;clean();reject(error);}};
      const closed=()=>fail(new Error('RPC input closed.'));const drain=()=>{drained=true;finish();};
      stream.once('error',fail);stream.once('close',closed);
      drained=stream.write(line,error=>{if(error)fail(error);else{callback=true;finish();}});if(!drained)stream.once('drain',drain);finish();
    });
  }
  private async uiResponse(attachment:string,primary:Primary,record:OwnerRecord) {
    this.writable(attachment);
    if(!object(record)||record.type!=='extension_ui_response'||!id(record.id)||!primary.records.hasDialog(record.id)||Object.keys(record).some(key=>!['type','id','value','confirmed','cancelled'].includes(key))||['value','confirmed','cancelled'].filter(key=>key in record).length!==1)failure('invalid_request','The dialog response is invalid or expired.');
    const line=`${JSON.stringify(record)}\n`;if(Buffer.byteLength(line)>128*1024)failure('capacity','The dialog response exceeds its bound.');
    primary.records.answered(record.id);const job=primary.writeTail.then(()=>this.writeBytes(primary,line));primary.writeTail=job.catch(()=>{});await job;return {written:true};
  }
  private lookup(primary:Primary,epoch:number,idValue?:string,mutation?:OwnerMutation):OwnerOutcome|null {
    if((idValue===undefined)===(mutation===undefined))failure('invalid_request','Supply one exact outcome selector.');
    const reference=idValue??this.mutations.get(mutationKey(primary.descriptor.key,epoch,checkMutation(mutation)));
    const value=reference?this.pending.get(reference):undefined;
    if(!value)return null;
    if(value.value.primaryKey!==primary.descriptor.key||value.value.epoch!==epoch||mutation&&value.value.mutation?.digest!==mutation.digest)failure('operation_conflict','The outcome selector differs.');
    return structuredClone(value.value);
  }
  private remember<T>(map:Map<string,T>,key:string,value:T) {
    map.set(key,value);
    while(map.size>this.limits.outcomes){const first=map.keys().next().value;if(first!==undefined)map.delete(first);}
  }
  private operationSteps(key:string,epoch:number,operationId:string):Pending[] {
    return [...this.pending.values()].filter(item=>item.value.primaryKey===key&&item.value.epoch===epoch&&item.value.mutation?.operationId===operationId);
  }
  private retireOutcome(pending:Pending) {
    const value=pending.value;this.pending.delete(value.id);this.remember(this.tombstones,value.id,{command:value.command});
    if(value.mutation) {
      const key=mutationKey(value.primaryKey,value.epoch,value.mutation);this.mutations.delete(key);this.remember(this.retiredMutations,key,true);
    }
  }
  private retireOperation(key:string) {this.operations.delete(key);this.remember(this.retiredOperations,key,true);}
  private ack(primary:Primary,epoch:number,id:string):boolean {
    const pending=this.pending.get(id);
    if(!pending)return this.ackOperation(primary.descriptor.key,epoch,id);
    if(pending.value.primaryKey!==primary.descriptor.key||pending.value.epoch!==epoch)failure('operation_conflict','The outcome belongs to another primary.');
    if(['pending','prepared'].includes(pending.value.state))failure('not_ready','The command has no settled outcome.');
    this.retireOutcome(pending);
    const operationId=pending.value.mutation?.operationId;
    if(operationId!==undefined) {
      const key=JSON.stringify([primary.descriptor.key,epoch,operationId]);
      if(this.operations.has(key)&&!this.operationSteps(primary.descriptor.key,epoch,operationId).length)this.retireOperation(key);
    }
    return true;
  }
  private ackOperation(primaryKey:string,epoch:number,operationId:string):boolean {
    const key=JSON.stringify([primaryKey,epoch,operationId]);if(!this.operations.has(key))return false;
    const steps=this.operationSteps(primaryKey,epoch,operationId);
    if(steps.some(item=>['pending','prepared'].includes(item.value.state)))failure('not_ready','The operation still has an unsettled step.');
    for(const step of steps)this.retireOutcome(step);
    this.retireOperation(key);return true;
  }
  private close(primary:Primary,timeoutMs=30000):Promise<void> {
    if(primary.exited)return Promise.resolve();
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)return Promise.reject(new OwnerFailure('invalid_request','The close deadline is invalid.'));
    if(primary.close)return primary.close;
    primary.close=(async()=> {
      let timer:NodeJS.Timeout|undefined;
      try {await Promise.race([(async()=>{await primary.writeTail;primary.available=false;primary.child.stdin.end();await primary.exit;await primary.decodeTail;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new OwnerFailure('handoff_blocked','Pi exit is unconfirmed.')),timeoutMs);})]);}
      finally{if(timer)clearTimeout(timer);}
    })().catch(error=>{primary.close=undefined;throw error;});return primary.close;
  }
  async shutdownPrimary(key:string,timeoutMs=30000):Promise<void> {
    const primary=this.primaries.get(key);if(!primary||primary.exited)return;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)failure('invalid_request','The shutdown deadline is invalid.');
    const internal=`shutdown:${randomUUID()}`,prior=this.mutator;this.connect(internal,()=>{});this.grant(internal);
    let timer:NodeJS.Timeout|undefined;
    try {await Promise.race([this.shutdownSteps(primary,internal,timeoutMs),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new OwnerFailure('handoff_blocked','Primary shutdown did not settle before its deadline.',true)),timeoutMs);})]);}
    finally{if(timer)clearTimeout(timer);this.detach(internal);if(prior&&this.attachments.has(prior))this.grant(prior);}
  }
  private async shutdownSteps(primary:Primary,internal:string,timeoutMs:number) {
    const key=primary.descriptor.key;
    const mutation=(step:string):OwnerMutation=>({operationId:internal,digest:digest({key,epoch:primary.descriptor.epoch,operation:internal}),step});
      const state=await this.command(internal,primary,{type:'get_state'});const pendingCount=this.queueCount(state);
      const returned=await this.command(internal,primary,{type:'clear_queue'},mutation('clear'),{id:randomUUID(),workspaceId:primary.descriptor.recoveryWorkspaceId,pendingCount});
      if(returned.state!=='complete'||returned.response?.success!==true)failure('recovery_blocked','The cleared queue was not retained.');
      const queue=returned.response.data;
      if(!object(queue)||!Array.isArray(queue.steering)||!Array.isArray(queue.followUp)||[...queue.steering,...queue.followUp].some(value=>typeof value!=='string')||queue.steering.length+queue.followUp.length>pendingCount||Buffer.byteLength(JSON.stringify(queue))>this.limits.queueBytes)failure('recovery_blocked','The retained queue requires explicit recovery.');
      for(const dialog of primary.records.pendingDialogs()) {const id=dialog.event.record.id;if(typeof id==='string')await this.uiResponse(internal,primary,{type:'extension_ui_response',id,cancelled:true});}
      const abort=await this.command(internal,primary,{type:'abort'},mutation('abort'));if(abort.state!=='complete'||abort.response?.success!==true)failure('handoff_blocked','Pi abort was not confirmed.');
      this.writable(internal);await this.close(primary,timeoutMs);
  }
  private queueCount(state:OwnerOutcome):number {
    const data=state.response?.data;
    if(state.state!=='complete'||state.response?.success!==true||!object(data)||!Number.isSafeInteger(data.pendingMessageCount)||Number(data.pendingMessageCount)<0||Number(data.pendingMessageCount)>this.limits.queueItems)failure('recovery_blocked','The pending queue count is unavailable.');
    return Number(data.pendingMessageCount);
  }
  async dispose():Promise<void> {
    if([...this.primaries.values()].some(primary=>!primary.exited)||this.opening.size)failure('handoff_blocked','Live primary ownership prevents disposal.');
    this.disposed=true;await Promise.all([...this.primaries.values()].map(primary=>primary.decodeTail));await this.recovery.drain();
    for(const attachment of [...this.attachments.keys()])this.detach(attachment);
    const decoder=this.decoder;this.decoder=undefined;if(decoder)await decoder.terminate();
  }
}
export async function createPrimaryOwner(options:PrimaryOwnerOptions):Promise<PrimaryOwner> {
  const limits={...OWNER_LIMITS,...options.limits};for(const [name,value]of Object.entries(limits))if(!Number.isSafeInteger(value)||value<1||value>OWNER_LIMITS[name as keyof OwnerLimits])throw new Error('Owner limits must be positive and cannot exceed the protocol bounds.');
  const state=structuredClone(options.state);const recovery=await OwnerRecoveryStore.open(state,options.recoveryDir,limits);return new PrimaryOwner({...options,state},recovery);
}
