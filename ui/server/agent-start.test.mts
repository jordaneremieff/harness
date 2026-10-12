import assert from 'node:assert/strict';
import { ChildProcess, spawn, type ChildProcess as OwnedChild } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { deriveEndpoint, type CatalogRecord } from '../agents/catalog-record.mts';
import { descriptor } from '../agents/fake-host.mts';
import { StoredAgentStarter, startBinding, startIdentity } from './agent-start.mts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(process.cwd(),'ui-start-fixture-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store = join(root,'store'); const durable = join(store,'durable'); const cwd = join(root,'project'); const agentDir = join(root,'agent');
  await Promise.all([mkdir(durable,{recursive:true}),mkdir(cwd),mkdir(agentDir)]);
  const owner = join(root,'configured-owner'); const ownerSlice=join(owner,'extensions','agent'); const packageDir=join(root,'installation'); const executable=join(packageDir,'dist','bundle','cli.js');
  await Promise.all([mkdir(ownerSlice,{recursive:true}),mkdir(dirname(executable),{recursive:true})]);
  await Promise.all([writeFile(join(owner,'package.json'),JSON.stringify({name:'harness',pi:{extensions:['./extensions']}})),writeFile(join(ownerSlice,'index.ts'),'// inert configured entry'),writeFile(join(ownerSlice,'durable-runner.ts'),'// inert configured runner'),writeFile(join(agentDir,'settings.json'),JSON.stringify({extensions:[join(ownerSlice,'index.ts')]})),writeFile(join(packageDir,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.1.0',bin:{pi:'dist/bundle/cli.js'}})),writeFile(executable,'#!/usr/bin/env node\n// inert installation CLI',{mode:0o700})]);
  const record: CatalogRecord = {storageId:'stored',cwd,agentDir,packageDir:'/not/a/trusted/package',storagePath:join(durable,'stored.sqlite'),model:{provider:'fixture',modelId:'inert'},thinkingLevel:'off',trust:false,createdAt:new Date().toISOString(),recoveryDue:true};
  await writeFile(record.storagePath,'inert copied storage');
  const save = ()=>writeFile(join(durable,'stored.json'),JSON.stringify(record)); await save();
  const endpoint = deriveEndpoint(record); const contract = await descriptor();
  const claim = async (pid=process.pid,host=hostname()) => {
    await mkdir(dirname(endpoint.claimPath),{recursive:true});
    await writeFile(endpoint.claimPath,JSON.stringify({sessionId:record.storageId,cwd,host,createdAt:new Date().toISOString(),pid}));
  };
  const children: ChildProcess[] = []; const launches: {command:string;args:string[];options:unknown}[] = [];
  let onSpawn = async (_child: ChildProcess) => {};
  const fakeSpawn = ((command:string,args:string[],options:unknown)=> {
    launches.push({command,args,options});
    const child = Object.assign(new ChildProcess(),{pid:process.pid,stdout:new PassThrough(),stderr:new PassThrough()});
    t.mock.method(child,'kill',()=>{throw new Error('A start must never signal a process');});
    children.push(child); queueMicrotask(()=>{void onSpawn(child);}); return child;
  });
  const ready = (child:ChildProcess,patch:Record<string,unknown>={}) => child.stdout?.emit('data',Buffer.from(`PI_AGENT_HOST_READY ${JSON.stringify({pid:child.pid,socketPath:endpoint.socketPath,contract,...patch})}\n`));
  const starter = new StoredAgentStarter({store,executable,agentDir,spawn:fakeSpawn,timeoutMs:100});
  return {root,record,save,store,executable,agentDir,ownerSlice,packageDir,endpoint,claim,children,launches,ready,starter,setSpawn(fn:typeof onSpawn){onSpawn=fn;}};
}
test('start accepts only exact canonical storage and conversation identities',()=> {
  for(const id of ['stored','stored:2','stored:9007199254740991']) assert.equal(startIdentity(id),'stored');
  for(const id of ['','..','../escape','a/b','a\\b','stored:1','stored:0','stored:02','stored:2:3','stored:9007199254740992','stored:','stored\n','stored name']) assert.throws(()=>startIdentity(id),{code:'invalid_request'});
});
test('catalog identity and database path validation prevents launch',async t=> {
  const f = await fixture(t); f.record.storagePath = join(f.root,'other.sqlite'); await f.save();
  await assert.rejects(f.starter.start('stored'),{code:'invalid_request'}); assert.equal(f.launches.length,0);
});
test('canonical project path and existing regular database are required',async t=> {
  const f = await fixture(t); f.record.cwd += '/.'; await f.save();
  await assert.rejects(f.starter.start('stored'),{code:'invalid_request'});
  f.record.cwd = join(f.root,'project'); await f.save(); await rm(f.record.storagePath);
  await assert.rejects(f.starter.start('stored'),{code:'invalid_request'}); assert.equal(f.launches.length,0);
});
test('binding selects the configured owner source and explicit CLI installation, not the UI package',async t=> {
  const f=await fixture(t);const binding=await startBinding({executable:f.executable,agentDir:f.agentDir});
  assert.deepEqual(binding,{runner:join(f.ownerSlice,'durable-runner.ts'),packageDir:f.packageDir});
});
test('a local package entry resolves relative to the global agent directory',async t=> {
  const f=await fixture(t);await writeFile(join(f.agentDir,'settings.json'),JSON.stringify({packages:['../configured-owner/extensions/agent/index.ts']}));
  assert.deepEqual(await startBinding({executable:f.executable,agentDir:f.agentDir}),{runner:join(f.ownerSlice,'durable-runner.ts'),packageDir:f.packageDir});
});
test('managed executable resolution follows a bounded version marker and verifies the installed manifest',async t=> {
  const f=await fixture(t);const managed=join(f.root,'managed');const wrapper=join(managed,'bin','pi');const install=join(managed,'install');const packageDir=join(install,'releases','1.1.0','node_modules','@earendil-works','pi-coding-agent');
  await Promise.all([mkdir(dirname(wrapper),{recursive:true}),mkdir(join(packageDir,'dist','bundle'),{recursive:true})]);
  await Promise.all([writeFile(wrapper,'#!/bin/sh\n# inert managed launcher',{mode:0o700}),writeFile(join(install,'current-version'),'1.1.0\n'),writeFile(join(packageDir,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.1.0',bin:{pi:'dist/bundle/cli.js'}})),writeFile(join(packageDir,'dist','bundle','cli.js'),'// inert CLI')]);
  assert.equal((await startBinding({executable:wrapper,agentDir:f.agentDir})).packageDir,packageDir);
  for(const marker of ['../escape','', 'x'.repeat(257)]) {await writeFile(join(install,'current-version'),marker);await assert.rejects(startBinding({executable:wrapper,agentDir:f.agentDir}),{code:'not_ready'});}
});
for(const kind of ['missing-settings','ambiguous-entry','missing-runner','wrong-owner-package','wrong-installation','unknown-executable'] as const) test(`${kind} binding fails closed before spawn`,async t=> {
  const f=await fixture(t);
  if(kind==='missing-settings')await rm(join(f.agentDir,'settings.json'));
  if(kind==='ambiguous-entry')await writeFile(join(f.agentDir,'settings.json'),JSON.stringify({extensions:[join(f.ownerSlice,'index.ts'),join(f.ownerSlice,'index.ts')]}));
  if(kind==='missing-runner')await rm(join(f.ownerSlice,'durable-runner.ts'));
  if(kind==='wrong-owner-package')await writeFile(join(f.ownerSlice,'..','..','package.json'),'{}');
  if(kind==='wrong-installation')await writeFile(join(f.packageDir,'package.json'),JSON.stringify({name:'wrong',version:'1.1.0',bin:{pi:'dist/bundle/cli.js'}}));
  if(kind==='unknown-executable'){await writeFile(f.executable,'// inert');await writeFile(join(f.packageDir,'package.json'),'{}');}
  await assert.rejects(f.starter.start('stored'),{code:'not_ready'});assert.equal(f.launches.length,0);
});
test('stored owner and independent trust are preserved while catalog threads and projections are omitted',async t=> {
  const f=await fixture(t);delete f.record.trust;f.record.ownerId='retained-owner';f.record.independent={inputDigest:'a'.repeat(64),projectTrusted:false};f.record.name='retained name';
  await writeFile(join(f.store,'durable','stored.json'),JSON.stringify({...f.record,threads:{unrelated:'catalog-only'}}));
  f.setSpawn(async child=>{await f.claim();f.ready(child);});await f.starter.start('stored');
  const input=JSON.parse(f.launches[0].args[1]);assert.equal(Object.hasOwn(input,'trust'),false);assert.equal(input.ownerId,'retained-owner');assert.deepEqual(input.independent,f.record.independent);assert.equal(input.threads,undefined);assert.equal(input.name,'retained name');
});
test('unsupported catalog metadata fields never cross the runner boundary',async t=> {
  const f=await fixture(t);await writeFile(join(f.store,'durable','stored.json'),JSON.stringify({...f.record,runner:'/browser-controlled'}));
  await assert.rejects(f.starter.start('stored'),{code:'invalid_request'});assert.equal(f.launches.length,0);
});
test('split readiness waits for a complete line and current operation contracts',async t=> {
  const f=await fixture(t);const contract=await descriptor();f.setSpawn(async child=> {
    await f.claim();const line=Buffer.from(`PI_AGENT_HOST_READY ${JSON.stringify({pid:child.pid,socketPath:f.endpoint.socketPath,contract})}\n`);
    child.stdout?.emit('data',line.subarray(0,7));child.stdout?.emit('data',line.subarray(7,line.length-1));child.stdout?.emit('data',line.subarray(line.length-1));
  });await f.starter.start('stored');assert.equal(f.launches.length,1);
});
for(const partial of ['truncated','no-newline'] as const)test(`${partial} readiness remains uncertain and late output never relaunches`,async t=> {
  const f=await fixture(t);const contract=await descriptor();f.setSpawn(async child=>{child.stdout?.emit('data',Buffer.from(partial==='truncated'?'PI_AGENT_HOST_READY {':`PI_AGENT_HOST_READY ${JSON.stringify({pid:child.pid,socketPath:f.endpoint.socketPath,contract})}`));});
  await assert.rejects(f.starter.start('stored'),{code:'not_ready'});f.ready(f.children[0]);await assert.rejects(f.starter.start('stored'),{code:'not_ready'});assert.equal(f.launches.length,1);
});
test('storage launch capacity refuses rather than evicting uncertain attempts',async t=> {
  const f=await fixture(t);const identities=Array.from({length:33},(_,i)=>`capacity-${i}`);
  await Promise.all(identities.map(async storageId=>{const record={...f.record,storageId,storagePath:join(f.store,'durable',`${storageId}.sqlite`)};await writeFile(record.storagePath,'inert');await writeFile(join(f.store,'durable',`${storageId}.json`),JSON.stringify(record));}));
  const outcomes=await Promise.allSettled(identities.map(identity=>f.starter.start(identity)));
  assert.equal(f.launches.length,32);assert.equal(outcomes.filter(outcome=>outcome.status==='rejected' && outcome.reason.code==='capacity').length,1);
  const retained=identities[outcomes.findIndex(outcome=>outcome.status==='rejected' && outcome.reason.code==='not_ready')];
  await assert.rejects(f.starter.start(retained),{code:'not_ready'});assert.equal(f.launches.length,32);
});

test('readiness pipe loss after a live claim preserves the host and reports uncertainty',async t=> {
  const f=await fixture(t);f.setSpawn(async child=>{await f.claim();child.stdout?.emit('error',new Error('inert pipe loss'));});
  await assert.rejects(f.starter.start('stored'),{code:'not_ready'});assert.equal(f.launches.length,1);
  await f.starter.start('stored');assert.equal(f.launches.length,1);
});

test('live ownership attaches without any spawn',async t=> {
  const f = await fixture(t); await f.claim(); await f.starter.start('stored:2'); assert.equal(f.launches.length,0);
});
test('unknown foreign and malformed claims refuse acquisition',async t=> {
  const f = await fixture(t); await f.claim(process.pid,'other-host');
  await assert.rejects(f.starter.start('stored'),{code:'not_ready'});
  await writeFile(f.endpoint.claimPath,'{}'); await assert.rejects(f.starter.start('stored'),{code:'not_ready'}); assert.equal(f.launches.length,0);
});
for(const initial of ['absent','dead'] as const) test(`${initial} ownership starts one trusted runner with current installation metadata`,async t=> {
  const f = await fixture(t); if(initial==='dead') await f.claim(2147483647);
  f.setSpawn(async child=>{await f.claim(); f.ready(child);});
  await f.starter.start('stored:2'); const binding = await startBinding({executable:f.executable,agentDir:f.agentDir}); const launch = f.launches[0];
  assert.equal(f.launches.length,1); assert.equal(launch.command,process.execPath); assert.equal(launch.args[0],binding.runner);
  const input = JSON.parse(launch.args[1]); assert.equal(input.packageDir,binding.packageDir); assert.equal(input.trust,false);
  assert.equal(input.storageId,'stored'); assert.equal(input.storagePath,f.record.storagePath); assert.equal(input.recoveryDue,undefined); assert.equal(input.createdAt,undefined); assert.equal(input.view,undefined);
  assert.deepEqual(Object.keys(input).sort(),['agentDir','cwd','model','packageDir','storageId','storagePath','thinkingLevel','trust'].sort());
});
test('concurrent conversations and repeated starts share one storage launch',async t=> {
  const f = await fixture(t); f.setSpawn(async child=>{await f.claim(); f.ready(child);});
  await Promise.all([f.starter.start('stored'),f.starter.start('stored:2'),f.starter.start('stored')]);
  await f.starter.start('stored'); assert.equal(f.launches.length,1);
});
test('a competing live claim remains authoritative after losing runner exits',async t=> {
  const f = await fixture(t); f.setSpawn(async child=>{await f.claim(); child.emit('exit',1,null);});
  // A fake losing PID differs from the live owner and is never signaled.
  f.setSpawn(async child=>{Object.assign(child,{pid:2147483646});await f.claim();child.emit('exit',1,null);});
  await f.starter.start('stored'); assert.equal(f.launches.length,1);
});
for(const kind of ['malformed','socket','pid','contract','output'] as const) test(`${kind} readiness refuses without stopping an admitted host`,async t=> {
  const f = await fixture(t); f.setSpawn(async child=> {
    await f.claim();
    if(kind==='malformed') child.stdout?.emit('data',Buffer.from('PI_AGENT_HOST_READY {bad}\n'));
    else if(kind==='output') child.stdout?.emit('data',Buffer.alloc(65537,65));
    else f.ready(child,kind==='socket'?{socketPath:'/wrong.sock'}:kind==='pid'?{pid:2147483646}:{contract:{}});
  });
  await assert.rejects(f.starter.start('stored'),{code:'not_ready'}); assert.equal(f.launches.length,1);
  await f.starter.start('stored'); assert.equal(f.launches.length,1);
});
test('uncertain timeout retains the attempt and never relaunches an absent-claim child',async t=> {
  const f = await fixture(t); await assert.rejects(f.starter.start('stored'),{code:'not_ready'});
  await assert.rejects(f.starter.start('stored'),{code:'not_ready'}); assert.equal(f.launches.length,1);
});
test('a child error with an assigned PID is not proof of exit',async t=> {
  const f=await fixture(t);f.setSpawn(async child=>{child.emit('error',new Error('inert post-spawn error'));});
  await assert.rejects(f.starter.start('stored'),{code:'not_ready'});
  await assert.rejects(f.starter.start('stored'),{code:'not_ready'});assert.equal(f.launches.length,1);
});
test('confirmed startup failure permits a new explicit attempt after exit',async t=> {
  const f = await fixture(t); f.setSpawn(async child=>{child.emit('exit',1,null);});
  await assert.rejects(f.starter.start('stored'),{code:'not_ready'});
  f.setSpawn(async child=>{await f.claim();f.ready(child);});await f.starter.start('stored');assert.equal(f.launches.length,2);
});
test('a detached fake runner remains alive after the start adapter closes', {timeout:10000}, async t=> {
  const f = await fixture(t); const path = join(f.root,'fake-runner.mjs'); const contract = await descriptor();
  await writeFile(path,`import {mkdir,writeFile} from 'node:fs/promises';\nimport {hostname} from 'node:os';\nimport {dirname} from 'node:path';\nconst input=JSON.parse(process.argv[2]);\nawait mkdir(dirname(${JSON.stringify(f.endpoint.claimPath)}),{recursive:true});\nawait writeFile(${JSON.stringify(f.endpoint.claimPath)},JSON.stringify({sessionId:input.storageId,cwd:input.cwd,host:hostname(),createdAt:new Date().toISOString(),pid:process.pid}));\nprocess.stdout.write('PI_AGENT_HOST_READY '+JSON.stringify({pid:process.pid,socketPath:${JSON.stringify(f.endpoint.socketPath)},contract:${JSON.stringify(contract)}})+'\\n');\nconst interval=setInterval(()=>{},1000);process.once('SIGTERM',()=>{clearInterval(interval);process.exit(0);});\n`);
  let child:OwnedChild|undefined;
  const fakeRunnerSpawn = ((command:string,args:string[],options:Parameters<typeof spawn>[2])=> {
    child=spawn(command,[path,args[1]],options);return child;
  });
  const starter = new StoredAgentStarter({store:f.store,executable:f.executable,agentDir:f.agentDir,spawn:fakeRunnerSpawn,timeoutMs:2000});
  t.after(async()=>{starter.close();if(child && child.exitCode === null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}});
  await starter.start('stored'); assert.ok(child?.pid);starter.close();assert.equal(child.exitCode,null);
  await assert.rejects(starter.start('stored'),{code:'not_ready'});assert.equal(child.exitCode,null);
});

test('adapter closure cancels only its readiness wait, never the uncertain host',async t=> {
  const f = await fixture(t); let spawned!:()=>void;const started=new Promise<void>(done=>{spawned=done;});f.setSpawn(async()=>{spawned();});
  const attempt=f.starter.start('stored');await started;f.starter.close();await assert.rejects(attempt,{code:'not_ready'});assert.equal(f.launches.length,1);
});

test('readiness alone never establishes writer ownership',async t=> {
  const f = await fixture(t);f.setSpawn(async child=>{f.ready(child);});
  await assert.rejects(f.starter.start('stored'),{code:'not_ready'});assert.equal(f.launches.length,1);
});
