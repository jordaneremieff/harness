import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionRecovery, connectionSurface, type ConnectionClock, type ConnectionPhase } from './connection-state.ts';

test('recovery and failure use one owner that stays visible when the sidebar is hidden', () => {
  for (const sidebar of [true, false]) {
    const owner = sidebar ? 'connection' : 'workspace-alert';
    for (const phase of ['healthy', 'quiet'] as const) assert.deepEqual(connectionSurface(phase, sidebar), {owner, visible: false});
    for (const phase of ['reconnecting', 'offline', 'auth'] as const) assert.deepEqual(connectionSurface(phase, sidebar), {owner, visible: true});
  }
});
function fixture() {
  let now = 0; let serial = 0;
  const timers = new Map<number, {at: number; callback: () => void}>();
  const phases: ConnectionPhase[] = []; const attempts: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const clock: ConnectionClock = {now: () => now, set: (callback, delay) => {const id = ++serial; timers.set(id, {at: now + delay, callback}); return id;}, clear: id => {timers.delete(id);}};
  const recovery = new ConnectionRecovery({attempt: () => {const task = Promise.withResolvers<void>(); attempts.push(task); return task.promise;}, paint: phase => phases.push(phase), unauthorized: error => error === 'auth'}, clock);
  return {recovery, phases, attempts, timers, advance: (time: number) => {
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
test('a slow attempt delays the next attempt until failure rather than starting parallel reads', async () => {
  const f = fixture(); f.recovery.lost(); f.advance(250); f.advance(7000);
  assert.equal(f.attempts.length, 1); f.attempts[0]?.reject('late'); await settle();
  f.advance(7000); assert.equal(f.attempts.length, 2);
});
