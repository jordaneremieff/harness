import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {LIMITS, sameDraftTuple} from '../shared/api.ts';
import type {DraftImage, Target} from '../shared/api.ts';
import {StateStore} from './state.mts';
import type {OperationRecord} from './state.mts';
import {Operations} from './operations.mts';
import {normalizeDraftImages} from './validate.mts';
import {readVerifiedDraftImages} from './draft-images.mts';
import {execute} from './dispatch.mts';
import {AgentError} from '../agents/index.mts';
import type {Registry} from './registry.mts';

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-draft-images-')); let clock = Date.now(); let store = await StateStore.open(root, {now: () => clock});
  t.after(async () => {await store.close(); await rm(root, {recursive: true, force: true});});
  const workspace = await store.workspace(), target: Extract<Target, {kind: 'primary'}> = {kind: 'primary', key: 'p', epoch: 1};
  const saved = await store.target(workspace.id, target);
  const upload = async (wid = workspace.id, key = saved.targetKey, name = 'pixel.png', payload: Uint8Array = bytes) => {
    const reservation = await store.reserveImageUpload(wid, key, {name, mimeType: 'image/png', epoch: 1, declaredBytes: payload.byteLength}, () => {});
    try {const intake = await store.beginImageUpload(reservation); await intake.write(payload); return await store.finishImageUpload(reservation, await intake.finish(), () => {});}
    finally {await store.cancelImageUpload(reservation);}
  };
  const operations = () => new Operations(store, {now: () => clock});
  return {root, workspace, target, saved, upload, operations, get store() {return store;}, advance(ms: number) {clock += ms;}, async reopen() {await store.close(); store = await StateStore.open(root, {now: () => clock});}};
}
async function admitted(f: Awaited<ReturnType<typeof fixture>>, wid: string, key: string, image: DraftImage, disposition: 'queued' | 'handled' | 'started' = 'queued') {
  const saved = await f.store.getTarget(wid, key);
  const draft = await f.store.putDraft(wid, key, {expectedRevision: saved.draft.revision, text: 'caption', mode: 'prompt', images: [image]});
  const operations = f.operations(), operation = await operations.reserve(wid, 'primary.input', f.target);
  const request = {workspaceId: wid, kind: 'primary.input' as const, target: f.target, body: {message: draft.text, mode: draft.mode, draftRevision: draft.revision, images: draft.images}, input: {targetKey: key, text: draft.text, mode: draft.mode, draftRevision: draft.revision, images: draft.images}};
  assert.equal((await operations.execute(operation.id, request, async () => ({state: 'accepted', receipt: {kind: 'rpc', disposition}}))).state, 'accepted');
  return operation.id;
}

test('image references normalize omissions and reject invalid complete metadata', () => {
  assert.deepEqual(normalizeDraftImages(undefined), []);
  const image: DraftImage = {digest: 'a'.repeat(64), mimeType: 'image/png', bytes: 10, width: 1, height: 1, name: 'é.png'};
  assert.deepEqual(normalizeDraftImages([image]), [image]);
  for (const patch of [{digest: 'A'.repeat(64)}, {width: 8193}, {name: '../x'}, {name: '\ud800'}, {name: 'x\u0000'}]) assert.throws(() => normalizeDraftImages([{...image, ...patch}]), {code: 'invalid_image_reference'});
  for (const patch of [{bytes: 0}, {extra: true}]) assert.throws(() => normalizeDraftImages([{...image, ...patch}]), {code: 'invalid_request'});
  assert.throws(() => normalizeDraftImages([image, image]), {code: 'invalid_image_reference'});
  assert.throws(() => normalizeDraftImages(Array.from({length: 5}, (_, i) => ({...image, digest: String(i).repeat(64)}))), {code: 'invalid_image_reference'});
  assert.throws(() => normalizeDraftImages([{...image, bytes: LIMITS.imageBytes}, {...image, digest: 'b'.repeat(64)}]), {code: 'invalid_image_reference'});
});

