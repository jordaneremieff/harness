import assert from 'node:assert/strict';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Operations, nativeRequestId } from './operations.mts';
import type { DispatchResult, ExecuteRequest } from './operations.mts';
import { StateStore } from './state.mts';

async function setup(t: test.TestContext, kind: 'primary' | 'agent' = 'primary') {
  const root = await mkdtemp(join(tmpdir(), 'ui-operations-test-')); let store = await StateStore.open(root);
  t.after(async () => { await store.close(); await rm(root, {recursive: true, force: true}); });
  const workspace = await store.workspace();
  const target = await store.target(workspace.id, kind === 'primary' ? {kind, key: 'primary', epoch: 1} : {kind, identity: 'storage:1'});
  const draft = await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 0, text: 'exact message', mode: kind === 'primary' ? 'prompt' : 'followUp'});
  const operations = new Operations(store);
  const view = await operations.reserve(workspace.id, kind === 'primary' ? 'primary.input' : 'agent.input', target.target);
  const request: ExecuteRequest = {workspaceId: workspace.id, kind: view.kind, target: target.target, body: {message: draft.text, mode: draft.mode, draftRevision: draft.revision}, input: {targetKey: target.targetKey, text: draft.text, mode: draft.mode, draftRevision: draft.revision}};
  return {root, store, operations, workspace, target, draft, view, request, reopen: async () => { await store.close(); store = await StateStore.open(root); return store; }};
}

test('issued keys bind body and target; exact concurrent retries never resend; newer edits remain', async t => {
  const {store, operations, workspace, target, view, request} = await setup(t);
  let calls = 0; let finish!: () => void; let dispatched!: () => void;
  const reached = new Promise<void>(resolve => { dispatched = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const first = operations.execute(view.id, request, async () => { calls++; dispatched(); await pending; return {state: 'accepted', receipt: {kind: 'rpc', disposition: 'started'}}; });
  await reached;
  const duplicate = await operations.execute(view.id, {...request, body: {draftRevision: 1, mode: 'prompt', message: 'exact message'}}, async () => { throw new Error('duplicate'); });
  assert.equal(duplicate.state, 'dispatched'); assert.equal(calls, 1);
  await assert.rejects(operations.execute(view.id, {...request, body: {message: 'changed'}}, async () => ({state: 'accepted'})), /different request/);
  await assert.rejects(operations.execute('unknown', request, async () => ({state: 'accepted'})), /Unknown operation/);
  await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 1, text: 'newer edit', mode: 'prompt'});
  finish(); assert.equal((await first).state, 'accepted');
  assert.equal((await store.getTarget(workspace.id, target.targetKey)).draft.text, 'newer edit');
  assert.equal((await store.getTarget(workspace.id, target.targetKey)).unconfirmed.length, 0);
  assert.equal((await operations.execute(view.id, request, async () => { calls++; return {state: 'accepted'}; })).state, 'accepted');
  assert.equal(calls, 1); await operations.remove(view.id); await assert.rejects(operations.get(view.id), /Unknown operation/);
});

test('control actions remain exact after completion, restart and idempotent retry', async t => {
  const {operations, workspace, target, reopen} = await setup(t);
  const completed = [];
  let sends = 0;
  for (const action of ['model', 'thinking', 'compact', 'unfamiliarControl']) {
    const view = await operations.reserve(workspace.id, 'primary.control', target.target);
    assert.equal(Object.hasOwn(view, 'action'), false);
    const request: ExecuteRequest = {workspaceId: workspace.id, kind: 'primary.control', target: target.target, body: {epoch: 1, action}};
    const result = await operations.execute(view.id, request, async () => {
      sends++;
      assert.equal((await operations.get(view.id)).action, action);
      return {state: 'completed', receipt: {kind: 'rpc', result: {value: null, truncated: false}}};
    });
    assert.equal(result.state, 'completed'); assert.equal(result.action, action);
    await assert.rejects(operations.execute(view.id, {...request, body: {epoch: 1, action: 'changed'}}, async () => { throw new Error('must not resend'); }), /different request/);
    assert.equal((await operations.get(view.id)).action, action);
    completed.push({view: result, request});
  }
  const after = new Operations(await reopen());
  for (const {view, request} of completed) {
    assert.deepEqual(await after.get(view.id), view);
    assert.deepEqual(await after.execute(view.id, request, async () => { sends++; throw new Error('must not resend'); }), view);
  }
  assert.equal(sends, completed.length);
});

