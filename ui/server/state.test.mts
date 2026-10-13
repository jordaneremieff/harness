import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StateError, StateStore, validateConversationLayout } from './state.mts';
import { Operations } from './operations.mts';
import { Journal } from './journal.mts';
import type { Appearance, ConversationLayout, Workspace } from '../shared/api.ts';

test('conversation layout accepts one bounded target-object tree and rejects flat records', () => {
  const layout: ConversationLayout = {root: {kind: 'split', id: 'split-1', axis: 'x', ratio: 50,
    first: {kind: 'pane', id: 'pane-1', tabs: [{kind: 'primary'}], active: 'primary'},
    second: {kind: 'pane', id: 'pane-2', tabs: [{kind: 'agent', identity: 'agent-one'}], active: 'agent:agent-one'}}, focusedPane: 'pane-2'};
  assert.doesNotThrow(() => validateConversationLayout(layout));
  assert.doesNotThrow(() => validateConversationLayout({root: {kind: 'pane', id: 'empty', tabs: [], active: null}, focusedPane: 'empty'}));
  assert.throws(() => validateConversationLayout({tabs: [{kind: 'primary'}], active: 0, splitRatio: 50}), StateError);
  assert.throws(() => validateConversationLayout({...layout, tabs: []}), StateError);
  assert.throws(() => validateConversationLayout({...layout, focusedPane: 'split-1'}), StateError);
  assert.throws(() => validateConversationLayout({...layout, root: {...layout.root, ratio: 50.5}}), StateError);
});
test('conversation layout rejects duplicate targets, unknown tab fields, empty groups and oversized trees', () => {
  const leaf = {kind: 'pane', id: 'pane-1', tabs: [{kind: 'primary'}], active: 'primary'};
  const layout = (root: unknown) => ({root, focusedPane: 'pane-1'});
  const invalid = [
    {...leaf, tabs: [{kind: 'primary'}, {kind: 'primary'}]},
    {...leaf, tabs: [{kind: 'agent', identity: 'one', split: false}], active: 'agent:one'},
    {...leaf, active: 'agent:missing'}, {...leaf, id: 'x'.repeat(65)},
    {...leaf, tabs: Array.from({length: 17}, (_, index) => ({kind: 'agent', identity: String(index)})), active: 'agent:0'},
    {kind: 'split', id: 'split', axis: 'x', ratio: 50, first: leaf, second: {...leaf, id: 'pane-2', tabs: [], active: null}},
    {kind: 'split', id: 'split', axis: 'x', ratio: 50, first: leaf, second: {...leaf, id: 'pane-2'}},
    {kind: 'split', id: 'split', axis: 'z', ratio: 50, first: leaf, second: {...leaf, id: 'pane-2'}},
  ];
  for (const root of invalid) assert.throws(() => validateConversationLayout(layout(root)), StateError);
  let root: unknown = leaf;
  for (let index = 0; index < 4; index++) root = {kind: 'split', id: `split-${index}`, axis: 'y', ratio: 50, first: root,
    second: {kind: 'pane', id: `extra-${index}`, tabs: [{kind: 'agent', identity: String(index)}], active: `agent:${index}`}};
  assert.throws(() => validateConversationLayout(layout(root)), StateError);
});
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

async function savedTextInput(t: test.TestContext) {
  const fixture = await setup(t), {store, workspace, target} = fixture;
  const draft = await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 0, text: 'exact text-only input', mode: 'prompt'});
  const operations = new Operations(store), view = await operations.reserve(workspace.id, 'primary.input', target.target);
  const result = await operations.execute(view.id, {workspaceId: workspace.id, kind: 'primary.input', target: target.target,
    body: {message: draft.text, mode: draft.mode, draftRevision: draft.revision},
    input: {targetKey: target.targetKey, text: draft.text, mode: draft.mode, draftRevision: draft.revision}},
  async () => {throw new Error('Fixture admission has no receipt');});
  assert.equal(result.state, 'uncertain');
  await store.close();
  return {...fixture, operationId: view.id, targetPath: join(fixture.root, 'targets', `${target.targetKey}.json`), operationPath: join(fixture.root, 'operations', `${view.id}.json`)};
}

