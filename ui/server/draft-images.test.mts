import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {LIMITS, sameDraftTuple} from '../shared/api.ts';
import type {DraftImage, Target} from '../shared/api.ts';
import {StateStore} from './state.mts';
import type {OperationRecord} from './state.mts';
import {Operations} from './operations.mts';
import {normalizeDraftImages} from './validate.mts';
import {readVerifiedDraftImages,verifiedImageReferences} from './draft-images.mts';
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

test('verified image file reference retains exact bytes and target isolation', async t => {
  const f=await fixture(t),staged=await f.upload();
  const paths=await verifiedImageReferences({root:f.root,targetKey:f.saved.targetKey,images:[staged.image]});
  assert.equal(paths.length,1);assert.deepEqual(await readFile(paths[0]),bytes);
  await assert.rejects(verifiedImageReferences({root:f.root,targetKey:'00000000-0000-0000-0000-000000000000',images:[staged.image]}),{code:'image_unavailable'});
});

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

test('saved references enforce target isolation and intrinsic metadata while admission captures the submitted name', async t => {
  const f = await fixture(t), staged = await f.upload(); const other = await f.store.createWorkspace(), target = await f.store.target(other.id, f.target);
  await assert.rejects(f.store.putDraft(other.id, target.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [staged.image]}), {code: 'unknown_image_digest'});
  await assert.rejects(f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [{...staged.image, width: 2}]}), {code: 'invalid_image_reference'});
  const draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [staged.image]});
  const operations = f.operations(), operation = await operations.reserve(f.workspace.id, 'primary.input', f.target); let effects = 0;
  const request = {workspaceId: f.workspace.id, kind: 'primary.input' as const, target: f.target, body: {message: '', images: [{...staged.image, name: 'changed.png'}]}, input: {targetKey: f.saved.targetKey, text: '', mode: 'prompt', draftRevision: draft.revision, images: [{...staged.image, name: 'changed.png'}]}};
  assert.equal((await operations.execute(operation.id, request, async () => {effects++; return {state: 'rejected', error: {code: 'unsupported', message: 'No admission', retry: 'manual'}};})).state, 'rejected'); assert.equal(effects, 1);
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
  await operations.settleQueueClearFailure(id, true); await f.reopen();
  assert.equal(f.store.retainedInputCount(), 2);
  await f.operations().retainQueue(id, rows); await f.operations().retainQueue(id, rows);
  const state = await f.store.getTarget(f.workspace.id, f.saved.targetKey); assert.equal(state.unconfirmed.length, 2); assert.equal(new Set(state.unconfirmed.map(row => row.operationId)).size, 2);
});

test('unused clear records release independently of retained images', async t => {
  for (const outcome of ['empty', 'refused', 'uncertain'] as const) {
    const f = await fixture(t), staged = await f.upload(), imageId = await admitted(f, f.workspace.id, f.saved.targetKey, staged.image);
    const copy = await f.store.getRetainedInput(f.workspace.id, imageId);
    const id = await f.operations().beginQueueClear(f.workspace.id, f.target, outcome === 'uncertain' ? 2 : 0);
    if (outcome === 'empty') await f.operations().retainQueue(id, {steering: [], followUp: []});
    else await f.operations().settleQueueClearFailure(id, outcome === 'uncertain');
    f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
    assert.equal(f.store.retainedInputCount(), outcome === 'uncertain' ? 3 : 1);
    await f.operations().remove(id);
    assert.throws(() => f.store.record(id), {code: 'unknown_operation'});
    assert.equal(f.store.retainedInputCount(), 1);
    assert.deepEqual(await f.store.getRetainedInput(f.workspace.id, imageId), copy);
    await assert.rejects(f.operations().remove(imageId), {code: 'operation_conflict'});
    assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace.id, f.saved.targetKey, staged.image.digest)).data), bytes);
    await f.reopen(); assert.equal(f.store.retainedInputCount(), 1);
    await f.store.discardRetainedInput(f.workspace.id, imageId); await f.operations().remove(imageId);
  }
});

