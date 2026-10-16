import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import type {spawn} from 'node:child_process';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPrimaryOwner,type PrimaryOwner} from './primary-owner.mts';
import {OwnerWire,type WireEndpoint} from './owner-wire.mts';
import {OwnerConnection} from './owner-client.mts';
import {FakeChild} from '../rpc/fake-child.mts';
import {PrimarySession} from '../rpc/session.mts';
import type {OwnerRequest} from '../shared/owner.ts';
import {withPrimaryOperation} from '../rpc/primary-operation.mts';
class Endpoint extends EventEmitter {other?:Endpoint;send(value:unknown,callback:(error:Error|null)=>void){queueMicrotask(()=>{this.other?.emit('message',value);callback(null);});return true;}}
function connect(owner:PrimaryOwner){const parent=new Endpoint(),backend=new Endpoint();parent.other=backend;backend.other=parent;const attachment=randomUUID();let wire:OwnerWire;const hello=owner.connect(attachment,notice=>wire.send({kind:'notice',notice}));owner.grant(attachment);wire=new OwnerWire(parent as unknown as WireEndpoint,value=>{const v=value as {kind:string;request:OwnerRequest};if(v.kind==='request')void owner.handle(attachment,v.request).then(reply=>wire.send({kind:'reply',id:v.request.requestId,reply}));});return{connection:OwnerConnection.connect(backend as unknown as WireEndpoint,hello),detach:()=>{wire.close();owner.detach(attachment);}};}
const settled=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('owner-backed transport retains its Pi process and raw deltas across backend session replacement',async context=> {
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-owner-adapter-'))),child=new FakeChild();context.after(()=>rm(root,{recursive:true,force:true}));child.onCommand=record=>child.defaults(record);
  const owner=await createPrimaryOwner({state:{root,instanceId:randomUUID()},spawnChild:child.spawn as typeof spawn});
  let first:PrimarySession|undefined,second:PrimarySession|undefined;const channels:ReturnType<typeof connect>[]=[];
  context.after(async()=>{child.exit(0);await first?.detach();await second?.detach();for(const channel of channels){channel.connection.close();channel.detach();}await owner.dispose();await rm(root,{recursive:true,force:true});});
  const primary={key:'primary',epoch:1,cwd:process.cwd(),executable:'pi',recoveryWorkspaceId:randomUUID()};
  const channel=connect(owner);channels.push(channel);
  first=new PrimarySession({...primary,transport:channel.connection.factory(primary),ownerIdentity:`${channel.connection.hello.ownerIncarnation}:primary:1`,publish:()=>{}});await first.start();
  const message={role:'assistant',timestamp:7,content:[],model:'fixture',provider:'fixture',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop'};
  child.event({type:'agent_start'});child.event({type:'message_start',message});child.event({type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}});child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'before'}});await settled();await settled();
  const id=first.messages[0]?.id;assert.ok(id);await first.prepareDetach();await first.detach();channel.detach();
  child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' between'}});await settled();
  const next=connect(owner);channels.push(next);const descriptor=next.connection.hello.primaries[0];assert.ok(descriptor);
  second=new PrimarySession({...primary,attach:true,transport:next.connection.factory(primary,descriptor),ownerIdentity:`${next.connection.hello.ownerIncarnation}:primary:1`,publish:()=>{}});await second.start();
  assert.equal(second.view.pid,123);assert.equal(second.messages[0]?.id,id);assert.match(JSON.stringify(second.messages[0]?.parts),/before between/);assert.ok(!child.writes.some(v=>v.type==='abort'||v.type==='clear_queue'));
  child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' after'}});await settled();await settled();assert.match(JSON.stringify(second.messages[0]?.parts),/before between after/);
});
test('retained command receipts reconcile read-only and prepared bytes keep the owner correlation identity',async context=> {
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-owner-receipt-'))),child=new FakeChild();context.after(()=>rm(root,{recursive:true,force:true}));child.onCommand=record=>child.defaults(record);
  const owner=await createPrimaryOwner({state:{root,instanceId:randomUUID()},spawnChild:child.spawn as typeof spawn}),channel=connect(owner);
  context.after(async()=>{child.exit(0);channel.connection.close();channel.detach();await owner.dispose();await rm(root,{recursive:true,force:true});});
  const primary={key:'primary',epoch:1,cwd:process.cwd(),executable:'pi',recoveryWorkspaceId:randomUUID()},transport=channel.connection.factory(primary)({});await transport.start();
  const id=randomUUID(),digest='a'.repeat(64);
  await withPrimaryOperation(id,digest,()=>transport.requestPrepared('prompt',async requestId=>{const line=`${JSON.stringify({type:'prompt',id:requestId,message:'fixture',images:[]})}\n`;return{line,bytes:Buffer.byteLength(line)};},()=>{}));
  const before=child.writes.length,outcome=await channel.connection.reconcile('primary',1,id,digest);assert.equal(outcome?.state,'accepted');assert.equal(outcome?.receipt?.kind,'rpc');assert.equal(child.writes.length,before);
  assert.equal(child.writes.find(v=>v.type==='prompt')?.message,'fixture');
});