test('control projection has no inferred action for missing or non-string values and other kinds', async t => {
  const {operations, workspace, target} = await setup(t);
  for (const body of [{}, {action: null}, {action: 1}]) {
    const view = await operations.reserve(workspace.id, 'primary.control', target.target);
    const result = await operations.execute(view.id, {workspaceId: workspace.id, kind: view.kind, target: target.target, body}, async () => ({state: 'completed'}));
    assert.equal(Object.hasOwn(result, 'action'), false);
  }
  const view = await operations.reserve(workspace.id, 'primary.session', target.target);
  const result = await operations.execute(view.id, {workspaceId: workspace.id, kind: view.kind, target: target.target, body: {action: 'fork'}}, async () => ({state: 'completed'}));
  assert.equal(Object.hasOwn(result, 'action'), false);
});

test('a completed handoff receipt replaces an interim uncertainty error', async t => {
  const {operations, workspace, target} = await setup(t);
  const view = await operations.reserve(workspace.id, 'primary.handoff', target.target);
  const request: ExecuteRequest = {workspaceId: workspace.id, kind: 'primary.handoff', target: target.target, body: {}};
  let reached!: () => void; let finish!: (result: DispatchResult) => void;
  const dispatched = new Promise<void>(resolve => { reached = resolve; });
  const pending = new Promise<DispatchResult>(resolve => { finish = resolve; });
  const execution = operations.execute(view.id, request, () => { reached(); return pending; });
  const receipt = {kind: 'rpc' as const, disposition: 'handled' as const};
  try {
    await dispatched; assert.equal((await operations.get(view.id)).state, 'dispatched');
    await operations.markUncertain(target.target);
    const interim = await operations.get(view.id);
    assert.equal(interim.state, 'uncertain'); assert.equal(interim.error?.code, 'delivery_uncertain');
  } finally { finish({state: 'completed', receipt}); }
  const completed = await execution; assert.equal(completed.state, 'completed'); assert.deepEqual(completed.receipt, receipt);
  assert.equal(Object.hasOwn(completed, 'error'), false);
  const stored = await operations.get(view.id); assert.equal(stored.state, 'completed'); assert.deepEqual(stored.receipt, receipt);
  assert.equal(Object.hasOwn(stored, 'error'), false);
});

test('an explicit handoff rejection replaces and retains its error after interim uncertainty', async t => {
  const {operations, workspace, target} = await setup(t);
  const view = await operations.reserve(workspace.id, 'primary.handoff', target.target);
  const request: ExecuteRequest = {workspaceId: workspace.id, kind: 'primary.handoff', target: target.target, body: {}};
  let reached!: () => void; let finish!: (result: DispatchResult) => void;
  const dispatched = new Promise<void>(resolve => { reached = resolve; });
  const pending = new Promise<DispatchResult>(resolve => { finish = resolve; });
  const execution = operations.execute(view.id, request, () => { reached(); return pending; });
  const error = {code: 'not_ready', message: 'Handoff refused', retry: 'read' as const};
  try {
    await dispatched; await operations.markUncertain(target.target);
    assert.equal((await operations.get(view.id)).error?.code, 'delivery_uncertain');
  } finally { finish({state: 'rejected', error}); }
  const rejected = await execution; assert.equal(rejected.state, 'rejected'); assert.deepEqual(rejected.error, error);
  const stored = await operations.get(view.id); assert.equal(stored.state, 'rejected'); assert.deepEqual(stored.error, error);
});

