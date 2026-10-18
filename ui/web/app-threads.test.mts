import assert from 'node:assert/strict';
import test from 'node:test';
import type {ThreadEventView, ThreadFrameView, ThreadListItem, ThreadOverview, ThreadPageView} from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';
const harness = await createAppFixture();
const {app, arrive, settle, byId, hostDocument, primaryFixture, agentFixture, twoPanes, transportLog} = harness;
const fixtureControl = harness;

const STORAGE = '10000000-0000-4000-8000-000000000001';
const BUILDER = '10000000-0000-4000-8000-000000000002';
const DESIGNER = '10000000-0000-4000-8000-000000000003';
const CHILD = `${STORAGE}:22`;
const id = (letter: string) => `${STORAGE}/${letter.repeat(32)}`;
const THREAD = id('a'), CLOSED = id('b'), MORE = id('c'), GONE = id('d'), LOST = id('e');
const frame = (overrides: Partial<ThreadFrameView> = {}): ThreadFrameView => ({title: 'Release plan', purpose: 'Ship the list', authority: 'Operator', source: '', restrictions: 'Read only', acceptance: 'It reads', integrator: STORAGE, ...overrides});
const event = (sequence: number, kind: string, sender: string, overrides: Partial<ThreadEventView> = {}): ThreadEventView =>
  ({sequence, at: Date.now() - (10 - sequence) * 60_000, sender, origin: 'model', kind, message: `message ${sequence}`, source: '', replyTo: null, revision: 1, notify: [], ...overrides});
const items: ThreadListItem[] = [
  {id: THREAD, storageId: STORAGE, title: 'Release plan', purpose: 'Ship the list', updatedAt: Date.now() - 60_000, closed: false, members: 3},
  {id: MORE, storageId: STORAGE, title: 'Long thread', purpose: '', updatedAt: Date.now() - 120_000, closed: false, members: 3},
  {id: GONE, storageId: STORAGE, title: 'Unavailable thread', purpose: '', updatedAt: Date.now() - 180_000, closed: false, members: 3},
  {id: LOST, storageId: STORAGE, title: 'Lost thread', purpose: '', updatedAt: Date.now() - 240_000, closed: false, members: 3},
  {id: CLOSED, storageId: STORAGE, title: 'Old audit', purpose: 'Done', updatedAt: Date.now() - 86_400_000 * 3, closed: true, members: 2}];
const overview: ThreadOverview = {items, storages: [{storageId: STORAGE, state: 'answered', threads: 2, truncated: false}], rosterComplete: true, truncated: false, omitted: 0,
  hosts: {total: 1, answered: 1, unavailable: 0, failed: 0, notRunning: 2}, bounds: {perHost: 256, total: 200}, observedAt: '2026-10-19T00:00:00Z'};
function page(events: ThreadEventView[], overrides: Partial<ThreadPageView['thread']> = {}): ThreadPageView {
  return {storageId: STORAGE, events, nextBefore: null, pending: 0, coverage: {complete: true}, observedAt: '2026-10-19T00:00:00Z',
    thread: {...frame(), id: THREAD, creator: STORAGE, createdAt: Date.now() - 600_000, updatedAt: Date.now(), revision: 2, closed: false, sequence: events.length,
      members: [{identity: BUILDER, contribution: 'Builds the list', joinedAt: 1}, {identity: DESIGNER, contribution: 'Reviews it', joinedAt: 2}, {identity: CHILD, contribution: 'Runs checks', joinedAt: 3}], ...overrides}};
}
const events = [event(1, 'create', STORAGE, {frame: frame(), message: ''}), event(2, 'join', BUILDER, {message: 'Builds the list'}),
  event(3, 'contribution', BUILDER, {message: 'Plan: **first** the list'}), event(4, 'revise', STORAGE, {frame: frame({purpose: 'Ship the list and the reader'}), message: '', revision: 2}),
  event(5, 'carried-authority', DESIGNER, {message: 'Go ahead', source: 'chat', replyTo: 3}), event(6, 'archive', DESIGNER)];
const threadCalls = () => transportLog.filter(call => call.path.startsWith('/api/threads'));
const reader = () => hostDocument.querySelector('.thread-reader');
const regions = () => hostDocument.querySelectorAll('.transcript-region');
const text = (node: {textContent: string}) => node.textContent;

await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: BUILDER}, conversationLayout: twoPanes(BUILDER, 'agent-pane')},
  primaries: [primaryFixture()], roster: [agentFixture(BUILDER, {name: 'Builder'}), agentFixture(DESIGNER, {name: 'Designer'}), agentFixture(STORAGE, {name: 'Web UI manager'})]});

