import assert from 'node:assert/strict';
import test from 'node:test';
import {ModelMemory, NEW_MODEL_DAYS, modelKey} from './model-memory.ts';

const memoryStore = () => { const data = new Map<string, string>(); return {getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => {data.set(key, value);}}; };

test('the first list this browser sees is known, and later additions are new for fourteen days', () => {
  const store = memoryStore(); let now = 1_000_000_000;
  const memory = new ModelMemory(store, () => now);
  memory.observe(['a/one', 'a/two']);
  assert.equal(memory.isNew('a/one'), false, 'the first list is recorded without marking anything new');
  now += 1000; memory.observe(['a/one', 'a/two', 'b/three']);
  assert.equal(memory.isNew('b/three'), true); assert.equal(memory.isNew('a/two'), false);
  now += (NEW_MODEL_DAYS - 1) * 86_400_000; assert.equal(new ModelMemory(store, () => now).isNew('b/three'), true, 'the memory persists');
  now += 2 * 86_400_000; assert.equal(new ModelMemory(store, () => now).isNew('b/three'), false);
});

test('pins persist, lead with the newest pin and survive unreadable storage', () => {
  const store = memoryStore(); const memory = new ModelMemory(store);
  assert.equal(memory.togglePin(modelKey('a', 'one')), true); assert.equal(memory.togglePin('a/two'), true);
  assert.equal(new ModelMemory(store).isPinned('a/one'), true);
  assert.equal(memory.togglePin('a/one'), false); assert.equal(new ModelMemory(store).isPinned('a/one'), false);
  const broken = new ModelMemory({getItem: () => '{not json', setItem: () => {throw new Error('full');}});
  assert.equal(broken.togglePin('a/one'), true); assert.equal(broken.isPinned('a/one'), true);
});
