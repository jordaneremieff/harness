import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationLayout, ConversationTab, Workspace } from '../shared/api.ts';
import { activeTab, closeTab, layoutTarget, MAX_TABS, moveTab, openTab, splitGeometry, splitPercent, switchTab, tabForTarget, tabKey, toggleSplit, workspaceLayout } from './tabs.ts';

const agent = (identity: string): ConversationTab => ({kind: 'agent', identity, split: false});
const base = (): ConversationLayout => ({tabs: [{kind: 'primary'}], active: 0, splitRatio: 50});
const workspace = (layout?: ConversationLayout): Workspace => ({id: 'fixture', revision: 0, ...(layout ? {conversationLayout: layout} : {})});
test('workspace defaults and restored layouts keep the exact active conversation and split size', () => {
  assert.deepEqual(workspaceLayout(), base());
  const selected = {...workspace(), selectedTarget: {kind: 'agent' as const, identity: 'a'}};
  assert.deepEqual(workspaceLayout(selected), {...base(), tabs: [{kind: 'primary'}, agent('a')], active: 1});
  const saved = toggleSplit(openTab(base(), agent('a'))); saved.splitRatio = 62;
  assert.deepEqual(workspaceLayout({...selected, conversationLayout: saved}), saved);
  assert.deepEqual(workspaceLayout(workspace({tabs: [], active: null, splitRatio: 50})), {tabs: [], active: null, splitRatio: 50});
});
test('opening focuses existing tabs without changing order or split preference', () => {
  const layout = toggleSplit(openTab(base(), agent('a')));
  const two = openTab(layout, agent('b'));
  const focused = openTab(two, agent('a'));
  assert.equal(focused.active, 1); assert.equal(focused.tabs.length, 3);
  assert.deepEqual(focused.tabs[1], {kind: 'agent', identity: 'a', split: true});
  assert.deepEqual(layout.tabs, [{kind: 'primary'}, {kind: 'agent', identity: 'a', split: true}]);
});
test('close chooses an adjacent tab or an explicit empty layout without modifying target state', () => {
  const layout = openTab(openTab(base(), agent('a')), agent('b'));
  assert.equal(closeTab(layout, 0).active, 1);
  const closed = closeTab(layout, 2); const selected = activeTab(closed); assert.ok(selected); assert.equal(tabKey(selected), 'agent:a');
  assert.deepEqual(closeTab(base(), 0), {tabs: [], active: null, splitRatio: 50});
  assert.equal(closeTab(layout, -1), layout);
  assert.equal(layout.tabs.length, 3);
});
test('reorder follows the active tab identity and keeps split metadata', () => {
  const layout = toggleSplit(openTab(openTab(base(), agent('a')), agent('b')));
  const moved = moveTab(layout, 2, 0);
  assert.deepEqual(moved.tabs.map(tabKey), ['agent:b', 'primary', 'agent:a']);
  assert.equal(moved.active, 0); assert.deepEqual(activeTab(moved), {kind: 'agent', identity: 'b', split: true});
  assert.equal(moveTab(layout, -1, 0), layout); assert.equal(moveTab(layout, 0, 5), layout);
  assert.deepEqual(layout.tabs.map(tabKey), ['primary', 'agent:a', 'agent:b']);
});
test('keyboard switching wraps and the primary target uses the current epoch', () => {
  const layout = openTab(base(), agent('a'));
  assert.equal(switchTab(layout, 1).active, 0); assert.equal(switchTab(base(), -1).active, 0);
  assert.equal(switchTab({...base(), tabs: [], active: null}, 1).active, null);
  assert.deepEqual(layoutTarget(layout), {kind: 'agent', identity: 'a'});
  assert.deepEqual(layoutTarget(base(), {kind: 'primary', key: 'p', epoch: 8}), {kind: 'primary', key: 'p', epoch: 8});
  assert.equal(layoutTarget({tabs: [], active: null, splitRatio: 50}), null);
  assert.deepEqual(tabForTarget({kind: 'primary', key: 'p', epoch: 8}), {kind: 'primary'});
});
test('splits are primary plus one agent and their ratio stays bounded', () => {
  assert.equal(toggleSplit(base()).tabs[0]?.kind, 'primary');
  const layout = openTab(base(), agent('a')); assert.equal(layoutTarget(toggleSplit(layout))?.kind, 'agent');
  assert.deepEqual(toggleSplit(toggleSplit(layout)), layout);
  assert.equal(splitPercent(0, 500), 20); assert.equal(splitPercent(999, 500), 80);
  assert.equal(splitPercent(275, 500), 55); assert.equal(splitPercent(0, 0), 50);
});
test('split geometry reserves the actual divider and both 320px pane minimums', () => {
  assert.equal(splitGeometry(644, 5, 50), undefined);
  assert.equal(splitGeometry(683, 44, 50), undefined);
  assert.deepEqual(splitGeometry(645, 5, 20), {width: 640, min: 320, max: 320, primary: 320});
  assert.deepEqual(splitGeometry(684, 44, 80), {width: 640, min: 320, max: 320, primary: 320});
  assert.deepEqual(splitGeometry(700.75, 5, 20), {width: 695, min: 320, max: 375, primary: 320});
  assert.equal(splitGeometry(644.99, 5, 50), undefined);
  assert.equal(splitGeometry(Number.NaN, 5, 50), undefined);
});
test('saved ratios project into safe pixel bounds at every supported split width', () => {
  for (const divider of [5, 44]) for (const width of [640, 650, 800, 1000, 1600, 2400]) for (const ratio of [20, 37, 50, 63, 80]) {
    const size = splitGeometry(width + divider, divider, ratio); assert.ok(size);
    assert.ok(size.primary >= 320); assert.ok(size.width - size.primary >= 320);
    assert.ok(Number.isSafeInteger(size.min) && Number.isSafeInteger(size.max));
    assert.ok(size.min >= Math.ceil(width * .2)); assert.ok(size.max <= Math.floor(width * .8));
    assert.ok(size.primary >= size.min && size.primary <= size.max);
  }
});
test('capacity fails without evicting drafts and externally selected sessions remain reachable', () => {
  let full = base(); for (let i = 1; i < MAX_TABS; i++) full = openTab(full, agent(String(i)));
  assert.throws(() => openTab(full, agent('extra')), /Close a conversation tab/);
  assert.equal(openTab(full, agent('1')).active, 1);
  const external = workspaceLayout({...workspace(full), selectedTarget: {kind: 'agent', identity: 'external'}});
  assert.equal(external.tabs.length, MAX_TABS); assert.deepEqual(activeTab(external), agent('external'));
  assert.equal(full.tabs.some(tab => tabKey(tab) === 'agent:external'), false);
});
