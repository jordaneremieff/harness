import assert from 'node:assert/strict';
import fs, { appendFile, chmod, mkdir, mkdtemp, open, rename, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import test from 'node:test';
import { ApiError } from './errors.mts';
import { SessionStore, validateSessionProject } from './sessions.mts';

const WINDOW = 65536;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const user = (content: unknown) => line({type: 'message', message: {role: 'user', content}});
const named = (name: unknown) => line({type: 'session_info', name});
const sessionHeader = (cwd: string, id = 'session-id') => line({type: 'session', version: 3, id, cwd});
// Pi 1.1.0 dist/core/session-manager.js getDefaultSessionDirPath uses exactly
// remove one leading slash/backslash, then replace slash/backslash/colon with '-'.
const encoded = (cwd: string) => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ui-sessions-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const agentDir = join(root, 'agent');
  const project = join(root, 'project');
  await mkdir(project);
  const dir = join(agentDir, 'sessions', encoded(project));
  await mkdir(dir, {recursive: true});
  const store = new SessionStore(agentDir);
  const save = async (name: string, body: string, cwd = project) => {
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, sessionHeader(cwd, name) + body);
    return path;
  };
  return {root, agentDir, project, dir, store, save};
}
async function ready(store: SessionStore, project: string, cursor?: string | null) {
  const page = await store.sessions(project, cursor);
  return page.titleCursor ? store.titles(project, page.titleCursor) : page;
}
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test('latest names, explicit clears, excerpts, and malformed records follow bounded JSONL rules', async t => {
  const {store, project, save, dir} = await setup(t);
  await save('named', user('first user') + named('older') + named('  newest\n name  '));
  await save('cleared', user([{type: 'image', data: 'ignored'}, {type: 'text', text: ' first '}, {type: 'text', text: ' user '}]) + named('old') + named(' '));
  await save('broken', `not json\nnull\n[]\n42\n${line({type: 'message', message: null})}${user('valid\t excerpt')}${named(9)}`);
  await save('empty', line({type: 'unknown', data: true}));
  await save('long', user('x'.repeat(300)));
  await writeFile(join(dir, 'bad-header.jsonl'), `{broken\n${user('not a session')}`);
  await writeFile(join(dir, 'wrong-header.jsonl'), line({type: 'session', id: 2, cwd: project}));
  await writeFile(join(dir, 'ignored.txt'), sessionHeader(project));
  const page = await ready(store, project);
  assert.equal(page.total, 5); assert.equal(page.omitted, 0); assert.equal(page.nextCursor, null);
  const titles = new Map(page.items.map(item => [item.id, item.title]));
  assert.equal(titles.get('named'), 'newest name'); assert.equal(titles.get('cleared'), 'first user');
  assert.equal(titles.get('broken'), 'valid excerpt'); assert.equal(titles.get('empty'), '(title unavailable)');
  assert.equal(titles.get('long')?.length, 200);
  for (const item of page.items) {
    const info = await stat(item.path); assert.equal(item.size, info.size); assert.equal(item.modifiedAt, info.mtime.toISOString());
  }
  assert.ok(Number.isFinite(Date.parse(page.observedAt)));
});

test('large files use head and tail names but never middle records or split lines', async t => {
  const {store, project, save} = await setup(t);
  const prefix = user('head excerpt') + named('head name');
  const body = `${prefix + line({type: 'message', message: {role: 'assistant', content: 'a'.repeat(WINDOW * 3)}}) + named('tail old') + named('tail latest')}{partial`;
  await save('large', body);
  await save('middle', prefix + '\n'.repeat(WINDOW) + named('middle invisible') + '\n'.repeat(WINDOW * 2));
  await save('giant', user('first') + line({type: 'message', message: {role: 'assistant', content: 'z'.repeat(WINDOW * 4)}}));
  await save('clear-tail', prefix + '\n'.repeat(WINDOW * 2) + named(''));
  const page = await ready(store, project);
  const titles = new Map(page.items.map(item => [item.id, item.title]));
  assert.equal(titles.get('large'), 'tail latest'); assert.equal(titles.get('middle'), 'head name');
  assert.equal(titles.get('giant'), 'first'); assert.equal(titles.get('clear-tail'), 'head excerpt');
});

