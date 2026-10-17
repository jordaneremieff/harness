import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {hostname, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {type AgentCatalog, AgentService, HostLink, deriveEndpoint, type CatalogRecord, type ConversationFrame} from './service-runtime.mts';
import {deferred, FakeHost, frame, snapshot, STORAGE, CHILD} from './fake-host.mts';
import type {RetainedReader} from './retained-read.mts';
import {ObservationManager} from './observation.mts';

test('live history cancellation releases its request and preserves the host connection', {timeout:10000}, async context => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ui-history-'));
  context.after(() => fs.rm(root, {recursive:true, force:true}));
  const record:CatalogRecord = {storageId:STORAGE,cwd:root,agentDir:root,packageDir:root,storagePath:join(root,'agent.sqlite'),model:{provider:'synthetic',modelId:'synthetic'},thinkingLevel:'off',createdAt:'2026-01-01T00:00:00.000Z'};
  const endpoint = deriveEndpoint(record);
  await fs.mkdir(dirname(endpoint.socketPath), {recursive:true});
  await fs.mkdir(dirname(endpoint.claimPath), {recursive:true});
  await fs.writeFile(endpoint.claimPath, JSON.stringify({sessionId:STORAGE,cwd:root,host:hostname(),createdAt:record.createdAt,pid:process.pid}));
  const held = deferred<ReturnType<typeof snapshot>>(), cancelled = deferred<void>();
  let snapshots = 0;
  const host = await FakeHost.start({endpoint,handler:call => {
    if (call.member !== 'snapshot' || ++snapshots !== 1) return;
    call.signal.addEventListener('abort', () => {cancelled.resolve(); held.resolve(snapshot());}, {once:true});
    return held.promise;
  }});
  context.after(() => host.close());
  const link = await HostLink.connect(endpoint, {maxPending:1});
  context.after(async () => {held.resolve(snapshot()); await link.close();});
  const requests = context.mock.method(link, 'request');
  const connections = context.mock.method(HostLink, 'connect', async () => link);
  let retainedReads = 0;
  const service = new AgentService({store:root,stateDir:root,installationId:'synthetic'},
    () => ({get:() => record,close:async () => {}} as unknown as AgentCatalog),
    () => ({request:async () => {retainedReads++; throw Error('Unexpected retained read');},close:async () => {}} as unknown as RetainedReader));
  context.after(async () => {held.resolve(snapshot()); await service.close();});
  const controller = new AbortController();
  const history = service.history(CHILD, {limit:1}, controller.signal);
  const rejected = assert.rejects(history, {code:'cancelled',uncertain:false});
  const first = await host.waitForCall(call => call.member === 'snapshot');
  assert.equal(requests.mock.calls[0].arguments[3], controller.signal);
  controller.abort();
  await rejected; await cancelled.promise;
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(await service.history(CHILD, {limit:1}), snapshot());
  assert.equal(link.connected, true);
  assert.equal(host.connectionCount, 1);
  assert.equal(connections.mock.callCount(), 1);
  assert.equal(retainedReads, 0);
  assert.deepEqual(host.calls.map(call => call.member), ['snapshot','snapshot']);
  assert.equal(host.calls[0].connection, host.calls[1].connection);
  assert.equal(host.lifecycle.some(event => event.kind === 'release'), false);
});

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
  const service=new AgentService({store:'synthetic',stateDir:'/fixture/state',installationId:'synthetic',onAvailability:(...args)=>availability.push(args)},()=>({get:()=>record,close:async()=>{}} as unknown as AgentCatalog));
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
  const service = new AgentService({store:'synthetic-store',stateDir:'/fixture/state',installationId:'synthetic'},() => {
    catalogs++; return {close:async()=>{closed++;}} as unknown as AgentCatalog;
  });
  await service.select('w','a',11); await service.select('w','b',12);
  await service.hide('w','a'); await service.reconnect('w','b',13);
  assert.deepEqual(calls,[['select','w','a',11],['select','w','b',12],['hide','w','a'],['reconnect','w','b',13]]);
  await service.disconnectWorkspace('w'); assert.deepEqual(calls.at(-1),['hide','w',undefined]);
  await service.close(); assert.equal(catalogs,1); assert.equal(closed,1);
  assert.throws(()=>service.select('w','b',14),{code:'not_ready'});
});
