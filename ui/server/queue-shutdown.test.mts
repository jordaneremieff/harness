import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {FakeChild} from '../rpc/fake-child.mts';
import {PrimarySession} from '../rpc/session.mts';
import type {CatalogPage} from '../agents/index.mts';
import type {AgentAdapter} from './registry.mts';
import {main, startBackend} from './backend.mts';
import {StateStore, type OperationRecord} from './state.mts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
const empty: CatalogPage = {rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false,
  scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}};
const forbidden = async (): Promise<never> => {throw new Error('No native agent work belongs in this fixture');};
const agents: AgentAdapter = {roster: () => empty, rosterRow: () => undefined, imageInputAvailable: () => false,
  refresh: async () => empty.scan, prepare: forbidden, select: forbidden, reconnect: forbidden, history: forbidden,
  image: forbidden, inspect: forbidden, inventory: forbidden, command: forbidden, threads: forbidden, thread: forbidden, submit: forbidden, retrySubmit: forbidden, abort: forbidden,
  configure: () => {throw new Error('No native agent configuration');}, hide: async () => {}, disconnectWorkspace: async () => {}, close: async () => {}};

async function fixture(t: TestContext, response: unknown, cli = false) {
  const root = await mkdtemp(join(tmpdir(), 'ui-queue-shutdown-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const stateDir = join(root, 'state'); const child = new FakeChild(); const ready = deferred();
  child.pendingMessageCount = 4;
  child.onCommand = record => record.type === 'clear_queue' ? child.response(record, response) : child.defaults(record);
  const launch: typeof startBackend = cli ? (_options, injection) => main([
    '--cwd', cwd, '--state-dir', stateDir, '--pi', 'unused', '--port', '0',
  ], async () => {}, injection) : startBackend;
  const app = await launch({cwd, stateDir, pi: 'unused', port: 0}, {
    assets: new Map([['/', {type: 'text/html', data: Buffer.from('<title>Fixture</title>')}]]), agents: () => agents,
    primary: options => {
      const session = new PrimarySession({...options, spawnChild: child.spawn});
      const start = session.start.bind(session);
      session.start = async () => {await start(); ready.resolve();};
      return session;
    },
  });
  const {registry} = app;
  t.after(async () => {
    child.exit(0);
    await app.close().catch(() => {});
    // An intentionally malformed result remains unresolved; dispose only this private fixture.
    await registry.store.close(); await rm(root, {recursive: true, force: true});
  });
  const workspace = await registry.store.workspace();
  const key = await registry.openPrimary(cwd, undefined, workspace.id); await ready.promise;
  const session = registry.primary(key); const target = await registry.store.target(workspace.id, session.target);
  const ids: string[] = [];
  const begin = registry.operations.beginQueueClear.bind(registry.operations);
  t.mock.method(registry.operations, 'beginQueueClear', async (...args: Parameters<typeof begin>) => {
    const id = await begin(...args); ids.push(id); return id;
  });
  const attempts: {id: string; queue: {steering: string[]; followUp: string[]}}[] = [];
  const retain = registry.operations.retainQueue.bind(registry.operations);
  t.mock.method(registry.operations, 'retainQueue', async (id: string, queue: {steering: string[]; followUp: string[]}) => {
    attempts.push({id, queue: structuredClone(queue)}); await retain(id, queue);
  });
  const closeStore = registry.store.close.bind(registry.store);
  const closed = t.mock.method(registry.store, 'close', closeStore);
  return {app, registry, child, session, workspace: workspace.id, targetKey: target.targetKey, stateDir, ids, attempts, closed, closeStore};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function assertStorageOwned(f: Fixture) {
  assert.equal(f.closed.mock.callCount(), 0);
  await assert.rejects(StateStore.open(f.stateDir), {code: 'not_ready', message: 'State root already has an owner'});
  const target = await f.registry.store.getTarget(f.workspace, f.targetKey);
  await f.registry.store.putDraft(f.workspace, f.targetKey, {expectedRevision: target.draft.revision, text: 'store remains usable', mode: 'prompt'});
}
const returned = {steering: ['', 'native-only retained text', 'native-only retained text'], followUp: ['last']};

for (const exitPoint of ['before-close', 'after-rejected-close', 'during-persistence'] as const) {
  test(`shutdown retains queue storage through child exit ${exitPoint} and retries the original rows`, {timeout: 15000}, async t => {
    let refuse = true; const entered = deferred(); const release = deferred();
    t.after(() => release.resolve());
    const f = await fixture(t, returned);
    const write = f.registry.store.writeOperation.bind(f.registry.store);
    t.mock.method(f.registry.store, 'writeOperation', async (record: OperationRecord) => {
      if (record.queueRecovery && refuse) {
        entered.resolve(); if (exitPoint === 'during-persistence') await release.promise;
        throw new Error('queue row persistence refused');
      }
      await write(record);
    });
    const stop = f.session.stop(); const rejected = assert.rejects(stop, /queue row persistence refused/);
    await entered.promise;
    if (exitPoint === 'during-persistence') {
      f.child.exit(1); assert.equal(f.closed.mock.callCount(), 0);
      await assert.rejects(StateStore.open(f.stateDir), {code: 'not_ready', message: 'State root already has an owner'});
      release.resolve();
    }
    await rejected;
    const id = f.ids[0]; assert.ok(id);
    assert.deepEqual(f.session.returnedQueueRecovery, {clearOperationId: id, response: returned});
    assert.equal(f.registry.store.record(id).queueClear?.phase, 'uncertain');
    assert.equal((await f.registry.store.getTarget(f.workspace, f.targetKey)).unconfirmed.length, 0);
    if (exitPoint === 'after-rejected-close') {
      await assert.rejects(f.registry.close(), {code: 'not_ready'});
      await assertStorageOwned(f); f.child.exit(1);
    } else f.child.exit(1);
    await assert.rejects(f.registry.close(), {code: 'not_ready'});
    await assertStorageOwned(f);
    assert.equal(f.session.queueRecoveryPending, true);
    refuse = false;
    const writes = t.mock.method(f.registry.store, 'close', async () => {
      assert.equal(f.registry.store.record(id).queueClear?.phase, 'retained');
      assert.equal(f.session.queueRecoveryPending, false);
      await f.closeStore();
    });
    await f.registry.close(); assert.equal(writes.mock.callCount(), 1);
    assert.equal(f.ids.length, 1); assert.ok(f.attempts.length >= 3);
    assert.ok(f.attempts.every(attempt => attempt.id === id && JSON.stringify(attempt.queue) === JSON.stringify(returned)));
    assert.equal(f.child.writes.filter(record => record.type === 'clear_queue').length, 1);
    assert.equal(f.child.writes.some(record => record.type === 'abort'), false);
    const next = await StateStore.open(f.stateDir);
    try {
      assert.equal(next.record(id).queueClear?.phase, 'retained');
      const rows = (await next.getTarget(f.workspace, f.targetKey)).unconfirmed;
      assert.deepEqual(rows.map(row => [row.mode, row.queueRecovery?.index, row.text]).sort(), [
        ['steer', 0, ''], ['steer', 1, 'native-only retained text'], ['steer', 2, 'native-only retained text'], ['followUp', 0, 'last'],
      ].sort());
      assert.ok(rows.every(row => row.queueRecovery?.clearOperationId === id));
    } finally {await next.close();}
  });
}

test('backend close retries failed Registry queue persistence after the child exits', {timeout: 15000}, async t => {
  const f = await fixture(t, returned); let refuse = true;
  const write = f.registry.store.writeOperation.bind(f.registry.store);
  t.mock.method(f.registry.store, 'writeOperation', async (record: OperationRecord) => {
    if (record.queueRecovery && refuse) throw new Error('queue row persistence refused');
    await write(record);
  });
  const first = f.app.close(); assert.equal(f.app.close(), first);
  await assert.rejects(first, {code: 'not_ready'});
  f.child.exit(1); await assertStorageOwned(f);
  await assert.rejects(f.app.close(), {code: 'not_ready'}); await assertStorageOwned(f);
  refuse = false; await f.app.close();
  assert.equal(f.ids.length, 1); assert.equal(f.closed.mock.callCount(), 1);
  assert.ok(f.attempts.every(attempt => attempt.id === f.ids[0]));
  const next = await StateStore.open(f.stateDir);
  try {
    assert.equal(next.record(f.ids[0] ?? '').queueClear?.phase, 'retained');
    assert.equal((await next.getTarget(f.workspace, f.targetKey)).unconfirmed.length, 4);
  } finally {await next.close();}
});

test('the same shutdown signal retries queue persistence before it releases storage', {timeout: 15000}, async t => {
  const signals = new Map<string, () => void>();
  const on = process.on.bind(process), off = process.off.bind(process);
  t.mock.method(process, 'on', (event: string, listener: () => void) => {
    if (event === 'SIGINT' || event === 'SIGTERM') {signals.set(event, listener); return process;}
    return on(event, listener);
  });
  t.mock.method(process, 'off', (event: string, listener: () => void) => {
    if (event === 'SIGINT' || event === 'SIGTERM') {signals.delete(event); return process;}
    return off(event, listener);
  });
  const previousExitCode = process.exitCode; t.after(() => {process.exitCode = previousExitCode;});
  const refused = deferred(); const stderr = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (value: string | Uint8Array) => {
    if (String(value).includes('did not confirm an orderly primary exit')) {refused.resolve(); return true;}
    return stderr(value);
  });
  const f = await fixture(t, returned, true); let refuse = true;
  const write = f.registry.store.writeOperation.bind(f.registry.store);
  t.mock.method(f.registry.store, 'writeOperation', async (record: OperationRecord) => {
    if (record.queueRecovery && refuse) throw new Error('queue row persistence refused');
    await write(record);
  });
  const first = signals.get('SIGTERM'); assert.ok(first); first(); await refused.promise;
  assert.equal(signals.get('SIGTERM'), first); assert.equal(signals.size, 2);
  f.child.exit(1); await assertStorageOwned(f);
  refuse = false; const retry = signals.get('SIGTERM'); assert.ok(retry); retry(); await f.app.close();
  assert.equal(signals.size, 0); assert.equal(f.closed.mock.callCount(), 1); assert.equal(f.ids.length, 1);
  assert.ok(f.attempts.every(attempt => attempt.id === f.ids[0]));
  const next = await StateStore.open(f.stateDir);
  try {assert.equal(next.record(f.ids[0] ?? '').queueClear?.phase, 'retained');} finally {await next.close();}
});

test('malformed returned queue keeps its original identity and positions across Stop, handoff and close', {timeout: 15000}, async t => {
  const raw = {steering: ['available native text', 42, '', 'available native text'], followUp: []};
  const f = await fixture(t, raw);
  await assert.rejects(f.session.stop(), {code: 'protocol_error', uncertain: true});
  const id = f.ids[0]; assert.ok(id);
  assert.deepEqual(f.session.returnedQueueRecovery, {clearOperationId: id, response: raw});
  for (const action of [() => f.session.stop(), () => f.session.handoff({epoch: f.session.target.epoch, mode: 'abort', clearQueue: true}), () => f.session.close()]) {
    await assert.rejects(action(), {code: 'protocol_error', uncertain: true});
    assert.deepEqual(f.session.returnedQueueRecovery, {clearOperationId: id, response: raw});
  }
  await assert.rejects(f.registry.close(), {code: 'not_ready'});
  f.child.exit(1);
  await assert.rejects(f.app.close(), {code: 'not_ready'});
  await assertStorageOwned(f);
  assert.equal(f.registry.store.record(id).queueClear?.phase, 'uncertain');
  assert.equal(f.registry.store.record(id).view.state, 'uncertain');
  assert.equal(f.session.queueRecoveryPending, true);
  assert.deepEqual(f.session.returnedQueueRecovery, {clearOperationId: id, response: raw});
  assert.equal(f.ids.length, 1); assert.deepEqual(f.attempts, []);
  assert.equal((await f.registry.store.getTarget(f.workspace, f.targetKey)).unconfirmed.length, 0);
  assert.equal(f.child.writes.filter(record => record.type === 'clear_queue').length, 1);
  assert.equal(f.child.writes.some(record => record.type === 'abort'), false);
  assert.equal(f.child.stdin.writableEnded, false);
});
