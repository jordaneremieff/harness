import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CatalogPage } from '../agents/index.mts';
import { ApiError } from './errors.mts';
import { main, parseArgs } from './main.mts';
import type { AgentAdapter } from './registry.mts';

const assets = new Map([['/', {type: 'text/html; charset=utf-8', data: Buffer.from('<title>Fixture</title>')}]]);
const executable = fileURLToPath(new URL('../rpc/fake-pi.mts', import.meta.url));
const empty: CatalogPage = {rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false, scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}};
const forbidden = async (): Promise<never> => { throw new Error('No native agent work belongs in this fixture'); };
const adapter: AgentAdapter = {roster: () => empty, rosterRow: () => undefined, refresh: async () => empty.scan, prepare: forbidden, select: forbidden, reconnect: forbidden, history: forbidden,
  inspect: forbidden, submit: forbidden, retrySubmit: forbidden, abort: forbidden, configure: () => { throw new Error('No native agent configuration'); },
  hide: async () => {}, disconnectWorkspace: async () => {}, close: async () => {}};
async function project(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-main-')); const cwd = join(root, 'project'); await mkdir(cwd);
  const apps: {close(): Promise<void>}[] = [];
  context.after(async () => { for (const app of apps) await app.close(); await rm(root, {recursive: true, force: true}); });
  return {root, cwd, keep: <T extends {close(): Promise<void>}>(app: T) => { apps.push(app); return app; }};
}
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

test('main passes the launch URL to the opener only with --open', {timeout: 15000}, async context => {
  const {root, cwd, keep} = await project(context);
  const opened: string[] = [];
  const app = keep(await main([...flags(cwd, root, 'state-open'), '--open'], async url => { opened.push(url); }, {agents: () => adapter, assets}));
  assert.deepEqual(opened, [app.launchUrl]);
  assert.match(app.launchUrl, /^http:\/\/127\.0\.0\.1:\d+\/#launch=/);
  let silent = 0;
  keep(await main(flags(cwd, root, 'state-plain'), async () => { silent += 1; }, {agents: () => adapter, assets}));
  assert.equal(silent, 0);
});

test('main keeps the backend running when the opener fails', {timeout: 15000}, async context => {
  const {root, cwd, keep} = await project(context);
  const app = keep(await main([...flags(cwd, root, 'state-fail'), '--open'], async () => { throw new Error('no browser'); }, {agents: () => adapter, assets}));
  assert.match(app.launchUrl, /^http:\/\/127\.0\.0\.1:\d+\//);
});
