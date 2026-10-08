import assert from 'node:assert/strict';
import test from 'node:test';
import { PreferenceQueue } from './preference-queue.ts';
function gate() {let resolve: () => void = () => undefined; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
test('view writes keep one request in flight and retain the latest unsent value', async () => {
  const queue = new PreferenceQueue(); const first = gate(); const sent: number[] = []; let revision = 0;
  const write = (value: number) => async () => {sent.push(value); const captured = revision; if (value === 1) await first.promise; assert.equal(revision, captured); revision++;};
  const pending = queue.save('target/reading', write(1)); await Promise.resolve();
  queue.save('target/reading', write(2)); queue.save('target/reading', write(3));
  assert.deepEqual(sent, [1]); first.resolve(); await pending; assert.deepEqual(sent, [1, 3]); assert.equal(revision, 2);
});
test('distinct targets and preference kinds do not block each other', async () => {
  const queue = new PreferenceQueue(); const first = gate(); const completed: string[] = [];
  const blocked = queue.save('a/reading', async () => {await first.promise; completed.push('a');});
  await queue.save('b/reading', async () => {completed.push('b');}); await queue.save('a/presentation', async () => {completed.push('view');});
  assert.deepEqual(completed, ['b', 'view']); first.resolve(); await blocked;
});
test('a failed view write is not resent and a later explicit edit starts a fresh lane', async () => {
  const queue = new PreferenceQueue(); let calls = 0;
  await assert.rejects(queue.save('target', async () => {calls++; throw new Error('not saved');}), /not saved/);
  assert.equal(calls, 1); await queue.save('target', async () => {calls++;}); assert.equal(calls, 2);
});
test('rapid local edits before dispatch coalesce without a network round trip', async () => {
  const queue = new PreferenceQueue(); const sent: string[] = [];
  const pending = queue.save('target', async () => {sent.push('old');}); queue.save('target', async () => {sent.push('latest');});
  await pending; assert.deepEqual(sent, ['latest']);
});
