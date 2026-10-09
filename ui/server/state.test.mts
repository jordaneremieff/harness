import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StateError, StateStore } from './state.mts';

async function setup(t: test.TestContext, hook?: Parameters<typeof StateStore.open>[1]) {
  const root = await mkdtemp(join(tmpdir(), 'ui-state-test-'));
  const store = await StateStore.open(root, hook);
  t.after(async () => { await store.close(); await rm(root, {recursive: true, force: true}); });
  const workspace = await store.workspace();
  const target = await store.target(workspace.id, {kind: 'primary', key: 'primary', epoch: 1});
  return {root, store, workspace, target};
}

test('private state survives restart, retains distinct epochs, and publishes only saved revisions', async t => {
  const events: string[] = [];
  const {root, store, workspace, target} = await setup(t, {onChange: name => { events.push(name); }});
  await assert.rejects(StateStore.open(root), error => error instanceof StateError && error.code === 'not_ready');
  const draft = await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 0, text: 'exact\n draft ', mode: 'steer'});
  assert.equal(draft.persisted, true);
  await store.putReading(workspace.id, target.targetKey, {expectedRevision: 0, anchorId: 'message-a', offsetPx: 24, followTail: false});
  await store.putPresentation(workspace.id, target.targetKey, {expectedRevision: 0, expanded: ['call-a', 'call-a'], showThinking: true});
  await store.updateSelection(workspace.id, {expectedRevision: 0, selectedTarget: target.target, panelVisible: false, sidebarVisible: false, appearance: 'light'});
  const other = await store.target(workspace.id, {kind: 'primary', key: 'primary', epoch: 2});
  assert.equal(other.draft.text, ''); assert.notEqual(target.targetKey, other.targetKey);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, 'targets', `${target.targetKey}.json`))).mode & 0o777, 0o600);
  assert.deepEqual(events, ['workspace.changed', 'draft.changed', 'reading.changed', 'workspace.changed']);
  const instance = store.instanceId;
  await store.close(); const reopened = await StateStore.open(root);
  try {
    assert.equal(reopened.instanceId, instance);
    const saved = await reopened.getTarget(workspace.id, target.targetKey);
    assert.equal(saved.draft.text, 'exact\n draft '); assert.equal(saved.reading.anchorId, 'message-a');
    assert.deepEqual(saved.presentation?.expanded, ['call-a']);
    assert.equal(reopened.snapshot(workspace.id).workspace.appearance, 'light');
    assert.equal(reopened.snapshot(workspace.id).workspace.sidebarVisible, false);
  } finally { await reopened.close(); }
});

test('sidebar preference is optional, boolean and independent of observation', async t => {
  const {store, workspace} = await setup(t);
  assert.equal(workspace.sidebarVisible, undefined);
  const selected = await store.updateSelection(workspace.id, {expectedRevision: 0, sidebarVisible: false});
  assert.equal(selected.sidebarVisible, false); assert.equal(selected.panelVisible, true);
  const observed = await store.updateSelection(workspace.id, {expectedRevision: 1, panelVisible: false});
  assert.equal(observed.sidebarVisible, false);
  for (const value of [null, 'false', 0, {}]) {
    await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 2, sidebarVisible: value as boolean}), /sidebar visibility/);
  }
  assert.equal((await store.workspace(workspace.id)).revision, 2);
});

test('draft writes serialize compare-and-set, errors retain the acknowledged draft', async t => {
  const {root, store, workspace, target} = await setup(t);
  const replies = await Promise.allSettled(['one', 'two'].map(text => store.putDraft(workspace.id, target.targetKey, {expectedRevision: 0, text, mode: 'prompt'})));
  assert.equal(replies.filter(reply => reply.status === 'fulfilled').length, 1);
  const rejected = replies.find(reply => reply.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'stale_revision'); assert.equal(rejected.reason.details.text, 'one');
  await rename(join(root, 'targets'), join(root, 'targets-away'));
  await assert.rejects(store.putDraft(workspace.id, target.targetKey, {expectedRevision: 1, text: 'not saved', mode: 'prompt'}));
  assert.equal((await store.getTarget(workspace.id, target.targetKey)).draft.text, 'one');
  await rename(join(root, 'targets-away'), join(root, 'targets'));
  await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 1, text: 'three', mode: 'prompt'});
  assert.deepEqual((await readdir(join(root, 'targets'))).filter(name => name.endsWith('.tmp')), []);
  assert.equal(JSON.parse(await readFile(join(root, 'targets', `${target.targetKey}.json`), 'utf8')).draft.text, 'three');
});

