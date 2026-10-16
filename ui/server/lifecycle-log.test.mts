import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,stat,writeFile,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LifecycleLog,LIFECYCLE_BYTES,redactLifecycle} from './lifecycle-log.mts';

test('lifecycle text removes split-safe complete URLs and credentials before retention',()=> {
  const text=redactLifecycle('failure http://127.0.0.1:9/private Cookie=secret token: hidden');
  assert.equal(text.includes('private'),false);assert.equal(text.includes('secret'),false);assert.equal(text.includes('hidden'),false);
  assert.equal(redactLifecycle('x'.repeat(1000)).length,512);
});
test('lifecycle logging bounds records and bytes, drains writes, and reopens a valid private window',async context=> {
  const root=await mkdtemp(join(tmpdir(),'ui-lifecycle-'));context.after(()=>rm(root,{recursive:true,force:true}));
  let log=await LifecycleLog.open(root);
  for(let i=0;i<1000;i++) log.record('restart',`${i}: ${'x'.repeat(1000)} https://127.0.0.1:9/secret`);
  await log.close();const path=join(root,'lifecycle.log'),first=await readFile(path,'utf8');
  assert.ok(Buffer.byteLength(first)<=LIFECYCLE_BYTES);assert.ok(first.trim().split('\n').length<=128);assert.equal(first.includes('secret'),false);
  assert.ok(first.trim().split('\n').every(row=>JSON.parse(row).event==='restart'));assert.equal((await stat(path)).mode&0o077,0);
  log=await LifecycleLog.open(root);log.record('shutdown','Resources closed.');await log.close();
  const reopened=await readFile(path,'utf8');assert.ok(reopened.trim().split('\n').every(row=>JSON.parse(row).at));assert.match(reopened,/Resources closed/);
});
test('control rows retain lifecycle evidence within separate record and shared byte bounds',async context=> {
  const root=await mkdtemp(join(tmpdir(),'ui-lifecycle-control-')),log=await LifecycleLog.open(root),path=join(root,'lifecycle.log');
  context.after(async()=>{await log.close();await rm(root,{recursive:true,force:true});});
  log.record('fatal','Retained lifecycle evidence.');
  for(let i=0;i<99;i++)log.record('control',`control-${i}`);await log.control('control-99');
  const first=await readFile(path,'utf8'),rows=first.trim().split('\n').map(row=>JSON.parse(row));
  assert.equal(rows.filter(row=>row.event==='control').length,64);assert.ok(rows.some(row=>row.event==='fatal'&&row.detail==='Retained lifecycle evidence.'));
  assert.equal(rows.find(row=>row.event==='control')?.detail,'control-36');assert.ok(rows.length<=128);assert.ok(Buffer.byteLength(first)<=LIFECYCLE_BYTES);
  for(let i=0;i<200;i++)log.record('restart',`restart-${i}`);await log.control('settled');
  const total=(await readFile(path,'utf8')).trim().split('\n');assert.equal(total.length,128);
  for(let i=0;i<100;i++)log.record('control','雪'.repeat(512));await log.control('byte-bound');
  const final=await readFile(path,'utf8'),bounded=final.trim().split('\n').map(row=>JSON.parse(row));
  assert.ok(bounded.length<=128);assert.ok(bounded.filter(row=>row.event==='control').length<=64);assert.ok(Buffer.byteLength(final)<=LIFECYCLE_BYTES);
});

test('an oversized old log is replaced by a bounded window and hardlinks refuse admission',async context=> {
  const root=await mkdtemp(join(tmpdir(),'ui-lifecycle-'));context.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'lifecycle.log');await writeFile(path,'x'.repeat(LIFECYCLE_BYTES+1),{mode:0o600});
  const log=await LifecycleLog.open(root);await log.close();assert.ok((await stat(path)).size<=LIFECYCLE_BYTES);
  await link(path,join(root,'linked'));await assert.rejects(()=>LifecycleLog.open(root),/unavailable/);
});
