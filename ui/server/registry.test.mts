import assert from 'node:assert/strict';
import { ChildProcess, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { AgentError, type AgentServiceOptions, type CatalogPage } from '../agents/index.mts';
import { ApiError } from './errors.mts';
import { RpcClient } from '../rpc/client.mts';
import { PrimarySession, type PrimarySessionOptions } from '../rpc/session.mts';
import { LIMITS, type ConversationLayout, type Workspace, type Target, type TargetState, type PrimaryView, type TargetPreparation } from '../shared/api.ts';
import { Registry, type AgentAdapter, type RegistryOptions } from './registry.mts';
import { StateStore } from './state.mts';
import { assertOperation, decodeDescriptor, supportedOperations, type OperationName } from '../agents/contract.mts';
import { activity, descriptor, frame, CHILD, STORAGE } from '../agents/fake-host.mts';
import { deriveEndpoint, type CatalogRecord } from '../agents/catalog-record.mts';

const sessionHeader = (cwd: string, id = 'fixture-session') => `${JSON.stringify({type:'session',version:3,id,cwd})}\n`;
const empty: CatalogPage = {rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false, scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}};
function fakeAgents() {
  const forbidden = async (): Promise<never> => { throw new Error('No native work in a registry fixture'); };
  const adapter: AgentAdapter = {roster: () => empty, rosterRow: () => undefined, lookup: forbidden, imageInputAvailable: () => false, refresh: forbidden, prepare: forbidden, select: forbidden, reconnect: forbidden, history: forbidden, image: forbidden, inspect: forbidden, inventory: forbidden, command: forbidden, threads: forbidden, thread: forbidden,
    submit: forbidden, retrySubmit: forbidden, abort: forbidden, configure: () => { throw new Error('No native configuration'); },
    hide: async () => {}, disconnectWorkspace: async () => {}, close: async () => {}};
  return () => adapter;
}
class Primary extends PrimarySession {
  private counts: {started: number; closed: number};
  constructor(privateOptions: PrimarySessionOptions, counts: {started: number; closed: number}) {
    super(privateOptions); this.counts = counts; this.view.sessionFile = privateOptions.sessionFile;
  }
  override async start() { this.counts.started++; this.view.lifecycle = 'ready'; this.view.activity = 'idle'; this.view.sessionId = 'fixture-session'; }
  override async close() { this.counts.closed++; this.view.lifecycle = 'stopped'; }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}
class WriterClient extends RpcClient {
  actualExited = false;
  override get exited() { return this.actualExited; }
}
class WriterPrimary extends Primary {
  override readonly client: WriterClient;
  rejectClose = false;
  private supplied: PrimarySessionOptions;
  constructor(supplied: PrimarySessionOptions, counts: {started: number; closed: number}) {
    super(supplied, counts); this.supplied = supplied; this.client = new WriterClient(supplied);
  }
  override async start() {
    await super.start();
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    const stdio: NonNullable<WriterClient['child']>['stdio'] = [stdin, stdout, stderr, undefined, undefined];
    this.client.child = Object.assign(new ChildProcess(), {stdin, stdout, stderr, stdio});
    this.view.lifecycle = 'failed';
    this.supplied.publish('primary.state', this.target, this.view);
  }
  actualExit() {
    this.client.actualExited = true; this.view.lifecycle = 'stopped';
    this.supplied.publish('primary.state', this.target, this.view);
  }
  override async close() {
    if (this.rejectClose) throw new Error('The fake child still owns its writer');
    this.actualExit(); await super.close();
  }
}
async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-registry-')); const cwd = join(root, 'project'); await mkdir(cwd); await mkdir(join(cwd, 'nested'));
  const counts = {started: 0, closed: 0}; const options: RegistryOptions = {stateDir: join(root, 'state'), cwd, executable: 'fixture-unused', agentStore: join(root, 'no-catalog'),
    agents: fakeAgents(), primary: supplied => new Primary(supplied, counts)};
  const registries: Registry[] = []; const open = async () => { const registry = await Registry.open(options); registries.push(registry); return registry; };
  context.after(async () => { for (const registry of registries) await registry.close(); await rm(root, {recursive: true, force: true}); });
  return {cwd, counts, options, open};
}

test('registry restart restores stopped records, drafts, and workspace without spawning', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const workspace = await registry.store.workspace();
  const key = await registry.openPrimary(setup.cwd); const primary = registry.primary(key); assert.equal(setup.counts.started, 1);
  primary.view.pid = 123; primary.view.activity = 'retrying'; primary.view.retry = {attempt: 2, maxAttempts: 9, delayMs: 60000, at: Date.now() + 60000, error: 'Opaque provider diagnostic'}; primary.view.responseOutcome = 'failed'; primary.view.pendingDialogs = [{id: 'pending', method: 'confirm', title: 'Pending'}];
  await registry.store.updateSelection(workspace.id, {expectedRevision: workspace.revision, primaryKey: key, selectedTarget: primary.target});
  const target = await registry.store.target(workspace.id, primary.target);
  await registry.store.putDraft(workspace.id, target.targetKey, {expectedRevision: 0, text: 'retained draft', mode: 'prompt'});
  await registry.store.savePrimaries(registry.views()); assert.deepEqual((await registry.store.readPrimaries())[0]?.retry, primary.view.retry); const boot = registry.journal.bootId; await registry.close();
  const restarted = await setup.open(); assert.equal(setup.counts.started, 1); assert.equal(restarted.sessions.size, 0); assert.notEqual(restarted.journal.bootId, boot);
  const snapshot = await restarted.snapshot(workspace.id); const view = snapshot.primaries[0]; assert.ok(view);
  assert.equal(view.key, key); assert.equal(view.lifecycle, 'stopped'); assert.equal(view.activity, 'unknown'); assert.equal(view.pid, undefined);
  assert.equal(view.retry, undefined); assert.equal(view.responseOutcome, undefined); assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(view)), 'retry'), false);
  assert.deepEqual(view.pendingDialogs, []); assert.equal(view.capabilities.input, false); assert.equal(view.lastError?.code, 'not_ready');
  assert.equal(snapshot.workspace.selectedTarget?.kind, 'primary'); assert.equal(snapshot.targets?.[0]?.draft.text, 'retained draft');
  assert.throws(() => restarted.primary(key), {code: 'not_ready', status: 503});
});

test('canonical session aliases reject a second backend writer and release after shutdown', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const file = join(setup.cwd, 'session.jsonl'); await writeFile(file, sessionHeader(setup.cwd));
  const canonical = await registry.validatePath(file, false);
  const alias = await registry.validatePath(`${setup.cwd}/nested/../session.jsonl`, false); assert.equal(alias, canonical);
  const key = await registry.openPrimary(setup.cwd, canonical); assert.equal(setup.counts.started, 1);
  await assert.rejects(registry.openPrimary(setup.cwd, alias), {code: 'operation_conflict', status: 409});
  assert.equal(registry.sessions.size, 1); assert.equal(registry.primary(key).view.sessionFile, canonical); assert.equal(setup.counts.started, 1);
  await registry.close(); const restarted = await setup.open(); await restarted.openPrimary(setup.cwd, alias);
  assert.equal(setup.counts.started, 2);
});

test('an auto-new primary excludes a saved open through its raw child-reported canonical alias', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open();
  const file = join(setup.cwd, 'saved.jsonl'); await writeFile(file, sessionHeader(setup.cwd));
  const key = await registry.openPrimary(setup.cwd);
  const primary = registry.primary(key); assert.equal(primary.view.sessionFile, undefined);
  primary.view.sessionFile = `${setup.cwd}/nested/../saved.jsonl`;
  const canonical = await registry.validatePath(file, false);
  assert.notEqual(primary.view.sessionFile, canonical);
  await assert.rejects(registry.openPrimary(setup.cwd, canonical), {code: 'operation_conflict', status: 409});
  assert.equal(setup.counts.started, 1); assert.equal(registry.sessions.size, 1); assert.equal(registry.saved.size, 1);
  await primary.close(); registry.publish('primary.state', primary.target, primary.view);
  await registry.openPrimary(setup.cwd, canonical); assert.equal(setup.counts.started, 2);
});

