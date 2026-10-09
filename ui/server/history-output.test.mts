import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PrimarySession } from '../rpc/session.mts';
import { FakeChild } from '../rpc/fake-child.mts';
import { startBackend } from './main.mts';
import type { HistoryPage, OutputPage, PrimaryView, Success } from '../shared/api.ts';

async function setup(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ui-output-')); const path = join(dir, 'session.jsonl');
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  t.after(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; });
  const rows = [{type: 'message', id: 'text', parentId: null, message: {role: 'assistant', timestamp: 1, content: [{type: 'text', text: '雪'.repeat(10_000)}]}}];
  await writeFile(path, [{type: 'session', version: 3, id: 'fixture', timestamp: new Date(0).toISOString(), cwd: dir}, ...rows].map(row => `${JSON.stringify(row)}\n`).join(''));
  let resolveReady: () => void = () => {}; const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const app = await startBackend({cwd: dir, pi: 'fixture', stateDir: join(dir, 'state'), port: 0}, {assets: new Map([['/', {type: 'text/html; charset=utf-8', data: Buffer.from('<title>Fixture</title>')}]]), primary: options => {
    const child = new FakeChild(); child.onCommand = record => {
      if (record.type === 'get_state') child.response(record, {sessionId: 'fixture', sessionFile: path, isStreaming: false, isCompacting: false});
      else if (record.type === 'get_entries') child.response(record, {entries: record.since ? [] : rows, leafId: 'text'});
      else child.defaults(record);
    };
    return new PrimarySession({...options, spawnChild: child.spawn, publish: (name, target, data) => { options.publish(name, target, data); if (name === 'primary.state' && (data as PrimaryView).lifecycle === 'ready') resolveReady(); }});
  }});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  const key = await app.registry.openPrimary(dir, path); await ready;
  const launch = new URL(app.launchUrl); const origin = launch.origin;
  const auth = await fetch(`${origin}/api/auth/launch`, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({capability: launch.hash.slice('#launch='.length)})});
  assert.equal(auth.status, 200); const cookie = auth.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  return {app, key, origin, cookie, route: `${origin}/api/primaries/${key}/history/output`};
}
test('authenticated history output restores protected bytes in bounded chunks and validates epoch and part', async t => {
  const fixture = await setup(t); const headers = {Cookie: fixture.cookie};
  const history = await fetch(`${fixture.origin}/api/primaries/${fixture.key}/history`, {headers});
  const page = (await history.json() as Success<HistoryPage>).data;
  const part = page.items[0]?.messages?.[0]?.parts[0]; assert.ok(part?.type === 'text'); assert.ok(part.more);
  let text = part.text, offset: number | null = part.more.offset;
  const workspace = (await fixture.app.registry.store.workspace()).id;
  while (offset !== null) {
    const response = await fetch(`${fixture.route}?epoch=1&entry=text&part=0&offset=${offset}&workspace=${workspace}`, {headers}); assert.equal(response.status, 200);
    const output = (await response.json() as Success<OutputPage>).data;
    assert.ok(Buffer.byteLength(output.text) <= 8192); assert.equal(output.totalBytes, 30_000); text += output.text; offset = output.nextOffset;
  }
  assert.equal(text, '雪'.repeat(10_000));
  for (const query of ['epoch=0&entry=text&part=0&offset=0', 'epoch=1&entry=missing&part=0&offset=0', 'epoch=1&entry=text&part=0&offset=1', 'epoch=1&entry=text&part=100&offset=0', 'epoch=1&entry=text&part=0&offset=-1', 'epoch=1&entry=text&part=0&offset=0&path=untrusted']) {
    const response = await fetch(`${fixture.route}?${query}`, {headers}); assert.ok([400, 409].includes(response.status), `${query}: ${response.status}`);
  }
  assert.equal((await fetch(`${fixture.route}?epoch=1&entry=text&part=0&offset=0`)).status, 401);
  assert.ok(Buffer.byteLength(JSON.stringify(fixture.app.registry.primary(fixture.key).entries)) < 64 * 1024);
});