test('target-local leases survive restart, expire explicitly, and reupload enables only save', async t => {
  const f = await fixture(t), staged = await f.upload();
  assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace.id, f.saved.targetKey, staged.image.digest)).data), bytes);
  assert.equal((await stat(join(f.root, 'images', f.saved.targetKey, `${staged.image.digest}.bin`))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, 'images', f.saved.targetKey))).mode & 0o777, 0o700);
  await f.reopen(); f.advance(LIMITS.imageLeaseMs + 1);
  await assert.rejects(f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [staged.image]}), error => {
    const value = error as {code: string; details: {missingIndexes: number[]}}; assert.equal(value.code, 'unknown_image_digest'); assert.deepEqual(value.details.missingIndexes, [0]); return true;
  });
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.revision, 0);
  const renewed = await f.upload(undefined, undefined, 'renamed.png');
  const draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [renewed.image]});
  assert.equal(draft.images[0]?.name, 'renamed.png'); assert.equal(f.store.operationMetadata().length, 0);
  f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).imageAvailability[0]?.state, 'ready');
  const read = await readVerifiedDraftImages(f.store.blobReadSpecForOperation(f.workspace.id, f.saved.targetKey, draft.images)); assert.deepEqual(Buffer.from(read[0]?.data ?? []), bytes);
});

test('reservations are bounded before bytes and cancellation releases only the intake', async t => {
  const f = await fixture(t), held = [];
  for (let i = 0; i < 2; i++) held.push(await f.store.reserveImageUpload(f.workspace.id, f.saved.targetKey, {name: `${i}.png`, mimeType: 'image/png', epoch: 1}, () => {}));
  await assert.rejects(f.store.reserveImageUpload(f.workspace.id, f.saved.targetKey, {name: 'third.png', mimeType: 'image/png', epoch: 1}, () => {}), {code: 'capacity'});
  for (const item of held) await f.store.cancelImageUpload(item);
  const staged = await f.upload();
  await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [staged.image]});
  const reservation = await f.store.reserveImageUpload(f.workspace.id, f.saved.targetKey, {name: 'abort.png', mimeType: 'image/png', epoch: 1}, () => {});
  const intake = await f.store.beginImageUpload(reservation); await intake.write(bytes.subarray(0, 8)); await f.store.cancelImageUpload(reservation);
  assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace.id, f.saved.targetKey, staged.image.digest)).data), bytes);
  await assert.rejects(f.store.reserveImageUpload(f.workspace.id, f.saved.targetKey, {name: 'old.png', mimeType: 'image/png', epoch: 2}, () => {}), {code: 'stale_epoch'});
});

test('saved references enforce target isolation, intrinsic metadata and complete tuple CAS', async t => {
  const f = await fixture(t), staged = await f.upload(); const other = await f.store.createWorkspace(), target = await f.store.target(other.id, f.target);
  await assert.rejects(f.store.putDraft(other.id, target.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [staged.image]}), {code: 'unknown_image_digest'});
  await assert.rejects(f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [{...staged.image, width: 2}]}), {code: 'invalid_image_reference'});
  const draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [staged.image]});
  const operations = f.operations(), operation = await operations.reserve(f.workspace.id, 'primary.input', f.target); let effects = 0;
  const request = {workspaceId: f.workspace.id, kind: 'primary.input' as const, target: f.target, body: {message: '', images: [{...staged.image, name: 'changed.png'}]}, input: {targetKey: f.saved.targetKey, text: '', mode: 'prompt', draftRevision: draft.revision, images: [{...staged.image, name: 'changed.png'}]}};
  await assert.rejects(operations.execute(operation.id, request, async () => {effects++; return {state: 'accepted'};}), {code: 'stale_revision'}); assert.equal(effects, 0);
});

test('queued and handled image receipts protect the original complete operation and bytes', async t => {
  for (const disposition of ['queued', 'handled'] as const) {
    const f = await fixture(t), staged = await f.upload(), id = await admitted(f, f.workspace.id, f.saved.targetKey, staged.image, disposition);
    const state = await f.store.getTarget(f.workspace.id, f.saved.targetKey);
    assert.equal(state.retainedInputs[0]?.admission, `${disposition}-image`); assert.deepEqual(state.retainedInputs[0]?.images, [staged.image]);
    assert.equal(state.draft.images.length, disposition === 'handled' ? 1 : 0);
    assert.equal((await f.store.getRetainedInput(f.workspace.id, id)).admission, `${disposition}-image`);
    await assert.rejects(f.operations().remove(id), {code: 'operation_conflict'});
    f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
    assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace.id, f.saved.targetKey, staged.image.digest)).data), bytes);
    await f.store.discardRetainedInput(f.workspace.id, id);
    if (disposition === 'handled') assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.images.length, 1);
  }
});

