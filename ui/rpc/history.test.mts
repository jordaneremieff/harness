import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrimarySession } from './session.mts';
import { FakeChild } from './fake-child.mts';

test('older history worker selects active branch strictly before marker without replacing live cache', async () => {
  const child = new FakeChild(); child.onCommand = (record) => child.defaults(record);
  const session = new PrimarySession({ key: 'primary', executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, publish: () => {} });
  await session.start();
  const entries = [
    { type: 'message', id: 'first', parentId: null, message: { role: 'user', timestamp: 1, content: 'first' } },
    { type: 'message', id: 'second', parentId: 'first', message: { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'second' }] } },
    { type: 'message', id: 'last', parentId: 'second', message: { role: 'user', timestamp: 3, content: 'last' } },
    { type: 'message', id: 'abandoned', parentId: 'first', message: { role: 'user', timestamp: 4, content: 'abandoned' } },
  ];
  child.onCommand = (record) => record.type === 'get_entries' ? child.response(record, { entries, leafId: 'last' }) : child.defaults(record);
  const window = await session.historyWindow('second'); assert.deepEqual(window.entries.map((e) => e.id), ['first']);
  assert.equal(session.entries.length, 0); assert.equal(window.coverage.complete, true);
  await assert.rejects(session.historyWindow('abandoned'), { code: 'history_limit' });
  assert.equal(session.client.synchronized, true); await session.close();
});
test('long history decode yields the main loop and retains a bounded projected window', async () => {
  const child = new FakeChild(); child.onCommand = (record) => child.defaults(record);
  const session = new PrimarySession({ key: 'primary', executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, publish: () => {} });
  await session.start();
  const entries = Array.from({ length: 1200 }, (_, i) => ({ type: 'message', id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null,
    message: { role: 'assistant', timestamp: i, content: [{ type: 'text', text: 'x'.repeat(10_000) }] } }));
  child.onCommand = (record) => record.type === 'get_entries' ? child.response(record, { entries, leafId: 'entry-1199' }) : child.defaults(record);
  let completed = false; const result = session.historyWindow('entry-1199').then((value) => { completed = true; return value; });
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(completed, false);
  const window = await result; assert.ok(Buffer.byteLength(JSON.stringify(window.entries)) <= 8 * 1024 * 1024);
  assert.equal(window.coverage.truncated, true); assert.equal(window.entries.at(-1)?.id, 'entry-1198');
  assert.equal(session.entries.length, 0); await session.close();
});
