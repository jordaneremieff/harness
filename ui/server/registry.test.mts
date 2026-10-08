import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import type { AgentServiceOptions, CatalogPage, CatalogRow } from '../agents/index.mts';
import { RpcClient } from '../rpc/client.mts';
import { PrimarySession, type PrimarySessionOptions } from '../rpc/session.mts';
import { LIMITS, type PrimaryView } from '../shared/api.ts';
import { Registry, type AgentAdapter, type RegistryOptions } from './registry.mts';
import { StateStore } from './state.mts';

const empty: CatalogPage = {rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false, scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}};
function fakeAgents() {
  const forbidden = async (): Promise<never> => { throw new Error('No native work in a registry fixture'); };
  const adapter: AgentAdapter = {roster: () => empty, rosterRow: () => undefined, refresh: forbidden, select: forbidden, reconnect: forbidden, history: forbidden, inspect: forbidden,
    submit: forbidden, retrySubmit: forbidden, abort: forbidden, configure: () => { throw new Error('No native configuration'); },
    hide: async () => {}, disconnectWorkspace: async () => {}, close: async () => {}};
  return () => adapter;
}
class Primary extends PrimarySession {
  private counts: {started: number; closed: number};
  constructor(privateOptions: PrimarySessionOptions, counts: {started: number; closed: number}) {
    super(privateOptions); this.counts = counts; this.view.sessionFile = privateOptions.sessionFile;
  }
  override async start() { this.counts.started++; this.view.lifecycle = 'ready'; this.view.activity = 'idle'; }
  override async close() { this.counts.closed++; this.view.lifecycle = 'stopped'; }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}
class WriterClient extends RpcClient {
  actualExited = false;
  override get exited() { return this.actualExited; }
}
class WriterPrimary extends Primary {
  override readonly client: WriterClient;
  rejectClose = false;
  private supplied: PrimarySessionOptions;
  constructor(supplied: PrimarySessionOptions, counts: {started: number; closed: number}) {
    super(supplied, counts); this.supplied = supplied; this.client = new WriterClient(supplied);
  }
  override async start() {
    await super.start();
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    const stdio: NonNullable<WriterClient['child']>['stdio'] = [stdin, stdout, stderr, undefined, undefined];
    this.client.child = Object.assign(new ChildProcess(), {stdin, stdout, stderr, stdio});
    this.view.lifecycle = 'failed';
    this.supplied.publish('primary.state', this.target, this.view);
  }
  actualExit() {
    this.client.actualExited = true; this.view.lifecycle = 'stopped';
    this.supplied.publish('primary.state', this.target, this.view);
  }
  override async close() {
    if (this.rejectClose) throw new Error('The fake child still owns its writer');
    this.actualExit(); await super.close();
  }
}
async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-registry-')); const cwd = join(root, 'project'); await mkdir(cwd); await mkdir(join(cwd, 'nested'));
  const counts = {started: 0, closed: 0}; const options: RegistryOptions = {stateDir: join(root, 'state'), cwd, executable: 'fixture-unused', agentStore: join(root, 'no-catalog'),
    agents: fakeAgents(), primary: supplied => new Primary(supplied, counts)};
  const registries: Registry[] = []; const open = async () => { const registry = await Registry.open(options); registries.push(registry); return registry; };
  context.after(async () => { for (const registry of registries) await registry.close(); await rm(root, {recursive: true, force: true}); });
  return {cwd, counts, options, open};
}

