import assert from 'node:assert/strict';
import test from 'node:test';
import type {ThreadEventView, ThreadFrameView, ThreadListItem, ThreadOverview} from '../shared/api.ts';
import {emptyListText, eventTime, exchangeRows, filterThreads, frameChanges, mergeEvents, noteFitsInline, olderBoundary, overviewLines, prependEvents, purposeNeedsExpansion, threadCount, threadMeta} from './threads.ts';

const frame = (overrides: Partial<ThreadFrameView> = {}): ThreadFrameView => ({title: 'Plan', purpose: 'Ship it', authority: 'Operator', source: '', restrictions: 'None', acceptance: 'Works', integrator: 'root', ...overrides});
const item = (id: string, title: string, overrides: Partial<ThreadListItem> = {}): ThreadListItem => ({id, storageId: 'root', title, purpose: '', updatedAt: 1000, closed: false, members: 2, ...overrides});
const event = (sequence: number, kind: string, overrides: Partial<ThreadEventView> = {}): ThreadEventView =>
  ({sequence, at: 1000 * sequence, sender: `agent-${sequence}`, origin: 'model', kind, message: `text ${sequence}`, source: '', replyTo: null, revision: 1, notify: [], ...overrides});
const overview = (overrides: Partial<ThreadOverview> = {}): ThreadOverview => ({items: [item('a', 'One')], storages: [], rosterComplete: true, truncated: false, omitted: 0,
  hosts: {total: 2, answered: 2, unavailable: 0, failed: 0, notRunning: 0}, bounds: {perHost: 256, total: 200}, observedAt: '2026-10-19T00:00:00Z', ...overrides});
const names = (identity: string, origin: 'model' | 'operator') => origin === 'operator' ? 'Operator' : `name:${identity}`;

test('the list filter matches every word in title, purpose or identity', () => {
  const rows = [item('s/1', 'Release plan', {purpose: 'Ship the UI'}), item('s/2', 'Audit', {purpose: 'Check release notes'}), item('s/3', 'Other')];
  assert.deepEqual(filterThreads(rows, 'release').map(row => row.id), ['s/1', 's/2']);
  assert.deepEqual(filterThreads(rows, 'RELEASE ui').map(row => row.id), ['s/1']);
  assert.deepEqual(filterThreads(rows, '  ').map(row => row.id), ['s/1', 's/2', 's/3']);
  assert.deepEqual(filterThreads(rows, 's/3').map(row => row.id), ['s/3']);
});

test('the collapsed count marks a cut list', () => {
  assert.equal(threadCount(undefined), '');
  assert.equal(threadCount(overview({items: []})), '');
  assert.equal(threadCount(overview()), '1');
  assert.equal(threadCount(overview({truncated: true})), '1+');
});

test('quiet lines state coverage, cuts and agents that cannot list threads', () => {
  assert.deepEqual(overviewLines(overview()), []);
  assert.deepEqual(overviewLines(overview({hosts: {total: 2, answered: 1, unavailable: 1, failed: 0, notRunning: 0}})), ['Listed by 1 of 2 running agents', '1 agent does not offer threads']);
  assert.deepEqual(overviewLines(overview({hosts: {total: 1, answered: 0, unavailable: 0, failed: 1, notRunning: 0}})), ['Listed by 0 of 1 running agent', '1 agent did not answer']);
  assert.deepEqual(overviewLines(overview({hosts: {total: 4, answered: 1, unavailable: 2, failed: 1, notRunning: 3}, truncated: true, omitted: 9, rosterComplete: false})), [
    'Listed by 1 of 4 running agents · Showing the newest 1 threads; 9 more not shown · Agent list incomplete',
    '2 agents do not offer threads', '1 agent did not answer', 'Threads from 3 stopped agents are not listed.']);
  assert.deepEqual(overviewLines(overview({hosts: {total: 1, answered: 1, unavailable: 0, failed: 0, notRunning: 1}})), ['Threads from 1 stopped agent are not listed.']);
  assert.deepEqual(overviewLines(overview({truncated: true})), ['Some threads are not shown']);
  assert.deepEqual(overviewLines(overview({hosts: {total: 0, answered: 0, unavailable: 0, failed: 0, notRunning: 0}})), []);
});