for (const absence of ['missing', 'discarded'] as const) test(`completed queue publication stays final after a ${absence} row`, async t => {
  const f = await fixture(t), queue = {steering: ['retained text'], followUp: []};
  const id = await f.operations().beginQueueClear(f.workspace.id, f.target, 1);
  await f.operations().retainQueue(id, queue);
  const row = f.store.records().find(record => record.queueRecovery?.clearOperationId === id); assert.ok(row);
  const anchor = f.store.record(id);
  if (absence === 'missing') { await f.store.close(); await unlink(join(f.root, 'operations', `${row.view.id}.json`)); }
  else { await f.store.discardRetainedInput(f.workspace.id, row.view.id); await f.operations().remove(row.view.id); }
  await f.reopen();
  for (const uncertain of [true, false, true]) {
    await assert.rejects(f.operations().retainQueue(id, queue), {code: 'queue_recovery_provenance'});
    assert.deepEqual(f.store.record(id), anchor);
    await f.operations().settleQueueClearFailure(id, uncertain); await f.reopen();
    await assert.rejects(f.operations().retainQueue(id, queue), {code: 'queue_recovery_provenance'});
    assert.deepEqual(f.store.record(id), anchor);
    assert.throws(() => f.store.record(row.view.id), {code: 'unknown_operation'});
    assert.equal(f.store.retainedInputCount(), 0);
  }
});

test('completed queue verification preserves resolved rows and rejects changed content without writes', async t => {
  const f = await fixture(t), queue = {steering: ['text'], followUp: ['next']};
  const id = await f.operations().beginQueueClear(f.workspace.id, f.target, 2);
  await f.operations().retainQueue(id, queue);
  const row = f.store.records().find(record => record.queueRecovery?.clearOperationId === id); assert.ok(row);
  await f.store.discardRetainedInput(f.workspace.id, row.view.id); await f.reopen();
  const records = f.store.records();
  const write = t.mock.method(f.store, 'writeOperation', async () => {throw new Error('unexpected write');});
  await f.operations().retainQueue(id, queue);
  await f.operations().settleQueueClearFailure(id, true);
  const changed = {steering: ['text'], followUp: ['next']};
  if (row.queueRecovery?.mode === 'steer') changed.followUp = ['changed']; else changed.steering = ['changed'];
  await assert.rejects(f.operations().retainQueue(id, changed), {code: 'queue_recovery_provenance'});
  await assert.rejects(f.operations().retainQueue(id, {steering: [], followUp: []}), {code: 'queue_recovery_provenance'});
  assert.equal(write.mock.callCount(), 0); assert.deepEqual(f.store.records(), records);
});

test('partial publication retains release evidence and its remaining reservation across restart', async t => {
  const f = await fixture(t), queue = {steering: ['first', 'second'], followUp: []};
  const id = await f.operations().beginQueueClear(f.workspace.id, f.target, 2);
  const write = f.store.writeOperation.bind(f.store);
  t.mock.method(f.store, 'writeOperation', async (record: OperationRecord) => {if (record.queueRecovery?.index === 1) throw new Error('row write failed'); await write(record);});
  await assert.rejects(f.operations().retainQueue(id, queue), /row write failed/);
  const row = f.store.records().find(record => record.queueRecovery?.clearOperationId === id); assert.ok(row);
  await f.store.discardRetainedInput(f.workspace.id, row.view.id);
  await assert.rejects(f.operations().remove(row.view.id), {code: 'operation_conflict'});
  await f.operations().settleQueueClearFailure(id, true); await f.reopen();
  assert.equal(f.store.retainedInputCount(), 1);
  await assert.rejects(f.operations().remove(id), {code: 'operation_conflict'});
  await f.operations().retainQueue(id, queue); await f.operations().retainQueue(id, queue);
  assert.equal(f.store.record(row.view.id).input, undefined);
  assert.equal(f.store.record(row.view.id).inputResolved, true);
  assert.equal(f.store.retainedInputCount(), 1);
  assert.equal(f.store.records().filter(record => record.queueRecovery?.clearOperationId === id).length, 2);
});

