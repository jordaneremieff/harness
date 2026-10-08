import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import test from 'node:test';
import { LIMITS } from '../shared/api.ts';
import { Journal } from './journal.mts';

class Response extends EventEmitter {
  writes: string[] = []; ends: string[] = []; writableLength = 0; writable = true;
  status = 0; headers: unknown; flushed = false;
  get http() { return this as unknown as ServerResponse; }
  writeHead(status: number, headers: unknown) { this.status = status; this.headers = headers; }
  flushHeaders() { this.flushed = true; }
  write(wire: string) { this.writes.push(wire); return this.writable; }
  end(wire?: string) { this.ends.push(wire ?? ''); }
}
function publish(journal: Journal, message: string, workspace?: string) {
  return journal.publish('notice', undefined, {level: 'info', message}, workspace);
}
function frames(response: Response) {
  return response.writes.concat(response.ends).filter(Boolean).map(wire => ({
    id: /^id: (.+)$/m.exec(wire)?.[1], name: /^event: (.+)$/m.exec(wire)?.[1],
    envelope: JSON.parse(/^data: (.+)$/m.exec(wire)?.[1] ?? 'null'),
  }));
}

test('journal IDs, envelopes, and replay preserve exact publication order', () => {
  const journal = new Journal(); const start = journal.cursor;
  const target = {kind: 'primary' as const, key: 'primary', epoch: 3};
  const first = journal.publish('primary.delta', target, {messageId: 'm', index: 0, kind: 'text', delta: 'α\nβ'}, 'a');
  const second = publish(journal, 'next');
  assert.equal(first, `${journal.bootId}:1`); assert.equal(second, `${journal.bootId}:2`);
  const replay = journal.replay(start, 'a');
  assert.equal(replay.reason, undefined); assert.deepEqual(replay.records.map(r => r.id), [first, second]);
  assert.deepEqual(replay.records[0]?.envelope.target, target);
  assert.equal(replay.records[0]?.envelope.workspaceId, 'a');
  for (const record of replay.records) {
    assert.equal(record.bytes, Buffer.byteLength(record.wire)); assert.ok(record.wire.endsWith('\n\n'));
    assert.ok(Number.isFinite(Date.parse(record.envelope.at)));
  }
  assert.deepEqual(journal.replay(second, 'a').records, []);
});

test('workspace filtering preserves global events and permits sequence gaps', () => {
  const journal = new Journal(); const cut = journal.cursor;
  const ids = [publish(journal, 'global'), publish(journal, 'a', 'a'), publish(journal, 'b', 'b'), publish(journal, 'global2')];
  assert.deepEqual(journal.replay(cut, 'a').records.map(r => r.id), [ids[0], ids[1], ids[3]]);
  const a = new Response(); const b = new Response(); journal.attach(a.http, 'a', 'session', journal.cursor); journal.attach(b.http, 'b', 'session', journal.cursor);
  publish(journal, 'only a', 'a'); publish(journal, 'all');
  assert.deepEqual(frames(a).filter(f => f.id).map(f => f.envelope.data.message), ['only a', 'all']);
  assert.deepEqual(frames(b).filter(f => f.id).map(f => f.envelope.data.message), ['all']); journal.close();
});

test('missing, malformed, foreign-boot, future, and unsafe cursors resynchronize', () => {
  const journal = new Journal();
  assert.equal(journal.replay(undefined, 'a').reason, 'initial');
  assert.equal(journal.replay(`${new Journal().bootId}:0`, 'a').reason, 'boot-changed');
  for (const cursor of ['bad', ':0', `${journal.bootId}:-1`, `${journal.bootId}:1.0`, `${journal.bootId}:1`, `${journal.bootId}:9007199254740992`, `${journal.bootId}:0x0`]) {
    assert.equal(journal.replay(cursor, 'a').reason, 'invalid-cursor', cursor);
  }
});

test('count and UTF-8 byte retention bounds expire only cursors below the retained floor', () => {
  for (const bounds of [{events: 2, bytes: 100000, queue: 100000}, {events: 100, bytes: 300, queue: 100000}]) {
    const journal = new Journal(bounds); const start = journal.cursor;
    const ids = Array.from({length: 6}, () => publish(journal, '😀'.repeat(10)));
    assert.equal(journal.replay(start, 'a').reason, 'expired');
    const tail = journal.replay(ids[4], 'a'); assert.equal(tail.reason, undefined);
    assert.deepEqual(tail.records.map(r => r.id), [ids[5]]);
  }
});

