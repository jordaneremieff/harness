import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {PrimarySession, type PrimarySessionOptions} from './session.mts';
import {RpcError} from './client.mts';
import {FakeChild} from './fake-child.mts';
import {validateImageBytes} from '../server/images.mts';
import type {BlobReadSpec} from '../server/draft-images.mts';
import {LIMITS} from '../shared/api.ts';

function present<T>(value: T | undefined): T { assert.ok(value !== undefined); return value; }
async function assertPreparationAvailable() {
  const {session} = create(); await session.start();
  await session.client.requestPrepared('prompt', async id => { const line = `${JSON.stringify({id, type: 'prompt', message: 'capacity'})}\n`; return {line, bytes: Buffer.byteLength(line)}; }, () => {});
  await session.close();
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return {promise, resolve}; }
async function imageSource(t: TestContext): Promise<BlobReadSpec> {
  const root = await mkdtemp(join(tmpdir(), 'rpc-images-')); t.after(() => rm(root, {recursive: true, force: true}));
  const targetKey = randomUUID(); const path = join(root, 'images', targetKey); await mkdir(path, {recursive: true, mode: 0o700});
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const image = {...validateImageBytes(data, 'image/png'), name: 'sample.png'};
  await writeFile(join(path, `${image.digest}.bin`), data, {mode: 0o600}); return {root, targetKey, images: [image]};
}
function create(options: Partial<PrimarySessionOptions> = {}) {
  const child = new FakeChild(); child.modelInput = ['text', 'image']; child.onCommand = record => child.defaults(record);
  const session = new PrimarySession({key: randomUUID(), executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, publish: () => {},
    onBeforeClearQueue: async () => randomUUID(), onRecoveredQueue: async () => {}, onQueueClearFailed: async () => {}, ...options});
  return {child, session};
}
test('text-only prompts retain modes and native admission dispositions without image parts', async () => {
  const {child, session} = create(); await session.start();
  for (const mode of ['prompt', 'steer', 'followUp'] as const) for (const disposition of ['started', 'queued', 'handled']) {
    child.onCommand = record => record.type === 'prompt' ? child.response(record, {disposition}) : child.defaults(record);
    assert.deepEqual(await session.input('text', mode), {disposition});
    const record = present(child.writes.at(-1)); assert.equal(record.type, 'prompt'); assert.equal(record.images, undefined);
    assert.equal(record.streamingBehavior, mode === 'prompt' ? undefined : mode);
  }
  await session.close();
});
test('image prompts retain modes, exact bytes and every native admission disposition', async t => {
  const source = await imageSource(t); const {child, session} = create(); await session.start(); t.after(() => session.close());
  for (const mode of ['prompt', 'steer', 'followUp'] as const) for (const disposition of ['started', 'queued', 'handled']) for (const message of ['exact text', '']) {
    child.onCommand = record => record.type === 'prompt' ? child.response(record, {disposition}) : child.defaults(record);
    assert.deepEqual(await session.input(message, mode, false, source), {disposition});
    const record = present(child.writes.at(-1)); assert.equal(record.type, 'prompt'); assert.equal(record.message, message);
    assert.equal(record.streamingBehavior, mode === 'prompt' ? undefined : mode);
    const images = record.images as {type: string; data: string; mimeType: string}[];
    const actual = present(images[0]), expected = present(source.images[0]);
    assert.equal(images.length, 1); assert.equal(actual.mimeType, expected.mimeType); assert.equal(actual.type, 'image');
    assert.equal(createHash('sha256').update(Buffer.from(actual.data, 'base64')).digest('hex'), expected.digest);
  }
  assert.equal(child.writes.some(record => record.type === 'steer' || record.type === 'follow_up'), false);
});
test('image validation refuses missing retention, slash commands, incompatible models and changed blobs before native write', async t => {
  const source = await imageSource(t); const {child, session} = create(); await session.start(); t.after(() => session.close());
  for (const literal of [false, true]) await assert.rejects(session.input(' \n /fixture', 'prompt', literal, source), {code: 'unsupported', uncertain: false});
  present(session.view.model).input = ['text']; await assert.rejects(session.input('', 'prompt', false, source), {code: 'unsupported'});
  session.view.model = undefined; await assert.rejects(session.input('', 'prompt', false, source), {code: 'unsupported'});
  await session.refreshState();
  const changed = structuredClone(source); present(changed.images[0]).width++;
  await assert.rejects(session.input('', 'prompt', false, changed), {code: 'image_unavailable', uncertain: false});
  const noPersistence = create({onBeforeClearQueue: undefined}); await noPersistence.session.start();
  await assert.rejects(noPersistence.session.input('', 'prompt', false, source), {code: 'not_ready'}); noPersistence.child.exit(0);
  assert.equal(child.writes.some(record => record.type === 'prompt'), false);
  assert.deepEqual(await session.input('text remains available', 'prompt'), {disposition: 'handled'});
  assert.equal(present(child.writes.at(-1)).images, undefined);
});
test('one global reservation remains occupied until the acknowledged image frame drains', async t => {
  const source = await imageSource(t); const one = create(), two = create(); await one.session.start(); await two.session.start();
  one.child.blocked = true;
  const sent = one.session.input('', 'prompt', false, source); await one.child.command('prompt');
  await assert.rejects(two.session.input('', 'prompt', false, source), {code: 'capacity'});
  one.child.blocked = false; present(one.child.release)(); await sent;
  assert.deepEqual(await two.session.input('', 'prompt', false, source), {disposition: 'handled'});
  await one.session.close(); await two.session.close();
});
for (const action of ['stop', 'handoff', 'close', 'transition'] as const) test(`${action} cancels stale image preparation without a native prompt`, async t => {
  const source = await imageSource(t), began = deferred<void>();
  const {child, session} = create({measure: stage => { if (stage === 'rpc.prepare.start') began.resolve(); }});
  await session.start(); const send = session.input('', 'prompt', false, source); const refused = assert.rejects(send, {uncertain: false});
  await began.promise;
  if (action === 'stop') await session.stop();
  else if (action === 'close') await session.close();
  else if (action === 'handoff') await assert.rejects(session.handoff({epoch: 1, mode: 'abort', clearQueue: true}), {code: 'not_ready'});
  else await session.transition({epoch: 1, action: 'new'});
  await refused; assert.equal(child.writes.some(record => record.type === 'prompt'), false);
  await assertPreparationAvailable();
  if (action !== 'close') { await session.input('new text', 'prompt'); await session.close(); }
});
test('image preparation rechecks current model immediately before the external write', async t => {
  const source = await imageSource(t); let session!: PrimarySession;
  const pair = create({measure: stage => { if (stage === 'rpc.prepare.end') present(session.view.model).input = ['text']; }}); session = pair.session;
  await session.start(); await assert.rejects(session.input('', 'prompt', false, source), {code: 'unsupported', uncertain: false});
  assert.equal(pair.child.writes.some(record => record.type === 'prompt'), false); await session.close();
});
test('unresolved model changes reject images until an authoritative refresh', async t => {
  const source = await imageSource(t); const {child, session} = create(); await session.start();
  child.onCommand = record => { if (record.type !== 'set_model') child.defaults(record); };
  const change = session.control({epoch: 1, action: 'model', provider: 'fixture', modelId: 'new'});
  const failure = assert.rejects(change, {code: 'rpc_rejected'}); const record = await child.command('set_model');
  await assert.rejects(session.input('', 'prompt', false, source), {code: 'not_ready'});
  child.reject(record); await failure;
  await assert.rejects(session.input('', 'prompt', false, source), {code: 'not_ready'});
  await session.refreshState(); await session.input('', 'prompt', false, source); await session.close();
});
test('a state response from before a model change cannot restore stale image capability', async t => {
  const source = await imageSource(t); const {child, session} = create(); await session.start();
  const requested = deferred<import('./client.mts').RpcRecord>();
  child.onCommand = record => record.type === 'get_state' ? requested.resolve(record) : child.defaults(record);
  const refresh = session.refreshState(); const stale = await requested.promise;
  child.onCommand = record => {
    if (record.type === 'set_model') { child.modelInput = ['text']; child.response(record, {provider: 'fixture', id: 'text', reasoning: false, input: ['text']}); }
    else child.defaults(record);
  };
  await session.control({epoch: 1, action: 'model', provider: 'fixture', modelId: 'text'});
  child.response(stale, {sessionId: 'fixture', isStreaming: false, isCompacting: false, model: {provider: 'fixture', id: 'old', reasoning: false, input: ['image']}});
  await refresh; assert.deepEqual(present(session.view.model).input, ['text']);
  await assert.rejects(session.input('', 'prompt', false, source), {code: 'unsupported'}); await session.close();
});
test('process exit during image preparation releases capacity without a native prompt', async t => {
  const source = await imageSource(t), began = deferred<void>();
  const {child, session} = create({measure: stage => { if (stage === 'rpc.prepare.start') began.resolve(); }});
  await session.start(); const send = session.input('', 'prompt', false, source); const refused = assert.rejects(send, {uncertain: false});
  await began.promise; child.exit(1); await refused;
  assert.equal(child.writes.some(record => record.type === 'prompt'), false);
  await assertPreparationAvailable(); await session.close();
});
test('missing prompt disposition is uncertain and preparation capacity releases after process failure', async t => {
  const source = await imageSource(t); const {child, session} = create(); await session.start();
  child.onCommand = record => record.type === 'prompt' ? child.response(record, {}) : child.defaults(record);
  await assert.rejects(session.input('', 'prompt', false, source), {code: 'protocol_error', uncertain: true});
  child.onCommand = record => record.type === 'prompt' ? child.exit(1) : child.defaults(record);
  await assert.rejects(session.input('', 'prompt', false, source), {uncertain: true});
  await assertPreparationAvailable(); await session.close();
});
test('prepared capacity releases after drainage without waiting for native admission', async t => {
  const source = await imageSource(t), written = deferred<void>();
  const first = create({measure: stage => { if (stage === 'rpc.write.end') written.resolve(); }});
  await first.session.start(); first.child.onCommand = record => { if (record.type !== 'prompt') first.child.defaults(record); };
  const send = first.session.input('', 'prompt', false, source); const refused = assert.rejects(send, {uncertain: true});
  await written.promise; assert.equal(first.session.client.pendingCount, 1);
  await assertPreparationAvailable(); first.child.exit(1); await refused; await first.session.close();
});
test('prepared requests use the same ordered backpressured writer and bound exact frames', async () => {
  const {child, session} = create(); await session.start();
  const ready = deferred<void>(), release = deferred<void>();
  const first = session.client.requestPrepared('prompt', async id => { ready.resolve(); await release.promise; const line = `${JSON.stringify({id, type: 'prompt', message: 'prepared'})}\n`; return {line, bytes: Buffer.byteLength(line)}; }, () => {});
  await ready.promise; const next = session.client.request('get_state'); assert.equal(child.writes.some(record => record.type === 'prompt'), false);
  release.resolve(); await Promise.all([first, next]); assert.deepEqual(child.writes.slice(-2).map(record => record.type), ['prompt', 'get_state']);
  const before = child.writes.length;
  await assert.rejects(session.client.requestPrepared('prompt', async () => ({line: `${'x'.repeat(LIMITS.inputFrameBytes)}\n`, bytes: LIMITS.inputFrameBytes + 1}), () => {}), {code: 'payload_too_large', uncertain: false});
  await assert.rejects(session.client.requestPrepared('prompt', async () => { throw new RpcError('image_unavailable', 'Missing image.'); }, () => {}), {code: 'image_unavailable', uncertain: false});
  assert.equal(child.writes.length, before); assert.equal(session.client.pendingCount, 0); await session.close();
});
