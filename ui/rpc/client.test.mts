import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RpcClient, type RpcRecord } from './client.mts';
import { FakeChild } from './fake-child.mts';
import type { ProjectedSnapshot } from './events.mts';

function create(options: Partial<ConstructorParameters<typeof RpcClient>[0]> = {}) {
  const child = new FakeChild(); const events: unknown[] = []; const errors: unknown[] = [];
  const client = new RpcClient({ executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn,
    onEvent: (event) => events.push(event), onProtocolError: (error) => errors.push(error), ...options });
  client.start(); return { client, child, events, errors };
}

test('LF framing preserves chunked UTF-8, CRLF and Unicode separators', async () => {
  const { client, child, events } = create();
  const bytes = Buffer.from('{"type":"custom","text":"雪\u2028line\u2029tail"}\r\n');
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  assert.deepEqual(events, [{ type: 'custom', text: '雪\u2028line\u2029tail' }]); await client.close();
});
test('responses correlate out of order; events do not acknowledge requests', async () => {
  const { client, child } = create();
  const one = client.request('get_state'); const two = client.request('get_commands');
  const a = await child.command('get_state'); const b = await child.command('get_commands');
  child.event({ type: 'agent_settled', id: a.id }); assert.equal(client.pendingCount, 2);
  child.response(b, { commands: [] }); child.response(a, { sessionId: 'a' });
  assert.deepEqual(await two, { commands: [] }); assert.deepEqual(await one, { sessionId: 'a' });
  assert.equal(client.timings.length, 2); await client.close();
});
test('malformed, wrong response shape and unknown IDs refuse synchronization without killing child', async () => {
  for (const record of ['{bad}\n', '{"type":"response","id":"unknown","command":"get_state","success":true}\n', '{"type":"response","id":"rpc-1","command":"wrong","success":true}\n']) {
    const { client, child, errors } = create();
    const pending = client.request('get_state'); const rejected = assert.rejects(pending, { code: 'protocol_error' });
    await child.command('get_state'); child.stdout.write(record); await rejected;
    assert.equal(client.synchronized, false); assert.equal(errors.length, 1);
    await assert.rejects(client.request('prompt', { message: 'text' }), { code: 'protocol_error' });
    const read = client.request('get_state'); const command = await new Promise<RpcRecord>((resolve) => child.once('command', resolve));
    child.response(command, { ready: true }); await read; client.markSynchronized(); await client.close();
  }
});
test('oversized record discards through LF then continues to drain', async () => {
  const { client, child, events, errors } = create({ maxRecordBytes: 80 });
  child.stdout.write('x'.repeat(90)); child.stdout.write('tail\n{"type":"agent_start"}\n');
  assert.equal(errors.length, 1); assert.deepEqual(events, [{ type: 'agent_start' }]); await client.close();
});
test('backpressure does not stop stdout and limits outstanding commands', async () => {
  const { client, child, events } = create(); child.blocked = true;
  const first = client.request('get_state'); const command = await child.command('get_state');
  const rest = Array.from({ length: 63 }, () => client.request('get_commands').catch(() => {}));
  await assert.rejects(client.request('get_state'), { code: 'capacity' });
  child.event({ type: 'agent_start' }); child.response(command, {}); await first;
  assert.equal(events.length, 1); child.blocked = false; child.onCommand = (c) => child.response(c, {}); assert.ok(child.release); child.release();
  await Promise.all(rest); await client.close();
});
test('exit rejects dispatched input as uncertain and never replays', async () => {
  const { client, child } = create(); const input = client.request('prompt', { message: 'exact intent' });
  const rejected = assert.rejects(input, { uncertain: true }); await child.command('prompt'); child.exit(); await rejected;
  await assert.rejects(client.request('prompt'), { code: 'not_ready' }); assert.equal(child.writes.length, 1); await client.close();
});
test('stderr is bounded and controls escaped; upstream refusal retains its public message', async () => {
  const { client, child } = create(); child.stderr.write('a'.repeat(70 * 1024)); child.stderr.write('\x00\x1b[31mred\x1b[0m');
  assert.ok(Buffer.byteLength(client.stderrTail) < 66 * 1024); assert.ok(client.stderrTail.endsWith('\\u0000red'));
  const request = client.request('compact'); const command = await child.command('compact');
  child.event({ type: 'response', id: command.id, command: command.type, success: false, error: 'Nothing to compact (session too small)' });
  await assert.rejects(request, { code: 'rpc_rejected', message: 'Nothing to compact (session too small)' }); await client.close();
});
test('large retained snapshot decodes in order through the worker and omits signatures', async () => {
  const { client, child, events } = create();
  const request = client.request('get_entries'); const command = await child.command('get_entries');
  child.response(command, { entries: [{ id: 'e', parentId: null, type: 'message', message: { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'a'.repeat(300 * 1024), textSignature: 'secret' }] } }], leafId: 'e' });
  child.event({ type: 'agent_settled' }); const result = await request as ProjectedSnapshot;
  assert.equal(result.projected, true); assert.equal(result.entries[0]?.messages?.[0]?.coverage.truncated, true);
  assert.equal(JSON.stringify(result).includes('secret'), false); assert.deepEqual(events, [{ type: 'agent_settled' }]); await client.close();
});
test('control acknowledgment does not wait behind large history decode and state events remain ordered', async () => {
  const { client, child, events } = create(); let historyDone = false;
  const history = client.request('get_entries').then((value) => { historyDone = true; return value; });
  const snapshot = await child.command('get_entries');
  child.response(snapshot, { entries: [{ id: 'entry', parentId: null, type: 'message', message: { role: 'user', timestamp: 1, content: 'x'.repeat(1024 * 1024) } }], leafId: 'entry' });
  child.event({ type: 'agent_start' }); child.event({ type: 'compaction_start', reason: 'manual' });
  const control = client.request('abort'); const command = await child.command('abort');
  child.event({ type: 'agent_settled', aborted: true }); child.response(command); await control; assert.equal(historyDone, false);
  await history; assert.deepEqual(events, [{ type: 'agent_start' }, { type: 'compaction_start', reason: 'manual' }, { type: 'agent_settled', aborted: true }]); await client.close();
});
test('measurement hooks carry only stable IDs, bytes and same-process monotonic times', async () => {
  const measurements: unknown[][] = [];
  const { client, child } = create({ measure: (...values) => { measurements.push(values); } });
  const request = client.request('prompt', { message: 'private text' }); const record = await child.command('prompt');
  child.response(record, { disposition: 'handled' }); await request;
  assert.deepEqual(measurements.map((row) => row[0]), ['rpc.dispatch', 'upstream.receipt', 'rpc.ack']);
  assert.equal(measurements[0]?.[1], measurements[2]?.[1]); assert.equal(JSON.stringify(measurements).includes('private text'), false);
  assert.ok(Number(measurements[0]?.[2]) <= Number(measurements[2]?.[2])); await client.close();
});
test('shutdown deadline does not grant a process signal', async () => {
  const { client, child } = create({ shutdownTimeoutMs: 1 }); child.autoExit = false;
  await assert.rejects(client.close(), { code: 'handoff_blocked' }); assert.equal(child.listenerCount('exit'), 1); child.exit(0);
});
