import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {FakeChild} from '../rpc/fake-child.mts';
import {PrimarySession} from '../rpc/session.mts';
import type {RpcRecord} from '../rpc/client.mts';
import {deriveEndpoint, type CatalogRecord} from '../agents/catalog-record.mts';
import {FakeHost, STORAGE, deferred, receipt, type FakeCall, type FakeHostOptions} from '../agents/fake-host.mts';
import type {DraftImage, ImageUploadView, OperationView, Target} from '../shared/api.ts';
import type {RequestContext} from './http.mts';
import {Registry} from './registry.mts';
import {StateStore} from './state.mts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function context(workspace: string, path: string, body: Record<string, unknown> = {}, operationId?: string): RequestContext {
  return {workspace, parts: path.split('/').filter(Boolean), url: new URL(path, 'http://localhost'), method: 'POST', body, operationId};
}
async function upload(registry: Registry, workspace: string, target: Target, name = 'pixel.png') {
  const state = await registry.store.target(workspace, target);
  const path = `/api/workspaces/${workspace}/targets/${state.targetKey}/images`;
  const url = new URL(`${path}?name=${name}${target.kind === 'primary' ? `&epoch=${target.epoch}` : ''}`, 'http://localhost');
  const result = await registry.uploadImage({...context(workspace, path), url, signal: new AbortController().signal, checkActive() {}},
    {mimeType: 'image/png', declaredBytes: png.length}, (async function* () {yield png;})()) as ImageUploadView;
  assert.equal(result.image.digest, digest(png));
  return {state, image: result.image};
}
async function sendDraft(registry: Registry, workspace: string, target: Target, text: string, mode: 'prompt' | 'steer' | 'followUp', images: DraftImage[]) {
  const state = await registry.store.target(workspace, target);
  const draft = await registry.store.putDraft(workspace, state.targetKey, {expectedRevision: state.draft.revision, text, mode, images});
  const kind = target.kind === 'primary' ? 'primary.input' : 'agent.input';
  const operation = await registry.operations.reserve(workspace, kind, target);
  const path = target.kind === 'primary' ? `/api/primaries/${target.key}/inputs` : `/api/agents/${target.identity}/inputs`;
  const body = {message: text, mode, images, draftRevision: draft.revision, ...(target.kind === 'primary' ? {epoch: target.epoch} : {})};
  return {operation, body, state, result: registry.dispatch(context(workspace, path, body, operation.id)) as Promise<OperationView>};
}
async function primaryFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-image-dispatch-')); const cwd = join(root, 'project'); await mkdir(cwd);
  const stateDir = join(root, 'state'); const child = new FakeChild(); const ready = deferred<void>();
  let disposition: 'started' | 'queued' | 'handled' = 'queued';
  let queue = {steering: [] as string[], followUp: [] as string[]};
  let promptHook: ((record: RpcRecord) => void) | undefined;
  let clears = 0;
  const sessionFile = join(cwd, 'session.jsonl'); await writeFile(sessionFile, `${JSON.stringify({type: 'session', version: 3, id: 'image-fixture', timestamp: new Date().toISOString(), cwd})}\n`);
  child.onCommand = record => {
    switch (record.type) {
      case 'get_state': child.response(record, {sessionId: 'image-fixture', sessionFile, isStreaming: false, isCompacting: false,
        pendingMessageCount: queue.steering.length + queue.followUp.length, model: {provider: 'fixture', id: 'image', name: 'Image', reasoning: false, input: ['text', 'image']}}); return;
      case 'prompt':
        if (promptHook) {promptHook(record); return;}
        if (disposition === 'queued') queue[record.streamingBehavior === 'followUp' ? 'followUp' : 'steering'].push(String(record.message));
        child.response(record, {disposition}); return;
      case 'clear_queue': {clears++; const returned = queue; queue = {steering: [], followUp: []}; child.response(record, returned); return;}
      default: child.defaults(record);
    }
  };
  const registry = await Registry.open({stateDir, cwd, executable: 'unused', agentStore: join(root, 'agents'), primary: options => {
    const session = new PrimarySession({...options, spawnChild: child.spawn});
    const start = session.start.bind(session); session.start = () => start().then(() => ready.resolve(), error => {ready.reject(error); throw error;});
    return session;
  }});
  t.after(async () => {child.exit(0); await registry.close(); await rm(root, {recursive: true, force: true});});
  const workspace = await registry.store.workspace(); const key = await registry.openPrimary(cwd, undefined, workspace.id); await ready.promise;
  const session = registry.primary(key); const target = session.target;
  return {registry, workspace: workspace.id, session, target, child, stateDir, get clears() {return clears;},
    disposition(value: typeof disposition) {disposition = value;}, prompt(value: typeof promptHook) {promptHook = value;}};
}
function assertNativeImages(record: RpcRecord | undefined, text: string, mode: 'prompt' | 'steer' | 'followUp') {
  assert.ok(record); assert.equal(record.type, 'prompt'); assert.equal(record.message, text);
  assert.equal(record.streamingBehavior, mode === 'prompt' ? undefined : mode);
  const images = record.images as {type: string; mimeType: string; data: string}[];
  assert.equal(images.length, 1); assert.equal(images[0]?.type, 'image'); assert.equal(images[0]?.mimeType, 'image/png');
  assert.equal(digest(Buffer.from(images[0]?.data ?? '', 'base64')), digest(png));
}

