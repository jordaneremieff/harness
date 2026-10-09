import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ApiResult, Bootstrap, EventData, EventEnvelope, EventName, OperationKind, OperationView, Target } from '../shared/api.ts';
import { LIMITS } from '../shared/api.ts';
import type { CatalogPage } from '../agents/index.mts';
import { startBackend } from './main.mts';
import { ASSET_ENTRY_LIMIT, ASSET_FILE_BYTES, ASSET_TOTAL_BYTES, assetMap, type Asset } from './http.mts';
import { ApiError } from './errors.mts';
import type { AgentAdapter } from './registry.mts';

const executable = fileURLToPath(new URL('../rpc/fake-pi.mts', import.meta.url));
const empty: CatalogPage = {rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false, scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}};
function agents() {
  const counts = {refresh: 0, disconnect: 0, close: 0};
  let detached!: () => void; const disconnected = new Promise<void>(resolve => { detached = resolve; });
  const forbidden = async (): Promise<never> => { throw new Error('No native agent work belongs in this fixture'); };
  const adapter: AgentAdapter = {roster: () => empty, rosterRow: () => undefined, refresh: async () => { counts.refresh++; return empty.scan; },
    prepare: forbidden, select: forbidden, reconnect: forbidden, history: forbidden, inspect: forbidden, submit: forbidden, retrySubmit: forbidden, abort: forbidden,
    configure: () => { throw new Error('No native agent configuration'); }, hide: async () => {},
    disconnectWorkspace: async () => { counts.disconnect++; detached(); }, close: async () => { counts.close++; }};
  return {adapter, counts, disconnected};
}
type Reply = {status: number; headers: IncomingHttpHeaders; bytes: Buffer; text: string; json?: ApiResult<unknown>};
async function send(origin: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const raw = typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(origin, {path, method, agent: false, headers: {...(raw === undefined ? {} : {'Content-Type': 'application/json', ...(headers['Transfer-Encoding'] ? {} : {'Content-Length': String(Buffer.byteLength(raw))})}), ...headers}}, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('error', reject);
      res.on('end', () => {
        const bytes = Buffer.concat(chunks); const text = bytes.toString('utf8'); let json: ApiResult<unknown> | undefined;
        if (method !== 'HEAD' && res.headers['content-type']?.startsWith('application/json')) json = JSON.parse(text);
        resolve({status: res.statusCode ?? 0, headers: res.headers, bytes, text, json});
      });
    });
    req.on('error', reject); req.end(raw);
  });
}
function data<T>(reply: Reply): T { assert.ok(reply.json?.ok, reply.text); return reply.json.data as T; }
async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-http-')); const cwd = join(root, 'project'); await mkdir(cwd);
  const shell = Buffer.from('<!doctype html><title>Fixture</title>');
  const fake = agents();
  const app = await startBackend({cwd, port: 0, pi: executable, stateDir: join(root, 'state')}, {agents: () => fake.adapter, assets: new Map([['/', {data: shell, type: 'text/html; charset=utf-8'}]])});
  context.after(async () => { await app.close(); await rm(root, {recursive: true, force: true}); });
  const launch = new URL(app.launchUrl); const origin = launch.origin; let cookie = ''; let workspace: string | undefined;
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const separator = path.includes('?') ? '&' : '?';
    const scoped = workspace && path.startsWith('/api/') && !path.includes('workspace=') ? `${path}${separator}workspace=${encodeURIComponent(workspace)}` : path;
    return send(origin, scoped, method, body, {Origin: origin, ...(cookie ? {Cookie: cookie} : {}), ...headers});
  };
  const login = async () => {
    const reply = await call('/api/auth/launch', 'POST', {capability: new URLSearchParams(launch.hash.slice(1)).get('launch')});
    assert.equal(reply.status, 200); cookie = reply.headers['set-cookie']?.[0]?.split(';')[0] ?? ''; assert.ok(cookie);
  };
  const reserve = async (kind: OperationKind, target?: Target) => data<{operationId: string}>(await call('/api/operations', 'POST', {kind, ...(target ? {target} : {})})).operationId;
  return {...app, cwd, fake, origin, call, login, reserve, useWorkspace(id: string) { workspace = id; }, get cookie() { return cookie; }};
}

