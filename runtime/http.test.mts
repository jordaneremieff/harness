import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {serveRuntime} from './http.mts';
import {callRuntime,discoverRuntime} from './client.mts';
import {RUNTIME_PROTOCOL} from './contract.mts';
import {recoveryJs} from './recovery.mts';
import {Script} from 'node:vm';

test('recovery and validated config remain available without browser assets or providers',async t=>{
  const root=await realpath(await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rh-')));
  await writeFile(join(root,'harness.json'),'{invalid');
  const options={agentDir:root,stateDir:root,cwd:root,sourceRoot:root,uiStateDir:join(root,'ui'),env:{},network:{port:0}};
  const runtime=await serveRuntime(options);t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
  await runtime.service.domains.recovery.refresh();assert.equal(runtime.service.domains.recovery.status().inventory,'unavailable');assert.equal(runtime.service.domains.recovery.status().owners.length,0);
  const origin=runtime.descriptor.origin;
  const page=await fetch(`${origin}/runtime/`);assert.equal(page.status,200);assert.match(await page.text(),/Harness management/);
  assert.equal((await stat(join(root,'control.sock'))).mode&0o777,0o600);
  const result=await callRuntime({operation:'health'},{agentDir:root,stateDir:root});assert.equal(result.ok,true);if(result.ok)assert.equal((result.value as {configuration:string}).configuration,'invalid');
  const denied=await fetch(`${origin}/runtime/operation`,{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:JSON.stringify({protocol:RUNTIME_PROTOCOL,request:{operation:'health'}})});assert.equal(denied.status,403);
  const valid=await fetch(`${origin}/runtime/operation`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({protocol:RUNTIME_PROTOCOL,request:{operation:'config.validate',target:'pi',values:{defaultModel:'synthetic'}}})});assert.equal((await valid.json() as {ok:boolean}).ok,true);
  await assert.rejects(serveRuntime(options));
  assert.equal((await discoverRuntime({stateDir:root})).incarnation,runtime.descriptor.incarnation);
});
function wire(port:number,headers:string[]):Promise<number> {
  return new Promise((accept,reject)=>{const request=httpRequest({host:'127.0.0.1',port,path:'/runtime/health',headers},response=>{response.resume();response.once('end',()=>accept(response.statusCode??0));});request.once('error',reject);request.end();});
}
test('private entrypoint requires exact proxy identity before assets and rejects duplicates',async t=>{
  const root=await realpath(await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rh-')));
  const runtime=await serveRuntime({agentDir:root,stateDir:root,cwd:root,sourceRoot:root,uiStateDir:join(root,'ui'),env:{},network:{port:0,privatePort:0,privateOrigin:'https://machine.example.ts.net',privateOwnerLogin:'owner@example.com'}});t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
  const port=runtime.privatePort as number,headers=['Host','machine.example.ts.net','X-Forwarded-Host','machine.example.ts.net','X-Forwarded-Proto','https','Tailscale-User-Login','owner@example.com'];
  assert.equal(await wire(port,headers),200);
  assert.equal(await wire(port,[...headers,'Tailscale-User-Login','owner@example.com']),403);
  assert.equal(await wire(port,['Host','machine.example.ts.net']),403);
  assert.equal(await wire(port,[...headers,'Tailscale-Funnel-Request','true']),403);
  const localPort=Number(new URL(runtime.descriptor.origin).port);assert.equal(await wire(localPort,headers),403);
});
test('repeat close of an old runtime leaves its replacement descriptor intact',async t=>{
  const root=await realpath(await mkdtemp(join(process.env.RUNTIME_TEST_ROOT??tmpdir(),'rh-'))),options={agentDir:root,stateDir:root,cwd:root,sourceRoot:root,uiStateDir:join(root,'ui'),env:{},network:{port:0}};
  let current=await serveRuntime(options);t.after(async()=>{await current.close();await rm(root,{recursive:true,force:true});});const previous=current;await previous.close();
  current=await serveRuntime(options);await previous.close();assert.equal((await discoverRuntime({stateDir:root})).incarnation,current.descriptor.incarnation);
});
test('recovery script is syntactically complete and uses only the independent operation route',()=>{new Script(recoveryJs);assert.match(recoveryJs,/\/runtime\/operation/);assert.doesNotMatch(recoveryJs,/api\/workspaces/);});