test('adjacent windows retain complete boundary records without reordering overlapping names', async t => {
  const {store, project, dir} = await setup(t);
  const prefix = sessionHeader(project, 'boundary') + user('fallback') + named('old');
  const padding = '\n'.repeat(WINDOW - Buffer.byteLength(prefix));
  await writeFile(join(dir, 'boundary.jsonl'), prefix + padding + named('boundary name') + named('last'));
  assert.equal((await ready(store, project)).items[0].title, 'last');
  const noNewline = sessionHeader(project, 'nonl') + user('nonl excerpt') + 'x'.repeat(WINDOW * 3) + JSON.stringify({type: 'session_info', name: 'fragment'});
  await writeFile(join(dir, 'nonl.jsonl'), noNewline);
  assert.equal((await ready(store, project)).items.find(item => item.id === 'nonl')?.title, 'nonl excerpt');
});

test('encoded cwd preserves colon, backslash, hyphens, and spaces; header cwd disambiguates collisions', async t => {
  const {root, agentDir} = await setup(t);
  const project = join(root, 'space - colon: slash\\');
  await mkdir(project);
  const dir = join(agentDir, 'sessions', encoded(project)); await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'odd.jsonl'), sessionHeader(project, 'odd') + user('odd path'));
  const store = new SessionStore(agentDir);
  assert.equal((await ready(store, project)).items[0].path, join(dir, 'odd.jsonl'));
  const nested = join(root, 'a', 'b'); const dashed = join(root, 'a-b');
  await mkdir(nested, {recursive: true}); await mkdir(dashed);
  assert.equal(encoded(nested), encoded(dashed));
  const collisionDir = join(agentDir, 'sessions', encoded(nested)); await mkdir(collisionDir);
  await writeFile(join(collisionDir, 'nested.jsonl'), sessionHeader(nested, 'nested'));
  await writeFile(join(collisionDir, 'dashed.jsonl'), sessionHeader(dashed, 'dashed'));
  assert.deepEqual((await ready(store, nested)).items.map(item => item.id), ['nested']);
  assert.deepEqual((await ready(store, dashed)).items.map(item => item.id), ['dashed']);
  const projects = await store.projects();
  assert.ok(projects.items.some(item => item.path === project));
  assert.ok(projects.items.some(item => item.path === nested));
  assert.ok(projects.items.some(item => item.path === dashed));
});

test('existing filesystem alias preserves lexical lookup and canonical association checks', async t => {
  const {agentDir, project, store, save} = await setup(t);
  const alias = await realpath(project);
  if (alias === project) { t.skip('The temporary directory has no existing canonical alias.'); return; }
  assert.notEqual(encoded(alias), encoded(project));
  const original = await save('original', user('physical project'));
  const dir = join(agentDir, 'sessions', encoded(alias)); await mkdir(dir);
  const aliased = join(dir, 'alias.jsonl'); await writeFile(aliased, sessionHeader(alias, 'alias') + user('lexical project'));
  assert.deepEqual((await ready(store, alias)).items.map(item => item.id), ['alias']);
  assert.deepEqual((await ready(store, project)).items.map(item => item.id), ['original']);
  await validateSessionProject(alias, original); await validateSessionProject(project, aliased);
});