test('dispatch persistence failure prevents send, post-send persistence failure retains an uncertain copy', async t => {
  const {root, store, operations, workspace, target, view, request, reopen} = await setup(t);
  let calls = 0;
  await rename(join(root, 'operations'), join(root, 'operations-away'));
  await assert.rejects(operations.execute(view.id, request, async () => { calls++; return {state: 'accepted'}; }));
  assert.equal(calls, 0);
  await rename(join(root, 'operations-away'), join(root, 'operations'));
  const result = await operations.execute(view.id, request, async () => {
    calls++; await rename(join(root, 'operations'), join(root, 'operations-away'));
    return {state: 'accepted', receipt: {kind: 'rpc', disposition: 'started'}};
  });
  assert.equal(result.state, 'uncertain'); assert.equal(calls, 1);
  assert.equal((await store.getTarget(workspace.id, target.targetKey)).unconfirmed[0]?.text, 'exact message');
  await rename(join(root, 'operations-away'), join(root, 'operations'));
  const restarted = await reopen(); const after = new Operations(restarted);
  assert.equal((await after.get(view.id)).state, 'uncertain');
  assert.equal((await after.execute(view.id, request, async () => { calls++; return {state: 'accepted'}; })).state, 'uncertain');
  assert.equal(calls, 1); assert.equal((await after.reconcile(view.id)).state, 'uncertain');
});

test('uncertain copy restore checks current draft revision and never sends; discard only removes the copy', async t => {
  const {store, operations, workspace, target, view, request} = await setup(t);
  await operations.execute(view.id, request, async () => { throw new Error('transport gone'); });
  await assert.rejects(operations.remove(view.id), /Resolve/);
  await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 1, text: 'new edit', mode: 'prompt'});
  await assert.rejects(store.restoreUnconfirmed(workspace.id, view.id, 1), /revision changed/);
  const restored = await store.restoreUnconfirmed(workspace.id, view.id, 2); assert.equal(restored.text, 'exact message');
  assert.equal((await store.getTarget(workspace.id, target.targetKey)).unconfirmed.length, 1);
  await store.discardUnconfirmed(workspace.id, view.id); assert.equal((await operations.get(view.id)).state, 'uncertain');
  assert.equal((await store.getTarget(workspace.id, target.targetKey)).unconfirmed.length, 0);
  await operations.remove(view.id);
});

test('native explicit retry uses the original key, payload and target; wrong receipt stays uncertain', async t => {
  const {store, operations, workspace, target, view, request} = await setup(t, 'agent'); let sends = 0;
  await operations.execute(view.id, request, async () => { sends++; throw new Error('lost'); });
  await operations.execute(view.id, request, async () => { sends++; return {state: 'accepted'}; }); assert.equal(sends, 1);
  await assert.rejects(operations.execute(view.id, {...request, body: {message: 'changed'}, retryUncertainNative: true}, async () => ({state: 'accepted'})), /different request/);
  const bad = await operations.execute(view.id, {...request, retryUncertainNative: true}, async () => ({state: 'accepted', receipt: {kind: 'durable', identity: 'wrong:1', requestId: nativeRequestId(view.id), submissionId: 1, deduped: true}}));
  assert.equal(bad.state, 'uncertain');
  const good = await operations.execute(view.id, {...request, retryUncertainNative: true}, async () => ({state: 'accepted', receipt: {kind: 'durable', identity: 'storage:1', requestId: nativeRequestId(view.id), submissionId: 1, deduped: true}}));
  assert.equal(good.state, 'accepted'); assert.equal((await store.getTarget(workspace.id, target.targetKey)).draft.text, '');
});

