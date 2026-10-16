import assert from 'node:assert/strict';
import test from 'node:test';
import type {spawn} from 'node:child_process';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createPrimaryOwner} from './primary-owner.mts';
import {OwnerConnection} from './owner-client.mts';
import type {OwnerDescriptor} from '../shared/owner.ts';
import {connectTestOwner,ownerTurn} from './owner-test-fixture.mts';
import {PrimarySession} from '../rpc/session.mts';
import {FakeChild} from '../rpc/fake-child.mts';
import {RpcError} from '../rpc/client.mts';
import type {ReleaseManifest} from '../shared/release.ts';
const message={role:'assistant',timestamp:7,content:[],model:'fixture',provider:'fixture',stopReason:'stop'};
async function fixture(context:test.TestContext,create=createPrimaryOwner,Wire?:Parameters<typeof connectTestOwner>[1],backend?:{Session:typeof PrimarySession;Connection:typeof OwnerConnection}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-owner-recover-'))),child=new FakeChild();child.onCommand=record=>child.defaults(record);
  const owner=await create({state:{root,instanceId:randomUUID()},spawnChild:child.spawn as typeof spawn}),channel=connectTestOwner(owner,Wire,backend?.Connection);
  const primary={key:'primary',epoch:1,cwd:root,executable:'unused',recoveryWorkspaceId:randomUUID()},session=new (backend?.Session??PrimarySession)({...primary,transport:channel.connection.factory(primary),ownerIdentity:`${owner.incarnation}:primary:1`,publish:()=>{},onBeforeClearQueue:async()=>{throw new RpcError('not_ready','Fixture queue storage is unavailable.');},onRecoveredQueue:async()=>{},onQueueClearFailed:async()=>{}});
  context.after(async()=>{child.exit(0);await session.detach();channel.connection.close();channel.detach();await owner.dispose();await rm(root,{recursive:true,force:true});});
  await session.start();return{root,child,owner,channel,session};
}
test('verified native refresh clears the owner protocol latch before prompt and complete capture',async context=>{
  const {child,session}=await fixture(context);child.event({type:'response',id:'unknown',command:'get_state',success:true,data:{}});await ownerTurn();await ownerTurn();
  assert.equal(session.client.synchronized,false);await assert.rejects(()=>session.input('not yet','prompt'),{code:'protocol_error'});
  const before=child.writes.filter(record=>record.type==='get_available_models').length;await session.resynchronize();
  assert.equal(session.client.synchronized,true);assert.equal(child.writes.filter(record=>record.type==='get_available_models').length,before+1);
  await session.input('after refresh','prompt');await session.prepareDetach();
});
test('one drain notice across a refused Stop recaptures the lost live suffix and resumes records',async context=>{
  const {child,channel,session}=await fixture(context);child.event({type:'message_start',message});child.event({type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}});child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'before'}});await ownerTurn();
  child.event({type:'extension_ui_request',id:'confirm',method:'confirm',title:'Fixture'});await ownerTurn();
  const id=session.messages[0]?.id,reads=child.writes.filter(record=>record.type==='get_state').length;channel.parent.hold=true;assert.equal(channel.wire.send({kind:'padding',data:'x'.repeat(9*1024*1024)}),true);
  child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' missing'}});await ownerTurn();assert.doesNotMatch(JSON.stringify(session.messages),/missing/);
  child.blocked=true;const stopped=assert.rejects(()=>session.stop(),{code:'not_ready'});await child.command('extension_ui_response');
  channel.parent.drain();await ownerTurn();child.blocked=false;child.release?.();await stopped;await ownerTurn();await ownerTurn();assert.equal(session.client.synchronized,true);assert.equal(session.messages[0]?.id,id);assert.match(JSON.stringify(session.messages[0]?.parts),/before missing/);
  child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' after'}});await ownerTurn();assert.match(JSON.stringify(session.messages[0]?.parts),/before missing after/);assert.equal(child.writes.filter(record=>record.type==='get_state').length,reads+2);
  assert.equal(child.writes.some(record=>['abort','clear_queue','new_session'].includes(record.type)),false);
});
async function replacement(context:test.TestContext,owner:Parameters<typeof connectTestOwner>[0],Wire:Parameters<typeof connectTestOwner>[1],Session=PrimarySession,Connection=OwnerConnection){
  const channel=connectTestOwner(owner,Wire,Connection),descriptor=channel.connection.hello.primaries[0] as OwnerDescriptor;
  const session=new Session({...descriptor,attach:true,transport:channel.connection.factory(descriptor,descriptor),ownerIdentity:`${channel.connection.hello.ownerIncarnation}:primary:1`,publish:()=>{}});
  context.after(async()=>{await session.detach();channel.connection.close();channel.detach();});await session.start();
  return{session,leave:async()=>{await session.prepareDetach();await session.detach();channel.connection.close();channel.detach();}};
}
test('the current backend runs with an actual sealed owner and exposes its unsupported recovery',{skip:!process.env.UI_TEST_OLD_RELEASE},async context=>{
  const root=process.env.UI_TEST_OLD_RELEASE as string,manifest=JSON.parse(await readFile(join(root,'release.json'),'utf8')) as ReleaseManifest;
  assert.equal(manifest.sourceCommit,'851e599d8a243abf2cdadd1f1e9c05939600c6f0');
  for(const path of ['ui/server/primary-owner.mts','ui/server/owner-records.mts','ui/server/owner-recovery.mts','ui/server/owner-decode-worker.mts','ui/server/owner-wire.mts','ui/shared/owner.ts','ui/server/owner-client.mts','ui/rpc/session.mts'])assert.equal(createHash('sha256').update(await readFile(join(root,path))).digest('hex'),manifest.files[path]);
  const old=await import(pathToFileURL(join(root,'ui/server/primary-owner.mts')).href),wire=await import(pathToFileURL(join(root,'ui/server/owner-wire.mts')).href),oldSession=await import(pathToFileURL(join(root,'ui/rpc/session.mts')).href),oldClient=await import(pathToFileURL(join(root,'ui/server/owner-client.mts')).href);
  const {child,owner,channel,session}=await fixture(context,old.createPrimaryOwner,wire.OwnerWire,{Session:oldSession.PrimarySession,Connection:oldClient.OwnerConnection});assert.equal(channel.connection.hello.capabilities,undefined);
  child.event({type:'message_start',message});child.event({type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}});child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'old'}});await ownerTurn();const id=session.messages[0]?.id;
  await session.prepareDetach();await session.detach();channel.connection.close();channel.detach();
  const updated=await replacement(context,owner,wire.OwnerWire);assert.equal(updated.session.view.pid,123);assert.equal(updated.session.messages[0]?.id,id);await updated.session.input('healthy old owner','prompt');await updated.session.resynchronize();assert.equal(updated.session.client.synchronized,true);
  child.event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:' new'}});await ownerTurn();await updated.leave();
  const rollback=await replacement(context,owner,wire.OwnerWire,oldSession.PrimarySession,oldClient.OwnerConnection);assert.equal(rollback.session.messages[0]?.id,id);assert.match(JSON.stringify(rollback.session.messages[0]?.parts),/old new/);await rollback.leave();
  const final=await replacement(context,owner,wire.OwnerWire);child.event({type:'response',id:'unknown-old',command:'get_state',success:true,data:{}});await ownerTurn();await ownerTurn();
  await assert.rejects(()=>final.session.resynchronize(),{code:'unsupported'});assert.equal(final.session.client.synchronized,false);assert.equal(owner.descriptors()[0]?.synchronized,false);assert.equal(child.writes.some(record=>['abort','clear_queue','new_session'].includes(record.type)),false);
});
