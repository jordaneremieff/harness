import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, unlink, writeFile} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {createAgentService, type AgentServiceOptions} from '../agents/index.mts';
import {deriveEndpoint, type CatalogRecord} from '../agents/catalog-record.mts';
import {FakeHost, STORAGE, deferred, frame, receipt, snapshot} from '../agents/fake-host.mts';
import type {ConversationFrame} from '../agents/contract.mts';
import {LIMITS, type DraftImage, type EntryView, type MessageView, type OperationView, type Target} from '../shared/api.ts';
import {LocalHttp, type RequestContext} from './http.mts';
import {imageMessageDigest, imageReferenceMessage, sentImageAttachments, type SentImageReceipt} from './images.mts';
import {Operations} from './operations.mts';
import {projectMessage} from './projection.mts';
import {Registry} from './registry.mts';
import {dispatchView} from './routes-view.mts';
import {Journal} from './journal.mts';
import {StateStore} from './state.mts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const target: Target = {kind: 'agent', identity: STORAGE};
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-sent-images-')); let now = Date.now();
  let store = await StateStore.open(root, {now: () => now});
  t.after(async () => {await store.close(); await rm(root, {recursive: true, force: true});});
  const workspace = (await store.workspace()).id, saved = await store.target(workspace, target);
  const reservation = await store.reserveImageUpload(workspace, saved.targetKey, {name: 'pixel "one".png', mimeType: 'image/png', declaredBytes: png.length}, () => {});
  const intake = await store.beginImageUpload(reservation); await intake.write(png);
  const image = (await store.finishImageUpload(reservation, await intake.finish(), () => {})).image;
  const paths = [join(root, 'images', saved.targetKey, `${image.digest}.bin`)];
  const text = 'Inspect this picture.\nKeep this text.';
  const message = imageReferenceMessage(text, [image], paths);
  const operations = () => new Operations(store, {now: () => now});
  const send = async (outcome: 'accepted' | 'rejected' = 'accepted', fingerprint: string | undefined = imageMessageDigest(message)) => {
    const draft = await store.getTarget(workspace, saved.targetKey);
    const put = await store.putDraft(workspace, saved.targetKey, {expectedRevision: draft.draft.revision, text, images: [image], mode: 'followUp'});
    const ops = operations(), op = await ops.reserve(workspace, 'agent.input', target);
    const result = await ops.execute(op.id, {workspaceId: workspace, kind: 'agent.input', target, body: {message: text, images: [image]}, input: {targetKey: saved.targetKey, text, mode: 'followUp', images: [image], draftRevision: put.revision}}, async () => outcome === 'rejected' ? {state: 'rejected'} : {
      state: 'accepted', receipt: {kind: 'durable', identity: STORAGE, submissionId: 7, requestId: `ui:${op.id}`, deduped: false}, ...(fingerprint ? {sentImageMessageDigest: fingerprint} : {})});
    return {id: op.id, result};
  };
  return {root, workspace, saved, image, text, paths, message, send, operations, get store() {return store;},
    expire() {now += LIMITS.imageLeaseMs + 1;}, async reopen() {await store.close(); store = await StateStore.open(root, {now: () => now});}};
}
function user(text: string): MessageView {return projectMessage({role: 'user', content: text}, 'user-message');}
function entry(message: MessageView): EntryView {return {id: '1', kind: 'message', messages: [message]};}

test('file-reference formatting preserves the exact submitted string and attachment-line ranges', () => {
  const image: DraftImage = {digest: 'a'.repeat(64), name: 'a "quoted".png', mimeType: 'image/png', bytes: 10, width: 1, height: 1};
  const paths = ['/fixture/images/target/a.bin'];
  const expectedLine = `Attached image ${JSON.stringify(image.name)} (image/png): ${paths[0]}`;
  assert.equal(imageReferenceMessage('caption\n\n', [image], paths), `caption\n\n\n\n${expectedLine}`);
  assert.equal(imageReferenceMessage('', [image], paths), expectedLine);
  const images = [image, {...image, digest: 'b'.repeat(64), name: 'second.png'}];
  const canonicalPaths = images.map(item => join('/fixture', 'images', 'target', `${item.digest}.bin`));
  const message = imageReferenceMessage('🖼 Caption', images, canonicalPaths);
  const ranges = sentImageAttachments(user(message), {targetKey: 'target', images, messageDigest: imageMessageDigest(message)}, '/fixture', 'workspace');
  assert.ok(ranges); assert.equal(ranges.length, 2);
  for (const [index, range] of ranges.entries()) assert.equal(message.slice(range.start, range.end), imageReferenceMessage('', [images[index]], [canonicalPaths[index]]));
});

