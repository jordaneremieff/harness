import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrimarySession } from './session.mts';
import { FakeChild } from './fake-child.mts';
import type { SessionAction } from '../shared/api.ts';

function create(extra: Partial<ConstructorParameters<typeof PrimarySession>[0]> = {}) {
  const child = new FakeChild(); child.onCommand = (record) => child.defaults(record);
  const session = new PrimarySession({ key: 'key', executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, publish: () => {}, ...extra });
  return { child, session };
}
test('cleared queue persistence precedes abort and successful persistence releases local copies', async () => {
  let persist!: () => void; let seen = false;
  const { child, session } = create({ onRecoveredQueue: async (queue) => {
    assert.deepEqual(queue, { steering: ['exact'], followUp: [] }); seen = true; await new Promise<void>((resolve) => { persist = resolve; });
  } });
  await session.start(); child.onCommand = (record) => record.type === 'clear_queue' ? child.response(record, { steering: ['exact'], followUp: [] }) : child.defaults(record);
  const stop = session.stop(); await child.command('clear_queue');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(seen, true); assert.equal(child.writes.some((record) => record.type === 'abort'), false);
  persist(); await stop; assert.deepEqual(session.recoveredQueue, { steering: [], followUp: [] }); child.exit(0);
});
test('queue persistence failure retains recovered text and prevents abort', async () => {
  const { child, session } = create({ onRecoveredQueue: async () => { throw new Error('disk failure'); } });
  await session.start(); child.onCommand = (record) => record.type === 'clear_queue' ? child.response(record, { steering: ['exact'], followUp: [] }) : child.defaults(record);
  await assert.rejects(session.stop()); assert.deepEqual(session.recoveredQueue.steering, ['exact']);
  assert.equal(child.writes.some((record) => record.type === 'abort'), false); child.exit(0);
});
test('protocol fault refuses input but explicit stop remains available', async () => {
  const { child, session } = create(); await session.start(); child.stdout.write('{broken}\n');
  await assert.rejects(session.input('intent', 'prompt'), { code: 'protocol_error' });
  await session.stop(); assert.equal(child.writes.at(-1)?.type, 'abort'); await session.resynchronize();
  assert.equal(session.view.capabilities.input, true); await session.close();
});
test('oversized trust dialogs remain explicit blocked state and stop cancels retained request IDs', async () => {
  const { child, session } = create(); await session.start();
  child.event({ type: 'extension_ui_request', id: 'large', method: 'confirm', title: 'x'.repeat(40 * 1024) });
  assert.equal(session.view.lastError?.code, 'capacity'); assert.equal(session.view.capabilities.input, false);
  assert.ok(Buffer.byteLength(JSON.stringify(session.view)) < 256 * 1024);
  await assert.rejects(session.resynchronize(), { code: 'capacity' });
  await session.stop(); assert.ok(child.writes.some((record) => record.id === 'large' && record.cancelled === true));
  await session.resynchronize(); await session.close();
});
test('extension aggregate bounds restore the previous status state on refusal', async () => {
  const { child, session } = create(); await session.start();
  child.event({ type: 'extension_ui_request', id: 'a', method: 'setStatus', statusKey: 'existing', statusText: 'kept' });
  child.event({ type: 'extension_ui_request', id: 'b', method: 'setStatus', statusKey: 'large', statusText: 'x'.repeat(20 * 1024) });
  assert.equal(session.view.lastError?.code, 'capacity'); assert.deepEqual(session.view.extension?.statuses, { existing: 'kept' });
  await session.stop(); await session.close();
});
test('failed recovered queue persists on the next stop before another native clear', async () => {
  let fail = true; const stored: unknown[] = [];
  const { child, session } = create({ onRecoveredQueue: async (queue) => { if (fail) throw new Error('disk'); stored.push(queue); } });
  await session.start(); child.onCommand = (record) => record.type === 'clear_queue' ? child.response(record, { steering: ['intent'], followUp: [] }) : child.defaults(record);
  await assert.rejects(session.stop()); assert.deepEqual(session.recoveredQueue.steering, ['intent']); fail = false;
  await session.stop(); assert.deepEqual(stored, [{ steering: ['intent'], followUp: [] }, { steering: ['intent'], followUp: [] }]);
  assert.deepEqual(session.recoveredQueue, { steering: [], followUp: [] }); child.exit(0);
});
test('empty backend lifecycle never creates a process on construction or observation', () => {
  const { child, session } = create(); assert.equal(session.entries.length, 0); assert.equal(session.messages.length, 0);
  assert.equal(session.view.lifecycle, 'starting'); assert.equal(child.spawnArgs, undefined);
});
test('resume requires explicit writer-release attestation', async () => {
  const { child, session } = create(); await session.start();
  await assert.rejects(session.transition({ epoch: 1, action: 'resume', sessionFile: import.meta.filename } as unknown as SessionAction), { code: 'invalid_request' });
  assert.equal(child.writes.some((record) => record.type === 'switch_session'), false);
  await session.transition({ epoch: 1, action: 'resume', sessionFile: import.meta.filename, writerReleased: true });
  assert.equal(session.view.epoch, 2); await session.close();
});
