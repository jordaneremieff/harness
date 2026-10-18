import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentError, type ThreadList } from '../agents/index.mts';
import type { AgentAdapter } from './registry.mts';
import { THREAD_BOUNDS, collectThreads } from './threads-overview.mts';

const storage = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const threadId = (n: number, k = 1) => `${storage(n)}/${k.toString(16).padStart(32, '0')}`;
const item = (n: number, k: number, updatedAt: number, closed = false) => ({id: threadId(n, k), title: `T${n}-${k}`, purpose: 'p', updatedAt, closed, members: 1});
const answer = (items: ReturnType<typeof item>[], nextCursor: string | null = null): ThreadList =>
  ({items, nextCursor, coverage: {complete: nextCursor === null, visited: items.length, omitted: 0}});
type Row = {storageId: string; claim: string};
function agentsFor(rows: Row[], threads: AgentAdapter['threads'], pages?: (cursor?: string) => unknown) {
  return {roster: (options: {cursor?: string; limit?: number} = {}) => pages ? pages(options.cursor) : ({rows, nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false, scan: {}}), threads} as unknown as Pick<AgentAdapter, 'roster' | 'threads'>;
}

test('only storages with a live claim are queried, and the others are counted', async () => {
  const asked: string[] = [];
  const agents = agentsFor([{storageId: storage(1), claim: 'live'}, {storageId: storage(1), claim: 'live'}, {storageId: storage(2), claim: 'dead'}, {storageId: storage(3), claim: 'unknown'}, {storageId: storage(4), claim: 'live'}],
    async identity => {asked.push(identity); return answer([item(Number(identity.slice(-1)), 1, 5)]);});
  const overview = await collectThreads(agents);
  assert.deepEqual(asked.sort(), [storage(1), storage(4)]);
  assert.deepEqual(overview.hosts, {total: 2, answered: 2, unavailable: 0, failed: 0, notRunning: 2});
  assert.equal(overview.rosterComplete, true);
  assert.equal(overview.items.length, 2);
  assert.equal(overview.items[0].storageId === storage(1) || overview.items[0].storageId === storage(4), true);
});

test('open threads sort first, then the newest update, with a stable tie order', async () => {
  const agents = agentsFor([{storageId: storage(1), claim: 'live'}, {storageId: storage(2), claim: 'live'}], async identity => identity === storage(1)
    ? answer([item(1, 1, 10, true), item(1, 2, 30), item(1, 3, 20)]) : answer([item(2, 1, 90, true), item(2, 2, 30), item(2, 3, 5)]));
  const overview = await collectThreads(agents);
  assert.deepEqual(overview.items.map(entry => entry.title), ['T1-2', 'T2-2', 'T1-3', 'T2-3', 'T2-1', 'T1-1']);
  assert.equal(overview.truncated, false);
  assert.equal(overview.omitted, 0);
  assert.deepEqual(overview.bounds, {perHost: THREAD_BOUNDS.perHost, total: THREAD_BOUNDS.total});
});

test('a host is paged by its continuation and a repeated thread appears once', async () => {
  const calls: unknown[] = [];
  const agents = agentsFor([{storageId: storage(1), claim: 'live'}], async (_identity, options) => {
    calls.push(options);
    return options?.cursor === undefined ? answer([item(1, 1, 1), item(1, 2, 2)], '2') : answer([item(1, 2, 2), item(1, 3, 3)]);
  });
  const overview = await collectThreads(agents);
  assert.deepEqual(calls, [{limit: THREAD_BOUNDS.pageLimit}, {limit: THREAD_BOUNDS.pageLimit, cursor: '2'}]);
  assert.deepEqual(overview.items.map(entry => entry.title), ['T1-3', 'T1-2', 'T1-1']);
  assert.equal(overview.storages[0].threads, 4);
});

test('absent operations, failures and timeouts stay distinct per host', async () => {
  const rows = [1, 2, 3, 4, 5].map(n => ({storageId: storage(n), claim: 'live'}));
  const agents = agentsFor(rows, async (identity, _options, signal) => {
    switch (identity) {
      case storage(1): return answer([item(1, 1, 1)]);
      case storage(2): throw new AgentError('threads_unavailable', 'Host operation collaboration-list is unavailable.');
      case storage(3): throw new AgentError('host_unavailable', 'Host connection is unavailable.');
      case storage(4): throw new Error('Thread index refers to an unavailable thread \u001b[31mx');
      default: return new Promise<ThreadList>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new AgentError('cancelled', 'cancelled')), {once: true}));
    }
  });
  const overview = await collectThreads(agents, {hostTimeoutMs: 20});
  assert.deepEqual(overview.hosts, {total: 5, answered: 1, unavailable: 1, failed: 3, notRunning: 0});
  const by = Object.fromEntries(overview.storages.map(state => [state.storageId, state]));
  assert.equal(by[storage(2)].state, 'unavailable');
  assert.equal(by[storage(2)].code, 'threads_unavailable');
  assert.equal(by[storage(3)].code, 'host_unavailable');
  assert.equal(by[storage(4)].code, 'host_error');
  assert.equal(by[storage(4)].message?.includes('\u001b'), false);
  assert.equal(by[storage(5)].code, 'timeout');
  assert.equal(overview.items.length, 1);
});