test('every row from one clear stays guarded across workspaces, edits, discard, pruning and restart', async t => {
  const f = await fixture(t), other = await f.store.createWorkspace(), otherTarget = await f.store.target(other.id, f.target);
  const a = await f.upload(), b = await f.upload(other.id, otherTarget.targetKey);
  const aId = await admitted(f, f.workspace.id, f.saved.targetKey, a.image), bId = await admitted(f, other.id, otherTarget.targetKey, b.image);
  const operations = f.operations(), clearId = await operations.beginQueueClear(f.workspace.id, f.target, 2);
  assert.equal(f.store.record(clearId).queueClear?.imageCopies.length, 2);
  await operations.retainQueue(clearId, {steering: ['same caption', 'unrelated text'], followUp: []});
  let state = await f.store.getTarget(f.workspace.id, f.saved.targetKey); const source = state.unconfirmed[1]; assert.ok(source);
  assert.equal(state.unconfirmed.every(row => row.sendGuard?.state === 'blocked'), true);
  let draft = await f.store.restoreRetainedInput(f.workspace.id, source.operationId, state.draft.revision);
  draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: draft.revision, text: 'edited', mode: 'prompt', images: []});
  assert.equal(draft.recoverySendGuard?.imageCopies, 2);
  await assert.rejects(f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: draft.revision, text: 'edited', mode: 'prompt', recoverySource: state.unconfirmed[0]?.operationId}), {code: 'queue_recovery_provenance'});
  await f.store.discardRetainedInput(f.workspace.id, source.operationId); await f.reopen();
  state = await f.store.getTarget(f.workspace.id, f.saved.targetKey); assert.equal(state.draft.recoveryOrigin?.recoveryOperationId, source.operationId);
  const operation = await f.operations().reserve(f.workspace.id, 'primary.input', f.target); let effects = 0;
  const request = {workspaceId: f.workspace.id, kind: 'primary.input' as const, target: f.target, body: {message: state.draft.text, mode: state.draft.mode, draftRevision: state.draft.revision}, input: {targetKey: f.saved.targetKey, text: state.draft.text, mode: state.draft.mode, draftRevision: state.draft.revision, images: []}};
  await assert.rejects(f.operations().execute(operation.id, request, async () => {effects++; return {state: 'accepted'};}), {code: 'queue_recovery_guard'}); assert.equal(effects, 0);
  await assert.rejects(f.operations().remove(clearId), {code: 'operation_conflict'});
  const confirmed = {...request, body: {...request.body, differentMessage: true}, input: {...request.input, differentMessage: true as const}};
  const result = await f.operations().execute(operation.id, confirmed, async () => {effects++; return {state: 'accepted', receipt: {kind: 'rpc', disposition: 'started'}};}); assert.equal(result.state, 'accepted'); assert.equal(effects, 1);
  await assert.rejects(f.operations().execute(operation.id, {...confirmed, input: {...confirmed.input, text: 'another'}}, async () => ({state: 'accepted'})), {code: 'operation_conflict'});
  const remaining = (await f.store.getTarget(f.workspace.id, f.saved.targetKey)).unconfirmed[0]; assert.ok(remaining);
  draft = await f.store.restoreRetainedInput(f.workspace.id, remaining.operationId, (await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.revision);
  await f.store.discardRetainedInput(f.workspace.id, aId); assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.recoverySendGuard?.imageCopies, 1);
  await f.store.discardRetainedInput(other.id, bId); assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.recoverySendGuard?.state, 'clear');
  assert.equal(sameDraftTuple(draft, (await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft), true);
});

test('partial row publication resumes by clear ID and position without duplicate rows', async t => {
  const f = await fixture(t), operations = f.operations(), id = await operations.beginQueueClear(f.workspace.id, f.target, 2); let fail = true;
  const write = f.store.writeOperation.bind(f.store);
  t.mock.method(f.store, 'writeOperation', async (record: OperationRecord) => {if (fail && record.queueRecovery?.index === 1) {fail = false; throw new Error('before publication');} await write(record);});
  const rows = {steering: ['identical', 'identical'], followUp: []};
  await assert.rejects(operations.retainQueue(id, rows), /before publication/); assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).unconfirmed.length, 1);
  await operations.settleQueueClearFailure(id, true); await operations.retainQueue(id, rows); await operations.retainQueue(id, rows);
  const state = await f.store.getTarget(f.workspace.id, f.saved.targetKey); assert.equal(state.unconfirmed.length, 2); assert.equal(new Set(state.unconfirmed.map(row => row.operationId)).size, 2);
});