type Frame = {name: string; id?: string; body: EventEnvelope};
class Stream {
  frames: Frame[] = []; private waits = new Set<() => void>(); private buffer = '';
  readonly ready: Promise<void>; readonly ended: Promise<void>; private closeRequest: () => void = () => {};
  constructor(origin: string, cookie: string, path: string, headers: Record<string, string> = {}) {
    let end!: () => void; this.ended = new Promise(resolve => { end = resolve; });
    this.ready = new Promise((resolve, reject) => {
      const req = request(origin, {path, headers: {Cookie: cookie, ...headers}}, res => {
        assert.equal(res.statusCode, 200); res.setEncoding('utf8');
        res.on('data', (chunk: string) => this.read(chunk)); res.on('end', end); res.on('close', end); res.on('error', reject); resolve();
      });
      req.on('error', reject); req.end(); this.closeRequest = () => req.destroy();
    });
  }
  private read(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const cut = this.buffer.indexOf('\n\n'); if (cut < 0) break;
      const wire = this.buffer.slice(0, cut); this.buffer = this.buffer.slice(cut + 2);
      const name = /^event: (.+)$/m.exec(wire)?.[1]; const json = /^data: (.+)$/m.exec(wire)?.[1];
      if (name && json) this.frames.push({name, id: /^id: (.+)$/m.exec(wire)?.[1], body: JSON.parse(json)});
      for (const waiter of this.waits) waiter();
    }
  }
  wait<N extends EventName>(name: N, predicate: (data: EventData[N]) => boolean = () => true, from = 0): Promise<EventEnvelope<N>> {
    return new Promise(resolve => {
      const check = () => {
        const frame = this.frames.slice(from).find(f => f.name === name && predicate(f.body.data as EventData[N]));
        if (frame) { this.waits.delete(check); resolve(frame.body as EventEnvelope<N>); }
      };
      this.waits.add(check); check();
    });
  }
  close() { this.closeRequest(); }
}
async function stream(context: TestContext, app: Awaited<ReturnType<typeof fixture>>, boot: Bootstrap, after = boot.cursor) {
  const events = new Stream(app.origin, app.cookie, `/api/events?workspace=${boot.workspace.id}&after=${encodeURIComponent(after)}`);
  context.after(() => events.close()); await events.ready; await events.wait('ready'); return events;
}
async function openPrimary(app: Awaited<ReturnType<typeof fixture>>, events: Stream, body: unknown = {cwd: app.cwd}) {
  const id = await app.reserve('primary.open'); const reply = await app.call('/api/primaries', 'POST', body, {'Idempotency-Key': id});
  assert.equal(reply.status, 202); const opened = data<{primaryKey: string}>(reply);
  const ready = await events.wait('primary.state', value => value.key === opened.primaryKey && value.lifecycle === 'ready');
  return {view: ready.data, target: {kind: 'primary' as const, key: opened.primaryKey, epoch: ready.data.epoch}, id};
}
async function input(app: Awaited<ReturnType<typeof fixture>>, target: Target & {kind: 'primary'}, message: string) {
  const snapshot = data<Bootstrap>(await app.call('/api/snapshot'));
  const state = snapshot.targets?.find(s => s.target.kind === 'primary' && s.target.key === target.key && s.target.epoch === target.epoch); assert.ok(state);
  const draft = data<{revision: number}>(await app.call(`/api/workspaces/${snapshot.workspace.id}/targets/${state.targetKey}/draft`, 'PUT', {expectedRevision: state.draft.revision, text: message, mode: 'prompt'}));
  const id = await app.reserve('primary.input', target); const body = {epoch: target.epoch, message, mode: 'prompt', draftRevision: draft.revision, literal: false};
  const path = `/api/primaries/${target.key}/inputs?workspace=${encodeURIComponent(snapshot.workspace.id)}`;
  const reply = await app.call(path, 'POST', body, {'Idempotency-Key': id});
  if (reply.status === 500 && (await app.registry.operations.get(id)).state === 'reserved') {
    try {
      await app.registry.dispatch({method: 'POST', parts: ['api', 'primaries', target.key, 'inputs'], url: new URL(path, app.origin), body, session: 'fixture', operationId: id, workspace: snapshot.workspace.id});
    } catch (cause) { throw new Error('The HTTP input failed before dispatch; the direct fixture dispatch exposes its cause.', {cause}); }
    assert.fail('The HTTP input failed before dispatch, but the same direct fixture dispatch succeeded.');
  }
  assert.equal(data<OperationView>(reply).state, 'accepted'); return {id, body, receipt: data<OperationView>(reply)};
}

