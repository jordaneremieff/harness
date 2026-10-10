import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StateError, StateStore } from './state.mts';
import type { Appearance, ConversationLayout, Workspace } from '../shared/api.ts';

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
  await store.updateSelection(workspace.id, {expectedRevision: 0, selectedTarget: target.target, panelVisible: false, sidebarVisible: false, sidebarWidth: 328, appearance: 'light'});
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
    assert.equal(reopened.snapshot(workspace.id).workspace.sidebarWidth, 328);
  } finally { await reopened.close(); }
});

test('conversation layouts replace atomically, clone nested values, preserve omission and survive restart', async t => {
  const events: Workspace[] = [];
  const {root, store, workspace, target} = await setup(t, {onChange: (name, data) => {if (name === 'workspace.changed') events.push(data as Workspace);}});
  assert.equal(workspace.conversationLayout, undefined); assert.equal(workspace.appearance, 'dark');
  const layout: ConversationLayout = {tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'agent-a', split: true}], active: 1, splitRatio: 60};
  const original = structuredClone(layout);
  const saved = await store.updateSelection(workspace.id, {expectedRevision: 0, conversationLayout: layout, selectedTarget: {kind: 'agent', identity: 'agent-a'}});
  assert.deepEqual(saved.conversationLayout, original); assert.equal(saved.revision, 1);
  assert.ok(saved.conversationLayout); const published = events.at(-1)?.conversationLayout; assert.ok(published);
  layout.tabs.length = 0; saved.conversationLayout.tabs.pop(); published.splitRatio = 20;
  const snapshot = store.snapshot(workspace.id); assert.ok(snapshot.workspace.conversationLayout); snapshot.workspace.conversationLayout.tabs.length = 0;
  assert.deepEqual((await store.workspace(workspace.id)).conversationLayout, original);
  await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 0, conversationLayout: original}), error => error instanceof StateError && error.code === 'stale_revision');
  const selected = await store.updateSelection(workspace.id, {expectedRevision: 1, selectedTarget: target.target, appearance: 'mocha', sidebarWidth: 320});
  assert.deepEqual(selected.conversationLayout, original); assert.deepEqual(selected.selectedTarget, target.target);
  const replacement: ConversationLayout = {tabs: [{kind: 'agent', identity: 'agent-b', split: false}], active: 0, splitRatio: 80};
  const replaced = await store.updateSelection(workspace.id, {expectedRevision: 2, conversationLayout: replacement});
  assert.deepEqual(replaced.conversationLayout, replacement); assert.deepEqual(replaced.selectedTarget, target.target);
  await store.close(); const reopened = await StateStore.open(root);
  try {
    const restored = await reopened.workspace(workspace.id);
    assert.deepEqual(restored.conversationLayout, replacement); assert.equal(restored.appearance, 'mocha'); assert.equal(restored.sidebarWidth, 320);
    const closed = await reopened.updateSelection(workspace.id, {expectedRevision: 3, conversationLayout: {tabs: [], active: null, splitRatio: 50}, selectedTarget: null});
    assert.deepEqual(closed.conversationLayout, {tabs: [], active: null, splitRatio: 50}); assert.equal(closed.selectedTarget, undefined);
    assert.equal((await reopened.getTarget(workspace.id, target.targetKey)).targetKey, target.targetKey);
  } finally { await reopened.close(); }
});

test('invalid conversation layouts never advance revisions, write state or publish changes', async t => {
  const changes: string[] = [];
  const {root, store, workspace} = await setup(t, {onChange: name => {changes.push(name);}});
  const one = {tabs: [{kind: 'primary'}], active: 0, splitRatio: 50};
  const agent = {kind: 'agent', identity: 'agent', split: false};
  const invalid: unknown[] = [null, [], 1, {}, {...one, extra: true}, {...one, tabs: null}, {...one, tabs: {}},
    {tabs: [], active: 0, splitRatio: 50}, {...one, active: null}, {...one, active: -1}, {...one, active: 1},
    {...one, active: 0.5}, {...one, active: '0'}, {...one, active: NaN}, {...one, active: Infinity},
    {...one, splitRatio: 19}, {...one, splitRatio: 81}, {...one, splitRatio: 50.5}, {...one, splitRatio: '50'}, {...one, splitRatio: NaN}, {...one, splitRatio: Infinity},
    {tabs: one.tabs, active: 0}, {active: 0, splitRatio: 50}, {...one, tabs: [{kind: 'primary'}, {kind: 'primary'}]},
    {...one, tabs: Array.from({length: 17}, (_, i) => ({kind: 'agent', identity: `agent-${i}`, split: false}))},
    {...one, tabs: [agent, {...agent, split: true}]}, {...one, tabs: [null]}, {...one, tabs: [[]]}, {...one, tabs: [{kind: 'other'}]},
    {...one, tabs: [{kind: 'primary', split: true}]}, {...one, tabs: [{kind: 'primary', key: 'primary', epoch: 1}]},
    {...one, tabs: [{...agent, extra: true}]}, {...one, tabs: [{kind: 'agent', identity: 'agent'}]}, {...one, tabs: [{...agent, split: 'false'}]},
    ...['', 'x'.repeat(257), 'bad\nidentity', null, 1].map(identity => ({...one, tabs: [{...agent, identity}]})),
  ];
  const path = join(root, 'workspaces', `${workspace.id}.json`); const bytes = await readFile(path, 'utf8');
  for (const conversationLayout of invalid) await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 0, conversationLayout: conversationLayout as ConversationLayout}), error => error instanceof StateError && error.code === 'invalid_request');
  assert.deepEqual(await store.workspace(workspace.id), workspace); assert.equal(await readFile(path, 'utf8'), bytes); assert.deepEqual(changes, ['workspace.changed']);
});