test('resync closes without a journal ID and carries a snapshot URL and current cut', () => {
  const journal = new Journal(); publish(journal, 'state'); const cut = journal.cursor;
  const response = new Response(); let closed = 0;
  journal.attach(response.http, 'a & b', 'session', undefined, () => closed++);
  assert.equal(response.status, 200); assert.equal(response.flushed, true);
  assert.deepEqual(response.headers, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
  assert.equal(journal.connectionCount, 0); assert.equal(closed, 1);
  assert.deepEqual(frames(response).map(f => [f.name, f.id, f.envelope.data]), [['resync', undefined, {reason: 'initial', snapshotUrl: '/api/snapshot?workspace=a%20%26%20b', cursor: cut}]]);
  assert.equal(journal.cursor, cut);
});

test('blocked replay, ready metadata, and subsequent live events drain in order', () => {
  const journal = new Journal(); const cut = journal.cursor;
  const first = publish(journal, 'first'); const second = publish(journal, 'second');
  const response = new Response(); response.writable = false;
  journal.attach(response.http, 'a', 'session', cut);
  const third = publish(journal, 'third'); assert.equal(response.writes.length, 1);
  response.writable = true; response.emit('drain');
  assert.deepEqual(frames(response).map(f => [f.name, f.id]), [['notice', first], ['notice', second], ['ready', undefined], ['notice', third]]);
  assert.equal(journal.cursor, third); journal.close();
});

test('one slow browser never blocks producers or another browser', () => {
  const journal = new Journal({events: 4096, bytes: 8 * 1024 * 1024, queue: 1024});
  const slow = new Response(); const fast = new Response(); let closed = 0;
  journal.attach(slow.http, 'a', 'slow', journal.cursor, () => closed++);
  journal.attach(fast.http, 'a', 'fast', journal.cursor);
  slow.writable = false;
  const ids = Array.from({length: 100}, (_, i) => publish(journal, `delta ${i}`));
  assert.deepEqual(frames(fast).filter(f => f.id).map(f => f.id), ids);
  assert.equal(frames(slow).at(-1)?.envelope.data.reason, 'slow-client');
  assert.equal(frames(slow).at(-1)?.id, undefined); assert.equal(closed, 1);
  assert.equal(journal.connectionCount, 1); slow.emit('drain'); slow.emit('close'); assert.equal(closed, 1); journal.close();
});

test('transport buffered bytes count toward the slow-client bound', () => {
  const journal = new Journal({events: 10, bytes: 10000, queue: 1024}); const response = new Response();
  journal.attach(response.http, 'a', 'session', journal.cursor);
  response.writableLength = 1024; publish(journal, 'new');
  assert.equal(frames(response).at(-1)?.envelope.data.reason, 'slow-client'); assert.equal(journal.connectionCount, 0);
});

test('close, error, logout revocation, and shutdown detach exactly once', () => {
  const journal = new Journal(); const a = new Response(); const b = new Response(); const c = new Response(); let closed = 0;
  for (const [response, session] of [[a, 'one'], [b, 'two'], [c, 'two']] as const) journal.attach(response.http, 'a', session, journal.cursor, () => closed++);
  a.emit('error', new Error('connection')); a.emit('close'); assert.equal(closed, 1);
  journal.revoke('two'); assert.equal(closed, 3); assert.equal(journal.workspaceClients('a'), 0);
  journal.close(); journal.revoke('two'); assert.equal(closed, 3); assert.equal(b.ends.length, 1); assert.equal(c.ends.length, 1);
});

test('control and oversized records never consume a sequence number', () => {
  const journal = new Journal(); const cut = journal.cursor;
  assert.throws(() => journal.publish('ready', undefined, {bootId: journal.bootId, cursor: cut}), {code: 'invalid_request'});
  assert.throws(() => journal.publish('resync', undefined, {reason: 'initial', snapshotUrl: '/', cursor: cut}), {code: 'invalid_request'});
  assert.throws(() => publish(journal, '😀'.repeat(LIMITS.displayBytes / 4)), {code: 'payload_too_large', status: 413});
  assert.equal(journal.cursor, cut); assert.deepEqual(journal.replay(cut, 'a').records, []);
});
