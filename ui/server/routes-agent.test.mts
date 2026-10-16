import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { deriveEndpoint, type CatalogRecord } from '../agents/catalog-record.mts';
import { HostLink } from '../agents/client.mts';
import { FakeHost, STORAGE, descriptor } from '../agents/fake-host.mts';
import { Registry } from './registry.mts';
import type { RequestContext } from './http.mts';
import type { TargetPreparation } from '../shared/api.ts';
import {dispatchAgent} from './routes-agent.mts';
import {ApiError} from './errors.mts';

test('pure concurrent agent actions retain the workspace guard and exact identity without observation mutations',async()=> {
  const calls:unknown[][]=[];
  const registry={workspace:async(id?:string)=>{if(id!=='w')throw new ApiError('invalid_request','Unknown workspace',404);calls.push(['workspace',id]);return id;},
    startAgent:async(...args:unknown[])=>{calls.push(['start',...args]);return {availability:'stored'};},agents:{select:()=>{throw Error('No implicit observation');},hide:()=>{throw Error('No implicit hide');}}} as unknown as Registry;
  const context:RequestContext={parts:['api','agents',STORAGE,'start'],body:{},method:'POST',url:new URL('http://localhost/api'),workspace:'wrong',operationId:'request'};
  await assert.rejects(dispatchAgent(registry,context),{code:'invalid_request'});assert.deepEqual(calls,[]);
  await assert.rejects(dispatchAgent(registry,{...context,workspace:'w',body:{message:'not input'}}),{code:'invalid_request'});
  assert.deepEqual(calls,[['workspace','w']]);calls.length=0;
  assert.deepEqual(await dispatchAgent(registry,{...context,workspace:'w'}),{availability:'stored'});
  assert.deepEqual(calls,[['workspace','w'],['start','w',STORAGE,'request']]);
});
test('pure concurrent agent history remains an identity-qualified bounded read',async()=> {
  const calls:unknown[][]=[];
  const registry={agents:{history:async(identity:string,options:unknown)=>{calls.push([identity,options]);return {entries:[],nextBefore:null,revision:'r',coverage:{complete:true,truncated:false,omitted:0}};}}} as unknown as Registry;
  const context:RequestContext={parts:['api','agents',`${STORAGE}:2`,'history'],body:{},method:'GET',url:new URL('http://localhost/api?limit=2&before=7')};
  const result=await dispatchAgent(registry,context) as {target:{identity:string};revision:string};
  assert.equal(result.target.identity,`${STORAGE}:2`);assert.equal(result.revision,'r');assert.deepEqual(calls,[[`${STORAGE}:2`,{limit:2,before:7}]]);
  await assert.rejects(dispatchAgent(registry,{...context,url:new URL('http://localhost/api?limit=101')}),{code:'invalid_request'});
  assert.equal(calls.length,1);
});

test('agent image routes reject malformed identities before the adapter and preserve downstream failures',async()=> {
  const calls:string[]=[];let failure:Error|undefined;
  const registry={agents:{image:async(identity:string)=>{calls.push(identity);if(failure)throw failure;return {mimeType:'image/png',data:new Uint8Array([1])};}}} as unknown as Registry;
  const route=(identity:string)=>dispatchAgent(registry,{method:'GET',parts:['api','agents',identity,'history','image'],body:{},url:new URL(`http://localhost/api?entry=1&message=0&part=0&digest=${'a'.repeat(64)}`)});
  for(const identity of ['invalid',`${STORAGE}:0`,`${STORAGE}:02`,`${STORAGE}:2:3`]) {
    await assert.rejects(route(identity),error=>error instanceof ApiError&&error.status===400&&error.code==='invalid_request');
  }
  assert.deepEqual(calls,[]);await route(`${STORAGE}:2`);assert.deepEqual(calls,[`${STORAGE}:2`]);
  for(const error of [new ApiError('not_found','No retained conversation.',404),new Error('Image worker failed.')]) {
    failure=error;await assert.rejects(route(STORAGE),caught=>caught===error);
  }
});