for (const owner of ['draft', 'input'] as const) {
  test(`saved ${owner} without image metadata stays refused while valid queue recovery continues`, async t => {
    const f = await savedTextInput(t), initial = await StateStore.open(f.root);
    const validTarget = {kind: 'primary' as const, key: 'other-primary', epoch: 1};
    const valid = await initial.target(f.workspace.id, validTarget);
    const operations = new Operations(initial), clearId = await operations.beginQueueClear(f.workspace.id, validTarget, 1);
    await operations.retainQueue(clearId, {steering: ['exact recovered text'], followUp: []});
    const recoveredId = initial.records().find(record => record.queueRecovery?.clearOperationId === clearId)?.view.id; assert.ok(recoveredId);
    const operationCount = initial.operationStoreCount(), originalOperation = initial.record(f.operationId);
    await initial.close();
    const source = owner === 'draft' ? f.targetPath : f.operationPath;
    const record = JSON.parse(await readFile(source, 'utf8')); delete record[owner].images;
    await writeFile(source, JSON.stringify(record));
    const imageDirectory = join(f.root, 'images', f.target.targetKey); await mkdir(imageDirectory, {recursive: true});
    const imagePath = join(imageDirectory, `${'a'.repeat(64)}.bin`); await writeFile(imagePath, 'unclassified saved image bytes');
    const paths = [f.targetPath, f.operationPath, imagePath, join(f.root, 'instance.json'), join(f.root, 'workspaces', `${f.workspace.id}.json`)];
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    const journal = new Journal(); t.after(() => journal.close());
    const reopened = await StateStore.open(f.root, {onChange: (name, data, workspace, target) => journal.publish(name, target, data, workspace)});
    try {
      assert.equal(journal.notices(f.workspace.id).some(notice => notice.code === 'state_record_refused' && notice.message.includes(`Saved ${owner} image metadata requires an array`)), true);
      assert.equal(reopened.records().some(record => record.view.id === f.operationId), false);
      assert.equal(reopened.operationStoreCount(), operationCount);
      await assert.rejects(reopened.writeOperation(originalOperation), {code: 'state_record_refused', message: 'A refused saved operation cannot be rewritten'});
      assert.equal(await readFile(f.operationPath, 'utf8'), before[1]);
      assert.equal(reopened.targetIndex(f.workspace.id).some(target => target.targetKey === f.target.targetKey), owner === 'input');
      assert.equal((await reopened.getRetainedInput(f.workspace.id, recoveredId)).text, 'exact recovered text');
      const next = new Operations(reopened), nextId = await next.beginQueueClear(f.workspace.id, validTarget, 1);
      await next.retainQueue(nextId, {steering: [], followUp: ['new recovered text']});
      const draft = await reopened.putDraft(f.workspace.id, valid.targetKey, {expectedRevision: 0, text: 'text remains available', mode: 'prompt'});
      assert.deepEqual(draft.images, []);
      assert.equal((await reopened.getTarget(f.workspace.id, valid.targetKey)).imageStorageError?.code, 'image_storage_unavailable');
      await assert.rejects(reopened.reserveImageUpload(f.workspace.id, valid.targetKey, {name: 'image.png', mimeType: 'image/png', epoch: 1}, () => {}), {code: 'image_storage_unavailable'});
    } finally {await reopened.close();}
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before);
    await assert.rejects(stat(join(f.root, 'lock.json')), {code: 'ENOENT'});
  });
}

test('queue publication never rewrites a refused saved row at the same operation identity', async t => {
  const f = await setup(t); assert.ok(f.target.target.kind === 'primary');
  const operations = new Operations(f.store), queue = {steering: ['exact queue text'], followUp: []};
  const clearId = await operations.beginQueueClear(f.workspace.id, f.target.target, 1);
  await operations.retainQueue(clearId, queue);
  const row = f.store.records().find(record => record.queueRecovery?.clearOperationId === clearId); assert.ok(row);
  await f.store.close();
  const rowPath = join(f.root, 'operations', `${row.view.id}.json`), clearPath = join(f.root, 'operations', `${clearId}.json`);
  const savedRow = JSON.parse(await readFile(rowPath, 'utf8')); delete savedRow.input.images;
  const bytes = JSON.stringify(savedRow); await writeFile(rowPath, bytes);
  const anchor = JSON.parse(await readFile(clearPath, 'utf8')); anchor.queueClear.phase = 'retaining'; anchor.view.state = 'dispatched';
  await writeFile(clearPath, JSON.stringify(anchor));
  const reopened = await StateStore.open(f.root);
  try {
    await assert.rejects(new Operations(reopened).retainQueue(clearId, queue), {code: 'state_record_refused', message: 'A refused saved operation cannot be rewritten'});
    assert.equal(reopened.records().some(record => record.view.id === row.view.id), false);
    assert.equal(await readFile(rowPath, 'utf8'), bytes);
  } finally {await reopened.close();}
});