test('concurrent saved opens recheck capacity after canonical writer claims', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open();
  const paths = await Promise.all(Array.from({length: LIMITS.primaries + 1}, async (_, index) => {
    const file = join(setup.cwd, `session-${index}.jsonl`); await writeFile(file, sessionHeader(setup.cwd));
    return registry.validatePath(file, false);
  }));
  const arrived = deferred(); const release = deferred(); context.after(() => release.resolve());
  const claimPath = registry.claimPath.bind(registry); let claims = 0;
  context.mock.method(registry, 'claimPath', async (path: string, key: string) => {
    await claimPath(path, key); claims++; if (claims === paths.length) arrived.resolve();
    await release.promise;
  });
  const opens = paths.map(path => registry.openPrimary(setup.cwd, path));
  const outcomes = Promise.allSettled(opens);
  try {
    await arrived.promise;
    assert.equal(setup.counts.started, 0); assert.equal(registry.sessions.size, 0); assert.equal(registry.saved.size, 0);
  } finally { release.resolve(); }
  const results = await outcomes;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, LIMITS.primaries);
  const rejected = results.filter(result => result.status === 'rejected'); assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reason.code, 'capacity'); assert.equal(rejected[0]?.reason.status, 429);
  assert.equal(setup.counts.started, LIMITS.primaries); assert.equal(registry.sessions.size, LIMITS.primaries);
  assert.equal(registry.saved.size, LIMITS.primaries);
  const failedPath = paths[results.findIndex(result => result.status === 'rejected')]; assert.ok(failedPath);
  await claimPath(failedPath, 'released-reservation'); registry.releasePath(failedPath, 'released-reservation');
});

test('failed lifecycle retains canonical writer exclusion and capacity until actual exit', {timeout: 10000}, async context => {
  const setup = await fixture(context); const writers: WriterPrimary[] = [];
  setup.options.primary = supplied => { const writer = new WriterPrimary(supplied, setup.counts); writers.push(writer); return writer; };
  const registry = await setup.open(); const file = join(setup.cwd, 'owned.jsonl'); await writeFile(file, sessionHeader(setup.cwd));
  const firstKey = await registry.openPrimary(setup.cwd); const first = writers[0]; assert.ok(first);
  first.view.sessionFile = `${setup.cwd}/nested/../owned.jsonl`;
  const canonical = await registry.validatePath(file, false);
  assert.equal(first.view.lifecycle, 'failed'); assert.ok(first.client.child); assert.equal(first.client.exited, false);
  await assert.rejects(registry.openPrimary(setup.cwd, canonical), {code: 'operation_conflict', status: 409});
  assert.equal(setup.counts.started, 1);
  for (let index = 1; index < LIMITS.primaries; index++) await registry.openPrimary(setup.cwd);
  assert.ok(writers.every(writer => writer.view.lifecycle === 'failed' && writer.client.child && !writer.client.exited));
  await assert.rejects(registry.openPrimary(setup.cwd), {code: 'capacity', status: 429});
  assert.equal(setup.counts.started, LIMITS.primaries);
  first.actualExit(); assert.equal(registry.primary(firstKey).client.exited, true);
  await registry.openPrimary(setup.cwd, canonical); assert.equal(setup.counts.started, LIMITS.primaries + 1);
});

test('shutdown retains the StateStore lock after close rejection until the actual writer exits', {timeout: 10000}, async context => {
  const setup = await fixture(context); const writers: WriterPrimary[] = [];
  setup.options.primary = supplied => { const writer = new WriterPrimary(supplied, setup.counts); writers.push(writer); return writer; };
  const registry = await setup.open(); await registry.openPrimary(setup.cwd); const writer = writers[0]; assert.ok(writer);
  writer.rejectClose = true; const finalized = deferred(); const closeState = registry.store.close.bind(registry.store);
  const closeStore = context.mock.method(registry.store, 'close', async () => { await closeState(); finalized.resolve(); });
  try {
    await assert.rejects(registry.close(), {code: 'not_ready', status: 503});
    assert.equal(writer.view.lifecycle, 'failed'); assert.ok(writer.client.child); assert.equal(writer.client.exited, false);
    await assert.rejects(StateStore.open(setup.options.stateDir), {code: 'not_ready', status: 503, message: 'State root already has an owner'});
    await assert.rejects(registry.openPrimary(setup.cwd), {code: 'not_ready', status: 503});
    assert.equal(setup.counts.started, 1); assert.equal(closeStore.mock.callCount(), 0);
  } finally { writer.actualExit(); await finalized.promise; }
  assert.equal(closeStore.mock.callCount(), 1);
  const next = await StateStore.open(setup.options.stateDir);
  try { assert.equal((await next.readPrimaries())[0]?.lifecycle, 'stopped'); } finally { await next.close(); }
});

test('shutdown awaits a pending saved open before releasing the StateStore lock and never starts it', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open();
  const file = join(setup.cwd, 'pending.jsonl'); await writeFile(file, sessionHeader(setup.cwd));
  const canonical = await registry.validatePath(file, false); const entered = deferred(); const release = deferred();
  context.after(() => release.resolve()); const savePrimaries = registry.store.savePrimaries.bind(registry.store);
  context.mock.method(registry.store, 'savePrimaries', async (views: PrimaryView[]) => {
    entered.resolve(); await release.promise; await savePrimaries(views);
  });
  const closeStore = context.mock.method(registry.store, 'close', registry.store.close.bind(registry.store));
  const pending = registry.openPrimary(setup.cwd, canonical); const rejected = assert.rejects(pending, {code: 'not_ready', status: 503});
  await entered.promise; assert.equal(registry.sessions.size, 1); assert.equal(setup.counts.started, 0);
  let closed = false; const closing = registry.close().then(() => { closed = true; });
  try {
    await assert.rejects(StateStore.open(setup.options.stateDir), {code: 'not_ready', status: 503, message: 'State root already has an owner'});
    assert.equal(closed, false); assert.equal(closeStore.mock.callCount(), 0); assert.equal(setup.counts.closed, 0);
  } finally { release.resolve(); await rejected; await closing; }
  assert.equal(closed, true); assert.equal(closeStore.mock.callCount(), 1);
  assert.equal(setup.counts.started, 0); assert.equal(setup.counts.closed, 0);
  assert.equal(registry.sessions.size, 0); assert.equal(registry.saved.size, 0);
  const next = await StateStore.open(setup.options.stateDir);
  try { assert.deepEqual(await next.readPrimaries(), []); } finally { await next.close(); }
});

async function retainedFixture(context: TestContext, beforeClose?: (registry: Registry, key: string) => Promise<void>) {
  const setup = await fixture(context); const registry = await setup.open(); const workspace = await registry.store.workspace();
  const file = join(setup.cwd,'retained.jsonl'); await writeFile(file,sessionHeader(setup.cwd));
  const key = await registry.openPrimary(setup.cwd,file,workspace.id); const primary = registry.primary(key); primary.view.epoch = 7;
  const layout: ConversationLayout = {root:{kind:'pane',id:'pane',tabs:[{kind:'primary'},{kind:'file',rootId:'root',path:'source.ts'}],active:'primary'},focusedPane:'pane'};
  await registry.store.updateSelection(workspace.id,{expectedRevision:workspace.revision,primaryKey:key,selectedTarget:primary.target,conversationLayout:layout,filePositions:{'file:["root","source.ts"]':{scrollTop:240,scrollLeft:32}}});
  const target = await registry.store.target(workspace.id,primary.target);
  await registry.store.putDraft(workspace.id,target.targetKey,{expectedRevision:0,text:'acknowledged draft',mode:'prompt'});
  await registry.store.putReading(workspace.id,target.targetKey,{expectedRevision:0,anchorId:'assistant-36',offsetPx:525,followTail:false});
  await registry.store.putPresentation(workspace.id,target.targetKey,{expectedRevision:0,expanded:['tool-1'],showThinking:true,transcriptView:'grouped'});
  await beforeClose?.(registry,key); await registry.store.savePrimaries(registry.views()); await registry.close();
  const restarted = await setup.open(); const before = await restarted.store.getTarget(workspace.id,target.targetKey);
  return {...setup,registry:restarted,key,file,workspace:await restarted.store.workspace(workspace.id),before};
}