test('image prompt routes preserve exact bytes, modes and distinct admission receipts', {timeout: 15000}, async t => {
  const f = await primaryFixture(t); const {state, image} = await upload(f.registry, f.workspace, f.target);
  for (const [mode, disposition, text] of [['prompt', 'started', 'explain'], ['steer', 'queued', ''], ['followUp', 'handled', 'inspect']] as const) {
    f.disposition(disposition);
    const sent = await sendDraft(f.registry, f.workspace, f.target, text, mode, [image]); const result = await sent.result;
    assert.equal(result.state, 'accepted'); assert.equal(result.receipt?.kind, 'rpc');
    if (result.receipt?.kind === 'rpc') assert.equal(result.receipt.disposition, disposition);
    assertNativeImages(f.child.writes.filter(value => value.type === 'prompt').at(-1), text, mode);
    const saved = await f.registry.store.getTarget(f.workspace, state.targetKey);
    assert.equal(saved.draft.images.length, disposition === 'handled' ? 1 : 0);
    if (disposition !== 'started') {
      const copy = await f.registry.store.getRetainedInput(f.workspace, sent.operation.id);
      assert.equal(copy.admission, disposition === 'queued' ? 'queued-image' : 'handled-image'); assert.deepEqual(copy.images, [image]);
    }
  }
});