test('current text-only writers persist explicit image arrays and reopen without normalization', async t => {
  const f = await savedTextInput(t);
  assert.deepEqual(JSON.parse(await readFile(f.targetPath, 'utf8')).draft.images, []);
  assert.deepEqual(JSON.parse(await readFile(f.operationPath, 'utf8')).input.images, []);
  const reopened = await StateStore.open(f.root);
  try {
    const target = await reopened.getTarget(f.workspace.id, f.target.targetKey);
    assert.equal(target.draft.text, 'exact text-only input'); assert.deepEqual(target.draft.images, []);
    assert.equal(reopened.record(f.operationId).input?.text, target.draft.text);
    assert.deepEqual(reopened.record(f.operationId).input?.images, []);
  } finally {await reopened.close();}
});

test('Enter preference is workspace-local, revisioned, optional and durable', async t => {
  const {root, store, workspace} = await setup(t);
  assert.equal(workspace.enterSendsMessages, undefined);
  const other = await store.createWorkspace();
  const saved = await store.updateSelection(workspace.id, {expectedRevision: 0, enterSendsMessages: true});
  assert.equal(saved.enterSendsMessages, true); assert.equal(saved.revision, 1);
  assert.equal((await store.workspace(other.id)).enterSendsMessages, undefined);
  await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 0, enterSendsMessages: false}), StateError);
  await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 1, enterSendsMessages: 'yes'} as unknown as Parameters<StateStore['updateSelection']>[1]), StateError);
  const unchanged = await store.updateSelection(workspace.id, {expectedRevision: 1, appearance: 'light'}); assert.equal(unchanged.enterSendsMessages, true);
  await store.close(); const reopened = await StateStore.open(root);
  try {
    assert.equal((await reopened.workspace(workspace.id)).enterSendsMessages, true);
    const off = await reopened.updateSelection(workspace.id, {expectedRevision: 2, enterSendsMessages: false}); assert.equal(off.enterSendsMessages, false);
  } finally {await reopened.close();}
});
test('conversation layouts replace atomically, clone nested values, preserve omission and survive restart', async t => {
  const events: Workspace[] = [];
  const {root, store, workspace, target} = await setup(t, {onChange: (name, data) => {if (name === 'workspace.changed') events.push(data as Workspace);}});
  assert.equal(workspace.conversationLayout, undefined); assert.equal(workspace.appearance, 'dark');
  const layout: ConversationLayout = {root: {kind: 'split', id: 'split', axis: 'x', ratio: 60, first: {kind: 'pane', id: 'left', tabs: [{kind: 'primary'}], active: 'primary'}, second: {kind: 'pane', id: 'right', tabs: [{kind: 'agent', identity: 'agent-a'}], active: 'agent:agent-a'}}, focusedPane: 'right'};
  const original = structuredClone(layout);
  const saved = await store.updateSelection(workspace.id, {expectedRevision: 0, conversationLayout: layout, selectedTarget: {kind: 'agent', identity: 'agent-a'}});
  assert.deepEqual(saved.conversationLayout, original); assert.equal(saved.revision, 1);
  assert.ok(saved.conversationLayout); const published = events.at(-1)?.conversationLayout; assert.ok(published);
  assert.ok(layout.root.kind === 'split'); assert.ok(saved.conversationLayout.root.kind === 'split'); assert.ok(published.root.kind === 'split');
  assert.ok(layout.root.first.kind === 'pane'); assert.ok(saved.conversationLayout.root.second.kind === 'pane');
  layout.root.first.tabs.length = 0; saved.conversationLayout.root.second.tabs.pop(); published.root.ratio = 20;
  const snapshot = store.snapshot(workspace.id); assert.ok(snapshot.workspace.conversationLayout); snapshot.workspace.conversationLayout.focusedPane = 'left';
  assert.deepEqual((await store.workspace(workspace.id)).conversationLayout, original);
  await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 0, conversationLayout: original}), error => error instanceof StateError && error.code === 'stale_revision');
  const selected = await store.updateSelection(workspace.id, {expectedRevision: 1, appearance: 'mocha', sidebarWidth: 320});
  assert.deepEqual(selected.conversationLayout, original); assert.deepEqual(selected.selectedTarget, {kind: 'agent', identity: 'agent-a'});
  const replacement: ConversationLayout = {root: {kind: 'pane', id: 'pane', tabs: [{kind: 'agent', identity: 'agent-b'}], active: 'agent:agent-b'}, focusedPane: 'pane'};
  const replaced = await store.updateSelection(workspace.id, {expectedRevision: 2, conversationLayout: replacement, selectedTarget: {kind: 'agent', identity: 'agent-b'}});
  assert.deepEqual(replaced.conversationLayout, replacement); assert.deepEqual(replaced.selectedTarget, {kind: 'agent', identity: 'agent-b'});
  await store.close(); const reopened = await StateStore.open(root);
  try {
    const restored = await reopened.workspace(workspace.id);
    assert.deepEqual(restored.conversationLayout, replacement); assert.equal(restored.appearance, 'mocha'); assert.equal(restored.sidebarWidth, 320);
    const empty: ConversationLayout = {root: {kind: 'pane', id: 'pane', tabs: [], active: null}, focusedPane: 'pane'};
    const closed = await reopened.updateSelection(workspace.id, {expectedRevision: 3, conversationLayout: empty, selectedTarget: null});
    assert.deepEqual(closed.conversationLayout, empty); assert.equal(closed.selectedTarget, undefined);
    assert.equal((await reopened.getTarget(workspace.id, target.targetKey)).targetKey, target.targetKey);
  } finally { await reopened.close(); }
});