test('registry restart restores stopped records, drafts, and workspace without spawning', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const workspace = await registry.store.workspace();
  const key = await registry.openPrimary(setup.cwd); const primary = registry.primary(key); assert.equal(setup.counts.started, 1);
  primary.view.pid = 123; primary.view.activity = 'running'; primary.view.pendingDialogs = [{id: 'pending', method: 'confirm', title: 'Pending'}];
  await registry.store.updateSelection(workspace.id, {expectedRevision: workspace.revision, primaryKey: key, selectedTarget: primary.target});
  const target = await registry.store.target(workspace.id, primary.target);
  await registry.store.putDraft(workspace.id, target.targetKey, {expectedRevision: 0, text: 'retained draft', mode: 'prompt'});
  await registry.store.savePrimaries(registry.views()); const boot = registry.journal.bootId; await registry.close();
  const restarted = await setup.open(); assert.equal(setup.counts.started, 1); assert.equal(restarted.sessions.size, 0); assert.notEqual(restarted.journal.bootId, boot);
  const snapshot = await restarted.snapshot(workspace.id); const view = snapshot.primaries[0]; assert.ok(view);
  assert.equal(view.key, key); assert.equal(view.lifecycle, 'stopped'); assert.equal(view.activity, 'unknown'); assert.equal(view.pid, undefined);
  assert.deepEqual(view.pendingDialogs, []); assert.equal(view.capabilities.input, false); assert.equal(view.lastError?.code, 'not_ready');
  assert.equal(snapshot.workspace.selectedTarget?.kind, 'primary'); assert.equal(snapshot.targets?.[0]?.draft.text, 'retained draft');
  assert.throws(() => restarted.primary(key), {code: 'not_ready', status: 503});
});

test('canonical session aliases reject a second backend writer and release after shutdown', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const file = join(setup.cwd, 'session.jsonl'); await writeFile(file, '{}\n');
  const canonical = await registry.validatePath(file, false);
  const alias = await registry.validatePath(`${setup.cwd}/nested/../session.jsonl`, false); assert.equal(alias, canonical);
  const key = await registry.openPrimary(setup.cwd, canonical); assert.equal(setup.counts.started, 1);
  await assert.rejects(registry.openPrimary(setup.cwd, alias), {code: 'operation_conflict', status: 409});
  assert.equal(registry.sessions.size, 1); assert.equal(registry.primary(key).view.sessionFile, canonical); assert.equal(setup.counts.started, 1);
  await registry.close(); const restarted = await setup.open(); await restarted.openPrimary(setup.cwd, alias);
  assert.equal(setup.counts.started, 2);
});

test('an auto-new primary excludes a saved open through its raw child-reported canonical alias', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open();
  const file = join(setup.cwd, 'saved.jsonl'); await writeFile(file, '{}\n');
  const key = await registry.openPrimary(setup.cwd);
  const primary = registry.primary(key); assert.equal(primary.view.sessionFile, undefined);
  primary.view.sessionFile = `${setup.cwd}/nested/../saved.jsonl`;
  const canonical = await registry.validatePath(file, false);
  assert.notEqual(primary.view.sessionFile, canonical);
  await assert.rejects(registry.openPrimary(setup.cwd, canonical), {code: 'operation_conflict', status: 409});
  assert.equal(setup.counts.started, 1); assert.equal(registry.sessions.size, 1); assert.equal(registry.saved.size, 1);
  await primary.close(); registry.publish('primary.state', primary.target, primary.view);
  await registry.openPrimary(setup.cwd, canonical); assert.equal(setup.counts.started, 2);
});

