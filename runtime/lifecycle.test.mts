import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Lifecycle} from './lifecycle.mts';
import {launchAgentPlan} from './launchd.mts';
import {parseRuntimeArgs} from './cli.mts';

test('a relocated sealed CLI stages the selected development checkout through fixed argument arrays',async t=>{
  const temporary=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rl-')),development=await realpath(temporary);t.after(()=>rm(temporary,{recursive:true,force:true}));
  const calls:string[][]=[];
  const lifecycle=new Lifecycle({sourceRoot:'/sealed-source',uiStateDir:'/state/ui',agentDir:'/agent',cwd:development},async(executable,args)=>{calls.push([executable,...args]);return {exitCode:0,value:{state:'ready'},uncertain:false};});
  await lifecycle.release('stage');assert.deepEqual(calls[0].slice(1),['--experimental-vm-modules','/sealed-source/ui/cli/release.mts','stage','--state-dir','/state/ui','--source',development]);
  const id='a'.repeat(64);await lifecycle.release('switch',id);assert.equal(calls[1].at(-1),id);
  assert.deepEqual(await lifecycle.start(),{started:false,status:{state:'ready'}});
});
test('a lost lifecycle receipt is uncertain and does not retry',async()=>{
  let calls=0;const lifecycle=new Lifecycle({sourceRoot:'/source',uiStateDir:'/state/ui',agentDir:'/agent',cwd:'/project'},async()=>{calls++;return {exitCode:null,value:null,uncertain:true};});
  await assert.rejects(lifecycle.release('rollback'),error=>!!error&&typeof error==='object'&&'uncertain' in error&&error.uncertain===true);assert.equal(calls,1);
});
test('macOS service plan retains fixed source and restarts management without session replay',()=>{
  const plan=launchAgentPlan({sourceRoot:'/source',stateDir:'/state',agentDir:'/agent',cwd:'/project',uiStateDir:'/ui',path:'/usr/bin:/bin'});
  assert.match(plan.plist,/<key>KeepAlive<\/key><true\/>/);assert.match(plan.plist,/--restore-ui/);assert.equal(plan.arguments.some(value=>['bootstrap','follow_up','prompt'].includes(value)),false);
  const parsed=parseRuntimeArgs(['serve','--agent-dir','/agent','--state-dir','/state','--private-origin','https://machine.example.ts.net','--private-owner-login','owner@example.com']);assert.equal(parsed.options.network?.privateOrigin,'https://machine.example.ts.net');
});