test('explicit saved resume preserves key, epoch and each workspace draft and view without startup execution', {timeout:10000}, async context => {
  let otherId = ''; let otherState!: TargetState;
  const f = await retainedFixture(context,async (registry,key) => {
    const other = await registry.store.createWorkspace(); otherId = other.id; const target = registry.primary(key).target;
    await registry.store.updateSelection(other.id,{expectedRevision:other.revision,primaryKey:key,selectedTarget:target});
    const state = await registry.store.target(other.id,target);
    await registry.store.putDraft(other.id,state.targetKey,{expectedRevision:0,text:'other workspace draft',mode:'prompt'});
    await registry.store.putReading(other.id,state.targetKey,{expectedRevision:0,anchorId:'other-entry',offsetPx:91,followTail:false});
    otherState = await registry.store.getTarget(other.id,state.targetKey);
  });
  assert.equal(f.counts.started,1); assert.equal(f.registry.sessions.size,0);
  const key = await f.registry.openPrimary(f.cwd,`${f.cwd}/nested/../retained.jsonl`,f.workspace.id);
  assert.equal(key,f.key); assert.equal(f.registry.primary(key).view.epoch,7); assert.equal(f.counts.started,2);
  assert.deepEqual(await f.registry.store.target(f.workspace.id,f.registry.primary(key).target),f.before);
  assert.deepEqual(await f.registry.store.target(otherId,f.registry.primary(key).target),otherState);
  assert.deepEqual(await f.registry.store.workspace(f.workspace.id),f.workspace);
});

test('concurrent retained opens reserve one identity before writer claims and persistence await', {timeout:10000}, async context => {
  const f = await retainedFixture(context); const entered = deferred(); const release = deferred(); context.after(()=>release.resolve());
  const claim = f.registry.claimPath.bind(f.registry);
  const claims = context.mock.method(f.registry,'claimPath',async (path: string,key: string)=>{await claim(path,key); entered.resolve(); await release.promise;});
  const first = f.registry.openPrimary(f.cwd,f.file,f.workspace.id); await entered.promise;
  try {await assert.rejects(f.registry.openPrimary(f.cwd,f.file,f.workspace.id),{code:'operation_conflict'}); assert.equal(f.counts.started,1);}
  finally {release.resolve();}
  assert.equal(await first,f.key); assert.equal(claims.mock.callCount(),1); assert.equal(f.counts.started,2); assert.equal(f.registry.sessions.size,1);
  await assert.rejects(f.registry.openPrimary(f.cwd,f.file,f.workspace.id),{code:'operation_conflict'});
  assert.deepEqual(await f.registry.store.getTarget(f.workspace.id,f.before.targetKey),f.before);
});

test('retained recovery rolls back setup and persistence failures without replacing saved state', {timeout:10000}, async context => {
  const f = await retainedFixture(context); const previous = structuredClone(f.registry.saved.get(f.key));
  const factory = f.options.primary; f.options.primary = ()=>{throw new Error('construction failed');};
  await assert.rejects(f.registry.openPrimary(f.cwd,f.file,f.workspace.id),/construction failed/);
  assert.deepEqual(f.registry.saved.get(f.key),previous); assert.equal(f.registry.sessions.size,0);
  f.options.primary = factory;
  const save = f.registry.store.savePrimaries.bind(f.registry.store); let fail = true;
  context.mock.method(f.registry.store,'savePrimaries',async (views: PrimaryView[])=>{if(fail) {fail=false;throw new Error('save failed');} await save(views);});
  await assert.rejects(f.registry.openPrimary(f.cwd,f.file,f.workspace.id),/save failed/);
  assert.deepEqual(f.registry.saved.get(f.key),previous); assert.deepEqual(await f.registry.store.readPrimaries(),[previous]);
  assert.equal(f.counts.started,1); assert.equal(f.registry.sessions.size,0);
  assert.equal(await f.registry.openPrimary(f.cwd,f.file,f.workspace.id),f.key); assert.equal(f.counts.started,2);
  assert.deepEqual(await f.registry.store.getTarget(f.workspace.id,f.before.targetKey),f.before);
});

test('failed retained initialization keeps its writer until actual exit before explicit retry', {timeout:10000}, async context => {
  const f = await retainedFixture(context); const writers: WriterPrimary[] = [];
  f.options.primary = supplied=>{const writer=new WriterPrimary(supplied,f.counts);writers.push(writer);return writer;};
  assert.equal(await f.registry.openPrimary(f.cwd,f.file,f.workspace.id),f.key); const writer = writers[0]; assert.ok(writer);
  assert.equal(writer.view.lifecycle,'failed'); assert.equal(writer.client.exited,false);
  await assert.rejects(f.registry.openPrimary(f.cwd,`${f.cwd}/nested/../retained.jsonl`,f.workspace.id),{code:'operation_conflict'});
  assert.equal(f.counts.started,2); assert.equal(f.registry.sessions.get(f.key),writer);
  writer.actualExit(); assert.equal(await f.registry.openPrimary(f.cwd,f.file,f.workspace.id),f.key); assert.equal(f.counts.started,3);
  assert.deepEqual(await f.registry.store.getTarget(f.workspace.id,f.before.targetKey),f.before);
});

test('retained identity requires a valid matching header and project while new files stay new', {timeout:10000}, async context => {
  const f = await retainedFixture(context); const previous = structuredClone(f.registry.saved.get(f.key));
  for(const body of [sessionHeader(f.cwd,'different-session'),sessionHeader(f.cwd,''),sessionHeader(join(f.cwd,'nested')),'{broken\n',`${JSON.stringify({type:'session',cwd:f.cwd})}\n`]) {
    await writeFile(f.file,body);
    await assert.rejects(f.registry.openPrimary(f.cwd,f.file,f.workspace.id),error=>error instanceof ApiError && ['operation_conflict','invalid_session'].includes(error.code));
    assert.equal(f.counts.started,1); assert.deepEqual(f.registry.saved.get(f.key),previous);
  }
  await writeFile(f.file,sessionHeader(f.cwd)); const retained = f.registry.saved.get(f.key); assert.ok(retained);
  delete retained.sessionId;
  await assert.rejects(f.registry.openPrimary(f.cwd,f.file,f.workspace.id),{code:'operation_conflict'});
  f.registry.saved.set(f.key,previous as PrimaryView);
  const other = join(f.cwd,'different.jsonl'); await writeFile(other,sessionHeader(f.cwd,'another-session'));
  const key = await f.registry.openPrimary(f.cwd,other,f.workspace.id); assert.notEqual(key,f.key); assert.equal(f.registry.primary(key).view.epoch,1);
  assert.equal((await f.registry.store.target(f.workspace.id,f.registry.primary(key).target)).draft.text,'');
  assert.deepEqual(await f.registry.store.getTarget(f.workspace.id,f.before.targetKey),f.before);
});

test('ambiguous retained identities refuse without workspace preference and pure reuse consumes no saved slot', {timeout:10000}, async context => {
  const f = await retainedFixture(context); const original = f.registry.saved.get(f.key); assert.ok(original);
  for(let index=1;index<128;index++) f.registry.saved.set(`retained-${index}`,{...structuredClone(original),key:`retained-${index}`});
  await assert.rejects(f.registry.openPrimary(f.cwd,f.file),{code:'operation_conflict'}); assert.equal(f.counts.started,1);
  assert.equal(await f.registry.openPrimary(f.cwd,f.file,f.workspace.id),f.key); assert.equal(f.registry.saved.size,128); assert.equal(f.counts.started,2);
  await assert.rejects(f.registry.openPrimary(f.cwd),{code:'capacity'});
});

test('explicit retained resume never dispatches uncertain input or retained queue copies', {timeout:10000}, async context => {
  let operationId = '';
  const f = await retainedFixture(context,async (registry,key)=>{
    const target=registry.primary(key).target; const workspace=await registry.store.workspace(); const state=await registry.store.target(workspace.id,target);
    operationId=(await registry.operations.reserve(workspace.id,'primary.input',target)).id;
    await registry.operations.execute(operationId,{workspaceId:workspace.id,kind:'primary.input',target,body:{message:state.draft.text},input:{targetKey:state.targetKey,text:state.draft.text,mode:'prompt',draftRevision:state.draft.revision}},async()=>{throw new Error('unknown input outcome');});
    const clear=await registry.operations.beginQueueClear(workspace.id,target,1); await registry.operations.retainQueue(clear,{steering:[],followUp:['retained queue text']});
  });
  const before=f.registry.store.records(); const replay=context.mock.method(Primary.prototype,'input',async()=>{throw new Error('Resume must not replay input');});
  assert.equal((await f.registry.operations.get(operationId)).state,'uncertain');
  const route=async(id: string)=>f.registry.dispatch({method:'POST',parts:['api','primaries'],url:new URL('http://localhost/api/primaries'),body:{cwd:f.cwd,sessionFile:f.file},workspace:f.workspace.id,operationId:id});
  const id=(await f.registry.operations.reserve(f.workspace.id,'primary.open')).id; await route(id); await route(id);
  assert.equal(f.counts.started,2); assert.equal(replay.mock.callCount(),0);
  assert.deepEqual(f.registry.store.records().filter(record=>record.view.id!==id),before);
  assert.deepEqual(await f.registry.store.getTarget(f.workspace.id,f.before.targetKey),f.before);
});

