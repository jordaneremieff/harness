import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationLayout, Workspace } from '../shared/api.ts';
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
test('conversation layout replacement validates, clones and leaves observation tied to selection', async () => {
  const f = fixture();
  const conversationLayout: ConversationLayout = {tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'a', split: true}], active: 1, splitRatio: 50};
  const original = structuredClone(conversationLayout);
  const saved = await f.select({expectedRevision: 0, conversationLayout, selectedTarget: {kind: 'agent', identity: 'a'}}) as Workspace;
  assert.deepEqual(saved.conversationLayout, original); assert.equal(f.hidden, 0); assert.equal(f.observed, 1);
  conversationLayout.tabs.length = 0;
  assert.deepEqual(f.changes, [{expectedRevision: 0, conversationLayout: original, selectedTarget: {kind: 'agent', identity: 'a'}}]);
  const preserved = await f.select({expectedRevision: 0, sidebarVisible: false}) as Workspace;
  assert.deepEqual(preserved.conversationLayout, original);
  const empty = {tabs: [], active: null, splitRatio: 50};
  const closed = await f.select({expectedRevision: 0, conversationLayout: empty, selectedTarget: null}) as Workspace;
  assert.deepEqual(closed.conversationLayout, empty); assert.equal(f.hidden, 1);
  assert.deepEqual(f.changes.at(-1), {expectedRevision: 0, conversationLayout: empty, selectedTarget: null});
});
test('conversation layout accepts endpoint bounds and does not enforce a selection match', async () => {
  const f = fixture();
  const tabs = Array.from({length: 16}, (_, i) => ({kind: 'agent', identity: `agent-${i}`, split: i % 2 === 0}));
  for (const splitRatio of [20, 80]) {
    const conversationLayout = {tabs, active: 15, splitRatio};
    const saved = await f.select({expectedRevision: 0, conversationLayout}) as Workspace;
    assert.deepEqual(saved.conversationLayout, conversationLayout);
    assert.deepEqual(saved.selectedTarget, {kind: 'agent', identity: 'a'});
  }
});
test('invalid conversation layouts reject before the state write', async () => {
  const f = fixture(); const one = {tabs: [{kind: 'primary'}], active: 0, splitRatio: 50};
  const agent = {kind: 'agent', identity: 'a', split: false};
  const invalid = [null, [], {}, {...one, unknown: true}, {tabs: [], active: 0, splitRatio: 50}, {...one, active: null},
    {...one, active: 1}, {...one, active: 0.5}, {...one, splitRatio: 19}, {...one, splitRatio: 81}, {...one, splitRatio: '50'},
    {...one, tabs: Array.from({length: 17}, (_, i) => ({...agent, identity: `agent-${i}`}))}, {...one, tabs: [{kind: 'primary'}, {kind: 'primary'}]},
    {...one, tabs: [agent, {...agent, split: true}]}, {...one, tabs: [{kind: 'primary', split: true}]}, {...one, tabs: [{...agent, label: 'Agent'}]},
    {...one, tabs: [{kind: 'agent', identity: 'a'}]}, {...one, tabs: [{...agent, split: null}]}, {...one, tabs: [{...agent, identity: 'bad\nidentity'}]},
    {...one, tabs: [{...agent, identity: ''}]}, {...one, tabs: [{...agent, identity: 'x'.repeat(257)}]},
  ];
  for (const conversationLayout of invalid) await assert.rejects(f.select({expectedRevision: 0, conversationLayout}));
  assert.deepEqual(f.changes, []); assert.equal(f.hidden, 0); assert.equal(f.observed, 0);
});
test('appearance choices validate and unknown values reject before the state write', async () => {
  const f = fixture();
  const choices = ['dark', 'light', 'system', 'latte', 'frappe', 'macchiato', 'mocha'] as const;
  for (const appearance of choices) {
    const saved = await f.select({expectedRevision: 0, appearance}) as Workspace;
    assert.equal(saved.appearance, appearance);
  }
  await assert.rejects(f.select({expectedRevision: 0, appearance: 'unknown'}), /appearance/);
  assert.deepEqual(f.changes, choices.map(appearance => ({expectedRevision: 0, appearance})));
});
test('sidebar visibility validates without releasing selected-agent observation', async () => {
  const f = fixture(); const saved = await f.select({expectedRevision: 0, sidebarVisible: false}) as Workspace;
  assert.equal(saved.sidebarVisible, false); assert.equal(saved.panelVisible, true);
  assert.deepEqual(f.changes, [{expectedRevision: 0, sidebarVisible: false}]); assert.equal(f.hidden, 0); assert.equal(f.observed, 1);
  await f.select({expectedRevision: 0, panelVisible: false}); assert.equal(f.hidden, 1);
});
test('sidebar width validates and returns without releasing selected-agent observation', async () => {
  const f = fixture();
  for (const sidebarWidth of [200, 264, 480]) {
    const saved = await f.select({expectedRevision: 0, sidebarWidth}) as Workspace;
    assert.equal(saved.sidebarWidth, sidebarWidth); assert.equal(saved.panelVisible, true);
    assert.equal(saved.sidebarVisible, undefined);
  }
  assert.deepEqual(f.changes, [200, 264, 480].map(sidebarWidth => ({expectedRevision: 0, sidebarWidth})));
  assert.equal(f.hidden, 0); assert.equal(f.observed, 3);
});
test('invalid sidebar width rejects before the state write', async () => {
  const f = fixture();
  for (const sidebarWidth of [null, '264', 199, 481, 200.5, NaN, Infinity, {}, []]) await assert.rejects(f.select({expectedRevision: 0, sidebarWidth}), /sidebar width/);
  assert.deepEqual(f.changes, []);
});
test('invalid sidebar visibility rejects before the state write', async () => {
  const f = fixture();
  for (const sidebarVisible of [null, 'false', 0, {}, []]) await assert.rejects(f.select({expectedRevision: 0, sidebarVisible}), /sidebar visibility/);
  assert.deepEqual(f.changes, []);
});
