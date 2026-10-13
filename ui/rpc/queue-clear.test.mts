import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PrimarySession, type PrimarySessionOptions} from './session.mts';
import {FakeChild} from './fake-child.mts';
import {LIMITS} from '../shared/api.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return {promise, resolve}; }
function create(options: Partial<PrimarySessionOptions> = {}) {
  const child = new FakeChild(); child.onCommand = record => child.defaults(record);
  const events: unknown[] = []; let count = 0;
  const session = new PrimarySession({key: 'primary', epoch: 3, cwd: process.cwd(), executable: 'pi', spawnChild: child.spawn, publish: () => {},
    onBeforeClearQueue: async (target, pending) => { const id = `clear-${++count}`; events.push(['before', id, target, pending]); return id; },
    onRecoveredQueue: async (id, queue) => { events.push(['retained', id, queue]); },
    onQueueClearFailed: async (id, uncertain) => { events.push(['failed', id, uncertain]); }, ...options});
  return {child, session, events};
}
const actions = {
  stop: (session: PrimarySession) => session.stop(),
  handoff: (session: PrimarySession) => session.handoff({epoch: 3, mode: 'abort', clearQueue: true}),
  close: (session: PrimarySession) => session.close(),
};
for (const [name, action] of Object.entries(actions)) {
  test(`${name} freezes input and completes the durable pre-clear check before native clearance`, async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const {child, session, events} = create({onBeforeClearQueue: async (target, pending) => {
      assert.deepEqual(target, {kind: 'primary', key: 'primary', epoch: 3}); assert.equal(pending, 2);
      entered.resolve(); await release.promise; throw new Error('storage refused');
    }});
    await session.start(); child.pendingMessageCount = 2;
    const work = action(session); const refused = assert.rejects(work, /storage refused/);
    await entered.promise;
    await assert.rejects(session.input('not admitted', 'prompt'), {code: 'not_ready'});
    assert.equal(child.writes.some(record => record.type === 'clear_queue' || record.type === 'abort'), false);
    release.resolve(); await refused; assert.deepEqual(events, []); child.exit(0);
  });
  test(`${name} waits for recovery persistence before abort or process close`, async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const {child, session, events} = create({onRecoveredQueue: async (id, queue) => {
      assert.equal(id, 'clear-1'); assert.deepEqual(queue, {steering: ['', 'same'], followUp: ['same']});
      entered.resolve(); await release.promise; throw new Error('retention refused');
    }});
    await session.start(); child.pendingMessageCount = 3;
    child.onCommand = record => record.type === 'clear_queue' ? child.response(record, {steering: ['', 'same'], followUp: ['same']}) : child.defaults(record);
    const work = action(session); const refused = assert.rejects(work, /retention refused/); await entered.promise;
    assert.equal(child.writes.some(record => record.type === 'abort'), false); assert.equal(child.stdin.writableEnded, false);
    release.resolve(); await refused;
    assert.deepEqual(events.at(-1), ['failed', 'clear-1', true]);
    assert.deepEqual(session.recoveredQueue, {steering: ['', 'same'], followUp: ['same']}); child.exit(0);
  });
}
test('fresh pending count validation refuses before anchor or native clearance', async () => {
  for (const pending of [undefined, -1, 0.5, LIMITS.unconfirmed + 1, '1']) {
    const {child, session, events} = create(); await session.start();
    child.onCommand = record => record.type === 'get_state' ? child.response(record, {pendingMessageCount: pending}) : child.defaults(record);
    await assert.rejects(session.stop(), {code: 'capacity'});
    assert.deepEqual(events, []); assert.equal(child.writes.some(record => record.type === 'clear_queue'), false); child.exit(0);
  }
});
test('clear failure settlement separates native refusal from lost, invalid and oversized responses', async () => {
  for (const outcome of ['refused', 'lost', 'invalid', 'protocol', 'excess-count', 'excess-bytes']) {
    const {child, session, events} = create(); await session.start(); child.pendingMessageCount = 1;
    child.onCommand = record => {
      if (record.type !== 'clear_queue') return child.defaults(record);
      switch (outcome) {
        case 'refused': child.reject(record); break;
        case 'lost': child.exit(1); break;
        case 'protocol': child.stdout.write('{bad}\n'); break;
        case 'invalid': child.response(record, {steering: [42], followUp: []}); break;
        case 'excess-count': child.response(record, {steering: ['a', 'b'], followUp: []}); break;
        default: child.response(record, {steering: ['x'.repeat(1024 * 1024)], followUp: []});
      }
    };
    await assert.rejects(session.stop());
    assert.deepEqual(events.at(-1), ['failed', 'clear-1', outcome !== 'refused']);
    assert.equal(child.writes.some(record => record.type === 'abort'), false);
    if (outcome.startsWith('excess')) {
      await assert.rejects(session.stop(), {code: 'capacity'});
      assert.equal(child.writes.filter(record => record.type === 'clear_queue').length, 1);
      assert.ok(session.recoveredQueue.steering.length);
    }
    child.exit(0);
  }
});
test('recovery retries preserve original identity and positions before another clear event', async () => {
  const records: unknown[] = []; let fail = true;
  const {child, session} = create({onRecoveredQueue: async (id, queue) => {
    records.push(['retain', id, queue]); if (fail) throw new Error('disk');
  }, onBeforeClearQueue: async (_target, count) => { const id = `event-${records.length}`; records.push(['before', id, count]); return id; }});
  await session.start(); child.pendingMessageCount = 2;
  child.onCommand = record => record.type === 'clear_queue' ? child.response(record, {steering: ['duplicate', 'duplicate'], followUp: []}) : child.defaults(record);
  await assert.rejects(session.stop()); await assert.rejects(session.stop());
  assert.equal(child.writes.filter(record => record.type === 'clear_queue').length, 1);
  fail = false; await session.stop();
  assert.deepEqual(records.slice(0, 4), [['before', 'event-0', 2], ...Array.from({length: 3}, () => ['retain', 'event-0', {steering: ['duplicate', 'duplicate'], followUp: []}])]);
  assert.deepEqual(records[4], ['before', 'event-4', 2]); assert.deepEqual(session.recoveredQueue, {steering: [], followUp: []}); child.exit(0);
});
test('close retries retained rows after persistence failure instead of releasing the writer', async () => {
  let fail = true; const ids: string[] = [];
  const {child, session} = create({onRecoveredQueue: async id => { ids.push(id); if (fail) throw new Error('disk'); }});
  await session.start(); await assert.rejects(session.close()); assert.equal(child.stdin.writableEnded, false);
  fail = false; await session.close(); assert.deepEqual(ids, ['clear-1', 'clear-1', 'clear-2']); assert.equal(child.stdin.writableEnded, true);
});
test('transport failure cannot release a writer before returned queue text is saved', async () => {
  let fail = true; const retained: string[] = [];
  const {child, session} = create({onRecoveredQueue: async id => { retained.push(id); if (fail) throw new Error('disk'); }});
  await session.start(); await assert.rejects(session.stop());
  child.stdin.emit('error', new Error('pipe unavailable'));
  await assert.rejects(session.close(), /disk/); assert.equal(child.stdin.writableEnded, false);
  fail = false; await session.close(); assert.deepEqual(retained, ['clear-1', 'clear-1', 'clear-1']);
  assert.equal(child.stdin.writableEnded, true);
});
test('concurrent stop and close share the active clear rather than merging native events', async () => {
  const entered = deferred<void>(), release = deferred<void>(); let before = 0, retained = 0;
  const {child, session} = create({onBeforeClearQueue: async () => { before++; entered.resolve(); await release.promise; return 'one'; }, onRecoveredQueue: async () => { retained++; }});
  await session.start(); const stop = session.stop(); await entered.promise; const close = session.close(); release.resolve();
  await Promise.all([stop, close]); assert.equal(before, 1); assert.equal(retained, 1); assert.equal(child.writes.filter(record => record.type === 'clear_queue').length, 1);
});
