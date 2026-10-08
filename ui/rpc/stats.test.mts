import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import type { PrimaryView } from '../shared/api.ts';
import { RpcClient, type RpcRecord } from './client.mts';
import { FakeChild } from './fake-child.mts';
import { PrimarySession } from './session.mts';
import { decodeStats, SessionStats } from './stats.mts';

const sample = { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0,
  contextUsage: { tokens: null, contextWindow: 1000, percent: null } };
function setup() {
  const child = new FakeChild(); const faults: unknown[] = [];
  child.onCommand = (record) => { if (record.type !== 'get_session_stats') child.defaults(record); };
  const client = new RpcClient({ executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, onProtocolError: (error) => faults.push(error) });
  const view: PrimaryView = { key: 'key', epoch: 1, cwd: process.cwd(), lifecycle: 'ready', activity: 'idle', pendingDialogs: [], pendingOperationIds: [], capabilities: { input: true } };
  const updates = new EventEmitter(); let changed = 0;
  const stats = new SessionStats(view, client, () => { changed++; updates.emit('changed'); });
  client.start(); return { child, client, view, stats, updates, faults, changes: () => changed };
}
async function nextRequest(child: FakeChild, trigger: () => void): Promise<RpcRecord> {
  const next = once(child, 'command'); trigger(); const [record] = await next; return record;
}
test('statistics decoder preserves unknown null context and accepts only finite nonnegative fields', () => {
  assert.deepEqual(decodeStats(sample), { usage: { tokens: sample.tokens, cost: 0 }, contextUsage: sample.contextUsage });
  for (const value of [-1, Infinity, NaN, '0', undefined]) assert.throws(() => decodeStats({ ...sample, cost: value }));
  assert.throws(() => decodeStats({ ...sample, tokens: { ...sample.tokens, total: -1 } }));
  assert.throws(() => decodeStats({ ...sample, contextUsage: { ...sample.contextUsage, percent: 'unknown' } }));
  assert.throws(() => decodeStats({ ...sample, excess: 'x'.repeat(17 * 1024) }));
  const withoutContext = { tokens: sample.tokens, cost: 0 }; assert.deepEqual(decodeStats(withoutContext), { usage: withoutContext });
});
test('statistics refresh coalesces requests, preserves nulls and publishes only actual changes', async () => {
  const { child, client, view, stats, updates, changes } = setup();
  stats.refresh(); const first = await child.command('get_session_stats');
  stats.refresh(); stats.refresh(); stats.refresh(); assert.equal(client.pendingCount, 1);
  const secondPromise = once(child, 'command'); child.response(first, sample); const [second] = await secondPromise;
  assert.equal(changes(), 0); assert.equal(client.pendingCount, 1); assert.equal(child.writes.length, 2);
  const changed = once(updates, 'changed'); child.response(second, sample); await changed;
  assert.deepEqual(view.contextUsage, { tokens: null, contextWindow: 1000, percent: null }); assert.equal(changes(), 1);
  const third = await nextRequest(child, () => stats.refresh()); child.response(third, sample);
  await client.request('get_state'); assert.equal(changes(), 1); await client.close();
});
test('rejected or malformed optional statistics never create protocol faults or block input', async () => {
  const { child, client, view, stats, faults, changes, updates } = setup();
  const valid = await nextRequest(child, () => stats.refresh()); const changed = once(updates, 'changed'); child.response(valid, sample); await changed;
  const first = await nextRequest(child, () => stats.refresh()); child.reject(first); await client.request('get_state');
  assert.equal(view.usage, undefined); assert.equal(view.contextUsage, undefined); assert.equal(view.capabilities.input, true);
  const second = await nextRequest(child, () => stats.refresh()); child.response(second, { ...sample, cost: -1 }); await client.request('get_state');
  assert.deepEqual(faults, []); assert.equal(client.synchronized, true); assert.equal(changes(), 2); await client.close();
});
test('statistics response from a replaced epoch cannot replace the new session values', async () => {
  const { child, client, view, stats, updates } = setup();
  const old = await nextRequest(child, () => stats.refresh()); view.epoch = 2; stats.clear(); stats.refresh();
  const next = once(child, 'command'); child.response(old, { ...sample, cost: 100 }); const [fresh] = await next;
  assert.equal(view.usage, undefined);
  const changed = once(updates, 'changed'); child.response(fresh, sample); await changed; assert.equal((view as PrimaryView).usage?.cost, 0); await client.close();
});
test('primary readiness ignores pending statistics and lifecycle events request fresh statistics', async () => {
  const child = new FakeChild(); const states = new EventEmitter();
  child.onCommand = (record) => { if (record.type !== 'get_session_stats') child.defaults(record); };
  const session = new PrimarySession({ key: 'key', executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn,
    publish: (name, _target, data) => { if (name === 'primary.state' && (data as PrimaryView).usage) states.emit('stats'); } });
  await session.start(); assert.equal(session.view.lifecycle, 'ready'); assert.equal(session.view.capabilities.input, true);
  const first = await child.command('get_session_stats'); const changed = once(states, 'stats'); child.response(first, sample); await changed;
  const afterSettled = await nextRequest(child, () => child.event({ type: 'agent_settled' }));
  const afterCompaction = once(child, 'command'); child.event({ type: 'compaction_end', aborted: false }); child.response(afterSettled, sample);
  const [fresh] = await afterCompaction; child.response(fresh, sample); await session.refreshState();
  assert.equal(child.writes.filter((record) => record.type === 'get_session_stats').length, 3); await session.close();
});
