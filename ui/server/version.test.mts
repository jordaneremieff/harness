import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UI_ITERATION, readIdentity } from '../shared/version.ts';
import { assetDigest, collectIdentity, identityDocument, uiModified, type GitExec } from './version.mts';
const commit = 'a'.repeat(40), date = '2026-10-12T01:00:00.000Z';
const assets = new Map([['/web/app.js', {type: 'text/javascript', data: Buffer.from('export {};')}], ['/', {type: 'text/html', data: Buffer.from('<head></head><body>Fixture</body>')}]]);
const moduleAsset = assets.get('/web/app.js'), pageAsset = assets.get('/'); assert.ok(moduleAsset); assert.ok(pageAsset);

test('UI dirty status excludes unrelated and ignored paths, and follows both rename paths', () => {
  for (const value of ['', ' M docs/guide.md\0', '?? notes.txt\0', '!! ui/dist/app.js\0', ' M guide/ui/file.ts\0']) assert.equal(uiModified(value), false, value);
  for (const value of [' M ui/web/app.ts\0', 'M  ui/shared/version.ts\0', '?? ui/new file.ts\0', ' D ui/old.ts\0',
    'R  docs/moved.ts\0ui/old.ts\0', 'R  ui/new.ts\0docs/old.ts\0', 'UU ui/conflict.ts\0']) assert.equal(uiModified(value), true, value);
});
test('served asset fingerprints bind bytes, route and MIME type but not map insertion order', () => {
  assert.equal(assetDigest(assets), assetDigest(new Map([...assets].reverse())));
  assert.notEqual(assetDigest(assets), assetDigest(new Map([['/web/app.js', {type: 'text/javascript', data: Buffer.from('changed')}]])));
  assert.notEqual(assetDigest(assets), assetDigest(new Map([...assets, ['/other.js', moduleAsset]])));
});
test('startup Git uses package-root argument arrays without a shell or optional index writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ui-version-')); t.after(() => rm(root, {recursive: true, force: true}));
  const calls: string[][] = [];
  const execute: GitExec = async (command, args, options) => {
    assert.equal(command, 'git'); assert.equal(options.cwd, root); assert.equal(options.shell, false);
    assert.equal(options.maxBuffer, 256 * 1024); assert.equal(options.timeout, 3000);
    assert.deepEqual(args.slice(0, 3), ['-c', 'core.hooksPath=/dev/null', '--no-optional-locks']);
    const flags = args.slice(3); calls.push(flags);
    if (flags[0] === 'rev-parse' && flags[1] === '--show-toplevel') return root;
    if (flags[0] === 'show') return `${commit}\0aaaaaaa\0${date}\n`;
    if (flags[0] === 'status') return '?? ui/local.ts\0';
    return 'feature/ui\n';
  };
  await mkdir(join(root, 'ui/dist/web'), {recursive: true}); const path = join(root, 'ui/dist/web/app.js');
  await writeFile(path, 'export {};'); await utimes(path, new Date(date), new Date(date));
  const identity = await collectIdentity(assets, {root, execute, startedAt: date});
  assert.deepEqual(identity.git, {commit, shortCommit: 'aaaaaaa', branch: 'feature/ui', modified: true, committedAt: date});
  assert.equal(identity.assets?.builtAt, date); assert.equal(identity.assets?.digest, assetDigest(assets));
  assert.equal(identity.startedAt, date); assert.ok(identity.pi); assert.ok(identity.durable);
  assert.match(identity.pi, /^\d+\.\d+\.\d+/); assert.match(identity.durable, /^\d+\.\d+\.\d+/);
  assert.ok(calls.some(args => JSON.stringify(args) === JSON.stringify(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', 'ui/'])));
  const html = identityDocument(pageAsset, identity, 10000).data.toString();
  const meta = /name="ui-identity" content="([^"]*)"/.exec(html); assert.ok(meta?.[1]);
  assert.deepEqual(readIdentity(meta[1]), identity);
});
test('a non-Git package and a package nested in another repository expose only the declaration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ui-no-git-')); t.after(() => rm(root, {recursive: true, force: true}));
  const missing: GitExec = async () => {throw new Error('not a repository');};
  assert.deepEqual(await collectIdentity(assets, {root, execute: missing}), {iteration: UI_ITERATION});
  const parent: GitExec = async () => tmpdir();
  assert.deepEqual(await collectIdentity(assets, {root, execute: parent}), {iteration: UI_ITERATION});
});
test('detached HEAD and absent build files remain explicit instead of invented', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ui-detached-')); t.after(() => rm(root, {recursive: true, force: true}));
  const execute: GitExec = async (_command, args) => args.includes('--show-toplevel') ? root : args.includes('show') ? `${commit}\0aaaaaaa\0${date}` : args.includes('status') ? '' : 'HEAD';
  const identity = await collectIdentity(assets, {root, execute});
  assert.equal(identity.git?.branch, 'detached'); assert.equal(identity.git?.modified, false); assert.equal(identity.assets?.builtAt, undefined);
  const build = {digest: 'b'.repeat(64), builtAt: date};
  assert.deepEqual((await collectIdentity(assets, {root, execute, build})).assets, build);
});
test('encoded identity cannot create markup and obeys the document byte bound', () => {
  const identity = {iteration: '<img src=x onerror=bad>'};
  const document = identityDocument(pageAsset, identity, 10000).data.toString();
  assert.equal(document.includes('<img'), false); assert.equal(document.includes('onerror='), false);
  assert.throws(() => identityDocument(pageAsset, identity, 20), (error: unknown) => (error as {code?: string}).code === 'capacity');
});
