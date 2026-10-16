import {constants} from 'node:fs';
import {mkdir,open,opendir,realpath,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {OWNER_LIMITS,type OwnerLimits,type OwnerPrimary,type OwnerQueueReservation,type OwnerRecord,type OwnerRecovery,type OwnerStateIdentity} from '../shared/owner.ts';

/** An independent recovery writer; it never opens backend state files. */
export class OwnerRecoveryStore {
  private records=new Map<string,OwnerRecovery>();
  private sizes=new Map<string,number>();
  private tail:Promise<unknown>=Promise.resolve();
  readonly state:OwnerStateIdentity;readonly directory:string;private limits:OwnerLimits;
  private constructor(state:OwnerStateIdentity,directory:string,limits:OwnerLimits) {this.state=state;this.directory=directory;this.limits=limits;}
  static async open(state:OwnerStateIdentity,directory=join(state.root,'releases','owner-recovery'),limits:OwnerLimits={...OWNER_LIMITS}) {
    if(!isAbsolute(state.root)||!state.instanceId||state.instanceId.length>256)throw new Error('Invalid owner state identity.');
    const root=await realpath(state.root);if(root!==resolve(state.root))throw new Error('Owner root must be canonical.');
    const suffix=relative(root,resolve(directory));if(!suffix||suffix.startsWith('..')||isAbsolute(suffix))throw new Error('Recovery directory must be beneath the selected root.');
    await mkdir(directory,{recursive:true,mode:0o700});const actual=await realpath(directory);
    if(actual!==resolve(directory))throw new Error('Recovery directory must not follow a symbolic link.');
    const store=new OwnerRecoveryStore(structuredClone(state),actual,limits);await store.load();return store;
  }
  private filename(id:string) {return join(this.directory,`${createHash('sha256').update(id).digest('hex')}.json`);}
  private charge(record:OwnerRecovery,bytes:number) {return record.status==='reserved'?this.limits.recordBytes+64*1024:bytes;}
  private async load() {
    const directory=await opendir(this.directory,{bufferSize:1});let visits=0,total=0;
    for await(const entry of directory) {
      if(++visits>this.limits.recoveryRecords*2)throw new Error('Recovery inventory exceeds its bound.');
      if(/^\.tmp-[a-f0-9-]+$/.test(entry.name))continue;
      if(!/^[a-f0-9]{64}\.json$/.test(entry.name)||!entry.isFile())throw new Error('Recovery inventory has an unsupported entry.');
      const path=join(this.directory,entry.name),bytes=await this.readBounded(path);
      const record=this.validate(JSON.parse(bytes.toString('utf8')),path);
      total+=this.charge(record,bytes.length);if(total>this.limits.recoveryBytes||this.records.size>=this.limits.recoveryRecords)throw new Error('Recovery capacity is exhausted.');
      this.records.set(record.id,record);this.sizes.set(record.id,bytes.length);
    }
  }
  private async readBounded(path:string):Promise<Buffer> {
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const info=await file.stat(),limit=this.limits.recordBytes+64*1024;
      if(!info.isFile()||info.nlink!==1||info.size>limit)throw new Error('Recovery file exceeds its bound.');
      const bytes=Buffer.alloc(Math.min(limit,info.size)+1);let offset=0;
      while(offset<bytes.length){const result=await file.read(bytes,offset,bytes.length-offset,null);if(!result.bytesRead)break;offset+=result.bytesRead;}
      if(offset>info.size)throw new Error('Recovery file grew during its read.');return bytes.subarray(0,offset);
    }finally{await file.close();}
  }
  private validate(value:unknown,path:string):OwnerRecovery {
    const record=value as OwnerRecovery;
    if(record?.format!=='ui.owner-recovery/1'||record.state?.root!==this.state.root||record.state?.instanceId!==this.state.instanceId)throw new Error('Recovery state identity differs from the selected root.');
    if(typeof record.id!=='string'||record.id.length>256||this.filename(record.id)!==path||!record.primary||typeof record.primary.key!=='string'||!Number.isSafeInteger(record.primary.epoch)||typeof record.workspaceId!=='string'||!Number.isSafeInteger(record.pendingCount)||!['reserved','returned','uncertain'].includes(record.status))throw new Error('Recovery record is invalid.');
    return record;
  }
  private serial<T>(work:()=>Promise<T>):Promise<T> {const result=this.tail.then(work);this.tail=result.catch(()=>{});return result;}
  private async write(record:OwnerRecovery) {
    const bytes=Buffer.from(JSON.stringify(record));if(bytes.length>this.limits.recordBytes+64*1024)throw new Error('Recovery response exceeds its record bound.');
    let total=this.charge(record,bytes.length);for(const [id,item]of this.records)if(id!==record.id)total+=this.charge(item,this.sizes.get(id)??0);
    if(total>this.limits.recoveryBytes)throw new Error('Recovery byte capacity is exhausted.');
    const temp=join(this.directory,`.tmp-${randomUUID()}`);const file=await open(temp,'wx',0o600);
    try {await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    try {await rename(temp,this.filename(record.id));const dir=await open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}}
    catch(error){await unlink(temp).catch(()=>{});throw error;}
    this.records.set(record.id,structuredClone(record));this.sizes.set(record.id,bytes.length);
  }
  reserve(ownerIncarnation:string,primary:OwnerPrimary,reservation:OwnerQueueReservation):Promise<void> {
    return this.serial(async()=> {
      if(!reservation.id||reservation.id.length>256||!reservation.workspaceId||reservation.workspaceId.length>256||!Number.isSafeInteger(reservation.pendingCount)||reservation.pendingCount<0||reservation.pendingCount>this.limits.queueItems)throw new Error('Queue recovery reservation is invalid.');
      if(this.records.has(reservation.id)||this.hasPrimary(primary.key))throw new Error('Existing queue recovery must be imported before another clear.');
      if(this.records.size>=this.limits.recoveryRecords)throw new Error('Queue recovery capacity is exhausted.');
      await this.write({format:'ui.owner-recovery/1',state:this.state,ownerIncarnation,id:reservation.id,primary:structuredClone(primary),workspaceId:reservation.workspaceId,pendingCount:reservation.pendingCount,status:'reserved'});
    });
  }
  returned(id:string,response:OwnerRecord):Promise<void> {return this.serial(async()=>{const record=this.records.get(id);if(!record)throw new Error('Queue recovery reservation is absent.');await this.write({...record,status:'returned',response:structuredClone(response)});});}
  uncertain(id:string):Promise<void> {return this.serial(async()=>{const record=this.records.get(id);if(record)await this.write({...record,status:'uncertain'});});}
  list():OwnerRecovery[] {return [...this.records.values()].map(value=>structuredClone(value));}
  hasPrimary(key:string) {return [...this.records.values()].some(record=>record.primary.key===key);}
  ack(id:string):Promise<boolean> {return this.serial(async()=> {
    if(!this.records.has(id))return false;
    await unlink(this.filename(id));const dir=await open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}
    this.records.delete(id);this.sizes.delete(id);return true;
  });}
  async drain() {await this.tail;}
}