test('sessions and project pages are newest first and preserve snapshots across live changes', async t => {
  const {store, project, save} = await setup(t);
  for (let index = 0; index < 25; index++) {
    const path = await save(`s${index}`, user(`session ${index}`));
    await utimes(path, 1000 + index, 1000 + index);
  }
  const first = await ready(store, project);
  assert.equal(first.items.length, 20); assert.equal(first.total, 25); assert.equal(first.items[0].id, 's24');
  assert.ok(first.nextCursor);
  const second = await ready(store, project, first.nextCursor);
  assert.equal(second.items.length, 5); assert.equal(second.nextCursor, null); assert.equal(second.items[0].id, 's4');
  await assert.rejects(store.projects(first.nextCursor), code('invalid_cursor'));
  await assert.rejects(ready(store, project, 'not-json'), code('invalid_cursor'));
  await save('new', user('newest'));
  const retained = await ready(store, project, first.nextCursor);
  assert.equal(retained.total, 25); assert.deepEqual(retained.items, second.items);
  assert.equal((await ready(store, project)).total, 26);
  assert.equal((await ready(store, project, first.nextCursor)).total, 25);
});

test('stat invalidation detects same-size writes, append, replacement, and deletion without directory changes', async t => {
  const {store, project, save} = await setup(t);
  const path = await save('cached', named('one'));
  const first = await ready(store, project); const before = await stat(path);
  await writeFile(path, sessionHeader(project, 'cached') + named('two'));
  await utimes(path, before.atime, before.mtime);
  assert.equal((await ready(store, project)).items[0].title, 'two');
  await appendFile(path, named('three'));
  assert.equal((await ready(store, project)).items[0].title, 'three');
  const replacement = `${path}.replacement`; await writeFile(replacement, sessionHeader(project, 'cached') + named('replacement'));
  await rename(replacement, path);
  assert.equal((await ready(store, project)).items[0].title, 'replacement');
  first.items[0].title = 'caller mutation';
  assert.equal((await ready(store, project)).items[0].title, 'replacement');
  assert.equal((await store.projects()).total, 1);
  await rm(path);
  assert.equal((await ready(store, project)).total, 0); assert.equal((await store.projects()).total, 0);
});

test('projects derive cwd from headers, refresh pages, omit deleted paths, and return copies', async t => {
  const {root, agentDir, store} = await setup(t);
  const paths: string[] = [];
  for (let index = 0; index < 23; index++) {
    const project = join(root, `project-${index}`); paths.push(project); await mkdir(project);
    const dir = join(agentDir, 'sessions', `directory-${index}`); await mkdir(dir);
    const file = join(dir, 'session.jsonl'); await writeFile(file, sessionHeader(project)); await utimes(file, index + 1, index + 1);
  }
  const first = await store.projects();
  assert.equal(first.total, 23); assert.equal(first.items.length, 20); assert.equal(first.items[0].path, paths[22]);
  assert.equal(first.items[0].name, 'project-22'); assert.ok(first.nextCursor);
  assert.equal((await store.projects(first.nextCursor)).items.length, 3);
  first.items[0].name = 'caller mutation'; assert.equal((await store.projects()).items[0].name, 'project-22');
  await rm(paths[22], {recursive: true});
  assert.equal((await store.projects(first.nextCursor)).total, 23);
  assert.equal((await store.projects()).total, 22);
});

test('invalid projects and unreadable directories fail explicitly; missing session roots return empty pages', async t => {
  const {root, project, agentDir, store, dir} = await setup(t);
  const file = join(root, 'file'); await writeFile(file, 'file');
  for (const invalid of ['relative', join(root, 'missing'), file, `${project}\0`]) await assert.rejects(ready(store, invalid), code('invalid_project'));
  await chmod(project, 0);
  try { if (process.getuid?.() !== 0) await assert.rejects(ready(store, project), code('invalid_project')); }
  finally { await chmod(project, 0o700); }
  await chmod(dir, 0);
  try { if (process.getuid?.() !== 0) await assert.rejects(ready(store, project), code('sessions_unavailable')); }
  finally { await chmod(dir, 0o700); }
  const missing = new SessionStore(join(agentDir, 'missing'));
  assert.equal((await missing.sessions(project)).total, 0); assert.equal((await missing.projects()).total, 0);
});

