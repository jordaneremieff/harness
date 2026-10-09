import assert from 'node:assert/strict';
import test from 'node:test';
import type { Workspace } from '../shared/api.ts';
import type { SelectionChange } from './actions.ts';
import { SelectionQueue, navigationState, visibleReceipt } from './selection-state.ts';
test('navigation separates the selected conversation, sidebar preference and narrow drawer', () => {
  const workspace: Workspace = {id: 'w', revision: 1, panelVisible: false, selectedTarget: {kind: 'agent', identity: 'a'}};
  assert.deepEqual(navigationState(workspace, false), {sidebarVisible: true, agentSelected: true, editor: 'agent-editor'});
  assert.equal(navigationState(workspace, true).sidebarVisible, false);
  assert.equal(navigationState(workspace, true, true).sidebarVisible, true);
  assert.equal(navigationState({...workspace, sidebarVisible: false}, false).sidebarVisible, false);
  assert.deepEqual(navigationState({...workspace, selectedTarget: undefined}, false), {sidebarVisible: true, agentSelected: false, editor: 'primary-editor'});
  assert.equal(workspace.sidebarVisible, undefined);
});
function setup() {
  let current: Workspace = {id: 'workspace', revision: 0, primaryKey: 'p'};
  const calls: {workspace: Workspace; change: SelectionChange; resolve: (value: Workspace) => void; reject: (error: Error) => void}[] = [];
  const frames: Workspace[] = []; let reloads = 0;
  const queue = new SelectionQueue({current: () => current, paint(workspace) {current = workspace; frames.push(workspace);}, reload: async () => {reloads++;}, save: (workspace, change) => new Promise<Workspace>((resolve, reject) => {calls.push({workspace, change, resolve, reject});})});
  return {queue, calls, frames, get reloads() {return reloads;}};
}
test('cached last selection appears before any network response', async () => {
  const fixture = setup();
  const first = fixture.queue.select({selectedTarget: {kind: 'agent', identity: 'a'}});
  const second = fixture.queue.select({selectedTarget: {kind: 'agent', identity: 'b'}});
  assert.deepEqual(fixture.frames.at(-1)?.selectedTarget, {kind: 'agent', identity: 'b'});
  await Promise.resolve(); assert.equal(fixture.calls.length, 1);
  fixture.calls[0]?.resolve({id: 'workspace', revision: 1, selectedTarget: {kind: 'agent', identity: 'a'}}); await first;
  await Promise.resolve(); assert.equal(fixture.calls[1]?.workspace.revision, 1);
  assert.deepEqual(fixture.frames.at(-1)?.selectedTarget, {kind: 'agent', identity: 'b'});
  fixture.calls[1]?.resolve({id: 'workspace', revision: 2, selectedTarget: {kind: 'agent', identity: 'b'}}); await second;
  assert.equal(fixture.reloads, 1);
});
test('external selection acknowledgment cannot replace pending local intent', async () => {
  const fixture = setup(); const action = fixture.queue.select({selectedTarget: null}); await Promise.resolve();
  const observed = fixture.queue.observe({id: 'workspace', revision: 4, selectedTarget: {kind: 'agent', identity: 'external'}});
  assert.equal(observed.selectedTarget, undefined);
  fixture.calls[0]?.resolve({id: 'workspace', revision: 5}); await action;
  assert.equal(fixture.frames.at(-1)?.selectedTarget, undefined);
});
test('failed selection preserves the confirmed workspace and never retries', async () => {
  const fixture = setup(); const action = fixture.queue.select({primaryKey: 'new'}); await Promise.resolve();
  fixture.calls[0]?.reject(new Error('selection refused'));
  await assert.rejects(action, /selection refused/);
  assert.equal(fixture.frames.at(-1)?.primaryKey, 'p'); assert.equal(fixture.calls.length, 1);
});
test('selection errors use the visible receipt after rollback in either direction', async () => {
  const agent = {kind: 'agent' as const, identity: 'a'};
  for (const previous of [undefined, agent]) {
    const fixture = setup(); fixture.queue.observe({id: 'workspace', revision: 1, primaryKey: 'p', selectedTarget: previous});
    const attempted = previous ? null : agent; const pending = fixture.queue.select({selectedTarget: attempted});
    const optimisticSlot = visibleReceipt(fixture.frames.at(-1));
    let errorSlot = ''; const handled = pending.catch(() => {errorSlot = visibleReceipt(fixture.frames.at(-1));});
    await Promise.resolve(); fixture.calls[0]?.reject(new Error('Selection refused')); await handled;
    assert.equal(errorSlot, previous ? 'agent-receipt' : 'primary-receipt'); assert.notEqual(errorSlot, optimisticSlot);
  }
});
test('sidebar failure uses the current conversation receipt without a connection owner', async () => {
  const fixture = setup(); fixture.queue.observe({id: 'workspace', revision: 1, selectedTarget: {kind: 'agent', identity: 'a'}, sidebarVisible: true});
  const pending = fixture.queue.select({sidebarVisible: false}); let slot = '';
  const handled = pending.catch(() => {slot = visibleReceipt(fixture.frames.at(-1));});
  await Promise.resolve(); fixture.calls[0]?.reject(new Error('Sidebar save refused')); await handled;
  assert.equal(slot, 'agent-receipt'); assert.equal(fixture.frames.at(-1)?.sidebarVisible, true);
});
test('a refused selection does not discard the next queued choice', async () => {
  const fixture = setup(); const first = fixture.queue.select({primaryKey: 'a'}); const second = fixture.queue.select({primaryKey: 'b'}); await Promise.resolve();
  fixture.calls[0]?.reject(new Error('refused')); await assert.rejects(first, /refused/); await Promise.resolve();
  assert.equal(fixture.frames.at(-1)?.primaryKey, 'b'); fixture.calls[1]?.resolve({id: 'workspace', revision: 1, primaryKey: 'b'}); await second;
  assert.equal(fixture.frames.at(-1)?.primaryKey, 'b');
});

test('sidebar preference queues without changing selection or observation', async () => {
  const fixture = setup(); fixture.queue.observe({id: 'workspace', revision: 1, panelVisible: true, selectedTarget: {kind: 'agent', identity: 'a'}});
  const action = fixture.queue.select({sidebarVisible: false});
  assert.equal(fixture.frames.at(-1)?.sidebarVisible, false); assert.equal(fixture.frames.at(-1)?.panelVisible, true);
  assert.deepEqual(fixture.frames.at(-1)?.selectedTarget, {kind: 'agent', identity: 'a'});
  await Promise.resolve(); assert.deepEqual(fixture.calls[0]?.change, {sidebarVisible: false});
  fixture.calls[0]?.resolve({id: 'workspace', revision: 2, panelVisible: true, sidebarVisible: false, selectedTarget: {kind: 'agent', identity: 'a'}}); await action;
});

test('agent panel selection has no primary dependency and sends only the panel intent', async () => {
  const fixture = setup(); fixture.queue.observe({id: 'workspace', revision: 1, panelVisible: false});
  const action = fixture.queue.select({panelVisible: true}); assert.equal(fixture.frames.at(-1)?.primaryKey, undefined); assert.equal(fixture.frames.at(-1)?.panelVisible, true);
  await Promise.resolve(); assert.deepEqual(fixture.calls[0]?.change, {panelVisible: true});
  fixture.calls[0]?.resolve({id: 'workspace', revision: 2, panelVisible: true}); await action;
  assert.equal(fixture.frames.at(-1)?.panelVisible, true); assert.equal(fixture.frames.at(-1)?.primaryKey, undefined);
});
