import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Configuration,validateRuntimeConfig,validatePiPreferences} from './config.mts';
import {ManagementService} from './service.mts';
import {RUNTIME_PROTOCOL} from './contract.mts';

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
test('invalid runtime envelopes permit only explicit backed-up replacement',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=new Configuration(root,root,{}),path=join(root,'harness.json');
  for(const version of [undefined,'1',2,0,null]) {
    const original=Buffer.from(`${JSON.stringify({version,runtime:{port:4320},other:{keep:true}})}\n`);
    await writeFile(path,original);
    const before=await config.inspect('runtime');assert.equal(before.status,'invalid');assert.equal(before.values,null);
    assert.equal((await config.startup()).valid,false);
    await assert.rejects(config.apply('runtime',{port:4322},before.digest),/envelope is invalid/);
    const repaired=await config.repair('runtime',{port:4322},before.digest);
    assert.equal(repaired.snapshot.status,'valid');assert.match(repaired.scope,/replaced, not migrated/);
    assert.ok(repaired.scope.includes(`${repaired.backupId}.json`));
    assert.equal(Buffer.compare(await readFile(join(root,'runtime','config-backups',`${repaired.backupId}.json`)),original),0);
    const replacement=JSON.parse(await readFile(path,'utf8'));
    assert.equal(replacement.version,1);assert.equal(replacement.runtime.port,4322);assert.equal(replacement.other,undefined);
  }
});
test('invalid runtime fields in a valid envelope use field changes and preserve sibling settings',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'harness.json'),JSON.stringify({version:1,runtime:{port:'bad'},other:{keep:true}}));
  const config=new Configuration(root,root,{}),before=await config.inspect('runtime');assert.equal(before.status,'invalid');
  await assert.rejects(config.repair('runtime',{port:4322},before.digest),/valid envelope/);
  await config.apply('runtime',{port:4322},before.digest);
  const result=JSON.parse(await readFile(join(root,'harness.json'),'utf8'));
  assert.equal(result.runtime.port,4322);assert.equal(result.other.keep,true);
});
test('repair preserves stale-digest, size, file-type and original-byte restrictions',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=new Configuration(root,root,{}),path=join(root,'harness.json');
  await writeFile(path,'{}');const stale=await config.inspect('runtime');await writeFile(path,'{"version":"bad"}');
  await assert.rejects(config.repair('runtime',{},stale.digest),/changed/);
  await assert.rejects(readFile(join(root,'runtime','config-backups',`runtime-${stale.digest}.json`)),{code:'ENOENT'});
  const original=Buffer.from([0xff,0xfe,0x00,0x7b]);await writeFile(path,original);
  const invalid=await config.inspect('runtime'),repaired=await config.repair('runtime',{},invalid.digest);
  assert.equal(Buffer.compare(await readFile(join(root,'runtime','config-backups',`${repaired.backupId}.json`)),original),0);
  await writeFile(path,'x'.repeat(131073));const oversized=await config.inspect('runtime');
  assert.equal(oversized.status,'invalid');await assert.rejects(config.repair('runtime',{},oversized.digest),/bounded invalid/);
  assert.equal((await readFile(path)).length,131073);
  const directory=new Configuration(root,root,{PI_HARNESS_FILE:root});
  await assert.rejects(directory.inspect('runtime'),/unavailable/);
  await assert.rejects(directory.repair('runtime',{},'missing'),/unavailable/);
  const absent=new Configuration(root,root,{PI_HARNESS_FILE:'absent.json'});
  await assert.rejects(absent.repair('runtime',{},'missing'),/bounded invalid/);
});
test('management admission requires confirmation before destructive envelope replacement',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const original='{"version":2,"other":{"keep":true}}';await writeFile(join(root,'harness.json'),original);
  const service=new ManagementService({agentDir:root,stateDir:join(root,'state'),cwd:root,sourceRoot:root,uiStateDir:join(root,'ui'),env:{}});t.after(()=>service.close());
  const inspect=await service.call({protocol:RUNTIME_PROTOCOL,request:{operation:'config.inspect',target:'runtime'}});assert.equal(inspect.ok,true);
  const before=(inspect as {ok:true;value:{digest:string;status:string}}).value;assert.equal(before.status,'invalid');
  const request={operation:'config.repair',target:'runtime',values:{port:4322},expectedDigest:before.digest};
  const unconfirmed=await service.call({protocol:RUNTIME_PROTOCOL,request});
  assert.equal(unconfirmed.ok,false);if(!unconfirmed.ok)assert.equal(unconfirmed.error.code,'invalid_request');
  assert.equal(await readFile(join(root,'harness.json'),'utf8'),original);
  const confirmed=await service.call({protocol:RUNTIME_PROTOCOL,request:{...request,confirm:true}});assert.equal(confirmed.ok,true);
  const result=(confirmed as {ok:true;value:{backupId:string;scope:string}}).value;
  assert.match(result.scope,/replaced, not migrated/);
  assert.equal(await readFile(join(root,'runtime','config-backups',`${result.backupId}.json`),'utf8'),original);
});
test('Pi preference changes use public setters and never expose arbitrary settings',async t=>{
  const root=await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rc-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'settings.json'),JSON.stringify({defaultModel:'before',unrelated:{keep:true},providerSecret:'not-exposed'}));
  const config=new Configuration(root,root,{}),before=await config.inspect('pi');assert.equal(JSON.stringify(before).includes('not-exposed'),false);
  await config.apply('pi',{defaultModel:'after',autoRetry:false},before.digest);
  const result=JSON.parse(await readFile(join(root,'settings.json'),'utf8'));assert.equal(result.defaultModel,'after');assert.deepEqual(result.unrelated,{keep:true});
});
