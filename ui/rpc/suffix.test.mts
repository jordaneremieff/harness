import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RpcClient } from './client.mts';
import { FakeChild } from './fake-child.mts';

const entry = (id: string, parentId: string | null, text = 'text') => ({type: 'message', id, parentId, message: {role: 'user', timestamp: 1, content: text}});
function create() {
  const child = new FakeChild();
  const client = new RpcClient({executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn});
  client.start(); return {child, client};
}
test('a large retained-entry suffix returns a bounded authoritative leaf without claiming branch coverage', async t => {
  const {child, client} = create(); t.after(() => client.close());
  child.onCommand = record => record.type === 'get_entries' ? child.response(record, {entries: [entry('last', 'earlier', 'x'.repeat(300_000))], leafId: 'last'}) : child.defaults(record);
  const result = await client.request('get_entries', {since: 'earlier'}) as {entries: unknown[]; leafId: string; historyChanged: boolean};
  assert.deepEqual(result.entries, []); assert.equal(result.leafId, 'last'); assert.equal(result.historyChanged, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024); assert.equal(client.synchronized, true);
});
test('a suffix after a fork confirms the RPC leaf instead of inferring it from the newest record', async t => {
  const {child, client} = create(); t.after(() => client.close());
  child.onCommand = record => record.type === 'get_entries' ? child.response(record, {entries: [entry('abandoned', 'root', 'x'.repeat(300_000))], leafId: 'root'}) : child.defaults(record);
  const result = await client.request('get_entries', {since: 'root'}) as {leafId: string; projected?: boolean; entries: unknown[]};
  assert.equal(result.leafId, 'root'); assert.equal(result.projected, undefined); assert.deepEqual(result.entries, []);
});
test('a complete large response still projects the actual active branch', async t => {
  const {child, client} = create(); t.after(() => client.close());
  child.onCommand = record => record.type === 'get_entries' ? child.response(record, {entries: [entry('root', null), entry('active', 'root'), entry('abandoned', 'root', 'x'.repeat(300_000))], leafId: 'active'}) : child.defaults(record);
  const result = await client.request('get_entries') as {projected: boolean; entries: {id: string}[]};
  assert.equal(result.projected, true); assert.deepEqual(result.entries.map(row => row.id), ['root', 'active']);
});
