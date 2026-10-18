import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerRoot} from './file-access.mts';
import {searchFiles, searchQuery, SEARCH_LIMITS} from './file-search.mts';

async function tree(context: {after(callback: () => Promise<void>): void}, files: Record<string, string>) {
  const path = await mkdtemp(join(tmpdir(), 'ui-file-search-')); context.after(() => rm(path, {recursive: true, force: true}));
  for (const [name, text] of Object.entries(files)) {
    const parts = name.split('/'); if (parts.length > 1) await mkdir(join(path, ...parts.slice(0, -1)), {recursive: true});
    if (!name.endsWith('/')) await writeFile(join(path, name), text);
  }
  return registerRoot(path, 'root');
}
test('names rank by prefix, then name part, then path, with duplicate basenames kept apart', async context => {
  const root = await tree(context, {'src/readme.md': '', 'docs/readme.md': '', 'docs/notes-readme.txt': '', 'readme-first.md': '', 'lib/guide.md': ''});
  const result = await searchFiles(root, 'readme');
  assert.deepEqual(result.rows.map(row => row.path), ['readme-first.md', 'docs/readme.md', 'src/readme.md', 'docs/notes-readme.txt']);
  assert.equal(result.coverage.complete, true); assert.equal(result.more, false); assert.equal(result.scope, '');
  const byPath = await searchFiles(root, 'docs/note'); assert.deepEqual(byPath.rows.map(row => row.path), ['docs/notes-readme.txt']); assert.equal(byPath.scope, 'docs');
});
test('a slash query starts below that folder, and an unknown folder matches as part of a path', async context => {
  const root = await tree(context, {'a/b/target.ts': '', 'target.ts': '', 'a/other.ts': ''});
  assert.deepEqual((await searchFiles(root, 'a/')).rows.map(row => row.path), ['a/b', 'a/other.ts', 'a/b/target.ts']);
  assert.deepEqual((await searchFiles(root, 'a/b/tar')).rows.map(row => row.path), ['a/b/target.ts']);
  assert.deepEqual((await searchFiles(root, 'zz/tar')).rows, []);
  assert.deepEqual((await searchFiles(root, '../x')).rows, []);
});
test('dependency folders are searched after other folders at their depth and nothing is excluded by name', async context => {
  const files: Record<string, string> = {'node_modules/pkg/match.js': '', 'src/match.js': ''};
  const root = await tree(context, files);
  const result = await searchFiles(root, 'match');
  assert.deepEqual(result.rows.map(row => row.path), ['src/match.js', 'node_modules/pkg/match.js']);
});
test('symbolic links and version-control folders are skipped and reported', async context => {
  const root = await tree(context, {'real/file.txt': '', '.git/config': '', 'outside.txt': ''});
  await symlink(join(root.path, 'real'), join(root.path, 'link'));
  const result = await searchFiles(root, 'file');
  assert.deepEqual(result.rows.map(row => row.path), ['real/file.txt']);
  assert.equal(result.coverage.skipped >= 1, true); assert.equal(result.coverage.complete, false);
});
test('the walk stops at its bounds and says the search covered part of the folder', async context => {
  const files: Record<string, string> = {};
  for (let index = 0; index < SEARCH_LIMITS.matches + 8; index++) files[`m${String(index).padStart(3, '0')}.txt`] = '';
  const root = await tree(context, files);
  const capped = await searchFiles(root, 'm');
  assert.equal(capped.rows.length, SEARCH_LIMITS.rows); assert.equal(capped.more, true); assert.equal(capped.coverage.complete, false); assert.match(capped.coverage.reason ?? '', /Searched part of the folder/);
  let deep = 'x'; const nested: Record<string, string> = {}; for (let depth = 0; depth < SEARCH_LIMITS.depth + 2; depth++) deep += `/d${depth}`; nested[`${deep}/needle.txt`] = '';
  const deepRoot = await tree(context, nested);
  const shallow = await searchFiles(deepRoot, 'needle'); assert.deepEqual(shallow.rows, []); assert.match(shallow.coverage.reason ?? '', /depth bound/);
});
test('queries are bounded text and the empty query lists the shallowest entries', async context => {
  const root = await tree(context, {'a.txt': '', 'b/c.txt': ''});
  assert.throws(() => searchQuery('x'.repeat(SEARCH_LIMITS.queryChars + 1)), {code: 'invalid_request'}); assert.throws(() => searchQuery('a\u0000b'), {code: 'invalid_request'});
  assert.deepEqual((await searchFiles(root, '')).rows.map(row => row.path), ['a.txt', 'b', 'b/c.txt']);
});
