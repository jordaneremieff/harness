import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import test from 'node:test';
import {Files, type FileJob} from './files.mts';
import {LIMITS} from '../shared/api.ts';
import type {FileChanges} from '../shared/files.ts';

class Port extends EventEmitter {
  requests:{id:number;job:FileJob}[] = [];
  autoOpen = true;
  autoWatch = true;
  terminated = 0;
  postMessage(request:{id:number;job:FileJob}):void {
    this.requests.push(request);
    if (request.job.kind === 'open' && this.autoOpen || request.job.kind === 'watch' && this.autoWatch || request.job.kind === 'unwatch') queueMicrotask(()=>this.reply(request.id));
    if (request.job.kind === 'close') queueMicrotask(()=> {this.reply(request.id);this.emit('exit',0);});
  }
  reply(id:number):void {this.emit('message',{id,json:'{"ok":true,"data":null}',status:200});}
  async terminate():Promise<number> {this.terminated++;this.emit('exit',1);return 1;}
  worker():Worker {return this as unknown as Worker;}
}
async function until(predicate:()=>boolean):Promise<void> {
  const deadline = Date.now()+5000;
  while (!predicate()) {assert.ok(Date.now()<deadline,'worker condition deadline');await turn();}
}
const scope = [{rootId:'root',directories:['','nested'],files:['nested/open.md']}];

test('replacement reopens state before full watch scopes and ignores all old-generation traffic',async t=> {
  const ports:Port[] = [];
  const files = new Files({workerFactory:()=> {const port = new Port();if (ports.length) port.autoOpen = false;ports.push(port);return port.worker();}});
  t.after(()=>files.close());
  const events:FileChanges[] = [];files.observe(change=>events.push(change));
  assert.equal(files.available,false);
  await files.request({kind:'open',directory:'/fixture'});assert.equal(files.available,true);
  const roots = structuredClone(scope);await files.request({kind:'watch',workspace:'w',clientId:'c',roots});roots[0].files[0] = 'mutated';
  const failed = assert.rejects(files.request({kind:'text',rootId:'root',path:'pending'}),{code:'file_unavailable'});
  ports[0].emit('exit',1);await failed;await until(()=>ports.length===2);
  assert.equal(files.available,false);assert.deepEqual(events.map(event=>event.watch),['unavailable']);
  assert.deepEqual(ports[1].requests.map(request=>request.job.kind),['open']);
  ports[0].emit('message',{change:{rootId:'root',directories:[],files:[],rescan:false,watch:'live'},workspace:'w'});
  ports[0].reply(ports[0].requests.at(-1)?.id ?? 0);ports[0].emit('exit',1);
  assert.equal(events.length,1);
  ports[1].reply(ports[1].requests[0].id);await until(()=>files.available);
  assert.deepEqual(ports[1].requests[1].job,{kind:'watch',workspace:'w',clientId:'c',roots:scope});
  ports[1].emit('message',{change:{rootId:'root',directories:[],files:['nested/open.md'],rescan:true,watch:'live'},workspace:'w'});
  assert.equal(events.at(-1)?.watch,'live');assert.equal(ports.length,2);
});

test('identity uncertainty never replaces the worker or replays any effect',async t=> {
  const ports:Port[] = [];let poisoned = 0;
  const files = new Files({identityFailed:()=>poisoned++,workerFactory:()=> {const port = new Port();ports.push(port);return port.worker();}});
  t.after(()=>files.close());await files.request({kind:'open',directory:'/fixture'});
  const mutation = assert.rejects(files.request({kind:'save',rootId:'root',path:'edit.md',expectedRevision:1}),{code:'file_identity_uncertain'});
  ports[0].emit('exit',1);await mutation;await turn();
  assert.equal(poisoned,1);assert.equal(ports.length,1);assert.equal(files.available,false);
  await assert.rejects(files.request({kind:'selection',workspace:'w'}),{code:'file_identity_uncertain'});
  assert.deepEqual(ports[0].requests.map(request=>request.job.kind),['open','save']);
});

test('replacement startup failures exhaust a finite lifetime budget',async t=> {
  let creates = 0;const first = new Port();
  const files = new Files({workerFactory:()=> {if (++creates>1) throw new Error('startup refused');return first.worker();}});
  t.after(()=>files.close());await files.request({kind:'open',directory:'/fixture'});first.emit('exit',1);
  await until(()=>creates===4);await turn();assert.equal(files.available,false);
  first.emit('exit',1);await turn();assert.equal(creates,4);
  await assert.rejects(files.request({kind:'selection',workspace:'w'}),{code:'file_unavailable'});
});

test('close during replacement startup terminates it without watches or later resurrection',async()=> {
  const ports:Port[] = [];
  const files = new Files({workerFactory:()=> {const port = new Port();port.autoOpen = ports.length===0;ports.push(port);return port.worker();}});
  await files.request({kind:'open',directory:'/fixture'});await files.request({kind:'watch',workspace:'w',clientId:'c',roots:scope});
  ports[0].emit('exit',1);await until(()=>ports.length===2);
  const closing = files.close();assert.equal(files.close(),closing);await closing;
  ports[1].reply(ports[1].requests[0].id);await turn();
  assert.equal(files.available,false);assert.equal(ports.length,2);assert.ok(ports[1].terminated>0);
  assert.deepEqual(ports[1].requests.map(request=>request.job.kind),['open']);
});

