import {constants} from 'node:fs';
import {open,opendir,realpath,stat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {hostname} from 'node:os';
import type {SavedSessionPage,SavedSession} from '../shared/api.ts';
import {savedSessionRevision,validateSessionProject} from './sessions.mts';
import {scanSessionTitle} from './sessions-title.mts';
import {ApiError} from './errors.mts';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Presence={id:string;sessionFile:string;cwd:string;name?:string};
function publisherPresent(value:{pid?:unknown;hostname?:unknown}):boolean {
  if(value.hostname!==hostname()||typeof value.pid!=='number'||!Number.isSafeInteger(value.pid)||value.pid<=0)return false;
  try{process.kill(value.pid,0);return true;}catch{return false;}
}
/** Public primary discovery data, not an Agent catalog or a live-context request. */
async function presence(root:string,id:string):Promise<Presence|undefined> {
  if(!UUID.test(id))return;
  const path=join(root,'.primaries',`${id}.json`);const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=await file.stat();if(!before.isFile()||before.size>16384)return;
    const buffer=Buffer.alloc(16385);const{bytesRead}=await file.read(buffer,0,buffer.length,0);
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)));
    if(!publisherPresent(value)||value.id!==id||typeof value.cwd!=='string'||!isAbsolute(value.cwd)||typeof value.sessionFile!=='string'||!isAbsolute(value.sessionFile)||(value.name!==undefined&&typeof value.name!=='string'))return;
    if(bytesRead!==before.size||savedSessionRevision(path,before)!==savedSessionRevision(path,await file.stat()))return;
    if(await realpath(value.sessionFile)!==resolve(value.sessionFile)||await validateSessionProject(value.cwd,value.sessionFile)!==id)return;
    return{id,cwd:value.cwd,sessionFile:value.sessionFile,...(value.name===undefined?{}:{name:value.name})};
  } finally {await file.close();}
}
export async function publishedOrdinaryName(root:string,id:string,path:string):Promise<string|undefined> {
  try{const value=await presence(root,id);return value?.sessionFile===path?value.name:undefined;}catch{return;}
}
async function row(root:string,id:string):Promise<SavedSession|undefined> {
  try {
    const info=await presence(root,id);if(!info)return;
    const before=await stat(info.sessionFile),revision=savedSessionRevision(info.sessionFile,before);
    let title=await scanSessionTitle(info.sessionFile,before.size);
    const changed=savedSessionRevision(info.sessionFile,await stat(info.sessionFile))!==revision;
    const current=changed?await presence(root,id):info;if(!current||current.sessionFile!==info.sessionFile)return;
    const after=await stat(current.sessionFile);
    if(savedSessionRevision(current.sessionFile,after)!==revision)title={title:'(title unavailable)',titleState:'unavailable'};
    const selected=title.titleState==='unavailable'&&current.name?{title:current.name,titleState:'ready' as const,titleSource:'name' as const}:title;
    return{id,path:current.sessionFile,project:current.cwd,revision:savedSessionRevision(current.sessionFile,after),size:after.size,modifiedAt:after.mtime.toISOString(),...selected};
  } catch {return;}
}
async function publishedIds(root:string):Promise<{ids:string[];omitted:number}> {
  const ids:string[]=[];let visited=0,omitted=0;
  try {
    const directory=await opendir(join(root,'.primaries'),{bufferSize:32});
    for await(const entry of directory) {
      if(++visited>8192)throw new ApiError('capacity','Public ordinary discovery exceeds its directory bound.',413);
      if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
      const id=entry.name.slice(0,-5);if(!UUID.test(id))continue;
      if(ids.length<256)ids.push(id);else omitted++;
    }
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return{ids,omitted};
}
export async function publishedOrdinarySessions(root:string):Promise<SavedSessionPage> {
  const discovery=await publishedIds(root);const ids=discovery.ids;let omitted=discovery.omitted;
  const items:SavedSession[]=[];
  for(let offset=0;offset<ids.length;offset+=8)for(const item of await Promise.all(ids.slice(offset,offset+8).map(id=>row(root,id)))){if(item)items.push(item);else omitted++;}
  items.sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt));
  return{items,total:items.length,omitted,nextCursor:null,titleCursor:null,observedAt:new Date().toISOString()};
}
