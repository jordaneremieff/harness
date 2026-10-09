import assert from 'node:assert/strict';
import test from 'node:test';
import type { Workspace } from '../shared/api.ts';
import type { Registry } from './registry.mts';
import { dispatchView } from './routes-view.mts';

function fixture() {
  let workspace: Workspace = {id: 'w', revision: 0, panelVisible: true, selectedTarget: {kind: 'agent', identity: 'a'}};
  const changes: unknown[] = []; let hidden = 0; let observed = 0;
  const registry = {store: {workspace: async () => workspace, target: async () => undefined,
    updateSelection: async (_id: string, change: Partial<Workspace>) => {changes.push(change); workspace = {...workspace, ...change}; return workspace;}},
    agents: {hide: async () => {hidden++;}}, frames: new Map(), journal: {workspaceClients: () => 1}, observe: async () => {observed++;}} as unknown as Registry;
  return {changes, get hidden() {return hidden;}, get observed() {return observed;},
    select: (body: Record<string, unknown>) => dispatchView(registry, {parts: ['api', 'workspaces', 'w', 'selection'], body, method: 'PUT', url: new URL('http://localhost/api/workspaces/w/selection'), session: 'test'})};
}
test('sidebar visibility validates without releasing selected-agent observation', async () => {
  const f = fixture(); const saved = await f.select({expectedRevision: 0, sidebarVisible: false}) as Workspace;
  assert.equal(saved.sidebarVisible, false); assert.equal(saved.panelVisible, true);
  assert.deepEqual(f.changes, [{expectedRevision: 0, sidebarVisible: false}]); assert.equal(f.hidden, 0); assert.equal(f.observed, 1);
  await f.select({expectedRevision: 0, panelVisible: false}); assert.equal(f.hidden, 1);
});
test('invalid sidebar visibility rejects before the state write', async () => {
  const f = fixture();
  for (const sidebarVisible of [null, 'false', 0, {}, []]) await assert.rejects(f.select({expectedRevision: 0, sidebarVisible}), /sidebar visibility/);
  assert.deepEqual(f.changes, []);
});