test('watch departure during recovery removes only that client intent',async t=> {
  const ports:Port[] = [];
  const files = new Files({workerFactory:()=> {const port = new Port();port.autoOpen = ports.length===0;ports.push(port);return port.worker();}});
  t.after(()=>files.close());await files.request({kind:'open',directory:'/fixture'});
  await files.request({kind:'watch',workspace:'w',clientId:'gone',roots:scope});
  await files.request({kind:'watch',workspace:'w',clientId:'kept',roots:scope});
  ports[0].emit('exit',1);await until(()=>ports.length===2);files.releaseWatch('w','gone');
  ports[1].reply(ports[1].requests[0].id);await until(()=>files.available);
  assert.deepEqual(ports[1].requests.filter(request=>request.job.kind==='watch').map(request=>(request.job as Extract<FileJob,{kind:'watch'}>).clientId),['kept']);
});

test('actual owned file-worker death recovers durable selection, reads, and watch observers',async t=> {
  const directory = await mkdtemp(join(tmpdir(),'files-recovery-')), project = join(directory,'project'), workers:Worker[] = [];
  await mkdir(project);await writeFile(join(project,'open.md'),'before');
  const files = new Files({workerFactory:()=> {const worker = new Worker(new URL('./files-worker.mts',import.meta.url));workers.push(worker);return worker;}});
  t.after(async()=> {await files.close();await rm(directory,{recursive:true,force:true});});
  await files.request({kind:'open',directory});
  const workspace = '00000000-0000-4000-8000-000000000001';
  const selected = JSON.parse((await files.request({kind:'select',workspace,path:project,expectedRevision:0})).json).data;
  const rootId:string = selected.root.id, events:FileChanges[] = [];
  files.observe(change=>events.push(change));
  await files.request({kind:'watch',workspace,clientId:'client',roots:[{rootId,directories:[''],files:['open.md']}]});
  await workers[0].terminate();await until(()=>files.available && workers.length===2);
  const unavailable = events.findIndex(event=>event.watch==='unavailable');assert.ok(unavailable>=0);
  assert.ok(events.slice(unavailable+1).some(event=>event.watch==='live' && event.rescan));
  assert.deepEqual(JSON.parse((await files.request({kind:'selection',workspace})).json).data,selected);
  assert.equal(JSON.parse((await files.request({kind:'text',rootId,path:'open.md'})).json).data.text,'before');
  assert.equal(JSON.parse((await files.request({kind:'watch-state',workspace,clientId:'client'})).json).data.roots[0].watch,'live');
});


test('stalled replacement startup expires without unbounded attempts',async t=> {
  t.mock.timers.enable({apis:['setTimeout']});const ports:Port[] = [];
  const files = new Files({deadlineMs:10,workerFactory:()=> {const port = new Port();port.autoOpen = ports.length===0;ports.push(port);return port.worker();}});
  t.after(()=>files.close());await files.request({kind:'open',directory:'/fixture'});ports[0].emit('exit',1);
  for (let index = 1;index<=3;index++) {await until(()=>ports.length===index+1);t.mock.timers.tick(10);await turn();}
  assert.equal(ports.length,4);assert.equal(files.available,false);
  await assert.rejects(files.request({kind:'selection',workspace:'w'}),{code:'file_unavailable'});
});

test('a saturated departure never restores an unreachable client scope',async t=> {
  const ports:Port[] = [];
  const files = new Files({workerFactory:()=> {const port = new Port();ports.push(port);return port.worker();}});
  t.after(()=>files.close());await files.request({kind:'open',directory:'/fixture'});await files.request({kind:'watch',workspace:'w',clientId:'c',roots:scope});
  const pending = Array.from({length:LIMITS.filePending},()=>assert.rejects(files.request({kind:'text',rootId:'root',path:'pending'}),{code:'file_unavailable'}));
  files.releaseWatch('w','c');await Promise.all(pending);await until(()=>ports.length===2 && files.available);
  assert.deepEqual(ports[1].requests.map(request=>request.job.kind),['open']);
});

test('departure during an in-flight watch restoration releases the replacement scope',async t=> {
  const ports:Port[] = [];
  const files = new Files({workerFactory:()=> {const port = new Port();port.autoWatch = ports.length===0;ports.push(port);return port.worker();}});
  t.after(()=>files.close());await files.request({kind:'open',directory:'/fixture'});await files.request({kind:'watch',workspace:'w',clientId:'c',roots:scope});
  ports[0].emit('exit',1);await until(()=>ports.length===2 && ports[1].requests.length===2);
  assert.equal(files.available,false);files.releaseWatch('w','c');ports[1].reply(ports[1].requests[1].id);await until(()=>files.available);
  assert.deepEqual(ports[1].requests.map(request=>request.job.kind),['open','watch','unwatch']);
});
