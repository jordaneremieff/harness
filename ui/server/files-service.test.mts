import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {Worker} from 'node:worker_threads';
import test from 'node:test';
import {Files, type FileJob} from './files.mts';
import {LIMITS} from '../shared/api.ts';
class FakeWorker extends EventEmitter {
  requests:{id:number;job:FileJob}[] = [];
  postMessage(request:{id:number;job:FileJob}):void {this.requests.push(request);if (request.job.kind === 'close') queueMicrotask(()=> {this.reply(request.id);this.emit('exit',0);});}
  reply(id:number):void {this.emit('message',{id,json:'{"ok":true,"data":null}',status:200});}
  async terminate():Promise<number> {this.emit('exit',1);return 1;}
}
test('timed-out jobs retain admission until worker settlement and close stops admission',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});
  const worker = new FakeWorker(), files = new Files({worker:worker as unknown as Worker,deadlineMs:10});
  const pending = Array.from({length:LIMITS.filePending},()=>assert.rejects(files.request({kind:'text',rootId:'r',path:'p'}),{code:'file_unavailable'}));
  context.mock.timers.tick(10);await Promise.all(pending);
  await assert.rejects(files.request({kind:'text',rootId:'r',path:'p'}),{code:'capacity'});
  for (const request of worker.requests) worker.reply(request.id);
  const next = files.request({kind:'selection',workspace:'w'});worker.reply(worker.requests.at(-1)?.id ?? 0);await next;
  const closed = files.close();await assert.rejects(files.request({kind:'selection',workspace:'w'}),{code:'file_unavailable'});await closed;
});
test('a move behind a stalled read expires, poisons identity and ignores a late reply',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const worker = new FakeWorker();let poisoned = 0;const files = new Files({worker:worker as unknown as Worker,deadlineMs:10,identityFailed:()=> {poisoned++;}});
  const watched = files.request({kind:'watch',workspace:'workspace',clientId:'page',roots:[{rootId:'root',directories:[''],files:[]}]});worker.reply(1);await watched;
  const events:string[] = [];files.observe(change=>events.push(change.watch));
  const reading = assert.rejects(files.request({kind:'text',rootId:'root',path:'stalled'}),{code:'file_unavailable'});
  const moved = assert.rejects(files.settled({kind:'move',rootId:'root',from:'from.md',to:'to.md'}),{code:'file_identity_uncertain',retry:'manual'});context.mock.timers.tick(10);await reading;await moved;
  worker.reply(3);assert.equal(poisoned,1);await assert.rejects(files.request({kind:'create',rootId:'root',path:'from.md',entryKind:'file'}),{code:'file_identity_uncertain'});assert.deepEqual(events,['unavailable']);await files.close();
});
test('close acknowledgment failure still waits for actual worker exit',async()=> {
  const worker = new FakeWorker();worker.postMessage = request=> {worker.requests.push(request);};
  const files = new Files({worker:worker as unknown as Worker});let settled = false;
  const result = assert.rejects(files.close(),{code:'file_unavailable'}).then(()=> {settled = true;});
  worker.emit('message',{id:1,json:0,status:200});await Promise.resolve();await Promise.resolve();assert.equal(settled,false);
  worker.emit('exit',0);await result;assert.equal(settled,true);
});
test('aborted requests retain worker ownership and a worker failure releases pending promises',async()=> {
  const worker = new FakeWorker(), files = new Files({worker:worker as unknown as Worker});
  const abort = new AbortController(), result = assert.rejects(files.request({kind:'selection',workspace:'w'},abort.signal),{code:'file_unavailable'});
  abort.abort();await result;worker.reply(1);
  const next = assert.rejects(files.request({kind:'selection',workspace:'w'}),{code:'file_unavailable'});
  worker.emit('error',new Error('unavailable'));worker.emit('exit',1);await next;await files.close();
});
test('invalid mutation acknowledgment poisons identity instead of inviting a replay',async()=> {
  const worker = new FakeWorker();let poisoned = 0;const files = new Files({worker:worker as unknown as Worker,identityFailed:()=> {poisoned++;}});
  const result = assert.rejects(files.settled({kind:'move',rootId:'root',from:'from',to:'to'}),{code:'file_identity_uncertain',retry:'manual'});worker.emit('message',{id:1,json:null,status:200});await result;assert.equal(poisoned,1);
  await assert.rejects(files.request({kind:'trash',rootId:'root',path:'from'}),{code:'file_identity_uncertain'});await files.close();
});
test('a worker post-effect refusal poisons the service before another request',async()=> {
  const worker = new FakeWorker();let poisoned = 0;const files = new Files({worker:worker as unknown as Worker,identityFailed:()=> {poisoned++;}});
  const result = files.request({kind:'trash',rootId:'root',path:'from'});worker.emit('message',{id:1,json:'{"ok":false,"error":{"code":"file_identity_uncertain","message":"Inspect both paths","retry":"manual"}}',status:503,identityFailure:true});assert.equal((await result).status,503);assert.equal(poisoned,1);await assert.rejects(files.request({kind:'create',rootId:'root',path:'from',entryKind:'file'}),{code:'file_identity_uncertain'});await files.close();
});
test('browser departure does not abandon a dispatched mutation',async()=> {
  const worker = new FakeWorker(),files = new Files({worker:worker as unknown as Worker}),abort = new AbortController();const result = files.request({kind:'create',rootId:'root',path:'new',entryKind:'file'},abort.signal);abort.abort();worker.reply(1);assert.equal((await result).status,200);await files.close();
});
test('failed stream cleanup stops live file claims rather than leaking an unreachable client scope',async()=> {
  const worker = new FakeWorker(),files = new Files({worker:worker as unknown as Worker});const watched = files.request({kind:'watch',workspace:'workspace',clientId:'page',roots:[{rootId:'root',directories:[''],files:[]}]});worker.reply(1);await watched;const events:string[] = [];files.observe(change=>events.push(change.watch));
  const pending = Array.from({length:LIMITS.filePending},()=>assert.rejects(files.request({kind:'text',rootId:'root',path:'blocked'}),{code:'file_unavailable'}));files.releaseWatch('workspace','page');await Promise.all(pending);assert.deepEqual(events,['unavailable']);await files.close();
});
