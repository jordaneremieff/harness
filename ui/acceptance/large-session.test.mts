import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { calibratedSpan, copySession, distribution, hashChanges, isPromptInput, options, richSyntheticSession, servedAssets, sourceHashes, syntheticOutputText, syntheticSession } from './large-session.mts';

const project = '/disposable-project';
test('prompt guard matches only actual plural primary and agent input routes including queries', () => {
  for (const path of ['/api/primaries/key/inputs', '/api/primaries/key/inputs?workspace=x', '/api/agents/key/inputs', '/api/agents/key%3A1/inputs?workspace=x']) {
    assert(isPromptInput('POST', path)); assert(!isPromptInput('GET', path));
  }
  for (const path of ['/api/primaries/key/input', '/api/agents/key/input?workspace=x', '/api/primaries/key/inputs-more', '/api/agents/key/inputs/extra']) assert(!isPromptInput('POST', path));
});
test('rich synthetic fixture has a linked tool and thinking cohort above 25 MiB', () => {
  const source = richSyntheticSession(project); assert(source.length >= 25 * 1024 * 1024);
  const entries = source.toString().trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.shift().version, 3); assert.equal(entries.length % 3, 0); assert(entries.length > 3000);
  let parent: string | null = null;
  for (let index = 0; index < entries.length; index += 3) {
    const [user, owner, result] = entries.slice(index, index + 3);
    assert.equal(user.parentId, parent); assert.equal(owner.parentId, user.id); assert.equal(result.parentId, owner.id);
    assert.equal(user.message.role, 'user'); assert.equal(owner.message.content[0].type, 'thinking');
    assert.equal(owner.message.content[1].type, 'toolCall'); assert.equal(result.message.role, 'toolResult');
    assert.equal(result.message.toolCallId, owner.message.content[1].id); assert.equal(owner.message.usage.cost.total, 0);
    parent = result.id;
  }
  assert(options(['--rich']).rich); assert.throws(() => options(['--rich', '--session', 'file']), /synthetic input/);
});
test('source inventory binds runtime, stylesheet, markup and icons with byte bounds', async () => {
  const root = await mkdtemp(join(homedir(), 'Workspace', 'dump', 'source-binding-'));
  try {
    for (const directory of ['server', 'rpc', 'agents', 'shared', 'web', 'dist/web', 'dist/shared']) await mkdir(join(root, directory), {recursive:true});
    for (const path of ['rpc/client.mts', 'rpc/events.mts', 'rpc/session.mts', 'web/style.css', 'web/index.html', 'web/icons.ts', 'dist/web/icons.js']) await writeFile(join(root, path), path);
    await writeFile(join(root, 'rpc/client.test.mts'), 'not runtime');
    const before = await sourceHashes(pathToFileURL(`${root}/`));
    assert.equal(Object.keys(before).length, 7); assert(!('../rpc/client.test.mts' in before));
    assert.match(before['../web/style.css'] ?? '', /^[a-f0-9]{64}$/);
    await writeFile(join(root, 'rpc/client.mts'), 'changed');
    assert.deepEqual(hashChanges(before, await sourceHashes(pathToFileURL(`${root}/`))), ['../rpc/client.mts']);
    await writeFile(join(root, 'web/icons.ts'), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(sourceHashes(pathToFileURL(`${root}/`)), /byte bound/);
  } finally { await rm(root, {recursive:true,force:true}); }
});
test('hash comparison detects inventory additions and removals independent of order', () => {
  assert.deepEqual(hashChanges({a:'1', b:'2'}, {b:'2', a:'1'}), []);
  assert.deepEqual(hashChanges({a:'1', removed:'2'}, {a:'3', added:'4'}), ['a', 'added', 'removed']);
});
test('served inventory maps exact HTTP asset paths and refuses missing frozen builds', () => {
  const hashes = {'../web/index.html':'html', '../web/style.css':'css', '../dist/shared/api.js':'api', '../dist/web/app.js':'app', '../dist/web/icons.js':'icons', '../web/icons.ts':'source'};
  assert.deepEqual(servedAssets(hashes).map(asset => asset.path), ['/', '/shared/api.js', '/style.css', '/web/app.js', '/web/icons.js']);
  assert.equal(servedAssets(hashes).find(asset => asset.path === '/style.css')?.hash, 'css');
  assert.throws(() => servedAssets({}), /Missing served asset/);
  assert.throws(() => servedAssets({...hashes, '../dist/web/app.js':''}), /Missing served asset/);
});
test('copy changes only the header project and removes an external parent reference', () => {
  const header = { type: 'session', version: 3, id: 'session-id', cwd: '/original-project', parentSession: '/original-parent', timestamp: '2026-01-01T00:00:00.000Z' };
  const entries = Buffer.from('{"type":"message","id":"1","message":{"content":"Unicode: ☃"}}\r\n{"type":"custom","id":"2","data":{"value":1}}\n');
  const source = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), entries]);
  const original = Buffer.from(source);
  const copy = copySession(source, project);
  const boundary = copy.indexOf(10);
  assert.deepEqual(JSON.parse(copy.subarray(0, boundary).toString()), { type: 'session', version: 3, id: header.id, cwd: project, timestamp: header.timestamp });
  assert.deepEqual(copy.subarray(boundary + 1), entries);
  assert.deepEqual(source, original);
});
test('copy rejects malformed or non-current session headers', () => {
  assert.throws(() => copySession(Buffer.from('{}'), project), /no entries/);
  assert.throws(() => copySession(Buffer.from('not json\n{}\n'), project), SyntaxError);
  for (const header of [{ type: 'message', version: 3 }, { type: 'session', version: 2 }, { type: 'session' }]) {
    assert.throws(() => copySession(Buffer.from(`${JSON.stringify(header)}\n{}\n`), project), /version 3/);
  }
});
test('synthetic session reaches 25 MiB with a current linked branch', () => {
  const source = syntheticSession(project);
  assert(source.length >= 25 * 1024 * 1024);
  assert(source.length < 25 * 1024 * 1024 + 256 * 1024);
  const lines = source.toString().trimEnd().split('\n').map(line => JSON.parse(line));
  const header = lines.shift();
  assert.equal(header.cwd, project); assert.equal(header.type, 'session'); assert.equal(header.version, 3);
  let previous: string | null = null;
  for (const entry of lines.filter(entry => !entry.id.startsWith('fixture-'))) {
    assert.equal(entry.parentId, previous); assert.equal(entry.type, 'message');
    assert.equal(entry.message.role, 'user'); assert(entry.message.content.startsWith('Retained message'));
    previous = entry.id;
  }
  assert.equal(lines.find(entry => entry.id === 'fixture-inactive').parentId, null);
  assert.equal(lines.find(entry => entry.id === 'fixture-hidden').parentId, previous);
  assert.equal(lines.find(entry => entry.id === 'fixture-hidden').message.display, false);
  assert.equal(lines.find(entry => entry.id === 'fixture-redacted').message.content[0].redacted, true);
  assert.equal(lines.at(-1).id, 'fixture-output');
  assert.equal(lines.at(-1).message.content, syntheticOutputText());
  assert(syntheticOutputText().length > 8192 * 10); assert(syntheticOutputText().endsWith('END-OUTPUT'));
  assert.equal(syntheticOutputText().indexOf('Bearer'), 8188);
  assert.match(syntheticOutputText(), /\bBearer\s+synthetic-page-boundary-token/);
  assert(lines.length > 1000);
});
test('latency distributions use nearest ranks without changing the samples', () => {
  const samples = [40, 10, 20, 30];
  assert.deepEqual(distribution(samples), { count: 4, minMs: 10, medianMs: 20, p95Ms: 40, maxMs: 40 });
  assert.deepEqual(samples, [40, 10, 20, 30]);
  assert.deepEqual(distribution([]), { count: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null });
  assert.equal(distribution([0]).medianMs, 0);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => distribution([value]), /Invalid latency/);
});
test('CLI defaults to synthetic input and bounds explicit page limits', () => {
  assert.equal(options([]).session, undefined); assert.equal(options([]).pi, 'pi');
  assert.equal(options(['--session', 'fixture.jsonl', '--out', 'captures', '--max-pages', '5']).maxPages, 5);
  for (const value of ['0', '-1', '1.5', '10001', 'NaN']) assert.throws(() => options([`--max-pages=${value}`]), /page limit/);
  assert.throws(() => options(['--unknown']), /Unknown option/);
});
test('clock calibration brackets spans and accounts for roundtrip uncertainty', () => {
  const samples = [{ backend: {epoch: 1105, start: 100, end: 110, timeOrigin: 1000}, browser: {epoch: 2135, start: 120, end: 150, timeOrigin: 2000} }];
  const span = calibratedSpan(1300, 2400, samples);
  assert.equal(span.relativeOffsetMinMs, 980); assert.equal(span.relativeOffsetMaxMs, 1020);
  assert.equal(span.estimateMs, 100); assert.equal(span.lowerMs, 78); assert.equal(span.upperMs, 122);
  assert.equal(span.uncertaintyMs, 22);
  assert.throws(() => calibratedSpan(0, 0, []), /Invalid clock/);
  assert.throws(() => calibratedSpan(Number.NaN, 0, samples), /Invalid clock/);
  assert.throws(() => calibratedSpan(0, 0, [{...samples[0], backend: {...samples[0].backend, end: 1}}]), /Invalid clock/);
});
