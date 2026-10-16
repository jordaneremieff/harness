import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CatalogPage } from '../agents/index.mts';
import type { ApiResult } from '../shared/api.ts';
import { ApiError } from './errors.mts';
import { main, parseArgs } from './main.mts';
import { UI_ITERATION, identityLabel, readIdentity, type UiIdentity } from '../shared/version.ts';
import type { AgentAdapter } from './registry.mts';

const assets = new Map([['/', {type: 'text/html; charset=utf-8', data: Buffer.from('<title>Fixture</title>')}]]);
const executable = fileURLToPath(new URL('../rpc/fake-pi.mts', import.meta.url));
const empty: CatalogPage = {rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false, scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}};
const forbidden = async (): Promise<never> => { throw new Error('No native agent work belongs in this fixture'); };
const adapter: AgentAdapter = {roster: () => empty, rosterRow: () => undefined, imageInputAvailable: () => false, refresh: async () => empty.scan, prepare: forbidden, select: forbidden, reconnect: forbidden, history: forbidden, image: forbidden,
  inspect: forbidden, submit: forbidden, retrySubmit: forbidden, abort: forbidden, configure: () => { throw new Error('No native agent configuration'); },
  hide: async () => {}, disconnectWorkspace: async () => {}, close: async () => {}};
async function project(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-main-')); const cwd = join(root, 'project'); await mkdir(cwd);
  const apps: {close(): Promise<void>}[] = [];
  context.after(async () => { for (const app of apps) await app.close(); await rm(root, {recursive: true, force: true}); });
  return {root, cwd, keep: <T extends {close(): Promise<void>}>(app: T) => { apps.push(app); return app; }};
}
const quiet={agents:()=>adapter,assets,announce:()=>{}};
const flags = (cwd: string, root: string, name: string) => ['--cwd', cwd, '--port', '0', '--pi', executable, '--state-dir', join(root, name)];

test('parseArgs reads flag values and the standalone --open flag in any position', () => {
  const cwd = '/base';
  assert.deepEqual(parseArgs([], cwd), {cwd, port: 4318, pi: 'pi', open: false});
  assert.equal(parseArgs(['--open'], cwd).open, true);
  const mixed = parseArgs(['--port', '0', '--open', '--pi', '/bin/fake'], cwd);
  assert.equal(mixed.open, true); assert.equal(mixed.port, 0); assert.equal(mixed.pi, '/bin/fake');
  assert.equal(parseArgs(['--cwd', '/tmp', '--open'], cwd).open, true);
});

test('parseArgs refuses a value-taking flag without a value and unknown flags', () => {
  const invalid = (error: unknown) => error instanceof ApiError && error.code === 'invalid_request';
  assert.throws(() => parseArgs(['--port', '--open'], '/base'), invalid);
  assert.throws(() => parseArgs(['--open', '--cwd'], '/base'), invalid);
  assert.throws(() => parseArgs(['--opened'], '/base'), invalid);
});

test('main passes the local URL to the opener only with --open', {timeout: 15000}, async context => {
  const {root, cwd, keep} = await project(context);
  const opened: string[] = [];
  const app = keep(await main([...flags(cwd, root, 'state-open'), '--open'], async url => { opened.push(url); }, quiet));
  assert.deepEqual(opened, [app.url]);
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  let silent = 0;
  keep(await main(flags(cwd, root, 'state-plain'), async () => { silent += 1; }, quiet));
  assert.equal(silent, 0);
});

test('main forwards qualified native result selectors without admission and returns conflicts', {timeout: 15000}, async context => {
  const {root, cwd, keep} = await project(context);
  const identity = '00000000-0000-4000-8000-000000000001:7';
  const calls: {identity: string; options: Parameters<AgentAdapter['inspect']>[1]}[] = [];
  const injected: AgentAdapter = {...adapter, inspect: async (identity, options) => {
    calls.push({identity, options});
    if (options.submissionId === 99) throw new ApiError('invalid_request', 'Result selectors conflict.');
    return {view: 'result', sessionId: identity, conversationId: 7, requestId: options.requestId ?? '', status: 'unavailable', reason: 'Not retained', usage: {models: {}, tools: {}}};
  }};
  const app = keep(await main(flags(cwd, root, 'state-inspect'), async () => { throw new Error('No browser'); }, {agents: () => injected, assets,announce:()=>{}}));
  const launch = new URL(app.url);
  const inspect = (body: unknown) => fetch(`${launch.origin}/api/agents/${encodeURIComponent(identity)}/inspect`, {method: 'POST', headers: {Origin: launch.origin, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const input = {view: 'result' as const, requestId: 'exact-native-request', operationId: 'separate-operation', entryId: 30};
  const reply = await inspect(input); assert.equal(reply.status, 200);
  const result = await reply.json() as ApiResult<{projection: {value: Record<string, unknown>}}>; assert.ok(result.ok); assert.equal(result.data.projection.value.status, 'unavailable');
  assert.equal(Object.hasOwn(result.data.projection.value, 'submissionId'), false);
  assert.deepEqual(calls, [{identity, options: input}]);
  const conflict = await inspect({...input, submissionId: 99}); assert.equal(conflict.status, 400);
  const failure = await conflict.json() as ApiResult<never>; assert.ok(!failure.ok);
  assert.equal(failure.error.code, 'invalid_request'); assert.deepEqual(calls[1], {identity, options: {...input, submissionId: 99}});
  const invalid = await inspect({...input, requestId: ''}); assert.equal(invalid.status, 400); assert.equal(calls.length, 2);
});

test('main keeps the backend running when the opener fails', {timeout: 15000}, async context => {
  const {root, cwd, keep} = await project(context);
  const app = keep(await main([...flags(cwd, root, 'state-fail'), '--open'], async () => { throw new Error('no browser'); }, quiet));
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+\//);
});

test('startup prints the served page identity directly after the local URL', {timeout: 15000}, async context => {
  const {root, cwd, keep} = await project(context);
  const identity: UiIdentity = {iteration: UI_ITERATION, git: {commit: 'a'.repeat(40), shortCommit: 'aaaaaaa', branch: 'feature/ui', modified: true, committedAt: '2026-10-12T00:00:00.000Z'},
    assets: {digest: 'b'.repeat(64), builtAt: '2026-10-12T01:00:00.000Z'}, startedAt: '2026-10-12T02:00:00.000Z', pi: '1.1.0', durable: '1.1.0'};
  const output: string[] = [];
  const app = keep(await main(flags(cwd, root, 'state-identity'), async () => {throw new Error('No browser');}, {agents: () => adapter, assets, identity,announce:text=>{output.push(text);}}));
  assert.deepEqual(output.join('').trimEnd().split('\n'), [app.url, identityLabel(identity)]);
  const html = await (await fetch(new URL('/', app.url))).text();
  const encoded = /name="ui-identity" content="([^"]*)"/.exec(html)?.[1]; assert.ok(encoded);
  assert.deepEqual(readIdentity(encoded), identity); assert.equal(app.identity, identity);
});