test('invalid conversation layouts never advance revisions, write state or publish changes', async t => {
  const changes: string[] = [];
  const {root, store, workspace} = await setup(t, {onChange: name => {changes.push(name);}});
  const leaf = {kind: 'pane', id: 'pane', tabs: [{kind: 'primary'}], active: 'primary'};
  const one = {root: leaf, focusedPane: 'pane'};
  const wrap = (root: unknown) => ({root, focusedPane: 'pane'});
  const agent = {kind: 'agent', identity: 'agent'};
  const split = {kind: 'split', id: 'split', axis: 'x', ratio: 50, first: leaf, second: {kind: 'pane', id: 'other', tabs: [agent], active: 'agent:agent'}};
  const invalid: unknown[] = [null, [], 1, {}, {...one, extra: true}, {root: leaf}, {focusedPane: 'pane'}, {...one, focusedPane: 'missing'},
    ...[null, {}, [], [{kind: 'primary'}, {kind: 'primary'}], [agent, agent], [null], [[]], [{kind: 'other'}], [{kind: 'primary', extra: true}],
      [{kind: 'primary', key: 'primary', epoch: 1}], [{...agent, split: false}], [{...agent, extra: true}],
      Array.from({length: 17}, (_, index) => ({kind: 'agent', identity: String(index)}))].map(tabs => wrap({...leaf, tabs})),
    ...[null, '', 'missing', 0, 1, NaN, Infinity].map(active => wrap({...leaf, active})),
    ...['', 'x'.repeat(65), 'bad\nid', null, 1].map(id => wrap({...leaf, id})),
    ...[19, 81, 50.5, '50', NaN, Infinity].map(ratio => wrap({...split, ratio})),
    wrap({...split, axis: 'z'}), wrap({...split, second: leaf}), wrap({...split, second: {...split.second, tabs: [], active: null}}),
    ...['', 'x'.repeat(257), 'bad\nidentity', null, 1].map(identity => wrap({...leaf, tabs: [{...agent, identity}], active: 'agent:agent'})),
  ];
  const path = join(root, 'workspaces', `${workspace.id}.json`); const bytes = await readFile(path, 'utf8');
  for (const conversationLayout of invalid) await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 0, conversationLayout: conversationLayout as ConversationLayout}), error => error instanceof StateError && error.code === 'invalid_request');
  assert.deepEqual(await store.workspace(workspace.id), workspace); assert.equal(await readFile(path, 'utf8'), bytes); assert.deepEqual(changes, ['workspace.changed']);
});