function agentLayout(identities: string[]): ConversationLayout {
  const leaves = identities.map((identity,index) => ({kind:'pane' as const,id:`pane${index}`,tabs:[{kind:'agent' as const,identity}],active:`agent:${identity}`}));
  const primary = {kind:'pane' as const,id:'primary-pane',tabs:[{kind:'primary' as const}],active:'primary'};
  let root:ConversationLayout['root']=primary;
  for(const leaf of leaves) root={kind:'split',id:`split-${leaf.id}`,axis:'x',ratio:50,first:root,second:leaf};
  return {root,focusedPane:'primary-pane'};
}
async function memoryRegistry(context: TestContext) {
  const workspaces = new Map<string,Workspace>([['w',{id:'w',revision:0,conversationLayout:agentLayout([STORAGE,CHILD])}],['other',{id:'other',revision:0,conversationLayout:agentLayout([STORAGE])}]]);
  const states = new Map<string,TargetState[]>(); const clients = new Map([['w',1],['other',1]]);
  const calls:unknown[][]=[]; const epochs=new Map<string,Map<string,number>>(); let epoch=0;
  let callbacks!:AgentServiceOptions; let selectGate: ((workspace:string,identity:string)=>Promise<void>) | undefined; let disconnectGate: (()=>Promise<void>) | undefined;
  const state = async (workspace:string,target:Target):Promise<TargetState> => {
    const values=states.get(workspace) ?? []; let value=values.find(value=>JSON.stringify(value.target)===JSON.stringify(target));
    if(!value) {value={targetKey:target.kind==='agent'?target.identity:'primary',target,draft:{revision:0,text:'',mode:'steer',images:[],persisted:true},reading:{revision:0,anchorId:null,offsetPx:0,followTail:false},unconfirmed:[],retainedInputs:[],imageAvailability:[]};values.push(value);states.set(workspace,values);} return value;
  };
  const store={instanceId:'synthetic',workspace:async(id='w')=>{const value=workspaces.get(id);assert.ok(value);return structuredClone(value);},target:state,
    readPrimaries:async()=>[],savePrimaries:async()=>{},keepWorkspace:async()=>{},workspaceList:async()=>[...workspaces.values()].map(value=>structuredClone(value)),close:async()=>{},transaction:async<T,>(job:()=>Promise<T>)=>job(),operationViews:()=>[],enrichSentImages:()=>{},
    snapshot:(id:string)=>({workspace:structuredClone(workspaces.get(id)),targets:states.get(id) ?? [],targetIndex:[]})} as unknown as StateStore;
  context.mock.method(StateStore,'open',async()=>store);
  const registry=await Registry.open({cwd:'/project',stateDir:'synthetic',agentStore:'synthetic',executable:'not-used',agents:options=> {
    callbacks=options;return {...fakeAgents()(),roster:()=>({...empty,nextCursor:'authentic-page'}),prepare:async()=>({snapshot:true}),
      select:async(workspace,identity)=>{assert.ok(identity);calls.push(['select',workspace,identity]);await selectGate?.(workspace,identity);
        const targets=epochs.get(workspace) ?? new Map();const current=++epoch;targets.set(identity,current);epochs.set(workspace,targets);
        callbacks.onAvailability?.(workspace,identity,current,'live',undefined,{snapshot:true,'observe-open':true,'observe-frame':true,'observe-close':true,'task-submit':true,abort:true});},
      hide:async(workspace,identity)=>{calls.push(['hide',workspace,identity]);if(identity)epochs.get(workspace)?.delete(identity);else epochs.delete(workspace);},
      disconnectWorkspace:async workspace=>{calls.push(['disconnect',workspace]);epochs.delete(workspace);await disconnectGate?.();}};
  }});
  context.mock.method(registry.journal,'workspaceClients',(id:string)=>clients.get(id) ?? 0);
  context.mock.method(registry.journal,'agentViews',(id:string,inherited:readonly string[])=>(clients.get(id) ?? 0)>0?[...inherited]:[]);
  context.after(()=>registry.close());
  return {registry,workspaces,clients,calls,epochs,callbacks,set selectGate(value:typeof selectGate){selectGate=value;},set disconnectGate(value:typeof disconnectGate){disconnectGate=value;}};
}
test('pure concurrent registry snapshots include active leaves beyond the roster page while Primary focus preserves observations',async context=> {
  const f=await memoryRegistry(context); const before=await f.registry.snapshot('w');
  assert.deepEqual(before.observations,[{identity:STORAGE,connectionEpoch:0,omitted:true},{identity:CHILD,connectionEpoch:0,omitted:true}]);
  await f.registry.observe('w'); await f.registry.observe('other');
  f.callbacks.onFrame?.('w',STORAGE,1,frame(5) as never);f.callbacks.onFrame?.('w',CHILD,2,frame(7,CHILD) as never);
  f.callbacks.onFrame?.('other',STORAGE,3,frame(9) as never);
  const active=await f.registry.snapshot('w');assert.deepEqual(active.observations?.map(value=>[value.identity,value.connectionEpoch,value.frame?.revision]),[[STORAGE,1,5],[CHILD,2,7]]);
  assert.deepEqual(active.observations?.map(value=>[value.availability?.identity,value.availability?.connectionEpoch,value.availability?.state,value.availability?.capabilities.input]),[[STORAGE,1,'live',true],[CHILD,2,'live',true]]);
  assert.deepEqual(active.roster.rows,[]);assert.equal(active.roster.nextCursor,'authentic-page');
  assert.equal(active.targets?.length,2);assert.equal(f.registry.availability.get('w')?.get(CHILD)?.capabilities.input,true);
  f.callbacks.onAvailability?.('w',CHILD,1,'unavailable');assert.equal(f.registry.availability.get('w')?.get(CHILD)?.state,'live');
  assert.equal((await f.registry.snapshot('other')).observations?.[0]?.frame?.revision,9);
  const current=f.workspaces.get('w');assert.ok(current);current.conversationLayout=agentLayout([CHILD]);
  await f.registry.observe('w');f.callbacks.onFrame?.('w',STORAGE,1,frame(99) as never);
  assert.deepEqual(f.calls.filter(call=>call[0]==='hide'),[['hide','w',STORAGE]]);assert.equal(f.registry.frames.get('w')?.has(STORAGE),false);
  assert.equal((await f.registry.snapshot('w')).observations?.[0]?.frame?.revision,7);
  f.clients.set('w',0);f.registry.detached('w');await f.registry.observe('w');
  assert.equal(f.registry.frames.has('w'),false);assert.equal(f.registry.frames.get('other')?.get(STORAGE)?.frame.revision,9);
  assert.ok(f.calls.some(call=>call[0]==='disconnect' && call[1]==='w'));
});
test('pure concurrent explicit preparation reopens only a failed active target and rejects its old epoch',async context=> {
  const f=await memoryRegistry(context);await f.registry.observe('w');
  f.callbacks.onFrame?.('w',CHILD,2,frame(7,CHILD) as never);
  f.callbacks.onAvailability?.('w',STORAGE,1,'unavailable');
  await f.registry.prepareTarget('w',{kind:'agent',identity:STORAGE});
  assert.deepEqual(f.calls.filter(call=>call[0]==='hide'),[['hide','w',STORAGE]]);
  assert.equal(f.calls.filter(call=>call[0]==='select' && call[2]===CHILD).length,1);
  f.callbacks.onFrame?.('w',STORAGE,1,frame(99) as never);assert.equal(f.registry.frames.get('w')?.has(STORAGE),false);
  f.callbacks.onFrame?.('w',STORAGE,3,frame(8) as never);
  assert.deepEqual((await f.registry.snapshot('w')).observations?.map(value=>[value.connectionEpoch,value.frame?.revision]),[[3,8],[2,7]]);
});
test('explicit preparation refreshes image readiness in the existing observation lifetime',async context=> {
  const f=await memoryRegistry(context);await f.registry.observe('w');
  context.mock.method(f.registry.agents,'prepare',async()=>({snapshot:true,'observe-open':true,'observe-frame':true,'observe-close':true,'task-submit':true}));
  let images = false; context.mock.method(f.registry.agents,'imageInputAvailable',()=>images);
  assert.equal(f.registry.availability.get('w')?.get(STORAGE)?.capabilities.images,false);
  images = true; const result=await f.registry.prepareTarget('w',{kind:'agent',identity:STORAGE});
  assert.equal(result.capabilities.images,true);
  const readiness=f.registry.availability.get('w')?.get(STORAGE);assert.equal(readiness?.connectionEpoch,1);assert.equal(readiness?.capabilities.images,true);
  assert.equal((await f.registry.snapshot('w')).observations?.[0]?.availability?.capabilities.images,true);
  assert.equal(f.calls.filter(call=>call[0]==='select').length,2);assert.equal(f.calls.some(call=>call[0]==='hide'),false);
});
test('a selection failure for an agent whose catalog row reports no live host raises no notice, and a live row still does',async context=> {
  const f=await memoryRegistry(context);
  const claims=new Map<string,string>([[STORAGE,'dead'],[CHILD,'live']]);
  context.mock.method(f.registry.agents,'rosterRow',(identity:string)=>claims.has(identity)?{id:identity,storageId:'s',cwd:'/p',claim:claims.get(identity)}:undefined as never);
  context.mock.method(f.registry.agents,'select',async()=>{throw new Error('No live compatible host.');});
  await f.registry.observe('w');
  assert.deepEqual(f.registry.journal.notices('w').map(item=>item.target),[{kind:'agent',identity:CHILD}]);
  claims.delete(CHILD);const current=f.workspaces.get('w');assert.ok(current);current.conversationLayout=agentLayout([`${STORAGE}:9`]);
  await f.registry.observe('w');
  assert.deepEqual(f.registry.journal.notices('w').map(item=>item.target),[{kind:'agent',identity:CHILD},{kind:'agent',identity:`${STORAGE}:9`}]);
});
test('pure concurrent hidden tabs do not acquire observations',async context=> {
  const f=await memoryRegistry(context);const root=f.workspaces.get('w')?.conversationLayout?.root;
  assert.ok(root?.kind==='split' && root.first.kind==='split' && root.first.second.kind==='pane');
  root.first.second.tabs.push({kind:'agent',identity:`${STORAGE}:3`});
  await f.registry.observe('w');assert.deepEqual(f.calls.filter(call=>call[0]==='select').map(call=>call[2]),[STORAGE,CHILD]);
  assert.deepEqual((await f.registry.snapshot('w')).observations?.map(value=>value.identity),[STORAGE,CHILD]);
});
test('pure concurrent last detach serializes a new attach behind workspace cleanup',async context=> {
  const f=await memoryRegistry(context);await f.registry.observe('w');const entered=deferred();const release=deferred();
  f.disconnectGate=async()=>{entered.resolve();await release.promise;};
  f.clients.set('w',0);f.registry.detached('w');await entered.promise;
  f.clients.set('w',1);const attached=f.registry.observe('w');
  f.callbacks.onFrame?.('w',STORAGE,1,frame(99) as never);release.resolve();await attached;
  assert.deepEqual(f.calls.map(call=>call[0]),['select','select','hide','hide','disconnect','select','select']);
  assert.deepEqual((await f.registry.snapshot('w')).observations?.map(value=>value.connectionEpoch),[3,4]);
  assert.equal(f.registry.frames.get('w')?.has(STORAGE) ?? false,false);
});
test('pure concurrent detach during setup releases workspace capacity without retaining history',async context=> {
  const f=await memoryRegistry(context);
  for(let i=0;i<17;i++) {
    const id=`workspace-${i}`;f.workspaces.set(id,{id,revision:0,conversationLayout:agentLayout([STORAGE])});f.clients.set(id,1);
    const entered=deferred();const release=deferred();f.selectGate=async()=>{entered.resolve();await release.promise;};
    const opening=f.registry.observe(id);await entered.promise;f.clients.set(id,0);
    const departing=f.registry.observe(id);release.resolve();await Promise.all([opening,departing]);
  }
  assert.equal(f.calls.filter(call=>call[0]==='select').length,17);assert.equal(f.calls.filter(call=>call[0]==='disconnect').length,17);
  assert.equal(f.registry.frames.size,0);assert.equal(f.registry.availability.size,0);
});
test('pure concurrent registry coalesces pending setup and refuses obsolete target work',async context=> {
  const f=await memoryRegistry(context);const entered=deferred();const release=deferred();
  f.selectGate=async(_workspace,identity)=>{if(identity===STORAGE){entered.resolve();await release.promise;}};
  const first=f.registry.observe('w');await entered.promise;
  const current=f.workspaces.get('w');assert.ok(current);current.conversationLayout=agentLayout([`${STORAGE}:3`]);
  const second=f.registry.observe('w');current.conversationLayout=agentLayout([`${STORAGE}:4`,`${STORAGE}:5`]);
  const third=f.registry.observe('w');release.resolve();await Promise.all([first,second,third]);
  assert.deepEqual(f.calls.filter(call=>call[0]==='select').map(call=>call[2]),[STORAGE,`${STORAGE}:4`,`${STORAGE}:5`]);
  assert.deepEqual(f.calls.filter(call=>call[0]==='hide'),[['hide','w',STORAGE]]);
  assert.equal(f.registry.availability.get('w')?.has(STORAGE),false);
  const active=await f.registry.snapshot('w');assert.deepEqual(active.observations?.map(value=>value.identity),[`${STORAGE}:4`,`${STORAGE}:5`]);
});