test('HTTP and SSE drive the executable through deltas, tool output, a dialog, and settlement', {timeout: 15000}, async context => {
  const app = await fixture(context); await app.login(); const initial = data<Bootstrap>(await app.call('/api/bootstrap'));
  const created = data<{workspace: {id: string}}>(await app.call('/api/workspaces', 'POST', {}));
  assert.notEqual(created.workspace.id, initial.workspace.id); app.useWorkspace(created.workspace.id);
  const boot = data<Bootstrap>(await app.call('/api/bootstrap')); assert.equal(boot.workspace.id, created.workspace.id);
  const events = await stream(context, app, boot); const opened = await openPrimary(app, events);
  assert.equal(opened.view.model?.provider, 'acceptance-fixture');
  const admitted = await input(app, opened.target, 'deterministic prompt');
  await events.wait('primary.delta', value => value.kind === 'text' && value.delta.includes('Text, tool output'));
  await events.wait('primary.delta', value => value.kind === 'thinking');
  const tool = await events.wait('primary.tool', value => value.phase === 'end' && value.callId === 'fixture-read');
  assert.deepEqual(events.frames.filter(f => f.name === 'primary.tool').map(f => (f.body.data as EventData['primary.tool']).phase), ['start', 'update', 'end']);
  assert.ok(tool.data.parts?.some(part => part.type === 'text' && part.text.includes('Fixture file content')));
  const dialog = await events.wait('extension.request', value => value.method === 'confirm');
  assert.equal(dialog.target?.kind, 'primary'); assert.equal(app.registry.primary(opened.target.key).view.activity, 'running');
  const repeated = await app.call(`/api/primaries/${opened.target.key}/inputs`, 'POST', admitted.body, {'Idempotency-Key': admitted.id});
  assert.deepEqual(data<OperationView>(repeated), admitted.receipt);
  const changed = await app.call(`/api/primaries/${opened.target.key}/inputs`, 'POST', {...admitted.body, message: 'different'}, {'Idempotency-Key': admitted.id}); assert.equal(changed.status, 409);
  const unknown = await app.call(`/api/primaries/${opened.target.key}/inputs`, 'POST', admitted.body, {'Idempotency-Key': 'unknown'}); assert.equal(unknown.status, 404);
  const dialogId = 'id' in dialog.data ? dialog.data.id : ''; const answer = await app.reserve('primary.dialog', opened.target); const settledCut = events.frames.length;
  const result = await app.call(`/api/primaries/${opened.target.key}/dialogs/${dialogId}`, 'POST', {epoch: opened.target.epoch, confirmed: true}, {'Idempotency-Key': answer}); assert.equal(data<OperationView>(result).state, 'completed');
  await events.wait('primary.state', value => value.key === opened.target.key && value.activity === 'idle', settledCut);
  const session = app.registry.primary(opened.target.key); assert.equal(session.messages.filter(m => m.role === 'user').length, 1);
  assert.ok(session.messages.some(m => m.parts.some(p => p.type === 'text' && p.text === 'Fixture work completed.')));
  assert.equal(app.fake.counts.refresh, 1);
});

