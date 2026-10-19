import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {startBackend} from './backend.mts';
import type {AgentAdapter} from './registry.mts';

const ready={state:'ready' as const,complete:true,visited:0,skipped:0,omitted:0};
const failed=(error:string)=>({state:'failed' as const,complete:false,visited:0,skipped:0,omitted:0,error});
const page=(scan:typeof ready|ReturnType<typeof failed>)=>({rows:[],nextCursor:null,coverage:{complete:scan.state==='ready',omitted:0},stale:scan.state!=='ready',scan});
function adapter(scan:typeof ready|ReturnType<typeof failed>,refresh:()=>Promise<unknown>):AgentAdapter {
  const forbidden=async():Promise<never>=>{throw new Error('Not used.');};
  return {roster:()=>page(scan),rosterRow:()=>undefined,imageInputAvailable:()=>false,refresh:refresh as AgentAdapter['refresh'],prepare:forbidden,select:forbidden,reconnect:forbidden,history:forbidden,image:forbidden,inspect:forbidden,inventory:forbidden,command:forbidden,threads:forbidden,thread:forbidden,submit:forbidden,retrySubmit:forbidden,abort:forbidden,configure:()=>{throw new Error('Not used.');},hide:async()=>{},disconnectWorkspace:async()=>{},close:async()=>{}};
}
async function backend(t:TestContext,agents:AgentAdapter) {
  const directory=await mkdtemp(join(tmpdir(),'ui-unavailable-')),project=join(directory,'project'),stateDir=join(directory,'state');await mkdir(project);await mkdir(stateDir,{mode:0o700});
  const stderr:string[]=[];t.mock.method(process.stderr,'write',(text:string|Uint8Array)=>{stderr.push(String(text));return true;});
  const app=await startBackend({cwd:project,port:0,pi:'not-executed',stateDir},{agents:()=>agents,assets:new Map([['/',{data:Buffer.from('<html><head></head><body></body></html>'),type:'text/html'}]])});
  let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}};
  t.after(async()=>{await close();await rm(directory,{recursive:true,force:true});});
  const health=async()=>{const origin=app.http.boundary.origin,response=await fetch(new URL('/api/health',origin),{headers:{Origin:origin}});return (await response.json() as {data:{services:{name:string;state:string;reason?:string}[]}}).data.services;};
  return {app,stateDir,stderr,health,lifecycle:async()=>{await close();return readFile(join(stateDir,'lifecycle.log'),'utf8');}};
}
test('a failed catalog scan is logged with its reason and health reports agents unavailable with that reason',async t=>{
  const run=await backend(t,adapter(failed('Catalog directory is absent'),async()=>failed('Catalog directory is absent')));
  await new Promise<void>(resolve=>setImmediate(resolve));
  const services=await run.health();
  assert.deepEqual(services.find(service=>service.name==='agents'),{name:'agents',state:'unavailable',reason:'Catalog directory is absent'});
  assert.deepEqual(services.find(service=>service.name==='rpc'),{name:'rpc',state:'stopped'});
  assert.equal(run.stderr.filter(line=>line.includes('Agent catalog unavailable: Catalog directory is absent')).length,1);
  const log=await run.lifecycle(),rows=log.split('\n').filter(Boolean).map(row=>JSON.parse(row) as {event:string;detail:string});
  assert.equal(rows.filter(row=>row.event==='unavailable'&&row.detail==='Agent catalog unavailable: Catalog directory is absent').length,1);
});
test('a refused catalog refresh is logged and a ready catalog logs nothing',async t=>{
  const refused=await backend(t,adapter(failed('Agent worker failed.'),async()=>{throw new Error('Catalog is closed');}));
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal((await refused.health()).find(service=>service.name==='agents')?.state,'unavailable');
  assert((await refused.lifecycle()).includes('Agent catalog unavailable:'));
  const healthy=await backend(t,adapter(ready,async()=>ready));
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual((await healthy.health()).find(service=>service.name==='agents'),{name:'agents',state:'ready'});
  assert.equal((await healthy.lifecycle()).includes('"unavailable"'),false);
});