function prepareRoute(registry: Registry, workspace: string, body: Record<string,unknown>) {
  return registry.dispatch({parts:['api','workspaces',workspace,'targets'],body,method:'POST',
    url:new URL(`http://localhost/api/workspaces/${workspace}/targets`)}) as Promise<TargetPreparation>;
}

test('agent target preparation validates exact fields and workspace before native work', async context => {
  const setup = await fixture(context); const calls: string[] = []; const inert = fakeAgents()();
  setup.options.agents = () => ({...inert, prepare: async identity => {calls.push(identity); return {};}});
  const registry = await setup.open(); const workspace = await registry.store.workspace();
  const target = {kind:'agent',identity:'storage:2'};
  for(const body of [{}, {target,extra:true}, {target:{...target,extra:true}}, {target:{kind:'agent'}},
    {target:{kind:'agent',identity:3}}, {target:{kind:'primary',key:'primary',epoch:1}}, {target:null}]) {
    await assert.rejects(prepareRoute(registry,workspace.id,body), {code:'invalid_request'});
  }
  await assert.rejects(prepareRoute(registry,'missing',{target}), {code:'invalid_request',status:404});
  assert.deepEqual(calls, []); assert.equal(registry.store.snapshot(workspace.id).targets.length, 0);
  assert.deepEqual(await registry.store.workspace(workspace.id), workspace);
});

test('repeated agent preparation returns the same saved draft without selection or observation', async context => {
  const setup = await fixture(context); const calls: string[] = []; const inert = fakeAgents()();
  setup.options.agents = () => ({...inert, prepare: async identity => {calls.push(identity); return {
    snapshot:true,'observe-open':true,'observe-frame':true,'observe-close':true,'task-submit':true,abort:true,inspect:true,configure:true};}});
  const registry = await setup.open(); const workspace = await registry.store.workspace();
  const target = {kind:'agent',identity:'storage:2'};
  const first = await prepareRoute(registry,workspace.id,{target});
  await registry.store.putDraft(workspace.id,first.targetState.targetKey,{expectedRevision:0,text:'Retain this exact draft.',mode:'steer'});
  const second = await prepareRoute(registry,workspace.id,{target});
  assert.equal(second.targetState.targetKey,first.targetState.targetKey);
  assert.equal(second.targetState.draft.text,'Retain this exact draft.');
  assert.equal(second.targetState.draft.revision,1); assert.equal(second.availability,'live'); assert.equal(second.reason,undefined);
  assert.deepEqual(second.capabilities,{history:true,observe:true,input:true,images:false,abort:true,configure:true,inspect:true,commands:false});
  assert.deepEqual(await registry.store.workspace(workspace.id),workspace);
  assert.equal(registry.frames.size,0); assert.equal(registry.availability.size,0);
  assert.equal(setup.counts.started,0); assert.deepEqual(calls,['storage:2','storage:2']);
});