test('accepted image receipts retain only display provenance through cleanup, lease expiry and reopen', async t => {
  const f = await fixture(t), sent = await f.send();
  assert.equal(sent.result.state, 'accepted');
  const record = f.store.record(sent.id);
  assert.equal(record.input, undefined); assert.equal(record.retainedInput, undefined);
  assert.deepEqual(record.sentImages, {targetKey: f.saved.targetKey, images: [f.image], messageDigest: imageMessageDigest(f.message)});
  assert.equal(f.store.unresolvedInputCount(), 0);
  assert.deepEqual((await f.store.getTarget(f.workspace, f.saved.targetKey)).draft.images, []);
  await assert.rejects(f.store.getRetainedInput(f.workspace, sent.id), {code: 'unknown_operation'});
  assert.equal(f.store.operationMetadata().find(value => value.view.id === sent.id)?.protected, true);
  await assert.rejects(f.operations().remove(sent.id), {code: 'operation_conflict'});
  f.expire();
  const state = await f.store.getTarget(f.workspace, f.saved.targetKey);
  await f.store.putDraft(f.workspace, f.saved.targetKey, {expectedRevision: state.draft.revision, text: '', mode: 'followUp', images: []});
  await f.reopen();
  assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace, f.saved.targetKey, f.image.digest)).data), png);
  assert.deepEqual(await readFile(f.paths[0]), png);
  const view = user(f.message), raw = structuredClone(view.parts);
  f.store.enrichSentImages(f.workspace, target, [entry(view)]);
  assert.deepEqual(view.parts, raw); assert.equal(view.attachments?.length, 1);
  const attachment = view.attachments?.[0]; assert.ok(attachment);
  assert.equal(f.message.slice(attachment.start, attachment.end), imageReferenceMessage('', [f.image], f.paths));
  assert.deepEqual(attachment.image.attachment, {workspaceId: f.workspace, targetKey: f.saved.targetKey});
  assert.equal(attachment.image.alt, f.image.name);
});

test('the same conversation displays sent images from another workspace without rebinding their byte owner', async t => {
  const f = await fixture(t); await f.send();
  const viewer = await f.store.createWorkspace(), before = f.store.snapshot(viewer.id);
  const view = user(f.message); f.store.enrichSentImages(viewer.id, target, [entry(view)]);
  assert.equal(view.attachments?.length, 1);
  assert.deepEqual(view.attachments?.[0].image.attachment, {workspaceId: f.workspace, targetKey: f.saved.targetKey});
  assert.deepEqual(f.store.snapshot(viewer.id), before);
  await assert.rejects(f.store.readDraftImage(viewer.id, f.saved.targetKey, f.image.digest));
  assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace, f.saved.targetKey, f.image.digest)).data), png);
});

