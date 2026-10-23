import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm, mkdir, chmod, writeFile, readFile, lstat, symlink, access} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import test, {type TestContext} from 'node:test';
import {listenPrivateSocket} from './private-socket.mts';
import {LocalHttp} from './http.mts';
import {Journal} from './journal.mts';
const config = {origin: 'https://desktop.example.ts.net', host: 'desktop.example.ts.net', ownerLogin: 'owner@example.com'};
async function root(context: TestContext) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'ui-socket-')));
  context.after(() => rm(path, {recursive: true, force: true})); return path;
}
function http(stateDir: string) {
  return new LocalHttp({journal: new Journal(), dispatch: async () => ({}), workspace: async () => 'fixture', observe: async () => {}, detached: () => {}}, new Map(), undefined, {}, {config, stateDir});
}
for (const kind of ['root-link', 'directory-link', 'socket-link', 'directory-mode', 'root-mode', 'file', 'long']) {
  test(`private socket refuses an unsafe path: ${kind}`, async context => {
    const directory = await root(context), state = join(directory, 'state'); await mkdir(state, {mode: 0o700});
    let selected = state;
    if (kind === 'root-link') {selected = join(directory, 'alias'); await symlink(state, selected);}
    if (kind === 'root-mode') await chmod(state, 0o777);
    if (kind === 'long') {selected = join(directory, 'a'.repeat(104)); await mkdir(selected, {mode: 0o700});}
    const privateDir = join(state, 'private');
    if (kind === 'directory-link') {const destination = join(directory, 'elsewhere'); await mkdir(destination, {mode: 0o700}); await symlink(destination, privateDir);}
    else {await mkdir(privateDir, {mode: kind === 'directory-mode' ? 0o755 : 0o700});}
    const target = join(privateDir, 'http.sock');
    if (kind === 'file') await writeFile(target, 'preserve');
    if (kind === 'socket-link') await symlink(join(directory, 'absent'), target);
    const app = http(selected); await assert.rejects(app.listen(0));
    assert.equal(app.server.listening, false); assert.equal(app.privateServer?.listening, false);
    if (kind === 'file') assert.equal(await readFile(target, 'utf8'), 'preserve');
    if (kind === 'socket-link') assert.equal((await lstat(target)).isSymbolicLink(), true);
    await app.close();
  });
}
test('a second instance never unlinks or replaces a live socket', async context => {
  const state = await root(context), first = http(state); await first.listen(0); context.after(() => first.close());
  const path = join(state, 'private', 'http.sock'), before = await lstat(path), second = http(state);
  await assert.rejects(second.listen(0)); await second.close();
  const after = await lstat(path); assert.equal(after.ino, before.ino); assert.equal(first.privateServer?.listening, true);
});
test('TCP bind failure closes the new private listener and removes only its owned socket', async context => {
  const state = await root(context), occupied = createServer();
  await new Promise<void>(accept => occupied.listen(0, '127.0.0.1', accept));
  context.after(() => new Promise<void>(accept => occupied.close(() => accept())));
  const app = http(state); await assert.rejects(app.listen((occupied.address() as {port: number}).port), {code: 'EADDRINUSE'});
  assert.equal(app.server.listening, false); assert.equal(app.privateServer?.listening, false);
  await assert.rejects(access(join(state, 'private', 'http.sock')), {code: 'ENOENT'});
  app.resumeAdmission(); assert.equal(app.server.listening, false); await app.close();
});
test('exclusive publication fails without replacing a destination introduced during bind', async context => {
  const state = await root(context), server = createServer(), path = join(state, 'private', 'http.sock');
  server.once('listening', () => {writeFileSync(path, 'preserve');});
  await assert.rejects(listenPrivateSocket(server, state)); assert.equal(server.listening, false);
  assert.equal(await readFile(path, 'utf8'), 'preserve');
});
