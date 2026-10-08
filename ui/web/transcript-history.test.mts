import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrimaryView } from '../shared/api.ts';
import { historyBecameReady } from './transcript-history.ts';

const ready: PrimaryView = {key: 'primary', cwd: '', epoch: 1, lifecycle: 'ready', activity: 'idle', pendingDialogs: [], pendingOperationIds: [], capabilities: {}};
test('selected startup readiness hydrates saved transcript without a refresh', () => {
  assert.equal(historyBecameReady(undefined, ready, 'primary'), true);
  assert.equal(historyBecameReady({...ready, lifecycle: 'starting'}, ready, 'primary'), true);
  assert.equal(historyBecameReady(ready, ready, 'primary'), false);
  assert.equal(historyBecameReady(ready, {...ready, epoch: 2}, 'primary'), true);
});
test('nonselected and nonready updates never reload primary history', () => {
  assert.equal(historyBecameReady(undefined, ready, 'other'), false);
  for (const lifecycle of ['starting', 'switching', 'stopping', 'stopped', 'failed'] as const) assert.equal(historyBecameReady(undefined, {...ready, lifecycle}, 'primary'), false);
});
