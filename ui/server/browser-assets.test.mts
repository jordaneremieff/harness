import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {assertBrowserAssetsFresh,browserSourceFiles,STALE_ASSETS_MESSAGE} from './browser-assets.mts';

const checkout = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OLD = new Date('2026-01-01T00:00:00Z'), NEW = new Date('2026-01-02T00:00:00Z');
const CONFIG = {include: ['./*.ts', '../shared/api.ts'], compilerOptions: {rootDir: '..', outDir: '../dist'}};
async function write(root: string, path: string, text: string, time: Date) {
  await mkdir(join(root, path, '..'), {recursive: true});
  await writeFile(join(root, path), text);
  await utimes(join(root, path), time, time);
}
async function fixture(context: test.TestContext, config: object = CONFIG) {
  const root = await mkdtemp(join(tmpdir(), 'ui-browser-assets-'));
  context.after(() => rm(root, {recursive: true}));
  await write(root, 'ui/web/tsconfig.json', JSON.stringify(config), OLD);
  await write(root, 'ui/web/app.ts', "import {api} from '../shared/api.ts';\nexport const app = api;", OLD);
  await write(root, 'ui/shared/api.ts', "export * from './version.ts';\nexport const api = 1;", OLD);
  await write(root, 'ui/shared/version.ts', 'export const version = 1;', OLD);
  await write(root, 'ui/shared/unused.ts', 'export const unused = 1;', OLD);
  return root;
}
const emit = async (root: string, time: Date) => {
  for (const path of ['ui/dist/web/app.js', 'ui/dist/shared/api.js', 'ui/dist/shared/version.js']) await write(root, path, 'export {};', time);
};

test('compiler inputs are the included files plus the relative modules they import, without unreferenced siblings', async context => {
  const root = await fixture(context);
  assert.deepEqual(await browserSourceFiles(root), ['ui/shared/api.ts', 'ui/shared/version.ts', 'ui/web/app.ts']);
});

test('emitted modules at least as new as every input are accepted', async context => {
  const root = await fixture(context);
  await emit(root, NEW);
  await assertBrowserAssetsFresh(root);
  await emit(root, OLD);
  await assertBrowserAssetsFresh(root);
});

test('a missing emitted file refuses, including one for an imported module', async context => {
  const root = await fixture(context);
  await assert.rejects(() => assertBrowserAssetsFresh(root), {message: STALE_ASSETS_MESSAGE});
  await emit(root, NEW);
  await rm(join(root, 'ui/dist/shared/version.js'));
  await assert.rejects(() => assertBrowserAssetsFresh(root), {message: STALE_ASSETS_MESSAGE});
});

test('an emitted file older than its source or the tsconfig refuses', async context => {
  const root = await fixture(context);
  await emit(root, NEW);
  await write(root, 'ui/shared/version.ts', 'export const version = 2;', new Date(NEW.getTime() + 1000));
  await assert.rejects(() => assertBrowserAssetsFresh(root), {message: STALE_ASSETS_MESSAGE});
  await emit(root, new Date(NEW.getTime() + 2000));
  await assertBrowserAssetsFresh(root);
  await write(root, 'ui/web/tsconfig.json', JSON.stringify(CONFIG), new Date(NEW.getTime() + 3000));
  await assert.rejects(() => assertBrowserAssetsFresh(root), {message: STALE_ASSETS_MESSAGE});
});

test('a new import of a previously unreferenced module requires its emitted file', async context => {
  const root = await fixture(context);
  await emit(root, NEW);
  await write(root, 'ui/web/app.ts', "import {unused} from '../shared/unused.ts';\nexport const app = unused;", OLD);
  await assert.rejects(() => assertBrowserAssetsFresh(root), {message: STALE_ASSETS_MESSAGE});
});

test('unsupported compiler configuration shapes refuse instead of checking a partial set', async context => {
  const cases: [object, RegExp][] = [
    [{...CONFIG, extends: '../tsconfig.json'}, /must not extend/],
    [{...CONFIG, include: ['./**/*.ts']}, /directory-level/],
    [{...CONFIG, include: ['../../../outside/*.ts']}, /leaves the checkout/],
    [{compilerOptions: CONFIG.compilerOptions}, /must list/],
  ];
  for (const [config, pattern] of cases) await assert.rejects(async () => assertBrowserAssetsFresh(await fixture(context, config)), pattern);
  await assert.rejects(async () => {const root = await fixture(context, {include: CONFIG.include}); await emit(root, NEW); await assertBrowserAssetsFresh(root);}, /rootDir and outDir/);
});

test('the checked inputs equal the set of project source files the browser compiler reads', async () => {
  const tsc = join(checkout, 'node_modules/typescript/bin/tsc');
  const {stdout} = await promisify(execFile)(process.execPath, [tsc, '-p', 'ui/web/tsconfig.json', '--listFilesOnly'], {cwd: checkout, maxBuffer: 8 * 1024 * 1024});
  const read = stdout.split('\n').filter(Boolean).map(path => relative(checkout, path)).filter(path => !path.startsWith('..') && !path.startsWith('node_modules'));
  assert.deepEqual(await browserSourceFiles(checkout), read.sort());
});
