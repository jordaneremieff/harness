import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {hostname} from 'node:os';
import {type AgentCatalog, AgentService, HostLink, type CatalogRecord, type ConversationFrame} from './service-runtime.mts';
import {frame,STORAGE,CHILD} from './fake-host.mts';
import {ObservationManager} from './observation.mts';

test('pure concurrent runtime replaces an unshared endpoint but preserves another target transport',async context=> {
  const record:CatalogRecord={storageId:STORAGE,cwd:'/project',agentDir:'/project/agent',packageDir:'/project/package',storagePath:'/project/agent.sqlite',model:{provider:'synthetic',modelId:'synthetic'},thinkingLevel:'off',createdAt:'2026-01-01T00:00:00.000Z'};
  const claim=Buffer.from(JSON.stringify({sessionId:STORAGE,cwd:record.cwd,host:hostname(),createdAt:record.createdAt,pid:1}));
  const opened=context.mock.method(fs,'open',async()=>({stat:async()=>({isFile:()=>true,size:claim.length}),
    read:async(buffer:Buffer,offset:number,length:number,position:number)=>({bytesRead:claim.copy(buffer,offset,position,position+length),buffer}),close:async()=>{}}));
  syncBuiltinESMExports();context.after(()=>{opened.mock.restore();syncBuiltinESMExports();});
  context.mock.method(process,'kill',()=>true);
  let closes=0;const tokens=new Set<string>();const availability:unknown[][]=[];
  context.mock.method(HostLink,'connect',async (endpoint:Parameters<typeof HostLink.connect>[0])=>({endpoint,connected:true,require:()=>{},capabilities:()=>({snapshot:true}),onDisconnect:()=>()=>{},
    request:async(member:string,params:Record<string,unknown>)=>{if(member==='observe-open')tokens.add(params.token as string);if(member==='observe-close')tokens.delete(params.token as string);return {};},
    subscribeObservation:async(_token:string,_callback:unknown,identity:string)=>({baseline:frame(1,identity) as unknown as ConversationFrame,start:()=>{},dispose:async()=>{}}),
    close:async()=>{closes++;}} as unknown as HostLink));
  const service=new AgentService({store:'synthetic',installationId:'synthetic',onAvailability:(...args)=>availability.push(args)},()=>({get:()=>record,close:async()=>{}} as unknown as AgentCatalog));
  try {
    await service.select('w',STORAGE,1);await service.select('w',CHILD,2);assert.equal(tokens.size,2);
    record.agentDir='/project/replacement';
    await assert.rejects(service.reconnect('w',STORAGE,3),{code:'host_unavailable'});
    assert.equal(closes,0);assert.equal(tokens.size,1);assert.ok(availability.some(args=>args[1]===STORAGE && args[2]===3 && args[3]==='unavailable'));
    assert.equal(availability.filter(args=>args[1]===CHILD).length,1);
    await service.hide('w',CHILD);await service.reconnect('w',STORAGE,4);assert.equal(closes,1);assert.equal(tokens.size,1);
  } finally {await service.close();}
  assert.equal(closes,2);assert.equal(tokens.size,0);
});
test('pure concurrent runtime forwards target and lifetime without acquiring a catalog worker or host', async context => {
  const calls: unknown[][] = [];
  context.mock.method(ObservationManager.prototype,'select',async (...args: unknown[]) => {calls.push(['select',...args]);});
  context.mock.method(ObservationManager.prototype,'hide',async (...args: unknown[]) => {calls.push(['hide',...args]);});
  context.mock.method(ObservationManager.prototype,'reconnect',async (...args: unknown[]) => {calls.push(['reconnect',...args]);});
  let catalogs = 0; let closed = 0;
  const service = new AgentService({store:'synthetic-store',installationId:'synthetic'},() => {
    catalogs++; return {close:async()=>{closed++;}} as unknown as AgentCatalog;
  });
  await service.select('w','a',11); await service.select('w','b',12);
  await service.hide('w','a'); await service.reconnect('w','b',13);
  assert.deepEqual(calls,[['select','w','a',11],['select','w','b',12],['hide','w','a'],['reconnect','w','b',13]]);
  await service.disconnectWorkspace('w'); assert.deepEqual(calls.at(-1),['hide','w',undefined]);
  await service.close(); assert.equal(catalogs,1); assert.equal(closed,1);
  assert.throws(()=>service.select('w','b',14),{code:'not_ready'});
});
