import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventData, EventName } from '../shared/api.ts';
import { RpcClient, type RpcRecord } from './client.mts';
import { FakeChild } from './fake-child.mts';
import { PrimarySession } from './session.mts';

const refusal = 'Nothing to compact (session too small)';
function reject(child: FakeChild, record: RpcRecord, error = refusal): void {
  child.event({ type: 'response', id: record.id, command: record.type, success: false, error });
}
function compactEnd(child: FakeChild, reason = 'manual'): void {
  child.event({ type: 'compaction_end', reason, aborted: false, willRetry: reason === 'overflow', errorMessage: `Compaction failed: ${refusal}` });
}
async function create() {
  const child = new FakeChild(); const published: { name: EventName; data: EventData[EventName] }[] = [];
  child.onCommand = (record) => child.defaults(record);
  const session = new PrimarySession({ key: 'key', executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn,
    publish: (name, _target, data) => published.push({ name, data: structuredClone(data) }) });
  await session.start();
  return { child, session, published };
}
function refusing(child: FakeChild, duringRead?: (record: RpcRecord) => void): void {
  child.onCommand = (record) => {
    if (record.type === 'compact') {
      child.event({ type: 'compaction_start', reason: 'manual' }); compactEnd(child); reject(child, record);
    } else if (record.type === 'get_state' && duringRead) duringRead(record);
    else child.defaults(record);
  };
}

test('manual compact refusal refreshes idle without agent_settled and retains the actual error', async () => {
  const { child, session, published } = await create(); refusing(child);
  const before = child.writes.filter((record) => record.type === 'get_state').length;
  await assert.rejects(session.control({ action: 'compact', epoch: 1 }), { code: 'rpc_rejected', message: refusal });
  assert.equal(session.view.activity, 'idle'); assert.equal(session.client.synchronized, true);
  assert.equal(child.writes.filter((record) => record.type === 'get_state').length, before + 1);
  const recovery = published.filter((event) => event.name === 'primary.recovery').at(-1)?.data as EventData['primary.recovery'];
  assert.equal(recovery.error, `Compaction failed: ${refusal}`); assert.equal(recovery.phase, 'end');
  assert.equal(published.filter((event) => event.name === 'primary.state').at(-1)?.data && session.view.lifecycle, 'ready');
  await session.close();
});
test('manual refusal preserves authoritative concurrent streaming activity', async () => {
  const { child, session } = await create();
  refusing(child, (record) => child.response(record, { sessionId: 'fixture', isStreaming: true, isCompacting: false }));
  await assert.rejects(session.control({ action: 'compact', epoch: 1 }), { message: refusal });
  assert.equal(session.view.activity, 'running'); await session.close();
});
for (const type of ['agent_start', 'tool_execution_start', 'tool_execution_update']) {
  test(`manual refusal cannot erase newer ${type} with a stale idle response`, async () => {
    const { child, session } = await create();
    refusing(child, (record) => {
      child.event({ type, toolCallId: 'call', toolName: 'read' }); child.defaults(record);
    });
    await assert.rejects(session.control({ action: 'compact', epoch: 1 }), { message: refusal });
    assert.equal(session.view.activity, 'running'); await session.close();
  });
}
test('recovery end invalidates a state read issued before the end event', async () => {
  const { child, session } = await create(); let held: RpcRecord | undefined;
  child.event({ type: 'compaction_start', reason: 'manual' });
  let read!: () => void; const requested = new Promise<void>((resolve) => { read = resolve; });
  child.onCommand = (record) => { if (record.type === 'get_state') { held = record; read(); } else child.defaults(record); };
  const refresh = session.refreshState(); await requested;
  assert.ok(held); compactEnd(child);
  child.defaults(held); await refresh; assert.equal(session.view.activity, 'compacting'); await session.close();
});
for (const reason of ['threshold', 'overflow']) {
  test(`automatic ${reason} recovery end is not settlement or a manual state refresh`, async () => {
    const { child, session } = await create(); const before = child.writes.length;
    child.event({ type: 'agent_start' }); child.event({ type: 'compaction_start', reason }); compactEnd(child, reason);
    assert.equal(session.view.activity, 'compacting'); assert.equal(child.writes.length, before);
    child.event({ type: 'auto_retry_start' }); child.event({ type: 'auto_retry_end', success: true });
    assert.equal(session.view.activity, 'retrying'); child.event({ type: 'agent_settled' });
    assert.equal(session.view.activity, 'idle'); await session.close();
  });
}
test('failed refusal refresh preserves the refusal and marks state synchronization as unavailable', async () => {
  const { child, session } = await create(); refusing(child, (record) => child.response(record, { sessionId: 'fixture' }));
  await assert.rejects(session.control({ action: 'compact', epoch: 1 }), { message: refusal });
  assert.equal(session.view.lastError?.code, 'protocol_error'); assert.equal(session.client.synchronized, false);
  await session.close();
});
test('late state response cannot change activity after lifecycle closure', async () => {
  const { child, session } = await create(); let held: RpcRecord | undefined;
  let read!: () => void; const requested = new Promise<void>((resolve) => { read = resolve; });
  child.onCommand = (record) => { if (record.type === 'get_state') { held = record; read(); } else child.defaults(record); };
  const refresh = session.refreshState(); const rejected = assert.rejects(refresh, { code: 'not_ready' });
  await requested; assert.ok(held);
  session.view.lifecycle = 'stopping'; session.view.activity = 'unknown'; child.defaults(held); await rejected;
  assert.equal(session.view.activity, 'unknown'); await session.close();
});
test('RPC refusal text removes controls and credentials and stays within a Unicode-safe byte bound', async () => {
  const child = new FakeChild(); const client = new RpcClient({ executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn }); client.start();
  const request = client.request('compact'); const command = await child.command('compact');
  reject(child, command, `\x1b[31mRefused\x1b[0m\x00 Bearer ${'a'.repeat(24)} https://user:pass@example.test ${'雪'.repeat(1024)}`);
  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof Error); assert.ok(error.message.startsWith('Refused Bearer [redacted] https://[redacted]@example.test'));
    assert.ok(Buffer.byteLength(error.message) <= 512); assert.ok(error.message.endsWith('[truncated]'));
    assert.equal(/[\x00\x1b\ufffd]/.test(error.message), false); return true;
  });
  const empty = client.request('compact'); const next = await new Promise<RpcRecord>((resolve) => child.once('command', resolve));
  reject(child, next, '\x00'); await assert.rejects(empty, { message: 'Pi rejected the RPC command.' }); await client.close();
});