test('expected preparation refusals keep target drafts and disable every capability', async context => {
  const setup = await fixture(context); const inert = fakeAgents()(); let failure = new AgentError('stored','No live host.');
  setup.options.agents = () => ({...inert, prepare: async () => {throw failure;}});
  const registry = await setup.open(); const workspace = await registry.store.workspace();
  const target = {kind:'agent',identity:'storage:2'};
  const state = await registry.store.target(workspace.id,target as {kind:'agent';identity:string});
  await registry.store.putDraft(workspace.id,state.targetKey,{expectedRevision:0,text:'Safe offline draft.',mode:'followUp'});
  for(const [code,availability] of [['stored','stored'],['host_unavailable','unavailable'],['not_ready','unavailable'],
    ['capacity','unavailable'],['contract_mismatch','incompatible'],['protocol_error','incompatible'],['unsupported','incompatible']] as const) {
    failure = new AgentError(code,`Preparation refused: ${code}.`);
    const prepared = await prepareRoute(registry,workspace.id,{target});
    assert.equal(prepared.availability,availability); assert.equal(prepared.reason,failure.message);
    assert.equal(prepared.targetState.targetKey,state.targetKey); assert.equal(prepared.targetState.draft.text,'Safe offline draft.');
    assert.deepEqual(prepared.capabilities,{history:false,observe:false,input:false,images:false,abort:false,configure:false,inspect:false,commands:false});
  }
  assert.deepEqual(await registry.store.workspace(workspace.id),workspace);
  assert.equal(registry.frames.size,0); assert.equal(registry.availability.size,0); assert.equal(setup.counts.started,0);
});

test('unexpected preparation errors become public API errors', async context => {
  const setup = await fixture(context); const inert = fakeAgents()(); let failure: Error = new AgentError('invalid_request','Invalid identity.');
  setup.options.agents = () => ({...inert, prepare: async () => {throw failure;}});
  const registry = await setup.open(); const workspace = await registry.store.workspace(); const target = {kind:'agent',identity:'storage:2'};
  await assert.rejects(prepareRoute(registry,workspace.id,{target}), error => error instanceof ApiError && error.code === 'invalid_request');
  failure = new Error('Private implementation details.');
  await assert.rejects(prepareRoute(registry,workspace.id,{target}), error => error instanceof ApiError && error.code === 'internal' && !error.message.includes('Private'));
});

test('registry validates path kind and refuses stale epochs without a primary effect', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const file = join(setup.cwd, 'session.jsonl'); await writeFile(file, '{}\n');
  await assert.rejects(registry.validatePath('relative', true), {code: 'invalid_request'});
  await assert.rejects(registry.validatePath(file, true), {code: 'invalid_request'});
  await assert.rejects(registry.validatePath(setup.cwd, false), {code: 'invalid_request'});
  await assert.rejects(registry.validatePath(join(setup.cwd, 'missing'), false), {code: 'invalid_request'});
  const key = await registry.openPrimary(setup.cwd); const primary = registry.primary(key); const before: PrimaryView = structuredClone(primary.view);
  assert.throws(() => registry.primary(key, primary.view.epoch + 1, true), {code: 'stale_epoch', status: 409});
  assert.deepEqual(primary.view, before); assert.equal(setup.counts.started, 1);
  await registry.close(); await assert.rejects(registry.openPrimary(setup.cwd), {code: 'not_ready'}); assert.equal(setup.counts.started, 1);
});


test('current host identities enable input, activity inspection and configuration', async context => {
  const remote = decodeDescriptor(await descriptor());
  const supported = Object.fromEntries((Object.keys(supportedOperations) as OperationName[]).map(member => {
    try { assertOperation(remote, member); return [member, true]; } catch { return [member, false]; }
  }));
  const setup = await fixture(context); const inert = fakeAgents()(); const calls: unknown[] = [];
  setup.options.agents = () => ({...inert, prepare: async () => supported,
    inspect: async (identity, options) => { calls.push({identity, options}); return activity(identity) as Awaited<ReturnType<AgentAdapter['inspect']>>; }});
  const registry = await setup.open(); const workspace = await registry.store.workspace(); const identity = 'storage:2';
  const prepared = await prepareRoute(registry, workspace.id, {target:{kind:'agent',identity}});
  assert.deepEqual(prepared.capabilities,{history:true,observe:true,input:true,images:false,abort:true,configure:true,inspect:true,commands:true});
  const inspected = await registry.dispatch({parts:['api','agents',identity,'inspect'],body:{view:'activity',limit:20},method:'POST',
    url:new URL('http://localhost/api/agents/storage:2/inspect')}) as {identity:string;view:string};
  assert.equal(inspected.identity,identity);assert.equal(inspected.view,'activity');
  assert.deepEqual(calls,[{identity,options:{view:'activity',limit:20}}]);
  assert.equal(registry.frames.size,0); assert.equal(setup.counts.started,0);
  assert.deepEqual(await registry.store.workspace(workspace.id),workspace);
});


