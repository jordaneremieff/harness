import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AssetGeneration, AssetGenerations } from './asset-generations.mts';
import { DiagnosticDisk, DiagnosticSink } from './diagnostics.mts';
import { captureInputs, compileBrowser, DevelopmentBuild } from './development-build.mts';
import { Registry } from './registry.mts';
import { Journal } from './journal.mts';
import { access, chmod, mkdtemp, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ApiResult, Bootstrap, EventData, EventEnvelope, EventName, OperationKind, OperationView, Target } from '../shared/api.ts';
import { LIMITS } from '../shared/api.ts';
import { UI_ITERATION, readIdentity, type UiIdentity } from '../shared/version.ts';
import type { CatalogPage } from '../agents/index.mts';
import { startBackend } from './backend.mts';
import { ASSET_ENTRY_LIMIT, ASSET_FILE_BYTES, ASSET_TOTAL_BYTES, assetMap, LocalHttp, type HttpBackend, type Asset } from './http.mts';
import { ApiError } from './errors.mts';
import { identityDocument } from './version.mts';
import type { AgentAdapter } from './registry.mts';

const executable = fileURLToPath(new URL('../rpc/fake-pi.mts', import.meta.url));
const empty: CatalogPage = {rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false, scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}};
function agents() {
  const counts = {refresh: 0, disconnect: 0, close: 0};
  let detached!: () => void; const disconnected = new Promise<void>(resolve => { detached = resolve; });
  const forbidden = async (): Promise<never> => { throw new Error('No native agent work belongs in this fixture'); };
  const adapter: AgentAdapter = {roster: () => empty, rosterRow: () => undefined, lookup: forbidden, imageInputAvailable: () => false, refresh: async () => { counts.refresh++; return empty.scan; },
    prepare: forbidden, select: forbidden, reconnect: forbidden, history: forbidden, image: forbidden, inspect: forbidden, inventory: forbidden, command: forbidden, threads: forbidden, thread: forbidden, submit: forbidden, retrySubmit: forbidden, abort: forbidden,
    configure: () => { throw new Error('No native agent configuration'); }, hide: async () => {},
    disconnectWorkspace: async () => { counts.disconnect++; detached(); }, close: async () => { counts.close++; }};
  return {adapter, counts, disconnected};
}
type Reply = {status: number; headers: IncomingHttpHeaders; bytes: Buffer; text: string; json?: ApiResult<unknown>};
async function send(origin: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const raw = body instanceof Uint8Array ? Buffer.from(body) : typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(origin, {path, method, agent: false, headers: {...(raw === undefined ? {} : {'Content-Type': 'application/json', ...(headers['Transfer-Encoding'] ? {} : {'Content-Length': String(Buffer.byteLength(raw))})}), ...headers}}, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('error', reject);
      res.on('end', () => {
        const bytes = Buffer.concat(chunks); const text = bytes.toString('utf8'); let json: ApiResult<unknown> | undefined;
        if (method !== 'HEAD' && res.headers['content-type']?.startsWith('application/json')) json = JSON.parse(text);
        resolve({status: res.statusCode ?? 0, headers: res.headers, bytes, text, json});
      });
    });
    req.on('error', reject); req.end(raw);
  });
}
function data<T>(reply: Reply): T { assert.ok(reply.json?.ok, reply.text); return reply.json.data as T; }
async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-http-')); const cwd = join(root, 'project'); await mkdir(cwd);
  const shell = Buffer.from('<!doctype html><title>Fixture</title>');
  const fake = agents();
  const app = await startBackend({cwd, port: 0, pi: executable, stateDir: join(root, 'state')}, {agents: () => fake.adapter, assets: new Map([['/', {data: shell, type: 'text/html; charset=utf-8'}]])});
  context.after(async () => { await app.close(); await rm(root, {recursive: true, force: true}); });
  const launch = new URL(app.url); const origin = launch.origin; let workspace: string | undefined;
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const separator = path.includes('?') ? '&' : '?';
    const scoped = workspace && path.startsWith('/api/') && !path.includes('workspace=') ? `${path}${separator}workspace=${encodeURIComponent(workspace)}` : path;
    return send(origin, scoped, method, body, {Origin: origin, ...headers});
  };
  const reserve = async (kind: OperationKind, target?: Target) => data<{operationId: string}>(await call('/api/operations', 'POST', {kind, ...(target ? {target} : {})})).operationId;
  return {...app, cwd, fake, origin, call, reserve, useWorkspace(id: string) { workspace = id; }};
}

class MemoryResponse extends EventEmitter {
  statusCode=200;headersSent=false;destroyed=false;writableLength=0;headers:Record<string,string>={};text='';
  setHeader(name:string,value:unknown) {this.headers[name]=String(value);}
  writeHead(status:number,headers:Record<string,string>) {this.statusCode=status;this.headersSent=true;Object.assign(this.headers,headers);return this;}
  write(data:string|Buffer) {this.text+=data.toString();return true;}
  end(data?:string|Buffer) {if(data) this.write(data);this.destroyed=true;this.emit('close');}
}
async function inProcessHttp(context:TestContext, identity?: UiIdentity) {
  const assets=new Map<string,Asset>([
    ['/',{type:'text/html',data:Buffer.from('<html><head><link href="/style.css" rel="stylesheet"><link href="/favicon.svg" rel="icon"></head><body><script src="/web/app.js"></script></body></html>')}],
    ['/style.css',{type:'text/css',data:Buffer.from('body {color:black;}')}],['/favicon.svg',{type:'image/svg+xml',data:Buffer.from('<svg/>')}],
    ['/web/app.js',{type:'text/javascript',data:Buffer.from("import '../shared/api.js'; import '../shared/control.js';")}],['/shared/api.js',{type:'text/javascript',data:Buffer.from('export {};')}],
    ['/shared/control.js',{type:'text/javascript',data:Buffer.from("import './api.js'; export const control=true;")}]
  ]);
  const imports=new Map<string,string[]>();imports.set('/web/app.js',['../shared/api.js','../shared/control.js']);imports.set('/shared/api.js',[]);imports.set('/shared/control.js',['./api.js']);
  const generations=new AssetGenerations(new AssetGeneration(assets,imports));
  let now=0;const rows:string[]=[];const diagnostics=new DiagnosticSink({append:async row=>{rows.push(row);},close:async()=>{}},()=>now);
  const counts={dispatch:0,observe:0,detached:0};const journal=new Journal();
  const backend:HttpBackend={journal,dispatch:async()=>{counts.dispatch++;return {};},workspace:async()=> 'fake',observe:async()=>{counts.observe++;},detached:()=>{counts.detached++;}};
  const http=new LocalHttp(backend,new Map(),undefined,{generations,diagnostics,identity});http.boundary.setPort(12345);
  context.after(async()=>{await diagnostics.close();http.server.removeAllListeners();});
  const invoke=async(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=> {
    const raw=body===undefined?'':JSON.stringify(body);const request=Readable.from(raw?[Buffer.from(raw)]:[]) as unknown as IncomingMessage;
    request.url=path;request.method=method;request.headers={host:'127.0.0.1:12345',origin:http.boundary.origin,'content-type':'application/json','content-length':String(Buffer.byteLength(raw)),...headers};
    const response=new MemoryResponse();const handler=http as unknown as {handle(request:IncomingMessage,response:ServerResponse):Promise<void>};
    await handler.handle(request,response as unknown as ServerResponse);return response;
  };
  return {http,backend,generations,diagnostics,rows,counts,invoke,advance:(value:number)=>{now=value;}};
}

test('leased documents carry their retained generation identity and matching HEAD lengths', async context => {
  const identity: UiIdentity = {iteration: UI_ITERATION, git: {commit: 'a'.repeat(40), shortCommit: 'aaaaaaa', branch: 'feature/ui', modified: false, committedAt: '2026-10-12T00:00:00.000Z'},
    assets: {digest: 'b'.repeat(64)}, startedAt: '2026-10-12T02:00:00.000Z', pi: '1.1.0', durable: '1.1.0'};
  const fixture = await inProcessHttp(context, identity);
  const get = await fixture.invoke('/'); const head = await fixture.invoke('/', 'HEAD');
  assert.equal(get.statusCode, 200); assert.equal(head.statusCode, 200);
  const encoded = /name="ui-identity" content="([^"]*)"/.exec(get.text)?.[1]; assert.ok(encoded);
  const served = readIdentity(encoded);
  assert.ok(served.git); assert.ok(identity.git); assert.equal(served.git.commit, identity.git.commit);
  assert.deepEqual(served.assets, fixture.generations.identity());
  assert.equal(head.headers['Content-Length'], get.headers['Content-Length']);
  assert.deepEqual(fixture.counts, {dispatch: 0, observe: 0, detached: 0});
});

