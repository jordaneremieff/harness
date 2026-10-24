import assert from 'node:assert/strict';
import fs, { appendFile, mkdtemp, type open, rename, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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

async function onRead(t: test.TestContext, path: string, action: (position: number, length: number, bytesRead: number) => Promise<void>) {
  const nativeOpen = fs.open;
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const file = await nativeOpen(...args);
    if (args[0] === path) {
      const read = file.read;
      t.mock.method(file, 'read', async (...values: unknown[]) => {
        const result = await Reflect.apply(read, file, values);
        await action(Number(values[3]), Number(values[2]), result.bytesRead);
        return result;
      });
    }
    return file;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

test('oversized image records release buffered parts and retain late names and clears', async t => {
  const large = message('user', [{type: 'image', data: 'a'.repeat(700 * 1024)}]) + message('assistant', 'b'.repeat(1200 * 1024));
  const saved = await fixture(t, message('user', 'first prompt') + large + line({type: 'session_info', name: 'Manual name'}));
  const concat = Buffer.concat;
  t.mock.method(Buffer, 'concat', (parts: readonly Uint8Array[], size?: number) => { assert.ok((size ?? 0) <= 256 * 1024); return concat(parts, size); });
  assert.deepEqual(await scanSessionTitle(saved.path, saved.size), {title: 'Manual name', titleSource: 'name', titleState: 'ready'});
  const cleared = await fixture(t, message('user', 'first prompt') + large + line({type: 'session_info', name: 'old'}) + line({type: 'session_info', name: ''}));
  assert.deepEqual(await scanSessionTitle(cleared.path, cleared.size), {title: 'first prompt', titleSource: 'prompt', titleState: 'ready'});
});

test('unknown first-user coverage still permits a later complete manual name', async t => {
  const giant = message('user', 'u'.repeat(600 * 1024));
  const saved = await fixture(t, giant + message('user', 'not the first') + line({type: 'session_info', name: 'Named'}));
  assert.deepEqual(await scanSessionTitle(saved.path, saved.size), {title: 'Named', titleSource: 'name', titleState: 'ready'});
  const cleared = await fixture(t, giant + line({type: 'session_info', name: 'Named'}) + line({type: 'session_info', name: ''}) + message('user', 'later'));
  assert.equal((await scanSessionTitle(cleared.path, cleared.size)).titleState, 'unavailable');
});

test('bounded type peeks distinguish root keys, nested text, escaped keys and duplicate types', async t => {
  const payload = 'p'.repeat(300 * 1024);
  for (const record of [
    line({type: 'message', message: {role: 'assistant', content: payload, type: 'session_info', name: 'nested'}}),
    line({payload: `${payload} \\"type\\":\\"session_info\\"`, type: 'message'}),
    `{"\\u0074ype":"message","payload":"${payload}"}\n`,
  ]) {
    const saved = await fixture(t, message('user', 'first') + record);
    assert.equal((await scanSessionTitle(saved.path, saved.size)).title, 'first');
  }
  for (const record of [
    line({payload, nested: {type: 'message'}}),
    `{"type":"message","payload":"${payload}","type":"session_info","name":"hidden"}\n`,
    `{"type":"message","payload":"${payload}","\\u0074ype":"session_info","name":"hidden"}\n`,
    line({type: 'session_info', name: payload}),
    `{"type":"message","payload":"${payload}`,
    line({type: 'm'.repeat(300), payload}),
    `{"type":"message","payload":${'['.repeat(129)}"${payload}"${']'.repeat(129)}}\n`,
  ]) {
    const saved = await fixture(t, message('user', 'first') + line({type: 'session_info', name: 'old'}) + record);
    assert.equal((await scanSessionTitle(saved.path, saved.size)).titleState, 'unavailable');
  }
});

test('later complete names restore coverage after unknown or oversized name records', async t => {
  for (const unknown of ['{bad json}\n', line({type: 'session_info', name: 'x'.repeat(300 * 1024)}), line({type: 'session_info', name: 4})]) {
    const saved = await fixture(t, message('user', 'first') + unknown + line({type: 'session_info', name: 'latest'}));
    assert.equal((await scanSessionTitle(saved.path, saved.size)).title, 'latest');
    const cleared = await fixture(t, message('user', 'first') + unknown + line({type: 'session_info', name: ''}));
    assert.equal((await scanSessionTitle(cleared.path, cleared.size)).title, 'first');
  }
});

test('same-file growth before open reads only the captured prefix', async t => {
  const saved = await fixture(t, message('user', 'captured'));
  const captured = await stat(saved.path);
  await appendFile(saved.path, line({type: 'session_info', name: 'appended'}));
  let readBytes = 0;
  await onRead(t, saved.path, async (position, length, bytesRead) => { assert.ok(position + length <= saved.size); readBytes += bytesRead; });
  assert.equal((await scanSessionTitle(saved.path, saved.size, captured)).title, 'captured');
  assert.equal(readBytes, saved.size);
});

test('same-file growth during the read does not include appended names or reread the prefix', async t => {
  const saved = await fixture(t, message('user', 'captured') + message('assistant', 'a'.repeat(130 * 1024)));
  const captured = await stat(saved.path); let readBytes = 0; let appended = false;
  await onRead(t, saved.path, async (position, length, bytesRead) => {
    assert.ok(position + length <= saved.size); readBytes += bytesRead;
    if (!appended) { appended = true; await appendFile(saved.path, line({type: 'session_info', name: 'outside prefix'})); }
  });
  assert.equal((await scanSessionTitle(saved.path, saved.size, captured)).title, 'captured');
  assert.equal(readBytes, saved.size);
});

test('growth beyond the physical size ceiling never expands a valid captured prefix', async t => {
  const saved = await fixture(t, message('user', 'small captured prefix'));
  const captured = await stat(saved.path);
  await truncate(saved.path, 65 * 1024 * 1024);
  let readBytes = 0;
  await onRead(t, saved.path, async (position, length, bytesRead) => { assert.ok(position + length <= saved.size); readBytes += bytesRead; });
  assert.equal((await scanSessionTitle(saved.path, saved.size, captured)).title, 'small captured prefix');
  assert.equal(readBytes, saved.size);
  assert.equal((await scanSessionTitle(saved.path, 65 * 1024 * 1024)).titleState, 'unavailable');
});

test('captured identity rejects replacement and equal-size rewrites before open', async t => {
  const saved = await fixture(t, message('user', 'first'));
  const captured = await stat(saved.path);
  await writeFile(saved.path, message('user', 'other'));
  await utimes(saved.path, 1, 1);
  assert.equal((await scanSessionTitle(saved.path, saved.size, captured)).titleState, 'unavailable');
  await rename(saved.path, `${saved.path}.old`);
  await writeFile(saved.path, message('user', 'first'));
  assert.equal((await scanSessionTitle(saved.path, saved.size, captured)).titleState, 'unavailable');
});

test('same-size rewrites during a read reject the result', async t => {
  const saved = await fixture(t, message('user', 'first'));
  let changed = false;
  await onRead(t, saved.path, async () => {
    if (!changed) { changed = true; await writeFile(saved.path, message('user', 'other')); await utimes(saved.path, 1, 1); }
  });
  assert.equal((await scanSessionTitle(saved.path, saved.size)).titleState, 'unavailable');
});

test('descriptor identity does not hide a replaced path', async t => {
  const saved = await fixture(t, message('user', 'first'));
  let changed = false;
  await onRead(t, saved.path, async () => {
    if (!changed) { changed = true; await rename(saved.path, `${saved.path}.old`); await writeFile(saved.path, message('user', 'first')); }
  });
  assert.equal((await scanSessionTitle(saved.path, saved.size)).titleState, 'unavailable');
});

test('deletion during a read never publishes the held descriptor title', async t => {
  const saved = await fixture(t, message('user', 'first'));
  let deleted = false;
  await onRead(t, saved.path, async () => { if (!deleted) { deleted = true; await rm(saved.path); } });
  assert.equal((await scanSessionTitle(saved.path, saved.size)).titleState, 'unavailable');
});

test('observed shrink rejects even when the file remains larger than the captured prefix', async t => {
  const saved = await fixture(t, message('user', 'captured'));
  const captured = await stat(saved.path);
  await appendFile(saved.path, message('assistant', 'x'.repeat(130 * 1024)));
  let changed = false;
  await onRead(t, saved.path, async () => { if (!changed) { changed = true; await truncate(saved.path, saved.size + 10); } });
  assert.equal((await scanSessionTitle(saved.path, saved.size, captured)).titleState, 'unavailable');
});

test('captured limits and the original deadline reject before unbounded read work', async t => {
  const saved = await fixture(t, message('user', 'first'));
  for (const size of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER, 64 * 1024 * 1024 + 1]) assert.equal((await scanSessionTitle(saved.path, size)).titleState, 'unavailable');
  let calls = 0;
  t.mock.method(performance, 'now', () => calls++ === 0 ? 0 : 10_001);
  assert.equal((await scanSessionTitle(saved.path, saved.size)).titleState, 'unavailable');
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
