import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {copyReleaseSource, packageEntryDrivers, packagedSourcePath} from './release-package.mts';
import {inventory, manifestAt, readManifest, sha256} from './release-store.mts';
import {main} from './main.mts';
import {BROWSER_API, RELEASE_FORMAT} from '../shared/release.ts';
import {OWNER_PROTOCOL} from '../shared/owner.ts';

const run = promisify(execFile);
async function fixture(context: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ui-code-package-')));
  context.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'source'), directory = join(root, 'sealed');
  const data: Record<string, string> = {
    'package.json': '{"type":"module"}', LICENSE: 'Fixture licence notice',
    'ui/server/main.mts': `export const marker='main';export const parseArgs=()=>[];export async function main(args=[],observation={}) {process.stdout.write(JSON.stringify({args,root:observation.releaseDirectory})+'\\n');return 0;}`,
    'ui/server/backend.mts': `export const marker='backend';export async function cli(root) {process.stdout.write(JSON.stringify({root})+'\\n');}`,
    'ui/server/example.test.mts': 'not shipped',
    'ui/web/index.html': '<html/>', 'ui/web/style.css': 'body{}', 'ui/web/favicon.svg': '<svg/>',
    'ui/web/app.ts': 'export {};', 'ui/dist/web/app.js': 'export {};',
    'transport/index.ts': 'export {};', 'runtime/cli.mts': 'export {};',
    'extensions/agent/index.ts': 'export {};', 'scripts/worktrees.mts': 'export {};',
  };
  for (const [path, value] of Object.entries(data)) {
    await mkdir(join(source, path, '..'), {recursive: true});
    await writeFile(join(source, path), value);
  }
  const inputs = new Map<string, Awaited<ReturnType<typeof inventory>>>();
  for (const name of ['ui/server', 'ui/web', 'ui/dist', 'transport', 'runtime', 'extensions/agent', 'scripts']) inputs.set(name, await inventory(join(source, name)));
  return {root, source, directory, inputs};
}
function manifest(files: Record<string, string>) {
  const hash = 'a'.repeat(64), now = new Date().toISOString();
  return {format: RELEASE_FORMAT, id: hash, sourceCommit: 'b'.repeat(40), sourceTree: 'c'.repeat(40), runtimeDigest: hash,
    lockDigest: hash, assetDigest: hash, generation: hash, moduleFamily: hash, stagedAt: now, committedAt: now,
    iteration: '1.6', branch: 'fixture', ownerProtocol: OWNER_PROTOCOL, browserApi: BROWSER_API, files, imports: {}};
}

test('one code package retains browser paths, notices, full hashes and the current owner inventory vocabulary', async context => {
  const f = await fixture(context), files = await copyReleaseSource(f.source, f.directory, f.inputs);
  const expected = ['ui/package/runtime/cli.mts', 'ui/package/extensions/agent/index.ts', 'ui/package/scripts/worktrees.mts',
    'ui/package/transport/index.ts', 'ui/package/package.json', 'ui/package/LICENSE', 'ui/package/ui/web/app.ts',
    'ui/package/ui/server/main-implementation.mts', 'ui/package/ui/server/backend-implementation.mts',
    'ui/dist/web/app.js', 'ui/web/index.html', 'ui/web/style.css', 'ui/web/favicon.svg', ...packageEntryDrivers().keys()].sort();
  assert.deepEqual(Object.keys(files).sort(), expected);
  assert.deepEqual((await inventory(f.directory)).filter(entry => !entry.directory).map(entry => entry.path).sort(), expected);
  for (const [path, digest] of Object.entries(files)) {
    assert.match(path, /^(?:package\.json|(?:ui|transport)\/[a-zA-Z0-9_./-]+)$/);
    assert.equal(sha256(await readFile(join(f.directory, path))), digest);
  }
  assert.equal(await readFile(join(f.directory, 'ui/package/LICENSE'), 'utf8'), 'Fixture licence notice');
  assert.doesNotThrow(() => readManifest(manifest(files)));
  for (const path of ['runtime/cli.mts', 'scripts/worktrees.mts', 'extensions/agent/index.ts']) assert.throws(() => readManifest(manifest({[path]: 'a'.repeat(64)})), /file inventory/);
  await writeFile(join(f.directory, 'release.json'), JSON.stringify(manifest(files)));
  await manifestAt(f.directory, true);
  await writeFile(join(f.directory, 'ui/package/runtime/cli.mts'), 'tampered');
  await assert.rejects(() => manifestAt(f.directory, true), /integrity mismatch/);
});

test('inner and outer drivers retain exports, import without execution and directly use the outer release root', async context => {
  const f = await fixture(context); await copyReleaseSource(f.source, f.directory, f.inputs);
  for (const path of packageEntryDrivers().keys()) {
    const entry = join(f.directory, path), url = pathToFileURL(entry).href;
    const imported = await run(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(url)});console.log(JSON.stringify({marker:m.marker,entry:typeof m.${path.endsWith('/main.mts') ? 'main' : 'cli'}}));`]);
    assert.deepEqual(JSON.parse(imported.stdout), {marker: path.endsWith('/main.mts') ? 'main' : 'backend', entry: 'function'});
    const invoked = await run(process.execPath, [entry, 'fixture']);
    assert.equal(resolve(JSON.parse(invoked.stdout).root), f.directory);
  }
});

test('a packaged main refuses an absent outer manifest instead of staging from the code package', async context => {
  const f = await fixture(context);
  await assert.rejects(() => main(['--cwd', f.source, '--state-dir', join(f.root, 'state'), '--port', '0'], {releaseDirectory: f.source}), {code: 'ENOENT'});
});

test('capture refuses missing implementation entries and changed reserved bytes', async context => {
  const f = await fixture(context);
  await writeFile(join(f.source, 'runtime/cli.mts'), 'different reserved size');
  await assert.rejects(() => copyReleaseSource(f.source, f.directory, f.inputs), /staging reservation/);
  const other = join(f.root, 'missing');
  await assert.rejects(() => copyReleaseSource(f.source, other, new Map()), /implementation entrypoint/);
  assert.equal(packagedSourcePath('ui/dist/web/app.js'), 'ui/dist/web/app.js');
});
