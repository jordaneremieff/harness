import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SessionIndex } from './history-worker.mts';

const header = {type: 'session', version: 3, id: 'fixture', timestamp: '2026-01-01T00:00:00Z', cwd: '/fixture'};
function entry(id: string, parentId: string | null, text = id) {
  return {type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00Z', message: {role: 'assistant', timestamp: 1, content: [{type: 'text', text}]}};
}
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
async function fixture(t: TestContext, rows: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'ui-history-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, 'session.jsonl'); await writeFile(path, [header, ...rows].map(line).join(''));
  return {path, index: new SessionIndex(path)};
}
test('saved pages bind to the authoritative leaf rather than the final file entry', async t => {
  const {index} = await fixture(t, [entry('root', null), entry('left', 'root'), entry('right', 'root')]);
  assert.equal((await index.refresh()).lastId, 'right');
  const left = await index.page('left'); assert.deepEqual(left.entries.map(row => row.id), ['root', 'left']);
  const right = await index.page('right'); assert.deepEqual(right.entries.map(row => row.id), ['root', 'right']);
  await assert.rejects(index.page('right', 'left'), {code: 'history_limit'});
  await assert.rejects(index.output('right', 'left', 0, 0), {code: 'invalid_request'});
  assert.deepEqual(left.signatures.map(row => row[0]), ['assistant:1:#0', 'assistant:1:#1']);
});
test('incomplete trailing lines remain outside the index until the writer completes the LF record', async t => {
  const {path, index} = await fixture(t, [entry('first', null)]);
  const next = JSON.stringify(entry('next', 'first'));
  await appendFile(path, next.slice(0, 40));
  assert.equal((await index.refresh()).lastId, 'first');
  const page = await index.page('first'); assert.equal(page.coverage.complete, false); assert.match(page.coverage.reason ?? '', /partial/i);
  await assert.rejects(index.page('next'), {code: 'history_limit'});
  await appendFile(path, `${next.slice(40)}\n`);
  assert.equal((await index.refresh()).lastId, 'next');
  assert.deepEqual((await index.page('next')).entries.map(row => row.id), ['first', 'next']);
});
test('a changed path source clears offsets and rejects anchors from the old file', async t => {
  const {path, index} = await fixture(t, [entry('old', null, 'old output')]);
  await index.refresh(); await writeFile(path, line(header) + line(entry('new', null)));
  assert.equal((await index.refresh()).lastId, 'new');
  await assert.rejects(index.page('old'), {code: 'history_limit'});
  assert.deepEqual((await index.page('new')).entries.map(row => row.id), ['new']);
});
test('text output uses protected UTF-8 byte offsets without loss or credential disclosure', async t => {
  const text = `Bearer syntheticCredential\n${'雪😀'.repeat(6000)}`;
  const {index} = await fixture(t, [entry('text', null, text)]);
  const page = await index.page('text'); const part = page.entries[0]?.messages?.[0]?.parts[0];
  assert.ok(part?.type === 'text'); assert.ok(part.more); assert.equal(part.more.entryId, 'text');
  assert.ok(Buffer.byteLength(part.text) <= 8192); assert.ok(!part.text.includes('syntheticCredential'));
  let output = part.text, offset: number | null = part.more.offset;
  while (offset !== null) {
    const chunk = await index.output('text', 'text', 0, offset);
    assert.ok(Buffer.byteLength(chunk.text) <= 8192); assert.ok(!chunk.text.includes('\ufffd'));
    output += chunk.text; offset = chunk.nextOffset;
  }
  assert.equal(output, `Bearer [redacted]\n${'雪😀'.repeat(6000)}`);
  await assert.rejects(index.output('text', 'missing', 0, 0), {code: 'invalid_request'});
  await assert.rejects(index.output('text', 'text', 5, 0), {code: 'invalid_request'});
  await assert.rejects(index.output('text', 'text', 0, 19), {code: 'invalid_request'});
});
test('a generated 25 MiB source returns bounded tail pages and reaches the root without loss', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ui-history-large-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, 'session.jsonl'); await writeFile(path, line(header));
  const count = 800, text = 'output '.repeat(4700);
  for (let start = 0; start < count; start += 25) {
    await appendFile(path, Array.from({length: 25}, (_, n) => { const i = start + n; return line(entry(`entry-${i}`, i ? `entry-${i - 1}` : null, text)); }).join(''));
  }
  const index = new SessionIndex(path); await index.refresh();
  const seen = new Set<string>(); let before: string | undefined;
  do {
    const page = await index.page(`entry-${count - 1}`, before);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 64 * 1024);
    assert.ok(page.entries.length > 0);
    for (const row of page.entries) { assert.ok(!seen.has(row.id)); seen.add(row.id); }
    before = page.coverage.omitted ? page.entries[0]?.id : undefined;
  } while (before);
  assert.equal(seen.size, count); assert.ok(seen.has('entry-0'));
});
test('literal truncation labels and hidden custom text retain their defined display behavior', async t => {
  const visible = entry('visible', null, 'literal\n[truncated]');
  const hidden = {type: 'message', id: 'hidden', parentId: 'visible', message: {role: 'custom', display: false, content: 'private hidden text'}};
  const {index} = await fixture(t, [visible, hidden]);
  const page = await index.page('hidden');
  const part = page.entries[0]?.messages?.[0]?.parts[0]; assert.ok(part?.type === 'text');
  assert.equal(part.text, 'literal\n[truncated]'); assert.equal(part.more, undefined);
  assert.deepEqual(page.entries[1]?.messages?.[0]?.parts, []);
  await assert.rejects(index.output('hidden', 'hidden', 0, 0), {code: 'invalid_request'});
});
test('a malformed full record fails visibly rather than discarding its branch content', async t => {
  const {path, index} = await fixture(t, [entry('first', null)]);
  await appendFile(path, '{not-json}\n'); await assert.rejects(index.refresh(), {code: 'history_limit'});
});
