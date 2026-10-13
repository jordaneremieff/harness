import assert from 'node:assert/strict';
import test from 'node:test';
import {placeRetained} from './dom.ts';
function fixture(editing = true, connected = true) {
  let moves = 0, inserts = 0;
  const node = {tagName: 'SECTION', isConnected: connected, parentElement: null, nextSibling: null, querySelector: () => editing ? {} : null} as unknown as HTMLElement;
  const parent = {isConnected: true, insertBefore: () => {inserts++;}, moveBefore: function (this: HTMLElement, moved: HTMLElement, before: Node | null) {assert.equal(this, parent); assert.equal(moved, node); assert.equal(before, null); moves++;}} as unknown as HTMLElement & {moveBefore?: (node: Node, before: Node | null) => void};
  return {node, parent, counts: () => ({moves, inserts})};
}
test('connected editors refuse physical movement even with the native move API', () => {
  const f = fixture(); assert.throws(() => placeRetained(f.node, f.parent), /cannot preserve editing/); assert.deepEqual(f.counts(), {moves: 0, inserts: 0});
});
test('unsupported browser moves refuse connected editor trees before changing their parent', () => {
  const f = fixture(); delete f.parent.moveBefore; assert.throws(() => placeRetained(f.node, f.parent), /cannot preserve editing/); assert.equal(f.counts().inserts, 0);
});
test('initial mounts and nonediting nodes use ordinary insertion when necessary', () => {
  const detached = fixture(true, false); placeRetained(detached.node, detached.parent); assert.deepEqual(detached.counts(), {moves: 0, inserts: 1});
  const plain = fixture(false); delete plain.parent.moveBefore; placeRetained(plain.node, plain.parent); assert.equal(plain.counts().inserts, 1);
});
