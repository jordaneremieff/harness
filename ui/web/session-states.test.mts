import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture, type HostNode} from './app-fixture.mts';
import {createPaneLayout} from './pane-layout.ts';

const browser = await createAppFixture();
const {arrive, settle, byId, hostDocument, primaryFixture, targetFixture, app, transportLog} = browser;

const saved = (name: string, extra: Record<string, unknown> = {}) => ({id: `id-${name}`, path: `/fixture/project/${name}.jsonl`, project: '/fixture/project', revision: 'r', title: `Session ${name}`, titleSource: 'name' as const, titleState: 'ready' as const, modifiedAt: '2026-10-24T01:00:00.000Z', size: 10, ...extra});
const tabOf = (item: ReturnType<typeof saved>) => ({kind: 'session' as const, id: item.id, path: item.path, project: item.project, name: item.title});
/** A composer is visible when its editor sits in no hidden or inert ancestor. */
function visibleEditors(): HostNode[] {
  return hostDocument.body.querySelectorAll('textarea').filter(editor => { for (let node: HostNode | null = editor; node && node !== hostDocument.body; node = node.parentNode as HostNode | null) if (node.hidden || node.inert) return false; return true; });
}
const rowFor = (title: string) => byId('recent-sessions').querySelectorAll('.sidebar-content-row').find(row => row.querySelector('.row-title')?.textContent === title);

async function openState(t: test.TestContext, input: {primaries: ReturnType<typeof primaryFixture>[]; items: ReturnType<typeof saved>[]; tabs: ReturnType<typeof saved>[]; metadata?: unknown[]}) {
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://ui.test').pathname;
    if (path === '/api/sessions/published') return Response.json({ok: true, data: {items: input.items, total: input.items.length, omitted: 0, nextCursor: null, titleCursor: null, observedAt: ''}});
    if (path === '/api/sessions/metadata' && (init?.method ?? 'GET') === 'GET') return Response.json({ok: true, data: {items: input.metadata ?? []}});
    if (path === '/api/sessions/history') { const target = input.items.find(item => String(url).includes(encodeURIComponent(item.path))) ?? input.items[0]; return Response.json({ok: true, data: {session: target, entries: [], coverage: browser.coverage, leaf: null, before: null, observedAt: ''}}); }
    return original(url, init);
  });
  const selected = input.primaries[0];
  assert.ok(selected);
  await arrive({workspace: {id: `states-${input.tabs.map(item => item.id).join('-')}`, revision: 1, primaryKey: selected.key, conversationLayout: createPaneLayout([{kind: 'primary'}, ...input.tabs.map(tabOf)], 'primary')}, primaries: input.primaries,
    roster: [], targets: input.primaries.filter(item => item.lifecycle === 'ready').map(item => targetFixture(`t-${item.key}`, {kind: 'primary', key: item.key, epoch: item.epoch}))} as never);
  await settle(); await settle();
}

test('a live conversation that a stored tab also names opens with its composer, never as a snapshot', async t => {
  const current = primaryFixture({epoch: 41000, key: 'open', sessionId: 'id-open', sessionFile: '/fixture/project/open.jsonl', sessionName: 'Open now'});
  const idle = primaryFixture({epoch: 41001, key: 'idle', sessionId: 'id-idle', sessionFile: '/fixture/project/idle.jsonl'});
  const running = primaryFixture({epoch: 41002, key: 'running', activity: 'running', sessionId: 'id-running', sessionFile: '/fixture/project/running.jsonl'});
  const [idleSaved, runningSaved] = [saved('idle'), saved('running')];
  await openState(t, {primaries: [current, idle, running], items: [idleSaved, runningSaved], tabs: [idleSaved, runningSaved]});
  for (const item of [idleSaved, runningSaved]) {
    const row = rowFor(item.title); assert.ok(row, `${item.title} is listed in Recents`);
    row.click(); await settle(); await settle();
    assert.equal(visibleEditors().length, 1, `${item.title} shows one composer`);
    assert.equal(byId('conversation-panes').querySelectorAll('.session-reader').filter(node => !node.closest('[hidden]')).length, 0, `${item.title} shows no snapshot reader`);
  }
  assert.equal(app.state.workspace?.primaryKey, 'running', 'the running conversation is the selected Primary');
});

test('a closed saved session starts when opened, and an archived one stays listed behind the Archived row', async t => {
  const current = primaryFixture({epoch: 41100, key: 'open2', sessionId: 'id-open2', sessionFile: '/fixture/project/open2.jsonl', sessionName: 'Open now'});
  const dormant = saved('dormant'), archived = saved('archived'), hidden = saved('hidden');
  const metadata = [archived, hidden].map(item => ({target: {kind: 'session', id: item.id, path: item.path, project: item.project}, aliases: [`path:${item.path}`, `id:${item.id}`], title: item.title, archived: true, canRename: true, canArchive: false, canRestore: true}));
  await openState(t, {primaries: [current], items: [dormant, archived, hidden], tabs: [dormant, archived], metadata});
  assert.ok(rowFor('Session archived') || byId('recent-sessions').querySelectorAll('.sidebar-content-row').some(row => row.textContent?.includes('Session archived')), 'an archived session with an open tab stays listed');
  assert.equal(byId('recent-sessions').querySelectorAll('.sidebar-content-row').some(row => row.textContent?.includes('Session hidden')), false, 'an archived session without a tab leaves Recents');
  assert.match(byId('recent-sessions').textContent ?? '', /Archived · 2/, 'the Archived row counts every archived session');
  const before = transportLog.length;
  rowFor('Session dormant')?.click(); await settle(); await settle();
  assert.ok(transportLog.slice(before).some(call => call.method === 'POST' && /start|primaries/.test(call.path)), 'opening a closed session asks the backend to start it');
});