async function startFixture(t:TestContext,timeoutMs=30000) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'ui-registry-start-')));let retained:Registry|undefined;t.after(async()=>{await retained?.close();await rm(root,{recursive:true,force:true});});const cwd=join(root,'project');const agentDir=join(root,'agent');const store=join(root,'catalog');const durable=join(store,'durable');
  const owner=join(root,'owner');const slice=join(owner,'extensions','agent');const packageDir=join(root,'installation');const executable=join(packageDir,'dist','bundle','cli.js');
  await Promise.all([mkdir(cwd),mkdir(agentDir),mkdir(durable,{recursive:true}),mkdir(slice,{recursive:true}),mkdir(dirname(executable),{recursive:true})]);
  await Promise.all([writeFile(join(owner,'package.json'),JSON.stringify({name:'harness',pi:{extensions:['./extensions']}})),writeFile(join(slice,'index.ts'),'// inert entry'),writeFile(join(slice,'durable-runner.ts'),'// inert runner'),writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[join(slice,'index.ts')]})),writeFile(join(packageDir,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.1.0',bin:{pi:'dist/bundle/cli.js'}})),writeFile(executable,'// inert CLI',{mode:0o700})]);
  const record:CatalogRecord={storageId:STORAGE,cwd,agentDir,packageDir,storagePath:join(durable,`${STORAGE}.sqlite`),model:{provider:'fixture',modelId:'inert'},thinkingLevel:'off',trust:false,createdAt:new Date().toISOString()};
  await Promise.all([writeFile(record.storagePath,'inert storage'),writeFile(join(durable,`${STORAGE}.json`),JSON.stringify(record))]);
  const endpoint=deriveEndpoint(record);const contract=await descriptor();const remote=decodeDescriptor(contract);const supported=Object.fromEntries((Object.keys(supportedOperations) as OperationName[]).map(member=>{try{assertOperation(remote,member);return [member,true];}catch{return [member,false];}}));
  const admitted=deferred();const refreshEntered=deferred();const control:{announce:boolean;claim:boolean;refreshError?:Error;prepareError?:Error;refreshGate?:Promise<void>}={announce:true,claim:true};
  const counts={launches:0,signals:0,input:0,refresh:0,disconnect:0};const prepares:string[]=[];const selects:{workspace:string;identity?:string}[]=[];const children:ChildProcess[]=[];
  const forbidden=async():Promise<never>=>{counts.input++;throw new Error('Start must not submit input');};
  const adapter:AgentAdapter={...fakeAgents()(),refresh:async()=>{counts.refresh++;refreshEntered.resolve();await control.refreshGate;if(control.refreshError)throw control.refreshError;return empty.scan;},prepare:async identity=>{prepares.push(identity);if(control.prepareError)throw control.prepareError;return supported;},select:async(workspace,identity)=>{selects.push({workspace,identity});},submit:forbidden,retrySubmit:forbidden,disconnectWorkspace:async()=>{counts.disconnect++;}};
  const announce=()=>{const child=children[0];assert.ok(child);child.stdout?.emit('data',Buffer.from(`PI_AGENT_HOST_READY ${JSON.stringify({pid:child.pid,socketPath:endpoint.socketPath,contract})}${String.fromCharCode(10)}`));};
  const fakeSpawn=()=>{
    counts.launches++;const child=Object.assign(new ChildProcess(),{pid:process.pid,stdout:new PassThrough(),stderr:new PassThrough()});children.push(child);
    t.mock.method(child,'kill',()=>{counts.signals++;throw new Error('Start must not signal the host');});
    queueMicrotask(()=>{void(async()=>{if(control.claim){await mkdir(dirname(endpoint.claimPath),{recursive:true});await writeFile(endpoint.claimPath,JSON.stringify({sessionId:STORAGE,cwd,host:hostname(),createdAt:new Date().toISOString(),pid:process.pid}));}admitted.resolve();if(control.announce)announce();})().catch(error=>child.emit('error',error));});return child;
  };
  const registry=await Registry.open({stateDir:join(root,'ui'),cwd,executable,agentStore:store,agents:()=>adapter,agentStart:{agentDir,spawn:fakeSpawn,timeoutMs}});
  retained=registry;const workspace=await registry.store.workspace();
  return {registry,workspace,control,counts,prepares,selects,children,admitted,refreshEntered,announce};
}

test('start receipts deduplicate exact work and separate workspaces without input or draft changes',{timeout:10000},async t=>{
  const f=await startFixture(t);const target={kind:'agent' as const,identity:STORAGE};const agent=await f.registry.store.target(f.workspace.id,target);const primary=await f.registry.store.target(f.workspace.id,{kind:'primary',key:'retained-primary',epoch:1});
  await f.registry.store.putDraft(f.workspace.id,agent.targetKey,{expectedRevision:0,text:'Agent retained 🦉',mode:'steer'});await f.registry.store.putDraft(f.workspace.id,primary.targetKey,{expectedRevision:0,text:'Primary retained 🦉',mode:'prompt'});
  const saved=await Promise.all([f.registry.store.target(f.workspace.id,target),f.registry.store.target(f.workspace.id,primary.target)]);const bytes=saved.map(state=>Buffer.from(JSON.stringify(state.draft)));
  t.mock.method(f.registry.journal,'workspaceClients',(id:string)=>id===f.workspace.id?1:0);t.mock.method(f.registry.journal,'agentViews',(id:string,inherited:readonly string[])=>id===f.workspace.id?[...inherited]:[]);
  await f.registry.store.updateSelection(f.workspace.id,{expectedRevision:f.workspace.revision,selectedTarget:target,conversationLayout:agentLayout([STORAGE])});
  const first=f.registry.startAgent(f.workspace.id,STORAGE,'same-key');assert.equal(f.registry.startAgent(f.workspace.id,STORAGE,'same-key'),first);
  const result=await first;assert.equal(result.availability,'live');assert.equal(result.capabilities.input,true);assert.equal(f.counts.launches,1);assert.deepEqual(f.prepares,[STORAGE]);assert.deepEqual(f.selects,[{workspace:f.workspace.id,identity:STORAGE}]);
  assert.throws(()=>f.registry.startAgent(f.workspace.id,`${STORAGE}:2`,'same-key'),{code:'operation_conflict'});assert.equal(f.registry.startAgent(f.workspace.id,STORAGE,'same-key'),first);assert.deepEqual(f.prepares,[STORAGE]);
  const second=await f.registry.store.createWorkspace();const separate=f.registry.startAgent(second.id,STORAGE,'same-key');assert.notEqual(separate,first);const other=await separate;assert.equal(other.targetState.targetKey,(await f.registry.store.target(second.id,target)).targetKey);assert.notEqual(other.targetState.targetKey,result.targetState.targetKey);assert.deepEqual(f.prepares,[STORAGE,STORAGE]);assert.equal(f.counts.launches,1);
  for(let i=0;i<saved.length;i++)assert.deepEqual(Buffer.from(JSON.stringify((await f.registry.store.target(f.workspace.id,saved[i].target)).draft)),bytes[i]);
  assert.deepEqual((await f.registry.store.workspace(f.workspace.id)).selectedTarget,target);assert.equal(f.counts.input,0);assert.equal(f.counts.signals,0);
});

test('conversations share acquisition while each receipt prepares its exact target',{timeout:10000},async t=>{
  const f=await startFixture(t);const child=`${STORAGE}:2`;const results=await Promise.all([f.registry.startAgent(f.workspace.id,STORAGE,'root'),f.registry.startAgent(f.workspace.id,child,'child')]);
  assert.equal(f.counts.launches,1);assert.deepEqual(f.prepares.sort(),[STORAGE,child]);assert.deepEqual(results.map(result=>result.targetState.target),[{kind:'agent',identity:STORAGE},{kind:'agent',identity:child}]);assert.ok(results.every(result=>result.capabilities.input));assert.equal(f.counts.input,0);assert.equal(f.counts.signals,0);
});

for(const stage of ['refresh','prepare'] as const)test(`post-readiness ${stage} failure retains the receipt and permits only attach checks`,{timeout:10000},async t=>{
  const f=await startFixture(t);const error=new Error('inert connection failure');if(stage==='refresh')f.control.refreshError=error;else f.control.prepareError=error;
  const first=f.registry.startAgent(f.workspace.id,STORAGE,'uncertain');await assert.rejects(first,stage==='refresh'?error:{code:'not_ready'});assert.equal(f.registry.startAgent(f.workspace.id,STORAGE,'uncertain'),first);await assert.rejects(first);
  assert.equal(f.counts.launches,1);assert.equal(f.counts.refresh,1);assert.equal(f.prepares.length,stage==='refresh'?0:1);assert.equal(f.selects.length,0);
  f.control.refreshError=undefined;f.control.prepareError=undefined;const checked=await f.registry.prepareTarget(f.workspace.id,{kind:'agent',identity:STORAGE});assert.equal(checked.availability,'live');assert.equal(f.counts.launches,1);assert.equal(f.registry.startAgent(f.workspace.id,STORAGE,'uncertain'),first);assert.equal(f.counts.signals,0);assert.equal(f.counts.input,0);
});

test('browser detach leaves the admitted start and its receipt intact',{timeout:10000},async t=>{
  const f=await startFixture(t);f.control.announce=false;const first=f.registry.startAgent(f.workspace.id,STORAGE,'detached');await f.admitted.promise;
  f.registry.detached(f.workspace.id);await f.registry.observe(f.workspace.id);assert.equal(f.counts.disconnect,1);f.announce();assert.equal((await first).capabilities.input,true);assert.equal(f.registry.startAgent(f.workspace.id,STORAGE,'detached'),first);assert.equal(f.counts.launches,1);assert.equal(f.counts.signals,0);assert.equal(f.counts.input,0);
});

for(const stage of ['readiness','refresh'] as const)test(`backend shutdown during ${stage} never stops or relaunches the host`,{timeout:10000},async t=>{
  const f=await startFixture(t);const gate=deferred();if(stage==='readiness')f.control.announce=false;else f.control.refreshGate=gate.promise;
  const first=f.registry.startAgent(f.workspace.id,STORAGE,'shutdown');const rejected=assert.rejects(first,{code:'not_ready'});await(stage==='readiness'?f.admitted.promise:f.refreshEntered.promise);
  await f.registry.close();gate.resolve();await rejected;assert.throws(()=>f.registry.startAgent(f.workspace.id,STORAGE,'shutdown'),{code:'not_ready'});assert.throws(()=>f.registry.startAgent(f.workspace.id,STORAGE,'another-key'),{code:'not_ready'});assert.equal(f.counts.launches,1);assert.equal(f.counts.signals,0);assert.equal(f.counts.input,0);
});

test('selection changes before readiness do not observe the old recipient',{timeout:10000},async t=>{
  for(const replaceSelection of [false,true]) {
    const f=await startFixture(t);f.control.announce=false;
    const target={kind:'agent' as const,identity:STORAGE},initialLayout=agentLayout([STORAGE]);
    t.mock.method(f.registry.journal,'workspaceClients',(id:string)=>id===f.workspace.id?1:0);t.mock.method(f.registry.journal,'agentViews',(id:string,inherited:readonly string[])=>id===f.workspace.id?[...inherited]:[]);
    await f.registry.store.updateSelection(f.workspace.id,{expectedRevision:f.workspace.revision,selectedTarget:target,conversationLayout:initialLayout});
    const initial=await f.registry.snapshot(f.workspace.id);
    assert.equal(f.registry.journal.workspaceClients(f.workspace.id),1);assert.ok(initial.observations);
    assert.deepEqual(initial.observations.map(observation=>observation.identity),[STORAGE]);
    const first=f.registry.startAgent(f.workspace.id,STORAGE,'changed-selection');await f.admitted.promise;
    assert.deepEqual(f.selects,[]);
    const other={kind:'primary' as const,key:'another-primary',epoch:1},replacementLayout=agentLayout([]);
    if(replaceSelection) await f.registry.store.updateSelection(f.workspace.id,{expectedRevision:initial.workspace.revision,selectedTarget:other,conversationLayout:replacementLayout});
    f.announce();const result=await first;assert.equal(result.availability,'live');
    assert.equal(f.counts.launches,1);assert.deepEqual(f.prepares,[STORAGE]);
    const current=await f.registry.store.workspace(f.workspace.id);
    if(replaceSelection) {
      assert.deepEqual(f.selects,[]);
      assert.deepEqual(current.selectedTarget,other);assert.deepEqual(current.conversationLayout,replacementLayout);
    } else {
      assert.deepEqual(f.selects,[{workspace:f.workspace.id,identity:STORAGE}]);
      assert.deepEqual(current.selectedTarget,target);assert.deepEqual(current.conversationLayout,initialLayout);
    }
    assert.equal(f.counts.input,0);assert.equal(f.counts.signals,0);
  }
});

for(const state of ['hidden','stored'] as const)test(state==='hidden'?'a hidden selected agent returns live capabilities without observation':'a stored result disables input and never selects observation',{timeout:10000},async t=>{
  const f=await startFixture(t);await f.registry.store.updateSelection(f.workspace.id,{expectedRevision:0,selectedTarget:{kind:'agent',identity:STORAGE},panelVisible:state!=='hidden'});if(state==='stored')f.control.prepareError=new AgentError('stored','inert stored outcome');
  const result=await f.registry.startAgent(f.workspace.id,STORAGE,'availability');assert.deepEqual(f.selects,[]);assert.equal(result.availability,state==='stored'?'stored':'live');assert.equal(result.capabilities.input,state!=='stored');assert.equal(f.counts.input,0);assert.equal(f.counts.signals,0);
});

test('receipt capacity refuses new work without evicting an uncertain outcome',{timeout:30000},async t=>{
  const f=await startFixture(t,100);f.control.announce=false;f.control.claim=false;const first=f.registry.startAgent(f.workspace.id,STORAGE,'uncertain-0');await assert.rejects(first,{code:'not_ready'});
  for(let i=1;i<2048;i++)await assert.rejects(f.registry.startAgent(f.workspace.id,STORAGE,`uncertain-${i}`),{code:'not_ready'});
  assert.throws(()=>f.registry.startAgent(f.workspace.id,STORAGE,'overflow'),{code:'capacity'});assert.equal(f.registry.startAgent(f.workspace.id,STORAGE,'uncertain-0'),first);await assert.rejects(first,{code:'not_ready'});assert.equal(f.counts.launches,1);assert.equal(f.counts.refresh,0);assert.deepEqual(f.prepares,[]);assert.equal(f.counts.signals,0);assert.equal(f.counts.input,0);
});

const TERMINAL_ID = '3f2b8c1e-5d4a-4e7b-9c60-1a2b3c4d5e6f';
const deadPid = () => { const child = spawnSync(process.execPath, ['-e', ''], {stdio: 'ignore'}); assert.ok(child.pid); return child.pid; };
async function terminalRecord(setup: Awaited<ReturnType<typeof fixture>>, file: string, overrides: Record<string, unknown> = {}) {
  const directory = join(setup.options.agentStore, '.primaries'); await mkdir(directory, {recursive: true});
  const path = join(directory, `${TERMINAL_ID}.json`);
  await writeFile(path, JSON.stringify({id: TERMINAL_ID, sessionFile: file, cwd: setup.cwd, pid: process.pid, hostname: hostname(), ...overrides}));
  return path;
}
async function terminalSession(setup: Awaited<ReturnType<typeof fixture>>) {
  const file = join(setup.cwd, 'terminal.jsonl'); await writeFile(file, sessionHeader(setup.cwd, TERMINAL_ID)); return realpath(file);
}

test('a saved file a terminal session writes is refused until its record shows release', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const file = await terminalSession(setup);
  const record = await terminalRecord(setup, file);
  await assert.rejects(registry.openPrimary(setup.cwd, file), {code: 'writer_active', status: 409, message: 'A terminal session is writing this file. Resume when it ends.'});
  assert.equal(setup.counts.started, 0); assert.equal(registry.sessions.size, 0);
  await unlink(record);
  await registry.openPrimary(setup.cwd, file); assert.equal(setup.counts.started, 1);
});