test('pure development HTTP startup closes its admitted listener when watcher setup throws',async context=> {
  const stateDir=await mkdtemp(join(tmpdir(),'ui-http-startup-'));await chmod(stateDir,0o700);context.after(()=>rm(stateDir,{recursive:true,force:true}));
  const fixture=await inProcessHttp(context);const failure=new Error('watcher setup failed');const events:string[]=[];const closed:string[]=[];
  const registry={journal:fixture.backend.journal,validatePath:async()=>{},close:async()=>{closed.push('registry');},agents:{refresh:async()=>{throw new Error('unexpected refresh');}}};
  context.mock.method(Registry,'open',async()=>registry as unknown as Registry);
  context.mock.method(DevelopmentBuild,'open',async()=>({generations:fixture.generations,build:{start:()=>{events.push('watch');throw failure;},close:async()=>{closed.push('build');}}}) as unknown as Awaited<ReturnType<typeof DevelopmentBuild.open>>);
  context.mock.method(DiagnosticDisk,'open',async()=>({append:async()=>{},close:async()=>{closed.push('diagnostics');}}) as unknown as DiagnosticDisk);
  context.mock.method(LocalHttp.prototype,'listen',async()=>{events.push('listen');return 'http://127.0.0.1:12345/';});
  context.mock.method(LocalHttp.prototype,'close',async function(this:LocalHttp) {closed.push('http');this.server.removeAllListeners();});
  await assert.rejects(startBackend({cwd:'/synthetic/project',stateDir,pi:'unrun',port:0,devReload:true,devDiagnostics:true}),error=>error===failure);
  assert.deepEqual(events,['listen','watch']);assert.deepEqual(closed.sort(),['build','diagnostics','http','registry']);assert.deepEqual(fixture.counts,{dispatch:0,observe:0,detached:0});
});

test('pure development HTTP enforces Host Origin and bounded closed metadata ingestion',async context=> {
  const fixture=await inProcessHttp(context);const body={records:[{event:'measure',metric:'editor-echo',durationMs:2}],dropped:0};
  assert.equal((await fixture.invoke('/api/dev/diagnostics','POST',body,{host:'wrong.invalid'})).statusCode,403);
  assert.equal((await fixture.invoke('/api/dev/diagnostics','POST',body,{origin:'http://wrong.invalid'})).statusCode,403);
  const accepted=await fixture.invoke('/api/dev/diagnostics','POST',body);assert.equal(accepted.statusCode,200);assert.equal(JSON.parse(accepted.text).data.accepted,1);
  fixture.advance(1000);const rejected=await fixture.invoke('/api/dev/diagnostics','POST',{records:[{event:'connection',body:'PRIVATE-BODY-SENTINEL'}],dropped:0});
  assert.equal(JSON.parse(rejected.text).data.dropped,1);
  assert.equal((await fixture.invoke('/api/dev/diagnostics','POST',{records:[],dropped:0,body:'x'.repeat(17000)})).statusCode,413);
  await fixture.diagnostics.drain();assert.equal(fixture.rows.join('').includes('PRIVATE-BODY-SENTINEL'),false);assert.deepEqual(fixture.counts,{dispatch:0,observe:0,detached:0});
});

test('pure development HTTP refuses generation-prefixed HTML through parsed and direct routes without an unleased page',async context=> {
  const fixture=await inProcessHttp(context);const id=fixture.generations.status().generation;
  for(const path of [`/_ui/${id}/`,`/_ui/${id}/index.html`]) {
    for(const method of ['GET','HEAD']) {const response=await fixture.invoke(path,method);assert.equal(response.statusCode,404);assert.doesNotMatch(response.text,/<html|ui-client/);assert.equal(fixture.generations.counts().clients,0);}
    const router=fixture.http as unknown as {staticRoute(response:ServerResponse,url:URL,method:string):boolean};
    assert.throws(() => router.staticRoute(new MemoryResponse() as unknown as ServerResponse,new URL(path,fixture.http.boundary.origin),'GET'),error=>error instanceof ApiError&&error.status===404);
  }
  const page=await fixture.invoke('/');assert.equal(page.statusCode,200);assert.match(page.text,/ui-client/);assert.equal(fixture.generations.counts().clients,1);assert.deepEqual(fixture.counts,{dispatch:0,observe:0,detached:0});
});

test('pure development HTTP pins every asset and uses a distinct bounded notification stream without work replay',async context=> {
  const fixture=await inProcessHttp(context);const cursor=fixture.backend.journal.cursor;
  const page=await fixture.invoke('/');assert.equal(page.statusCode,200);const id=fixture.generations.status().generation;
  const head=await fixture.invoke('/','HEAD');assert.equal(head.statusCode,200);assert.equal(head.headers['Content-Length'],page.headers['Content-Length']);assert.equal(fixture.generations.counts().clients,1);
  assert.match(page.text,new RegExp(`/_ui/${id}/style.css`));const client=/name="ui-client" content="([a-f0-9]+)"/.exec(page.text)?.[1];assert.ok(client);
  const stream=await fixture.invoke(`/api/dev/events?client=${client}`);assert.match(stream.text,/event: build\ndata:/);assert.equal(stream.destroyed,false);
  assert.equal(fixture.backend.journal.cursor,cursor);assert.equal(fixture.backend.journal.connectionCount,0);
  assert.equal((await fixture.invoke(`/_ui/${id}/shared/control.js`)).statusCode,200);
  assert.match((await fixture.invoke(`/_ui/${id}/shared/control.js`)).text,/export const control=true/);
  assert.equal((await fixture.invoke(`/_ui/${id}/shared/control.js`,'HEAD')).statusCode,200);
  assert.equal((await fixture.invoke(`/_ui/${id}/web/app.js`)).statusCode,200);assert.equal((await fixture.invoke(`/_ui/${'f'.repeat(64)}/web/app.js`)).statusCode,409);
  assert.equal((await fixture.invoke('/api/dev/ack','POST',{client,generation:id,cssGeneration:id,extra:'no'})).statusCode,400);
  assert.equal((await fixture.invoke('/api/dev/ack','POST',{client,generation:id,cssGeneration:id})).statusCode,200);
  fixture.generations.restartRequired();assert.match(stream.text,/restart-required/);assert.equal(fixture.generations.status().generation,id);
  assert.deepEqual(fixture.counts,{dispatch:0,observe:0,detached:0});stream.end();assert.equal(fixture.generations.counts().clients,1);
  assert.equal((await fixture.invoke('/api/dev/release','POST',{client})).statusCode,200);assert.equal(fixture.generations.counts().clients,0);
});

