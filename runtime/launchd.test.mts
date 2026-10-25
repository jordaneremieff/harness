import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {launchAgentPlan} from './launchd.mts';
import {parseRuntimeArgs} from './cli.mts';

test('the exact LaunchAgent plist resolves selected tools with only its declared environment',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'launch-path-'));t.after(()=>rm(root,{recursive:true,force:true}));const bin=join(root,'selected &tools');await mkdir(bin);
  const tools=['pi','npm','git','node'];await Promise.all(tools.map(name=>writeFile(join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o700})));
  const existingSource={root:'/ordinary/root',sourceRoot:'/ordinary/source',packageDir:'/ordinary/dependencies'};
  const plan=launchAgentPlan({sourceRoot:'/sealed/source',stateDir:'/runtime/state',agentDir:'/agent',cwd:'/development',uiStateDir:'/ui',node:join(bin,'node'),path:bin,existingSource,port:4328,privatePort:4329,privateOrigin:'https://machine.example.ts.net',privateOwnerLogin:'owner@example.com'});
  const plist=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{input:plan.plist,encoding:'utf8',env:{},timeout:5000,maxBuffer:65536})) as {EnvironmentVariables:{PATH:string};ProgramArguments:string[];WorkingDirectory:string};
  assert.deepEqual(plist.EnvironmentVariables,plan.environment);assert.deepEqual(Object.keys(plist.EnvironmentVariables),['PATH']);assert.deepEqual(plist.ProgramArguments,plan.arguments);assert.equal(plist.WorkingDirectory,'/development');
  const resolved=execFileSync('/bin/sh',['-c','command -v pi; command -v npm; command -v git; command -v node'],{env:plist.EnvironmentVariables,cwd:bin,encoding:'utf8',timeout:5000,maxBuffer:8192}).trim().split('\n');
  assert.deepEqual(resolved,tools.map(name=>join(bin,name)));
  const restored=parseRuntimeArgs(plist.ProgramArguments.slice(2));assert.deepEqual(restored.options.existingSource,existingSource);assert.equal(restored.options.sourceRoot,'/sealed/source');
  assert.deepEqual(restored.options.network,{port:4328,privatePort:4329,privateOrigin:'https://machine.example.ts.net',privateOwnerLogin:'owner@example.com'});
});
test('service PATH selection is setup-only and rejects ambient working-directory lookup',()=>{
  const options={sourceRoot:'/source',stateDir:'/runtime',agentDir:'/agent',cwd:'/development',uiStateDir:'/ui'};
  for(const path of ['/usr/bin::/bin','relative:/bin','/usr/bin\n:/bin'])assert.throws(()=>launchAgentPlan({...options,path}),/absolute directory/);
  const selected=parseRuntimeArgs(['service-plan','--path','/usr/bin:/bin']);assert.equal(selected.servicePath,'/usr/bin:/bin');
  const plan=launchAgentPlan({...options,path:selected.servicePath});assert.equal(plan.environment.PATH.split(':')[0],dirname(process.execPath));
  assert.throws(()=>parseRuntimeArgs(['serve','--path','/usr/bin']),/only a service-plan/);
});