test('conversation tab and ratio boundaries retain the workspace file bound', async t => {
  const {root, store, workspace} = await setup(t);
  const leaf = (id: string, offset: number): Extract<import('../shared/api.ts').PaneNode, {kind: 'pane'}> => ({kind: 'pane', id, tabs: Array.from({length: 8}, (_, index) => ({kind: 'agent', identity: `agent-${index + offset}`})), active: `agent:${id}`});
  const layout: ConversationLayout = {root: {kind: 'split', id: 'split', axis: 'x', ratio: 20, first: {...leaf('left', 0), active: 'agent:agent-7'}, second: {...leaf('right', 8), active: 'agent:agent-15'}}, focusedPane: 'right'};
  const first = await store.updateSelection(workspace.id, {expectedRevision: 0, conversationLayout: layout});
  assert.deepEqual(first.conversationLayout, layout);
  const huge = structuredClone(layout); assert.ok(huge.root.kind === 'split');
  for (const [index, pane] of [huge.root.first, huge.root.second].entries()) {
    assert.ok(pane.kind === 'pane');
    pane.tabs = pane.tabs.map((_tab, offset) => ({kind: 'agent', identity: `${'\\'.repeat(254)}${index * 8 + offset}`}));
    const active = pane.tabs[0]; assert.ok(active?.kind === 'agent'); pane.active = `agent:${active.identity}`;
  }
  assert.ok(Buffer.byteLength(JSON.stringify({...first, conversationLayout: huge})) > 8192);
  await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 1, conversationLayout: huge}), error => error instanceof StateError && error.code === 'payload_too_large');
  assert.deepEqual(await store.workspace(workspace.id), first);
  await rename(join(root, 'workspaces'), join(root, 'workspaces-away'));
  const replacement = structuredClone(layout); assert.ok(replacement.root.kind === 'split'); replacement.root.ratio = 80; replacement.focusedPane = 'left';
  await assert.rejects(store.updateSelection(workspace.id, {expectedRevision: 1, conversationLayout: replacement}));
  assert.deepEqual(await store.workspace(workspace.id), first);
  await rename(join(root, 'workspaces-away'), join(root, 'workspaces'));
  const last = await store.updateSelection(workspace.id, {expectedRevision: 1, conversationLayout: replacement});
  assert.equal(last.conversationLayout?.root.kind === 'split' && last.conversationLayout.root.ratio, 80); assert.equal(last.conversationLayout?.focusedPane, 'left');
});

test('a malformed saved conversation layout rejects on reopen without rewriting the record', async t => {
  const {root, store, workspace} = await setup(t); await store.close();
  const path = join(root, 'workspaces', `${workspace.id}.json`);
  const bytes = JSON.stringify({...workspace, conversationLayout: {root: {kind: 'pane', id: 'pane', tabs: [], active: 'primary'}, focusedPane: 'pane'}});
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

test('target index previews retain exact draft prefixes, revision and Unicode without leaking full text', async t => {
  const {store, workspace, target} = await setup(t);
  const short = ' exact\n  saved <script> '; await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 0, text: short, mode: 'prompt'});
  let row = store.targetIndex(workspace.id)[0]; assert.equal(row.draftPreview, short); assert.equal(row.draftPreviewTruncated, false); assert.equal(row.draftRevision, 1);
  const text = '😀'.repeat(241); await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 1, text, mode: 'prompt'});
  row = store.targetIndex(workspace.id)[0]; assert.equal(row.draftPreview, '😀'.repeat(240)); assert.equal(row.draftPreviewTruncated, true); assert.equal(row.draftRevision, 2);
  assert.equal((await store.getTarget(workspace.id, target.targetKey)).draft.text, text);
  await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 2, text: '', mode: 'prompt'});
  row = store.targetIndex(workspace.id)[0]; assert.equal(row.hasDraft, false); assert.equal(row.draftPreview, ''); assert.equal(row.draftPreviewTruncated, false);
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

test('selection clear preserves old targets, synchronous index bounds draft previews, and unknown fields reject', async t => {
  const {store, workspace, target} = await setup(t);
  await store.putDraft(workspace.id, target.targetKey, {expectedRevision: 0, text: 'x'.repeat(64 * 1024), mode: 'prompt'});
  const selected = await store.updateSelection(workspace.id, {expectedRevision: 0, primaryKey: 'primary', selectedTarget: target.target});
  const cut = store.snapshot(workspace.id, [target.target]);
  assert.equal(cut.targets.length, 1); assert.equal(cut.targetIndex[0]?.hasDraft, true);
  assert.ok(Buffer.byteLength(JSON.stringify(store.targetIndex(workspace.id))) < 1024);
  assert.equal(cut.targetIndex[0]?.draftPreview, 'x'.repeat(240)); assert.equal(cut.targetIndex[0]?.draftPreviewTruncated, true);
  assert.equal(JSON.stringify(cut.targetIndex).includes('x'.repeat(241)), false);
  const cleared = await store.updateSelection(workspace.id, {expectedRevision: selected.revision, selectedTarget: null});
  assert.equal(cleared.selectedTarget, undefined); assert.equal((await store.getTarget(workspace.id, target.targetKey)).draft.text.length, 64 * 1024);
  const invalid = {expectedRevision: cleared.revision, unexpected: 'private field'};
  await assert.rejects(store.updateSelection(workspace.id, invalid), /Unknown workspace field/);
});