test('development lease recovery preserves page identity capacity and explicit missing-release results',async context=> {
  const fixture=await inProcessHttp(context);const id=fixture.generations.status().generation;
  const family=/name="ui-module-family" content="([a-f0-9]{64})"/.exec(fixture.generations.documentHead()?.data.toString()??'')?.[1];assert.ok(family);
  const missing='0'.repeat(24),body={client:missing,generation:id,cssGeneration:id,family};
  assert.equal((await fixture.invoke('/api/dev/lease','GET')).statusCode,405);
  for(const headers of [{host:'wrong.invalid'},{origin:'http://wrong.invalid'}] as Record<string,string>[]) assert.equal((await fixture.invoke('/api/dev/lease','POST',body,headers)).statusCode,403);
  for(const invalid of [{...body,client:'bad'},{...body,generation:'bad'},{...body,cssGeneration:'bad'},{...body,family:'bad'},{...body,extra:true}]) assert.equal((await fixture.invoke('/api/dev/lease','POST',invalid)).statusCode,400);
  const replacement=JSON.parse((await fixture.invoke('/api/dev/lease','POST',body)).text).data;assert.equal(replacement.lease,'replaced');assert.notEqual(replacement.client,missing);assert.equal(fixture.generations.counts().clients,1);
  assert.deepEqual(JSON.parse((await fixture.invoke('/api/dev/lease','POST',body)).text).data,replacement);assert.equal(fixture.generations.counts().clients,1);
  assert.equal((await fixture.invoke('/api/dev/ack','POST',{client:missing,generation:id,cssGeneration:id})).statusCode,409);
  assert.equal((await fixture.invoke('/api/dev/release','POST',{client:replacement.client})).statusCode,200);assert.equal(fixture.generations.counts().clients,0);
  const page=await fixture.invoke('/');const client=/name="ui-client" content="([a-f0-9]+)"/.exec(page.text)?.[1];assert.ok(client);
  const known={...body,client};assert.equal(JSON.parse((await fixture.invoke('/api/dev/lease','POST',known)).text).data.lease,'present');
  assert.equal((await fixture.invoke('/api/dev/lease','POST',{...known,generation:'f'.repeat(64)})).statusCode,409);
  assert.equal((await fixture.invoke('/api/dev/lease','POST',{...known,cssGeneration:'f'.repeat(64)})).statusCode,409);
  assert.equal((await fixture.invoke('/api/dev/lease','POST',{...known,family:'f'.repeat(64)})).statusCode,409);
  assert.equal((await fixture.invoke('/api/dev/release','POST',{client:'bad'})).statusCode,400);
  assert.equal(JSON.parse((await fixture.invoke('/api/dev/release','POST',{client:missing})).text).data.release,'absent');
  assert.equal(JSON.parse((await fixture.invoke('/api/dev/release','POST',{client})).text).data.release,'released');
  for(let index=fixture.generations.counts().clients;index<64;index++) {const page=fixture.generations.document();fixture.generations.subscribe(page.client,()=>{});}
  const capacity=await fixture.invoke('/api/dev/lease','POST',body);assert.equal(capacity.statusCode,429);assert.equal(JSON.parse(capacity.text).error.code,'capacity');
  assert.deepEqual(fixture.counts,{dispatch:0,observe:0,detached:0});
});

test('agent start has one loopback POST route with a separate request ID', {timeout:10000}, async context => {
  const app = await fixture(context); const calls: {workspace:string;identity:string;requestId:string}[] = [];
  context.mock.method(app.registry,'startAgent',async (workspace:string,identity:string,requestId:string)=> {
    calls.push({workspace,identity,requestId});
    return {targetState:await app.registry.store.target(workspace,{kind:'agent',identity}),availability:'live',capabilities:{input:true,history:true,observe:true,abort:true,configure:false,inspect:true}};
  });
  const boot = data<Bootstrap>(await app.call('/api/bootstrap'));app.useWorkspace(boot.workspace.id);
  assert.equal((await app.call('/api/agents/stored/start','GET')).status,405);
  assert.equal((await app.call('/api/agents/stored/start','POST',{requestId:'explicit',message:'forbidden'})).status,400);
  assert.equal((await app.call('/api/agents/stored/start','POST',{})).status,400);assert.equal(calls.length,0);
  assert.equal((await app.call('/api/agents/stored/start','POST',{}, {Origin:'http://wrong.invalid','Idempotency-Key':'wrong-origin'})).status,403);
  assert.equal((await app.call('/api/agents/stored/start?workspace=00000000-0000-4000-8000-000000000099','POST',{}, {'Idempotency-Key':'unknown-workspace'})).status,404);assert.equal(calls.length,0);
  const reply = await app.call('/api/agents/stored/start','POST',{}, {'Idempotency-Key':'explicit'});assert.equal(reply.status,200);
  assert.equal(data<{capabilities:{input:boolean}}>(reply).capabilities.input,true);
  assert.deepEqual(calls,[{workspace:boot.workspace.id,identity:'stored',requestId:'explicit'}]);
});

