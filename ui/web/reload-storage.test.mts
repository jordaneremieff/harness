import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { deleteReloadState, readReloadState, writeReloadState } from './reload-storage.ts';
import { Database, Factory, Transaction } from './reload-storage.fixture.mts';

const KEY = 'b78941dc-8f7b-4b6c-8825-956eb653e21d';
const OTHER = '87c64fc3-605a-48e5-a489-beeaeb2267d3';
const signal = () => new AbortController().signal;
const flush = async () => {for (let index = 0; index < 8; index++) await Promise.resolve();};

function fixture(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'); const factory = new Factory();
  Object.defineProperty(globalThis, 'indexedDB', {configurable: true, value: factory});
  t.after(() => {if (original) Object.defineProperty(globalThis, 'indexedDB', original); else Reflect.deleteProperty(globalThis, 'indexedDB');});
  return factory;
}

test('File and Blob payloads reach the store with bytes and metadata intact across separate connections', async t => {
  const f = fixture(t), bytes = new Uint8Array([0, 255, 13, 10, 128]);
  const file = new File([bytes], 'notes.dat', {type: 'application/octet-stream', lastModified: 1234});
  const blob = new Blob([bytes], {type: 'application/x-fixture'});
  const input = {file, nested: [blob, null, undefined, true, 7n, NaN, Infinity, -0]};
  await writeReloadState(KEY, input, signal());
  const output = await readReloadState(KEY, signal()) as typeof input;
  assert.notEqual(output, input); assert.ok(output.file instanceof File); assert.notEqual(output.file, file);
  assert.equal(output.file.name, file.name); assert.equal(output.file.type, file.type); assert.equal(output.file.lastModified, 1234);
  assert.deepEqual(new Uint8Array(await output.file.arrayBuffer()), bytes);
  const savedBlob = output.nested[0]; assert.ok(savedBlob instanceof Blob); assert.equal(savedBlob.type, blob.type);
  assert.deepEqual(new Uint8Array(await savedBlob.arrayBuffer()), bytes);
  assert.deepEqual(output.nested.slice(1), input.nested.slice(1));
  assert.equal(f.databases.length, 2); assert.ok(f.databases.every(db => db.closes === 1));
});
test('writes detach mutable metadata before open and preserve shared references without accepting cycles', async t => {
  const f = fixture(t); f.holdOpen = true;
  const shared = {text: 'before'}, value = {first: shared, second: shared};
  const writing = writeReloadState(KEY, value, signal()); shared.text = 'after';
  f.finishOpen(f.opens[0]); await writing; f.holdOpen = false;
  const output = await readReloadState(KEY, signal()) as typeof value;
  assert.equal(output.first.text, 'before'); assert.equal(output.first, output.second);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  await assert.rejects(writeReloadState(KEY, cycle, signal()), /cycle/);
});
test('success events do not resolve writes, reads or deletes before transaction completion', async t => {
  const f = fixture(t); f.automatic = false;
  let settled = false; const writing = writeReloadState(KEY, 'saved', signal()).then(() => {settled = true;});
  await flush(); f.latest().success(); await flush(); assert.equal(settled, false); assert.equal(f.records.has(KEY), false);
  f.latest().commit(); await writing; assert.equal(f.records.get(KEY), 'saved');
  settled = false; const reading = readReloadState(KEY, signal()).then(value => {settled = true; return value;});
  await flush(); f.latest().success(); await flush(); assert.equal(settled, false); f.latest().commit(); assert.equal(await reading, 'saved');
  settled = false; const deleting = deleteReloadState(KEY).then(() => {settled = true;});
  await flush(); f.latest().success(); await flush(); assert.equal(settled, false); assert.equal(f.records.get(KEY), 'saved');
  f.latest().commit(); await deleting; assert.equal(f.records.has(KEY), false);
});
test('abort after request success rolls back only the pending write and preserves prior bytes', async t => {
  const f = fixture(t); await writeReloadState(KEY, new Blob(['prior']), signal()); f.automatic = false;
  const controller = new AbortController(); const writing = writeReloadState(KEY, new Blob(['replacement']), controller.signal);
  await flush(); const tx = f.latest(); tx.success(); controller.abort();
  await assert.rejects(writing, {name: 'AbortError'}); assert.equal(tx.aborts, 1); tx.commit();
  f.automatic = true; const prior = await readReloadState(KEY, signal()); assert.ok(prior instanceof Blob); assert.equal(await prior.text(), 'prior');
  assert.equal(f.transactions.filter(item => item.operation?.kind === 'delete').length, 0);
});
test('abort before open or while open is pending creates no write, closes late connections and leaves committed data', async t => {
  const f = fixture(t); f.records.set(KEY, 'prior'); const controller = new AbortController(); controller.abort();
  await assert.rejects(writeReloadState(KEY, 'next', controller.signal), {name: 'AbortError'});
  await assert.rejects(readReloadState(KEY, controller.signal), {name: 'AbortError'}); assert.equal(f.opens.length, 0);
  f.holdOpen = true; const pending = new AbortController(), reason = new Error('cancel open');
  const writing = writeReloadState(KEY, 'next', pending.signal); pending.abort(reason); await assert.rejects(writing, error => error === reason);
  f.finishOpen(f.opens[0]); await flush(); assert.equal(f.databases[0].closes, 1); assert.equal(f.transactions.length, 0); assert.equal(f.records.get(KEY), 'prior');
});
test('read cancellation aborts its transaction and an abort after commit does not undo the committed write', async t => {
  const f = fixture(t); f.records.set(KEY, 'prior'); f.automatic = false;
  const controller = new AbortController(), reading = readReloadState(KEY, controller.signal);
  await flush(); f.latest().success(); controller.abort(); await assert.rejects(reading, {name: 'AbortError'}); assert.equal(f.latest().aborts, 1);
  const committed = new AbortController(), writing = writeReloadState(KEY, 'new', committed.signal);
  await flush(); f.latest().commit(); committed.abort(); await writing; assert.equal(f.records.get(KEY), 'new');
});
test('request errors, commit refusal, synchronous issue errors and open errors retain the prior record', async t => {
  const f = fixture(t); f.records.set(KEY, 'prior'); f.automatic = false;
  const requestError = new Error('request refused'), writing = writeReloadState(KEY, 'new', signal());
  await flush(); f.latest().fail(requestError); await assert.rejects(writing, error => error === requestError);
  f.automatic = true; f.commitFailure = new Error('quota');
  await assert.rejects(writeReloadState(KEY, 'new', signal()), /quota/); await assert.rejects(deleteReloadState(KEY), /quota/);
  f.commitFailure = undefined; f.issueFailure = new Error('clone refused'); await assert.rejects(writeReloadState(KEY, 'new', signal()), /clone refused/);
  assert.equal(f.latest().aborts, 1); f.issueFailure = undefined; f.openFailure = new Error('storage denied');
  await assert.rejects(writeReloadState(KEY, 'new', signal()), /storage denied/); await assert.rejects(readReloadState(KEY, signal()), /storage denied/);
  assert.equal(f.records.get(KEY), 'prior'); assert.ok(f.databases.every(db => db.closes === 1));
});
test('missing reads return undefined and deletion touches only the caller UUID', async t => {
  const f = fixture(t); assert.equal(await readReloadState(KEY, signal()), undefined);
  await writeReloadState(KEY, {value: 1}, signal()); await writeReloadState(OTHER, 'other', signal());
  await deleteReloadState(KEY); await deleteReloadState(KEY);
  assert.equal(await readReloadState(KEY, signal()), undefined); assert.equal(await readReloadState(OTHER, signal()), 'other');
  const nullPrototype = Object.assign(Object.create(null), {text: 'plain'}); await writeReloadState(KEY, nullPrototype, signal());
  assert.deepEqual(await readReloadState(KEY, signal()), {text: 'plain'}); assert.equal(f.records.size, 2);
});
test('malformed UUID keys never open storage', async t => {
  const f = fixture(t);
  for (const key of ['', '../state', '/tmp/state', `${KEY}/child`, KEY.replaceAll('-', ''), `${KEY}\n`, 'g'.repeat(36)]) {
    await assert.rejects(writeReloadState(key, {}, signal()), /UUID/); await assert.rejects(readReloadState(key, signal()), /UUID/); await assert.rejects(deleteReloadState(key), /UUID/);
  }
  assert.equal(f.opens.length, 0); await writeReloadState(KEY.toUpperCase(), 'uppercase', signal());
});
test('unsupported objects, accessors and symbols fail without replacing a committed record', async t => {
  const f = fixture(t); f.records.set(KEY, 'prior'); let accessed = false;
  const accessor = {get text() {accessed = true; return 'hidden';}};
  for (const value of [new Date(), new Map(), new Set(), new Uint8Array(1), new Error('unsupported'), () => {}, Symbol(), {bad: Symbol()}, accessor,
    {[Symbol('key')]: 1}, Object.defineProperty({}, 'hidden', {value: 1}), Object.create({custom: true}), new class Payload {}()]) {
    await assert.rejects(writeReloadState(KEY, value, signal()), /unsupported|plain|data properties/);
  }
  assert.equal(accessed, false); assert.equal(f.opens.length, 0); assert.equal(f.records.get(KEY), 'prior');
});
test('node bounds include sparse slots and pending descendants, with iterative deep traversal', async t => {
  const f = fixture(t); await writeReloadState(KEY, new Array(4095), signal());
  const before = f.opens.length; await assert.rejects(writeReloadState(KEY, new Array(4096), signal()), /4096 nodes/);
  const shared = {child: new Array(2048).fill(1)}; await assert.rejects(writeReloadState(KEY, [shared, new Array(2048).fill(1)], signal()), /4096 nodes/);
  let deep: unknown = null; for (let index = 0; index < 4096; index++) deep = {next: deep};
  await assert.rejects(writeReloadState(KEY, deep, signal()), /4096 nodes/); assert.equal(f.opens.length, before);
  f.holdOpen = true; const controller = new AbortController(); deep = null;
  for (let index = 0; index < 4095; index++) deep = {next: deep};
  const writing = writeReloadState(KEY, deep, controller.signal); assert.equal(f.opens.length, before + 1);
  controller.abort(); await assert.rejects(writing, {name: 'AbortError'});
  const opening = f.opens.at(-1); assert.ok(opening); f.finishOpen(opening);
});
test('metadata bounds include UTF-8 values, keys and File metadata; binary bounds aggregate all files', async t => {
  const f = fixture(t), maximum = 4 * 1024 * 1024;
  await writeReloadState(KEY, 'x'.repeat(maximum - 8), signal()); const before = f.opens.length;
  for (const value of ['x'.repeat(maximum - 7), 'é'.repeat(maximum / 2), {['x'.repeat(maximum)]: 1}, new File([], 'x'.repeat(maximum))]) {
    await assert.rejects(writeReloadState(KEY, value, signal()), /4 MiB/);
  }
  assert.equal(f.opens.length, before);
  const binary = new Blob([new Uint8Array(32 * 1024 * 1024)]); await writeReloadState(KEY, binary, signal());
  const opens = f.opens.length;
  await assert.rejects(writeReloadState(KEY, [binary, new File(['!'], 'extra')], signal()), /32 MiB/);
  assert.equal(f.opens.length, opens);
  Object.defineProperty(binary, 'size', {value: 0}); await assert.rejects(writeReloadState(KEY, [binary, new Blob(['!'])], signal()), /32 MiB/);
});
test('malformed stored payload fails its read without deletion', async t => {
  const f = fixture(t); f.records.set(KEY, new Map());
  // Inject a malformed native result directly; the double normally clones only the supported payload domain.
  f.automatic = false; const reading = readReloadState(KEY, signal()); await flush();
  const tx = f.latest(); tx.succeeded = true; tx.request.result = new Map(); tx.request.onsuccess?.();
  await assert.rejects(reading, /plain/); assert.equal(tx.aborts, 1); assert.ok(f.records.get(KEY) instanceof Map);
});
test('abort during initial schema creation aborts the upgrade transaction and closes a late connection', async t => {
  const f = fixture(t); f.holdOpen = true; const controller = new AbortController();
  const writing = writeReloadState(KEY, 'value', controller.signal), request = f.opens[0], upgrade = new Transaction(f, 'versionchange');
  request.result = new Database(f); request.transaction = upgrade; request.onupgradeneeded?.();
  controller.abort(); await assert.rejects(writing, {name: 'AbortError'}); assert.equal(upgrade.aborts, 1);
  f.finishOpen(request); assert.equal(f.databases[0].closes, 1); assert.equal(f.transactions.length, 0);
});
test('blocked open rejects and closes a late connection; initial upgrade creates only one store', async t => {
  const f = fixture(t); f.holdOpen = true;
  const reading = readReloadState(KEY, signal()), request = f.opens[0]; request.onblocked?.(); await assert.rejects(reading, /blocked/);
  f.finishOpen(request); assert.equal(f.databases[0].closes, 1);
  const writing = writeReloadState(KEY, 'saved', signal()), upgrade = f.opens[1]; const database = new Database(f); upgrade.result = database;
  upgrade.onupgradeneeded?.(); assert.equal(f.created, 1); upgrade.onsuccess?.(); await writing;
});
