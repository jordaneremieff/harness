import {constants, type Stats} from 'node:fs';
import {lstat,open,rename,unlink} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import type {IncomingMessage} from 'node:http';
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
    if(Object.keys(value).length!==3||typeof value.origin!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value.origin)||new URL(value.origin).port===''||typeof value.bootId!=='string'||!/^[a-f0-9-]{36}$/.test(value.bootId)||typeof value.credential!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.credential))throw unavailable();
    return value as ControlDescriptor;
  } catch {throw unavailable();}finally {await file.close();}
}
/** A separate local capability never authorizes browser APIs or launch sessions. */
export class ControlAuth {
  readonly credential=randomBytes(32).toString('base64url');
  private descriptor?:ControlDescriptor;private directory?:string;
  async publish(directory:string,origin:string,bootId:string):Promise<void> {
    if(!privateEntry(await lstat(directory),true))throw unavailable();
    const temporary=join(directory,`.control-${randomBytes(12).toString('hex')}.tmp`),descriptor={origin,bootId,credential:this.credential};
    try {
      const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try {await file.writeFile(JSON.stringify(descriptor));await file.sync();}finally {await file.close();}
      await rename(temporary,join(directory,'control.json'));this.directory=directory;this.descriptor=descriptor;
    }finally {await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  authorize(request:IncomingMessage):void {
    const header=request.headers.authorization;
    const expected=Buffer.from(`Bearer ${this.credential}`),actual=Buffer.from(typeof header==='string'?header:'');
    if(!this.descriptor||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new ApiError('unauthorized','The local control credential is unavailable or stale.',401);
    if(request.headers.cookie)throw new ApiError('unauthorized','Control requests require the separate local credential, without browser cookies.',401);
  }
  async close():Promise<void> {
    const directory=this.directory;this.descriptor=undefined;this.directory=undefined;if(!directory)return;
    try {const current=await readControlDescriptor(directory);if(current.credential===this.credential)await unlink(join(directory,'control.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
}