test('logout closes SSE and releases observations without stopping a busy primary', {timeout: 15000}, async context => {
  const app = await fixture(context); await app.login(); const boot = data<Bootstrap>(await app.call('/api/bootstrap'));
  const events = await stream(context, app, boot); const {target} = await openPrimary(app, events);
  await input(app, target, 'keep work alive'); await events.wait('extension.request', value => value.method === 'confirm');
  const primary = app.registry.primary(target.key); const pid = primary.view.pid; assert.ok(pid);
  assert.equal((await app.call('/api/auth/logout', 'POST', {})).status, 200);
  await events.ended; await app.fake.disconnected;
  assert.equal(app.registry.journal.connectionCount, 0); assert.equal(primary.view.lifecycle, 'ready'); assert.equal(primary.view.activity, 'running');
  assert.doesNotThrow(() => process.kill(pid, 0)); assert.equal((await app.call('/api/bootstrap')).status, 401);
});

test('saved-session open and resume require manual writer release; stale epochs never dispatch', {timeout: 15000}, async context => {
  const app = await fixture(context); await app.login(); const saved = join(app.cwd, 'saved.jsonl'); await writeFile(saved, `${JSON.stringify({type:'session',version:3,id:'fixture',timestamp:new Date(0).toISOString(),cwd:app.cwd})}\n`);
  const id = await app.reserve('primary.open'); const missing = await app.call('/api/primaries', 'POST', {cwd: app.cwd, sessionFile: saved}, {'Idempotency-Key': id});
  assert.equal(missing.status, 400); assert.equal(app.registry.sessions.size, 0);
  const boot = data<Bootstrap>(await app.call('/api/bootstrap')); const events = await stream(context, app, boot);
  const body = {cwd: app.cwd, sessionFile: saved, writerReleased: true}; const opened = await openPrimary(app, events, body);
  const repeated = await app.call('/api/primaries', 'POST', body, {'Idempotency-Key': opened.id}); assert.equal(data<{primaryKey: string}>(repeated).primaryKey, opened.target.key); assert.equal(app.registry.sessions.size, 1);
  const resume = await app.reserve('primary.session', opened.target); const route = `/api/primaries/${opened.target.key}/session`;
  assert.equal((await app.call(route, 'POST', {epoch: 1, action: 'resume', sessionFile: saved}, {'Idempotency-Key': resume})).status, 400);
  const accepted = await app.call(route, 'POST', {epoch: 1, action: 'resume', sessionFile: saved, writerReleased: true}, {'Idempotency-Key': resume}); assert.equal(data<OperationView>(accepted).state, 'completed');
  const stale = await app.reserve('primary.control', opened.target);
  const rejected = data<OperationView>(await app.call(`/api/primaries/${opened.target.key}/control`, 'POST', {epoch: 1, action: 'stats'}, {'Idempotency-Key': stale}));
  assert.equal(rejected.state, 'rejected'); assert.equal(rejected.error?.code, 'stale_epoch'); assert.equal(app.registry.primary(opened.target.key).view.epoch, 2);
});

test('HTTP authentication, methods, JSON bodies, and payload bounds are enforced', {timeout: 15000}, async context => {
  const app = await fixture(context);
  assert.equal((await app.call('/api/events')).status, 401); assert.equal((await app.call('/api/snapshot')).status, 401);
  assert.equal((await app.call('/api/auth/launch', 'POST', {}, {Origin: 'http://foreign.invalid'})).status, 403);
  assert.equal((await app.call('/', 'GET', undefined, {Host: 'localhost:1'})).status, 403);
  await app.login(); assert.equal((await app.call('/api/snapshot', 'POST', {})).status, 405);
  for (const body of ['[]', 'null', '{', '"scalar"']) assert.equal((await app.call('/api/workspaces', 'POST', body)).status, 400);
  assert.equal((await app.call('/api/workspaces', 'POST', {}, {'Content-Type': 'text/plain'})).status, 400);
  assert.equal((await app.call('/api/workspaces', 'POST', {text: 'x'.repeat(LIMITS.requestBytes)})).status, 413);
  assert.equal((await app.call('/api/workspaces', 'POST', {text: 'x'.repeat(LIMITS.requestBytes)}, {'Transfer-Encoding': 'chunked'})).status, 413);
});