test('an empty return with an unfinished final write stays protected until publication completes', async t => {
  const f = await fixture(t), id = await f.operations().beginQueueClear(f.workspace.id, f.target, 0);
  const write = f.store.writeOperation.bind(f.store);
  t.mock.method(f.store, 'writeOperation', async (record: OperationRecord) => {if (record.queueClear?.phase === 'retained') throw new Error('completion write failed'); await write(record);});
  await assert.rejects(f.operations().retainQueue(id, {steering: [], followUp: []}), /completion write failed/);
  await f.reopen();
  assert.equal(f.store.operationMetadata().find(record => record.view.id === id)?.protected, true);
  await assert.rejects(f.operations().remove(id), {code: 'operation_conflict'});
  await f.operations().retainQueue(id, {steering: [], followUp: []}); await f.operations().remove(id);
});

test('invalid member evidence prevents anchor removal and reservation release', async t => {
  for (const defect of ['missing', 'workspace', 'target', 'release'] as const) {
    const f = await fixture(t), staged = await f.upload(), imageId = await admitted(f, f.workspace.id, f.saved.targetKey, staged.image);
    const id = await f.operations().beginQueueClear(f.workspace.id, f.target, 1);
    await f.operations().settleQueueClearFailure(id, true);
    if (defect === 'missing') { await f.store.close(); await unlink(join(f.root, 'operations', `${imageId}.json`)); }
    else await f.store.transaction(async () => {
      const record = f.store.record(id), member = record.queueClear?.imageCopies[0]; assert.ok(member);
      if (defect === 'workspace') member.workspaceId = crypto.randomUUID();
      if (defect === 'target') record.view.target = {...f.target, epoch: 2};
      if (defect === 'release') {
        const copy = f.store.record(imageId); delete copy.input; delete copy.retainedInput; copy.inputResolved = false;
        await f.store.writeOperation(copy);
      }
      await f.store.writeOperation(record);
    });
    f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
    const anchor = f.store.record(id);
    assert.equal(f.store.canDiscardUnknownQueueClear(id), false);
    await assert.rejects(f.operations().remove(id), {code: 'operation_conflict'});
    assert.deepEqual(f.store.record(id), anchor);
    assert.equal(f.store.record(id).queueClear?.rowBudget, 1);
    assert.throws(() => f.store.imageGraphForMutation(), {code: 'image_storage_unavailable'});
    assert.equal((await stat(join(f.root, 'images', f.saved.targetKey, `${staged.image.digest}.bin`))).size, bytes.length);
  }
});

test('pending input backlinks retain clear evidence after the source and draft are released', async t => {
  const f = await fixture(t), staged = await f.upload(), imageId = await admitted(f, f.workspace.id, f.saved.targetKey, staged.image);
  const id = await f.operations().beginQueueClear(f.workspace.id, f.target, 1);
  await f.operations().retainQueue(id, {steering: ['review text'], followUp: []});
  const row = f.store.records().find(record => record.queueRecovery?.clearOperationId === id); assert.ok(row);
  const draft = await f.store.restoreRetainedInput(f.workspace.id, row.view.id, (await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.revision);
  const request = {workspaceId: f.workspace.id, kind: 'primary.input' as const, target: f.target, body: {message: draft.text, differentMessage: true}, input: {targetKey: f.saved.targetKey, text: draft.text, mode: draft.mode, images: [], draftRevision: draft.revision, differentMessage: true as const}};
  const pending = await f.operations().reserve(f.workspace.id, 'primary.input', f.target);
  await f.operations().execute(pending.id, request, async () => {throw new Error('receipt lost');});
  const accepted = await f.operations().reserve(f.workspace.id, 'primary.input', f.target);
  await f.operations().execute(accepted.id, request, async () => ({state: 'accepted', receipt: {kind: 'rpc', disposition: 'started'}}));
  await f.store.discardRetainedInput(f.workspace.id, row.view.id); await f.store.discardRetainedInput(f.workspace.id, imageId); await f.reopen();
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.recoveryOrigin, undefined);
  for (const protectedId of [id, row.view.id, imageId]) await assert.rejects(f.operations().remove(protectedId), {code: 'operation_conflict'});
  const origin = f.store.record(pending.id).input?.recoveryOrigin; assert.ok(origin);
  f.store.assertRecoverySendAllowed(origin);
  await f.store.discardRetainedInput(f.workspace.id, pending.id);
  await f.operations().remove(id); await f.operations().remove(row.view.id); await f.operations().remove(imageId); await f.operations().remove(pending.id);
});

