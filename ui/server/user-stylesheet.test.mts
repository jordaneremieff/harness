import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readUserStylesheet, USER_STYLESHEET_BYTES } from './user-stylesheet.mts';

async function agentDir(context: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ui-stylesheet-test-'));
  context.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
const configured = (dir: string, file: string) => readUserStylesheet({agentDir: dir, env: {PI_UI_USER_STYLESHEET: file}});

test('an unset setting reports none', async context => {
  assert.deepEqual(await readUserStylesheet({agentDir: await agentDir(context), env: {}}), {state: 'none'});
});
test('a readable regular file is applied with its exact bytes, resolved against the agent directory', async context => {
  const dir = await agentDir(context); await writeFile(join(dir, 'mine.css'), ':root { --canvas: #101010; }');
  const result = await configured(dir, 'mine.css');
  assert.equal(result.state, 'applied'); assert.equal(result.data?.toString('utf8'), ':root { --canvas: #101010; }');
});
test('a file at the size bound is applied and one byte over is too large', async context => {
  const dir = await agentDir(context);
  await writeFile(join(dir, 'edge.css'), Buffer.alloc(USER_STYLESHEET_BYTES, 0x20));
  assert.equal((await configured(dir, 'edge.css')).state, 'applied');
  await writeFile(join(dir, 'over.css'), Buffer.alloc(USER_STYLESHEET_BYTES + 1, 0x20));
  assert.deepEqual(await configured(dir, 'over.css'), {state: 'too-large'});
});
test('missing, directory, invalid UTF-8 and invalid setting each report a fixed state', async context => {
  const dir = await agentDir(context);
  assert.deepEqual(await configured(dir, 'absent.css'), {state: 'missing'});
  await mkdir(join(dir, 'folder.css'));
  assert.deepEqual(await configured(dir, 'folder.css'), {state: 'unreadable'});
  await writeFile(join(dir, 'binary.css'), Buffer.from([0xff, 0xfe, 0x00]));
  assert.deepEqual(await configured(dir, 'binary.css'), {state: 'unreadable'});
  assert.deepEqual(await configured(dir, ''), {state: 'invalid'});
});
test('each read reflects the file as it is now', async context => {
  const dir = await agentDir(context); const file = join(dir, 'live.css');
  await writeFile(file, 'a{}'); assert.equal((await configured(dir, 'live.css')).data?.toString(), 'a{}');
  await writeFile(file, 'b{}'); assert.equal((await configured(dir, 'live.css')).data?.toString(), 'b{}');
  await rm(file); assert.deepEqual(await configured(dir, 'live.css'), {state: 'missing'});
});