test('raw traversal requests never normalize into an allowed asset or API route', {timeout: 15000}, async context => {
  const app = await fixture(context); await app.login();
  for (const path of ['/private/../', '/web/%2e%2e/api/bootstrap', '/web/%2fetc/passwd', '/web/%5csecret', '/web/%00', '/package.json', '/ui/server/main.mts']) {
    assert.equal((await app.call(path)).status, 404, path);
  }
});

test('Last-Event-ID overrides the URL cursor and replay precedes ready metadata', {timeout: 15000}, async context => {
  const app = await fixture(context); await app.login(); const boot = data<Bootstrap>(await app.call('/api/bootstrap'));
  const id = app.registry.journal.publish('notice', undefined, {level: 'info', message: 'replayed'});
  const events = new Stream(app.origin, app.cookie, `/api/events?workspace=${boot.workspace.id}&after=other-boot:0`, {'Last-Event-ID': boot.cursor});
  context.after(() => events.close()); await events.ready; await events.wait('ready');
  assert.deepEqual(events.frames.map(frame => [frame.name, frame.id]), [['notice', id], ['ready', undefined]]);
});

test('request rate accounting rejects the next request at a deterministic fixed clock', {timeout: 15000}, async context => {
  context.mock.method(performance, 'now', () => 1);
  const app = await fixture(context);
  for (let i = 0; i < 240; i++) assert.equal((await app.call('/')).status, 200, String(i));
  const rejected = await app.call('/'); assert.equal(rejected.status, 429); assert.equal(rejected.json?.ok, false);
  assert.equal(app.fake.counts.refresh, 1); assert.equal(app.registry.sessions.size, 0);
});

const requiredAssets = ['web/index.html', 'web/style.css', 'dist/web/app.js', 'dist/shared/api.js'];
async function browserBuild(context: TestContext, emptyFiles = false) {
  const root = await mkdtemp(join(tmpdir(), 'ui-browser-assets-'));
  const apps: Awaited<ReturnType<typeof startBackend>>[] = [];
  context.after(async () => {
    try { for (const app of apps) await app.close(); }
    finally { await rm(root, {recursive: true, force: true}); }
  });
  await mkdir(join(root, 'web')); await mkdir(join(root, 'dist/web'), {recursive: true});
  await mkdir(join(root, 'dist/shared'));
  for (const path of requiredAssets) await writeFile(join(root, path), emptyFiles ? '' : `Original ${path}`);
  return {root, start: async (state = 'state') => {
    const fake = agents();
    const app = await startBackend({cwd: root, port: 0, pi: executable, stateDir: join(root, state)}, {agents: () => fake.adapter, assetRoot: root});
    apps.push(app); return {...app, origin: new URL(app.launchUrl).origin};
  }};
}
function buildError(path: string, reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ApiError); assert.ok(error.message.includes(path), error.message);
    assert.ok(error.message.includes(reason), error.message);
    assert.ok(error.message.includes('npm run ui:build'), error.message);
    assert.ok(!error.message.includes('#launch=')); return true;
  };
}
function assetHeaders(reply: Reply) {
  return Object.fromEntries(['content-type', 'content-length', 'cache-control', 'x-content-type-options', 'referrer-policy', 'content-security-policy'].map(name => [name, reply.headers[name]]));
}
async function verifyBrowserBytes(origin: string, assets: Map<string, Asset>) {
  const headers = new Map<string, ReturnType<typeof assetHeaders>>();
  for (const [route, asset] of assets) {
    const get = await send(origin, route); const head = await send(origin, route, 'HEAD');
    assert.equal(get.status, 200, route); assert.equal(head.status, 200, route);
    assert.deepEqual(get.bytes, asset.data, route); assert.equal(head.bytes.length, 0, route);
    assert.equal(get.headers['content-type'], asset.type, route);
    assert.equal(get.headers['content-length'], String(asset.data.length), route);
    assert.equal(get.headers['cache-control'], 'no-store'); assert.equal(get.headers['x-content-type-options'], 'nosniff');
    assert.equal(get.headers['referrer-policy'], 'no-referrer'); assert.match(String(get.headers['content-security-policy']), /default-src 'none'/);
    assert.deepEqual(assetHeaders(head), assetHeaders(get), route); headers.set(route, assetHeaders(get));
  }
  return headers;
}