test('the section reads nothing until it is opened and lists open threads before closed ones', async () => {
  fixtureControl.threadHandler = () => overview;
  await settle();
  assert.deepEqual(threadCalls(), []);
  assert.equal(byId('threads-heading').getAttribute('aria-expanded'), 'false');
  assert.equal(byId('threads-section-body').hidden, true);
  byId('threads-heading').click(); await settle();
  assert.deepEqual(threadCalls().map(call => call.method), ['GET']);
  assert.match(threadCalls()[0].path, /^\/api\/threads(\?|$)/);
  assert.equal(byId('threads-section-body').hidden, false);
  const rows = byId('threads-list').querySelectorAll('button');
  assert.deepEqual(rows.map(row => text(row.querySelector('.row-title') ?? row)), ['Release plan', 'Long thread', 'Unavailable thread', 'Lost thread', 'Old audit']);
  assert.match(text(rows[4]), /closed · 2 · /);
  assert.equal(rows[4].classList.contains('closed'), true);
  assert.match(text(byId('threads-footer')), /Listed by 1 of 1 running agent/);
  assert.match(text(byId('threads-footer')), /Agents that are not running do not list their threads \(2\)/);
  assert.equal(byId('threads-filter-box').hidden, true);
});

test('a thread opens in the focused pane only, reads without writing, and Escape returns to the row', async () => {
  fixtureControl.threadHandler = url => url.pathname === '/api/threads/read' ? page(events) : overview;
  byId('threads-list').querySelectorAll('button')[0]?.click(); await settle();
  const read = threadCalls().filter(call => call.path.startsWith('/api/threads/read'));
  assert.equal(read.length, 1);
  assert.match(read[0].path, new RegExp(`threadId=${encodeURIComponent(THREAD).replace(/[/]/g, '%2F')}&limit=20`));
  const node = reader(); assert.ok(node);
  assert.equal(node.hidden, false);
  assert.equal(hostDocument.querySelectorAll('.thread-reader').length, 1);
  const host = node.parentNode; assert.ok(host?.classList.contains('conversation'));
  const covered = regions().filter(region => region.hidden);
  assert.equal(covered.length, 1);
  assert.equal(covered[0]?.parentNode, host);
  assert.ok(regions().length >= 2);
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: BUILDER});
  assert.equal(byId('threads-list').querySelectorAll('button')[0]?.getAttribute('aria-current'), 'page');
  assert.equal(text(node.querySelector('.thread-title') as never), 'Release plan');
  assert.match(text(node.querySelector('.thread-status') as never), /^Open · 3 members · Integrator Web UI manager/);
  const exchange = node.querySelector('.thread-exchange'); assert.ok(exchange);
  const rows = exchange.children;
  assert.deepEqual(rows.map(row => row.classList.contains('thread-message') ? 'message' : 'line'), ['line', 'line', 'message', 'line', 'message', 'line']);
  assert.equal(text(rows[0]).startsWith('Thread created by Web UI manager'), true);
  assert.equal(text(rows[1]).startsWith('Builder joined'), true);
  assert.equal(text(rows[5]).startsWith('Designer archive'), true);
  assert.equal(text(rows[2].querySelector('.thread-sender') as never), 'Builder');
  assert.match(text(rows[4]), /Carried authority/); assert.match(text(rows[4]), /In reply to Builder/); assert.match(text(rows[4]), /Source: chat/);
  assert.match(text(rows[3]), /Frame revised to revision 2 by Web UI manager/);
  assert.match(text(rows[3].querySelector('.thread-line-details') as never), /Purpose/);
  const members = node.querySelector('.thread-members'); assert.ok(members);
  assert.deepEqual(members.querySelectorAll('.thread-person').map(person => text(person)), ['Builder', 'Designer', 'Web UI manager · 22']);
  assert.equal(members.querySelectorAll('.thread-person')[2]?.title, CHILD);
  node.dispatch('keydown', {key: 'Escape', isComposing: false});
  await settle();
  assert.equal(reader(), null);
  assert.equal(regions().filter(region => region.hidden).length, 0);
  assert.equal(hostDocument.activeElement, byId('threads-list').querySelectorAll('button')[0]);
  assert.equal(byId('threads-list').querySelectorAll('button')[0]?.getAttribute('aria-current'), null);
  assert.deepEqual(transportLog.filter(call => call.path.includes('threads') && call.method !== 'GET'), []);
});

test('Back to conversation closes the reader and a reopened thread asks again', async () => {
  byId('threads-list').querySelectorAll('button')[0]?.click(); await settle();
  const node = reader(); assert.ok(node);
  const back = node.querySelectorAll('button').find(item => text(item) === 'Back to conversation'); assert.ok(back);
  back.click(); await settle();
  assert.equal(reader(), null);
  byId('threads-list').querySelectorAll('button')[0]?.click(); await settle();
  assert.equal(threadCalls().filter(call => call.path.startsWith('/api/threads/read')).length, 3);
  assert.ok(reader());
});

