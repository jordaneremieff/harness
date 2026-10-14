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
test('identity transactions retain settlement beyond response deadlines and report lost watches',async context=> {
  context.mock.timers.enable({apis:['setTimeout']});const worker = new FakeWorker(),files = new Files({worker:worker as unknown as Worker,deadlineMs:10});
  const watched = files.request({kind:'watch',workspace:'workspace',roots:[{rootId:'root',directories:[''],files:[]}]});worker.reply(1);await watched;
  const events:string[] = [];files.observe(change=>events.push(change.watch));let settled = false;
  const moved = files.settled({kind:'move',rootId:'root',from:'from.md',to:'to.md'}).then(()=> {settled = true;});context.mock.timers.tick(100);await Promise.resolve();assert.equal(settled,false);worker.reply(2);await moved;
  worker.emit('error',new Error('lost'));worker.emit('exit',1);assert.deepEqual(events,['unavailable']);await files.close();
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
