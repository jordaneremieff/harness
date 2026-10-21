import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrimaryView } from '../shared/api.ts';
import { primaryBusy, primaryActivityLabel, primaryEmpty } from './primary-presentation.ts';
const primary = (lifecycle: PrimaryView['lifecycle'], activity: PrimaryView['activity']): PrimaryView => ({key: 'p', epoch: 1, cwd: '/project', lifecycle, activity, pendingOperationIds: [], pendingDialogs: [], capabilities: {}});
test('ready empty primary omits start text and retains its loading state', () => {
  const ready = primary('ready', 'idle');
  assert.equal(primaryEmpty(ready, false, true), undefined);
  assert.equal(primaryEmpty(ready, true, true), undefined);
  assert.deepEqual(primaryEmpty(ready, false, false), {heading: 'Loading messages…', caption: ''});
  assert.equal(primaryEmpty(primary('ready', 'running'), false, true), undefined);
  assert.equal(primaryEmpty(primary('failed', 'idle'), false, true), undefined);
  assert.equal(primaryEmpty(undefined, false, false)?.heading, 'Sessions');
});
test('busy presentation requires a ready primary and recognized work or queue state', () => {
  for (const activity of ['running', 'retrying', 'compacting'] as const) assert.equal(primaryBusy(primary('ready', activity)), true);
  assert.equal(primaryBusy(primary('ready', 'unknown')), false);
  assert.equal(primaryBusy(primary('ready', 'idle'), 1), true);
  for (const lifecycle of ['stopped', 'failed', 'stopping', 'starting', 'switching'] as const) assert.equal(primaryBusy(primary(lifecycle, 'running'), 1), false);
});
test('no primary and unknown activity produce no placeholder facts', () => {
  assert.equal(primaryBusy(), false); assert.equal(primaryActivityLabel(), ''); assert.equal(primaryActivityLabel(primary('ready', 'unknown')), '');
  assert.equal(primaryActivityLabel(primary('stopped', 'unknown')), 'Browser control stopped');
});
