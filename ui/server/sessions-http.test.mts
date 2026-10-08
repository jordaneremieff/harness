import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHttp, type HttpBackend } from './http.mts';
import { Journal } from './journal.mts';

const page = {items: [], total: 0, omitted: 0, nextCursor: null, titleCursor: null, observedAt: '2026-01-01T00:00:00Z'};
test('saved-session metadata routes require authentication and do not dispatch runtime work', async context => {
  const calls: unknown[][] = [];
  const backend: HttpBackend = {journal: new Journal(), dispatch: async () => { throw new Error('Metadata browsing must not dispatch runtime work'); }, workspace: async () => 'workspace', observe: async () => {}, detached() {}};
  const http = new LocalHttp(backend, new Map(), {sessions: async (project, cursor) => { calls.push(['sessions', project, cursor]); return page; }, projects: async cursor => { calls.push(['projects', cursor]); return page; }, titles: async (project, cursor) => { calls.push(['titles', project, cursor]); return page; }});
  const url = new URL(await http.listen(0)); const origin = url.origin;
  context.after(() => http.close());
  const denied = await fetch(`${origin}/api/sessions?project=%2Fproject`); assert.equal(denied.status, 401); assert.equal(calls.length, 0);
  const deniedProjects = await fetch(`${origin}/api/projects`); assert.equal(deniedProjects.status, 401); assert.equal(calls.length, 0);
  const login = await fetch(`${origin}/api/auth/launch`, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({capability: new URLSearchParams(url.hash.slice(1)).get('launch')})});
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  const sessions = await fetch(`${origin}/api/sessions?project=%2Fproject&cursor=next`, {headers: {Cookie: cookie}});
  assert.equal(sessions.status, 200); assert.deepEqual(await sessions.json(), {ok: true, data: page});
  assert.equal(sessions.headers.get('cache-control'), 'no-store');
  const projects = await fetch(`${origin}/api/projects?cursor=recent`, {headers: {Cookie: cookie}});
  assert.equal(projects.status, 200); assert.deepEqual(await projects.json(), {ok: true, data: page});
  const titles = await fetch(`${origin}/api/sessions?project=%2Fproject&titles=completion`, {headers: {Cookie: cookie}});
  assert.equal(titles.status, 200);
  assert.deepEqual(calls, [['sessions', '/project', 'next'], ['projects', 'recent'], ['titles', '/project', 'completion']]);
  const wrongMethod = await fetch(`${origin}/api/sessions`, {method: 'POST', headers: {Cookie: cookie, Origin: origin, 'Content-Type': 'application/json'}, body: '{}'}); assert.equal(wrongMethod.status, 405);
  const foreign = await fetch(`${origin}/api/projects`, {headers: {Cookie: cookie, 'Sec-Fetch-Site': 'cross-site'}}); assert.equal(foreign.status, 403);
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
  const login = await fetch(`${url.origin}/api/auth/launch`, {method: 'POST', headers: {Origin: url.origin, 'Content-Type': 'application/json'}, body: JSON.stringify({capability: new URLSearchParams(url.hash.slice(1)).get('launch')})});
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  const open = (cwd: string) => fetch(`${url.origin}/api/primaries`, {method: 'POST', headers: {Cookie: cookie, Origin: url.origin, 'Content-Type': 'application/json'}, body: JSON.stringify({cwd, sessionFile: file, writerReleased: true})});
  const mismatch = await open(other); assert.equal(mismatch.status, 400); assert.equal(dispatched, 0);
  const matching = await open(project); assert.equal(matching.status, 202); assert.equal(dispatched, 1);
});