type Frame = {name: string; id?: string; body: EventEnvelope};
class Stream {
  frames: Frame[] = []; private waits = new Set<() => void>(); private buffer = '';
  readonly ready: Promise<void>; readonly ended: Promise<void>; private closeRequest: () => void = () => {};
  constructor(origin: string, path: string, headers: Record<string, string> = {}) {
    let end!: () => void; this.ended = new Promise(resolve => { end = resolve; });
    this.ready = new Promise((resolve, reject) => {
      const req = request(origin, {path, headers}, res => {
        assert.equal(res.statusCode, 200); res.setEncoding('utf8');
        res.on('data', (chunk: string) => this.read(chunk)); res.on('end', end); res.on('close', end); res.on('error', reject); resolve();
      });
      req.on('error', reject); req.end(); this.closeRequest = () => req.destroy();
    });
  }
  private read(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const cut = this.buffer.indexOf('\n\n'); if (cut < 0) break;
      const wire = this.buffer.slice(0, cut); this.buffer = this.buffer.slice(cut + 2);
      const name = /^event: (.+)$/m.exec(wire)?.[1]; const json = /^data: (.+)$/m.exec(wire)?.[1];
      if (name && json) this.frames.push({name, id: /^id: (.+)$/m.exec(wire)?.[1], body: JSON.parse(json)});
      for (const waiter of this.waits) waiter();
    }
  }
  wait<N extends EventName>(name: N, predicate: (data: EventData[N]) => boolean = () => true, from = 0): Promise<EventEnvelope<N>> {
    return new Promise(resolve => {
      const check = () => {
        const frame = this.frames.slice(from).find(f => f.name === name && predicate(f.body.data as EventData[N]));
        if (frame) { this.waits.delete(check); resolve(frame.body as EventEnvelope<N>); }
      };
      this.waits.add(check); check();
    });
  }
  close() { this.closeRequest(); }
}
async function stream(context: TestContext, app: Awaited<ReturnType<typeof fixture>>, boot: Bootstrap, after = boot.cursor) {
  const events = new Stream(app.origin, `/api/events?workspace=${boot.workspace.id}&after=${encodeURIComponent(after)}`);
  context.after(() => events.close()); await events.ready; await events.wait('ready'); return events;
}
async function openPrimary(app: Awaited<ReturnType<typeof fixture>>, events: Stream, body: unknown = {cwd: app.cwd}) {
  const id = await app.reserve('primary.open'); const reply = await app.call('/api/primaries', 'POST', body, {'Idempotency-Key': id});
  assert.equal(reply.status, 202); const opened = data<{primaryKey: string}>(reply);
  const ready = await events.wait('primary.state', value => value.key === opened.primaryKey && value.lifecycle === 'ready');
  return {view: ready.data, target: {kind: 'primary' as const, key: opened.primaryKey, epoch: ready.data.epoch}, id};
}
async function input(app: Awaited<ReturnType<typeof fixture>>, target: Target & {kind: 'primary'}, message: string) {
  const snapshot = data<Bootstrap>(await app.call('/api/snapshot'));
  const state = snapshot.targets?.find(s => s.target.kind === 'primary' && s.target.key === target.key && s.target.epoch === target.epoch); assert.ok(state);
  const draft = data<{revision: number}>(await app.call(`/api/workspaces/${snapshot.workspace.id}/targets/${state.targetKey}/draft`, 'PUT', {expectedRevision: state.draft.revision, text: message, mode: 'prompt'}));
  const id = await app.reserve('primary.input', target); const body = {epoch: target.epoch, message, mode: 'prompt', draftRevision: draft.revision, literal: false};
  const path = `/api/primaries/${target.key}/inputs?workspace=${encodeURIComponent(snapshot.workspace.id)}`;
  const reply = await app.call(path, 'POST', body, {'Idempotency-Key': id});
  if (reply.status === 500 && (await app.registry.operations.get(id)).state === 'reserved') {
    try {
      await app.registry.dispatch({method: 'POST', parts: ['api', 'primaries', target.key, 'inputs'], url: new URL(path, app.origin), body, operationId: id, workspace: snapshot.workspace.id});
    } catch (cause) { throw new Error('The HTTP input failed before dispatch; the direct fixture dispatch exposes its cause.', {cause}); }
    assert.fail('The HTTP input failed before dispatch, but the same direct fixture dispatch succeeded.');
  }
  assert.equal(data<OperationView>(reply).state, 'accepted'); return {id, body, receipt: data<OperationView>(reply)};
}

test('saved-file HTTP resume after restart preserves exact identity and state without a no-op selection write', {timeout:20000}, async context => {
  const app=await fixture(context); const boot=data<Bootstrap>(await app.call('/api/bootstrap')); app.useWorkspace(boot.workspace.id);
  const file=join(app.cwd,'retained.jsonl'); await writeFile(file,`${JSON.stringify({type:'session',version:3,id:'retained-http',cwd:app.cwd})}\n`);
  const events=await stream(context,app,boot); const opened=await openPrimary(app,events,{cwd:app.cwd,sessionFile:file});
  const state=await app.registry.store.target(boot.workspace.id,opened.target);
  await app.registry.store.putDraft(boot.workspace.id,state.targetKey,{expectedRevision:0,text:'acknowledged HTTP draft',mode:'prompt'});
  await app.registry.store.putReading(boot.workspace.id,state.targetKey,{expectedRevision:0,anchorId:'assistant-36',offsetPx:525,followTail:false});
  await app.registry.store.putPresentation(boot.workspace.id,state.targetKey,{expectedRevision:0,expanded:['tool-1'],showThinking:true,transcriptView:'grouped'});
  const current=await app.registry.store.workspace(boot.workspace.id);
  await app.registry.store.updateSelection(current.id,{expectedRevision:current.revision,conversationLayout:{root:{kind:'pane',id:'pane',tabs:[{kind:'primary'},{kind:'file',rootId:'root',path:'source.ts'}],active:'primary'},focusedPane:'pane'},filePositions:{'file:["root","source.ts"]':{scrollTop:240,scrollLeft:32}},panelVisible:true,sidebarWidth:300});
  const before=await app.registry.snapshot(current.id); events.close(); await app.close();
  const restarted=await startBackend({cwd:app.cwd,port:0,pi:executable,stateDir:app.registry.options.stateDir},{agents:()=>agents().adapter,assets:new Map([['/',{data:Buffer.from('<!doctype html><title>Fixture</title>'),type:'text/html; charset=utf-8'}]])});
  let nextEvents: Stream | undefined;
  try {
    assert.equal(restarted.registry.sessions.size,0);
    const launch=new URL(restarted.url); const origin=launch.origin;
    const call=(path: string,method='GET',body?: unknown,headers: Record<string,string>={})=>send(origin,`${path}?workspace=${current.id}`,method,body,{Origin:origin,...headers});
    const stopped=data<Bootstrap>(await call('/api/snapshot')); assert.equal(stopped.primaries[0]?.lifecycle,'stopped');
    assert.deepEqual(stopped.workspace,before.workspace); assert.deepEqual(stopped.targets,before.targets);
    const updates=context.mock.method(restarted.registry.store,'updateSelection',restarted.registry.store.updateSelection.bind(restarted.registry.store));
    const publications=context.mock.method(restarted.registry.journal,'publish',restarted.registry.journal.publish.bind(restarted.registry.journal));
    nextEvents=new Stream(origin,`/api/events?workspace=${current.id}&after=${stopped.cursor}`); await nextEvents.ready; await nextEvents.wait('ready');
    const reserve=async()=>data<{operationId:string}>(await call('/api/operations','POST',{kind:'primary.open'})).operationId;
    const body={cwd:app.cwd,sessionFile:file}; const id=await reserve();
    const resumed=await call('/api/primaries','POST',body,{'Idempotency-Key':id}); assert.equal(resumed.status,202);
    assert.equal(data<{primaryKey:string}>(resumed).primaryKey,opened.target.key);
    await nextEvents.wait('primary.state',view=>view.key===opened.target.key && view.lifecycle==='ready');
    assert.equal(updates.mock.callCount(),0);
    assert.equal(publications.mock.calls.filter(call=>call.arguments[0]==='workspace.changed').length,0);
    const after=data<Bootstrap>(await call('/api/snapshot'));
    assert.deepEqual(after.workspace,before.workspace); assert.deepEqual(after.targets,before.targets);
    assert.equal(after.primaries[0]?.epoch,opened.target.epoch); assert.equal(after.primaries[0]?.sessionId,'retained-http'); assert.equal(restarted.registry.sessions.size,1);
    await call('/api/primaries','POST',body,{'Idempotency-Key':id}); assert.equal(updates.mock.callCount(),0); assert.equal(restarted.registry.sessions.size,1);
    await restarted.registry.primary(opened.target.key).close();
    const selected=await restarted.registry.store.workspace(current.id);
    await restarted.registry.store.updateSelection(current.id,{expectedRevision:selected.revision,selectedTarget:{kind:'agent',identity:'not-visible'}});
    const writes=updates.mock.callCount(); const changes=publications.mock.calls.filter(call=>call.arguments[0]==='workspace.changed').length;
    const changed=await call('/api/primaries','POST',body,{'Idempotency-Key':await reserve()}); assert.equal(changed.status,202); assert.equal(data<{primaryKey:string}>(changed).primaryKey,opened.target.key);
    assert.equal(updates.mock.callCount(),writes+1); assert.equal(publications.mock.calls.filter(call=>call.arguments[0]==='workspace.changed').length,changes+1);
    const restored=await restarted.registry.store.workspace(current.id);
    assert.deepEqual(restored.selectedTarget,opened.target); assert.deepEqual(restored.conversationLayout,before.workspace.conversationLayout); assert.deepEqual(restored.filePositions,before.workspace.filePositions);
    assert.deepEqual(await restarted.registry.store.getTarget(current.id,state.targetKey),before.targets?.[0]);
  } finally {nextEvents?.close(); await restarted.close();}
});