test('concurrent saved opens recheck capacity after canonical writer claims', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open();
  const paths = await Promise.all(Array.from({length: LIMITS.primaries + 1}, async (_, index) => {
    const file = join(setup.cwd, `session-${index}.jsonl`); await writeFile(file, '{}\n');
    return registry.validatePath(file, false);
  }));
  const arrived = deferred(); const release = deferred(); context.after(() => release.resolve());
  const claimPath = registry.claimPath.bind(registry); let claims = 0;
  context.mock.method(registry, 'claimPath', async (path: string, key: string) => {
    await claimPath(path, key); claims++; if (claims === paths.length) arrived.resolve();
    await release.promise;
  });
  const opens = paths.map(path => registry.openPrimary(setup.cwd, path));
  const outcomes = Promise.allSettled(opens);
  try {
    await arrived.promise;
    assert.equal(setup.counts.started, 0); assert.equal(registry.sessions.size, 0); assert.equal(registry.saved.size, 0);
  } finally { release.resolve(); }
  const results = await outcomes;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, LIMITS.primaries);
  const rejected = results.filter(result => result.status === 'rejected'); assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reason.code, 'capacity'); assert.equal(rejected[0]?.reason.status, 429);
  assert.equal(setup.counts.started, LIMITS.primaries); assert.equal(registry.sessions.size, LIMITS.primaries);
  assert.equal(registry.saved.size, LIMITS.primaries);
  const failedPath = paths[results.findIndex(result => result.status === 'rejected')]; assert.ok(failedPath);
  await claimPath(failedPath, 'released-reservation'); registry.releasePath(failedPath, 'released-reservation');
});

test('failed lifecycle retains canonical writer exclusion and capacity until actual exit', {timeout: 10000}, async context => {
  const setup = await fixture(context); const writers: WriterPrimary[] = [];
  setup.options.primary = supplied => { const writer = new WriterPrimary(supplied, setup.counts); writers.push(writer); return writer; };
  const registry = await setup.open(); const file = join(setup.cwd, 'owned.jsonl'); await writeFile(file, '{}\n');
  const firstKey = await registry.openPrimary(setup.cwd); const first = writers[0]; assert.ok(first);
  first.view.sessionFile = `${setup.cwd}/nested/../owned.jsonl`;
  const canonical = await registry.validatePath(file, false);
  assert.equal(first.view.lifecycle, 'failed'); assert.ok(first.client.child); assert.equal(first.client.exited, false);
  await assert.rejects(registry.openPrimary(setup.cwd, canonical), {code: 'operation_conflict', status: 409});
  assert.equal(setup.counts.started, 1);
  for (let index = 1; index < LIMITS.primaries; index++) await registry.openPrimary(setup.cwd);
  assert.ok(writers.every(writer => writer.view.lifecycle === 'failed' && writer.client.child && !writer.client.exited));
  await assert.rejects(registry.openPrimary(setup.cwd), {code: 'capacity', status: 429});
  assert.equal(setup.counts.started, LIMITS.primaries);
  first.actualExit(); assert.equal(registry.primary(firstKey).client.exited, true);
  await registry.openPrimary(setup.cwd, canonical); assert.equal(setup.counts.started, LIMITS.primaries + 1);
});

test('shutdown retains the StateStore lock after close rejection until the actual writer exits', {timeout: 10000}, async context => {
  const setup = await fixture(context); const writers: WriterPrimary[] = [];
  setup.options.primary = supplied => { const writer = new WriterPrimary(supplied, setup.counts); writers.push(writer); return writer; };
  const registry = await setup.open(); await registry.openPrimary(setup.cwd); const writer = writers[0]; assert.ok(writer);
  writer.rejectClose = true; const finalized = deferred(); const closeState = registry.store.close.bind(registry.store);
  const closeStore = context.mock.method(registry.store, 'close', async () => { await closeState(); finalized.resolve(); });
  try {
    await assert.rejects(registry.close(), {code: 'not_ready', status: 503});
    assert.equal(writer.view.lifecycle, 'failed'); assert.ok(writer.client.child); assert.equal(writer.client.exited, false);
    await assert.rejects(StateStore.open(setup.options.stateDir), {code: 'not_ready', status: 503, message: 'State root already has an owner'});
    await assert.rejects(registry.openPrimary(setup.cwd), {code: 'not_ready', status: 503});
    assert.equal(setup.counts.started, 1); assert.equal(closeStore.mock.callCount(), 0);
  } finally { writer.actualExit(); await finalized.promise; }
  assert.equal(closeStore.mock.callCount(), 1);
  const next = await StateStore.open(setup.options.stateDir);
  try { assert.equal((await next.readPrimaries())[0]?.lifecycle, 'stopped'); } finally { await next.close(); }
});