test('an empty list says why it is empty', () => {
  assert.equal(emptyListText(overview()), '');
  assert.equal(emptyListText(overview({items: [], hosts: {total: 0, answered: 0, unavailable: 0, failed: 0, notRunning: 2}})), 'No agent is running, so no threads are listed.');
  assert.equal(emptyListText(overview({items: [], hosts: {total: 2, answered: 0, unavailable: 1, failed: 1, notRunning: 0}})), 'No running agent listed its threads.');
  assert.equal(emptyListText(overview({items: []})), 'No threads yet.');
});

test('contributions and carried authority are message blocks; every other kind is one quiet line', () => {
  const rows = exchangeRows([
    event(1, 'create', {frame: frame(), message: ''}), event(2, 'join', {message: 'Builder for the list'}), event(3, 'contribution', {message: 'A plan'}),
    event(4, 'carried-authority', {message: 'Operator said go', source: 'chat 12:04', replyTo: 3}), event(5, 'leave', {message: 'Left the thread.'}),
    event(6, 'close', {message: ''}), event(7, 'archive'), event(8, 'contribution', {origin: 'operator', sender: 'user'})], names);
  assert.deepEqual(rows.map(row => row.type), ['line', 'line', 'message', 'message', 'line', 'line', 'line', 'message']);
  assert.equal(rows[0].type === 'line' && rows[0].text, 'Thread created by name:agent-1');
  assert.deepEqual(rows[1].type === 'line' && [rows[1].text, rows[1].note], ['name:agent-2 joined', 'Builder for the list']);
  const carried = rows[3]; assert.ok(carried.type === 'message');
  assert.deepEqual([carried.carried, carried.source, carried.replyTo, carried.replyToName], [true, 'chat 12:04', 3, 'name:agent-3']);
  assert.deepEqual(rows[4].type === 'line' && [rows[4].text, rows[4].note], ['name:agent-5 left', undefined]);
  assert.equal(rows[5].type === 'line' && rows[5].text, 'Thread closed by name:agent-6');
  assert.equal(rows[6].type === 'line' && rows[6].text, 'name:agent-7 archive');
  assert.equal(rows[7].type === 'message' && rows[7].origin, 'operator');
});

test('a revision shows its changes only when an earlier frame is loaded', () => {
  const first = frame(), revised = frame({purpose: 'Ship it quietly', restrictions: 'Read only'});
  const loaded = exchangeRows([event(1, 'create', {frame: first, message: ''}), event(4, 'revise', {frame: revised, message: '', revision: 2})], names);
  const revision = loaded[1]; assert.ok(revision.type === 'line');
  assert.equal(revision.text, 'Frame revised to revision 2 by name:agent-4');
  assert.deepEqual(revision.changes?.map(change => [change.label, change.before, change.after]), [['Purpose', 'Ship it', 'Ship it quietly'], ['Restrictions', 'None', 'Read only']]);
  const lone = exchangeRows([event(4, 'revise', {frame: revised, message: '', revision: 2})], names)[0];
  assert.ok(lone.type === 'line'); assert.equal(lone.changes, undefined);
  const same = exchangeRows([event(1, 'create', {frame: first, message: ''}), event(2, 'revise', {frame: first, message: '', revision: 2})], names)[1];
  assert.ok(same.type === 'line'); assert.equal(same.changes, undefined);
  const chained = exchangeRows([event(1, 'create', {frame: first, message: ''}), event(2, 'revise', {frame: revised, message: '', revision: 2}), event(3, 'revise', {frame: frame({purpose: 'Third'}), message: '', revision: 3})], names)[2];
  assert.ok(chained.type === 'line'); assert.equal(chained.changes?.find(change => change.field === 'purpose')?.before, 'Ship it quietly');
  assert.deepEqual(frameChanges(first, first), []);
});

test('events are ordered by sequence whatever order the page held', () => {
  const rows = exchangeRows([event(3, 'contribution'), event(1, 'join'), event(2, 'contribution')], names);
  assert.deepEqual(rows.map(row => row.sequence), [1, 2, 3]);
});