test('only explicit recovery removes a proven-dead same-host state lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ui-lock-test-')); t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'lock.json'), JSON.stringify({pid: 2147483647, hostname: hostname(), owner: 'dead'}), {mode: 0o600});
  await assert.rejects(StateStore.open(root), /already has an owner/);
  const store = await StateStore.open(root, {recoverDeadLock: true}); await store.close();
  await writeFile(join(root, 'lock.json'), JSON.stringify({pid: process.pid, hostname: hostname(), owner: 'live'}));
  await assert.rejects(StateStore.open(root, {recoverDeadLock: true}), /live or unknown/);
  await writeFile(join(root, 'lock.json'), JSON.stringify({pid: 2147483647, hostname: 'another-host', owner: 'foreign'}));
  await assert.rejects(StateStore.open(root, {recoverDeadLock: true}), /unknown/);
});

test('workspace and target capacities never evict drafts; values are copies and inputs are bounded', async t => {
  const {store, workspace, target} = await setup(t);
  for (let index = 1; index < 16; index++) await store.createWorkspace();
  await assert.rejects(store.createWorkspace(), error => error instanceof StateError && error.code === 'capacity');
  for (let index = 1; index < 128; index++) await store.target(workspace.id, {kind: 'agent', identity: `agent-${index}`});
  await assert.rejects(store.target(workspace.id, {kind: 'agent', identity: 'overflow'}), error => error instanceof StateError && error.code === 'capacity');
  await assert.rejects(store.putDraft(workspace.id, target.targetKey, {expectedRevision: 0, text: 'x'.repeat(65537), mode: 'prompt'}), /text limit/);
  await assert.rejects(store.putReading(workspace.id, target.targetKey, {expectedRevision: 0, anchorId: null, offsetPx: NaN, followTail: false}), /reading position/);
  await assert.rejects(store.putPresentation(workspace.id, target.targetKey, {expectedRevision: 0, expanded: Array(129).fill('id'), showThinking: false}), /presentation preferences/);
  const snapshot = store.snapshot(workspace.id, [target.target]); const first = snapshot.targets[0]; assert.ok(first); first.draft.text = 'external';
  assert.equal((await store.getTarget(workspace.id, target.targetKey)).draft.text, '');
  await assert.rejects(store.getTarget('unknown', target.targetKey), /workspace/);
});

test('selection clear preserves old targets, synchronous index avoids draft payloads, and unknown fields reject', async t => {
  const {store, workspace, target} = await setup(t);
  await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 0, text: 'x'.repeat(64 * 1024), mode: 'prompt'});
  const selected = await store.updateSelection(workspace.id, {expectedRevision: 0, primaryKey: 'primary', selectedTarget: target.target});
  const cut = store.snapshot(workspace.id, [target.target]);
  assert.equal(cut.targets.length, 1); assert.equal(cut.targetIndex[0]?.hasDraft, true);
  assert.ok(Buffer.byteLength(JSON.stringify(store.targetIndex(workspace.id))) < 1024);
  assert.equal(JSON.stringify(cut.targetIndex).includes('xxxx'), false);
  const cleared = await store.updateSelection(workspace.id, {expectedRevision: selected.revision, selectedTarget: null});
  assert.equal(cleared.selectedTarget, undefined); assert.equal((await store.getTarget(workspace.id, target.targetKey)).draft.text.length, 64 * 1024);
  const invalid = {expectedRevision: cleared.revision, unexpected: 'private field'};
  await assert.rejects(store.updateSelection(workspace.id, invalid), /Unknown workspace field/);
});