test('manual session association uses bounded headers and canonical project paths', async t => {
  const {root, project, dir, save} = await setup(t);
  const valid = await save('valid', user('valid'));
  await validateSessionProject(join(project, '..', 'project'), valid);
  const other = join(root, 'other'); await mkdir(other);
  await assert.rejects(validateSessionProject(other, valid), code('invalid_session'));
  await assert.rejects(validateSessionProject(project, 'relative.jsonl'), code('invalid_session'));
  await assert.rejects(validateSessionProject(project, dir), code('invalid_session'));
  await assert.rejects(validateSessionProject(project, join(dir, 'absent.jsonl')), code('invalid_session'));
  const bad = join(dir, 'bad.jsonl'); await writeFile(bad, `${'x'.repeat(WINDOW + 1)}\n${sessionHeader(project)}`);
  await assert.rejects(validateSessionProject(project, bad), code('invalid_session'));
  await writeFile(bad, sessionHeader(other) + '\n'.repeat(WINDOW * 2) + sessionHeader(project));
  await assert.rejects(validateSessionProject(project, bad), code('invalid_session'));
});

test('the first physical line owns the header and tail users never become first-user excerpts', async t => {
  const {store, project, dir, save} = await setup(t);
  const blank = join(dir, 'blank.jsonl'); await writeFile(blank, `\n${sessionHeader(project)}${user('wrong header')}`);
  await assert.rejects(validateSessionProject(project, blank), code('invalid_session'));
  await save('image-first', user([{type: 'image', data: 'image'}]) + user('later text'));
  await save('tail-only', line({type: 'unknown'}) + '\n'.repeat(WINDOW * 34) + user('late prompt'));
  const page = await ready(store, project);
  assert.equal(page.total, 2);
  assert.ok(page.items.every(item => item.title === '(title unavailable)'));
});

test('session titles redact credentials and terminal controls through the shared display policy', async t => {
  const {store, project, save} = await setup(t);
  const token = `sk-${'a'.repeat(32)}`;
  await save('secret-name', named(`\u001b[31mname ${token}\u001b[0m`));
  await save('secret-user', user(`Bearer ${'b'.repeat(24)}`));
  const titles = (await ready(store, project)).items.map(item => item.title);
  assert.ok(titles.includes('name [redacted credential]'));
  assert.ok(titles.includes('Bearer [redacted]'));
  assert.ok(titles.every(title => !title.includes(token) && !title.includes('\u001b')));
});

test('project discovery checks only bounded newest headers and reports unexamined candidates', async t => {
  const {store, project, save} = await setup(t);
  for (let index = 0; index < 25; index++) await save(`candidate-${index}`, 'x'.repeat(WINDOW * 3));
  const page = await store.projects(); assert.equal(page.total, 1); assert.equal(page.omitted, 5);
  const newest = await save('invalid-newest', '');
  await writeFile(newest, `\n${sessionHeader(project)}`);
  const refreshed = await store.projects(); assert.equal(refreshed.total, 1); assert.equal(refreshed.omitted, 6);
});

test('bounded snapshot eviction rejects cursors instead of mixing inventory revisions', async t => {
  const {store, root, project, save} = await setup(t);
  for (let index = 0; index < 21; index++) await save(`s${index}`, user('page'));
  const first = await ready(store, project); assert.ok(first.nextCursor);
  for (let index = 0; index < 32; index++) {
    const other = join(root, `other-${index}`); await mkdir(other); await ready(store, other);
  }
  await assert.rejects(ready(store, project, first.nextCursor), code('cursor_stale'));
});

test('sparse multi-megabyte bodies do not delay bounded manual association validation', async t => {
  const {project, dir} = await setup(t);
  const path = join(dir, 'sparse.jsonl'); const file = await open(path, 'w');
  try { await file.write(sessionHeader(project)); await file.truncate(512 * 1024 * 1024); }
  finally { await file.close(); }
  await validateSessionProject(project, path);
});