test('a newer read joins loaded events by sequence and a gap replaces them', () => {
  const loaded = [event(5, 'contribution'), event(6, 'contribution')];
  assert.deepEqual(mergeEvents(loaded, [event(6, 'contribution', {message: 'new'}), event(7, 'contribution')]).map(row => [row.sequence, row.message]), [[5, 'text 5'], [6, 'new'], [7, 'text 7']]);
  assert.deepEqual(mergeEvents(loaded, [event(9, 'contribution'), event(10, 'contribution')]).map(row => row.sequence), [9, 10]);
  assert.deepEqual(mergeEvents([], [event(2, 'join'), event(1, 'join')]).map(row => row.sequence), [1, 2]);
  assert.deepEqual(mergeEvents(loaded, []).map(row => row.sequence), [5, 6]);
  assert.deepEqual(prependEvents([event(3, 'join'), event(4, 'join')], loaded).map(row => row.sequence), [3, 4, 5, 6]);
});

test('older events remain until sequence one is loaded', () => {
  assert.equal(olderBoundary([]), null);
  assert.equal(olderBoundary([event(4, 'join'), event(5, 'join')]), 4);
  assert.equal(olderBoundary([event(1, 'create')]), null);
});

test('event times, long notes and long purposes are classified by size', () => {
  const now = new Date(2026, 9, 19, 15, 0).getTime();
  assert.match(eventTime(new Date(2026, 9, 19, 9, 5).getTime(), now), /^9:05\s?AM$/);
  assert.match(eventTime(new Date(2026, 9, 18, 9, 5).getTime(), now), /^18 Oct, 9:05 AM$/);
  assert.equal(eventTime(Number.NaN, now), '');
  assert.equal(noteFitsInline('short'), true);
  assert.equal(noteFitsInline('two\nlines'), false);
  assert.equal(noteFitsInline('x'.repeat(200)), false);
  assert.equal(purposeNeedsExpansion('short'), false);
  assert.equal(purposeNeedsExpansion('a\nb\nc\nd'), true);
  assert.equal(purposeNeedsExpansion('x'.repeat(300)), true);
});

test('thread times share day-first dates and uppercase day periods across zone day boundaries', () => {
  const zone = 'Australia/Sydney', now = Date.parse('2026-10-20T13:05:00Z');
  assert.equal(eventTime(Date.parse('2026-10-06T18:56:00Z'), now, zone), '7 Oct, 5:56 AM');
  assert.equal(eventTime(Date.parse('2026-10-20T18:56:00Z'), now, zone), '5:56 AM');
  assert.equal(eventTime(Date.parse('2026-10-20T13:00:00Z'), now, zone), '12:00 AM');
  assert.equal(eventTime(Date.parse('2026-10-20T12:59:00Z'), now, zone), '20 Oct, 11:59 PM');
  assert.equal(eventTime(Date.parse('2026-10-20T12:59:00Z'), now, 'UTC'), '12:59 PM');
  assert.equal(eventTime(Date.parse('2025-10-20T13:00:00Z'), now, zone), '21 Oct, 12:00 AM');
  assert.equal(eventTime(Number.NaN, now, zone), '');
});

test('a list row states its members and an age that reads as an age', () => {
  const now = Date.parse('2026-10-19T12:00:00Z'), at = (ms: number) => now - ms;
  assert.equal(threadMeta(item('a', 'One', {members: 20, updatedAt: at(2 * 60_000)}), now), '20 members · 2m ago');
  assert.equal(threadMeta(item('a', 'One', {members: 1, updatedAt: at(16 * 3600_000)}), now), '1 member · 16h ago');
  assert.equal(threadMeta(item('a', 'One', {members: 6, closed: true, updatedAt: at(11 * 86400_000)}), now), 'Closed · 6 members · 11d ago');
  assert.equal(threadMeta(item('a', 'One', {members: 2, updatedAt: at(5000)}), now), '2 members · just now');
  assert.match(threadMeta(item('a', 'One', {members: 2, updatedAt: at(90 * 86400_000)}), now), /^2 members · \d+ [A-Z][a-z]{2,3}$/);
});
