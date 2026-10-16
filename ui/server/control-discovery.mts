import {constants, type Stats} from 'node:fs';
import {lstat,open,rename,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import type {ControlDescriptor} from '../shared/control.ts';
import {ApiError} from './errors.mts';
const BYTES=2048;
function unavailable():ApiError {return new ApiError('not_ready','Private control discovery is unavailable.',503);}
function privateEntry(info:Stats,directory=false):boolean {return (directory?info.isDirectory():info.isFile()&&info.nlink===1)&&!info.isSymbolicLink()&&info.uid===process.getuid?.()&&(info.mode&0o077)===0;}
export async function readControlDescriptor(directory:string):Promise<ControlDescriptor> {
  if(!privateEntry(await lstat(directory),true))throw unavailable();
  const file=await open(join(directory,'control.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if(!privateEntry(await file.stat()))throw unavailable();
    const buffer=Buffer.alloc(BYTES+1);let length=0;
    while(length<buffer.length){const read=await file.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
    if(length>BYTES)throw unavailable();
    const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw unavailable();
    const value=raw as Record<string,unknown>;
    if(Object.keys(value).length!==2||typeof value.origin!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value.origin)||new URL(value.origin).port===''||typeof value.bootId!=='string'||!/^[a-f0-9-]{36}$/.test(value.bootId))throw unavailable();
    return value as ControlDescriptor;
  } catch {throw unavailable();}finally {await file.close();}
}
/** Private discovery identifies the current local backend without credentials. */
export class ControlDiscovery {
  private descriptor?:ControlDescriptor;private directory?:string;
  async publish(directory:string,origin:string,bootId:string):Promise<void> {
    if(!privateEntry(await lstat(directory),true))throw unavailable();
    const temporary=join(directory,`.control-${randomBytes(12).toString('hex')}.tmp`),descriptor={origin,bootId};
    try {
      const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try {await file.writeFile(JSON.stringify(descriptor));await file.sync();}finally {await file.close();}
      await rename(temporary,join(directory,'control.json'));this.directory=directory;this.descriptor=descriptor;
    }finally {await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  async close():Promise<void> {
    const directory=this.directory,bootId=this.descriptor?.bootId;this.descriptor=undefined;this.directory=undefined;if(!directory)return;
    try {const current=await readControlDescriptor(directory);if(current.bootId===bootId)await unlink(join(directory,'control.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
}
