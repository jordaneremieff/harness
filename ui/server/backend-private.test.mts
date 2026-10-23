import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {access, lstat, mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {startBackend} from './backend.mts';
import type {AgentAdapter} from './registry.mts';
import {LocalHttp} from './http.mts';
import {Journal} from './journal.mts';
import {BROWSER_API, RELEASE_FORMAT, type ReleaseManifest} from '../shared/release.ts';
import {OWNER_PROTOCOL} from '../shared/owner.ts';
const origin = 'https://desktop.example.ts.net', ownerLogin = 'owner@example.com';
async function fixture(context: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uipb-'))), agent = join(root, 'agent'), state = join(root, 'state');
  await mkdir(agent); await mkdir(state, {mode: 0o700});
  const keys = ['PI_CODING_AGENT_DIR', 'PI_HARNESS_FILE', 'PI_UI_PRIVATE_ORIGIN', 'PI_UI_PRIVATE_OWNER_LOGIN'];
  const previous = keys.map(key => process.env[key]), closers: (() => Promise<void>)[] = [];
  process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_HARNESS_FILE = 'harness.json'; delete process.env.PI_UI_PRIVATE_ORIGIN; delete process.env.PI_UI_PRIVATE_OWNER_LOGIN;
  context.after(async () => {for (const close of closers.reverse()) await close(); keys.forEach((key, index) => {const value = previous[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value;}); await rm(root, {recursive: true, force: true});});
  const configure = (ui: unknown) => writeFile(join(agent, 'harness.json'), JSON.stringify({version: 1, ui}));
  return {root, agent, state, configure, retain: (close: () => Promise<void>) => closers.push(close)};
}
function agents(): AgentAdapter {
  const forbidden = async (): Promise<never> => {throw new Error('No native agent work in private backend fixtures.');};
  const catalog = {rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false, scan: {state: 'ready' as const, complete: true, visited: 0, skipped: 0, omitted: 0}};
  return {roster: () => catalog, rosterRow: () => undefined, lookup: forbidden, imageInputAvailable: () => false, refresh: async () => catalog.scan,
    prepare: forbidden, select: forbidden, reconnect: forbidden, history: forbidden, image: forbidden, inspect: forbidden, inventory: forbidden, command: forbidden, threads: forbidden, thread: forbidden, submit: forbidden, retrySubmit: forbidden, abort: forbidden,
    configure: () => {throw new Error('No native configuration.');}, hide: async () => {}, disconnectWorkspace: async () => {}, close: async () => {}};
}
async function privateRead(path: string, login: string): Promise<number> {
  return new Promise((accept, reject) => {
    const req = request({socketPath: path, path: '/', agent: false, headers: {Host: 'localhost', 'X-Forwarded-Host': 'desktop.example.ts.net', 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': login}}, response => {response.resume(); response.on('end', () => accept(response.statusCode ?? 0));});
    req.on('error', reject); req.end();
  });
}
test('backend configuration uses the agent directory, freezes until replacement and keeps stylesheet errors independent', async context => {
  const f = await fixture(context); await f.configure({privateOrigin: origin, privateOwnerLogin: ownerLogin, userStylesheet: 7});
  const injection = {agents, assets: new Map([['/', {type: 'text/html', data: Buffer.from('<html><head></head><body></body></html>')}]]), userStylesheet: async () => ({state: 'invalid' as const})};
  const app = await startBackend({cwd: f.root, stateDir: f.state, port: 0, pi: 'not-executed'}, injection);
  f.retain(() => app.close()); const path = join(f.state, 'private', 'http.sock');
  assert.equal(await privateRead(path, ownerLogin), 200);
  await f.configure({privateOrigin: origin, privateOwnerLogin: 'other@example.com'});
  assert.equal(await privateRead(path, ownerLogin), 200); assert.equal(await privateRead(path, 'other@example.com'), 403);
  await app.close(); await f.configure({});
  const replacement = await startBackend({cwd: f.root, stateDir: f.state, port: 0, pi: 'not-executed'}, injection); f.retain(() => replacement.close());
  assert.equal(replacement.http.privateServer, undefined); await assert.rejects(access(path), {code: 'ENOENT'});
  const response = await fetch(replacement.url); assert.equal(response.status, 200); await response.text();
});
test('invalid private configuration aborts startup before state, registry, assets or TCP admission', async context => {
  const f = await fixture(context); await f.configure({privateOrigin: origin});
  const unused = join(f.root, 'unopened');
  await assert.rejects(startBackend({cwd: f.root, stateDir: unused, port: 0, pi: 'not-executed'}, {assets: new Map()}), /invalid or incomplete/);
  await assert.rejects(access(unused), {code: 'ENOENT'});
});
async function releaseFixture(root: string): Promise<{directory: string; manifest: ReleaseManifest}> {
  const directory = join(root, 'release'); await mkdir(join(directory, 'ui', 'dist', 'web'), {recursive: true}); await mkdir(join(directory, 'ui', 'dist', 'shared'), {recursive: true}); await mkdir(join(directory, 'ui', 'web'));
  await writeFile(join(directory, 'ui', 'dist', 'web', 'app.js'), 'export {};');
  for (const name of ['api', 'version', 'files', 'health', 'control', 'inspection']) await writeFile(join(directory, 'ui', 'dist', 'shared', `${name}.js`), 'export {};');
  for (const name of ['index.html', 'style.css', 'favicon.svg']) await writeFile(join(directory, 'ui', 'web', name), 'fixture');
  const hash = 'a'.repeat(64), date = '2026-10-23T00:00:00Z';
  const manifest: ReleaseManifest = {format: RELEASE_FORMAT, browserApi: BROWSER_API, ownerProtocol: OWNER_PROTOCOL, id: hash, sourceTree: 'a'.repeat(40), sourceCommit: 'a'.repeat(40), runtimeDigest: hash, lockDigest: hash, assetDigest: hash, generation: hash, moduleFamily: hash, iteration: '1.6', stagedAt: date, committedAt: date, branch: 'fixture', files: {}, imports: {}};
  await writeFile(join(directory, 'release.json'), JSON.stringify(manifest)); return {directory, manifest};
}
async function prewarm(release: Awaited<ReturnType<typeof releaseFixture>>, root: string): Promise<string> {
  const child = fork(fileURLToPath(new URL('./backend.mts', import.meta.url)), [], {env: {...process.env}, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  let timer: NodeJS.Timeout | undefined;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  try {
    return await new Promise<string>((accept, reject) => {
      timer = setTimeout(() => reject(new Error('Prewarm fixture deadline.')), 10000);
      child.once('error', reject); child.once('message', message => accept((message as {kind: string}).kind));
      child.once('exit', () => reject(new Error('Prewarm exited without a result.')));
      child.send({kind: 'prewarm', options: {cwd: root, stateDir: root, port: 0, pi: 'not-executed'}, release});
    });
  } finally {clearTimeout(timer); child.kill('SIGTERM'); await exited;}
}
test('real backend prewarm validates private settings without binding or replacing the active socket', async context => {
  const f = await fixture(context), release = await releaseFixture(f.root);
  await f.configure({privateOrigin: origin, privateOwnerLogin: ownerLogin});
  const active = new LocalHttp({journal: new Journal(), dispatch: async () => ({}), workspace: async () => 'fixture', observe: async () => {}, detached: () => {}}, new Map(), undefined, {}, {config: {origin, host: 'desktop.example.ts.net', ownerLogin}, stateDir: f.state});
  await active.listen(0); f.retain(() => active.close());
  const path = join(f.state, 'private', 'http.sock'), before = await lstat(path);
  assert.equal(await prewarm(release, f.state), 'prewarmed');
  assert.equal((await lstat(path)).ino, before.ino); assert.equal(active.privateServer?.listening, true);
  await f.configure({privateOrigin: origin});
  assert.equal(await prewarm(release, f.state), 'prewarm-failed'); assert.equal((await lstat(path)).ino, before.ino);
});