test('operation capacity prunes unused anchors before retained copies or live recovery evidence', async t => {
  const f = await fixture(t), staged = await f.upload(), imageId = await admitted(f, f.workspace.id, f.saved.targetKey, staged.image);
  const releasedId = await admitted(f, f.workspace.id, f.saved.targetKey, staged.image);
  const liveId = await f.operations().beginQueueClear(f.workspace.id, f.target, 1);
  await f.operations().retainQueue(liveId, {steering: ['review'], followUp: []});
  const row = f.store.records().find(record => record.queueRecovery?.clearOperationId === liveId); assert.ok(row);
  await f.store.restoreRetainedInput(f.workspace.id, row.view.id, (await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.revision);
  await f.store.discardRetainedInput(f.workspace.id, row.view.id); await f.store.discardRetainedInput(f.workspace.id, releasedId);
  f.advance(1);
  const emptyId = await f.operations().beginQueueClear(f.workspace.id, f.target, 0);
  await f.operations().retainQueue(emptyId, {steering: [], followUp: []});
  f.advance(1);
  const refusedId = await f.operations().beginQueueClear(f.workspace.id, f.target, 0);
  await f.operations().settleQueueClearFailure(refusedId, false);
  await f.store.transaction(async () => {
    while (f.store.operationStoreCount() < LIMITS.operations) {
      const at = '2099-01-01T00:00:00.000Z';
      await f.store.writeOperation({workspaceId: f.workspace.id, view: {id: crypto.randomUUID(), kind: 'primary.control', target: f.target, state: 'completed', createdAt: at, updatedAt: at}});
    }
  });
  f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
  await f.operations().reserve(f.workspace.id, 'primary.control', f.target);
  await f.operations().reserve(f.workspace.id, 'primary.control', f.target);
  assert.equal(f.store.operationStoreCount(), LIMITS.operations);
  for (const id of [emptyId, refusedId]) assert.throws(() => f.store.record(id), {code: 'unknown_operation'});
  for (const id of [imageId, releasedId, liveId, row.view.id]) assert.equal(f.store.operationMetadata().find(record => record.view.id === id)?.protected, true);
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.recoverySendGuard?.state, 'blocked');
  assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace.id, f.saved.targetKey, staged.image.digest)).data), bytes);
});

test('missing acknowledged bytes preserve labels, refuse Send and prevent pre-clear effects', async t => {
  const f = await fixture(t), staged = await f.upload(), id = await admitted(f, f.workspace.id, f.saved.targetKey, staged.image);
  await unlink(join(f.root, 'images', f.saved.targetKey, `${staged.image.digest}.bin`)); await f.reopen();
  const state = await f.store.getTarget(f.workspace.id, f.saved.targetKey); assert.equal(state.retainedInputs[0]?.images[0]?.name, 'pixel.png'); assert.equal(state.imageAvailability[0]?.state, 'unavailable');
  await assert.rejects(f.operations().beginQueueClear(f.workspace.id, f.target, 1), {code: 'image_unavailable'});
  await f.store.restoreRetainedInput(f.workspace.id, id, state.draft.revision);
  assert.throws(() => f.store.validateDraftImageReferences(f.saved.targetKey, [staged.image]), {code: 'image_unavailable'});
});