for (const action of ['stop', 'handoff', 'close'] as const) {
  test(`${action} retains complete image operations before native queue clearance`, {timeout: 15000}, async t => {
    const f = await primaryFixture(t); const {state, image} = await upload(f.registry, f.workspace, f.target);
    const sent = await sendDraft(f.registry, f.workspace, f.target, '', 'followUp', [image]); await sent.result;
    const begin = f.registry.operations.beginQueueClear.bind(f.registry.operations);
    let clearId = '';
    t.mock.method(f.registry.operations, 'beginQueueClear', async (...args: Parameters<typeof begin>) => {
      assert.equal(f.clears, 0); assert.equal(args[2], 1);
      clearId = await begin(...args); assert.deepEqual(f.registry.store.record(clearId).queueClear?.imageCopies, [{workspaceId: f.workspace, operationId: sent.operation.id}]);
      return clearId;
    });
    if (action === 'stop') await f.session.stop();
    else if (action === 'handoff') assert.ok((await f.session.handoff({epoch: f.target.epoch, mode: 'abort', clearQueue: true})).command);
    else await f.registry.close();
    assert.equal(f.clears, 1);
    const store = action === 'close' ? await StateStore.open(f.stateDir) : f.registry.store;
    try {
      const anchor = store.record(clearId); assert.equal(anchor.queueClear?.phase, 'retained');
      const copy = await store.getRetainedInput(f.workspace, sent.operation.id); assert.deepEqual(copy.images, [image]); assert.equal(copy.admission, 'queued-image');
      const saved = await store.getTarget(f.workspace, state.targetKey); assert.equal(saved.unconfirmed.length, 1);
      const row = saved.unconfirmed[0]; assert.ok(row); assert.equal(row.text, ''); assert.equal(row.queueRecovery?.clearOperationId, clearId); assert.equal(row.sendGuard?.state, 'blocked');
      assert.equal(saved.retainedInputs.length, 1); assert.deepEqual(Buffer.from((await store.readDraftImage(f.workspace, state.targetKey, image.digest)).data), png);
    } finally {if (action === 'close') await store.close();}
  });
}

test('a failed durable pre-clear barrier prevents native clearance and preserves the image operation', {timeout: 15000}, async t => {
  const f = await primaryFixture(t); const {image} = await upload(f.registry, f.workspace, f.target);
  const sent = await sendDraft(f.registry, f.workspace, f.target, 'same text', 'steer', [image]); await sent.result;
  const guard = t.mock.method(f.registry.operations, 'beginQueueClear', async () => {throw new Error('retention unavailable');});
  await assert.rejects(f.session.stop(), /retention unavailable/); assert.equal(f.clears, 0);
  assert.equal(f.child.writes.some(value => value.type === 'abort'), false);
  assert.deepEqual((await f.registry.store.getRetainedInput(f.workspace, sent.operation.id)).images, [image]);
  guard.mock.restore();
});

test('queue persistence retries reuse the durable clear identity and never duplicate returned rows', {timeout: 15000}, async t => {
  const f = await primaryFixture(t); const {state, image} = await upload(f.registry, f.workspace, f.target);
  const sent = await sendDraft(f.registry, f.workspace, f.target, 'same text', 'steer', [image]); await sent.result;
  const retain = f.registry.operations.retainQueue.bind(f.registry.operations); const ids: string[] = []; let fail = true;
  t.mock.method(f.registry.operations, 'retainQueue', async (id: string, queue: {steering: string[]; followUp: string[]}) => {
    ids.push(id); await retain(id, queue); if (fail) {fail = false; throw new Error('response lost after retention');}
  });
  await assert.rejects(f.session.stop()); assert.equal(f.clears, 1);
  await f.session.stop(); assert.equal(ids[0], ids[1]); assert.equal(f.clears, 2);
  const saved = await f.registry.store.getTarget(f.workspace, state.targetKey);
  assert.equal(saved.unconfirmed.length, 1); assert.equal(saved.unconfirmed[0]?.queueRecovery?.clearOperationId, ids[0]);
  assert.deepEqual(saved.retainedInputs.map(copy => copy.operationId), [sent.operation.id]);
});

test('image refusal after a newer edit retains the complete submitted copy without admission proof', {timeout: 15000}, async t => {
  const f = await primaryFixture(t); const {state, image} = await upload(f.registry, f.workspace, f.target); const entered = deferred<RpcRecord>();
  f.prompt(record => entered.resolve(record));
  const sent = await sendDraft(f.registry, f.workspace, f.target, 'original', 'prompt', [image]); const native = await entered.promise;
  await f.registry.store.putDraft(f.workspace, state.targetKey, {expectedRevision: 1, text: 'newer', mode: 'prompt', images: []});
  f.child.reject(native); const result = await sent.result; assert.equal(result.state, 'rejected');
  const copy = await f.registry.store.getRetainedInput(f.workspace, sent.operation.id);
  assert.equal(copy.admission, 'refused'); assert.deepEqual(copy.images, [image]); assert.equal(copy.text, 'original'); assert.equal('receipt' in copy, false);
  assert.equal((await f.registry.store.getTarget(f.workspace, state.targetKey)).draft.text, 'newer');
});

