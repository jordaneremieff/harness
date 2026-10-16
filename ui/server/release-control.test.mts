import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertControlPath,listenReleaseControl,requestReleaseControl} from './release-control.mts';
import {parseReleaseArgs} from '../cli/release.mts';
test('private release control admits only closed actions and retains selected root isolation',async context=> {
  const root=await mkdtemp(join(tmpdir(),'uir-')),path=join(root,'control.sock');let closed=false;
  const calls:unknown[]=[];const control=await listenReleaseControl(path,async request=>{calls.push(request);return {state:'ready'};});context.after(async()=>{if(!closed)await control.close();await rm(root,{recursive:true,force:true});});
  assert.equal((await stat(path)).mode&0o077,0);
  assert.deepEqual(await requestReleaseControl(path,{kind:'status'}),{state:'ready'});
  await assert.rejects(()=>requestReleaseControl(path,{kind:'execute',command:'forbidden'} as never),/Invalid/);
  assert.deepEqual(calls,[{kind:'status'}]);await control.close();closed=true;
});
test('release CLI retains existing launch surface and explicit selected-root flags',()=> {
  const args=parseReleaseArgs(['switch','--state-dir','/private/state','--release','a'.repeat(64)]);
  assert.equal(args.stateDir,'/private/state');assert.equal(args.release,'a'.repeat(64));
  assert.throws(()=>parseReleaseArgs(['switch']));assert.throws(()=>parseReleaseArgs(['status','--release','a'.repeat(64)]));assert.throws(()=>parseReleaseArgs(['stage','--command','x']));
  assert.throws(()=>assertControlPath(`/${'x'.repeat(103)}`),/path length/);
});