test('definite refusal retains draft without an uncertain copy; expired reservations never dispatch', async t => {
  const {store, operations, workspace, target, view, request} = await setup(t);
  const refused = await operations.execute(view.id, request, async () => ({state: 'rejected', error: {code: 'not_ready', message: 'Busy', retry: 'read'}}));
  assert.equal(refused.state, 'rejected'); assert.equal((await store.getTarget(workspace.id, target.targetKey)).draft.text, 'exact message');
  assert.equal((await store.getTarget(workspace.id, target.targetKey)).unconfirmed.length, 0);
  let now = Date.now(); const clock = new Operations(store, {now: () => now});
  const reservation = await clock.reserve(workspace.id, 'primary.stop', target.target); now += 600_001;
  await assert.rejects(clock.execute(reservation.id, {workspaceId: workspace.id, kind: 'primary.stop', target: target.target, body: {}}, async () => { throw new Error('must not send'); }), /expired/);
  for (let index = 0; index < 16; index++) await clock.reserve(workspace.id, 'primary.stop', target.target);
  await assert.rejects(clock.reserve(workspace.id, 'primary.stop', target.target), /Too many/);
  await assert.rejects(clock.reserve(workspace.id, 'agent.abort', target.target), /exact target/);
});

test('input recovery capacity refuses new work and never evicts unresolved records', async t => {
  const {store, operations, view, request} = await setup(t);
  const captured = request.input; assert.ok(captured); const capturedTarget = request.target; assert.ok(capturedTarget);
  await store.transaction(async () => {
    for (let index = 0; index < 128; index++) {
      const copy = store.record(view.id); copy.view.id = crypto.randomUUID(); copy.view.state = 'uncertain';
      copy.input = {operationId: copy.view.id, target: capturedTarget, targetKey: captured.targetKey, text: 'saved intent', mode: 'prompt', submittedDraftRevision: 1, createdAt: copy.view.createdAt, reason: 'uncertain'};
      await store.writeOperation(copy);
    }
  });
  let sends = 0;
  await assert.rejects(operations.execute(view.id, request, async () => { sends++; return {state: 'accepted'}; }), /Resolve unconfirmed/);
  assert.equal(sends, 0); assert.equal(store.unresolvedInputCount(), 128);
});

test('queue recovery preserves separate exact copies, previews stay bounded, and capacity failure preserves earlier copies', async t => {
  const {store, operations, workspace, target} = await setup(t);
  assert.equal(target.target.kind, 'primary');
  if (target.target.kind !== 'primary') throw new Error('Expected primary fixture');
  const text = '😀'.repeat(16_000);
  await operations.retainQueue(workspace.id, target.target, {steering: ['one', text], followUp: ['three']});
  const state = await store.getTarget(workspace.id, target.targetKey);
  assert.equal(state.unconfirmed.length, 3); assert.equal(new Set(state.unconfirmed.map(copy => copy.operationId)).size, 3);
  const truncated = state.unconfirmed.find(copy => copy.textTruncated); assert.ok(truncated);
  assert.ok(Buffer.byteLength(truncated.text) <= 256); assert.ok(Buffer.byteLength(JSON.stringify(state)) < 256 * 1024);
  const exact = await store.getUnconfirmed(workspace.id, truncated.operationId); assert.equal(exact.text, text); assert.equal(exact.mode, 'steer');
  assert.equal(exact.textTruncated, undefined); assert.match(exact.reason, /does not prove non-admission/);
  await store.restoreUnconfirmed(workspace.id, exact.operationId, 1); assert.equal((await store.getTarget(workspace.id, target.targetKey)).draft.text, text);
  await assert.rejects(operations.retainQueue(workspace.id, target.target, {steering: Array(128).fill('not lost'), followUp: []}), /Resolve unconfirmed/);
  assert.equal(store.unresolvedInputCount(), 3);
  await store.discardUnconfirmed(workspace.id, exact.operationId); assert.equal(store.record(exact.operationId).input, undefined);
  await assert.rejects(store.getUnconfirmed(workspace.id, exact.operationId), /No unconfirmed copy/);
});