test('only a dead local publisher proves release; every other record keeps the file held', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const file = await terminalSession(setup);
  for (const overrides of [{hostname: 'another-host.invalid'}, {pid: 'not-a-pid'}, {pid: 0}]) {
    await terminalRecord(setup, file, overrides);
    await assert.rejects(registry.openPrimary(setup.cwd, file), {code: 'writer_active'}, JSON.stringify(overrides));
  }
  await writeFile(join(setup.options.agentStore, '.primaries', `${TERMINAL_ID}.json`), '{not json');
  await assert.rejects(registry.openPrimary(setup.cwd, file), {code: 'writer_active'});
  await terminalRecord(setup, file, {pid: deadPid()});
  await registry.openPrimary(setup.cwd, file); assert.equal(setup.counts.started, 1);
});

test('a record that names another file does not hold this one', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const file = await terminalSession(setup);
  await terminalRecord(setup, join(setup.cwd, 'elsewhere.jsonl'));
  await registry.openPrimary(setup.cwd, file); assert.equal(setup.counts.started, 1);
});

test('saved lists mark held files and leave files this backend owns unmarked', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const file = await terminalSession(setup);
  const item = {id: TERMINAL_ID, path: file, revision: 'r', project: setup.cwd, title: 'Terminal', modifiedAt: new Date().toISOString(), size: 1};
  const page = {items: [item], total: 1, omitted: 0, nextCursor: null, titleCursor: null, observedAt: new Date().toISOString()};
  assert.equal((await registry.withWriters(page)).items[0]?.writer, undefined);
  const record = await terminalRecord(setup, file);
  assert.equal((await registry.withWriters(page)).items[0]?.writer, 'live');
  await unlink(record);
  assert.equal((await registry.withWriters(page)).items[0]?.writer, undefined);
  await registry.openPrimary(setup.cwd, file); await terminalRecord(setup, file);
  assert.equal((await registry.withWriters(page)).items[0]?.writer, undefined, 'the primary this backend owns is not a terminal writer');
});

test('a primary that already owns a file may claim it again without its own record refusing it', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const file = await terminalSession(setup);
  const key = await registry.openPrimary(setup.cwd, file); await terminalRecord(setup, file);
  await registry.claimPath(file, key); assert.equal(setup.counts.started, 1);
});

test('a held file that its terminal releases publishes one sessions.writers event', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const file = await terminalSession(setup);
  const item = {id: TERMINAL_ID, path: file, revision: 'r', project: setup.cwd, title: 'Terminal', modifiedAt: new Date().toISOString(), size: 1};
  const page = {items: [item], total: 1, omitted: 0, nextCursor: null, titleCursor: null, observedAt: new Date().toISOString()};
  const record = await terminalRecord(setup, file);
  const released = new Promise<string[]>(resolve => { const publish = registry.journal.publish.bind(registry.journal); registry.journal.publish = ((name: string, target: unknown, data: {released?: string[]}, workspace?: string) => { if (name === 'sessions.writers') resolve(data.released ?? []); return (publish as (...input: unknown[]) => string)(name, target, data, workspace); }) as typeof registry.journal.publish; });
  assert.equal((await registry.withWriters(page)).items[0]?.writer, 'live');
  await unlink(record);
  // The saved-list read a focus or Refresh triggers re-checks held files, so the test does not depend on a directory event.
  assert.equal((await registry.withWriters(page)).items[0]?.writer, undefined);
  assert.deepEqual(await released, [TERMINAL_ID]);
});
