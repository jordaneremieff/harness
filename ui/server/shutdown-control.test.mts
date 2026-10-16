import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import type {fork,ChildProcess} from 'node:child_process';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {supervise} from './supervisor.mts';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
class Backend extends EventEmitter {
  pid=101;stdout=new EventEmitter();stderr=new EventEmitter();sent:{kind:string}[]=[];refuse=false;hello?:()=>void;
  send(value:{kind:string},callback?:(error?:Error)=>void){this.sent.push(value);callback?.();queueMicrotask(()=>{
    if(value.kind==='start')this.emit('message',{kind:'ready',url:'http://127.0.0.1:1234/',identity:{}});
    if(value.kind==='owner-hello')this.hello?.();
    if(value.kind==='whole-stop'&&this.refuse)this.emit('message',{kind:'stop-blocked',code:'not_ready'});
  });return true;}
  kill(){throw Error('A retained-owner shutdown must not signal the backend or Pi.');}
}
async function fixture(context:test.TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-stop-control-'))),backend=new Backend(),signals:unknown[]=[];
  const spawn=(()=>{queueMicrotask(()=>backend.emit('spawn'));return backend as unknown as ChildProcess;}) as typeof fork;
  const parent=supervise({cwd:root,stateDir:root,port:1234,pi:'unused'},{spawn,stopTimeoutMs:5,signal:(pid,signal)=>{signals.push({pid,signal});throw Object.assign(Error('Absent test group'),{code:'ESRCH'});}});
  context.after(async()=>{backend.emit('exit',0,null);await turn();parent.stop();await parent.closed;await rm(root,{recursive:true,force:true});});
  await turn();const hello=new Promise<void>(resolve=>{backend.hello=resolve;});backend.emit('message',{kind:'owner-connect',state:{root,instanceId:randomUUID()}});await hello;
  return{parent,backend,signals};
}
test('a backend shutdown refusal becomes a blocked control state without signals or owner exit',async context=>{
  const {parent,backend,signals}=await fixture(context);backend.refuse=true;parent.stop();await turn();await turn();
  assert.equal(parent.status().state,'stop-blocked');assert.equal(parent.status().stopError?.code,'not_ready');assert.equal(parent.status().backendPid,101);assert.deepEqual(signals,[]);
  let closed=false;void parent.closed.then(()=>{closed=true;});await turn();assert.equal(closed,false);
});
test('a silent backend shutdown reaches a bounded blocked state and keeps the owner reachable',async context=>{
  const {parent,signals}=await fixture(context);context.mock.timers.enable({apis:['setTimeout']});parent.stop();context.mock.timers.tick(5);await turn();await turn();
  assert.equal(parent.status().state,'stop-blocked');assert.equal(parent.status().stopError?.code,'shutdown_timeout');assert.deepEqual(signals,[]);
});
