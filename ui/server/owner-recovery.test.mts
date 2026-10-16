import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {OwnerRecoveryStore} from './owner-recovery.mts';
import {OWNER_LIMITS,type OwnerPrimary} from '../shared/owner.ts';
const primary:OwnerPrimary={key:'primary',epoch:1,cwd:'/fixture',executable:'fake',recoveryWorkspaceId:'workspace'};
async function fixture(t:TestContext) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-owner-recovery-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const state={root,instanceId:'instance'};return {root,state,store:await OwnerRecoveryStore.open(state)};
}
test('recovery bytes survive reopen and an exact import acknowledgment removes only that record',async t=> {
  const {store,state}=await fixture(t);await store.reserve('owner',primary,{id:'clear',workspaceId:'workspace',pendingCount:1});
  const response={type:'response',id:'rpc',command:'clear_queue',success:true,data:{steering:['text'],followUp:[]}};
  await store.returned('clear',response);const reopened=await OwnerRecoveryStore.open(state);assert.deepEqual(reopened.list()[0]?.response,response);
  await reopened.ack('clear');assert.deepEqual((await OwnerRecoveryStore.open(state)).list(),[]);
});
test('existing queue recovery prevents another destructive clear reservation',async t=> {
  const {store}=await fixture(t);await store.reserve('owner',primary,{id:'clear',workspaceId:'workspace',pendingCount:1});
  await assert.rejects(store.reserve('owner',primary,{id:'clear',workspaceId:'workspace',pendingCount:1}),/Existing queue recovery/);
  await assert.rejects(store.reserve('owner',primary,{id:'other',workspaceId:'workspace',pendingCount:1}),/Existing queue recovery/);
});
test('foreign installation identity never imports saved queue data',async t=> {
  const {store,state}=await fixture(t);await store.reserve('owner',primary,{id:'clear',workspaceId:'workspace',pendingCount:0});
  await assert.rejects(OwnerRecoveryStore.open({...state,instanceId:'other'}),/identity differs/);
  assert.equal(store.list().length,1);
});
test('queue recovery reserves byte capacity before effect admission',async t=> {
  const {state}=await fixture(t);const store=await OwnerRecoveryStore.open(state,undefined,{...OWNER_LIMITS,recoveryBytes:1024});
  await assert.rejects(store.reserve('owner',primary,{id:'clear',workspaceId:'workspace',pendingCount:0}),/byte capacity/);assert.deepEqual(store.list(),[]);
});
test('invalid persisted metadata refuses instead of deleting a recovery record',async t=> {
  const {store,state}=await fixture(t);await store.reserve('owner',primary,{id:'clear',workspaceId:'workspace',pendingCount:0});
  const entries=await readdir(store.directory);const name=entries.find(value=>value.endsWith('.json'));assert.ok(name);const path=join(store.directory,name);
  const original=await readFile(path,'utf8');await writeFile(path,original.replace('"status":"reserved"','"status":"unknown"'));
  await assert.rejects(OwnerRecoveryStore.open(state),/record is invalid/);assert.ok((await readFile(path,'utf8')).includes('unknown'));
});