test('shutdown awaits a pending saved open before releasing the StateStore lock and never starts it', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open();
  const file = join(setup.cwd, 'pending.jsonl'); await writeFile(file, '{}\n');
  const canonical = await registry.validatePath(file, false); const entered = deferred(); const release = deferred();
  context.after(() => release.resolve()); const savePrimaries = registry.store.savePrimaries.bind(registry.store);
  context.mock.method(registry.store, 'savePrimaries', async (views: PrimaryView[]) => {
    entered.resolve(); await release.promise; await savePrimaries(views);
  });
  const closeStore = context.mock.method(registry.store, 'close', registry.store.close.bind(registry.store));
  const pending = registry.openPrimary(setup.cwd, canonical); const rejected = assert.rejects(pending, {code: 'not_ready', status: 503});
  await entered.promise; assert.equal(registry.sessions.size, 1); assert.equal(setup.counts.started, 0);
  let closed = false; const closing = registry.close().then(() => { closed = true; });
  try {
    await assert.rejects(StateStore.open(setup.options.stateDir), {code: 'not_ready', status: 503, message: 'State root already has an owner'});
    assert.equal(closed, false); assert.equal(closeStore.mock.callCount(), 0); assert.equal(setup.counts.closed, 0);
  } finally { release.resolve(); await rejected; await closing; }
  assert.equal(closed, true); assert.equal(closeStore.mock.callCount(), 1);
  assert.equal(setup.counts.started, 0); assert.equal(setup.counts.closed, 0);
  assert.equal(registry.sessions.size, 0); assert.equal(registry.saved.size, 0);
  const next = await StateStore.open(setup.options.stateDir);
  try { assert.deepEqual(await next.readPrimaries(), []); } finally { await next.close(); }
});

test('selected agent metadata comes from the exact cache lookup beyond the first roster page', {timeout: 10000}, async context => {
  const setup = await fixture(context);
  const rows: CatalogRow[] = Array.from({length: 30}, (_, i) => ({id: `storage:conversation-${i}`, storageId: 'storage', cwd: setup.cwd,
    modifiedAt: i, owner: 'unknown', state: 'idle', cost: 0, partial: false, claim: 'absent', name: `Agent ${i}`, latestReply: `Reply ${i}`}));
  const cached = new Map(rows.map(row => [row.id, row])); const selected = rows[25]; assert.ok(selected);
  const page: CatalogPage = {...empty, rows: rows.slice(0, 20), nextCursor: 'actual-page-cursor'};
  const inert = fakeAgents()(); const lookups: string[] = [];
  setup.options.agents = () => ({...inert, roster: options => { assert.equal(options?.limit, 20); return page; },
    rosterRow: identity => { lookups.push(identity); return structuredClone(cached.get(identity)); }});
  const registry = await setup.open(); const workspace = await registry.store.workspace();
  await registry.store.updateSelection(workspace.id, {expectedRevision: workspace.revision, selectedTarget: {kind: 'agent', identity: selected.id}});
  const snapshot = await registry.snapshot(workspace.id);
  assert.deepEqual(lookups, [selected.id]); assert.equal(snapshot.selectedAgent?.identity, selected.id);
  assert.equal(snapshot.selectedAgent?.cwd, selected.cwd); assert.equal(snapshot.selectedAgent?.name, selected.name);
  assert.equal(snapshot.selectedAgent?.latestReply, selected.latestReply);
  assert.deepEqual(snapshot.roster.rows.map(row => row.identity), page.rows.map(row => row.id));
  assert.ok(!snapshot.roster.rows.some(row => row.identity === selected.id)); assert.equal(snapshot.roster.nextCursor, 'actual-page-cursor');
  assert.equal(setup.counts.started, 0);
});