async function agentFixture(t: TestContext, handler?: (call: FakeCall, host: FakeHost) => ReturnType<NonNullable<FakeHostOptions['handler']>>) {
  const root = await mkdtemp(join(tmpdir(), 'ui-agent-images-')); const cwd = join(root, 'project'); const store = join(root, 'agents'); const durable = join(store, 'durable');
  await Promise.all([mkdir(cwd), mkdir(durable, {recursive: true})]);
  const record: CatalogRecord = {storageId: STORAGE, cwd, agentDir: join(root, 'agent'), packageDir: cwd, storagePath: join(durable, `${STORAGE}.sqlite`),
    model: {provider: 'fixture', modelId: 'unknown-image-capability'}, thinkingLevel: 'off', trust: false, createdAt: new Date().toISOString()};
  await Promise.all([writeFile(record.storagePath, 'fixture'), writeFile(join(durable, `${STORAGE}.json`), JSON.stringify(record))]);
  const endpoint = deriveEndpoint(record); await mkdir(dirname(endpoint.socketPath), {recursive: true}); await mkdir(dirname(endpoint.claimPath), {recursive: true});
  await writeFile(endpoint.claimPath, JSON.stringify({sessionId: STORAGE, cwd, host: hostname(), createdAt: new Date().toISOString(), pid: process.pid}));
  const host = await FakeHost.start({endpoint, handler: call => handler?.(call, host)});
  const registry = await Registry.open({stateDir: join(root, 'state'), cwd, executable: 'unused', agentStore: store});
  t.after(async () => {await registry.close(); await host.close(); await rm(root, {recursive: true, force: true});});
  await registry.agents.refresh(); const workspace = (await registry.store.workspace()).id; const target = {kind: 'agent' as const, identity: STORAGE};
  const prepared = await registry.prepareTarget(workspace, target); assert.equal(prepared.capabilities.images, true);
  return {registry, host, workspace, target};
}

for (const kind of ['primary', 'agent'] as const) {
  test(`${kind} missing image bytes refuse before native input without text fallback`, {timeout: 15000}, async t => {
    let nativeCalls = 0;
    const f = kind === 'primary' ? await primaryFixture(t) : await agentFixture(t, call => {if (call.member === 'task-submit') nativeCalls++; return undefined;});
    const {state, image} = await upload(f.registry, f.workspace, f.target);
    const mode = f.target.kind === 'primary' ? 'prompt' : 'followUp';
    const draft = await f.registry.store.putDraft(f.workspace, state.targetKey, {expectedRevision: 0, text: 'retain this', mode, images: [image]});
    const operation = await f.registry.operations.reserve(f.workspace, kind === 'primary' ? 'primary.input' : 'agent.input', f.target);
    const path = f.target.kind === 'primary' ? `/api/primaries/${f.target.key}/inputs` : `/api/agents/${f.target.identity}/inputs`;
    const blob = join(f.registry.store.root, 'images', state.targetKey, `${image.digest}.bin`); await rm(blob);
    try {
      const result = await f.registry.dispatch(context(f.workspace, path, {message: draft.text, mode, images: [image], draftRevision: draft.revision,
        ...(f.target.kind === 'primary' ? {epoch: f.target.epoch} : {})}, operation.id)) as OperationView;
      assert.equal(result.state, 'rejected'); assert.equal(result.error?.code, 'image_unavailable');
      assert.equal('child' in f ? f.child.writes.filter(row => row.type === 'prompt').length : nativeCalls, 0);
      assert.deepEqual((await f.registry.store.getTarget(f.workspace, state.targetKey)).draft.images, [image]);
    } finally {await writeFile(blob, png);}
  });
}