async function fixture(t: TestContext, mismatch=false, announce=true) {
  const root = await mkdtemp(join(process.cwd(),'ui-start-route-')); const store = join(root,'store'); const durable = join(store,'durable');
  const cwd = join(root,'project'); const agentDir = join(root,'agent'); await Promise.all([mkdir(durable,{recursive:true}),mkdir(cwd),mkdir(agentDir)]);
  const owner=join(root,'configured-owner');const ownerSlice=join(owner,'extensions','agent');const packageDir=join(root,'installation');const executable=join(packageDir,'dist','bundle','cli.js');
  await Promise.all([mkdir(ownerSlice,{recursive:true}),mkdir(dirname(executable),{recursive:true})]);
  await Promise.all([writeFile(join(owner,'package.json'),JSON.stringify({name:'harness',pi:{extensions:['./extensions']}})),writeFile(join(ownerSlice,'index.ts'),'// inert entry'),writeFile(join(ownerSlice,'durable-runner.ts'),'// inert runner'),writeFile(join(agentDir,'settings.json'),JSON.stringify({extensions:[join(ownerSlice,'index.ts')]})),writeFile(join(packageDir,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.1.0',bin:{pi:'dist/bundle/cli.js'}})),writeFile(executable,'#!/usr/bin/env node\n// inert CLI',{mode:0o700})]);
  const record: CatalogRecord = {storageId:STORAGE,cwd,agentDir,packageDir:'/untrusted/catalog-package',storagePath:join(durable,`${STORAGE}.sqlite`),model:{provider:'fixture',modelId:'inert'},thinkingLevel:'off',trust:false,createdAt:new Date().toISOString()};
  await writeFile(record.storagePath,'inert copied storage'); await writeFile(join(durable,`${STORAGE}.json`),JSON.stringify(record));
  const endpoint = deriveEndpoint(record); await mkdir(dirname(endpoint.socketPath),{recursive:true});
  const claim = async ()=>{await mkdir(dirname(endpoint.claimPath),{recursive:true});await writeFile(endpoint.claimPath,JSON.stringify({sessionId:STORAGE,cwd,host:hostname(),createdAt:new Date().toISOString(),pid:process.pid}));};
  let host:FakeHost|undefined; let launches=0; let errors=0; const contract = await descriptor();
  const fakeSpawn = ((_command:string,_args:string[],_options:unknown)=> {
    launches++; const child = Object.assign(new ChildProcess(),{pid:process.pid,stdout:new PassThrough(),stderr:new PassThrough()});
    t.mock.method(child,'kill',()=>{throw new Error('No signals belong in Start');});
    queueMicrotask(()=>{void (async()=> {
      host = await FakeHost.start({endpoint:{...endpoint,...(mismatch?{serverId:'00000000-0000-4000-8000-000000000099'}:{})}}); await claim();
      if(announce) child.stdout?.emit('data',Buffer.from(`PI_AGENT_HOST_READY ${JSON.stringify({pid:child.pid,socketPath:endpoint.socketPath,contract})}\n`));
    })().catch(()=>{errors++;child.emit('exit',1,null);});}); return child;
  });
  const registry = await Registry.open({cwd,agentStore:store,stateDir:join(root,'ui'),executable,agentStart:{agentDir,spawn:fakeSpawn,timeoutMs:1000}});
  t.after(async()=>{await registry.close();await host?.close();await rm(root,{recursive:true,force:true});});
  await registry.agents.refresh(); const workspace = await registry.store.workspace();
  const context = (requestId?:string,identity=STORAGE,body:Record<string,unknown>={}):RequestContext=>({method:'POST',parts:['api','agents',identity,'start'],url:new URL('http://localhost/api'),body,operationId:requestId,workspace:workspace.id});
  return {registry,workspace,context,endpoint,get host(){assert.ok(host);return host;},get launches(){return launches;},get errors(){return errors;}};
}
test('explicit start transitions stored to input-ready without changing selection or drafts, and survives UI shutdown',{timeout:10000},async t=> {
  const f = await fixture(t); const target = {kind:'agent' as const,identity:STORAGE};
  const state = await f.registry.store.target(f.workspace.id,target); await f.registry.store.putDraft(f.workspace.id,state.targetKey,{expectedRevision:0,text:'Agent draft',mode:'steer'});
  const primary = await f.registry.store.target(f.workspace.id,{kind:'primary',key:'retained-primary',epoch:1});
  await f.registry.store.putDraft(f.workspace.id,primary.targetKey,{expectedRevision:0,text:'Primary draft',mode:'prompt'});
  await f.registry.store.updateSelection(f.workspace.id,{expectedRevision:f.workspace.revision,selectedTarget:target});
  assert.equal((await f.registry.prepareTarget(f.workspace.id,target)).availability,'stored');assert.equal(f.launches,0);
  const first = f.registry.dispatch(f.context('explicit-1')); const repeat = f.registry.dispatch(f.context('explicit-1'));
  const [ready,again] = await Promise.all([first,repeat]) as TargetPreparation[];
  assert.deepEqual(again,ready);assert.equal(ready.availability,'live');assert.equal(ready.capabilities.input,true);assert.equal(f.launches,1);assert.equal(f.errors,0);
  assert.equal(ready.targetState.draft.text,'Agent draft');assert.equal((await f.registry.store.target(f.workspace.id,primary.target)).draft.text,'Primary draft');
  assert.deepEqual((await f.registry.store.workspace(f.workspace.id)).selectedTarget,target);
  await f.registry.dispatch(f.context('explicit-1'));await f.registry.dispatch(f.context('explicit-2'));await f.registry.prepareTarget(f.workspace.id,target);
  assert.equal(f.launches,1);assert.equal(f.host.calls.filter(call=>call.member==='task-submit').length,0);
  await assert.rejects(f.registry.dispatch(f.context('explicit-1',`${STORAGE}:2`)),{code:'operation_conflict'});
  await f.registry.close();
  const link = await HostLink.connect(f.endpoint);assert.equal(link.connected,true);await link.close();
  assert.equal(f.host.calls.filter(call=>call.member==='task-submit').length,0);
});
test('start route rejects extra fields, missing IDs and invalid identities without any launch',{timeout:10000},async t=> {
  const f = await fixture(t);
  for(const key of [undefined,'','bad key']) await assert.rejects(f.registry.dispatch(f.context(key)),{code:'invalid_request'});
  await assert.rejects(f.registry.dispatch(f.context('id',STORAGE,{message:'not input'})),{code:'invalid_request'});
  await assert.rejects(f.registry.dispatch(f.context('id',STORAGE,{requestId:'not a header'})),{code:'invalid_request'});
  await assert.rejects(f.registry.dispatch(f.context('id','../escape')),{code:'invalid_request'});assert.equal(f.launches,0);
});
test('concurrent starts share storage acquisition but prepare each exact conversation',{timeout:10000},async t=> {
  const f=await fixture(t);const child=`${STORAGE}:2`;
  const results=await Promise.all([f.registry.dispatch(f.context('root',STORAGE)),f.registry.dispatch(f.context('child',child))]) as TargetPreparation[];
  assert.equal(f.launches,1);assert.equal(results[0].targetState.target.kind,'agent');assert.deepEqual(results[0].targetState.target,{kind:'agent',identity:STORAGE});assert.deepEqual(results[1].targetState.target,{kind:'agent',identity:child});
  assert.equal(results[0].capabilities.input,true);assert.equal(results[1].capabilities.input,true);assert.equal(f.host.calls.filter(call=>call.member==='task-submit').length,0);
});
test('missing readiness retains the request outcome while check attaches without another launch',{timeout:10000},async t=> {
  const f=await fixture(t,false,false);
  await assert.rejects(f.registry.dispatch(f.context('uncertain')),{code:'not_ready'});
  await assert.rejects(f.registry.dispatch(f.context('uncertain')),{code:'not_ready'});assert.equal(f.launches,1);
  const checked=await f.registry.prepareTarget(f.workspace.id,{kind:'agent',identity:STORAGE});assert.equal(checked.availability,'live');assert.equal(checked.capabilities.input,true);assert.equal(f.launches,1);
  assert.equal(f.host.calls.filter(call=>call.member==='task-submit').length,0);
});

test('server handshake mismatch cannot produce an input-ready preparation',{timeout:10000},async t=> {
  const f = await fixture(t,true);
  const prepared = await f.registry.dispatch(f.context('mismatch')) as TargetPreparation;
  assert.equal(prepared.availability,'unavailable');assert.equal(prepared.capabilities.input,false);assert.equal(f.launches,1);
  assert.match(prepared.reason ?? '',/identity handshake failed/);
  assert.equal(f.host.serverId,'00000000-0000-4000-8000-000000000099');assert.notEqual(f.host.serverId,f.endpoint.serverId);
  assert.equal(f.host.endpoint.socketPath,f.endpoint.socketPath);
  const claim = JSON.parse(await readFile(f.endpoint.claimPath,'utf8'));
  assert.equal(claim.sessionId,STORAGE);assert.equal(claim.pid,process.pid);
  assert.deepEqual(f.host.calls,[]);
});
