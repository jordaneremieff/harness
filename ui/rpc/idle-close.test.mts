import assert from 'node:assert/strict';
import {access,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {FakeChild} from './fake-child.mts';
import {PrimarySession,type PrimarySessionOptions} from './session.mts';
import type {RpcRecord} from './client.mts';
const settled=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(t:TestContext,options:Partial<PrimarySessionOptions>={}) {
  const child=new FakeChild();child.onCommand=record=>child.defaults(record);
  const session=new PrimarySession({key:'primary',executable:'pi',cwd:process.cwd(),spawnChild:child.spawn,publish:()=>{},shutdownTimeoutMs:20,...options});
  t.after(()=>{if(!session.client.exited)child.exit(0);});
  await session.start();await settled();return {child,session};
}
test('idle close accepts an unsaved primary and sends no abort or queue clear',async t=>{
  const {child,session}=await fixture(t);assert.equal(session.view.sessionFile,undefined);
  await session.close(1);assert.equal(session.client.exited,true);assert.equal(session.view.lifecycle,'stopped');
  assert.equal(child.writes.some(record=>['abort','clear_queue'].includes(record.type)),false);
});
test('idle close accepts the planned session path before its JSONL exists',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ui-unsaved-close-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {child,session}=await fixture(t);child.sessionFile=join(root,'not-created.jsonl');await session.refreshState();
  await session.close(1);assert.equal(session.view.lifecycle,'stopped');await assert.rejects(access(child.sessionFile),{code:'ENOENT'});
});
test('idle close keeps an existing saved session file unchanged',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ui-idle-close-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'session.jsonl'),content='retained session bytes\n';await writeFile(path,content);
  const {child,session}=await fixture(t);child.sessionFile=path;await session.refreshState();
  await session.close(1);assert.equal(await readFile(path,'utf8'),content);
});
test('idle close refuses stale epochs, active work, dialogs and pending commands without EOF',async t=>{
  const {child,session}=await fixture(t);
  await assert.rejects(session.close(2),{code:'stale_epoch'});
  for(const activity of ['running','compacting','retrying','unknown'] as const){session.view.activity=activity;await assert.rejects(session.close(1),{code:'not_ready'});}
  session.view.activity='idle';session.view.pendingDialogs=[{id:'dialog',method:'confirm',title:'Keep open'}];
  await assert.rejects(session.close(1),{code:'not_ready'});session.view.pendingDialogs=[];
  let held:RpcRecord|undefined;child.onCommand=record=>{held=record;};const pending=session.client.request('get_state');await settled();
  await assert.rejects(session.close(1),{code:'not_ready'});assert.ok(held);child.defaults(held);await pending;
  assert.equal(child.stdin.writableEnded,false);assert.equal(session.view.lifecycle,'ready');
});
test('idle close refuses a native queue and restores admission without losing queued text',async t=>{
  const {child,session}=await fixture(t);child.pendingMessageCount=2;
  await assert.rejects(session.close(1),{code:'not_ready'});
  assert.equal(child.pendingMessageCount,2);assert.equal(child.stdin.writableEnded,false);
  child.onCommand=record=>child.defaults(record);assert.deepEqual(await session.input('still open','prompt'),{disposition:'handled'});
  assert.equal(child.writes.some(record=>['abort','clear_queue'].includes(record.type)),false);
  child.pendingMessageCount=0;await session.close(1);assert.equal(session.client.exited,true);
});
test('idle close refuses unresolved queue recovery and keeps its text',async t=>{
  const {child,session}=await fixture(t,{onBeforeClearQueue:async()=> 'clear',onRecoveredQueue:async()=>{throw new Error('Store unavailable');},onQueueClearFailed:async()=>{}});
  child.pendingMessageCount=1;child.onCommand=record=>record.type==='clear_queue'?child.response(record,{steering:['keep queued text'],followUp:[]}):child.defaults(record);
  await assert.rejects(session.stop(),/Store unavailable/);assert.equal(session.queueRecoveryPending,true);
  const before=child.writes.length;await assert.rejects(session.close(1),{code:'not_ready'});
  assert.deepEqual(session.recoveredQueue,{steering:['keep queued text'],followUp:[]});assert.equal(child.writes.length,before);assert.equal(child.stdin.writableEnded,false);
});
test('idle close rechecks state, epoch, lifecycle and dialog races while it freezes new input',async t=>{
  for(const race of ['stream','queue','epoch','lifecycle','dialog'] as const){
    const {child,session}=await fixture(t);let held:RpcRecord|undefined;child.onCommand=record=>{held=record;};
    const result=session.close(1);const rejected=assert.rejects(result,{code:race==='epoch'?'stale_epoch':'not_ready'});await settled();assert.ok(held);
    await assert.rejects(session.input('too late','prompt'),{code:'not_ready'});
    if(race==='epoch')session.view.epoch++;
    if(race==='lifecycle')session.view.lifecycle='switching';
    if(race==='dialog')session.view.pendingDialogs=[{id:'late',method:'confirm',title:'Keep open'}];
    child.response(held,{isStreaming:race==='stream',isCompacting:false,pendingMessageCount:race==='queue'?1:0});await rejected;
    assert.equal(child.stdin.writableEnded,false);assert.equal(child.writes.some(record=>['abort','clear_queue'].includes(record.type)),false);
  }
});
test('idle close keeps ownership until the actual child exit',async t=>{
  const {child,session}=await fixture(t);child.autoExit=false;
  const result=session.close(1);await settled();assert.equal(child.stdin.writableEnded,true);
  assert.equal(session.client.exited,false);assert.equal(session.view.lifecycle,'stopping');
  child.exit(0);await result;assert.equal(session.client.exited,true);assert.equal(session.view.lifecycle,'stopped');
});
