import {fork, type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {Options} from './main.mts';
import type {UiIdentity} from '../shared/version.ts';
import {redactLifecycle,LIFECYCLE_BYTES} from './lifecycle-log.mts';

export type BackendReady={kind:'ready';url:string;identity:UiIdentity};
type SupervisorOptions={module?:string;ready?:(message:BackendReady)=>void;output?:(line:string)=>void;
  spawn?:typeof fork;signal?:(pid:number,signal:NodeJS.Signals|0)=>void;now?:()=>number;restartDelayMs?:number;graceMs?:number;cleanupMs?:number};
function groupExists(pid:number,signal:NonNullable<SupervisorOptions['signal']>) {
  try {signal(-pid,0);return true;} catch(error) {if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw new Error('Owned process cleanup is unavailable.');}
}
function killGroup(pid:number,signal:NonNullable<SupervisorOptions['signal']>) {
  try {signal(-pid,'SIGKILL');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
}
function readyMessage(message:unknown):BackendReady|undefined {
  if(!message||typeof message!=='object')return;
  const value=message as BackendReady;if(value.kind!=='ready'||typeof value.url!=='string')return;
  let url:URL;try {url=new URL(value.url);} catch {return;}
  if(url.hostname==='127.0.0.1'&&url.protocol==='http:')return value;
}
async function cleanupGroup(pid:number,signal:NonNullable<SupervisorOptions['signal']>,now:()=>number,limit:number) {
  const deadline=now()+limit;let killed=false;
  await new Promise<void>((resolve,reject)=> {
    const inspect=()=> {
      try {
        if(!groupExists(pid,signal)) {resolve();return;}
        if(now()>=deadline) {reject(new Error('Owned processes did not stop.'));return;}
        if(!killed) {killGroup(pid,signal);killed=true;}
        setTimeout(inspect,25);
      } catch(error) {reject(error);}
    };inspect();
  });
}
function crashDelay(crashes:number[],at:number,base:number):number|undefined {
  while(crashes.length&&(crashes[0]??at)<at-60000) crashes.shift();crashes.push(at);
  if(crashes.length>=3)return;
  return base*2**Math.max(0,crashes.length-1);
}
/** A replacement never starts until the process group created for its predecessor is absent. */
export function supervise(options:Options,hooks:SupervisorOptions={}) {
  const signal=hooks.signal??((pid,kind)=>{process.kill(pid,kind);});const now=hooks.now??Date.now;
  let child:ChildProcess|undefined,stopped=false,restarts=0,requested=false;
  let delay:ReturnType<typeof setTimeout>|undefined,grace:ReturnType<typeof setTimeout>|undefined,startup:ReturnType<typeof setTimeout>|undefined;
  let finish:(code:number)=>void;const closed=new Promise<number>(resolve=>{finish=resolve;});
  const crashes:number[]=[];const selected={...options,devReload:true};
  let outputBytes=0,outputStopped=false;
  const output=(line:string)=> {
    if(outputStopped)return;const text=redactLifecycle(line),bytes=Buffer.byteLength(text)+1;
    if(outputBytes+bytes>LIFECYCLE_BYTES-64) {outputStopped=true;hooks.output?.('Further backend output is omitted.');return;}
    outputBytes+=bytes;hooks.output?.(text);
  };
  const settle=(code:number)=> {stopped=true;clearTimeout(delay);clearTimeout(grace);clearTimeout(startup);finish(code);};
  const awaitExit=(current:ChildProcess)=> {
    clearTimeout(grace);const pid=current.pid;if(!pid)return;
    grace=setTimeout(()=>{try {killGroup(pid,signal);} catch { /* Exit verification still owns completion. */ }},hooks.graceMs??5000);
  };
  const exited=async(current:ChildProcess,code:number|null,termination:NodeJS.Signals|null,intentional:boolean)=> {
    if(current.pid)await cleanupGroup(current.pid,signal,now,hooks.cleanupMs??5000);
    child=undefined;
    if(stopped||(code===0&&!termination&&!intentional)) {settle(0);return;}
    const next=intentional?0:crashDelay(crashes,now(),hooks.restartDelayMs??100);
    if(next===undefined) {output('The backend restart limit was reached.');settle(1);return;}
    if(!intentional)output('The backend stopped unexpectedly; a replacement will start.');
    restarts++;delay=setTimeout(launch,next);
  };
  const relay=(stream:NodeJS.ReadableStream)=> {
    let buffer='',discard=false;
    const line=(part:string)=> {
      if(buffer.length+part.length>4096) {buffer='';discard=true;}
      if(!discard) buffer+=part;
      if(!part.endsWith('\n'))return;
      if(!discard)output(buffer.trimEnd());buffer='';discard=false;
    };
    stream.on('data',(chunk:Buffer)=>{for(const part of String(chunk).split(/(?<=\n)/))line(part);});
    stream.on('end',()=>{if(buffer&&!discard) output(buffer);});
  };
  const launch=()=> {
    if(stopped) return;
    requested=false;
    let current:ChildProcess;
    try {current=(hooks.spawn??fork)(hooks.module??fileURLToPath(new URL('./main.mts',import.meta.url)),[],{detached:true,stdio:['ignore','pipe','pipe','ipc']});}
    catch {output('The backend process did not start.');settle(1);return;}
    child=current;
    if(current.stdout) relay(current.stdout);if(current.stderr) relay(current.stderr);
    current.on('error',()=> {
      output('The backend process failed.');if(!current.pid) {settle(1);return;}
      current.kill('SIGTERM');awaitExit(current);
    });
    current.once('spawn',()=> {
      if(stopped) {current.kill('SIGTERM');return;}
      current.send({kind:'start',options:selected,restarts},error=>{if(error) current.kill('SIGTERM');});
      startup=setTimeout(()=>{output('The backend did not confirm startup.');current.kill('SIGKILL');},45000);
    });
    current.on('message',(message:unknown)=> {
      if(child!==current||stopped) return;
      const value=readyMessage(message);
      if(value) {selected.port=Number(new URL(value.url).port||80);clearTimeout(startup);hooks.ready?.(value);return;}
      if(message&&typeof message==='object'&&(message as {kind?:string}).kind==='restart') {requested=true;awaitExit(current);}
    });
    current.once('exit',(code,termination)=> {
      clearTimeout(grace);clearTimeout(startup);
      void exited(current,code,termination,requested).catch(()=>{output('Owned backend cleanup did not complete; restart stopped.');settle(1);});
    });
  };
  const stop=()=> {
    if(stopped) return;stopped=true;clearTimeout(delay);
    if(!child) {settle(0);return;}
    child.kill('SIGTERM');awaitExit(child);
  };
  launch();return {closed,stop,restartCount:()=>restarts};
}
