import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHistoryCursor, History, pageEntries } from './history.mts';
import { projectEntry } from './projection.mts';
import type { DisplayCoverage, EntryView, Target } from '../shared/api.ts';


function requireValue<T>(value: T | null | undefined): T { assert.ok(value !== null && value !== undefined); return value; }
function firstText(entry: EntryView | undefined): {text: string} {
  const part = requireValue(requireValue(entry).messages?.[0]?.parts[0]);
  assert.ok(part.type === 'text' || part.type === 'thinking'); return part;
}

const target: Target = {kind: 'primary', key: 'p', epoch: 1};
const coverage: DisplayCoverage = {complete: true, truncated: false, omitted: 0};
const raw = (id: string, text = id) => ({id, kind: 'message', message: {role: 'user', content: text}});

test('history begins at the tail, keeps cursor anchors across append, and distinguishes incomplete source', () => {
  const history = new History(target); history.replace(Array.from({length: 120}, (_, index) => raw(String(index))), {complete: true});
  const first = history.page({limit: 50}); assert.equal(first.items[0]?.id, '70'); assert.equal(first.items.at(-1)?.id, '119');
  assert.ok(first.nextCursor); assert.equal(first.coverage.complete, false);
  history.upsert(raw('120')); const older = history.page({limit: 50, cursor: requireValue(first.nextCursor)});
  assert.equal(older.items[0]?.id, '20'); assert.equal(older.items.at(-1)?.id, '69');
  const oldest = history.page({cursor: requireValue(older.nextCursor), limit: 100}); assert.equal(oldest.items[0]?.id, '0'); assert.equal(oldest.nextCursor, null); assert.equal(oldest.coverage.complete, true);
  history.replace([], {complete: false}); const empty = history.page(); assert.deepEqual(empty.items, []); assert.equal(empty.coverage.complete, false);
});

test('history bounds memory, projects oversized entries, replaces IDs and refuses stale branch cursors', () => {
  const history = new History(target, {maxBytes: 65536});
  history.replace(Array.from({length: 20}, (_, index) => raw(String(index), 'x'.repeat(30_000))), {complete: true});
  assert.ok(history.coverage.omitted > 0); assert.equal(history.coverage.complete, false);
  const first = history.page({limit: 1}); assert.ok(Buffer.byteLength(JSON.stringify(first)) < 256 * 1024);
  history.upsert(raw('19', 'replacement')); assert.equal(firstText(history.page().items.at(-1)).text, 'replacement');
  if (first.nextCursor) { history.replace([raw('new')], {complete: true}); assert.throws(() => history.page({cursor: requireValue(first.nextCursor)}), /different branch/); }
  assert.throws(() => history.page({limit: 101}), /between/); assert.throws(() => history.page({cursor: '!bad'}), /Invalid history cursor/);
});

test('cached view paging preserves text and admits a large first entry without an empty cursor loop', () => {
  const entries = Array.from({length: 4}, (_, index) => projectEntry(raw(String(index))));
  const last = requireValue(entries[3]); requireValue(last.messages?.[0]).parts = [{type: 'text', text: 'x'.repeat(100_000)}];
  const first = pageEntries(entries, target, coverage, {limit: 50}); assert.equal(first.items.length, 1); assert.equal(first.items[0]?.id, '3');
  assert.ok(first.nextCursor); assert.ok(Buffer.byteLength(JSON.stringify(first)) < 256 * 1024);
  const older = pageEntries(entries, target, coverage, {cursor: requireValue(first.nextCursor)}); assert.deepEqual(older.items.map(entry => entry.id), ['0', '1', '2']);
  assert.equal(firstText(older.items[0]).text, '0');
  assert.equal(older.nextCursor, null);
  assert.throws(() => pageEntries(entries, {...target, epoch: 2}, coverage, {cursor: requireValue(first.nextCursor)}), /another target/);
  assert.throws(() => pageEntries(entries.slice(0, 2), target, coverage, {cursor: requireValue(first.nextCursor)}), /left the retained/);
});

test('cached pages retain explicit source and display omissions, validate cursors and do not copy unrelated rows', () => {
  const entries = [projectEntry(raw('a')), projectEntry(raw('b'))];
  const page = pageEntries(entries, target, {complete: false, truncated: true, omitted: 9, reason: 'source limit'}, {limit: 1});
  assert.equal(page.coverage.omitted, 9); assert.equal(page.coverage.reason, 'source limit');
  firstText(page.items[0]).text = 'mutated';
  assert.equal(firstText(entries[1]).text, 'b');
  assert.throws(() => pageEntries(entries, target, coverage, {cursor: 'x'.repeat(4097)}), /Invalid/);
  assert.throws(() => pageEntries(entries, target, coverage, {cursor: 'a'}), /Invalid/);
  assert.throws(() => pageEntries(entries, target, coverage, {limit: 0}), (error: unknown) => (error as {code: string}).code === 'invalid_request');
  assert.deepEqual(pageEntries([], target, coverage).items, []);
});

test('an evicted older boundary carries a target-bound cursor and requires explicit source history', () => {
  const entries = [projectEntry(raw('older-visible')), projectEntry(raw('latest-visible'))];
  const incomplete = {complete: false, truncated: true, omitted: 200, reason: 'projection-limit'};
  const page = pageEntries(entries, target, incomplete);
  assert.ok(page.nextCursor);
  const before = decodeHistoryCursor(page.nextCursor, target); assert.equal(before.before, 'older-visible');
  assert.throws(() => pageEntries(entries, target, incomplete, {cursor: page.nextCursor ?? undefined}), (error: unknown) => (error as {code: string}).code === 'history_limit');
  assert.throws(() => decodeHistoryCursor(page.nextCursor ?? '', {...target, epoch: 2}), /another target/);
});