test('HTTP and SSE drive the executable through deltas, tool output, a dialog, and settlement', {timeout: 15000}, async context => {
  const app = await fixture(context); const initial = data<Bootstrap>(await app.call('/api/bootstrap'));
  const created = data<{workspace: {id: string}}>(await app.call('/api/workspaces', 'POST', {}));
  assert.notEqual(created.workspace.id, initial.workspace.id); app.useWorkspace(created.workspace.id);
  const boot = data<Bootstrap>(await app.call('/api/bootstrap')); assert.equal(boot.workspace.id, created.workspace.id);
  const events = await stream(context, app, boot); const opened = await openPrimary(app, events);
  assert.equal(opened.view.model?.provider, 'acceptance-fixture');
  const admitted = await input(app, opened.target, 'deterministic prompt');
  await events.wait('primary.delta', value => value.kind === 'text' && value.delta.includes('Text, tool output'));
  await events.wait('primary.delta', value => value.kind === 'thinking');
  const tool = await events.wait('primary.tool', value => value.phase === 'end' && value.callId === 'fixture-read');
  assert.deepEqual(events.frames.filter(f => f.name === 'primary.tool').map(f => (f.body.data as EventData['primary.tool']).phase), ['start', 'update', 'end']);
  assert.ok(tool.data.parts?.some(part => part.type === 'text' && part.text.includes('Fixture file content')));
  const dialog = await events.wait('extension.request', value => value.method === 'confirm');
  assert.equal(dialog.target?.kind, 'primary'); assert.equal(app.registry.primary(opened.target.key).view.activity, 'running');
  const repeated = await app.call(`/api/primaries/${opened.target.key}/inputs`, 'POST', admitted.body, {'Idempotency-Key': admitted.id});
  assert.deepEqual(data<OperationView>(repeated), admitted.receipt);
  const changed = await app.call(`/api/primaries/${opened.target.key}/inputs`, 'POST', {...admitted.body, message: 'different'}, {'Idempotency-Key': admitted.id}); assert.equal(changed.status, 409);
  const unknown = await app.call(`/api/primaries/${opened.target.key}/inputs`, 'POST', admitted.body, {'Idempotency-Key': 'unknown'}); assert.equal(unknown.status, 404);
  const dialogId = 'id' in dialog.data ? dialog.data.id : ''; const answer = await app.reserve('primary.dialog', opened.target); const settledCut = events.frames.length;
  const result = await app.call(`/api/primaries/${opened.target.key}/dialogs/${dialogId}`, 'POST', {epoch: opened.target.epoch, confirmed: true}, {'Idempotency-Key': answer}); assert.equal(data<OperationView>(result).state, 'completed');
  await events.wait('primary.state', value => value.key === opened.target.key && value.activity === 'idle', settledCut);
  const session = app.registry.primary(opened.target.key); assert.equal(session.messages.filter(m => m.role === 'user').length, 1);
  assert.ok(session.messages.some(m => m.parts.some(p => p.type === 'text' && p.text === 'Fixture work completed.')));
  assert.equal(app.fake.counts.refresh, 1);
});

test('page departure closes SSE and releases observations without stopping a busy primary', {timeout: 15000}, async context => {
  const app = await fixture(context); const boot = data<Bootstrap>(await app.call('/api/bootstrap'));
  const events = await stream(context, app, boot); const {target} = await openPrimary(app, events);
  await input(app, target, 'keep work alive'); await events.wait('extension.request', value => value.method === 'confirm');
  const primary = app.registry.primary(target.key); const pid = primary.view.pid; assert.ok(pid);
  events.close();
  await events.ended; await app.fake.disconnected;
  assert.equal(app.registry.journal.connectionCount, 0); assert.equal(primary.view.lifecycle, 'ready'); assert.equal(primary.view.activity, 'running');
  assert.doesNotThrow(() => process.kill(pid, 0)); assert.equal((await app.call('/api/bootstrap')).status, 200);
});