test('exact-byte reattachment repairs only the acknowledged target image and preserves retained content', async t => {
  const f = await fixture(t), staged = await f.upload(), id = await admitted(f, f.workspace.id, f.saved.targetKey, staged.image);
  const copy = await f.store.getRetainedInput(f.workspace.id, id);
  const draft = await f.store.restoreRetainedInput(f.workspace.id, id, (await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.revision);
  await f.store.close(); await unlink(join(f.root, 'images', f.saved.targetKey, `${staged.image.digest}.bin`));
  f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
  assert.deepEqual(await f.store.getRetainedInput(f.workspace.id, id), copy);
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).imageAvailability[0]?.state, 'unavailable');
  await assert.rejects(f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: draft.revision, text: draft.text, mode: draft.mode, images: draft.images}), {code: 'image_unavailable'});
  const replacement = await f.upload(undefined, undefined, 'reattached.png');
  assert.equal(replacement.image.digest, staged.image.digest);
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).imageAvailability[0]?.state, 'ready');
  const saved = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: draft.revision, text: draft.text, mode: draft.mode, images: draft.images});
  assert.ok(sameDraftTuple(saved, draft));
  assert.deepEqual(await f.store.getRetainedInput(f.workspace.id, id), copy);
  assert.equal(f.store.retainedInputCount(), 1); await assert.rejects(f.operations().remove(id), {code: 'operation_conflict'});
  assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace.id, f.saved.targetKey, staged.image.digest)).data), bytes);
  f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).imageAvailability[0]?.state, 'ready');
  assert.deepEqual(await f.store.getRetainedInput(f.workspace.id, id), copy);
  assert.equal(f.store.records().length, 1);
});

test('replacement availability stays local to one digest and target', async t => {
  const f = await fixture(t), other = await f.store.createWorkspace(), target = await f.store.target(other.id, f.target);
  const alternate = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const a = await f.upload(), b = await f.upload(undefined, undefined, 'other.png', alternate), c = await f.upload(other.id, target.targetKey);
  const draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: 'caption', mode: 'prompt', images: [a.image, b.image]});
  const otherDraft = await f.store.putDraft(other.id, target.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [c.image]});
  assert.notEqual(a.image.digest, b.image.digest); assert.equal(a.image.digest, c.image.digest);
  await f.store.close();
  for (const [key, image] of [[f.saved.targetKey, a.image], [f.saved.targetKey, b.image], [target.targetKey, c.image]] as const) await unlink(join(f.root, 'images', key, `${image.digest}.bin`));
  f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
  await f.upload(undefined, undefined, 'replacement.png', alternate);
  assert.throws(() => f.store.validateDraftImageReferences(f.saved.targetKey, draft.images), {code: 'image_unavailable', details: {targetKey: f.saved.targetKey, missingIndexes: [0]}});
  assert.throws(() => f.store.validateDraftImageReferences(target.targetKey, otherDraft.images), {code: 'image_unavailable'});
  await f.upload(other.id, target.targetKey);
  f.store.validateDraftImageReferences(target.targetKey, otherDraft.images);
  assert.throws(() => f.store.validateDraftImageReferences(f.saved.targetKey, draft.images), {code: 'image_unavailable'});
  assert.deepEqual((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft, draft);
  await f.upload(); f.store.validateDraftImageReferences(f.saved.targetKey, draft.images);
  assert.deepEqual((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft, draft);
  await assert.rejects(f.store.putDraft(other.id, target.targetKey, {expectedRevision: otherDraft.revision, text: '', mode: 'prompt', images: [b.image]}), {code: 'unknown_image_digest'});
  assert.equal(f.store.records().length, 0);
});

test('failed lease publication does not release an unavailable reference before a verified retry', async t => {
  const f = await fixture(t), staged = await f.upload();
  const draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [staged.image]});
  await f.store.close(); await unlink(join(f.root, 'images', f.saved.targetKey, `${staged.image.digest}.bin`)); await f.reopen();
  const writer = f.store as unknown as {atomic(path: string, value: unknown, max: number): Promise<void>};
  const atomic = writer.atomic.bind(f.store); let fail = true;
  t.mock.method(writer, 'atomic', async (path: string, value: unknown, max: number) => {if (fail && path === `targets/${f.saved.targetKey}.json`) {fail = false; throw new Error('lease write failed');} await atomic(path, value, max);});
  await assert.rejects(f.upload(), /lease write failed/);
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).imageAvailability[0]?.state, 'unavailable');
  assert.throws(() => f.store.validateDraftImageReferences(f.saved.targetKey, draft.images), {code: 'image_unavailable'});
  assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace.id, f.saved.targetKey, staged.image.digest)).data), bytes);
  await f.upload(); f.store.validateDraftImageReferences(f.saved.targetKey, draft.images);
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).imageAvailability[0]?.state, 'ready');
});

