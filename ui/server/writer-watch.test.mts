import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {watch} from 'node:fs';
import {mkdir, mkdtemp, rm, unlink, writeFile} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {WriterWatch} from './writer-watch.mts';

const ID = '9a1c3e5f-7b2d-4f60-8a91-b2c3d4e5f607';
async function store(context: {after(work: () => Promise<void>): void}) {
  const root = await mkdtemp(join(tmpdir(), 'ui-writer-watch-')); const directory = join(root, '.primaries'); await mkdir(directory);
  context.after(async () => { await rm(root, {recursive: true, force: true}); });
  const record = join(directory, `${ID}.json`), session = join(root, 'session.jsonl');
  const publish = () => writeFile(record, JSON.stringify({id: ID, sessionFile: session, cwd: root, pid: process.pid, hostname: hostname()}));
  return {root, record, session, publish};
}

test('removing the record of a held file reports its release once and stops the watch', async context => {
  const disposable = await store(context); await disposable.publish();
  let watch!: WriterWatch;
  const released = new Promise<string[]>(resolve => { watch = new WriterWatch(disposable.root, ids => resolve(ids)); });
  watch.track([{id: ID, path: disposable.session}]); assert.equal(watch.active, true);
  await unlink(disposable.record);
  assert.deepEqual(await released, [ID]); assert.equal(watch.active, false);
  watch.close();
});

test('a held file whose record stays live reports nothing', async context => {
  const disposable = await store(context); await disposable.publish();
  const calls: string[][] = []; const watch = new WriterWatch(disposable.root, ids => calls.push(ids));
  watch.track([{id: ID, path: disposable.session}]); await disposable.publish(); await disposable.publish();
  await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []); assert.equal(watch.active, true);
  watch.close(); assert.equal(watch.active, false);
});

test('a record already gone when the watch starts is reported without waiting for an event', async context => {
  const disposable = await store(context);
  let watch!: WriterWatch;
  const released = new Promise<string[]>(resolve => { watch = new WriterWatch(disposable.root, ids => resolve(ids)); });
  watch.track([{id: ID, path: disposable.session}]);
  assert.deepEqual(await released, [ID]); watch.close();
});

test('a release whose directory event never arrives is reported by the next track call', {timeout: 5000}, async context => {
  const disposable = await store(context); await disposable.publish();
  const silent = (() => Object.assign(new EventEmitter(), {close() {}})) as unknown as typeof watch;
  let watcher!: WriterWatch; let calls = 0;
  const released = new Promise<string[]>(resolve => { watcher = new WriterWatch(disposable.root, ids => { calls++; resolve(ids); }, silent); });
  watcher.track([{id: ID, path: disposable.session}]);
  await unlink(disposable.record);
  watcher.track([]);
  assert.deepEqual(await released, [ID]); assert.equal(watcher.active, false);
  watcher.track([]); assert.equal(calls, 1); watcher.close();
});

test('nothing is watched when nothing is held', async context => {
  const disposable = await store(context); const watch = new WriterWatch(disposable.root, () => {});
  watch.track([]); assert.equal(watch.active, false);
  watch.close();
});

test('a missing record directory starts no watch and reports the held file released', async context => {
  const disposable = await store(context);
  let watch!: WriterWatch;
  const released = new Promise<string[]>(resolve => { watch = new WriterWatch(join(disposable.root, 'absent'), ids => resolve(ids)); });
  watch.track([{id: ID, path: disposable.session}]);
  assert.equal(watch.active, false); assert.deepEqual(await released, [ID]); watch.close();
});