test('saved-session open and resume are direct and idempotent; obsolete fields and stale epochs refuse', {timeout: 15000}, async context => {
  const app = await fixture(context); const saved = join(app.cwd, 'saved.jsonl'); await writeFile(saved, `${JSON.stringify({type:'session',version:3,id:'fixture',timestamp:new Date(0).toISOString(),cwd:app.cwd})}\n`);
  const id = await app.reserve('primary.open'); const obsolete = await app.call('/api/primaries', 'POST', {cwd: app.cwd, sessionFile: saved, writerReleased: true}, {'Idempotency-Key': id});
  assert.equal(obsolete.status, 400); assert.equal(app.registry.sessions.size, 0);
  for (const sessionFile of ['relative.jsonl', '/invalid\u0000session', app.cwd, `${app.cwd}/missing.jsonl`]) {
    assert.equal((await app.call('/api/primaries', 'POST', {cwd: app.cwd, sessionFile}, {'Idempotency-Key': id})).status, 400);
  }
  assert.equal(app.registry.sessions.size, 0);
  const boot = data<Bootstrap>(await app.call('/api/bootstrap')); const events = await stream(context, app, boot);
  const body = {cwd: app.cwd, sessionFile: saved}; const opened = await openPrimary(app, events, body);
  const repeated = await app.call('/api/primaries', 'POST', body, {'Idempotency-Key': opened.id}); assert.equal(data<{primaryKey: string}>(repeated).primaryKey, opened.target.key); assert.equal(app.registry.sessions.size, 1);
  const resume = await app.reserve('primary.session', opened.target); const route = `/api/primaries/${opened.target.key}/session`;
  assert.equal((await app.call(route, 'POST', {epoch: 1, action: 'resume', sessionFile: saved, writerReleased: true}, {'Idempotency-Key': resume})).status, 400);
  const resumeBody = {epoch: 1, action: 'resume', sessionFile: saved};
  const accepted = await app.call(route, 'POST', resumeBody, {'Idempotency-Key': resume}); assert.equal(data<OperationView>(accepted).state, 'completed');
  const replay = await app.call(route, 'POST', resumeBody, {'Idempotency-Key': resume}); assert.deepEqual(data<OperationView>(replay), data<OperationView>(accepted));
  const duplicate = await app.reserve('primary.open');
  const conflict = data<{operation: OperationView}>(await app.call('/api/primaries', 'POST', {cwd: app.cwd, sessionFile: `${app.cwd}/./saved.jsonl`}, {'Idempotency-Key': duplicate}));
  assert.equal(conflict.operation.state, 'rejected'); assert.equal(conflict.operation.error?.code, 'operation_conflict');
  assert.equal(app.registry.sessions.size, 1);
  const otherFile = join(app.cwd, 'other.jsonl'); await writeFile(otherFile, `${JSON.stringify({type:'session',version:3,id:'other',timestamp:new Date(0).toISOString(),cwd:app.cwd})}\n`);
  const other = await openPrimary(app, events, {cwd: app.cwd, sessionFile: otherFile});
  const otherResume = await app.reserve('primary.session', other.target);
  const refused = data<OperationView>(await app.call(`/api/primaries/${other.target.key}/session`, 'POST', {epoch: other.target.epoch, action: 'resume', sessionFile: `${app.cwd}/./saved.jsonl`}, {'Idempotency-Key': otherResume}));
  assert.equal(refused.state, 'rejected'); assert.equal(refused.error?.code, 'operation_conflict');
  assert.equal(app.registry.primary(other.target.key).view.epoch, other.target.epoch);
  assert.equal(app.registry.primary(other.target.key).view.sessionFile, await realpath(otherFile));
  const staleResume = await app.reserve('primary.session', opened.target);
  const staleTransition = data<OperationView>(await app.call(route, 'POST', resumeBody, {'Idempotency-Key': staleResume}));
  assert.equal(staleTransition.error?.code, 'stale_epoch');
  const stale = await app.reserve('primary.control', opened.target);
  const rejected = data<OperationView>(await app.call(`/api/primaries/${opened.target.key}/control`, 'POST', {epoch: 1, action: 'stats'}, {'Idempotency-Key': stale}));
  assert.equal(rejected.state, 'rejected'); assert.equal(rejected.error?.code, 'stale_epoch'); assert.equal(app.registry.primary(opened.target.key).view.epoch, 2);
});

test('HTTP boundaries, methods, JSON bodies, and payload bounds are enforced', {timeout: 15000}, async context => {
  const app = await fixture(context);
  assert.equal((await app.call('/api/snapshot')).status, 200);
  assert.equal((await app.call('/api/workspaces', 'POST', {}, {Origin: 'http://foreign.invalid'})).status, 403);
  assert.equal((await app.call('/', 'GET', undefined, {Host: 'localhost:1'})).status, 403);
  assert.equal((await app.call('/api/snapshot', 'POST', {})).status, 405);
  for (const body of ['[]', 'null', '{', '"scalar"']) assert.equal((await app.call('/api/workspaces', 'POST', body)).status, 400);
  assert.equal((await app.call('/api/workspaces', 'POST', {}, {'Content-Type': 'text/plain'})).status, 400);
  assert.equal((await app.call('/api/workspaces', 'POST', {text: 'x'.repeat(LIMITS.requestBytes)})).status, 413);
  assert.equal((await app.call('/api/workspaces', 'POST', {text: 'x'.repeat(LIMITS.requestBytes)}, {'Transfer-Encoding': 'chunked'})).status, 413);
});

test('raw traversal requests never normalize into an allowed asset or API route', {timeout: 15000}, async context => {
  const app = await fixture(context);
  for (const path of ['/private/../', '/web/%2e%2e/api/bootstrap', '/web/%2fetc/passwd', '/web/%5csecret', '/web/%00', '/package.json', '/ui/server/main.mts']) {
    assert.equal((await app.call(path)).status, 404, path);
  }
});

test('Last-Event-ID overrides the URL cursor and replay precedes ready metadata', {timeout: 15000}, async context => {
  const app = await fixture(context); const boot = data<Bootstrap>(await app.call('/api/bootstrap'));
  const id = app.registry.journal.publish('notice', undefined, {level: 'info', message: 'replayed'});
  const events = new Stream(app.origin, `/api/events?workspace=${boot.workspace.id}&after=other-boot:0`, {'Last-Event-ID': boot.cursor});
  context.after(() => events.close()); await events.ready; await events.wait('ready');
  assert.deepEqual(events.frames.map(frame => [frame.name, frame.id]), [['notice', id], ['ready', undefined]]);
});

test('request rate accounting rejects the next request at a deterministic fixed clock', {timeout: 15000}, async context => {
  context.mock.method(performance, 'now', () => 1);
  const app = await fixture(context);
  for (let i = 0; i < 240; i++) assert.equal((await app.call('/api/bootstrap')).status, 200, String(i));
  const rejected = await app.call('/api/bootstrap'); assert.equal(rejected.status, 429); assert.equal(rejected.json?.ok, false);
  for (let i = 0; i < 400; i++) assert.equal((await app.call('/')).status, 200, String(i));
  assert.equal(app.fake.counts.refresh, 1); assert.equal(app.registry.sessions.size, 0);
});