test('failed blob publication keeps unavailable metadata and corrupt storage guards', async t => {
  const f = await fixture(t), staged = await f.upload(), file = join(f.root, 'images', f.saved.targetKey, `${staged.image.digest}.bin`);
  const draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: 'caption', mode: 'prompt', images: [staged.image]});
  await f.store.close(); await unlink(file); await f.reopen();
  const held = await f.store.reserveImageUpload(f.workspace.id, f.saved.targetKey, {name: 'pixel.png', mimeType: 'image/png', epoch: 1, declaredBytes: bytes.length}, () => {});
  const intake = await f.store.beginImageUpload(held); await intake.write(bytes); const image = await intake.finish();
  await writeFile(file, 'corrupt');
  try { await assert.rejects(f.store.finishImageUpload(held, image, () => {}), {code: 'image_unavailable'}); }
  finally { await f.store.cancelImageUpload(held); }
  assert.deepEqual((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft, draft);
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).imageAvailability[0]?.state, 'unavailable');
  assert.throws(() => f.store.validateDraftImageReferences(f.saved.targetKey, draft.images), {code: 'image_unavailable'});
  await assert.rejects(f.upload(), {code: 'image_storage_unavailable'});
  assert.equal((await stat(file)).size, 7);
});

test('replacement bytes must agree with acknowledged intrinsic metadata', async t => {
  const f = await fixture(t), staged = await f.upload();
  const draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: '', mode: 'prompt', images: [staged.image]});
  const targetFile = join(f.root, 'targets', `${f.saved.targetKey}.json`), imageFile = join(f.root, 'images', f.saved.targetKey, `${staged.image.digest}.bin`);
  await f.store.close();
  const target = JSON.parse(await readFile(targetFile, 'utf8'));
  target.draft.images[0].width = 2;
  await writeFile(targetFile, JSON.stringify(target)); await unlink(imageFile); f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
  await assert.rejects(f.upload(), {code: 'invalid_image_reference'});
  await assert.rejects(stat(imageFile), {code: 'ENOENT'});
  assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.images[0]?.width, 2);
  assert.throws(() => f.store.validateDraftImageReferences(f.saved.targetKey, draft.images), {code: 'image_unavailable'});
  await writeFile(imageFile, bytes); await f.reopen();
  assert.ok((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).imageStorageError);
  await assert.rejects(f.upload(), {code: 'image_storage_unavailable'});
  assert.deepEqual(await readFile(imageFile), bytes);
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