test('a session a terminal holds keeps a visible, labelled composer shell instead of no composer', async t => {
  const current = primaryFixture({epoch: 41200, key: 'open3', sessionId: 'id-open3', sessionFile: '/fixture/project/open3.jsonl', sessionName: 'Open now'});
  const held = saved('held', {writer: 'live'});
  await openState(t, {primaries: [current], items: [held], tabs: [held]});
  rowFor(held.title)?.click(); await settle(); await settle();
  const shell = hostDocument.body.querySelectorAll('.session-reader-held').find(node => !node.closest('[hidden]') && !node.hidden);
  assert.ok(shell, 'the held shell is visible');
  assert.match(shell.querySelector('.session-reader-held-note')?.textContent ?? '', /Held by a terminal/);
  assert.deepEqual(shell.querySelectorAll('button').map(node => node.textContent), ['Copy message', 'Copy resume command']);
  assert.equal(transportLog.some(call => /\/inputs|\/start/.test(call.path)), false, 'a held session is never started or sent to');
});

test('Show more sessions loads the next page of a project until every saved session is listed', async t => {
  const current = primaryFixture({epoch: 41300, key: 'open4', cwd: '/fixture/project', sessionId: 'id-open4', sessionFile: '/fixture/project/open4.jsonl', sessionName: 'Open now'});
  const first = saved('page-one'), second = saved('page-two');
  const original = globalThis.fetch, cursors: (string | null)[] = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const parsed = new URL(String(url), 'http://ui.test');
    if (parsed.pathname === '/api/sessions/published') return Response.json({ok: true, data: {items: [], total: 0, omitted: 0, nextCursor: null, titleCursor: null, observedAt: ''}});
    if (parsed.pathname === '/api/sessions/metadata' && (init?.method ?? 'GET') === 'GET') return Response.json({ok: true, data: {items: []}});
    if (parsed.pathname === '/api/sessions' && parsed.searchParams.get('project')) {
      const cursor = parsed.searchParams.get('cursor'); cursors.push(cursor);
      return Response.json({ok: true, data: {items: [cursor ? second : first], total: 2, omitted: 0, nextCursor: cursor ? null : 'next', titleCursor: null, observedAt: ''}});
    }
    return original(url, init);
  });
  await arrive({workspace: {id: 'states-more', revision: 1, primaryKey: current.key}, primaries: [current], roster: [], targets: [targetFixture('t-open4', {kind: 'primary', key: current.key, epoch: current.epoch})]} as never);
  await settle(); await settle();
  assert.ok(rowFor(first.title), 'the first page is listed');
  assert.equal(rowFor(second.title), undefined);
  const more = byId('recent-sessions').querySelectorAll('button').find(node => node.textContent === 'Show more sessions'); assert.ok(more, 'a next page offers Show more sessions');
  more.click(); await settle(); await settle();
  assert.deepEqual(cursors, [null, 'next']);
  assert.ok(rowFor(second.title), 'the next page joins the list');
  assert.equal(byId('recent-sessions').querySelectorAll('button').some(node => node.textContent === 'Show more sessions'), false, 'the last page removes the button');
});

test('a live Durable conversation is listed in Recents and opens from the list', async t => {
  const current = primaryFixture({epoch: 41400, key: 'open5', sessionId: 'id-open5', sessionFile: '/fixture/project/open5.jsonl', sessionName: 'Open now'});
  const durable = browser.agentFixture('durable-orchestrator', {name: 'Web orchestrator', availability: 'live', state: 'working'});
  const stored = browser.agentFixture('durable-stored', {name: 'Finished worker', availability: 'stored', state: 'done'});
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://ui.test').pathname;
    if (path === '/api/sessions/published') return Response.json({ok: true, data: {items: [], total: 0, omitted: 0, nextCursor: null, titleCursor: null, observedAt: ''}});
    if (path === '/api/sessions/metadata' && (init?.method ?? 'GET') === 'GET') return Response.json({ok: true, data: {items: []}});
    return original(url, init);
  });
  await arrive({workspace: {id: 'states-durable', revision: 1, primaryKey: current.key}, primaries: [current], roster: [durable, stored],
    targets: [targetFixture('t-open6', {kind: 'primary', key: current.key, epoch: current.epoch}), targetFixture('t-durable', {kind: 'agent', identity: durable.identity})]} as never);
  await settle(); await settle();
  assert.ok(rowFor('Web orchestrator'), 'a live Durable conversation is listed');
  assert.equal(rowFor('Finished worker'), undefined, 'a stored worker stays in the Agents view');
  assert.equal(rowFor('Web orchestrator')?.querySelector('.session-dot')?.dataset.status, 'running');
  rowFor('Web orchestrator')?.click(); await settle(); await settle();
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: durable.identity});
});

test('opening the sidebar asks the host to rescan agents, at most once every ten seconds', async () => {
  const current = primaryFixture({epoch: 41500, key: 'open7', sessionId: 'id-open7', sessionFile: '/fixture/project/open7.jsonl', sessionName: 'Open now'});
  await arrive({workspace: {id: 'states-rescan', revision: 1, primaryKey: current.key}, primaries: [current], roster: []} as never);
  await settle();
  const rescans = () => transportLog.filter(call => call.method === 'POST' && call.path === '/api/agents/refresh').length;
  const before = rescans();
  app.toggleSidebar(true); await settle(); app.toggleSidebar(false); app.toggleSidebar(true); await settle();
  assert.ok(rescans() - before <= 1, 'a second open inside ten seconds does not rescan again');
  app.refreshRosterOnDemand(); await settle();
  assert.ok(rescans() - before <= 1);
});
