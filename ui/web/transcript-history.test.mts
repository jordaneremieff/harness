import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrimaryView, ReadingView } from '../shared/api.ts';
import { historyBecameReady, pageToReadingAnchor } from './transcript-history.ts';
import type { AnchorHistory } from './transcript-history.ts';

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

const reading: ReadingView = {revision: 3, anchorId: 'saved', offsetPx: 1652, followTail: false};
function paging(pages: string[][]) {
  const entries = new Set(pages[0]); const calls: string[] = []; let page = 0; let current = true;
  const history: AnchorHistory = {
    hasEntry: id => entries.has(id), nextCursor: () => page + 1 < pages.length ? String(page + 1) : null,
    loadEarlier: async cursor => {calls.push(cursor); for (const id of pages[++page]) entries.add(id);}, current: () => current,
  };
  return {history, calls, cancel: () => {current = false;}};
}
test('saved earlier-page anchor pages sequentially and stops at its entry', async () => {
  const {history, calls} = paging([['tail'], ['middle'], ['saved'], ['start']]);
  assert.equal(await pageToReadingAnchor(reading, history), 'found');
  assert.deepEqual(calls, ['1', '2']); assert.equal(reading.offsetPx, 1652);
});
test('first-page anchors and tail sessions need no earlier history', async () => {
  const {history, calls} = paging([['saved'], ['start']]);
  assert.equal(await pageToReadingAnchor(reading, history), 'found');
  assert.equal(await pageToReadingAnchor({...reading, followTail: true}, history), 'tail');
  assert.equal(await pageToReadingAnchor(undefined, history), 'tail');
  assert.deepEqual(calls, []);
});
test('absent anchor reaches history start and returns an explicit fallback result', async () => {
  const {history, calls} = paging([['tail'], ['middle'], ['start']]);
  assert.equal(await pageToReadingAnchor(reading, history), 'exhausted');
  assert.deepEqual(calls, ['1', '2']);
  assert.equal(await pageToReadingAnchor({...reading, anchorId: null}, history), 'start');
});
test('user intent before paging prevents the first request', async () => {
  const {history, calls, cancel} = paging([['tail'], ['saved']]); cancel();
  assert.equal(await pageToReadingAnchor(reading, history), 'interrupted'); assert.deepEqual(calls, []);
});
test('user scroll during an earlier request stops paging and never resumes restoration', async () => {
  const {history, cancel} = paging([['tail'], ['middle'], ['saved']]);
  const pending = Promise.withResolvers<void>(); const calls: string[] = [];
  history.loadEarlier = cursor => {calls.push(cursor); return pending.promise;};
  const result = pageToReadingAnchor(reading, history); assert.deepEqual(calls, ['1']);
  cancel(); pending.resolve(); assert.equal(await result, 'interrupted'); assert.deepEqual(calls, ['1']);
});
test('nonprogressing cursor and request failures cannot loop through the session', async () => {
  const {history, calls} = paging([['tail'], ['saved']]);
  history.loadEarlier = async cursor => {calls.push(cursor);};
  assert.equal(await pageToReadingAnchor(reading, history), 'unavailable'); assert.deepEqual(calls, ['1']);
  history.loadEarlier = async () => {throw new Error('History unavailable');};
  await assert.rejects(pageToReadingAnchor(reading, history), /History unavailable/);
});
