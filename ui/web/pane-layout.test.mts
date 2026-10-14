import assert from 'node:assert/strict';
import test from 'node:test';
import type {ConversationTab, PaneNode} from '../shared/api.ts';
import {MAX_TABS, tabKey} from './tabs.ts';
import {activatePaneTab, canSplitPane, closePane, closePaneTab, createPaneLayout, focusPaneLayout, MAX_PANES, minimumPaneSize, movePaneTab, normalizePaneLayout, openPaneTab, paneById, paneForTab, paneLeaves, paneSplitGeometry, resizePaneSplit, splitPane, validPaneLayout, samePaneLayout} from './pane-layout.ts';
const agent = (identity: string): ConversationTab => ({kind: 'agent', identity});
const space = {width: 1400, height: 1000, divider: 4};
const base = () => createPaneLayout([{kind: 'primary'}, agent('a'), agent('b'), agent('c')], 'agent:a');
const keys = (root: PaneNode) => paneLeaves(root).flatMap(pane => pane.tabs.map(tabKey));

test('file views have no tab count cap and conversations alone exhaust admission',()=> {
  let layout = createPaneLayout(Array.from({length:MAX_TABS},(_,index)=>agent(`conversation-${index}`)));
  for (let index = 0;index < MAX_TABS+2;index++) layout = openPaneTab(layout,'pane-1',{kind:'file',rootId:'r',path:`file-${index}.md`});
  assert.equal(validPaneLayout(layout),true);assert.equal(paneLeaves(layout.root)[0]?.tabs.length,MAX_TABS*2+2);
  assert.throws(()=>openPaneTab(layout,'pane-1',agent('overflow')),/tab limit/);
  const preview = openPaneTab(layout,'pane-1',{kind:'file',rootId:'r',path:'file-0.md',view:'preview'});assert.equal(validPaneLayout(preview),true);assert.equal(paneLeaves(preview.root)[0]?.tabs.length,MAX_TABS*2+3);
});
test('layout equality compares exact content and geometry rather than allocation identity', () => {
  const original = base(); assert.equal(samePaneLayout(original, structuredClone(original)), true);
  const next = structuredClone(original); next.focusedPane = 'changed'; assert.equal(samePaneLayout(original, next), false);
  const target = structuredClone(original); if (target.root.kind === 'pane') target.root.tabs[1] = agent('changed');
  assert.equal(samePaneLayout(original, target), false);
  const split = splitPane(original, 'pane-1', 'x', space); assert.equal(samePaneLayout(original, split), false);
  assert.equal(samePaneLayout(split, resizePaneSplit(split, split.root.id, 60)), false);
});
test('right and down splits address exact tabs, preserve other selection and never duplicate a target', () => {
  const original = base(); const snapshot = JSON.stringify(original); const b = paneById(original, 'pane-1')?.tabs[2];
  const right = splitPane(original, 'pane-1', 'x', space, 'agent:b'); assert.equal(right.root.kind, 'split');
  assert.equal(right.focusedPane, 'pane-2'); assert.equal(paneById(right, 'pane-2')?.tabs[0], b);
  assert.equal(paneById(right, 'pane-1')?.active, 'agent:a'); assert.deepEqual(keys(right.root).sort(), keys(original.root).sort());
  const down = splitPane(right, 'pane-1', 'y', space, 'primary'); assert.equal(down.root.kind === 'split' && down.root.first.kind === 'split' && down.root.first.axis, 'y');
  assert.equal(paneForTab(down, 'primary')?.id, 'pane-3'); assert.equal(validPaneLayout(down), true); assert.equal(JSON.stringify(original), snapshot);
});
test('sole-tab split stays provisional, cancel restores the exact source and fill yields a durable tree', () => {
  const original = createPaneLayout([agent('a')]); const staged = splitPane(original, 'pane-1', 'y', space);
  assert.equal(paneById(staged, 'pane-1')?.active, 'agent:a'); assert.equal(paneById(staged, 'pane-2')?.active, null); assert.equal(validPaneLayout(staged), false);
  const canceled = closePane(staged, 'pane-2'); assert.deepEqual(canceled, original); assert.equal(canceled.root, original.root);
  assert.deepEqual(normalizePaneLayout(staged), original);
  const filled = openPaneTab(staged, 'pane-2', agent('b')); assert.equal(validPaneLayout(filled), true); assert.equal(filled.focusedPane, 'pane-2');
  assert.deepEqual(keys(filled.root), ['agent:a', 'agent:b']);
});
test('existing chooser target focuses its owner; deliberate move into provisional pane moves instead of copying', () => {
  const original = base(); const chosen = openPaneTab(original, 'pane-1', agent('b'));
  assert.equal(paneById(chosen, 'pane-1')?.tabs.length, 4); assert.equal(paneById(chosen, 'pane-1')?.active, 'agent:b');
  let staged = splitPane(chosen, 'pane-1', 'x', space, 'agent:b'); staged = splitPane(staged, 'pane-2', 'y', space);
  const filled = movePaneTab(staged, 'agent:a', 'pane-3'); assert.equal(validPaneLayout(filled), true); assert.equal(keys(filled.root).filter(key => key === 'agent:a').length, 1);
});
test('pane and conversation bounds cover the entire tree without eviction', () => {
  let layout = base(); for (let i = 0; i < 3; i++) layout = splitPane(layout, 'pane-1', i % 2 ? 'y' : 'x', space);
  assert.equal(paneLeaves(layout.root).length, MAX_PANES); assert.equal(validPaneLayout(layout), true);
  assert.equal(splitPane(layout, 'pane-1', 'x', space), layout);
  let full = createPaneLayout(Array.from({length: MAX_TABS}, (_, i) => agent(String(i)))); full = splitPane(full, 'pane-1', 'x', space);
  assert.throws(() => openPaneTab(full, 'pane-2', agent('extra')), /tab limit/); assert.equal(keys(full.root).length, MAX_TABS);
  assert.equal(validPaneLayout(full), true); assert.equal(keys(openPaneTab(full, 'pane-1', agent('1')).root).length, MAX_TABS);
  assert.throws(() => createPaneLayout([agent('a'), agent('a')]), /invalid/);
});
test('actual width and height refuse undersized splits without hiding or mutating any pane', () => {
  const layout = base();
  for (const width of [0, 335, 643, Number.NaN, Infinity]) assert.equal(splitPane(layout, 'pane-1', 'x', {...space, width}), layout);
  assert.equal(canSplitPane(layout, 'pane-1', 'x', {width: 644, height: 240, divider: 4}), true);
  assert.equal(canSplitPane(layout, 'pane-1', 'y', {width: 320, height: 484, divider: 4}), true);
  assert.equal(canSplitPane(layout, 'pane-1', 'y', {width: 319, height: 484, divider: 4}), false);
  assert.equal(canSplitPane(layout, 'pane-1', 'y', {width: 320, height: 483, divider: 4}), false);
  assert.equal(canSplitPane(layout, 'pane-1', 'x', {...space, divider: -1}), false);
  assert.equal(splitPane(layout, 'gone', 'x', space), layout); assert.equal(splitPane(layout, 'pane-1', 'x', space, 'gone'), layout);
});
test('move preserves target objects, former destination tab and nearest source pruning', () => {
  const original = base(); const two = splitPane(original, 'pane-1', 'x', space, 'agent:b');
  const b = paneById(two, 'pane-2')?.tabs[0]; const moved = movePaneTab(two, 'agent:b', 'pane-1', 1);
  assert.equal(moved.root.kind, 'pane'); assert.equal(paneById(moved, 'pane-1')?.tabs[1], b); assert.equal(paneById(moved, 'pane-1')?.active, 'agent:b');
  assert.deepEqual(keys(moved.root), ['primary', 'agent:b', 'agent:a', 'agent:c']);
  assert.equal(movePaneTab(two, 'gone', 'pane-1'), two); assert.equal(movePaneTab(two, 'agent:b', 'gone'), two);
  assert.equal(movePaneTab(two, 'agent:b', 'pane-1', -1), two); assert.equal(movePaneTab(two, 'agent:b', 'pane-1', 1.5), two);
});
test('local reorder retains selected key and focus instead of selecting the dragged tab', () => {
  const original = base(); const moved = movePaneTab(original, 'agent:c', 'pane-1', 0);
  assert.deepEqual(keys(moved.root), ['agent:c', 'primary', 'agent:a', 'agent:b']); assert.equal(paneById(moved, 'pane-1')?.active, 'agent:a');
  assert.equal(moved.focusedPane, original.focusedPane); assert.equal(movePaneTab(original, 'agent:a', 'pane-1', 1), original);
});
test('close pane uses its nearest tree sibling, retains ordered tabs and moved focused selection', () => {
  let layout = splitPane(base(), 'pane-1', 'x', space, 'agent:c'); layout = splitPane(layout, 'pane-1', 'y', space, 'agent:b');
  const before = paneById(layout, 'pane-1')?.tabs; const closed = closePane(layout, 'pane-3');
  assert.equal(closed.focusedPane, 'pane-1'); assert.equal(paneById(closed, 'pane-1')?.active, 'agent:b');
  assert.deepEqual(paneById(closed, 'pane-1')?.tabs.slice(0, before?.length), before); assert.equal(paneForTab(closed, 'agent:c')?.id, 'pane-2');
  assert.equal(validPaneLayout(closed), true); const single = base(); assert.equal(closePane(single, 'pane-1'), single);
});
test('close tab chooses an adjacent key and closing last tab keeps one explicit empty pane', () => {
  const original = base(); const closed = closePaneTab(original, 'agent:a'); assert.equal(paneById(closed, 'pane-1')?.active, 'agent:b');
  let empty = original; for (const key of keys(original.root)) empty = closePaneTab(empty, key);
  assert.equal(validPaneLayout(empty), true); assert.equal(empty.root.kind === 'pane' && empty.root.active, null); assert.deepEqual(keys(empty.root), []);
  assert.equal(closePaneTab(original, 'gone'), original);
});
test('background pane activation preserves every other active key and idle focus is idempotent', () => {
  const split = splitPane(base(), 'pane-1', 'x', space, 'agent:b'); const next = activatePaneTab(split, 'pane-1', 'primary');
  assert.equal(next.focusedPane, 'pane-1'); assert.equal(paneById(next, 'pane-2')?.active, 'agent:b');
  assert.equal(focusPaneLayout(next, 'pane-1'), next); assert.equal(activatePaneTab(next, 'pane-2', 'primary'), next);
  assert.equal(focusPaneLayout(next, 'gone'), next);
});
test('normalization keeps an already-valid tree by reference and rejects flat/foreign/overbound shapes', () => {
  const original = base(); assert.equal(normalizePaneLayout(original), original);
  const wrong = [null, [], {}, {tabs: [], active: null, splitRatio: 50}, {...original, extra: true}, {...original, focusedPane: 'missing'},
    {root: {...original.root, active: 'missing'}, focusedPane: 'pane-1'}, {root: {...original.root, id: 'a'.repeat(65)}, focusedPane: 'a'.repeat(65)},
    {root: {kind: 'pane', id: 'pane-1', tabs: [{kind: 'agent', identity: 'a', split: false}], active: 'agent:a'}, focusedPane: 'pane-1'}];
  for (const value of wrong) {assert.equal(validPaneLayout(value), false); assert.throws(() => normalizePaneLayout(value as typeof original), /invalid/);}
  const two = splitPane(original, 'pane-1', 'x', space); assert.ok(two.root.kind === 'split');
  for (const ratio of [19, 81, 50.5, Number.NaN]) assert.equal(validPaneLayout({...two, root: {...two.root, ratio}}), false);
  assert.equal(validPaneLayout({...two, root: {...two.root, second: {...two.root.second, id: two.root.id}}}), false);
  assert.equal(validPaneLayout({...two, root: {...two.root, second: two.root.first}}), false);
  const cycle: Record<string, unknown> = {kind: 'split', id: 'cyclic', axis: 'x', ratio: 50}; cycle.first = cycle; cycle.second = original.root;
  assert.equal(validPaneLayout({root: cycle, focusedPane: 'pane-1'}), false);
});
test('nested geometry reserves four pixel dividers and enforces subtree minima plus ratio limits', () => {
  const two = splitPane(base(), 'pane-1', 'x', space); assert.deepEqual(minimumPaneSize(two.root), {width: 644, height: 240});
  const three = splitPane(two, 'pane-1', 'y', space); assert.deepEqual(minimumPaneSize(three.root), {width: 644, height: 484});
  assert.equal(paneSplitGeometry(two.root, {width: 643, height: 240, divider: 4}), undefined);
  assert.deepEqual(paneSplitGeometry(two.root, {width: 644, height: 240, divider: 4}), {extent: 640, min: 320, max: 320, first: 320});
  assert.equal(paneSplitGeometry(three.root, {width: 1000, height: 483, divider: 4}), undefined);
  assert.equal(paneSplitGeometry(three.root, {...space, width: Number.NaN}), undefined);
  for (const width of [644, 760, 1600, 2400]) for (const ratio of [20, 50, 80]) {
    assert.ok(two.root.kind === 'split'); const node = {...two.root, ratio}; const geometry = paneSplitGeometry(node, {...space, width}); assert.ok(geometry);
    assert.ok(geometry.first >= 320 && geometry.extent - geometry.first >= 320); assert.ok(geometry.first >= geometry.min && geometry.first <= geometry.max);
  }
});
test('stable split IDs route resize to only the addressed branch and never to a reused position', () => {
  const two = splitPane(base(), 'pane-1', 'x', space); const three = splitPane(two, 'pane-1', 'y', space);
  assert.ok(three.root.kind === 'split' && three.root.first.kind === 'split'); const id = three.root.first.id;
  const resized = resizePaneSplit(three, id, 99); assert.ok(resized.root.kind === 'split' && resized.root.first.kind === 'split');
  assert.equal(resized.root.ratio, 50); assert.equal(resized.root.first.ratio, 80); assert.equal(resized.root.second, three.root.second);
  assert.equal(resizePaneSplit(three, 'gone', 33), three); assert.equal(resizePaneSplit(three, id, Number.NaN), three);
});