test('only a complete exact accepted user message receives attachment metadata', async t => {
  const f = await fixture(t); await f.send();
  const cases = [user(`${f.message} `), user(f.message.replace(f.image.digest, 'a'.repeat(64))), user(f.message.replace('Inspect this picture.', 'Different text.')),
    user(imageReferenceMessage('', [f.image], f.paths)), user(`Quoted:\n${f.message}`), user(f.message)];
  cases[5].role = 'assistant';
  const partial = user(f.message); partial.state = 'partial'; cases.push(partial);
  const protectedText = user(f.message); (protectedText.parts[0] as {redacted?: boolean}).redacted = true; cases.push(protectedText);
  const truncated = user(f.message); truncated.coverage = {complete: false, truncated: true, omitted: 0}; cases.push(truncated);
  const continued = user(f.message); (continued.parts[0] as {more?: unknown}).more = {entryId: '1', part: 0, offset: 0}; cases.push(continued);
  const split = user(f.message); split.parts = [{type: 'text', text: f.text}, {type: 'text', text: `\n\n${imageReferenceMessage('', [f.image], f.paths)}`}]; cases.push(split);
  for (const view of cases) {
    view.attachments = [{part: 0, start: 0, end: 1, image: {type: 'image', ...f.image, alt: 'untrusted'}}];
    f.store.enrichSentImages(f.workspace, target, [entry(view)]); assert.equal(view.attachments, undefined);
  }
  for (const [workspace, selected] of [[f.workspace, {kind: 'agent', identity: `${STORAGE}:2`}], ['other-workspace', target]] as const) {
    const view = user(f.message); f.store.enrichSentImages(workspace, selected, [entry(view)]); assert.equal(view.attachments, undefined);
  }
  const protectedSource = user(imageReferenceMessage('Bearer abcdefghijklmnopqrstuvwxyz', [f.image], f.paths));
  assert.equal(protectedSource.coverage.truncated, true);
  const receipt: SentImageReceipt = {targetKey: f.saved.targetKey, images: [f.image], messageDigest: imageMessageDigest(imageReferenceMessage('Bearer abcdefghijklmnopqrstuvwxyz', [f.image], f.paths))};
  assert.equal(sentImageAttachments(protectedSource, receipt, f.root, f.workspace), undefined);
});

test('absent or mismatched submission fingerprints never establish sent-image provenance', async t => {
  const f = await fixture(t), invalid = await f.send('accepted', 'b'.repeat(64));
  assert.equal(invalid.result.state, 'uncertain'); assert.equal(f.store.record(invalid.id).sentImages, undefined);
  const rejected = await f.send('rejected'); assert.equal(rejected.result.state, 'rejected'); assert.equal(f.store.record(rejected.id).sentImages, undefined);
  const native = await f.send('accepted', ''); assert.equal(native.result.state, 'accepted'); assert.equal(f.store.record(native.id).sentImages, undefined);
  const view = user(f.message); f.store.enrichSentImages(f.workspace, target, [entry(view)]); assert.equal(view.attachments, undefined);
});

test('a missing receipt-owned image stays missing after reopen without fabricated bytes', async t => {
  const f = await fixture(t), sent = await f.send(); f.expire(); await unlink(f.paths[0]); await f.reopen();
  assert.ok(f.store.record(sent.id).sentImages);
  await assert.rejects(f.store.readDraftImage(f.workspace, f.saved.targetKey, f.image.digest), {code: 'image_unavailable'});
  await assert.rejects(readFile(f.paths[0]), {code: 'ENOENT'});
});

test('invalid saved receipt metadata preserves the refused record and prevents image cleanup', async t => {
  const f = await fixture(t), sent = await f.send(); f.expire();
  const path = join(f.root, 'operations', `${sent.id}.json`);
  const raw = JSON.parse(await readFile(path, 'utf8')); raw.sentImages = null;
  const content = JSON.stringify(raw); await writeFile(path, content); await f.reopen();
  assert.throws(() => f.store.record(sent.id), {code: 'unknown_operation'});
  assert.equal(await readFile(path, 'utf8'), content); assert.deepEqual(await readFile(f.paths[0]), png);
});

test('attachment enrichment respects its display byte budget without changing source parts', async t => {
  const f = await fixture(t); await f.send();
  const view = user(f.message), parts = structuredClone(view.parts);
  f.store.enrichSentImages(f.workspace, target, [entry(view)], 1); assert.equal(view.attachments, undefined);
  const rows = Array.from({length: 100}, () => entry(user(f.message)));
  f.store.enrichSentImages(f.workspace, target, rows, 1500);
  assert.ok(rows.some(value => value.messages?.[0].attachments));
  assert.ok(rows.some(value => !value.messages?.[0].attachments));
  assert.deepEqual(view.parts, parts);
});