test('conversation tab and ratio boundaries retain the workspace file bound', async t => {
  const {root, store, workspace} = await setup(t);
  const layout: ConversationLayout = {tabs: Array.from({length: 16}, (_, i) => ({kind: 'agent', identity: `agent-${i}`, split: i % 2 === 0})), active: 15, splitRatio: 20};
  const first = await store.updateSelection(workspace.id, {expectedRevision: 0, conversationLayout: layout});
  assert.deepEqual(first.conversationLayout, layout);
  const huge: ConversationLayout = {...layout, tabs: layout.tabs.map((_tab, i) => ({kind: 'agent', identity: `${'\\'.repeat(254)}${i}`, split: true}))};
  assert.ok(Buffer.byteLength(JSON.stringify({...first, conversationLayout: huge})) > 8192);
  await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 1, conversationLayout: huge}), error => error instanceof StateError && error.code === 'payload_too_large');
  assert.deepEqual(await store.workspace(workspace.id), first);
  await rename(join(root, 'workspaces'), join(root, 'workspaces-away'));
  await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 1, conversationLayout: {...layout, splitRatio: 80}}));
  assert.deepEqual(await store.workspace(workspace.id), first);
  await rename(join(root, 'workspaces-away'), join(root, 'workspaces'));
  const last = await store.updateSelection(workspace.id, {expectedRevision: 1, conversationLayout: {...layout, active: 0, splitRatio: 80}});
  assert.equal(last.conversationLayout?.splitRatio, 80); assert.equal(last.conversationLayout?.active, 0);
});

test('a malformed saved conversation layout rejects on reopen without rewriting the record', async t => {
  const {root, store, workspace} = await setup(t); await store.close();
  const path = join(root, 'workspaces', `${workspace.id}.json`);
  const bytes = JSON.stringify({...workspace, conversationLayout: {tabs: [], active: 0, splitRatio: 50}});
  await writeFile(path, bytes); await assert.rejects(StateStore.open(root), /active conversation tab/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('appearance choices persist unchanged and unknown values do not advance the revision', async t => {
  const {root, store, workspace} = await setup(t);
  assert.equal(workspace.appearance, 'dark');
  const choices = ['dark', 'light', 'system', 'latte', 'frappe', 'macchiato', 'mocha'] as const;
  let revision = workspace.revision;
  for (const appearance of choices) {
    const saved = await store.updateSelection(workspace.id, {expectedRevision: revision, appearance});
    revision++;
    assert.equal(saved.appearance, appearance); assert.equal(saved.revision, revision);
    assert.equal(store.snapshot(workspace.id).workspace.appearance, appearance);
    assert.equal(JSON.parse(await readFile(join(root, 'workspaces', `${workspace.id}.json`), 'utf8')).appearance, appearance);
  }
  await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: revision, appearance: 'unknown' as Appearance}), /appearance/);
  assert.equal((await store.workspace(workspace.id)).revision, revision);
  assert.equal((await store.workspace(workspace.id)).appearance, 'mocha');
  await store.close(); const reopened = await StateStore.open(root);
  try { assert.equal(reopened.snapshot(workspace.id).workspace.appearance, 'mocha'); }
  finally { await reopened.close(); }
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

test('sidebar width is optional, integer bounded and revisioned without changing visibility', async t => {
  const {store, workspace} = await setup(t);
  assert.equal(workspace.sidebarWidth, undefined);
  const first = await store.updateSelection(workspace.id, {expectedRevision: 0, sidebarWidth: 200});
  assert.equal(first.sidebarWidth, 200); assert.equal(first.sidebarVisible, undefined); assert.equal(first.panelVisible, true);
  await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 0, sidebarWidth: 480}), error => error instanceof StateError && error.code === 'stale_revision');
  const last = await store.updateSelection(workspace.id, {expectedRevision: 1, sidebarWidth: 480});
  assert.equal(last.sidebarWidth, 480);
  const hidden = await store.updateSelection(workspace.id, {expectedRevision: 2, sidebarVisible: false});
  assert.equal(hidden.sidebarWidth, 480); assert.equal(hidden.revision, 3);
  for (const value of [null, '264', 199, 481, 200.5, NaN, Infinity, {}, []]) {
    await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 3, sidebarWidth: value as number}), /sidebar width/);
  }
  assert.equal((await store.workspace(workspace.id)).revision, 3);
  assert.equal(store.snapshot(workspace.id).workspace.sidebarWidth, 480);
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