test('startup browser bytes survive overwrites and deletion; a fresh backend reads the rebuilt bytes', async context => {
  const {root, start} = await browserBuild(context); const extra = 'dist/web/extra-module.js';
  await writeFile(join(root, extra), Buffer.from([0, 255, 1, 127, 128]));
  const original = await assetMap(root);
  assert.deepEqual([...original.keys()].sort(), ['/', '/shared/api.js', '/style.css', '/web/app.js', '/web/extra-module.js']);
  const app = await start(); const headers = await verifyBrowserBytes(app.origin, original);
  for (const path of [...requiredAssets, extra]) await writeFile(join(root, path), `Rebuilt ${path}`);
  assert.deepEqual(await verifyBrowserBytes(app.origin, original), headers);
  const rebuilt = await assetMap(root); const fresh = await start('fresh-state');
  await verifyBrowserBytes(fresh.origin, rebuilt);
  for (const route of original.keys()) assert.notDeepEqual(rebuilt.get(route)?.data, original.get(route)?.data);
  for (const path of [...requiredAssets, extra]) await rm(join(root, path));
  assert.deepEqual(await verifyBrowserBytes(app.origin, original), headers);
  await verifyBrowserBytes(fresh.origin, rebuilt);
  await assert.rejects(assetMap(root), buildError('dist/web/app.js', 'missing'));
});

test('missing browser builds reject before the backend creates its state directory or acquires a lock', async context => {
  for (const path of ['dist/web', ...requiredAssets]) await context.test(path, async child => {
    const {root} = await browserBuild(child); await rm(join(root, path), {recursive: true});
    await assert.rejects(assetMap(root), buildError(path, 'missing'));
    let adapterOpened = false;
    await assert.rejects(startBackend({cwd: root, port: 0, pi: executable, stateDir: join(root, 'unopened-state')}, {
      assetRoot: root, agents: () => { adapterOpened = true; return agents().adapter; },
    }), buildError(path, 'missing'));
    assert.equal(adapterOpened, false);
    await assert.rejects(access(join(root, 'unopened-state')), {code: 'ENOENT'});
  });
});
async function sizedAsset(root: string, path: string, bytes: number) {
  const file = await open(join(root, path), 'w');
  try { await file.truncate(bytes); } finally { await file.close(); }
}

test('browser file reads accept the exact per-file bound and reject larger files', async context => {
  const {root} = await browserBuild(context, true); const path = 'web/index.html';
  await sizedAsset(root, path, ASSET_FILE_BYTES);
  assert.equal((await assetMap(root)).get('/')?.data.length, ASSET_FILE_BYTES);
  await sizedAsset(root, path, ASSET_FILE_BYTES + 1);
  await assert.rejects(assetMap(root), buildError(path, 'per-file bound'));
  await sizedAsset(root, path, ASSET_FILE_BYTES * 1024);
  await assert.rejects(assetMap(root), buildError(path, 'per-file bound'));
});

test('browser reads accept the exact total byte bound and stop at the next byte', async context => {
  const {root} = await browserBuild(context, true);
  for (let i = 0; i < ASSET_TOTAL_BYTES / ASSET_FILE_BYTES; i++) await sizedAsset(root, `dist/web/module-${i}.js`, ASSET_FILE_BYTES);
  const assets = await assetMap(root);
  assert.equal([...assets.values()].reduce((sum, asset) => sum + asset.data.length, 0), ASSET_TOTAL_BYTES);
  const path = 'dist/shared/api.js'; await writeFile(join(root, path), 'x');
  await assert.rejects(assetMap(root), buildError(path, 'total bound'));
});