test('missing acknowledged bytes preserve labels, refuse Send and prevent pre-clear effects', async t => {
  const f = await fixture(t), staged = await f.upload(), id = await admitted(f, f.workspace.id, f.saved.targetKey, staged.image);
  await unlink(join(f.root, 'images', f.saved.targetKey, `${staged.image.digest}.bin`)); await f.reopen();
  const state = await f.store.getTarget(f.workspace.id, f.saved.targetKey); assert.equal(state.retainedInputs[0]?.images[0]?.name, 'pixel.png'); assert.equal(state.imageAvailability[0]?.state, 'unavailable');
  await assert.rejects(f.operations().beginQueueClear(f.workspace.id, f.target, 1), {code: 'image_unavailable'});
  await f.store.restoreRetainedInput(f.workspace.id, id, state.draft.revision);
  assert.throws(() => f.store.validateDraftImageReferences(f.saved.targetKey, [staged.image]), {code: 'image_unavailable'});
});

test('unknown storage entries block intake and deletion while text drafts remain usable', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'images', 'unknown'), 'do not delete'); await f.reopen();
  await assert.rejects(f.store.reserveImageUpload(f.workspace.id, f.saved.targetKey, {name: 'x.png', mimeType: 'image/png', epoch: 1}, () => {}), {code: 'image_storage_unavailable'});
  assert.equal((await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: 'text works', mode: 'prompt'})).text, 'text works');
  assert.equal((await stat(join(f.root, 'images', 'unknown'))).size, 13);
});

test('uncertain host errors retain the original input instead of becoming definite refusal', async t => {
  const f = await fixture(t), saved = await f.store.target(f.workspace.id, {kind: 'agent', identity: 'storage:1'});
  const draft = await f.store.putDraft(f.workspace.id, saved.targetKey, {expectedRevision: 0, text: 'work', mode: 'steer'});
  const operations = f.operations(), view = await operations.reserve(f.workspace.id, 'agent.input', saved.target);
  const registry = {operations, options: {}} as Registry;
  const result = await execute(registry, view.id, {workspaceId: f.workspace.id, kind: 'agent.input', target: saved.target, body: {message: draft.text}, input: {targetKey: saved.targetKey, text: draft.text, mode: draft.mode, draftRevision: draft.revision}}, async () => {throw new AgentError('host_unavailable', 'connection lost', true);});
  assert.equal(result.state, 'uncertain'); assert.equal(f.store.record(view.id).input?.text, 'work');
});

test('wide recovery metadata omits only whole previews and keeps every exact copy in the target index', async t => {
  const f = await fixture(t), images: DraftImage[] = []; const name = '🔷'.repeat(240);
  for (let index = 0; index < 4; index++) {
    const text = Buffer.from(`k\0v${index}`), chunk = Buffer.alloc(12 + text.length); chunk.writeUInt32BE(text.length); chunk.write('tEXt', 4); text.copy(chunk, 8);
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4, 8 + text.length)) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + text.length);
    const png = Buffer.concat([bytes.subarray(0, -12), chunk, bytes.subarray(-12)]); images.push((await f.upload(undefined, undefined, name, png)).image);
  }
  const ids: string[] = [];
  await f.store.transaction(async () => {
    for (let index = 0; index < 128; index++) {
      const id = crypto.randomUUID(), at = new Date().toISOString(); ids.push(id);
      await f.store.writeOperation({workspaceId: f.workspace.id, retainedInput: 'queued-image', inputResolved: true, view: {id, kind: 'primary.input', target: f.target, state: 'accepted', createdAt: at, updatedAt: at, receipt: {kind: 'rpc', disposition: 'queued'}}, input: {operationId: id, target: f.target, targetKey: f.saved.targetKey, text: '', mode: 'prompt', images, submittedDraftRevision: 0, createdAt: at, reason: 'Queued input retained'}});
    }
  });
  const state = await f.store.getTarget(f.workspace.id, f.saved.targetKey); assert.equal(state.recoveryPreviewTruncated, true); assert.ok(Buffer.byteLength(JSON.stringify(state)) < LIMITS.displayBytes);
  assert.equal(state.retainedInputs.every(copy => copy.images.length === 4 && copy.images.every(image => image.name === name)), true);
  assert.equal(f.store.snapshot(f.workspace.id, []).targetIndex[0]?.retainedInputOperationIds.length, 128);
  assert.deepEqual((await f.store.getRetainedInput(f.workspace.id, ids[127] ?? '')).images, images);
});

