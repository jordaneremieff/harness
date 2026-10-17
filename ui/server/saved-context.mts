import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { buildSessionProjection, convertToLlm, parseSessionEntries, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Message } from '@earendil-works/pi-ai';
import { savedSessionRevision } from './sessions.mts';
import { ApiError } from './errors.mts';

const SOURCE_BYTES=64*1024*1024, RECORD_BYTES=32*1024*1024, MAX_ENTRIES=65536;
export type SavedContextRequest={path:string;project:string;id:string;revision:string};
export type SavedContext={messages:Message[];name?:string;nameDeclared:boolean;digest:string};
const entryTypes=new Set(['message','thinking_level_change','model_change','usage','compaction','branch_summary','custom','label','session_info','custom_message','context_edit']);
function record(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('A saved record is not an object.');
  return value as Record<string,unknown>;
}
function text(value:unknown):value is string {return typeof value==='string'&&value.length>0;}
function content(value:unknown):boolean {return typeof value==='string'||Array.isArray(value);}
function entryShape(row:Record<string,unknown>,seen:Set<string>):void {
  if(!text(row.type)||!entryTypes.has(row.type)||!text(row.id)||row.id.length>256||seen.has(row.id)||!text(row.timestamp)||!Number.isFinite(Date.parse(row.timestamp)))throw new Error('A saved entry has an invalid type, identity or timestamp.');
  if(row.parentId!==null&&(!text(row.parentId)||!seen.has(row.parentId)))throw new Error('The saved parent chain is incomplete or cyclic.');
  if(!payloadChecks[row.type]?.(row,seen))throw new Error(`The saved ${row.type} record is incomplete.`);
}
const payloadChecks:Record<string,(row:Record<string,unknown>,seen:Set<string>)=>boolean>={
  message:row=>{const message=record(row.message);return text(message.role)&&typeof message.timestamp==='number'&&Number.isFinite(message.timestamp);},
  session_info:row=>row.name===undefined||typeof row.name==='string',
  compaction:(row,seen)=>text(row.firstKeptEntryId)&&seen.has(row.firstKeptEntryId)&&typeof row.summary==='string'&&typeof row.tokensBefore==='number',
  branch_summary:row=>typeof row.summary==='string'&&typeof row.fromId==='string',
  context_edit:(row,seen)=>text(row.targetId)&&seen.has(row.targetId)&&(row.replacement===null||content(record(row.replacement).content)),
  custom_message:row=>typeof row.customType==='string'&&content(row.content)&&typeof row.display==='boolean',
  custom:row=>typeof row.customType==='string',
  thinking_level_change:row=>typeof row.thinkingLevel==='string',
  model_change:row=>text(row.provider)&&text(row.modelId),
  label:(row,seen)=>text(row.targetId)&&seen.has(row.targetId)&&(row.label===undefined||typeof row.label==='string'),
  usage:row=>text(row.kind)&&text(row.provider)&&text(row.model)&&!!record(row.usage),
};
function finiteJson(_key:string,value:unknown):unknown {if(typeof value==='number'&&!Number.isFinite(value))throw new Error('A saved JSON number is not finite.');return value;}
function validate(textValue:string,input:SavedContextRequest):void {
  if(!textValue.endsWith('\n'))throw new Error('The last saved record is incomplete.');
  const lines=textValue.split('\n');lines.pop();
  if(!lines.length||lines.length>MAX_ENTRIES)throw new Error('The saved entry count exceeds the conversion bound.');
  if(Buffer.byteLength(lines[0]??'')>65536)throw new Error('The saved header exceeds its bound.');
  const header=record(JSON.parse(lines[0]??'',finiteJson));
  if(header.type!=='session'||header.version!==3||(header.parentSession!==undefined&&typeof header.parentSession!=='string')||header.id!==input.id||typeof header.cwd!=='string'||resolve(header.cwd)!==resolve(input.project)||!text(header.timestamp)||!Number.isFinite(Date.parse(header.timestamp)))throw new Error('The current saved session header does not match this row.');
  const seen=new Set<string>();
  for(const line of lines.slice(1)) {
    if(!line||Buffer.byteLength(line)>RECORD_BYTES)throw new Error('A saved record is empty or exceeds the conversion bound.');
    const row=record(JSON.parse(line,finiteJson));entryShape(row,seen);seen.add(String(row.id));
  }
}
function same(a:Awaited<ReturnType<typeof stat>>,b:Awaited<ReturnType<typeof stat>>):boolean {return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
function savedName(entries:SessionEntry[]):{name?:string;nameDeclared:boolean} {
  let name:string|undefined,nameDeclared=false;
  for(const entry of entries)if(entry.type==='session_info'){name=entry.name;nameDeclared=true;}
  if(name!==undefined&&Buffer.byteLength(name)>4096)throw new Error('The actual saved name exceeds the native creation metadata bound.');
  return{name,nameDeclared};
}
async function capture(input:SavedContextRequest):Promise<SavedContext> {
  const file=await open(input.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=await file.stat();
    if(!before.isFile()||before.size>SOURCE_BYTES||savedSessionRevision(input.path,before)!==input.revision)throw new Error('The saved session changed or exceeds the conversion bound. Refresh the list.');
    const chunks:Buffer[]=[];let bytes=0;
    while(bytes<=SOURCE_BYTES) {
      const buffer=Buffer.allocUnsafe(Math.min(65536,SOURCE_BYTES+1-bytes));const read=await file.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;
      chunks.push(buffer.subarray(0,read.bytesRead));bytes+=read.bytesRead;
    }
    if(bytes!==before.size||!same(before,await file.stat())||!same(before,await stat(input.path)))throw new Error('The saved session changed during capture. Refresh the list.');
    const body=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks,bytes));validate(body,input);
    const parsed=parseSessionEntries(body);const entries=parsed.filter((entry):entry is SessionEntry=>entry.type!=='session');
    if(parsed.length!==body.split('\n').length-1)throw new Error('The public parser did not cover every saved record.');
    const messages=convertToLlm(buildSessionProjection(entries).messages).filter(message=>message.role!=='system');
    const named=savedName(entries);
    if(!same(before,await file.stat())||!same(before,await stat(input.path)))throw new Error('The saved session changed during projection. Refresh the list.');
    const {createHash}=await import('node:crypto');
    return{messages,...named,digest:createHash('sha256').update(JSON.stringify(messages)).digest('hex')};
  } finally {await file.close();}
}
let active=0;
/** One bounded worker keeps parsing and public projection outside the HTTP event loop. */
export async function savedContext(input:SavedContextRequest):Promise<SavedContext> {
  if(active>=2)throw new ApiError('capacity','Saved context capture is full.',429,'read');
  active++;let created=false;
  try {return await new Promise<SavedContext>((resolveResult,reject)=> {
    const worker=new Worker(new URL(import.meta.url),{workerData:{kind:'saved-context',input},resourceLimits:{maxOldGenerationSizeMb:256}});created=true;let received=false;
    const timer=setTimeout(()=>{void worker.terminate();reject(new ApiError('conversion_unavailable','Saved context capture exceeded its time bound.',413,'manual'));},15000);
    worker.once('message',(value:{ok:boolean;data:SavedContext;error:string})=>{received=true;clearTimeout(timer);void worker.terminate().then(()=>{if(value.ok)resolveResult(value.data);else reject(new ApiError('conversion_unavailable',value.error,409,'manual'));},()=>reject(new ApiError('conversion_unavailable','The capture worker did not close.',503,'manual')));});
    worker.once('error',error=>{clearTimeout(timer);reject(new ApiError('conversion_unavailable',error.message,409,'manual'));});
    worker.once('exit',()=>{active--;if(!received){clearTimeout(timer);reject(new ApiError('conversion_unavailable','Saved context capture ended without complete coverage.',409,'manual'));}});
  });}catch(error){if(!created)active--;throw error;}
}
if(!isMainThread&&workerData?.kind==='saved-context') {
  void capture(workerData.input).then(data=>parentPort?.postMessage({ok:true,data}),error=>parentPort?.postMessage({ok:false,error:error instanceof Error?error.message:'Saved context is unavailable.'}));
}
