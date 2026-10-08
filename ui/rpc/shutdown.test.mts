import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { PrimaryView } from '../shared/api.ts';
import { RpcClient } from './client.mts';
import { FakeChild } from './fake-child.mts';
import { PrimarySession } from './session.mts';

function sessionFixture() {
  const child = new FakeChild(); const states: PrimaryView[] = []; let spawns = 0;
  child.onCommand = (record) => child.defaults(record);
  const session = new PrimarySession({ key: 'key', executable: 'pi', cwd: process.cwd(), shutdownTimeoutMs: 1,
    spawnChild: (executable, args, options) => { spawns++; return child.spawn(executable, args, options); },
    publish: (name, _target, data) => { if (name === 'primary.state') states.push(structuredClone(data as PrimaryView)); } });
  return { child, session, states, spawns: () => spawns };
}
test('stdin EPIPE ends transport but retains ownership until the actual child exit', async () => {
  const child = new FakeChild(); child.autoExit = false; let exits = 0;
  const client = new RpcClient({ executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, shutdownTimeoutMs: 1, onExit: () => { exits++; } });
  client.start(); const pending = client.request('prompt', { message: 'intent' }); const rejected = assert.rejects(pending, { uncertain: true });
  await child.command('prompt'); child.stdin.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' })); await rejected;
  assert.equal(client.exited, false); assert.equal(client.available, false); assert.equal(exits, 0);
  await assert.rejects(client.close(), { code: 'handoff_blocked' }); assert.equal(client.exited, false);
  child.exit(0); assert.equal(client.exited, true); assert.equal(exits, 1);
});
test('child error proves termination only when spawn failed without a PID', async () => {
  for (const pid of [undefined, 123]) {
    const child = new FakeChild(); Object.defineProperty(child, 'pid', { value: pid }); let exits = 0;
    const client = new RpcClient({ executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, onExit: () => { exits++; } });
    client.start(); child.emit('error', new Error('process error'));
    assert.equal(client.exited, pid === undefined); assert.equal(exits, pid === undefined ? 1 : 0);
    child.exit(1); assert.equal(client.exited, true); assert.equal(exits, 1); await client.close();
  }
});
test('pipe setup failure after spawn retains ownership and still observes the actual exit', async (t) => {
  const child = new FakeChild(); let exits = 0;
  const registration = t.mock.method(child.stdout, 'on', () => { throw new Error('pipe setup'); });
  const client = new RpcClient({ executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn, onExit: () => { exits++; } });
  client.start(); registration.mock.restore(); assert.equal(client.exited, false); assert.equal(exits, 0);
  child.exit(1); assert.equal(client.exited, true); assert.equal(exits, 1); await client.close();
});
test('client close before start permanently refuses spawn and command admission', async () => {
  const child = new FakeChild(); let spawns = 0;
  const client = new RpcClient({ executable: 'pi', cwd: process.cwd(), spawnChild: (executable, args, options) => { spawns++; return child.spawn(executable, args, options); } });
  await client.close(); assert.throws(() => client.start(), { code: 'not_ready' });
  await assert.rejects(client.request('get_state'), { code: 'not_ready' }); assert.equal(spawns, 0); assert.equal(client.child, undefined);
});
test('session close before start or during directory validation prevents any child spawn', async () => {
  for (const startFirst of [false, true]) {
    const { session, spawns } = sessionFixture(); const rejected = startFirst ? assert.rejects(session.start(), { code: 'not_ready' }) : undefined;
    await session.close(); await rejected; await assert.rejects(session.start(), { code: 'not_ready' });
    assert.equal(spawns(), 0); assert.equal(session.client.child, undefined); assert.equal(session.view.lifecycle, 'stopped');
  }
});
test('malformed startup keeps the live writer owned through a blocked close and publishes its later exit', async () => {
  const { child, session, states } = sessionFixture(); child.autoExit = false;
  child.onCommand = (record) => { if (record.type === 'get_state') child.stdout.write('{bad}\n'); else child.defaults(record); };
  await assert.rejects(session.start(), { code: 'protocol_error' }); assert.equal(session.client.exited, false); assert.equal(session.view.lifecycle, 'failed');
  await assert.rejects(session.close(), { code: 'handoff_blocked' }); assert.equal(session.client.exited, false);
  child.exit(0); assert.equal(session.client.exited, true); assert.equal(session.view.lifecycle, 'stopped'); assert.equal(states.at(-1)?.lifecycle, 'stopped');
});
test('session close uses EOF after a transport failure and still publishes verified termination', async () => {
  const { child, session, states } = sessionFixture(); await session.start(); await session.refreshState();
  child.stdin.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' })); assert.equal(session.client.exited, false);
  await session.close(); assert.equal(session.client.exited, true); assert.equal(session.view.lifecycle, 'stopped'); assert.equal(states.at(-1)?.lifecycle, 'stopped');
  assert.equal(child.writes.some((record) => record.type === 'abort'), false);
});
test('exit cancels active and queued history decodes and ignores late records without another decoder', async () => {
  const child = new FakeChild(); const events: unknown[] = []; const errors: unknown[] = [];
  const client = new RpcClient({ executable: 'pi', cwd: process.cwd(), spawnChild: child.spawn,
    onEvent: (event) => events.push(event), onProtocolError: (error) => errors.push(error) }); client.start();
  const one = client.request('get_entries'); const two = client.request('get_entries');
  const rejectedOne = assert.rejects(one, { uncertain: true }); const rejectedTwo = assert.rejects(two, { uncertain: true });
  const first = await child.command('get_entries'); const [second] = await once(child, 'command');
  const snapshot = { entries: [{ id: 'entry', type: 'message', message: { role: 'user', timestamp: 1, content: 'x'.repeat(1024 * 1024) } }], leafId: 'entry' };
  child.response(first, snapshot); child.response(second, snapshot); child.event({ type: 'agent_settled' }); child.exit(1);
  await rejectedOne; await rejectedTwo; await client.close();
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'response', command: 'get_entries', id: second.id, success: true, data: snapshot })}\n`));
  assert.equal(client.exited, true); assert.equal(client.pendingCount, 0); assert.deepEqual(events, []); assert.deepEqual(errors, []);
});