test('browser traversal accepts the exact entry cap and rejects the next entry', async context => {
  const {root} = await browserBuild(context);
  for (let i = 1; i < ASSET_ENTRY_LIMIT; i++) await writeFile(join(root, `dist/web/ignored-${i}.txt`), '');
  assert.equal((await assetMap(root)).size, 4);
  await writeFile(join(root, 'dist/web/one-too-many.txt'), '');
  await assert.rejects(assetMap(root), buildError('dist/web', `${ASSET_ENTRY_LIMIT} entries`));
});

test('browser traversal ignores non-matching names and does not recurse', async context => {
  const {root} = await browserBuild(context);
  for (const name of ['bad.name.js', '.hidden.js', 'space name.js', 'note.txt', 'app.js.map', '雪.js']) await writeFile(join(root, 'dist/web', name), 'ignored');
  await mkdir(join(root, 'dist/web/nested')); await writeFile(join(root, 'dist/web/nested/valid.js'), 'ignored');
  await writeFile(join(root, 'dist/web/Valid_0-module.js'), 'routed');
  assert.deepEqual([...((await assetMap(root)).keys())].sort(), ['/', '/shared/api.js', '/style.css', '/web/Valid_0-module.js', '/web/app.js']);
});

test('browser startup rejects special build files without waiting on them', async context => {
  const {root} = await browserBuild(context);
  await mkdir(join(root, 'dist/web/folder.js'));
  await assert.rejects(assetMap(root), buildError('dist/web/folder.js', 'not a regular file'));
  await rm(join(root, 'dist/web/folder.js'), {recursive: true});
  await promisify(execFile)('mkfifo', [join(root, 'dist/web/stalled.js')]);
  await assert.rejects(assetMap(root), buildError('dist/web/stalled.js', 'not a regular file'));
  await rm(join(root, 'web/style.css')); await mkdir(join(root, 'web/style.css'));
  await rm(join(root, 'dist/web/stalled.js'));
  await assert.rejects(assetMap(root), buildError('web/style.css', 'not a regular file'));
});

test('malformed build directories name the path and the build command; other read failures propagate', async context => {
  const {root} = await browserBuild(context);
  await rm(join(root, 'dist/shared'), {recursive: true}); await writeFile(join(root, 'dist/shared'), 'not a directory');
  await assert.rejects(assetMap(root), buildError('dist/shared/api.js', 'not a directory'));
  await rm(join(root, 'dist/web'), {recursive: true}); await writeFile(join(root, 'dist/web'), 'not a directory');
  await assert.rejects(assetMap(root), buildError('dist/web', 'not a directory'));
  const denied = await browserBuild(context); await chmod(join(denied.root, 'web/index.html'), 0);
  await assert.rejects(assetMap(denied.root), {code: 'EACCES'});
});

test('browser asset routes preserve method errors and Host, Origin, and fetch metadata validation', async context => {
  const {root, start} = await browserBuild(context); const app = await start();
  await verifyBrowserBytes(app.origin, await assetMap(root));
  for (const path of ['/', '/style.css', '/web/app.js', '/shared/api.js']) {
    const post = await send(app.origin, path, 'POST', {}, {Origin: app.origin});
    assert.equal(post.status, 405); assert.equal(post.json?.ok, false);
    assert.equal(post.headers['content-type'], 'application/json; charset=utf-8');
    if (post.json && !post.json.ok) assert.equal(post.json.error.code, 'invalid_request');
    assert.equal((await send(app.origin, path, 'GET', undefined, {Host: 'foreign.invalid'})).status, 403);
    assert.equal((await send(app.origin, path, 'HEAD', undefined, {Origin: 'http://foreign.invalid'})).status, 403);
    assert.equal((await send(app.origin, path, 'POST', {}, {Origin: 'http://foreign.invalid'})).status, 403);
    assert.equal((await send(app.origin, path, 'GET', undefined, {'Sec-Fetch-Site': 'cross-site'})).status, 403);
  }
  assert.equal((await send(app.origin, '/api/bootstrap')).status, 401);
  assert.equal((await send(app.origin, '/web/not-built.js')).status, 404);
});