test('concurrent pages share a refresh and keep the event loop responsive', async t => {
  const {store, project, save} = await setup(t);
  await Promise.all(Array.from({length: 160}, (_, index) => save(`f${index}`, user(`first ${index}`) + '\n'.repeat(WINDOW * 3) + named(`tail ${index}`))));
  let active = true; let ticks = 0; let maxGap = 0; let last = performance.now();
  const monitor = async () => {
    while (active) { await yieldLoop(); const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }
  };
  const measured = monitor();
  try {
    const pages = await Promise.all(Array.from({length: 8}, () => ready(store, project)));
    for (const page of pages) { assert.equal(page.total, 160); assert.deepEqual(page.items, pages[0].items); }
    assert.ok(ticks > 4);
  } finally { active = false; await measured; }
  t.diagnostic(`160 large files, 8 concurrent calls: maximum event-loop gap ${maxGap.toFixed(3)} ms`);
  assert.ok(maxGap < 50, `event loop gap ${maxGap} ms exceeds 50 ms`);
});

test('file and directory caps report omitted inventory entries explicitly', async t => {
  const {root, agentDir, project, dir, store} = await setup(t);
  for (let offset = 0; offset < 2051; offset += 32) {
    await Promise.all(Array.from({length: Math.min(32, 2051 - offset)}, (_, index) => writeFile(join(dir, `${offset + index}.jsonl`), sessionHeader(project, `id${offset + index}`))));
  }
  const sessions = await ready(store, project); assert.equal(sessions.total, 2048); assert.equal(sessions.omitted, 3);
  await rm(dir, {recursive: true});
  for (let index = 0; index < 131; index++) {
    const cwd = join(root, `p${index}`); await mkdir(cwd);
    const folder = join(agentDir, 'sessions', `d${index}`); await mkdir(folder);
    await writeFile(join(folder, 'session.jsonl'), sessionHeader(cwd));
  }
  const projects = await store.projects(); assert.equal(projects.total, 128); assert.equal(projects.omitted, 3);
});

test('entry traversal caps include excluded names and reject incomplete coverage explicitly', async t => {
  const {dir, store, project} = await setup(t);
  for (let offset = 0; offset < 8193; offset += 64) {
    await Promise.all(Array.from({length: Math.min(64, 8193 - offset)}, (_, index) => mkdir(join(dir, `excluded-${offset + index}`))));
  }
  await assert.rejects(ready(store, project), code('session_inventory_limit'));
  await assert.rejects(store.projects(), code('session_inventory_limit'));
  await rm(join(dir, 'excluded-8192'), {recursive: true});
  assert.equal((await ready(store, project)).total, 0);
});

test('title completion preserves captured metadata and starts only current-page scans', async t => {
  const {store, project, save} = await setup(t);
  for (let index = 0; index < 25; index++) {
    const path = await save(`page-${index}`, line({type: 'message', message: {role: 'system', content: 's'.repeat(WINDOW * 5)}}) + user(`first ${index}`));
    await utimes(path, index + 1, index + 1);
  }
  const first = await store.sessions(project); assert.ok(first.titleCursor);
  assert.ok(first.items.every(item => item.titleState === 'pending'));
  const completed = await store.titles(project, first.titleCursor);
  assert.equal(completed.titleCursor, null); assert.ok(completed.items.every(item => item.titleState === 'ready'));
  const metadata = (items: typeof first.items) => items.map(({title: _title, titleState: _state, ...item}) => item);
  assert.deepEqual(metadata(completed.items), metadata(first.items));
  assert.equal(completed.nextCursor, first.nextCursor); assert.equal(completed.observedAt, first.observedAt);
  const more = await store.sessions(project, first.nextCursor);
  assert.ok(more.titleCursor); assert.ok(more.items.every(item => item.titleState === 'pending'));
  await store.titles(project, more.titleCursor);
  const cached = await store.sessions(project); assert.equal(cached.titleCursor, null);
  assert.deepEqual(cached.items, completed.items);
  await rm(completed.items[0].path);
  assert.deepEqual((await store.titles(project, first.titleCursor)).items, completed.items);
});

