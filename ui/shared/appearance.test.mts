import assert from 'node:assert/strict';
import test from 'node:test';
import { APPEARANCES, resolveAppearance } from './api.ts';

test('the appearance choices are dark, light and system', () => {
  assert.deepEqual([...APPEARANCES], ['dark', 'light', 'system']);
});
test('current values read as themselves', () => {
  for (const value of APPEARANCES) assert.equal(resolveAppearance(value), value);
});
test('retired stored values read as the mode they looked like', () => {
  assert.equal(resolveAppearance('latte'), 'light');
  for (const value of ['frappe', 'macchiato', 'mocha']) assert.equal(resolveAppearance(value), 'dark');
});
test('unknown, missing and inherited-key values follow the OS', () => {
  for (const value of ['unknown', '', 'Dark', 'constructor', '__proto__', 'toString', undefined, null, 1, {}]) assert.equal(resolveAppearance(value), 'system');
});