test('agent text with images preserves part order and follow-up mode', {timeout: 15000}, async t => {
  const calls: FakeCall[] = []; const f = await agentFixture(t, call => {if (call.member === 'task-submit') calls.push(call); return undefined;});
  const {image} = await upload(f.registry, f.workspace, f.target);
  const sent = await sendDraft(f.registry, f.workspace, f.target, 'inspect this', 'followUp', [image]);
  assert.equal((await sent.result).state, 'accepted');
  assert.equal(calls[0]?.params?.whenBusy, 'followUp');
  const imagePath = join(f.registry.store.root, 'images', (await f.registry.store.target(f.workspace, f.target)).targetKey, `${image.digest}.bin`);
  assert.equal(calls[0]?.params?.message, `inspect this\n\nAttached image ${JSON.stringify(image.name)} (${image.mimeType}): ${imagePath}`);
});

test('agent image upload remains valid after connection support changes between chunks', {timeout: 15000}, async t => {
  const f = await agentFixture(t); const state = await f.registry.store.target(f.workspace, f.target);
  let available = true; t.mock.method(f.registry.agents, 'imageInputAvailable', () => available);
  const path = `/api/workspaces/${f.workspace}/targets/${state.targetKey}/images`;
  const body = (async function* () {yield png.subarray(0, 30); available = false; yield png.subarray(30);})();
  const result = await f.registry.uploadImage({...context(f.workspace, path), url: new URL(`${path}?name=pixel.png`, 'http://localhost'),
    signal: new AbortController().signal, checkActive() {}}, {mimeType: 'image/png', declaredBytes: png.length}, body) as ImageUploadView;
  assert.equal(result.image.digest, digest(png));
  assert.equal((await f.registry.store.getTarget(f.workspace, state.targetKey)).draft.images.length, 0);
});

test('agent image route and explicit uncertain retry preserve exact parts, key and newer draft', {timeout: 20000}, async t => {
  const calls: FakeCall[] = []; let drop = true;
  const f = await agentFixture(t, async (call, host) => {
    if (call.member !== 'task-submit') return;
    calls.push(call);
    if (drop) {drop = false; await host.disconnect(); return;}
    return {...receipt(STORAGE, String(call.params?.requestId)), deduped: true};
  });
  const {state, image} = await upload(f.registry, f.workspace, f.target);
  const sent = await sendDraft(f.registry, f.workspace, f.target, '', 'steer', [image]); const result = await sent.result;
  assert.equal(result.state, 'uncertain'); assert.deepEqual((await f.registry.store.getRetainedInput(f.workspace, sent.operation.id)).images, [image]);
  await f.registry.operations.reconcile(sent.operation.id); assert.equal(calls.length, 1);
  await f.registry.store.putDraft(f.workspace, state.targetKey, {expectedRevision: 1, text: 'newer edit', mode: 'followUp', images: []});
  const retried = await f.registry.dispatch(context(f.workspace, `/api/operations/${sent.operation.id}`, {retry: true})) as OperationView;
  assert.equal(retried.state, 'accepted'); assert.equal(retried.receipt?.kind, 'durable'); assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.params, calls[1]?.params);
  const params = calls[0]?.params; assert.ok(params); assert.equal(params.sessionId, STORAGE); assert.equal(params.origin, 'operator');
  assert.equal(params.replyTo, STORAGE); assert.equal(params.requestId, `ui:${sent.operation.id}`); assert.equal(params.whenBusy, 'steer');
  const imagePath = join(f.registry.store.root, 'images', state.targetKey, `${image.digest}.bin`);
  assert.equal(params.message, `Attached image ${JSON.stringify(image.name)} (${image.mimeType}): ${imagePath}`);
  assert.equal((await f.registry.store.getTarget(f.workspace, state.targetKey)).draft.text, 'newer edit');
});