test('file changes reject title cache updates and opaque revisions distinguish preserved-mtime rewrites', async t => {
  const {store, project, save} = await setup(t);
  const path = await save('changing', user('one'));
  const initial = await store.sessions(project); assert.ok(initial.titleCursor); const info = await stat(path);
  await writeFile(path, sessionHeader(project, 'changing') + user('two')); await utimes(path, info.atime, info.mtime);
  const old = await store.titles(project, initial.titleCursor);
  assert.ok(old.items.every(item => item.titleState === 'unavailable'));
  const fresh = await ready(store, project);
  assert.equal(fresh.items[0].title, 'two'); assert.notEqual(fresh.items[0].revision, initial.items[0].revision);
  assert.equal(fresh.items[0].size, initial.items[0].size);
  assert.equal(fresh.items[0].modifiedAt, initial.items[0].modifiedAt);
  await rm(path);
  assert.deepEqual((await store.titles(project, initial.titleCursor)).items, old.items);
});

test('explicit Refresh retries transient same-revision title failures without polling', async t => {
  const {store, project, save, dir} = await setup(t);
  const path = await save('transient', user('restored'));
  const openFile = fs.open; let fixtureOpens = 0;
  // The header opens first; hide the directory before the eager title open,
  // not after sessions() returns, which races the title job.
  const mockOpen = t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    if (args[0] === path && ++fixtureOpens === 2) await rename(dir, `${dir}-hidden`);
    return openFile(...args);
  });
  t.after(() => { mockOpen.mock.restore(); syncBuiltinESMExports(); });
  syncBuiltinESMExports();
  const page = await store.sessions(project); assert.ok(page.titleCursor);
  const failed = await store.titles(project, page.titleCursor);
  assert.equal(fixtureOpens, 2); assert.equal(failed.items[0].titleState, 'unavailable');
  await rename(`${dir}-hidden`, dir);
  const refreshed = await ready(store, project);
  assert.equal(fixtureOpens, 3); assert.equal(refreshed.items[0].titleState, 'ready');
  assert.equal(refreshed.items[0].title, 'restored'); assert.equal(refreshed.items[0].revision, page.items[0].revision);
  assert.equal((await store.titles(project, page.titleCursor)).items[0].titleState, 'unavailable');
});

test('bounded title token retention expires explicitly and rejects foreign projects', async t => {
  const {store, root, project, save} = await setup(t);
  await save('title', user('title'));
  const first = await store.sessions(project); assert.ok(first.titleCursor);
  const other = join(root, 'other'); await mkdir(other);
  await assert.rejects(store.titles(other, first.titleCursor), code('cursor_stale'));
  await assert.rejects(store.titles(project, 'unknown'), code('cursor_stale'));
  // A new store never accepts a token from another instance.
  await assert.rejects(new SessionStore().titles(project, first.titleCursor), code('cursor_stale'));
  const now = Date.now(); const clock = t.mock.method(Date, 'now', () => now + 16 * 60 * 1000);
  await assert.rejects(store.titles(project, first.titleCursor), code('cursor_stale'));
  clock.mock.restore();
  await store.titles(project, first.titleCursor);
  for (let index = 0; index < 64; index++) {
    const path = await save(`token-${index}`, user(`title ${index}`)); await utimes(path, 1000 + index, 1000 + index);
    const page = await store.sessions(project); assert.ok(page.titleCursor);
    await store.titles(project, page.titleCursor);
  }
  await assert.rejects(store.titles(project, first.titleCursor), code('cursor_stale'));
});

test('default agent directory expands tilde environment paths like statePaths', async t => {
  const root = await mkdtemp(join(homedir(), '.ui-session-test-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, {recursive: true, force: true}); });
  const project = join(root, 'project'); await mkdir(project);
  const dir = join(root, 'sessions', encoded(project)); await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'one.jsonl'), sessionHeader(project));
  process.env.PI_CODING_AGENT_DIR = `~/${root.slice(homedir().length + 1)}`;
  assert.equal((await new SessionStore().sessions(project)).total, 1);
});
