import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {OwnerWire,type WireEndpoint} from './owner-wire.mts';
class Endpoint extends EventEmitter {other?:Endpoint;frames:unknown[]=[];send(value:unknown,callback:(error:Error|null)=>void){this.frames.push(value);queueMicrotask(()=>{this.other?.emit('message',value);callback(null);});return true;}}
test('owner IPC pages preserve large UTF-8 records within bounded individual frames',async()=> {
  const left=new Endpoint(),right=new Endpoint();left.other=right;right.other=left;
  let received!:(v:unknown)=>void;const value=new Promise<unknown>(resolve=>{received=resolve;});
  const sender=new OwnerWire(left as unknown as WireEndpoint,()=>{}),receiver=new OwnerWire(right as unknown as WireEndpoint,received);
  const record={type:'fixture',text:'😀'.repeat(180000)};assert.equal(sender.send(record),true);assert.deepEqual(await value,record);
  assert.ok(left.frames.length>1);assert.ok(left.frames.every(frame=>Buffer.byteLength(JSON.stringify(frame))<256*1024));sender.close();receiver.close();
});
test('owner IPC rejects excessive admission without backpressure on the Pi reader',()=> {
  const endpoint=new Endpoint(),sender=new OwnerWire(endpoint as unknown as WireEndpoint,()=>{});
  assert.equal(sender.send({text:'x'.repeat(9*1024*1024)}),true);assert.equal(sender.send({text:'second'}),false);
  sender.close();assert.equal(sender.send({text:'closed'}),false);
});
