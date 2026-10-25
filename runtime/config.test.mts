import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Configuration,validateRuntimeConfig,validatePiPreferences} from './config.mts';

test('configuration preserves unrelated machine sections and refuses stale writes',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'harness.json'),JSON.stringify({version:1,other:{keep:true},runtime:{port:4320}}));
  const config=new Configuration(root,root,{}),before=await config.inspect('runtime');
  const changed=await config.apply('runtime',{port:4322},before.digest);assert.equal(changed.activation,'next-runtime-start');
  assert.deepEqual(JSON.parse(await readFile(join(root,'harness.json'),'utf8')).other,{keep:true});
  await assert.rejects(config.apply('runtime',{port:4323},before.digest),/changed/);
  assert.throws(()=>validateRuntimeConfig({privateOrigin:'https://bad.example',privateOwnerLogin:'owner'}),/ts.net/);
  assert.throws(()=>validatePiPreferences({apiKey:'not-supported'}),/unsupported/);
});
test('malformed configuration remains inspectable without provider initialisation',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'harness.json'),'{broken');await writeFile(join(root,'settings.json'),'{broken');
  const config=new Configuration(root,root,{});assert.equal((await config.startup()).valid,false);assert.equal((await config.inspect('pi')).status,'invalid');
  const invalid=await config.inspect('runtime');assert.equal(invalid.status,'invalid');
  const repaired=await config.repair('runtime',{port:4322},invalid.digest);assert.equal(repaired.repaired,true);
  assert.equal(await readFile(join(root,'runtime','config-backups',`${repaired.backupId}.json`),'utf8'),'{broken');
  assert.equal((await config.startup()).valid,true);await assert.rejects(config.repair('runtime',{},(await config.inspect('runtime')).digest),/only a bounded invalid/);
});
test('Pi preference changes use public setters and never expose arbitrary settings',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'settings.json'),JSON.stringify({defaultModel:'before',unrelated:{keep:true},providerSecret:'not-exposed'}));
  const config=new Configuration(root,root,{}),before=await config.inspect('pi');assert.equal(JSON.stringify(before).includes('not-exposed'),false);
  await config.apply('pi',{defaultModel:'after',autoRetry:false},before.digest);
  const result=JSON.parse(await readFile(join(root,'settings.json'),'utf8'));assert.equal(result.defaultModel,'after');assert.deepEqual(result.unrelated,{keep:true});
});