test('lease publication failure never deletes an already acknowledged deduplicated image', async t => {
  const f = await fixture(t), staged = await f.upload();
  await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: 'saved', mode: 'prompt', images: [staged.image]});
  const writer = f.store as unknown as {atomic(path: string, value: unknown, max: number): Promise<void>}; const atomic = writer.atomic.bind(f.store); let fail = true;
  t.mock.method(writer, 'atomic', async (path: string, value: unknown, max: number) => {if (fail && path === `targets/${f.saved.targetKey}.json`) {fail = false; throw new Error('before lease publication');} await atomic(path, value, max);});
  await assert.rejects(f.upload(undefined, undefined, 'duplicate.png'), /before lease publication/);
  assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace.id, f.saved.targetKey, staged.image.digest)).data), bytes);
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.images[0]?.name, 'pixel.png');
});

test('a refused retry does not certify the original uncertain admission or discard its captured tuple', async t => {
  const f = await fixture(t), saved = await f.store.target(f.workspace.id, {kind: 'agent', identity: 'storage:1'});
  const draft = await f.store.putDraft(f.workspace.id, saved.targetKey, {expectedRevision: 0, text: 'original', mode: 'steer'}), operations = f.operations();
  const operation = await operations.reserve(f.workspace.id, 'agent.input', saved.target);
  const request = {workspaceId: f.workspace.id, kind: 'agent.input' as const, target: saved.target, body: {message: draft.text}, input: {targetKey: saved.targetKey, text: draft.text, mode: draft.mode, draftRevision: draft.revision}};
  assert.equal((await operations.execute(operation.id, request, async () => {throw new Error('lost receipt');})).state, 'uncertain');
  await f.store.putDraft(f.workspace.id, saved.targetKey, {expectedRevision: draft.revision, text: 'newer', mode: 'followUp'});
  const result = await operations.execute(operation.id, {...request, retryUncertainNative: true}, async () => ({state: 'rejected', error: {code: 'host_unavailable', message: 'This retry did not connect', retry: 'manual'}}));
  assert.equal(result.state, 'uncertain'); assert.equal(f.store.record(operation.id).input?.text, 'original'); assert.equal((await f.store.getTarget(f.workspace.id, saved.targetKey)).draft.text, 'newer');
});

test('corrupt acknowledged bytes remain a typed unavailable reference, not an expired upload', async t => {
  const f = await fixture(t), staged = await f.upload();
  const draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: 'caption', mode: 'prompt', images: [staged.image]});
  const file = join(f.root, 'images', f.saved.targetKey, `${staged.image.digest}.bin`);
  await writeFile(file, 'corrupt'); await f.reopen();
  const state = await f.store.getTarget(f.workspace.id, f.saved.targetKey);
  assert.deepEqual(state.draft.images, [staged.image]); assert.equal(state.imageAvailability[0]?.state, 'unavailable');
  await assert.rejects(f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: draft.revision, text: 'edited', mode: 'prompt', images: [staged.image]}), {code: 'image_unavailable', details: {targetKey: f.saved.targetKey, missingIndexes: [0]}});
  assert.equal((await stat(file)).size, 7);
});

test('incomplete clear provenance blocks deletion and Send without inventing missing copies', async t => {
  const f = await fixture(t), staged = await f.upload(), original = await admitted(f, f.workspace.id, f.saved.targetKey, staged.image);
  const operations = f.operations(), id = await operations.beginQueueClear(f.workspace.id, f.target, 1); await operations.retainQueue(id, {steering: ['shadow text'], followUp: []});
  const source = (await f.store.getTarget(f.workspace.id, f.saved.targetKey)).unconfirmed[0]; assert.ok(source);
  await f.store.restoreRetainedInput(f.workspace.id, source.operationId, (await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.revision);
  await unlink(join(f.root, 'operations', `${original}.json`)); f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
  const state = await f.store.getTarget(f.workspace.id, f.saved.targetKey); assert.equal(state.draft.recoverySendGuard?.state, 'unavailable'); assert.ok(state.imageStorageError);
  assert.equal((await stat(join(f.root, 'images', f.saved.targetKey, `${staged.image.digest}.bin`))).size, bytes.length);
  const origin = state.draft.recoveryOrigin; assert.ok(origin);
  assert.throws(() => f.store.assertRecoverySendAllowed(origin, true), {code: 'queue_recovery_provenance'});
  await assert.rejects(f.operations().remove(id), {code: 'operation_conflict'});
});
