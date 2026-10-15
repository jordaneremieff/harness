import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import test from 'node:test';
import {AgentService, type CatalogPage} from './index.mts';

type Request = {id:number;member:string;args:unknown[]};
class Port extends EventEmitter {
  requests:Request[] = [];
  terminated = 0;
  auto = false;
  postMessage(request:Request):void {
    this.requests.push(request);
    if (this.auto || request.member==='close') queueMicrotask(()=>this.reply(request.id));
  }
  reply(id:number,result?:unknown):void {this.emit('message',{id,result});}
  ready():void {this.emit('message',{event:'ready',args:[]});}
  async terminate():Promise<number> {this.terminated++;this.emit('exit',1);return 1;}
}
const options = {store:'/fixture',stateDir:'/fixture',installationId:'fixture'};
const input = {targetKey:'00000000-0000-4000-8000-000000000009',images:[],operationId:'receipt',message:'Exact input',mode:'steer' as const};
async function until(predicate:()=>boolean):Promise<void> {
  const deadline = Date.now()+5000;
  while (!predicate()) {assert.ok(Date.now()<deadline,'worker condition deadline');await turn();}
}
function page():CatalogPage {return {rows:[],nextCursor:null,coverage:{complete:true,omitted:0},stale:false,scan:{state:'ready',complete:true,visited:0,skipped:0,omitted:0}};}

test('startup confirmation precedes refresh and selection restoration with new epochs',async t=> {
  const ports:Port[] = [], availability:unknown[][] = [], frames:unknown[][] = [];
  const service = new AgentService({...options,onAvailability:(...args)=>availability.push(args),onFrame:(...args)=>frames.push(args)},()=> {const port = new Port();ports.push(port);return port;});
  t.after(()=>service.close());assert.equal(service.available,false);ports[0].ready();assert.equal(service.available,true);
  const selected = service.select('workspace','identity');ports[0].reply(ports[0].requests[0].id);await selected;
  const oldEpoch = ports[0].requests[0].args[2];
  const pending = assert.rejects(service.history('identity'),{code:'host_unavailable',uncertain:false});
  ports[0].emit('exit',1);await pending;await until(()=>ports.length===2);
  assert.equal(service.available,false);assert.equal(ports[1].requests.length,0);
  assert.equal(availability.length,1);assert.equal(availability[0][3],'unavailable');
  ports[0].emit('message',{event:'frame',args:['workspace','identity',oldEpoch,{}]});ports[0].emit('exit',1);assert.equal(frames.length,0);
  ports[1].ready();await until(()=>ports[1].requests.length===1);
  assert.equal(ports[1].requests[0].member,'refresh');assert.equal(service.available,false);
  ports[1].emit('message',{event:'roster',args:[page()]});ports[1].reply(ports[1].requests[0].id);
  await until(()=>ports[1].requests.length===2);const restored = ports[1].requests[1];
  assert.equal(restored.member,'select');assert.notEqual(restored.args[2],oldEpoch);
  ports[1].reply(restored.id);await until(()=>service.available);
  ports[1].emit('message',{event:'frame',args:['workspace','identity',oldEpoch,{}]});assert.equal(frames.length,0);
  ports[1].emit('message',{event:'frame',args:[...restored.args,{}]});assert.equal(frames.length,1);
});

test('worker replacement retains admission receipts and never replays mutations',async t=> {
  const ports:Port[] = [];
  const service = new AgentService(options,()=> {const port = new Port();ports.push(port);return port;});
  t.after(()=>service.close());ports[0].ready();
  const submitted = service.submit('identity',input), aborted = service.abort('identity');
  const failures = [assert.rejects(submitted,{code:'host_unavailable',uncertain:true}),assert.rejects(aborted,{code:'host_unavailable',uncertain:true})];
  ports[0].emit('exit',1);await Promise.all(failures);await until(()=>ports.length===2);
  ports[1].auto = true;ports[1].ready();await until(()=>service.available);
  assert.deepEqual(ports[1].requests.map(request=>request.member),['refresh']);
  assert.equal(service.submit('identity',input),submitted);
  await assert.rejects(service.submit('identity',{...input,message:'Changed'}),{code:'operation_conflict'});
  assert.equal(ports[1].requests.length,1);
  ports[0].reply(ports[0].requests[0].id,{identity:'identity'});
  await assert.rejects(submitted,{code:'host_unavailable',uncertain:true});
});

test('confirmed admission receipt survives replacement without redispatch',async t=> {
  const ports:Port[] = [];
  const service = new AgentService(options,()=> {const port = new Port();ports.push(port);return port;});
  t.after(()=>service.close());ports[0].ready();const receipt = {identity:'identity'};
  const submitted = service.submit('identity',input);ports[0].reply(ports[0].requests[0].id,receipt);await submitted;
  ports[0].emit('exit',1);await until(()=>ports.length===2);ports[1].auto = true;ports[1].ready();await until(()=>service.available);
  assert.equal(service.submit('identity',input),submitted);assert.deepEqual(await service.submit('identity',input),receipt);
  assert.deepEqual(ports[1].requests.map(request=>request.member),['refresh']);
});