test('at most four hosts are queried at a time', async () => {
  let active = 0, peak = 0;
  const rows = Array.from({length: 11}, (_, n) => ({storageId: storage(n + 1), claim: 'live'}));
  const overview = await collectThreads(agentsFor(rows, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return answer([]);
  }));
  assert.equal(peak, THREAD_BOUNDS.concurrency);
  assert.equal(overview.hosts.answered, 11);
});

test('a host that lists another storage thread is a protocol failure', async () => {
  const overview = await collectThreads(agentsFor([{storageId: storage(1), claim: 'live'}], async () => answer([item(2, 1, 1)])));
  assert.equal(overview.storages[0].state, 'failed');
  assert.equal(overview.storages[0].code, 'protocol_error');
  assert.deepEqual(overview.items, []);
});

test('the per-host call bound and the total bound report truncation', async () => {
  let calls = 0;
  const endless = agentsFor([{storageId: storage(1), claim: 'live'}], async () => {
    calls++; return answer([], String(calls));
  });
  const cut = await collectThreads(endless);
  assert.equal(calls, THREAD_BOUNDS.hostCalls);
  assert.equal(cut.storages[0].truncated, true);
  assert.equal(cut.truncated, true);
  const many = agentsFor([storage(1), storage(2)].map(storageId => ({storageId, claim: 'live'})), async identity => {
    const n = Number(identity.slice(-1));
    return answer(Array.from({length: 20}, (_, k) => item(n, k + 1, 1000 - k)), null);
  });
  const small = await collectThreads(many);
  assert.equal(small.items.length, 40);
  assert.equal(small.omitted, 0);
});

test('the total bound cuts the tail of the sorted list and counts it', async () => {
  const pages = Array.from({length: 12}, (_, k) => k);
  const agents = agentsFor([{storageId: storage(1), claim: 'live'}, {storageId: storage(2), claim: 'live'}], async (identity, options) => {
    const n = Number(identity.slice(-1)), page = options?.cursor === undefined ? 0 : Number(options.cursor);
    return answer(Array.from({length: 20}, (_, k) => item(n, page * 20 + k + 1, page * 20 + k)), page + 1 < pages.length ? String(page + 1) : null);
  });
  const overview = await collectThreads(agents);
  assert.equal(overview.items.length, THREAD_BOUNDS.total);
  assert.equal(overview.omitted, 480 - THREAD_BOUNDS.total);
  assert.equal(overview.truncated, true);
  assert.equal(overview.items[0].updatedAt, 239);
  assert.ok(Buffer.byteLength(JSON.stringify(overview)) < 256 * 1024);
});

test('roster paging, an expired cursor and an incomplete roster are reported', async () => {
  const pagesSeen: (string | undefined)[] = [];
  const agents = agentsFor([], async () => answer([]), cursor => {
    pagesSeen.push(cursor);
    return cursor === undefined
      ? {rows: [{storageId: storage(1), claim: 'live'}], nextCursor: 'next', coverage: {complete: false, omitted: 2}}
      : {rows: [{storageId: storage(2), claim: 'live'}], nextCursor: null, coverage: {complete: true, omitted: 0}};
  });
  const overview = await collectThreads(agents);
  assert.deepEqual(pagesSeen, [undefined, 'next']);
  assert.equal(overview.hosts.total, 2);
  assert.equal(overview.rosterComplete, false);
  let attempts = 0;
  const stale = await collectThreads(agentsFor([], async () => answer([]), () => {
    if (++attempts === 1) throw new AgentError('stale_revision', 'Roster cursor expired.');
    return {rows: [{storageId: storage(1), claim: 'live'}], nextCursor: null, coverage: {complete: true, omitted: 0}};
  }));
  assert.equal(stale.hosts.total, 1);
  assert.equal(stale.rosterComplete, true);
  const broken = await collectThreads(agentsFor([], async () => answer([]), () => { throw new AgentError('stale_revision', 'Roster cursor expired.'); }));
  assert.equal(broken.hosts.total, 0);
  assert.equal(broken.rosterComplete, false);
});

test('cancelling the request stops the fan-out', async () => {
  const controller = new AbortController();
  const agents = agentsFor([{storageId: storage(1), claim: 'live'}], (_identity, _options, signal) => new Promise<ThreadList>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new AgentError('cancelled', 'cancelled')), {once: true});
    queueMicrotask(() => controller.abort());
  }));
  await assert.rejects(collectThreads(agents, {signal: controller.signal}), {code: 'cancelled'});
});