test('negotiated selected-agent capabilities survive a snapshot cut and remain scoped to workspace and identity', {timeout: 10000}, async context => {
  const setup = await fixture(context); const factoryOptions: AgentServiceOptions[] = [];
  const rows: CatalogRow[] = Array.from({length: 2}, (_, i) => ({id: `storage:agent-${i}`, storageId: 'storage', cwd: setup.cwd,
    modifiedAt: i, owner: 'here', state: 'idle', cost: 0, partial: false, claim: 'live'}));
  const selected = rows[0]; const otherIdentity = rows[1]; assert.ok(selected && otherIdentity);
  assert.ok(!('capabilities' in selected)); const cached = new Map(rows.map(row => [row.id, row])); const inert = fakeAgents()();
  setup.options.agents = options => { factoryOptions.push(options); return {...inert, roster: () => ({...empty, rows}), rosterRow: identity => structuredClone(cached.get(identity))}; };
  const registry = await setup.open(); const workspace = await registry.store.workspace(); const unrelated = await registry.store.createWorkspace();
  for (const current of [workspace, unrelated]) await registry.store.updateSelection(current.id, {expectedRevision: current.revision, selectedTarget: {kind: 'agent', identity: selected.id}});
  const before = await registry.snapshot(workspace.id); assert.ok(before.selectedAgent); assert.notEqual(before.selectedAgent.capabilities?.input, true);
  const emit = factoryOptions[0]?.onAvailability; assert.ok(emit);
  emit(workspace.id, selected.id, 'live', undefined, {snapshot: true, 'observe-open': true, 'observe-frame': true, 'observe-close': true, 'task-submit': true, abort: true});
  const cut = registry.journal.cursor; const active = await registry.snapshot(workspace.id);
  assert.equal(active.cursor, cut); assert.equal(active.selectedAgent?.identity, selected.id); assert.equal(active.selectedAgent?.availability, 'live');
  assert.equal(active.selectedAgent?.capabilities?.input, true); assert.equal(active.selectedAgent?.capabilities?.observe, true); assert.equal(active.selectedAgent?.capabilities?.abort, true);
  assert.deepEqual(registry.journal.replay(active.cursor, workspace.id).records, []);
  const separate = await registry.snapshot(unrelated.id); assert.ok(separate.selectedAgent); assert.notEqual(separate.selectedAgent.capabilities?.input, true);
  const current = await registry.store.workspace(workspace.id);
  await registry.store.updateSelection(workspace.id, {expectedRevision: current.revision, selectedTarget: {kind: 'agent', identity: otherIdentity.id}});
  const changed = await registry.snapshot(workspace.id); assert.equal(changed.selectedAgent?.identity, otherIdentity.id); assert.notEqual(changed.selectedAgent?.capabilities?.input, true);
  assert.equal(setup.counts.started, 0);
});

test('registry validates path kind and refuses stale epochs without a primary effect', {timeout: 10000}, async context => {
  const setup = await fixture(context); const registry = await setup.open(); const file = join(setup.cwd, 'session.jsonl'); await writeFile(file, '{}\n');
  await assert.rejects(registry.validatePath('relative', true), {code: 'invalid_request'});
  await assert.rejects(registry.validatePath(file, true), {code: 'invalid_request'});
  await assert.rejects(registry.validatePath(setup.cwd, false), {code: 'invalid_request'});
  await assert.rejects(registry.validatePath(join(setup.cwd, 'missing'), false), {code: 'invalid_request'});
  const key = await registry.openPrimary(setup.cwd); const primary = registry.primary(key); const before: PrimaryView = structuredClone(primary.view);
  assert.throws(() => registry.primary(key, primary.view.epoch + 1, true), {code: 'stale_epoch', status: 409});
  assert.deepEqual(primary.view, before); assert.equal(setup.counts.started, 1);
  await registry.close(); await assert.rejects(registry.openPrimary(setup.cwd), {code: 'not_ready'}); assert.equal(setup.counts.started, 1);
});