test('receipt bursts use cached byte accounting without cloning or serializing retained operation payloads', async t => {
  const {store, operations, workspace, target} = await setup(t);
  const ids = new Set<string>();
  await store.transaction(async () => {
    for (let index = 0; index < 128; index++) {
      const id = crypto.randomUUID(); ids.add(id); const at = new Date().toISOString();
      await store.writeOperation({workspaceId: workspace.id, view: {id, kind: 'primary.control', target: target.target, state: 'completed', createdAt: at, updatedAt: at, receipt: {kind: 'rpc', result: {value: 'r'.repeat(60_000), truncated: false}}}});
    }
  });
  const initialBytes = store.operationStoreBytes(); assert.ok(initialBytes > 7_000_000);
  t.mock.method(store, 'records', () => { throw new Error('Full-store clones are forbidden on admission'); });
  const stringify = JSON.stringify; let retainedSerializations = 0;
  t.mock.method(JSON, 'stringify', (value: unknown, replacer?: never, space?: string | number) => {
    const item = value as {view?: {id?: string}};
    if (item?.view?.id && ids.has(item.view.id)) retainedSerializations++;
    return stringify(value, replacer, space);
  });
  for (let index = 0; index < 16; index++) {
    const view = await operations.reserve(workspace.id, 'primary.control', target.target);
    const result = await operations.execute(view.id, {workspaceId: workspace.id, kind: 'primary.control', target: target.target, body: {action: 'thinking', level: 'high'}}, async () => ({state: 'completed', receipt: {kind: 'rpc'}}));
    assert.equal(result.state, 'completed');
  }
  assert.equal(retainedSerializations, 0); assert.ok(store.operationStoreBytes() >= initialBytes);
  assert.deepEqual(store.operationViews(workspace.id).filter(view => ids.has(view.id)), []);
});

test('a full recovery window exposes bounded previews, exact copies, and metadata after restart', async t => {
  const {store, operations, workspace, target, reopen} = await setup(t);
  if (target.target.kind !== 'primary') throw new Error('Expected primary fixture');
  const exactText = 'q'.repeat(64 * 1024);
  await operations.retainQueue(workspace.id, target.target, {steering: Array(128).fill(exactText), followUp: []});
  const state = await store.getTarget(workspace.id, target.targetKey);
  assert.equal(state.unconfirmed.length, 128); assert.ok(Buffer.byteLength(JSON.stringify(state)) < 256 * 1024);
  assert.equal(state.unconfirmed.every(copy => copy.textTruncated === true && Buffer.byteLength(copy.text) <= 256), true);
  const id = state.unconfirmed[0]?.operationId; assert.ok(id);
  assert.equal((await store.getUnconfirmed(workspace.id, id)).text, exactText);
  const cut = store.snapshot(workspace.id, []); assert.deepEqual(cut.targets, []); assert.equal(cut.targetIndex[0]?.unconfirmedOperationIds.length, 128);
  assert.ok(Buffer.byteLength(JSON.stringify(cut)) < 16 * 1024);
  const restarted = await reopen(); assert.equal((await restarted.getUnconfirmed(workspace.id, id)).text, exactText);
  assert.equal(restarted.unresolvedInputCount(), 128);
});

test('queue file-byte validation happens before any copy publication', async t => {
  const {store, operations, workspace, target} = await setup(t);
  if (target.target.kind !== 'primary') throw new Error('Expected primary fixture');
  await assert.rejects(operations.retainQueue(workspace.id, target.target, {steering: ['first', '\n'.repeat(64 * 1024)], followUp: []}), /file limit/);
  assert.equal(store.unresolvedInputCount(), 0); assert.equal((await store.getTarget(workspace.id, target.targetKey)).unconfirmed.length, 0);
});
