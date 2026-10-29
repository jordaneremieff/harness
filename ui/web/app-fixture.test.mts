import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { inspect } from 'node:util';
import { HostNode } from './app-fixture.mts';

const assertionInspection = {depth: 1000, customInspect: false, getters: true, maxArrayLength: Infinity};

test('HostNode graph links stay outside assertion inspection', (context) => {
  const root = new HostNode('main');
  const leaves: HostNode[] = [];
  for (let group = 0; group < 20; group++) {
    const section = new HostNode('section');
    root.append(section);
    for (let index = 0; index < 100; index++) {
      const leaf = new HostNode('textarea');
      leaf.id = `editor-${group}-${index}`;
      section.append(leaf);
      leaves.push(leaf);
    }
  }
  assert.equal(leaves.length + root.children.length + 1, 2021);
  const inspected = inspect(root, assertionInspection);
  assert.ok(inspected.length < 2_000, 'Assertion inspection must stay below 2,000 characters.');
  assert.ok(!inspected.includes('children'), 'Inspection must not follow child links.');
  assert.ok(!inspected.includes('parentNode'), 'Inspection must not follow parent links.');
  const actual = leaves[0], expected = leaves[1];
  assert.ok(actual); assert.ok(expected);
  assert.ok(inspect(actual, assertionInspection).length < 2_000, 'Leaf inspection must not follow ancestors.');
  const started = performance.now();
  let messageLength = 0;
  assert.throws(() => assert.equal(actual, expected), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    messageLength = error.message.length;
    assert.ok(messageLength < 5_000, 'The assertion message must stay below 5,000 characters.');
    assert.ok(!error.message.includes('parentNode'), 'The assertion must not dump the node graph.');
    return true;
  });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1_000, 'The assertion diff must finish within one second.');
  context.diagnostic(`nodes=2021 inspection=${inspected.length} message=${messageLength} elapsedMs=${elapsed.toFixed(1)}`);

  assert.equal(actual.parentNode, root.children[0]);
  actual.remove();
  assert.equal(actual.parentNode, null);
  root.append(actual);
  assert.equal(actual.parentNode, root);
  assert.equal(root.lastElementChild, actual);
  const detached = new HostNode('div');
  detached.children = [actual];
  actual.parentNode = detached;
  assert.equal(detached.children[0], actual);
  assert.equal(actual.parentNode, detached);
});
