import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import test from 'node:test';
import { scanSessionTitle } from './sessions-title.mts';

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const message = (role: string, content: unknown) => line({type: 'message', message: {role, content}});
async function fixture(t: test.TestContext, body: string) {
  const root = await mkdtemp(join(tmpdir(), 'ui-title-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'session.jsonl'); await writeFile(path, body);
  return {path, size: Buffer.byteLength(body)};
}

test('title scans skip giant system lines and return the first user excerpt up to 200 characters', async t => {
  const body = line({type: 'session', id: 'id', cwd: '/project'}) + message('system', 's'.repeat(600 * 1024)) + message('user', 'u'.repeat(300)) + message('user', 'later user');
  const {path, size} = await fixture(t, body);
  assert.deepEqual(await scanSessionTitle(path, size), {title: 'u'.repeat(200), titleState: 'ready'});
});

test('the forward cap skips later users while the tail still supplies the latest name or clear', async t => {
  const base = line({type: 'session'}) + message('system', 's'.repeat(2 * 1024 * 1024 + 100));
  const late = await fixture(t, base + message('user', 'late outside cap'));
  assert.deepEqual(await scanSessionTitle(late.path, late.size), {title: '(title unavailable)', titleState: 'unavailable'});
  const named = await fixture(t, base + line({type: 'session_info', name: 'old'}) + line({type: 'session_info', name: 'latest'}));
  assert.deepEqual(await scanSessionTitle(named.path, named.size), {title: 'latest', titleState: 'ready'});
  const cleared = await fixture(t, message('user', 'first') + base + line({type: 'session_info', name: 'old'}) + line({type: 'session_info', name: ''}));
  assert.deepEqual(await scanSessionTitle(cleared.path, cleared.size), {title: 'first', titleState: 'ready'});
});

test('chunk-spanning UTF-8 records and final non-newline user records preserve text', async t => {
  const body = message('system', 'é'.repeat(64000)) + message('user', 'First café').trimEnd();
  const {path, size} = await fixture(t, body);
  assert.deepEqual(await scanSessionTitle(path, size), {title: 'First café', titleState: 'ready'});
});

test('an oversized first user never becomes the short later user', async t => {
  const {path, size} = await fixture(t, message('user', 'u'.repeat(600 * 1024)) + message('user', 'later text'));
  assert.deepEqual(await scanSessionTitle(path, size), {title: '(title unavailable)', titleState: 'unavailable'});
});

test('first image-only user does not become a later text user', async t => {
  const {path, size} = await fixture(t, message('user', [{type: 'image', data: 'image'}]) + message('user', 'later'));
  assert.equal((await scanSessionTitle(path, size)).titleState, 'unavailable');
});

test('dense malformed records yield within the loop bound', async t => {
  const {path, size} = await fixture(t, `${'{\n'.repeat(65536)}${message('user', 'valid')}`);
  let active = true; let maxGap = 0; let previous = performance.now();
  const monitor = (async () => {
    while (active) { await yieldLoop(); const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; }
  })();
  try { assert.equal((await scanSessionTitle(path, size)).title, 'valid'); }
  finally { active = false; await monitor; }
  t.diagnostic(`dense malformed record scan: maximum event-loop gap ${maxGap.toFixed(3)} ms`);
  assert.ok(maxGap < 50, `loop gap ${maxGap} ms`);
});