test('repeated replacement crashes stop after the finite lifetime budget',async t=> {
  const ports:Port[] = [];
  const service = new AgentService(options,()=> {const port = new Port();ports.push(port);return port;});
  t.after(()=>service.close());ports[0].emit('exit',1);
  for (let index = 1;index<=3;index++) {await until(()=>ports.length===index+1);ports[index].emit('exit',1);}
  await turn();await turn();assert.equal(ports.length,4);assert.equal(service.available,false);
  assert.throws(()=>service.refresh(),{code:'not_ready'});
  ports[0].ready();ports[0].emit('exit',1);await turn();assert.equal(ports.length,4);
});

test('close during replacement startup cancels restoration and rejects late readiness',async()=> {
  const ports:Port[] = [];
  const service = new AgentService(options,()=> {const port = new Port();ports.push(port);return port;});
  ports[0].ready();ports[0].emit('exit',1);await until(()=>ports.length===2);
  const closing = service.close();assert.equal(service.close(),closing);await closing;
  ports[1].ready();await turn();assert.equal(service.available,false);assert.equal(ports.length,2);
  assert.deepEqual(ports[1].requests,[]);assert.ok(ports[1].terminated>0);
});

test('departure during recovery does not restore hidden selections',async t=> {
  const ports:Port[] = [];
  const service = new AgentService(options,()=> {const port = new Port();ports.push(port);return port;});
  t.after(()=>service.close());ports[0].ready();ports[0].auto = true;
  await service.select('workspace','identity');ports[0].emit('exit',1);await until(()=>ports.length===2);
  await service.hide('workspace','identity');ports[1].auto = true;ports[1].ready();await until(()=>service.available);
  assert.deepEqual(ports[1].requests.map(request=>request.member),['refresh']);
});

test('actual owned agent-worker death restores empty-catalog reads and healthy state',async t=> {
  const directory = await mkdtemp(join(tmpdir(),'agent-recovery-')), workers:Worker[] = [];
  await mkdir(join(directory,'durable'));
  const service = new AgentService({store:directory,stateDir:directory,installationId:'fixture',agentDir:directory},(url,workerOptions)=> {assert.equal(url.href,new URL('./service-worker.mts',import.meta.url).href);const worker = new Worker(new URL('./service-worker.mts',import.meta.url),workerOptions);workers.push(worker);return worker;});
  t.after(async()=> {await service.close();await rm(directory,{recursive:true,force:true});});
  await service.refresh();await until(()=>service.available);await workers[0].terminate();
  await until(()=>workers.length===2 && service.available);
  assert.equal(service.roster().scan.state,'ready');assert.equal(service.roster().stale,false);
  await service.refresh();assert.deepEqual(service.roster().rows,[]);
});


test('replacement startup deadline exhausts stalled workers without idle polling',async t=> {
  t.mock.timers.enable({apis:['setTimeout']});const ports:Port[] = [];
  const service = new AgentService(options,()=> {const port = new Port();ports.push(port);return port;});t.after(()=>service.close());
  ports[0].emit('exit',1);
  for (let index = 1;index<=3;index++) {await until(()=>ports.length===index+1);t.mock.timers.tick(5000);await turn();}
  assert.equal(ports.length,4);assert.equal(service.available,false);assert.throws(()=>service.refresh(),{code:'not_ready'});
});

test('a saturated release preserves observation intent until the worker accepts cleanup',async t=> {
  const ports:Port[] = [];
  const service = new AgentService(options,()=> {const port = new Port();ports.push(port);return port;});t.after(()=>service.close());
  ports[0].ready();const selected = service.select('workspace','identity');ports[0].reply(ports[0].requests[0].id);await selected;
  const pending = Array.from({length:64},()=>assert.rejects(service.history('identity'),{code:'host_unavailable'}));
  await assert.rejects(service.hide('workspace','identity'),{code:'capacity'});ports[0].emit('exit',1);await Promise.all(pending);
  await until(()=>ports.length===2);ports[1].auto = true;ports[1].ready();await until(()=>service.available);
  assert.deepEqual(ports[1].requests.map(request=>request.member),['refresh','select']);
});

test('workspace departure during in-flight restoration releases observations without restoring other targets',async t=> {
  const ports:Port[] = [];
  const service = new AgentService(options,()=> {const port = new Port();ports.push(port);return port;});t.after(()=>service.close());
  ports[0].auto = true;ports[0].ready();await service.select('workspace','identity');await service.select('workspace','other');ports[0].emit('exit',1);await until(()=>ports.length===2);
  ports[1].ready();await until(()=>ports[1].requests.length===1);ports[1].reply(ports[1].requests[0].id);
  await until(()=>ports[1].requests.length===2);await service.disconnectWorkspace('workspace');ports[1].auto = true;ports[1].reply(ports[1].requests[1].id);
  await until(()=>service.available);assert.deepEqual(ports[1].requests.map(request=>request.member),['refresh','select','hide']);
});
