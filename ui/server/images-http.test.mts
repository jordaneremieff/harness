import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PrimarySession } from '../rpc/session.mts';
import { FakeChild } from '../rpc/fake-child.mts';
import { startBackend } from './backend.mts';
import { IMAGE_BYTES, ImageResponse, imagePart } from './images.mts';
import { LocalHttp } from './http.mts';
import { Journal } from './journal.mts';
import { StateStore } from './state.mts';
import type { PrimaryView } from '../shared/api.ts';
import type {Registry} from './registry.mts';
import {dispatchAgent} from './routes-agent.mts';
import {ApiError} from './errors.mts';
import {nativeImage} from '../agents/images.mts';

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('agent image HTTP validation keeps malformed identities separate from missing source and server failures',async t=> {
  let calls=0,failure:Error=new ApiError('not_found','No retained conversation.',404);
  const registry={agents:{image:async()=>{calls++;throw failure;}}} as unknown as Registry;
  const http=new LocalHttp({journal:new Journal(),workspace:async()=> 'workspace',observe:async()=>{},detached:()=>{},dispatch:context=>dispatchAgent(registry,context)},new Map());
  const url=await http.listen(0);t.after(()=>http.close());
  const read=async(identity:string)=> {
    const response=await fetch(new URL(`/api/agents/${identity}/history/image?entry=1&message=0&part=0&digest=${'a'.repeat(64)}`,url));
    const result=await response.json() as {ok:boolean;error:{code:string}};assert.equal(result.ok,false);return {status:response.status,code:result.error.code};
  };
  assert.deepEqual(await read('invalid'),{status:400,code:'invalid_request'});assert.equal(calls,0);
  const identity='00000000-0000-4000-8000-000000000099';
  assert.deepEqual(await read(identity),{status:404,code:'not_found'});assert.equal(calls,1);
  failure=new Error('Unrelated image source failure.');assert.deepEqual(await read(identity),{status:500,code:'internal'});assert.equal(calls,2);
});
test('agent image entries use bounded positive numeric IDs before adapter access',async t=> {
  const raw={type:'image',mimeType:'image/png',data},image=imagePart(raw);assert.ok(image.type==='image');
  let calls=0;
  const registry={agents:{image:async(identity:string,source:import('../shared/api.ts').ImageSource,digest:string)=> {
    calls++;return nativeImage({history:async(_identity:string,options?:{before?:number})=>({entries:[{id:(options?.before??2)-1,kind:'message',model:[{role:'user',content:[raw]}]}]})} as unknown as Parameters<typeof nativeImage>[0],identity,source,digest);
  }}} as unknown as Registry;
  const http=new LocalHttp({journal:new Journal(),workspace:async()=> 'workspace',observe:async()=>{},detached:()=>{},dispatch:context=>dispatchAgent(registry,context)},new Map());
  const url=await http.listen(0);t.after(()=>http.close());
  const read=(entry:string)=>fetch(new URL(`/api/agents/00000000-0000-4000-8000-000000000099/history/image?entry=${encodeURIComponent(entry)}&message=0&part=0&digest=${image.digest}`,url));
  const rejected=[];
  for(const entry of ['0','abc']) {
    const response=await read(entry),result=await response.json() as {error:{code:string}};
    rejected.push({entry,status:response.status,code:result.error.code});
  }
  assert.deepEqual(rejected,[{entry:'0',status:400,code:'invalid_request'},{entry:'abc',status:400,code:'invalid_request'}]);assert.equal(calls,0);
  for(const entry of ['1',String(Number.MAX_SAFE_INTEGER-1)]) {const response=await read(entry);assert.equal(response.status,200);assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'),data);}
  assert.equal(calls,2);
});
test('binary image admission holds two response slots and releases them after completion', async t => {
  let release = () => {}, admitted = () => {}, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { admitted = resolve; });
  const http = new LocalHttp({journal: new Journal(), workspace: async () => 'workspace', observe: async () => {}, detached: () => {}, dispatch: async () => {
    if (++calls === 2) admitted(); await gate;
    return new ImageResponse({mimeType: 'image/png', data: Buffer.from(data, 'base64')});
  }}, new Map());
  const launch = new URL(await http.listen(0));
  t.after(async () => { release(); await http.close(); });
  const url = `${launch.origin}/api/primaries/key/history/image`, options = {headers: {}};
  const first = fetch(url, options), second = fetch(url, options); await entered;
  assert.equal((await fetch(url, options)).status, 429); assert.equal(calls, 2);
  release(); const responses = await Promise.all([first, second]);
  for (const response of responses) { assert.equal(response.status, 200); await response.arrayBuffer(); }
  assert.equal((await fetch(url, options)).status, 200);
});
test('a disconnected active image releases its slot when its bounded source read settles', async t => {
  let releaseFirst = () => {}, releaseSecond = () => {}, admitted = () => {}, disconnected = () => {}, calls = 0;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const entered = new Promise<void>(resolve => { admitted = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const http = new LocalHttp({journal: new Journal(), workspace: async () => 'workspace', observe: async () => {}, detached: () => {}, dispatch: async context => {
    const request = context.url.searchParams.get('request'); if (++calls === 2) admitted();
    if (request === 'first') await firstGate;
    if (request === 'second') await secondGate;
    return new ImageResponse({mimeType: 'image/png', data: Buffer.from(data, 'base64')});
  }}, new Map());
  http.server.on('request', (request, response) => { if (request.url?.includes('request=first')) response.once('close', disconnected); });
  const launch = new URL(await http.listen(0));
  t.after(async () => { releaseFirst(); releaseSecond(); await http.close(); });
  const url = `${launch.origin}/api/primaries/key/history/image`, headers = {}, controller = new AbortController();
  const first = fetch(`${url}?request=first`, {headers, signal: controller.signal});
  const rejected = assert.rejects(first, {name: 'AbortError'});
  const second = fetch(`${url}?request=second`, {headers}); await entered;
  assert.equal((await fetch(url, {headers})).status, 429);
  controller.abort(); await rejected; await closed;
  assert.equal((await fetch(url, {headers})).status, 429);
  releaseFirst();
  const replacement = await fetch(url, {headers}); assert.equal(replacement.status, 200); await replacement.arrayBuffer();
  releaseSecond(); assert.equal((await second).status, 200);
  const after = await fetch(url, {headers}); assert.equal(after.status, 200); await after.arrayBuffer();
});
test('disconnect during an active binary response releases the response slot', async t => {
  const controller = new AbortController();
  let release = () => {}, admitted = () => {}, disconnected = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { admitted = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const http = new LocalHttp({journal: new Journal(), workspace: async () => 'workspace', observe: async () => {}, detached: () => {}, dispatch: async context => {
    const request = context.url.searchParams.get('request');
    if (request === 'held') { admitted(); await gate; }
    return new ImageResponse({mimeType: 'image/png', data: request === 'disconnect' ? Buffer.alloc(IMAGE_BYTES) : Buffer.from(data, 'base64')});
  }}, new Map());
  http.server.on('request', (request, response) => { if (request.url?.includes('request=disconnect')) response.once('close', disconnected); });
  const launch = new URL(await http.listen(0)); t.after(async () => { controller.abort(); release(); await http.close(); });
  const url = `${launch.origin}/api/primaries/key/history/image`, headers = {};
  const first = await fetch(`${url}?request=disconnect`, {headers, signal: controller.signal}); assert.equal(first.status, 200);
  const held = fetch(`${url}?request=held`, {headers}); await entered;
  assert.equal((await fetch(url, {headers})).status, 429);
  controller.abort(); await closed;
  const replacement = await fetch(url, {headers}); assert.equal(replacement.status, 200); await replacement.arrayBuffer();
  release(); assert.equal((await held).status, 200);
});
test('image HTTP route requires exact epoch, entry, part and content identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ui-image-')), path = join(dir, 'session.jsonl');
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const raw = {type: 'image', mimeType: 'image/png', data};
  const rows = [{type: 'message', id: 'image-entry', parentId: null, message: {role: 'user', timestamp: 1, content: [raw]}}];
  const save = () => writeFile(path, [{type: 'session', version: 3, id: 'fixture', timestamp: new Date(0).toISOString(), cwd: dir}, ...rows].map(row => `${JSON.stringify(row)}\n`).join(''));
  await save();
  let resolveReady = () => {}; const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const child = new FakeChild(), stateDir = join(dir, 'state');
  const app = await startBackend({cwd: dir, pi: 'fixture', stateDir, port: 0}, {assets: new Map([['/', {type: 'text/html', data: Buffer.from('<title>Fixture</title>')}]]), primary: options => {
    child.onCommand = record => {
      if (record.type === 'get_state') child.response(record, {sessionId: 'fixture', sessionFile: path, isStreaming: false, isCompacting: false, pendingMessageCount: child.pendingMessageCount});
      else if (record.type === 'get_entries') child.response(record, {entries: record.since ? [] : rows, leafId: 'image-entry'});
      else child.defaults(record);
    };
    return new PrimarySession({...options, spawnChild: child.spawn, publish: (name, target, value) => { options.publish(name, target, value); if (name === 'primary.state' && (value as PrimaryView).lifecycle === 'ready') resolveReady(); }});
  }});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  const key = await app.registry.openPrimary(dir, path); await ready;
  const launch = new URL(app.url), origin = launch.origin;
  const headers = {}; const part = imagePart(raw); assert.ok(part.type === 'image');
  const route = `${origin}/api/primaries/${key}/history/image`;
  const query = `epoch=1&entry=image-entry&message=0&part=0&digest=${part.digest}`;
  assert.equal((await fetch(`${route}?${query}`)).status, 200);
  const invalidFields = await fetch(`${origin}/api/agents/invalid/history/image?${query}`);
  assert.equal(invalidFields.status, 400); assert.equal((await invalidFields.json() as {error:{code:string}}).error.code, 'invalid_request');
  const response = await fetch(`${route}?${query}`, {headers}); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-security-policy') ?? '', /img-src 'self'/);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), data);
  for (const invalid of [query.replace('epoch=1', 'epoch=0'), query.replace('image-entry', 'missing'), query.replace('part=0', 'part=100'), query.replace(part.digest, 'bad'), `${query}&path=private`, `${query}&part=1`]) {
    const rejected = await fetch(`${route}?${invalid}`, {headers}); assert.ok([400, 409].includes(rejected.status), `${invalid}: ${rejected.status}`);
  }
  const history = await fetch(`${origin}/api/primaries/${key}/history`, {headers}); const body = await history.text();
  assert.ok(!body.includes(data)); assert.ok(body.length < 60 * 1024);
  const invalidNative = await fetch(`${origin}/api/agents/invalid/history/image?entry=1&message=0&part=0&digest=${part.digest}`, {headers});
  assert.equal(invalidNative.status, 400); assert.equal((await invalidNative.json() as {error:{code:string}}).error.code, 'invalid_request');
  const changed = Buffer.from(data, 'base64'); changed[50] ^= 1; raw.data = changed.toString('base64'); await save();
  const stale = await fetch(`${route}?${query}`, {headers}); assert.equal(stale.status, 409);
  raw.mimeType = 'image/svg+xml'; await save();
  assert.notEqual((await fetch(`${route}?${query}`, {headers})).status, 200);
  const beforeClose = child.writes.length;
  await app.close();
  assert.deepEqual(child.writes.slice(beforeClose).map(record => record.type), ['get_state', 'clear_queue', 'abort']);
  assert.equal(app.registry.primary(key).client.exited, true); assert.equal(child.stdin.writableEnded, true);
  assert.equal(app.http.server.listening, false);
  const next = await StateStore.open(stateDir); await next.close();
});