test('saved receipt images use exact target-owned same-origin raster delivery', async t => {
  const f = await fixture(t); await f.send(); f.expire(); await f.reopen();
  const registry = {store: f.store} as Registry;
  const http = new LocalHttp({journal: new Journal(), workspace: async () => f.workspace, observe: async () => {}, detached: () => {}, dispatch: context => dispatchView(registry, context)}, new Map());
  const base = new URL(await http.listen(0)); t.after(() => http.close());
  const path = `/api/workspaces/${f.workspace}/targets/${f.saved.targetKey}/images/${f.image.digest}`;
  const response = await fetch(new URL(path, base)); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') ?? '', /img-src 'self'/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  const other = await f.store.createWorkspace(), otherTarget = await f.store.target(other.id, target);
  const invalid = [path.replace(f.workspace, other.id), path.replace(f.saved.targetKey, otherTarget.targetKey), path.replace(f.image.digest, 'z'.repeat(64)),
    `${path}?path=private`, `${path}/extra`, path.replace('/targets/', '/other/')];
  for (const url of invalid) assert.notEqual((await fetch(new URL(url, base))).status, 200, url);
  const changed = Buffer.from(png); changed[50] ^= 1; await writeFile(f.paths[0], changed);
  assert.equal((await fetch(new URL(path, base))).status, 409);
});