const requiredAssets = ['web/index.html', 'web/style.css', 'web/favicon.svg', 'dist/web/app.js', 'dist/shared/api.js', 'dist/shared/version.js', 'dist/shared/files.js', 'dist/shared/health.js', 'dist/shared/control.js', 'dist/shared/inspection.js'];
async function browserBuild(context: TestContext, emptyFiles = false) {
  const root = await mkdtemp(join(tmpdir(), 'ui-browser-assets-'));
  const apps: Awaited<ReturnType<typeof startBackend>>[] = [];
  context.after(async () => {
    try { for (const app of apps) await app.close(); }
    finally { await rm(root, {recursive: true, force: true}); }
  });
  await mkdir(join(root, 'web')); await mkdir(join(root, 'dist/web'), {recursive: true});
  await mkdir(join(root, 'dist/shared'));
  for (const path of requiredAssets) await writeFile(join(root, path), emptyFiles ? '' : `Original ${path}`);
  return {root, start: async (state = 'state') => {
    const fake = agents();
    const app = await startBackend({cwd: root, port: 0, pi: executable, stateDir: join(root, state)}, {agents: () => fake.adapter, assetRoot: root});
    apps.push(app); return {...app, origin: new URL(app.url).origin};
  }};
}
function buildError(path: string, reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ApiError); assert.ok(error.message.includes(path), error.message);
    assert.ok(error.message.includes(reason), error.message);
    assert.ok(error.message.includes('npm run ui:build'), error.message);
    return true;
  };
}
function assetHeaders(reply: Reply) {
  return Object.fromEntries(['content-type', 'content-length', 'cache-control', 'x-content-type-options', 'referrer-policy', 'content-security-policy'].map(name => [name, reply.headers[name]]));
}
async function verifyBrowserBytes(origin: string, assets: Map<string, Asset>) {
  const headers = new Map<string, ReturnType<typeof assetHeaders>>();
  for (const [route, asset] of assets) {
    const get = await send(origin, route); const head = await send(origin, route, 'HEAD');
    assert.equal(get.status, 200, route); assert.equal(head.status, 200, route);
    const expected = route === '/' ? identityDocument(asset, {iteration: UI_ITERATION}, ASSET_FILE_BYTES) : asset;
    assert.deepEqual(get.bytes, expected.data, route); assert.equal(head.bytes.length, 0, route);
    assert.equal(get.headers['content-type'], asset.type, route);
    if (route === '/favicon.svg') {
      assert.equal(asset.type, 'image/svg+xml');
      assert.match(String(get.headers['content-security-policy']), /img-src 'self'/);
    }
    assert.equal(get.headers['content-length'], String(expected.data.length), route);
    assert.equal(get.headers['cache-control'], 'no-store'); assert.equal(get.headers['x-content-type-options'], 'nosniff');
    assert.equal(get.headers['referrer-policy'], 'no-referrer'); assert.match(String(get.headers['content-security-policy']), /default-src 'none'/);
    assert.deepEqual(assetHeaders(head), assetHeaders(get), route); headers.set(route, assetHeaders(get));
  }
  return headers;
}

test('startup browser bytes survive overwrites and deletion; a fresh backend reads the rebuilt bytes', async context => {
  const {root, start} = await browserBuild(context); const extra = 'dist/web/extra-module.js';
  await writeFile(join(root, extra), Buffer.from([0, 255, 1, 127, 128]));
  const original = await assetMap(root);
  assert.deepEqual([...original.keys()].sort(), ['/', '/favicon.svg', '/shared/api.js', '/shared/control.js', '/shared/files.js', '/shared/health.js', '/shared/inspection.js', '/shared/version.js', '/style.css', '/web/app.js', '/web/extra-module.js']);
  const app = await start(); const headers = await verifyBrowserBytes(app.origin, original);
  for (const path of [...requiredAssets, extra]) await writeFile(join(root, path), `Rebuilt ${path}`);
  assert.deepEqual(await verifyBrowserBytes(app.origin, original), headers);
  const rebuilt = await assetMap(root); const fresh = await start('fresh-state');
  await verifyBrowserBytes(fresh.origin, rebuilt);
  for (const route of original.keys()) assert.notDeepEqual(rebuilt.get(route)?.data, original.get(route)?.data);
  for (const path of [...requiredAssets, extra]) await rm(join(root, path));
  assert.deepEqual(await verifyBrowserBytes(app.origin, original), headers);
  await verifyBrowserBytes(fresh.origin, rebuilt);
  await assert.rejects(assetMap(root), buildError('dist/web/app.js', 'missing'));
});

