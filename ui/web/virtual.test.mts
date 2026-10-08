import assert from 'node:assert/strict';
import test from 'node:test';
import { captureAnchor, followsTail, layoutItems, measureItems, restoreAnchor, visibleWindow, updateHeights } from './virtual.ts';

test('variable measured heights stay keyed through reorder', () => {
  const heights = new Map([['a', 30], ['b', 100]]);
  const layout = layoutItems(['b', 'a', 'c'], heights, 40);
  assert.deepEqual(layout.items.map(item => [item.id, item.top, item.height]), [['b', 0, 100], ['a', 100, 30], ['c', 130, 40]]);
  assert.equal(layout.totalHeight, 170);
  assert.throws(() => layoutItems(['a', 'a'], heights), /Duplicate/);
  assert.throws(() => layoutItems([], heights, 0), /positive/);
  assert.equal(layoutItems(['x'], new Map([['x', Number.NaN]]), 50).totalHeight, 50);
});
test('prepend and changes above the anchor preserve its pixel offset', () => {
  const before = layoutItems(['a', 'b', 'c'], new Map(), 100);
  const anchor = captureAnchor(before, 130);
  assert.deepEqual(anchor, {id: 'b', offsetPx: 30});
  const after = layoutItems(['older', 'a', 'b', 'c'], new Map([['a', 150]]), 100);
  assert.equal(restoreAnchor(after, anchor, 100), 280);
  assert.equal(captureAnchor(before, 100)?.id, 'b');
  assert.equal(restoreAnchor(before, {id: 'missing', offsetPx: 9}, 100, 42), 42);
  assert.equal(captureAnchor(layoutItems([], new Map()), 30), null);
});
test('height shrink clamps the offset and the scroll boundary', () => {
  const layout = layoutItems(['a', 'b', 'c'], new Map([['b', 20]]), 100);
  assert.equal(restoreAnchor(layout, {id: 'b', offsetPx: 80}, 50), 119);
  assert.equal(restoreAnchor(layout, {id: 'c', offsetPx: 99}, 100), 120);
});
test('distant focus pins use separate spans without an enormous mounted range', () => {
  const ids = Array.from({length: 100}, (_, index) => String(index));
  const layout = layoutItems(ids, new Map(), 20);
  const window = visibleWindow(layout, 1000, 100, {overscanPx: 0, pins: new Set(['0', '99'])});
  assert.deepEqual(window.items.map(item => item.id), ['0', '50', '51', '52', '53', '54', '99']);
  assert.deepEqual(window.spans.map(span => [span.start, span.end]), [[0, 1], [50, 55], [99, 100]]);
  assert.equal(window.top, 0); assert.equal(window.bottom, 0);
  assert.deepEqual(visibleWindow(layoutItems([], new Map()), 0, 100).items, []);
});
test('unmeasured windows use overscan and reject stale measurements', () => {
  const layout = layoutItems(['a', 'b', 'c', 'd'], new Map(), 100);
  assert.deepEqual(visibleWindow(layout, 150, 100, {overscanPx: 50}).items.map(item => item.id), ['b', 'c']);
  assert.deepEqual([...measureItems(new Map([['gone', 20], ['a', 30]]), new Map([['a', 80], ['b', -1]]), ['a', 'b'])], [['a', 80]]);
});
test('height deltas reuse keyed layout objects and update only the affected suffix', () => {
  const layout = layoutItems(['a', 'b', 'c'], new Map(), 100);
  const first = layout.items[0]; const last = layout.items[2];
  updateHeights(layout, new Map([['c', 150], ['missing', 90]]));
  assert.equal(layout.items[0], first); assert.equal(layout.items[2], last);
  assert.equal(layout.totalHeight, 350); assert.equal(last?.top, 200);
  updateHeights(layout, new Map([['a', 20], ['b', Number.NaN]]));
  assert.deepEqual(layout.items.map(item => [item.top, item.bottom]), [[0, 20], [20, 120], [120, 270]]);
  assert.equal(restoreAnchor(layout, {id: 'c', offsetPx: 10}, 0), 130);
});
test('tail follow respects explicit scroll and selection', () => {
  assert.equal(followsTail(852, 100, 1000), true);
  assert.equal(followsTail(851, 100, 1000), false);
  assert.equal(followsTail(900, 100, 1000, {selection: true}), false);
  assert.equal(followsTail(900, 100, 1000, {explicitlyAway: true}), false);
});