test('a member name opens that conversation and leaves the reader', async () => {
  const designer = reader()?.querySelectorAll('.thread-person').find(person => text(person) === 'Designer'); assert.ok(designer);
  designer.click(); await settle();
  assert.equal(reader(), null);
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: DESIGNER});
});

test('older events load on request and join the loaded ones', async () => {
  const newest = page(events.slice(2), {id: MORE}); newest.nextBefore = 3; newest.coverage = {complete: false};
  const older = page(events.slice(0, 2), {id: MORE});
  fixtureControl.threadHandler = url => url.pathname !== '/api/threads/read' ? overview : url.searchParams.get('before') ? older : newest;
  byId('threads-list').querySelectorAll('button')[1]?.click(); await settle();
  const node = reader(); assert.ok(node);
  assert.equal(node.querySelector('.thread-exchange')?.children.length, 4);
  const earlier = node.querySelector('.thread-earlier'); assert.ok(earlier); assert.equal(earlier.hidden, false);
  earlier.click(); await settle();
  assert.match(threadCalls().at(-1)?.path ?? '', /before=3/);
  assert.equal(node.querySelector('.thread-exchange')?.children.length, 6);
  assert.equal(node.querySelector('.thread-earlier')?.hidden, true);
  node.dispatch('keydown', {key: 'Escape', isComposing: false}); await settle();
});

test('a host without thread operations and a failed read stay separate messages', async () => {
  fixtureControl.threadHandler = url => url.pathname !== '/api/threads/read' ? overview : {error: {code: 'threads_unavailable', message: 'Host operation collaboration-read is unavailable.', retry: 'none'}};
  byId('threads-list').querySelectorAll('button')[2]?.click(); await settle();
  let node = reader(); assert.ok(node);
  assert.match(text(node), /Threads are not available from this agent host\./);
  assert.doesNotMatch(text(node), /could not be read/);
  node.dispatch('keydown', {key: 'Escape', isComposing: false}); await settle();
  fixtureControl.threadHandler = url => url.pathname !== '/api/threads/read' ? overview : {error: {code: 'host_error', message: 'Thread not found', retry: 'user'}};
  byId('threads-list').querySelectorAll('button')[3]?.click(); await settle();
  node = reader(); assert.ok(node);
  assert.match(text(node), /The thread could not be read\./);
  assert.match(text(node), /Thread not found/);
  assert.doesNotMatch(text(node), /not available from this agent host/);
  fixtureControl.threadHandler = url => url.pathname !== '/api/threads/read' ? overview : page(events, {id: LOST});
  node.querySelectorAll('button').find(item => text(item) === 'Try again')?.click(); await settle();
  assert.match(text(node), /Thread created by/);
  node.dispatch('keydown', {key: 'Escape', isComposing: false}); await settle();
});

test('a list failure and a host that cannot list are reported without hiding the rest', async () => {
  fixtureControl.threadHandler = () => ({error: {code: 'host_error', message: 'Registry offline', retry: 'user'}});
  byId('threads-refresh').click(); await settle();
  assert.match(text(byId('threads-footer')), /Threads could not be listed\./);
  assert.match(text(byId('threads-footer')), /Registry offline/);
  assert.equal(byId('threads-list').querySelectorAll('button').length, 5);
  fixtureControl.threadHandler = () => ({...overview, hosts: {total: 3, answered: 1, unavailable: 1, failed: 1, notRunning: 0}, truncated: true, omitted: 4, rosterComplete: false,
    storages: [{storageId: STORAGE, state: 'answered', threads: 2, truncated: false}, {storageId: BUILDER, state: 'unavailable', threads: 0, truncated: false, code: 'threads_unavailable', message: 'old'},
      {storageId: DESIGNER, state: 'failed', threads: 0, truncated: false, code: 'timeout', message: 'The host did not answer in time.'}]});
  byId('threads-refresh').click(); await settle();
  const footer = text(byId('threads-footer'));
  assert.doesNotMatch(footer, /Threads could not be listed/);
  assert.match(footer, /Listed by 1 of 3 running agents · Showing the newest 5 threads; 4 more not shown · Agent list incomplete/);
  assert.match(footer, /1 agent does not offer threads/); assert.match(footer, /1 agent did not answer/);
  assert.match(footer, /Builder: does not offer threads/); assert.match(footer, /Designer: did not answer \(The host did not answer in time\.\)/);
});