test('production routes retain every module in the compiled browser dependency graph', async context => {
  const sourceRoot = fileURLToPath(new URL('../',import.meta.url)), inputs = await captureInputs(sourceRoot);
  const generation = await compileBrowser(sourceRoot,inputs,async()=>{}), {root,start} = await browserBuild(context);
  const modules = Object.keys(generation.manifest).filter(route=>route.endsWith('.js'));
  for (const route of modules) {const asset = generation.asset(route);assert.ok(asset,route);await writeFile(join(root,`dist${route}`),asset.data);}
  const assets = await assetMap(root);
  for (const route of modules) assert.deepEqual(assets.get(route)?.data,generation.asset(route)?.data,route);
  assert.match(assets.get('/web/file-owner.js')?.data.toString() ?? '',/from ['"]\.\.\/shared\/files\.js['"]/);
  const app = await start();const response = await send(app.origin,'/shared/files.js');
  assert.equal(response.status,200);assert.match(String(response.headers['content-type']),/^text\/javascript/);
  assert.deepEqual(response.bytes,generation.asset('/shared/files.js')?.data);
});

test('missing browser builds reject before the backend creates its state directory or acquires a lock', async context => {
  for (const path of ['dist/web', ...requiredAssets]) await context.test(path, async child => {
    const {root} = await browserBuild(child); await rm(join(root, path), {recursive: true});
    await assert.rejects(assetMap(root), buildError(path, 'missing'));
    let adapterOpened = false;
    await assert.rejects(startBackend({cwd: root, port: 0, pi: executable, stateDir: join(root, 'unopened-state')}, {
      assetRoot: root, agents: () => { adapterOpened = true; return agents().adapter; },
    }), buildError(path, 'missing'));
    assert.equal(adapterOpened, false);
    await assert.rejects(access(join(root, 'unopened-state')), {code: 'ENOENT'});
  });
});
async function sizedAsset(root: string, path: string, bytes: number) {
  const file = await open(join(root, path), 'w');
  try { await file.truncate(bytes); } finally { await file.close(); }
}

test('browser file reads accept the exact per-file bound and reject larger files', async context => {
  const {root} = await browserBuild(context, true); const path = 'web/index.html';
  await sizedAsset(root, path, ASSET_FILE_BYTES);
  assert.equal((await assetMap(root)).get('/')?.data.length, ASSET_FILE_BYTES);
  await sizedAsset(root, path, ASSET_FILE_BYTES + 1);
  await assert.rejects(assetMap(root), buildError(path, 'per-file bound'));
  await sizedAsset(root, path, ASSET_FILE_BYTES * 1024);
  await assert.rejects(assetMap(root), buildError(path, 'per-file bound'));
});

test('browser reads accept the exact total byte bound and stop at the next byte', async context => {
  const {root} = await browserBuild(context, true);
  for (let i = 0; i < ASSET_TOTAL_BYTES / ASSET_FILE_BYTES; i++) await sizedAsset(root, `dist/web/module-${i}.js`, ASSET_FILE_BYTES);
  const assets = await assetMap(root);
  assert.equal([...assets.values()].reduce((sum, asset) => sum + asset.data.length, 0), ASSET_TOTAL_BYTES);
  const path = 'dist/shared/api.js'; await writeFile(join(root, path), 'x');
  await assert.rejects(assetMap(root), buildError(path, 'total bound'));
});

test('browser traversal accepts the exact entry cap and rejects the next entry', async context => {
  const {root} = await browserBuild(context);
  for (let i = 1; i < ASSET_ENTRY_LIMIT - (requiredAssets.length - 4); i++) await writeFile(join(root, `dist/web/ignored-${i}.txt`), '');
  assert.equal((await assetMap(root)).size, requiredAssets.length);
  await writeFile(join(root, 'dist/web/one-too-many.txt'), '');
  await assert.rejects(assetMap(root), buildError('dist/shared', `${ASSET_ENTRY_LIMIT} entries`));
});

test('browser traversal ignores non-matching names and does not recurse', async context => {
  const {root} = await browserBuild(context);
  for (const name of ['bad.name.js', '.hidden.js', 'space name.js', 'note.txt', 'app.js.map', '雪.js']) await writeFile(join(root, 'dist/web', name), 'ignored');
  await mkdir(join(root, 'dist/web/nested')); await writeFile(join(root, 'dist/web/nested/valid.js'), 'ignored');
  await writeFile(join(root, 'dist/web/Valid_0-module.js'), 'routed');
  assert.deepEqual([...((await assetMap(root)).keys())].sort(), ['/', '/favicon.svg', '/shared/api.js', '/shared/control.js', '/shared/files.js', '/shared/health.js', '/shared/inspection.js', '/shared/version.js', '/style.css', '/web/Valid_0-module.js', '/web/app.js']);
});

test('browser startup rejects special build files without waiting on them', async context => {
  const {root} = await browserBuild(context);
  await mkdir(join(root, 'dist/web/folder.js'));
  await assert.rejects(assetMap(root), buildError('dist/web/folder.js', 'not a regular file'));
  await rm(join(root, 'dist/web/folder.js'), {recursive: true});
  await promisify(execFile)('mkfifo', [join(root, 'dist/web/stalled.js')]);
  await assert.rejects(assetMap(root), buildError('dist/web/stalled.js', 'not a regular file'));
  await rm(join(root, 'web/style.css')); await mkdir(join(root, 'web/style.css'));
  await rm(join(root, 'dist/web/stalled.js'));
  await assert.rejects(assetMap(root), buildError('web/style.css', 'not a regular file'));
});

test('malformed build directories name the path and the build command; other read failures propagate', async context => {
  const {root} = await browserBuild(context);
  await rm(join(root, 'dist/shared'), {recursive: true}); await writeFile(join(root, 'dist/shared'), 'not a directory');
  await assert.rejects(assetMap(root), buildError('dist/shared/api.js', 'not a directory'));
  await rm(join(root, 'dist/web'), {recursive: true}); await writeFile(join(root, 'dist/web'), 'not a directory');
  await assert.rejects(assetMap(root), buildError('dist/web', 'not a directory'));
  const denied = await browserBuild(context); await chmod(join(denied.root, 'web/index.html'), 0);
  await assert.rejects(assetMap(denied.root), {code: 'EACCES'});
});

test('browser asset routes preserve method errors and Host, Origin, and fetch metadata validation', async context => {
  const {root, start} = await browserBuild(context); const app = await start();
  await verifyBrowserBytes(app.origin, await assetMap(root));
  for (const path of ['/', '/style.css', '/favicon.svg', '/web/app.js', '/shared/api.js', '/shared/files.js']) {
    const post = await send(app.origin, path, 'POST', {}, {Origin: app.origin});
    assert.equal(post.status, 405); assert.equal(post.json?.ok, false);
    assert.equal(post.headers['content-type'], 'application/json; charset=utf-8');
    if (post.json && !post.json.ok) assert.equal(post.json.error.code, 'invalid_request');
    assert.equal((await send(app.origin, path, 'GET', undefined, {Host: 'foreign.invalid'})).status, 403);
    assert.equal((await send(app.origin, path, 'HEAD', undefined, {Origin: 'http://foreign.invalid'})).status, 403);
    assert.equal((await send(app.origin, path, 'POST', {}, {Origin: 'http://foreign.invalid'})).status, 403);
    assert.equal((await send(app.origin, path, 'GET', undefined, {'Sec-Fetch-Site': 'cross-site'})).status, 403);
  }
  assert.equal((await send(app.origin, '/api/bootstrap')).status, 200);
  for (const path of ['/web/not-built.js', '/favicon.ico', '/unknown.svg', '/favicon.svg/extra']) {
    assert.equal((await send(app.origin, path)).status, 404, path);
  }
});

test('raw image intake validates before bytes, saves a target-local lease and never falls back to text Send', {timeout: 15000}, async context => {
  const app = await fixture(context); const boot = data<Bootstrap>(await app.call('/api/bootstrap')); const events = await stream(context, app, boot);
  const primary = await openPrimary(app, events); const saved = await app.registry.store.target(boot.workspace.id, primary.target);
  const raw = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const path = `/api/workspaces/${boot.workspace.id}/targets/${saved.targetKey}/images`; const query = `?name=pixel.png&epoch=${primary.target.epoch}`;
  assert.equal((await app.call(path + query, 'POST', raw, {Origin: 'http://foreign.invalid', 'Content-Type': 'image/png'})).status, 403);
  assert.equal((await app.call(`${path + query}&workspace=${boot.workspace.id}`, 'POST', raw, {'Content-Type': 'image/png'})).status, 400);
  assert.equal((await app.call(path + query, 'POST', raw, {'Content-Type': 'image/gif'})).status, 400);
  const reply = await app.call(path + query, 'POST', raw, {'Content-Type': 'image/png'}); assert.equal(reply.status, 200);
  const staged = data<import('../shared/api.ts').ImageUploadView>(reply); assert.equal(staged.image.name, 'pixel.png');
  const read = await app.call(`${path}/${staged.image.digest}`); assert.equal(read.status, 200); assert.deepEqual(read.bytes, raw); assert.match(String(read.headers['cache-control']), /no-store/); assert.equal(read.headers['x-content-type-options'], 'nosniff');
  const draft = data<import('../shared/api.ts').DraftView>(await app.call(path.replace(/images$/, 'draft'), 'PUT', {expectedRevision: 0, text: '', mode: 'prompt', images: [staged.image]}));
  const id = await app.reserve('primary.input', primary.target);
  const receipt = data<OperationView>(await app.call(`/api/primaries/${primary.target.key}/inputs`, 'POST', {epoch: primary.target.epoch, message: '', mode: 'prompt', draftRevision: draft.revision, images: draft.images}, {'Idempotency-Key': id}));
  assert.equal(receipt.state, 'accepted'); assert.equal(receipt.receipt?.kind, 'rpc');
  if (receipt.receipt?.kind === 'rpc') assert.equal(receipt.receipt.disposition, 'started');
  assert.equal((await app.registry.store.getTarget(boot.workspace.id, saved.targetKey)).draft.images.length, 0);
});
test('raw body deadline cancels a stalled producer without an unhandled rejection', async context => {
  const f = await inProcessHttp(context); context.mock.timers.enable({apis: ['setTimeout']}); let reached!: () => void; let cancelled = false;
  const entered = new Promise<void>(resolve => {reached = resolve;});
  f.backend.uploadImage = async (ctx, _headers, body) => {reached(); try {for await (const _chunk of body) ctx.checkActive();} finally {cancelled = ctx.signal.aborted;} return {};};
  const request = new Readable({read() {}}) as unknown as IncomingMessage; request.url = '/api/workspaces/w/targets/t/images?name=x.png&epoch=1'; request.method = 'POST';
  request.headers = {host: '127.0.0.1:12345', origin: f.http.boundary.origin, 'content-type': 'image/png'};
  const response = new MemoryResponse(); const pending = (f.http as unknown as {handle(request: IncomingMessage, response: ServerResponse): Promise<void>}).handle(request, response as unknown as ServerResponse);
  await entered; context.mock.timers.tick(LIMITS.imageReceiveMs); await pending; assert.equal(response.statusCode, 408); assert.equal(cancelled, true); request.destroy();
});