test('delayed definite refusal preserves a displaced full tuple through restart and explicit restore', async t => {
  const f = await fixture(t), staged = await f.upload();
  const draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: 'submitted caption', mode: 'prompt', images: [staged.image]});
  const operations = f.operations(), operation = await operations.reserve(f.workspace.id, 'primary.input', f.target);
  let entered = () => {}, finish = () => {}, dispatches = 0;
  const started = new Promise<void>(resolve => {entered = resolve;}); const gate = new Promise<void>(resolve => {finish = resolve;});
  const error = {code: 'unsupported', message: 'Native input was refused', retry: 'none' as const};
  const pending = operations.execute(operation.id, {workspaceId: f.workspace.id, kind: 'primary.input', target: f.target, body: {message: draft.text, mode: draft.mode, draftRevision: draft.revision, images: draft.images}, input: {targetKey: f.saved.targetKey, text: draft.text, mode: draft.mode, draftRevision: draft.revision, images: draft.images}}, async () => {dispatches++; entered(); await gate; return {state: 'rejected', error};});
  await started;
  const newer = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: draft.revision, text: 'newer text', mode: 'steer', images: []});
  finish(); const result = await pending;
  assert.equal(result.state, 'rejected'); assert.deepEqual(result.error, error); assert.equal(result.receipt, undefined); assert.equal(result.retainedInput, 'refused');
  assert.deepEqual((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft, newer);
  await assert.rejects(operations.remove(operation.id), {code: 'operation_conflict'});
  f.advance(LIMITS.imageLeaseMs + 1); await f.reopen();
  const copy = await f.store.getRetainedInput(f.workspace.id, operation.id);
  assert.equal(copy.admission, 'refused'); assert.ok(!('receipt' in copy)); assert.ok(sameDraftTuple(copy, draft));
  if (copy.admission === 'refused') assert.deepEqual(copy.error, error);
  assert.equal(f.store.retainedInputCount(), 1); assert.equal(f.store.record(operation.id).view.state, 'rejected');
  assert.deepEqual(f.store.snapshot(f.workspace.id, [f.target]).targetIndex[0]?.retainedInputOperationIds, [operation.id]);
  const clear = await f.operations().beginQueueClear(f.workspace.id, f.target, 0); assert.deepEqual(f.store.record(clear).queueClear?.imageCopies, []);
  await assert.rejects(f.store.restoreRetainedInput(f.workspace.id, operation.id, draft.revision), {code: 'stale_revision'});
  assert.deepEqual((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft, newer);
  const restored = await f.store.restoreRetainedInput(f.workspace.id, operation.id, newer.revision); assert.ok(sameDraftTuple(restored, draft)); assert.equal(dispatches, 1);
  assert.deepEqual(Buffer.from((await f.store.readDraftImage(f.workspace.id, f.saved.targetKey, staged.image.digest)).data), bytes);
  await f.store.discardRetainedInput(f.workspace.id, operation.id); assert.equal(f.store.retainedInputCount(), 0);
  await f.operations().remove(operation.id); assert.ok(sameDraftTuple((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft, draft));
});

test('text-only refused copies use retained capacity and remain protected until explicit discard', async t => {
  const f = await fixture(t), draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: 'original', mode: 'prompt'});
  const operations = f.operations(), operation = await operations.reserve(f.workspace.id, 'primary.input', f.target);
  await operations.execute(operation.id, {workspaceId: f.workspace.id, kind: 'primary.input', target: f.target, body: {message: draft.text, mode: draft.mode, draftRevision: draft.revision}, input: {targetKey: f.saved.targetKey, text: draft.text, mode: draft.mode, draftRevision: draft.revision}}, async () => {
    await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: draft.revision, text: draft.text, mode: 'followUp'}); return {state: 'rejected', error: {code: 'not_ready', message: 'Refused', retry: 'none'}};
  });
  assert.equal((await f.store.getRetainedInput(f.workspace.id, operation.id)).admission, 'refused'); assert.equal(f.store.retainedInputCount(), 1);
  await assert.rejects(operations.remove(operation.id), {code: 'operation_conflict'});
  await f.reopen(); assert.equal(f.store.retainedInputCount(), 1);
  await f.store.discardRetainedInput(f.workspace.id, operation.id); assert.equal(f.store.retainedInputCount(), 0);
  await f.operations().remove(operation.id); assert.equal((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft.mode, 'followUp');
});

test('definite refusal releases its operation copy when the complete tuple remains in a newer saved revision', async t => {
  const f = await fixture(t), draft = await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: 0, text: 'unchanged', mode: 'prompt'});
  const operations = f.operations(), operation = await operations.reserve(f.workspace.id, 'primary.input', f.target);
  const result = await operations.execute(operation.id, {workspaceId: f.workspace.id, kind: 'primary.input', target: f.target, body: {message: draft.text, mode: draft.mode, draftRevision: draft.revision}, input: {targetKey: f.saved.targetKey, text: draft.text, mode: draft.mode, draftRevision: draft.revision}}, async () => {
    await f.store.putDraft(f.workspace.id, f.saved.targetKey, {expectedRevision: draft.revision, text: draft.text, mode: draft.mode}); return {state: 'rejected'};
  });
  assert.equal(result.state, 'rejected'); assert.equal(result.retainedInput, undefined); assert.equal(f.store.record(operation.id).input, undefined);
  assert.ok(sameDraftTuple((await f.store.getTarget(f.workspace.id, f.saved.targetKey)).draft, draft));
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
