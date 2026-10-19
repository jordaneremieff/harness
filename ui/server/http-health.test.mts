import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type {BackendHealthFacts, HealthSnapshot} from '../shared/health.ts';
import {LocalHttp, type DevelopmentHttp, type HttpBackend} from './http.mts';
import {Journal} from './journal.mts';
const facts = (): BackendHealthFacts => ({startedAt:'2026-10-15T00:00:00.000Z',supervisorRestarts:2,
  services:[{name:'files',state:'ready'},{name:'agents',state:'unavailable'},{name:'rpc',state:'ready'}],build:{state:'static'}});
async function fixture(context:TestContext,development:DevelopmentHttp) {
  const backend:HttpBackend = {journal:new Journal(),dispatch:async()=>{throw new Error('Health must not dispatch work.');},workspace:async()=>{throw new Error('Health must not load workspaces.');},observe:async()=>{},detached:()=>{}};
  const http = new LocalHttp(backend,new Map(),undefined,development), origin = new URL(await http.listen(0)).origin;context.after(()=>http.close());
  return {http,origin,read:(method='GET')=>fetch(`${origin}/api/health`,{method,headers:{Origin:origin}})};
}
test('health reads are open, on demand, method-bound and independent of work dispatch',async context => {
  let calls = 0;const app = await fixture(context,{health:()=>{calls++;return facts();}});assert.equal(calls,0);
  const wrongMethod = await app.read('POST');assert.equal(wrongMethod.status,405);await wrongMethod.text();assert.equal(calls,0);
  const response = await app.read();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const result = await response.json() as {ok:boolean;data:HealthSnapshot};assert.equal(result.ok,true);assert.equal(calls,1);
  assert.equal(result.data.process.pid,process.pid);assert(Number.isSafeInteger(result.data.process.rssBytes));assert(result.data.process.rssBytes>0);assert(result.data.process.uptimeMs>=0);
  assert.deepEqual(result.data.requests,{active:1,limit:64});assert.deepEqual(result.data.services,facts().services);assert.equal(result.data.supervisorRestarts,2);
  const again = await app.read();await again.text();assert.equal(calls,2);
});
test('health projects only bounded named facts and identity hashes, never arbitrary diagnostic data',async context => {
  const secret = '/private/operator/location token=secret prompt contents';
  const app = await fixture(context,{health:()=>({...facts(),privateState:secret,services:facts().services.map(service=>({...service,detail:secret})),build:{state:'static',diagnostic:secret}}),
    identity:{iteration:'0.8',git:{commit:'a'.repeat(40),shortCommit:'aaaaaaa',branch:secret,modified:false,committedAt:'2026-10-15T00:00:00Z'},assets:{digest:'b'.repeat(64)}}});
  const response = await app.read(), text = await response.text();assert.equal(response.status,200);assert.equal(text.includes(secret),false);
  const snapshot = JSON.parse(text).data;assert.deepEqual(Object.keys(snapshot).sort(),['build','identity','process','requests','services','startedAt','supervisorRestarts','userStylesheet']);
  assert.deepEqual(snapshot.identity,{iteration:'0.8',commit:'a'.repeat(40),assetDigest:'b'.repeat(64)});
  assert.deepEqual(snapshot.build,{state:'static'});assert(snapshot.services.every((service:object)=>Object.keys(service).length===2));
});
test('health carries a bounded reason only for an unavailable service and drops any other service property',async context => {
  const app = await fixture(context,{health:()=>({...facts(),services:[{name:'files',state:'ready'},{name:'agents',state:'unavailable',reason:'Catalog directory is absent'},{name:'rpc',state:'stopped'}]})});
  const response = await app.read();assert.equal(response.status,200);
  assert.deepEqual((await response.json() as {data:HealthSnapshot}).data.services,[{name:'files',state:'ready'},{name:'agents',state:'unavailable',reason:'Catalog directory is absent'},{name:'rpc',state:'stopped'}]);
});
test('health callback failures and malformed facts return one non-sensitive unavailable result',async context => {
  let current:unknown = facts();const app = await fixture(context,{health:()=>{if(current instanceof Error)throw current;return current as BackendHealthFacts;}});
  for (const value of [new Error('/private/state token=secret'),{...facts(),supervisorRestarts:-1},{...facts(),startedAt:'private path'},
    {...facts(),services:[{name:'private-path',state:'ready'}]},{...facts(),services:[...facts().services,...facts().services]},
    {...facts(),services:[{name:'files',state:'ready'},{name:'files',state:'stopped'}]},{...facts(),build:{state:'private path'}}]) {
    current=value;const response = await app.read();assert.equal(response.status,503);const result = await response.json() as {ok:boolean;error:{message:string}};assert.equal(result.ok,false);assert.equal(result.error.message,'Backend health details are unavailable.');
  }
  current=facts();const recovered=await app.read();assert.equal(recovered.status,200);await recovered.text();
});
test('an omitted health owner reports unavailable rather than invented service readiness',async context => {
  const app = await fixture(context,{}), response = await app.read();assert.equal(response.status,503);await response.text();
});
