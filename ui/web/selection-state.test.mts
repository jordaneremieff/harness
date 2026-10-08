import assert from 'node:assert/strict';
import test from 'node:test';
import type { Workspace } from '../shared/api.ts';
import type { SelectionChange } from './actions.ts';
import { SelectionQueue } from './selection-state.ts';
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
test('a refused selection does not discard the next queued choice', async () => {
  const fixture = setup(); const first = fixture.queue.select({primaryKey: 'a'}); const second = fixture.queue.select({primaryKey: 'b'}); await Promise.resolve();
  fixture.calls[0]?.reject(new Error('refused')); await assert.rejects(first, /refused/); await Promise.resolve();
  assert.equal(fixture.frames.at(-1)?.primaryKey, 'b'); fixture.calls[1]?.resolve({id: 'workspace', revision: 1, primaryKey: 'b'}); await second;
  assert.equal(fixture.frames.at(-1)?.primaryKey, 'b');
});

test('agent panel selection has no primary dependency and sends only the panel intent', async () => {
  const fixture = setup(); fixture.queue.observe({id: 'workspace', revision: 1, panelVisible: false});
  const action = fixture.queue.select({panelVisible: true}); assert.equal(fixture.frames.at(-1)?.primaryKey, undefined); assert.equal(fixture.frames.at(-1)?.panelVisible, true);
  await Promise.resolve(); assert.deepEqual(fixture.calls[0]?.change, {panelVisible: true});
  fixture.calls[0]?.resolve({id: 'workspace', revision: 2, panelVisible: true}); await action;
  assert.equal(fixture.frames.at(-1)?.panelVisible, true); assert.equal(fixture.frames.at(-1)?.primaryKey, undefined);
});
