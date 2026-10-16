import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import type {fork,ChildProcess} from 'node:child_process';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {supervise} from './supervisor.mts';
import {atomicJson,releaseRoot,readSelection} from './release-store.mts';
import {RELEASE_FORMAT,BROWSER_API,type ReleaseManifest} from '../shared/release.ts';
import {OWNER_PROTOCOL} from '../shared/owner.ts';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const absent=()=>{throw Object.assign(Error('absent'),{code:'ESRCH'});};
type Message={kind:string;release?:{directory:string;manifest:ReleaseManifest;previous?:string};options?:unknown};
class Child extends EventEmitter {
  pid:number;stdout=new EventEmitter();stderr=new EventEmitter();sent:Message[]=[];failWarm=false;failActivation=false;holdDrain=false;
  constructor(pid:number){super();this.pid=pid;}
  send(message:Message,callback?:(error?:Error)=>void){this.sent.push(message);callback?.();queueMicrotask(()=>this.respond(message));return true;}
  private respond(message:Message){
    if(message.kind==='start')this.emit('message',{kind:'ready',url:'http://127.0.0.1:1234/',identity:{}});
    if(message.kind==='prewarm')this.emit('message',{kind:this.failWarm?'prewarm-failed':'prewarmed'});
    if(message.kind==='activate'){if(this.failActivation)this.emit('exit',1,null);else this.emit('message',{kind:'ready',url:'http://127.0.0.1:1234/',identity:{}});}
    if(message.kind==='drain')this.emit('message',{kind:this.holdDrain?'drain-blocked':'fenced'});
    if(message.kind==='detach'||message.kind==='whole-stop')this.emit('exit',0,null);
  }
  kill(){queueMicrotask(()=>this.emit('exit',0,null));return true;}
}
async function fixture(context:test.TestContext){
  const temporary=await realpath(await mkdtemp(join(tmpdir(),'ui-release-switch-')));context.after(()=>rm(temporary,{recursive:true,force:true}));const paths=await releaseRoot(join(temporary,'state'));
  const releases=[];for(const letter of ['a','b']){const id=letter.repeat(64),runtime='c'.repeat(64),directory=join(paths.root,'runtimes',runtime,'releases',id);await mkdir(directory,{recursive:true});const manifest:ReleaseManifest={format:RELEASE_FORMAT,id,sourceCommit:letter.repeat(40),sourceTree:letter.repeat(40),iteration:'1.6',stagedAt:new Date().toISOString(),committedAt:new Date().toISOString(),branch:'fixture',lockDigest:runtime,runtimeDigest:runtime,assetDigest:runtime,ownerProtocol:OWNER_PROTOCOL,browserApi:BROWSER_API,generation:id,moduleFamily:id,files:{},imports:{}};await atomicJson(join(directory,'release.json'),manifest);await mkdir(join(paths.root,'releases'),{recursive:true});await atomicJson(join(paths.root,'releases',`${id}.json`),{runtimeDigest:runtime});releases.push({directory,manifest});}
  const first=releases[0],second=releases[1];assert.ok(first&&second);return{paths,first,second};
}
function fleet(configure?:(child:Child,index:number)=>void){const children:Child[]=[];const spawn=(()=>{const child=new Child(100+children.length);configure?.(child,children.length);children.push(child);queueMicrotask(()=>child.emit('spawn'));return child as unknown as ChildProcess;}) as typeof fork;return{children,spawn};}
test('forward switch and reverse rollback preload the replaced sealed generation without persisted page leases',async context=> {
  const f=await fixture(context),processes=fleet(),parent=supervise({cwd:f.paths.state,port:1234,pi:'pi',stateDir:f.paths.state},{release:f.first,releaseRoot:f.paths.root,spawn:processes.spawn,signal:absent});context.after(async()=>{parent.stop();await parent.closed;});await turn();
  assert.equal((await parent.switchRelease(f.second.manifest.id)).state,'ready');assert.equal(parent.status().current,f.second.manifest.id);assert.equal((await readSelection(f.paths.root))?.lastGood,f.first.manifest.id);
  assert.equal(processes.children[1]?.sent.find(v=>v.kind==='prewarm')?.release?.previous,f.first.directory);
  await parent.rollback();assert.equal(parent.status().current,f.first.manifest.id);assert.equal((await readSelection(f.paths.root))?.lastGood,f.second.manifest.id);
  assert.equal(processes.children[2]?.sent.find(v=>v.kind==='prewarm')?.release?.previous,f.second.directory);
});
test('failed prewarm or refused drain leaves the active backend and selection unchanged',async context=> {
  for(const refusal of ['prewarm','drain']){
    const f=await fixture(context),processes=fleet((child,index)=>{if(index===1&&refusal==='prewarm')child.failWarm=true;if(index===0&&refusal==='drain')child.holdDrain=true;}),parent=supervise({cwd:f.paths.state,port:1234,pi:'pi',stateDir:f.paths.state},{release:f.first,releaseRoot:f.paths.root,spawn:processes.spawn,signal:absent});await turn();
    await assert.rejects(()=>parent.switchRelease(f.second.manifest.id));assert.equal(parent.status().current,f.first.manifest.id);assert.equal(parent.status().backendPid,100);assert.equal(processes.children[0]?.sent.some(v=>v.kind==='detach'),false);
    parent.stop();await parent.closed;
  }
});
test('post-transfer startup failure restores the prior sealed backend and supplies candidate page bytes for rollback',async context=> {
  const f=await fixture(context),processes=fleet((child,index)=>{if(index===1)child.failActivation=true;}),parent=supervise({cwd:f.paths.state,port:1234,pi:'pi',stateDir:f.paths.state},{release:f.first,releaseRoot:f.paths.root,spawn:processes.spawn,signal:absent});context.after(async()=>{parent.stop();await parent.closed;});await turn();
  await assert.rejects(()=>parent.switchRelease(f.second.manifest.id));assert.equal(parent.status().current,f.first.manifest.id);assert.equal(parent.status().backendPid,102);assert.equal(processes.children[2]?.sent[0]?.release?.previous,f.second.directory);
});