function context(workspace: string, path: string, body: Record<string, unknown>, operationId?: string): RequestContext {
  return {workspace, method: 'POST', parts: path.split('/').filter(Boolean), url: new URL(path, 'http://localhost'), body, operationId};
}
test('accepted file-reference admission re-enriches an earlier cached frame without a native revision change', {timeout: 15000}, async t => {
  const root = await mkdtemp('/tmp/ui-sent-'), stateDir = join(root, 'state'), store = join(root, 'agents');
  const durable = join(store, 'durable'), agentDir = join(root, 'agent');
  await mkdir(durable, {recursive: true});
  const record: CatalogRecord = {storageId: STORAGE, cwd: root, agentDir, packageDir: root, storagePath: join(durable, `${STORAGE}.sqlite`), model: {provider: 'fixture', modelId: 'image'}, thinkingLevel: 'off', createdAt: new Date().toISOString()};
  await writeFile(record.storagePath, 'fixture'); await writeFile(join(durable, `${STORAGE}.json`), JSON.stringify(record));
  const endpoint = deriveEndpoint(record); await mkdir(dirname(endpoint.socketPath), {recursive: true}); await mkdir(dirname(endpoint.claimPath), {recursive: true});
  await writeFile(endpoint.claimPath, JSON.stringify({sessionId: STORAGE, cwd: root, host: hostname(), createdAt: record.createdAt, pid: process.pid}));
  const held = deferred<ReturnType<typeof receipt>>(); let submitted = '';
  const host = await FakeHost.start({endpoint, handler: call => {
    if (call.member === 'task-submit') {assert.equal(typeof call.params?.message, 'string'); submitted = String(call.params?.message); return held.promise;}
    if (call.member === 'snapshot') return {...snapshot(), entries: submitted ? [{id: '1', kind: 'message', model: [{role: 'user', content: submitted}]}] : []};
  }});
  let callbacks!: AgentServiceOptions;
  const registry = await Registry.open({stateDir, cwd: root, executable: 'unused', agentStore: store, agents: options => {callbacks = options; return createAgentService(options);}});
  t.after(async () => {held.resolve(receipt(STORAGE, 'unused')); await registry.close(); await host.close(); await rm(root, {recursive: true, force: true});});
  await registry.agents.refresh(); const workspace = (await registry.store.workspace()).id;
  const prepared = await registry.prepareTarget(workspace, target), key = prepared.targetState.targetKey;
  const reservation = await registry.store.reserveImageUpload(workspace, key, {name: 'pixel.png', mimeType: 'image/png', declaredBytes: png.length}, () => {});
  const intake = await registry.store.beginImageUpload(reservation); await intake.write(png);
  const image = (await registry.store.finishImageUpload(reservation, await intake.finish(), () => {})).image;
  const draft = await registry.store.putDraft(workspace, key, {expectedRevision: 0, text: 'caption', images: [image], mode: 'followUp'});
  const current = await registry.store.workspace(workspace);
  await registry.store.updateSelection(workspace, {expectedRevision: current.revision, conversationLayout: {root: {kind: 'pane', id: 'agent', tabs: [{kind: 'agent', identity: STORAGE}], active: `agent:${STORAGE}`}, focusedPane: 'agent'}});
  t.mock.method(registry.journal, 'workspaceClients', () => 1); t.mock.method(registry.journal, 'agentViews', () => [STORAGE]); await registry.observe(workspace);
  const operation = await registry.operations.reserve(workspace, 'agent.input', target);
  const result = registry.dispatch(context(workspace, `/api/agents/${STORAGE}/inputs`, {message: draft.text, mode: draft.mode, images: [image], draftRevision: draft.revision}, operation.id)) as Promise<OperationView>;
  await host.waitForCall(call => call.member === 'task-submit');
  const expected = `caption\n\nAttached image "pixel.png" (image/png): ${join(stateDir, 'images', key, `${image.digest}.bin`)}`;
  assert.equal(submitted, expected); assert.equal(registry.store.record(operation.id).sentImages, undefined);
  const epoch = registry.availability.get(workspace)?.get(STORAGE)?.connectionEpoch; assert.ok(epoch);
  const source = {...frame(9), entries: [{id: '1', kind: 'message', model: [{role: 'user', content: submitted}]}]};
  const cursor = registry.journal.cursor;
  callbacks.onFrame?.(workspace, STORAGE, epoch, source as unknown as ConversationFrame);
  const published = registry.journal.replay(cursor, workspace).records.find(value => value.name === 'agent.frame'); assert.ok(published);
  const envelope = structuredClone(published.envelope), wire = published.wire;
  const cached = registry.frames.get(workspace)?.get(STORAGE); assert.ok(cached);
  const before = structuredClone(cached);
  assert.equal(before.frame.entries[0].messages?.[0].attachments, undefined);
  const viewer = await registry.store.createWorkspace();
  registry.frames.set(viewer.id, new Map([[STORAGE, {...structuredClone(before), connectionEpoch: epoch + 1}]]));
  held.resolve(receipt(STORAGE, `ui:${operation.id}`));
  const accepted = await result; assert.equal(accepted.state, 'accepted'); assert.equal('sentImageMessageDigest' in accepted, false);
  const after = registry.frames.get(workspace)?.get(STORAGE); assert.ok(after);
  assert.equal(after.frame.revision, before.frame.revision); assert.equal(after.frame.observedAt, before.frame.observedAt); assert.equal(after.connectionEpoch, before.connectionEpoch);
  assert.ok(after.frame.attachmentRevision !== undefined);
  assert.ok(after.frame.attachmentRevision > (before.frame.attachmentRevision ?? 0)); assert.equal(after.frame.entries[0].messages?.[0].attachments?.length, 1);
  assert.deepEqual(after.frame.entries[0].messages?.[0].parts, before.frame.entries[0].messages?.[0].parts);
  assert.deepEqual(published.envelope, envelope); assert.equal(published.wire, wire);
  assert.ok(wire.includes(`data: ${JSON.stringify(published.envelope)}\n`));
  const otherView = registry.frames.get(viewer.id)?.get(STORAGE); assert.ok(otherView);
  assert.equal(otherView.connectionEpoch, epoch + 1); assert.equal(otherView.frame.revision, before.frame.revision);
  assert.equal(otherView.frame.attachmentRevision, after.frame.attachmentRevision);
  assert.deepEqual(otherView.frame.entries[0].messages?.[0].attachments?.[0].image.attachment, {workspaceId: workspace, targetKey: key});
  assert.ok(registry.journal.replay(cursor, viewer.id).records.some(value => value.name === 'agent.frame'));
  const path = `/api/agents/${STORAGE}/history`;
  const get = (workspaceId?: string) => registry.dispatch({...context(workspaceId ?? '', path, {}), method: 'GET', workspace: workspaceId});
  assert.equal((await get(workspace) as {entries: EntryView[]}).entries[0].messages?.[0].attachments?.length, 1);
  assert.deepEqual((await get(viewer.id) as {entries: EntryView[]}).entries[0].messages?.[0].attachments?.[0].image.attachment, {workspaceId: workspace, targetKey: key});
  assert.equal((await get() as {entries: EntryView[]}).entries[0].messages?.[0].attachments, undefined);
});
