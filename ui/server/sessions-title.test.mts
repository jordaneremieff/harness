import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import test from 'node:test';
import { scanSessionTitle, sessionRecord } from './sessions-title.mts';

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const message = (role: string, content: unknown) => line({type: 'message', message: {role, content}});
async function fixture(t: test.TestContext, body: string) {
  const root = await mkdtemp(join(tmpdir(), 'ui-title-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'session.jsonl'); await writeFile(path, body);
  return {path, size: Buffer.byteLength(body)};
}

test('session records accept only complete JSON objects', () => {
  for (const value of ['', '  \t', '{', 'not json', 'null', '[]', '[{}]', '42', 'true', '"text"', '{}\n{}']) assert.equal(sessionRecord(value), null);
  assert.deepEqual(sessionRecord(' {"type":"session","id":"saved"} \n'), {type: 'session', id: 'saved'});
  assert.deepEqual(sessionRecord('{}'), {});
});

test('complete bounded system records preserve the first user excerpt up to 200 characters', async t => {
  const body = line({type: 'session', id: 'id', cwd: '/project'}) + message('system', 's'.repeat(200 * 1024)).repeat(3) + message('user', 'u'.repeat(300)) + message('user', 'later user');
  const {path, size} = await fixture(t, body);
  assert.deepEqual(await scanSessionTitle(path, size), {title: 'u'.repeat(200), titleSource: 'prompt', titleState: 'ready'});
});

test('complete scans find late users and the latest name or clear', async t => {
  const base = line({type: 'session'}) + message('system', 's'.repeat(64 * 1024)).repeat(34);
  const late = await fixture(t, base + message('user', 'late complete prompt'));
  assert.deepEqual(await scanSessionTitle(late.path, late.size), {title: 'late complete prompt', titleSource: 'prompt', titleState: 'ready'});
  const named = await fixture(t, base + line({type: 'session_info', name: 'old'}) + line({type: 'session_info', name: 'latest'}));
  assert.deepEqual(await scanSessionTitle(named.path, named.size), {title: 'latest', titleSource: 'name', titleState: 'ready'});
  const cleared = await fixture(t, message('user', 'first') + base + line({type: 'session_info', name: 'old'}) + line({type: 'session_info', name: ''}));
  assert.deepEqual(await scanSessionTitle(cleared.path, cleared.size), {title: 'first', titleSource: 'prompt', titleState: 'ready'});
});

test('blank first lines retain the first nonblank line of the same first user message',async t=>{
  for(const content of ['\n  \r\nUseful first prompt\nSecond line',[{type:'text',text:'\n  \nUseful first prompt\nSecond line'}]]){
    const saved=await fixture(t,message('user',content)+message('user','Later prompt'));
    assert.deepEqual(await scanSessionTitle(saved.path,saved.size),{title:'Useful first prompt',titleSource:'prompt',titleState:'ready'});
  }
  const named=await fixture(t,message('user','\nUseful prompt')+line({type:'session_info',name:'Manual name'}));
  assert.deepEqual(await scanSessionTitle(named.path,named.size),{title:'Manual name',titleSource:'name',titleState:'ready'});
  const invalid=await fixture(t,`${message('user','\nUseful prompt')}{bad json}\n`);
  assert.equal((await scanSessionTitle(invalid.path,invalid.size)).titleState,'unavailable');
});

test('chunk-spanning UTF-8 records and final non-newline user records preserve text', async t => {
  const body = message('system', 'é'.repeat(64000)) + message('user', 'First café').trimEnd();
  const {path, size} = await fixture(t, body);
  assert.deepEqual(await scanSessionTitle(path, size), {title: 'First café', titleSource: 'prompt', titleState: 'ready'});
});

test('an oversized first user never becomes the short later user', async t => {
  const {path, size} = await fixture(t, message('user', 'u'.repeat(600 * 1024)) + message('user', 'later text'));
  assert.deepEqual(await scanSessionTitle(path, size), {title: '(title unavailable)', titleState: 'unavailable'});
});

test('first image-only user does not become a later text user', async t => {
  const {path, size} = await fixture(t, message('user', [{type: 'image', data: 'image'}]) + message('user', 'later'));
  assert.equal((await scanSessionTitle(path, size)).titleState, 'unavailable');
});

test('dense complete records yield within the loop bound', async t => {
  const {path, size} = await fixture(t, `${line({type:'unknown'}).repeat(65536)}${message('user', 'valid')}`);
  let active = true; let maxGap = 0; let previous = performance.now();
  const monitor = (async () => {
    while (active) { await yieldLoop(); const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; }
  })();
  try { assert.equal((await scanSessionTitle(path, size)).title, 'valid'); }
  finally { active = false; await monitor; }
  t.diagnostic(`dense complete record scan: maximum event-loop gap ${maxGap.toFixed(3)} ms`);
  assert.ok(maxGap < 50, `loop gap ${maxGap} ms`);
});
