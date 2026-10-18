import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHttp, type HttpBackend } from './http.mts';
import { Journal } from './journal.mts';

const page = {items: [], total: 0, omitted: 0, nextCursor: null, titleCursor: null, observedAt: '2026-01-01T00:00:00Z'};
test('saved-session metadata routes remain open and do not dispatch runtime work', async context => {
  const calls: unknown[][] = [];
  const backend: HttpBackend = {journal: new Journal(), dispatch: async () => { throw new Error('Metadata browsing must not dispatch runtime work'); }, workspace: async () => 'workspace', observe: async () => {}, detached() {}};
  const http = new LocalHttp(backend, new Map(), {sessions: async (project, cursor) => { calls.push(['sessions', project, cursor]); return page; }, projects: async cursor => { calls.push(['projects', cursor]); return page; }, titles: async (project, cursor) => { calls.push(['titles', project, cursor]); return page; }});
  const url = new URL(await http.listen(0)); const origin = url.origin;
  context.after(() => http.close());
  const sessions = await fetch(`${origin}/api/sessions?project=%2Fproject&cursor=next`, {});
  assert.equal(sessions.status, 200); assert.deepEqual(await sessions.json(), {ok: true, data: page});
  assert.equal(sessions.headers.get('cache-control'), 'no-store');
  const projects = await fetch(`${origin}/api/projects?cursor=recent`, {});
  assert.equal(projects.status, 200); assert.deepEqual(await projects.json(), {ok: true, data: page});
  const titles = await fetch(`${origin}/api/sessions?project=%2Fproject&titles=completion`, {});
  assert.equal(titles.status, 200);
  assert.deepEqual(calls, [['sessions', '/project', 'next'], ['projects', 'recent'], ['titles', '/project', 'completion']]);
  const wrongMethod = await fetch(`${origin}/api/sessions`, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: '{}'}); assert.equal(wrongMethod.status, 405);
  const foreign = await fetch(`${origin}/api/projects`, {headers: {'Sec-Fetch-Site': 'cross-site'}}); assert.equal(foreign.status, 403);
});

test('manual saved paths validate their header project before runtime dispatch', async context => {
  const root = await mkdtemp(join(tmpdir(), 'ui-sessions-http-'));
  context.after(() => rm(root, {recursive: true, force: true}));
  const project = join(root, 'project'); const other = join(root, 'other'); await mkdir(project); await mkdir(other);
  const file = join(root, 'session.jsonl'); await writeFile(file, `${JSON.stringify({type: 'session', version: 3, id: 'saved', cwd: project})}\n`);
  let dispatched = 0;
  const backend: HttpBackend = {journal: new Journal(), dispatch: async () => { dispatched++; return {primaryKey: 'test'}; }, workspace: async () => 'workspace', observe: async () => {}, detached() {}};
  const http = new LocalHttp(backend, new Map(), {sessions: async () => page, projects: async () => page, titles: async () => page});
  const url = new URL(await http.listen(0)); context.after(() => http.close());
  const open = (cwd: string) => fetch(`${url.origin}/api/primaries`, {method: 'POST', headers: {Origin: url.origin, 'Content-Type': 'application/json'}, body: JSON.stringify({cwd, sessionFile: file})});
  const mismatch = await open(other); assert.equal(mismatch.status, 400); assert.equal(dispatched, 0);
  const matching = await open(project); assert.equal(matching.status, 202); assert.equal(dispatched, 1);
});

test('the first saved page and the published list carry the backend writer marks, and title pages do not', async context => {
  const marked = {...page, items: [{id: 'a', path: '/s/a.jsonl', revision: 'r', project: '/project', title: 'A', modifiedAt: '2026-01-01T00:00:00Z', size: 1}]};
  const seen: string[] = [];
  const backend: HttpBackend = {journal: new Journal(), dispatch: async () => ({}), workspace: async () => 'workspace', observe: async () => {}, detached() {},
    publishedSessions: async () => marked, withWriters: async input => { seen.push(input.items[0]?.id ?? ''); return {...input, items: input.items.map(item => ({...item, writer: 'live' as const}))}; }};
  const http = new LocalHttp(backend, new Map(), {sessions: async () => marked, projects: async () => page, titles: async () => marked});
  const origin = new URL(await http.listen(0)).origin; context.after(() => http.close());
  const listed = await (await fetch(`${origin}/api/sessions?project=%2Fproject`)).json() as {data: typeof marked};
  assert.equal((listed.data.items[0] as {writer?: string}).writer, 'live');
  const titles = await (await fetch(`${origin}/api/sessions?project=%2Fproject&titles=cursor`)).json() as {data: typeof marked};
  assert.equal((titles.data.items[0] as {writer?: string}).writer, undefined);
  assert.deepEqual(seen, ['a']);
});
