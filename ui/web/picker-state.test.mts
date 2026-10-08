import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrimaryView, SavedSession, SavedSessionPage } from '../shared/api.ts';
import { filterSessions, mergeSessions, mergeSessionTitles, savedPathValid, sessionCoverage, sessionOwner, sessionSize } from './picker-state.ts';
const item = (id: string, title = id): SavedSession => ({id, title, revision: id, path: `/sessions/${id}.jsonl`, project: '/project', modifiedAt: '2026-01-01T00:00:00Z', size: 1024});
const page = (items: SavedSession[]): SavedSessionPage => ({items, total: 1259, omitted: 0, nextCursor: 'next', titleCursor: null, observedAt: '2026-01-01T00:00:00Z'});
test('local search matches title, exact identity and saved path, not unloaded sessions', () => {
  const items = [item('id-one', 'Named session'), item('id-two', 'First user message')];
  assert.deepEqual(filterSessions(items, ' NAMEd '), [items[0]]);
  assert.deepEqual(filterSessions(items, 'id-two'), [items[1]]);
  assert.deepEqual(filterSessions(items, '/sessions/id-one'), [items[0]]);
  assert.deepEqual(filterSessions(items, 'unloaded'), []);
  assert.deepEqual(filterSessions(items, ''), items);
});
test('More merges cached pages without duplicate sessions and refresh replaces the list', () => {
  const first = mergeSessions(undefined, page([item('one'), item('two')]));
  const next = mergeSessions(first, page([item('two', 'new title'), item('three')]), true);
  assert.deepEqual(next.items.map(item => item.id), ['one', 'two', 'three']);
  assert.equal(next.items[1]?.title, 'new title');
  assert.deepEqual(mergeSessions(next, page([item('new')])).items.map(item => item.id), ['new']);
});
test('async title completion updates exact file versions without dropping loaded pages', () => {
  const one = {...item('one'), title: 'Loading title…', titleState: 'pending' as const};
  const two = {...item('two'), title: 'Loading title…', titleState: 'pending' as const};
  const list = mergeSessions(undefined, page([one, two]));
  const updated = mergeSessionTitles(list, page([{...one, title: 'First prompt', titleState: 'ready'}, {...two, size: 2048, title: 'Wrong version', titleState: 'ready'}]));
  assert.equal(updated.items.length, 2); assert.equal(updated.items[0]?.title, 'First prompt');
  assert.equal(updated.items[1]?.titleState, 'pending');
  assert.equal(mergeSessionTitles(list, page([{...one, revision: 'replacement', title: 'Wrong inode', titleState: 'ready'}])).items[0]?.titleState, 'pending'); assert.equal(updated.nextCursor, list.nextCursor);
  assert.equal(updated.observedAt, list.observedAt);
  assert.equal(list.items[0]?.titleState, 'pending');
});
test('late failed completions do not downgrade a ready title at the same file revision', () => {
  const ready = {...item('one'), title: 'Ready title', titleState: 'ready' as const};
  const list = mergeSessions(undefined, page([ready]));
  assert.equal(mergeSessionTitles(list, page([{...ready, title: '(title unavailable)', titleState: 'unavailable'}])).items[0]?.title, 'Ready title');
  assert.equal(mergeSessionTitles(list, page([{...ready, title: '(title pending)', titleState: 'pending'}])).items[0]?.titleState, 'ready');
});
test('every cached page retains its pending title completion across More and return', () => {
  const first = {...page([{...item('one'), titleState: 'pending' as const}]), titleCursor: 'one'};
  const second = {...page([{...item('two'), titleState: 'pending' as const}]), titleCursor: 'two'};
  const list = mergeSessions(mergeSessions(undefined, first), second, true);
  assert.deepEqual(list.pendingTitles.map(page => page.titleCursor), ['one', 'two']);
  const filled = mergeSessionTitles(list, page([{...item('one'), titleState: 'ready'}]));
  assert.deepEqual(filled.pendingTitles.map(page => page.titleCursor), ['two']);
  assert.deepEqual(mergeSessions(list, page([item('new')])).pendingTitles, []);
});
test('coverage separates loaded-list matches from total store coverage', () => {
  const list = mergeSessions(undefined, page(Array.from({length: 20}, (_, index) => item(String(index)))));
  assert.equal(sessionCoverage(list, 20, ''), '20 of 1259 shown');
  assert.equal(sessionCoverage(list, 2, 'id'), '2 matches in loaded sessions · 20 of 1259 shown');
  assert.match(sessionCoverage({...list, omitted: 3}, 20, ''), /3 unavailable or outside the scan bound/);
});
test('manual Resume requires an absolute nonempty path', () => {
  for (const path of ['', 'relative.jsonl', '   ', '/bad\0path', `/${'x'.repeat(4096)}`]) assert.equal(savedPathValid(path), false);
  assert.equal(savedPathValid('/saved session.jsonl'), true);
});
test('session ownership comes from the current exact file and epoch, not a captured row owner', () => {
  const primary = {key: 'primary', epoch: 1, sessionFile: '/a.jsonl', lifecycle: 'ready'} as PrimaryView;
  assert.equal(sessionOwner([primary], '/a.jsonl')?.epoch, 1);
  const switched = {...primary, epoch: 2, sessionFile: '/b.jsonl'};
  assert.equal(sessionOwner([switched], '/a.jsonl'), undefined);
  assert.equal(sessionOwner([switched], '/b.jsonl')?.epoch, 2);
  assert.equal(sessionOwner([{...primary, lifecycle: 'stopped'}], '/a.jsonl'), undefined);
  assert.equal(sessionOwner([{...primary, lifecycle: 'failed'}], '/a.jsonl'), undefined);
});
test('file sizes use consistent binary units', () => {
  assert.equal(sessionSize(512), '512 B'); assert.equal(sessionSize(1024), '1.0 KiB');
  assert.equal(sessionSize(27 * 1024 * 1024), '27.0 MiB');
});
