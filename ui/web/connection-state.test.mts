import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionRecovery, accessViewVisible, connectionSurface, type ConnectionClock, type ConnectionPhase } from './connection-state.ts';

test('connection trouble has one top owner and unauthorized access replaces the shell', () => {
  for (const phase of ['healthy','quiet'] as const) assert.deepEqual(connectionSurface(phase), {owner: 'connection', visible: false});
  for (const phase of ['reconnecting','offline'] as const) assert.deepEqual(connectionSurface(phase), {owner: 'connection', visible: true});
  assert.deepEqual(connectionSurface('auth'), {owner: 'access-view', visible: false});
});

test('access rechecks retain the full-window view until a healthy baseline returns', () => {
  assert.equal(accessViewVisible('auth', false), true);
  for (const phase of ['quiet','reconnecting','offline','auth'] as const) assert.equal(accessViewVisible(phase, true), true);
  assert.equal(accessViewVisible('healthy', true), false); assert.equal(accessViewVisible('quiet', false), false);
});
function fixture() {
  let now = 0; let serial = 0;
  const timers = new Map<number, {at: number; callback: () => void}>();
  const phases: ConnectionPhase[] = []; const attempts: Array<ReturnType<typeof Promise.withResolvers<void>>> = []; const signals: AbortSignal[] = [];
  const clock: ConnectionClock = {now: () => now, set: (callback, delay) => {const id = ++serial; timers.set(id, {at: now + delay, callback}); return id;}, clear: id => {timers.delete(id);}};
  const recovery = new ConnectionRecovery({attempt: signal => {const task = Promise.withResolvers<void>(); attempts.push(task); signals.push(signal); return task.promise;}, paint: phase => phases.push(phase), unauthorized: error => error === 'auth'}, clock);
  return {recovery, phases, attempts, signals, timers, advance: (time: number) => {
    now = time;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now) {timers.delete(id); timer.callback();}
  }};
}
const settle = async () => {await Promise.resolve(); await Promise.resolve();};
test('loss is quiet before 750ms; automatic attempts are bounded and never overlap', async () => {
  const f = fixture(); f.recovery.lost(); assert.deepEqual(f.phases, ['quiet']);
  f.advance(249); assert.equal(f.attempts.length, 0);
  f.advance(250); assert.equal(f.attempts.length, 1);
  f.recovery.lost(); f.recovery.reconnect(); assert.equal(f.attempts.length, 1);
  f.advance(750); assert.equal(f.recovery.phase, 'reconnecting');
  f.attempts[0]?.reject('network'); await settle();
  f.advance(999); assert.equal(f.attempts.length, 1);
  f.advance(1000); assert.equal(f.attempts.length, 2); f.attempts[1]?.reject('network'); await settle();
  f.advance(3000); assert.equal(f.attempts.length, 3); f.attempts[2]?.reject('network'); await settle();
  f.advance(6000); assert.equal(f.attempts.length, 4); f.attempts[3]?.reject('network'); await settle();
  assert.equal(f.recovery.phase, 'offline'); assert.equal(f.timers.size, 0);
  f.advance(60000); f.recovery.lost(); assert.equal(f.attempts.length, 4);
});
test('successful ready attempt cancels all timers and remains visually quiet', async () => {
  const f = fixture(); f.recovery.lost(); f.advance(250); f.attempts[0]?.resolve(); await settle();
  assert.deepEqual(f.phases, ['quiet', 'healthy']); assert.equal(f.timers.size, 0);
  f.advance(10000); assert.equal(f.attempts.length, 1);
});
test('auth failure stops retries immediately and explicit reconnect starts a new episode', async () => {
  const f = fixture(); f.recovery.lost('auth'); assert.equal(f.recovery.phase, 'auth'); assert.equal(f.timers.size, 0);
  f.recovery.reconnect(); assert.equal(f.attempts.length, 1);
  f.attempts[0]?.reject('auth'); await settle(); assert.equal(f.recovery.phase, 'auth'); assert.equal(f.timers.size, 0);
});
test('a late failure cannot replace a newer healthy state', async () => {
  const f = fixture(); f.recovery.lost(); f.advance(250); f.recovery.healthy();
  f.attempts[0]?.reject('late'); await settle(); assert.equal(f.recovery.phase, 'healthy'); assert.equal(f.timers.size, 0);
});
test('suspension cancels queued retries and rejects even an already-dequeued hidden callback', async () => {
  const f = fixture(); f.recovery.lost(); const queued = [...f.timers.values()].find(timer => timer.at === 250); assert.ok(queued);
  f.recovery.suspend(); assert.equal(f.timers.size, 0); queued.callback(); f.recovery.reconnect(); f.recovery.lost('hidden');
  assert.equal(f.attempts.length, 0); f.recovery.resume(); f.recovery.resume(); assert.equal(f.attempts.length, 1);
  f.attempts[0]?.resolve(); await settle(); assert.equal(f.recovery.phase, 'healthy'); assert.equal(f.timers.size, 0);
});
test('suspension aborts a pending attempt and stale completion cannot clear the revealed attempt', async () => {
  const f = fixture(); f.recovery.reconnect(); assert.equal(f.attempts.length, 1);
  f.recovery.suspend(); assert.equal(f.signals[0]?.aborted, true); f.recovery.resume(); assert.equal(f.attempts.length, 2);
  f.attempts[0]?.reject('late'); await settle(); f.recovery.reconnect(); assert.equal(f.attempts.length, 2);
  assert.equal(f.signals[1]?.aborted, false); f.attempts[1]?.resolve(); await settle(); assert.equal(f.recovery.phase, 'healthy'); assert.equal(f.timers.size, 0);
});
test('a late successful hidden attempt cannot report healthy or schedule another retry', async () => {
  const f = fixture(); f.recovery.reconnect(); f.recovery.suspend(); const phases = [...f.phases];
  f.attempts[0]?.resolve(); await settle(); assert.deepEqual(f.phases, phases); assert.equal(f.timers.size, 0);
  f.recovery.resume(); assert.equal(f.attempts.length, 2); f.attempts[1]?.resolve(); await settle(); assert.equal(f.recovery.phase, 'healthy');
});
test('a slow attempt delays the next attempt until failure rather than starting parallel reads', async () => {
  const f = fixture(); f.recovery.lost(); f.advance(250); f.advance(7000);
  assert.equal(f.attempts.length, 1); f.attempts[0]?.reject('late'); await settle();
  f.advance(7000); assert.equal(f.attempts.length, 2);
});
