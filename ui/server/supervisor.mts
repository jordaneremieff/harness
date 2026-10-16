import {fork, type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import type {Options} from './options.mts';
import type {UiIdentity} from '../shared/version.ts';
import type {ReleaseManifest, ReleaseStatus} from '../shared/release.ts';
import {OWNER_PROTOCOL, type OwnerHello, type OwnerRequest, type OwnerStateIdentity, type OwnerNotice} from '../shared/owner.ts';
import {createPrimaryOwner, type PrimaryOwner} from './primary-owner.mts';
import {OwnerWire, type WireEndpoint} from './owner-wire.mts';
import {redactLifecycle,LIFECYCLE_BYTES} from './lifecycle-log.mts';
import {findRelease, writeSelection} from './release-store.mts';
export type BackendReady = {kind:'ready';url:string;identity:UiIdentity};
type Release = {directory:string;manifest:ReleaseManifest;previous?:string};
type SupervisorOptions = {module?:string;ready?:(message:BackendReady)=>void;output?:(line:string)=>void;
  spawn?:typeof fork;signal?:(pid:number,signal:NodeJS.Signals|0)=>void;now?:()=>number;restartDelayMs?:number;graceMs?:number;cleanupMs?:number;stopTimeoutMs?:number;
  release?:Release;releaseRoot?:string;lastGood?:string;
  observeOwnerRecord?:(notice:Extract<OwnerNotice,{kind:'record'}>)=>void};
type Running = {child:ChildProcess; attachment:string; connected?:boolean; wire:OwnerWire; release?:Release; intentional:boolean; exited:Promise<void>; resolveExit:()=>void; ready:Promise<BackendReady>; resolveReady:(v:BackendReady)=>void; rejectReady:(e:Error)=>void; prewarmed:Promise<void>; resolveWarm:()=>void; rejectWarm:(e:Error)=>void; drain?:{resolve:()=>void;reject:(e:Error)=>void}; stop?:{reject:(e:Error)=>void}; timer?:NodeJS.Timeout};
function groupExists(pid:number,signal:NonNullable<SupervisorOptions['signal']>) {try {signal(-pid,0);return true;} catch(error) {if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw new Error('Owned process cleanup is unavailable.');}}
function killGroup(pid:number,signal:NonNullable<SupervisorOptions['signal']>) {try {signal(-pid,'SIGKILL');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
async function cleanupGroup(pid:number,signal:NonNullable<SupervisorOptions['signal']>,now:()=>number,limit:number) {
  const deadline=now()+limit;let killed=false;
  await new Promise<void>((accept,reject)=> {const inspect=()=> {try {if(!groupExists(pid,signal)) {accept();return;} if(now()>=deadline) {reject(new Error('Owned processes did not stop.'));return;} if(!killed) {killGroup(pid,signal);killed=true;} setTimeout(inspect,25);} catch(error) {reject(error);}};inspect();});
}
function readyMessage(value:unknown):BackendReady|undefined {
  if(!value||typeof value!=='object')return;
  const v=value as BackendReady;if(v.kind!=='ready'||typeof v.url!=='string')return;
  try {const url=new URL(v.url);if(url.hostname==='127.0.0.1'&&url.protocol==='http:')return v;} catch {return;}
}
/** Backend process groups are replaceable. Detached Pi groups and their pipes belong only to the raw owner. */
export function supervise(options:Options,hooks:SupervisorOptions={}) {
  const signal=hooks.signal??((pid,kind)=>{process.kill(pid,kind);}),now=hooks.now??Date.now;
  const selected={...options,devReload:hooks.release?false:options.devReload??true};
  let current:Running|undefined,candidate:Running|undefined,owner:PrimaryOwner|undefined,ownerHello:OwnerHello|undefined,ownerStarting:Promise<PrimaryOwner>|undefined,ownerObserver:string|undefined;
  let stopped=false,stopping=false,restarts=0,unavailable=false,switching=false,lastGood=hooks.lastGood,activeRelease=hooks.release,triedLastGood=false,fallbackSelection=false;
  let delay:NodeJS.Timeout|undefined,finish!:(code:number)=>void;const closed=new Promise<number>(accept=>{finish=accept;});
  const crashes:number[]=[],failed:string[]=[],cleanupBlocked:Running[]=[];
  let stopError:ReleaseStatus['stopError'];
  let outputBytes=0,outputStopped=false;
  const output=(line:string)=> {if(outputStopped)return;const text=redactLifecycle(line),bytes=Buffer.byteLength(text)+1;if(outputBytes+bytes>LIFECYCLE_BYTES-64) {outputStopped=true;hooks.output?.('Further backend output is omitted.');return;} outputBytes+=bytes;hooks.output?.(text);};
  const settle=(code:number)=> {stopped=true;clearTimeout(delay);finish(code);};
  const controlState=():ReleaseStatus['state']=>{if(stopped)return 'stopped';if(stopping)return 'stopping';if(stopError)return 'stop-blocked';if(switching)return 'switching';return unavailable?'backend-unavailable':'ready';};
  const status=():ReleaseStatus=>({current:activeRelease?.manifest.id,lastGood,candidate:candidate?.release?.manifest.id,state:controlState(),...(stopError?{stopError}:{}),ownerPid:process.pid,backendPid:current?.child.pid,ownerIncarnation:ownerHello?.ownerIncarnation??'',ownerProtocol:OWNER_PROTOCOL,primaries:owner?.descriptors().filter(v=>!v.exited).map(({key,epoch,pid})=>({key,epoch,pid}))??[],failed:[...failed]});
  const relay=(stream:NodeJS.ReadableStream)=> {
    let buffer='',discard=false;
    const line=(part:string)=>{if(buffer.length+part.length>4096){buffer='';discard=true;}if(!discard)buffer+=part;if(!part.endsWith('\n'))return;if(!discard)output(buffer.trimEnd());buffer='';discard=false;};
    stream.on('data',(chunk:Buffer)=>{for(const part of String(chunk).split(/(?<=\n)/))line(part);});stream.on('end',()=>{if(buffer&&!discard)output(buffer);});
  };
  const observeOwner=()=>{
    if(!hooks.observeOwnerRecord||ownerObserver||!owner)return;
    ownerObserver=`observer:${randomUUID()}`;owner.connect(ownerObserver,notice=>{if(notice.kind==='record'){try{hooks.observeOwnerRecord?.(notice);}catch{output('The injected owner record observer failed.');}}return true;});
  };
  const ownerHandshake=async(run:Running):Promise<OwnerHello>=>{
    if(!owner)throw new Error('The raw owner is unavailable.');
    if(run.connected){const reply=await owner.handle(run.attachment,{kind:'hello',protocol:OWNER_PROTOCOL,ownerIncarnation:ownerHello?.ownerIncarnation??'',requestId:randomUUID()});if(!reply.ok)throw new Error('Owner handshake failed.');return reply.value as OwnerHello;}
    const hello=owner.connect(run.attachment,notice=>run.wire.send({kind:'notice',notice}));run.connected=true;return hello;
  };
  const attachOwner=async(run:Running,state:OwnerStateIdentity)=> {
    try {
      if(resolve(state.root)!==resolve(selected.stateDir??state.root)) throw new Error('The backend requested another selected state root.');
      ownerStarting??=createPrimaryOwner({state});owner??=await ownerStarting;
      observeOwner();const hello=await ownerHandshake(run);
      if(hello.state.root!==state.root||hello.state.instanceId!==state.instanceId) throw new Error('The backend state identity differs from its raw owner.');
      if(current===run)owner.grant(run.attachment);
      ownerHello=hello;run.child.send({kind:'owner-hello',hello});
    } catch {run.child.send({kind:'owner-hello',error:'The raw owner refused this backend state identity.'});}
  };
  const recordFailure=(id:string)=>{if(!failed.includes(id)){failed.push(id);if(failed.length>8)failed.shift();}};
  const tryLastGood=async():Promise<boolean>=>{
    if(!lastGood||lastGood===activeRelease?.manifest.id||triedLastGood||!hooks.releaseRoot)return false;
    triedLastGood=true;
    try{const release=await findRelease(hooks.releaseRoot,lastGood);activeRelease={...release,previous:activeRelease?.directory};fallbackSelection=true;lastGood=undefined;launch(false,activeRelease);return true;}
    catch{output('The last good release did not start.');return false;}
  };
  const restartAfterCrash=async(run:Running)=>{
    if(run.release)recordFailure(run.release.manifest.id);
    const at=now();while(crashes.length&&(crashes[0]??at)<at-60000)crashes.shift();crashes.push(at);
    if(crashes.length>=3){output('The backend restart limit was reached; the owner and Pi remain available.');if(await tryLastGood())return;unavailable=true;return;}
    output('The backend stopped unexpectedly; a replacement will start.');restarts++;
    delay=setTimeout(()=>launch(false,activeRelease),(hooks.restartDelayMs??100)*2**Math.max(0,crashes.length-1));
  };
  const watchExit=async(run:Running,code:number|null,termination:NodeJS.Signals|null)=> {
    clearTimeout(run.timer);run.wire.close();owner?.detach(run.attachment);
    if(run.child.pid)await cleanupGroup(run.child.pid,signal,now,hooks.cleanupMs??5000);
    run.resolveExit();run.rejectReady(new Error('The backend exited before readiness.'));run.rejectWarm(new Error('The candidate exited before prewarm.'));
    if(candidate===run) {candidate=undefined;return;}
    if(current!==run)return;current=undefined;
    if(stopping||stopped||switching||run.intentional)return;
    if(code===0&&!termination&&!owner) {settle(0);return;}
    await restartAfterCrash(run);
  };
  const backendReady=(run:Running,ready:BackendReady)=>{
    clearTimeout(run.timer);selected.port=Number(new URL(ready.url).port||80);unavailable=false;run.resolveReady(ready);hooks.ready?.(ready);
    if(fallbackSelection&&hooks.releaseRoot&&run.release){fallbackSelection=false;void writeSelection(hooks.releaseRoot,run.release.manifest.id).catch(()=>output('The restored release selection could not be retained.'));}
  };
  const backendControl=(run:Running,kind?:string,code?:unknown)=>{
    switch(kind){
      case 'prewarmed':clearTimeout(run.timer);run.resolveWarm();break;
      case 'prewarm-failed':run.rejectWarm(new Error('Candidate prewarm failed.'));break;
      case 'drain-blocked':run.drain?.reject(new Error('The active backend refused a short release drain.'));break;
      case 'fenced':run.drain?.resolve();break;
      case 'stop-blocked':run.stop?.reject(Object.assign(new Error('Primary recovery or writer exit blocks clean shutdown; the owner and Pi remain active.'),{code:typeof code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(code)?code:'shutdown_blocked'}));break;
      case 'restart':if(current===run&&!switching){run.intentional=true;run.timer=setTimeout(()=>{if(run.child.pid)killGroup(run.child.pid,signal);},hooks.graceMs??5000);void run.exited.then(()=>{if(!stopping&&!stopped){restarts++;launch(false,activeRelease);}});}break;
    }
  };
  const launch=(prewarm:boolean,release?:Release):Running=> {
    let child:ChildProcess;
    try {child=(hooks.spawn??fork)(hooks.module??(release?resolve(release.directory,'ui/server/backend.mts'):fileURLToPath(new URL('./backend.mts',import.meta.url))),[],{detached:true,stdio:['ignore','pipe','pipe','ipc']});}
    catch {unavailable=true;throw new Error('The backend process did not start.');}
    const run={} as Running;run.child=child;run.attachment=randomUUID();run.release=release;run.intentional=false;
    run.exited=new Promise<void>(accept=>{run.resolveExit=accept;});run.ready=new Promise<BackendReady>((accept,reject)=>{run.resolveReady=accept;run.rejectReady=reject;});void run.ready.catch(()=>{});
    run.prewarmed=new Promise<void>((accept,reject)=>{run.resolveWarm=accept;run.rejectWarm=reject;});void run.prewarmed.catch(()=>{});
    run.wire=new OwnerWire(child as unknown as WireEndpoint,value=> {
      const v=value as {kind?:string;request?:OwnerRequest};
      if(v.kind==='request'&&v.request) void (async()=> {
        const reply=owner?await owner.handle(run.attachment,v.request as OwnerRequest):{ok:false,error:{code:'not_ready',message:'The raw owner is unavailable.',uncertain:false}};
        run.wire.send({kind:'reply',id:v.request?.requestId,reply});
      })().catch(()=>output('An owner request failed without affecting other primaries.'));
    });
    if(prewarm)candidate=run;else current=run;
    if(child.stdout)relay(child.stdout);if(child.stderr)relay(child.stderr);
    child.once('spawn',()=> {if(stopped) {child.kill('SIGTERM');return;} child.send({kind:prewarm?'prewarm':'start',options:selected,restarts,owner:true,ownerState:ownerHello?.state,release},error=>{if(error)child.kill('SIGTERM');});run.timer=setTimeout(()=>{output('The backend did not confirm startup.');child.kill('SIGKILL');},45000);});
    child.on('error',()=> {output('The backend process failed.');if(!child.pid) {unavailable=true;run.rejectReady(new Error('Backend spawn failed.'));run.rejectWarm(new Error('Backend spawn failed.'));run.resolveExit();}else child.kill('SIGTERM');});
    child.on('message',(message:unknown)=> {
      const v=message as {kind?:string;state?:OwnerStateIdentity;code?:unknown};
      if(v.kind==='owner-connect'&&v.state) {void attachOwner(run,v.state);return;}
      const ready=readyMessage(message);
      if(ready){backendReady(run,ready);return;}
      backendControl(run,v.kind,v.code);
    });
    child.once('exit',(code,termination)=> {void watchExit(run,code,termination).catch(()=> {unavailable=true;run.resolveExit();cleanupBlocked.push(run);if(current===run)current=undefined;if(candidate===run)candidate=undefined;output('Backend group cleanup blocked replacement; the raw owner remains available.');});});
    return run;
  };
  const drainBackend=async(previous?:Running):Promise<boolean>=>{
    if(!previous)return false;
    await new Promise<void>((accept,reject)=>{const timer=setTimeout(()=>reject(new Error('The active backend did not confirm drain.')),1000);previous.drain={resolve:()=>{clearTimeout(timer);accept();},reject:error=>{clearTimeout(timer);reject(error);}};previous.child.send({kind:'drain'});});
    previous.intentional=true;previous.child.send({kind:'detach'});await previous.exited;return true;
  };
  const activateBackend=(next:Running)=>{
    candidate=undefined;current=next;if(next.connected)owner?.grant(next.attachment);next.timer=setTimeout(()=>next.child.kill('SIGKILL'),45000);next.child.send({kind:'activate',options:selected});
  };
  const restoreSwitch=async(id:string,release:Release,previous:Running|undefined,oldRelease:Release|undefined,next:Running|undefined,drained:boolean)=>{
    if(previous&&!drained&&!previous.intentional)previous.child.send({kind:'drain-cancel'});
    failed.push(id);if(failed.length>8)failed.shift();
    if(next){next.intentional=true;next.child.kill('SIGTERM');await next.exited;}
    if(drained&&oldRelease){const restored=launch(false,{...oldRelease,previous:release.directory});try{await restored.ready;}catch{unavailable=true;}}
    else if(previous)current=previous;
  };
  const selectRelease=async(id:string,release:Release,oldRelease?:Release)=>{
    if(!hooks.releaseRoot)throw new Error('Release storage is unavailable.');
    await writeSelection(hooks.releaseRoot,id,oldRelease?.manifest.id??lastGood);
    lastGood=oldRelease?.manifest.id??lastGood;activeRelease={...release,previous:oldRelease?.directory};crashes.length=0;triedLastGood=false;unavailable=false;switching=false;stopError=undefined;
  };
  const switchRelease=async(id:string)=> {
    if(switching||stopping||stopped||!hooks.releaseRoot||cleanupBlocked.length)throw new Error('Release switching is unavailable until owned backend cleanup is confirmed.');
    const release=await findRelease(hooks.releaseRoot,id);
    if(release.manifest.ownerProtocol!==OWNER_PROTOCOL)throw new Error('This release requires another raw owner protocol.');
    if(release.manifest.id===activeRelease?.manifest.id&&current)return status();
    switching=true;const previous=current,oldRelease=activeRelease;
    let next:Running|undefined,drained=false;
    try {
      next=launch(true,{...release,previous:oldRelease?.directory});await next.prewarmed;
      drained=await drainBackend(previous);activateBackend(next);await next.ready;
      await selectRelease(id,release,oldRelease);
      return status();
    } catch(error) {
      await restoreSwitch(id,release,previous,oldRelease,next,drained);throw error;
    } finally {candidate=undefined;switching=false;}
  };
  const stopWithOwner=async(run:Running)=>{
    let timer:NodeJS.Timeout|undefined;
    const blocked=new Promise<never>((_,reject)=>{run.stop={reject};timer=setTimeout(()=>reject(Object.assign(new Error('The backend did not confirm shutdown before its deadline; the owner and Pi remain active.'),{code:'shutdown_timeout'})),hooks.stopTimeoutMs??35000);});
    try{run.child.send({kind:'whole-stop'});await Promise.race([run.exited,blocked]);}finally{clearTimeout(timer);run.stop=undefined;}
  };
  const stopBackends=async()=>{
    for(const run of cleanupBlocked)if(run.child.pid)await cleanupGroup(run.child.pid,signal,now,hooks.cleanupMs??5000);cleanupBlocked.length=0;
    if(candidate){candidate.intentional=true;candidate.child.kill('SIGTERM');await candidate.exited;candidate=undefined;}
    if(!current)return;const run=current;run.intentional=true;
    if(owner){await stopWithOwner(run);return;}
    run.child.kill('SIGTERM');const timer=setTimeout(()=>{if(run.child.pid)killGroup(run.child.pid,signal);},hooks.graceMs??5000);await run.exited;clearTimeout(timer);
  };
  const stopOwner=async()=>{
    if(!owner)return;for(const primary of owner.descriptors())if(!primary.exited)await owner.shutdownPrimary(primary.key);if(ownerObserver)owner.detach(ownerObserver);await owner.dispose();
  };
  const stop=()=>{
    if(stopped||stopping)return;stopping=true;stopError=undefined;clearTimeout(delay);
    void (async()=>{await stopBackends();await stopOwner();settle(0);})().catch((error:unknown)=>{stopping=false;unavailable=!current;stopError={code:error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'shutdown_blocked',message:'Primary recovery or writer exit is unconfirmed; the owner remains active.'};output('Primary queue recovery or writer exit blocks clean shutdown.');});
  };
  try {launch(false,activeRelease);} catch {unavailable=true;}
  return {closed,stop,status,switchRelease,rollback:()=>{if(!lastGood)throw new Error('There is no last good release.');return switchRelease(lastGood);},restartCount:()=>restarts};
}
