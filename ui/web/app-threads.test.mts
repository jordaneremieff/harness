import assert from 'node:assert/strict';
import test from 'node:test';
import type {ThreadEventView, ThreadFrameView, ThreadListItem, ThreadOverview, ThreadPageView} from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';
const harness = await createAppFixture();
const {app, arrive, settle, byId, hostDocument, primaryFixture, agentFixture, twoPanes, transportLog, dispatchWindow, event: emitEvent} = harness as typeof harness & {dispatchWindow(name: string): void};
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
  primaries: [primaryFixture()], roster: [agentFixture(BUILDER, {state: 'working', name: 'Builder'}), agentFixture(DESIGNER, {name: 'Designer'}), agentFixture(STORAGE, {name: 'Web UI manager'})]});
app.focusPane('agent-pane'); await settle();

test('the section reads when the sidebar opens and lists threads with two or more members, newest first', async () => {
  fixtureControl.threadHandler = () => overview;
  byId('threads-refresh').click(); await settle();
  const heading = byId('threads-heading'), chevron = heading.querySelector('.card-icon-chevron');
  assert.ok(chevron); assert.equal(heading.firstChild, chevron); assert.equal(heading.querySelectorAll('svg').length, 1);
  assert.equal(heading.getAttribute('aria-expanded'), 'true');
  assert.equal(byId('threads-section-body').hidden, false);
  assert.match(threadCalls()[0].path, /^\/api\/threads(\?|$)/);
  const rows = byId('threads-list').querySelectorAll('button');
  assert.deepEqual(rows.map(row => text(row.querySelector('.row-title') ?? row)), ['Release plan', 'Long thread', 'Unavailable thread', 'Lost thread', 'Old audit']);
  assert.match(text(rows[4].querySelector('.row-meta') as never), /^2 · 3d$/); assert.match(text(rows[0].querySelector('.row-meta') as never), /^3 · 1m$/);
  assert.match(rows[4].title, /Closed · 2 members · 3d ago/);
  assert.equal(rows[4].classList.contains('closed'), true);
  assert.equal(byId('threads-refresh').disabled, false);
  assert.match(byId('threads-refresh').title, /2 stopped agents use saved storage reads\./);
  assert.doesNotMatch(text(byId('threads-footer')), /Listed by/);
  assert.equal(byId('threads-filter-box').hidden, true);
  const count = byId('threads-count'); assert.equal(count.textContent, '5'); assert.equal(count.hidden, false);
  assert.equal(heading.contains(byId('threads-refresh')), false);
  const reads = threadCalls().length;
  heading.click(); await settle();
  assert.equal(heading.getAttribute('aria-expanded'), 'false'); assert.equal(byId('threads-section-body').hidden, true);
  assert.equal(byId('threads-refresh').disabled, true); assert.equal(heading.firstChild, chevron); assert.equal(count.textContent, '5');
  heading.click(); await settle(); assert.equal(heading.getAttribute('aria-expanded'), 'true'); assert.equal(count.hidden, false);
  assert.equal(threadCalls().length, reads);
});

test('All threads opens the full catalog with a filter that keeps a query, and Escape returns to the compact list', async () => {
  const loaded = Array.from({length: 9}, (_, index) => ({...items[0], id: id(String(index)), title: `Filter thread ${index}`}));
  fixtureControl.threadHandler = () => ({...overview, items: loaded});
  byId('threads-refresh').click(); await settle();
  assert.equal(byId('threads-filter-box').hidden, true);
  assert.equal(byId('threads-list').querySelectorAll('button').length, 9);
  const all = byId('threads-footer').querySelectorAll('button').find(item => text(item) === 'All threads (9)'); assert.ok(all);
  all.click(); await settle();
  assert.equal(byId('threads-filter-box').hidden, false);
  const filter = byId('threads-filter');
  filter.value = 'thread 3'; filter.dispatch('input');
  assert.deepEqual(byId('threads-list').querySelectorAll('button').map(row => text(row.querySelector('.row-title') as never)), ['Filter thread 3']);
  filter.dispatch('keydown', {key: 'Escape'}); await settle();
  assert.equal(filter.value, ''); assert.equal(byId('threads-section').dataset.catalog, 'false');
  fixtureControl.threadHandler = () => overview; byId('threads-refresh').click(); await settle();
});
test('a thread opens in the focused pane only, reads without writing, and Escape returns to the row', async context => {
  context.mock.method(Date, 'now', () => new Date(2026, 9, 20, 12).getTime());
  const firstAt = new Date(2026, 9, 7, 5, 56).getTime();
  const datedEvents = events.map((event, index) => index === 0 ? {...event, at: firstAt} : event);
  fixtureControl.threadHandler = url => url.pathname === '/api/threads/read' ? page(datedEvents) : overview;
  byId('threads-list').querySelectorAll('button')[0]?.click(); await settle();
  const read = threadCalls().filter(call => call.path.startsWith('/api/threads/read'));
  assert.equal(read.length, 1);
  assert.match(read[0].path, new RegExp(`threadId=${encodeURIComponent(THREAD).replace(/[/]/g, '%2F')}&limit=20`));
  const node = reader(); assert.ok(node);
  assert.equal(node.hidden, false);
  assert.equal(hostDocument.querySelectorAll('.thread-reader').length, 1);
  const host = node.parentNode; assert.ok(host?.classList.contains('pane-leaf'));
  assert.equal(host.querySelector('.pane-content')?.hidden, true);
  const covered = regions().filter(region => region.hidden);
  assert.equal(covered.length, 1);
  assert.equal(covered[0]?.parentNode?.dataset.paneId, 'agent-pane');
  assert.ok(regions().length >= 2);
  assert.deepEqual(app.state.workspace?.selectedTarget, {kind: 'agent', identity: BUILDER});
  assert.equal(byId('threads-list').querySelectorAll('button')[0]?.getAttribute('aria-current'), 'page');
  assert.equal(text(node.querySelector('.thread-title') as never), 'Release plan');
  assert.match(text(node.querySelector('.thread-status') as never), /^Open · 3 participants · updated/);
  assert.match((node.querySelector('.thread-status') as unknown as {title: string}).title, /^Updated /);
  const exchange = node.querySelector('.thread-exchange'); assert.ok(exchange);
  const rows = exchange.children;
  assert.deepEqual(rows.map(row => row.classList.contains('thread-message') ? 'message' : 'line'), ['line', 'line', 'message', 'line', 'message', 'line']);
  assert.equal(text(rows[0]).startsWith('Thread created by Web UI manager'), true);
  const time = rows[0].querySelector('.thread-time'); assert.ok(time);
  assert.equal(text(time), '7 Oct, 5:56 AM');
  assert.equal(time.title, '7 Oct 2026, 5:56 AM');
  assert.equal((time as unknown as {dateTime: string}).dateTime, new Date(firstAt).toISOString());
  assert.equal(text(rows[1]).startsWith('Builder joined'), true);
  assert.equal(text(rows[5]).startsWith('Designer archive'), true);
  assert.equal(text(rows[2].querySelector('.thread-sender') as never), 'Builder');
  assert.match(text(rows[4]), /Carried authority/); assert.match(text(rows[4]), /Reply to Builder/); assert.match(text(rows[4]), /Source: chat/);
  assert.match(text(rows[3]), /Frame revised to revision 2 by Web UI manager/);
  assert.match(text(rows[3].querySelector('.thread-line-details') as never), /Purpose/);
  const members = node.querySelector('.thread-members'); assert.ok(members);
  assert.deepEqual(members.querySelectorAll('.thread-person').map(person => text(person)), ['Designer', 'Builder', 'Web UI manager · 22']);
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
  const back = node.querySelectorAll('button').find(item => text(item) === 'Back to Builder'); assert.ok(back);
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
  const newest = page(events.slice(2), {id: MORE, sequence: 6}); newest.nextBefore = 3; newest.coverage = {complete: false};
  const older = page(events.slice(0, 2), {id: MORE, sequence: 6});
  fixtureControl.threadHandler = url => url.pathname !== '/api/threads/read' ? overview : url.searchParams.get('before') ? older : newest;
  byId('threads-list').querySelectorAll('button')[1]?.click(); await settle();
  const node = reader(); assert.ok(node);
  assert.equal(node.querySelector('.thread-exchange')?.children.length, 4);
  const row = node.querySelector('.thread-earlier-row'), earlier = node.querySelector('.thread-earlier'); assert.ok(row); assert.ok(earlier); assert.equal(row.hidden, false);
  assert.match(text(row), /^Newest 4 of 6\s*Load earlier events$/); assert.doesNotMatch(text(node.querySelector('.thread-status') as never), /Newest/);
  earlier.click(); await settle();
  assert.match(threadCalls().at(-1)?.path ?? '', /before=3/);
  assert.equal(node.querySelector('.thread-exchange')?.children.length, 6);
  assert.equal(node.querySelector('.thread-earlier-row')?.hidden, true); assert.doesNotMatch(text(node.querySelector('.thread-status') as never), /Newest/);
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
  assert.match(byId('threads-refresh').title, /Registry offline/);
  assert.equal(byId('threads-list').querySelectorAll('button').length, 5);
  fixtureControl.threadHandler = () => ({...overview, hosts: {total: 3, answered: 1, unavailable: 1, failed: 1, notRunning: 0}, truncated: true, omitted: 4, rosterComplete: false,
    storages: [{storageId: STORAGE, state: 'answered', threads: 2, truncated: false}, {storageId: BUILDER, state: 'unavailable', threads: 0, truncated: false, code: 'threads_unavailable', message: 'old'},
      {storageId: DESIGNER, state: 'failed', threads: 0, truncated: false, code: 'timeout', message: 'The host did not answer in time.'}]});
  byId('threads-refresh').click(); await settle();
  const footer = byId('threads-refresh').title;
  assert.doesNotMatch(footer, /Registry offline/);
  assert.doesNotMatch(footer, /Listed by/);
  assert.match(footer, /Showing the newest 5 threads; 4 more not shown · Agent list incomplete/);
  assert.match(footer, /1 agent does not offer threads/); assert.match(footer, /1 agent did not answer/);
  assert.match(footer, /Builder: does not offer threads/); assert.match(footer, /Designer: did not answer \(The host did not answer in time\.\)/);
});

function scrollerOf(): HostNodeLike {
  const node = reader()?.querySelector('.thread-scroll') as HostNodeLike | null | undefined; assert.ok(node);
  Object.defineProperty(node, 'scrollHeight', {value: 2000, configurable: true}); return node;
}
type HostNodeLike = {scrollTop: number; dispatch(name: string): void};
const closeReader = async () => { reader()?.dispatch('keydown', {key: 'Escape', isComposing: false}); await settle(); };
const rowButton = (title: string) => {
  const row = byId('threads-list').querySelectorAll('button').find(item => text(item).startsWith(title)); assert.ok(row, title); return row;
};

test('a thread reopens at its scroll position after another thread and after moving to another pane', async () => {
  fixtureControl.threadHandler = url => url.pathname === '/api/threads/read' ? page(events, {id: url.searchParams.get('threadId') ?? THREAD}) : overview;
  rowButton('Release plan').click(); await settle();
  let scroller = scrollerOf(); scroller.scrollTop = 500; scroller.dispatch('scroll');
  rowButton('Long thread').click(); await settle();
  scroller = scrollerOf(); scroller.scrollTop = 0; scroller.dispatch('scroll');
  rowButton('Release plan').click(); await settle();
  assert.equal(scrollerOf().scrollTop, 500);
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: BUILDER}, conversationLayout: twoPanes(BUILDER, 'primary-pane')},
    primaries: [primaryFixture()], roster: [agentFixture(BUILDER, {state: 'working', name: 'Builder'}), agentFixture(DESIGNER, {name: 'Designer'}), agentFixture(STORAGE, {name: 'Web UI manager'})]});
  rowButton('Long thread').click(); await settle();
  scrollerOf().scrollTop = 0; reader()?.querySelector('.thread-scroll')?.dispatch('scroll');
  rowButton('Release plan').click(); await settle();
  assert.equal(scrollerOf().scrollTop, 500);
  assert.equal(hostDocument.querySelectorAll('.thread-reader').length, 1);
  await closeReader();
});

test('a thread evicted from the content cache refetches and still reopens at its scroll position', async () => {
  const many = Array.from({length: 10}, (_, index): ThreadListItem => ({id: id(String.fromCharCode(102 + index)), storageId: STORAGE, title: `Thread ${index}`, purpose: '', updatedAt: Date.now() - index * 1000, closed: false, members: 2}));
  fixtureControl.threadHandler = url => url.pathname === '/api/threads/read' ? page(events, {id: url.searchParams.get('threadId') ?? THREAD}) : {...overview, items: many};
  byId('threads-refresh').click(); await settle();
  rowButton('Thread 0').click(); await settle();
  const scroller = scrollerOf(); scroller.scrollTop = 700; scroller.dispatch('scroll');
  for (let index = 1; index <= 9; index++) { rowButton(`Thread ${index}`).click(); await settle(); }
  const before = threadCalls().filter(call => call.path.startsWith('/api/threads/read')).length;
  rowButton('Thread 0').click(); await settle();
  assert.equal(threadCalls().filter(call => call.path.startsWith('/api/threads/read')).length, before + 1);
  assert.equal(scrollerOf().scrollTop, 700);
  await closeReader();
});

test('opening from a focused file pane covers that file pane', async () => {
  fixtureControl.threadHandler = url => url.pathname === '/api/threads/read' ? page(events) : overview;
  const file = {kind: 'file' as const, rootId: 'r', path: 'a.md'};
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: BUILDER}, conversationLayout: {root: {kind: 'split', id: 'split-file', axis: 'x', ratio: 50,
    first: {kind: 'pane', id: 'conversation-pane', tabs: [{kind: 'agent', identity: BUILDER}], active: `agent:${BUILDER}`},
    second: {kind: 'pane', id: 'file-pane', tabs: [file], active: `file:${JSON.stringify([file.rootId, file.path])}`}}, focusedPane: 'conversation-pane'}},
    primaries: [primaryFixture()], roster: [agentFixture(BUILDER, {state: 'working', name: 'Builder'}), agentFixture(STORAGE, {name: 'Web UI manager'})]});
  await arrive({workspace: {id: 'w', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: BUILDER}, conversationLayout: {root: {kind: 'split', id: 'split-file', axis: 'x', ratio: 50,
    first: {kind: 'pane', id: 'conversation-pane', tabs: [{kind: 'agent', identity: BUILDER}], active: `agent:${BUILDER}`},
    second: {kind: 'pane', id: 'file-pane', tabs: [file], active: `file:${JSON.stringify([file.rootId, file.path])}`}}, focusedPane: 'file-pane'}},
    primaries: [primaryFixture()], roster: [agentFixture(BUILDER, {state: 'working', name: 'Builder'}), agentFixture(STORAGE, {name: 'Web UI manager'})]}, true);
  byId('threads-refresh').click(); await settle();
  rowButton('Release plan').click(); await settle();
  assert.ok(reader());
  assert.equal(byId('modal-body').textContent, '');
  assert.equal(hostDocument.querySelectorAll('.thread-reader').length, 1);
  assert.equal(reader()?.parentNode?.dataset.paneId, 'file-pane');
  assert.equal(reader()?.querySelector('.inspection-back')?.textContent, 'Back to a.md');
  await closeReader();
});

test('an unknown participant has a readable name with a quiet identity suffix', async () => {
  const unknown = '01a149eb-cedf-7392-8808-5d73a0416bbe';
  fixtureControl.threadHandler = url => url.pathname === '/api/threads/read' ? page([event(1, 'create', STORAGE, {frame: frame(), message: ''}), event(2, 'contribution', unknown, {message: 'Hello'})],
    {id: url.searchParams.get('threadId') ?? THREAD, integrator: unknown, members: [{identity: unknown, contribution: 'Coordinates', joinedAt: 1}]}) : overview;
  byId('threads-refresh').click(); await settle();
  rowButton('Release plan').click(); await settle();
  const node = reader(); assert.ok(node);
  assert.doesNotMatch(text(node.querySelector('.thread-status') as never), /Integrator/);
  assert.deepEqual(node.querySelectorAll('.thread-person').map(person => text(person)), ['Unnamed conversation · 01a149eb']);
  assert.equal(node.querySelectorAll('.thread-person')[0]?.title, unknown);
  assert.doesNotMatch(text(node), /Unnamed agent/);
  await closeReader();
});

const FRESH = id('y');
test('scrolling up to the top of the exchange reads the next older page once and keeps the reading position', async () => {
  const newest = page(events.slice(2), {id: FRESH, sequence: 6}); newest.nextBefore = 3; newest.coverage = {complete: false};
  const older = page(events.slice(0, 2), {id: FRESH, sequence: 6});
  fixtureControl.threadHandler = url => url.pathname !== '/api/threads/read' ? {...overview, items: [...overview.items, {id: FRESH, storageId: STORAGE, title: 'Fresh thread', purpose: '', updatedAt: Date.now(), closed: false, members: 2}]} : url.searchParams.get('before') ? older : newest;
  byId('threads-refresh').click(); await settle();
  rowButton('Fresh thread').click(); await settle();
  const node = reader(); assert.ok(node);
  const scroller = node.querySelector('.thread-scroll') as unknown as {scrollTop: number; dispatch(name: string): void} | null; assert.ok(scroller);
  const reads = () => threadCalls().filter(call => call.path.startsWith('/api/threads/read')).length, before = reads();
  scroller.scrollTop = 600; scroller.dispatch('scroll'); await settle(); assert.equal(reads(), before);
  scroller.scrollTop = 40; scroller.dispatch('scroll'); await settle();
  assert.equal(reads(), before + 1); assert.match(threadCalls().at(-1)?.path ?? '', /before=3/);
  assert.equal(node.querySelector('.thread-exchange')?.children.length, 6);
  scroller.scrollTop = 10; scroller.dispatch('scroll'); await settle(); assert.equal(reads(), before + 1);
  await closeReader();
});

for (const [name, letter, removesRow] of [['while older events remain', 'x', false], ['when the older page is the last', 'w', true]] as const) {
  test(`loading an older page keeps the first visible event where it was ${name}`, async () => {
    const thread = id(letter), more = (events.length + 2);
    const all = Array.from({length: more}, (_, index) => event(index + 1, 'contribution', BUILDER, {message: `event ${index + 1}`}));
    const newest = page(all.slice(removesRow ? 2 : 4), {id: thread, sequence: more}); newest.nextBefore = removesRow ? 3 : 5; newest.coverage = {complete: false};
    const older = page(all.slice(removesRow ? 0 : 2, removesRow ? 2 : 4), {id: thread, sequence: more}); older.nextBefore = removesRow ? null : 3; older.coverage = {complete: removesRow};
    fixtureControl.threadHandler = url => url.pathname !== '/api/threads/read' ? {...overview, items: [...overview.items, {id: thread, storageId: STORAGE, title: `Anchor ${letter}`, purpose: '', updatedAt: Date.now(), closed: false, members: 2}]} : url.searchParams.get('before') ? older : newest;
    byId('threads-refresh').click(); await settle();
    rowButton(`Anchor ${letter}`).click(); await settle();
    const node = reader(); assert.ok(node);
    const scroller = node.querySelector('.thread-scroll') as unknown as {scrollTop: number; getBoundingClientRect(): {top: number}} | null; assert.ok(scroller);
    scroller.scrollTop = 100;
    const edge = scroller.getBoundingClientRect().top;
    const anchor = node.querySelector('.thread-exchange')?.children.find(row => row.getBoundingClientRect().bottom > edge); assert.ok(anchor);
    const viewportTop = () => anchor.getBoundingClientRect().top;
    const before = viewportTop();
    const button = node.querySelector('.thread-earlier'); assert.ok(button); button.click(); await settle();
    assert.equal(node.querySelector('.thread-earlier-row')?.hidden, removesRow);
    assert.ok(Math.abs(viewportTop() - before) <= 1, `the first visible event moved by ${viewportTop() - before}px`);
    await closeReader();
  });
}

const LATE = id('v');
test('rows that grow after they are placed leave the first visible event where it was, and a refresh keeps the reading position', async () => {
  const {HostNode, HostResizeObserver} = harness as unknown as {HostNode: {prototype: object}; HostResizeObserver: {instances: {observed: Set<unknown>; callback: () => void}[]}};
  const all = Array.from({length: 12}, (_, index) => event(index + 1, 'contribution', BUILDER, {message: `event ${index + 1}`}));
  const newest = page(all.slice(4), {id: LATE, sequence: 12}); newest.nextBefore = 5; newest.coverage = {complete: false};
  const older = page(all.slice(0, 4), {id: LATE, sequence: 12});
  const grown = new Map<string, number>();
  const prototype = HostNode.prototype as Record<string, unknown>;
  const height = Object.getOwnPropertyDescriptor(prototype, 'offsetHeight') as PropertyDescriptor;
  type Layout = {classList: {contains(name: string): boolean}; dataset: Record<string, string>; closest(selector: string): {scrollTop: number} | null};
  const eventRow = (node: Layout) => node.classList.contains('thread-event');
  Object.defineProperty(prototype, 'offsetHeight', {configurable: true, get(this: Layout) { return eventRow(this) ? 100 + (grown.get(this.dataset.sequence ?? '') ?? 0) : height.get?.call(this); }});
  try {
    fixtureControl.threadHandler = url => url.pathname !== '/api/threads/read' ? {...overview, items: [...overview.items, {id: LATE, storageId: STORAGE, title: 'Late growth', purpose: '', updatedAt: Date.now(), closed: false, members: 2}]} : url.searchParams.get('before') ? older : newest;
    byId('threads-refresh').click(); await settle();
    rowButton('Late growth').click(); await settle();
    const node = reader(); assert.ok(node);
    const scroller = node.querySelector('.thread-scroll') as unknown as {scrollTop: number; dispatch(name: string): void; getBoundingClientRect(): {top: number}} | null; assert.ok(scroller);
    const rows = () => node.querySelector('.thread-exchange')?.children ?? [];
    const top = (sequence: string) => { const row = rows().find(candidate => candidate.dataset.sequence === sequence); assert.ok(row, sequence); return row.getBoundingClientRect().top; };
    const settleRows = () => { for (const observer of HostResizeObserver.instances) if ([...observer.observed].some(target => target === node.querySelector('.thread-exchange'))) observer.callback(); };
    scroller.scrollTop = 450; scroller.dispatch('scroll'); await settle();
    const first = rows().find(row => row.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top)?.dataset.sequence; assert.ok(first);
    const before = top(first);
    node.querySelector('.thread-earlier')?.click(); await settle();
    assert.equal(rows().length, 12);
    assert.ok(Math.abs(top(first) - before) <= 1, `after the older page the event moved by ${top(first) - before}px`);
    for (const sequence of ['1', '2', '3', '4']) grown.set(sequence, 40);
    settleRows();
    assert.ok(Math.abs(top(first) - before) <= 1, `after late growth the event moved by ${top(first) - before}px`);
    const position = scroller.scrollTop;
    byId('threads-refresh').click(); node.querySelector('.thread-refresh')?.click(); await settle();
    assert.ok(Math.abs(top(first) - before) <= 1, `after a refresh the event moved by ${top(first) - before}px`);
    assert.ok(Math.abs(scroller.scrollTop - position) <= 1);
  } finally {
    Object.defineProperty(prototype, 'offsetHeight', height);
    await closeReader();
  }
});

test('the forum shows participants, replies, notify names, decisions, and whole-post controls', async () => {
  const long = 'A'.repeat(1500), forumEvents = [event(1, 'create', STORAGE, {frame: frame(), message: ''}), event(2, 'join', BUILDER), event(3, 'join', DESIGNER), event(4, 'leave', DESIGNER),
    ...Array.from({length: 12}, (_, index) => event(index + 5, 'contribution', index === 2 ? DESIGNER : BUILDER, {message: index === 0 ? long : `Post ${index}`, replyTo: index === 3 || index === 4 ? 5 : null, notify: index === 1 ? [DESIGNER] : []})),
    event(17, 'carried-authority', STORAGE, {message: 'Proceed with the plan', source: 'Decision source'})];
  await arrive({workspace: {id: 'forum', revision: 1, primaryKey: 'p', selectedTarget: {kind: 'agent', identity: BUILDER}, conversationLayout: twoPanes(BUILDER, 'agent-pane')}, primaries: [primaryFixture()],
    roster: [agentFixture(BUILDER, {state: 'working', name: 'Builder', handle: '@builder', role: 'Build the list', model: {provider: 'sample', modelId: 'model', thinkingLevel: 'high'}}), agentFixture(DESIGNER, {name: 'Designer'}), agentFixture(STORAGE, {name: 'Manager'})]});
  fixtureControl.threadHandler = url => url.pathname === '/api/threads/read' ? {...page(forumEvents, {members: [{identity: BUILDER, contribution: 'The list', joinedAt: 1}, {identity: STORAGE, contribution: 'Integration', joinedAt: 1}]}), source: 'retained'} : overview;
  byId('threads-refresh').click(); await settle(); rowButton('Release plan').click(); await settle();
  const node = reader(); assert.ok(node);
  assert.match(node.querySelector('.thread-status')?.textContent ?? '', /Read from saved storage/);
  assert.deepEqual(node.querySelectorAll('.thread-person').map(person => person.textContent), ['Manager', 'Builder', 'Designer']);
  assert.match(node.querySelector('.thread-member-list')?.textContent ?? '', /@builder · sample\/model · high/);
  assert.match(node.querySelector('.thread-member-list')?.textContent ?? '', /Build the list/);
  assert.match(node.querySelector('.thread-member-list')?.textContent ?? '', /Earlier participants/);
  assert.equal(node.querySelectorAll('.thread-event-group').length, 1);
  assert.equal(node.querySelector('.thread-event-group')?.querySelectorAll('details').length, 1);
  assert.equal(node.querySelector('.thread-event-group')?.querySelectorAll('[data-sequence]').length, 3);
  assert.match(node.querySelector('.thread-replies')?.textContent ?? '', /2 replies/);
  assert.match(node.querySelector('.thread-to')?.textContent ?? '', /To Designer/);
  assert.match(node.querySelector('.thread-decided')?.textContent ?? '', /Proceed with the plan/);
  const first = node.querySelector('#thread-post-5'); assert.ok(first);
  node.querySelector('.thread-reply')?.click(); await settle(); assert.equal(hostDocument.activeElement, first);
  const body = first.querySelector('.thread-post-body'); assert.ok(body);
  Object.defineProperty(body, 'scrollHeight', {value: 500, configurable: true});
  const observers = (harness as unknown as {HostResizeObserver: {instances: {callback: () => void; observed: Set<unknown>}[]}}).HostResizeObserver.instances;
  for (const observer of observers) if (observer.observed.has(node.querySelector('.thread-exchange'))) observer.callback();
  const whole = first.querySelector('.thread-whole-post'); assert.ok(whole); assert.equal(whole.hidden, false); assert.equal(body.dataset.long, 'true');
  whole.click(); assert.equal(body.dataset.expanded, 'true'); assert.equal(body.textContent, long);
  await closeReader();
});

test('a thread opens in an empty pane without a layout write and Close and Escape return to its row', async () => {
  const layout = {root: {kind: 'pane' as const, id: 'empty-pane', tabs: [], active: null}, focusedPane: 'empty-pane'};
  await arrive({workspace: {id: 'empty', revision: 1, conversationLayout: layout}, primaries: [], roster: []});
  fixtureControl.threadHandler = url => url.pathname === '/api/threads/read' ? page(events) : overview;
  byId('threads-refresh').click(); await settle(); const before = JSON.stringify(app.state.workspace?.conversationLayout), calls = transportLog.length;
  rowButton('Release plan').click(); await settle();
  assert.equal(reader()?.parentNode?.dataset.paneId, 'empty-pane'); assert.equal(reader()?.querySelector('.inspection-back')?.textContent, 'Close thread');
  assert.equal(byId('conversation-panes').hidden, false); assert.equal(byId('session-chooser').hidden, true);
  assert.equal(JSON.stringify(app.state.workspace?.conversationLayout), before);
  assert.deepEqual(transportLog.slice(calls).filter(call => call.method !== 'GET' && call.path.includes('selection')), []);
  reader()?.querySelector('.inspection-back')?.click(); await settle(); assert.equal(reader(), null); assert.equal(hostDocument.activeElement, rowButton('Release plan'));
  rowButton('Release plan').click(); await settle(); await closeReader(); assert.equal(reader(), null); assert.equal(hostDocument.activeElement, rowButton('Release plan'));
  assert.equal(JSON.stringify(app.state.workspace?.conversationLayout), before);
});

test('the open session picker re-reads its rows when the window regains focus and when a release event arrives', async context => {
  await arrive({workspace: {id: 'picker', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture()], roster: []});
  const file = {id: 'terminal-session', path: '/fixture/terminal-session.jsonl', project: '/fixture', revision: 'r1', title: 'Terminal session', titleState: 'ready', modifiedAt: '2026-01-01T00:00:00Z', size: 10};
  let writer: 'live' | undefined = 'live';
  const body = () => ({items: [{...file, ...(writer ? {writer}: {})}], total: 1, omitted: 0, nextCursor: null, titleCursor: null, observedAt: '2026-01-02T00:00:00Z'});
  const original = globalThis.fetch; let reads = 0;
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/sessions/published')) return Response.json({ok: true, data: {...body(), items: []}});
    if (path.startsWith('/api/sessions?')) { reads++; return Response.json({ok: true, data: body()}); }
    return original(input, init);
  });
  context.after(() => byId('modal-close').click());
  byId('session-open').click(); await settle();
  const row = () => hostDocument.querySelectorAll('.picker-select')[0];
  assert.ok(row()); assert.equal(row()?.disabled, false); assert.match(row()?.textContent ?? '', /live in terminal/);
  const before = reads; writer = undefined;
  dispatchWindow('focus'); await settle();
  assert.ok(reads > before, 'focus re-reads the saved rows');
  assert.match(row()?.textContent ?? '', /Terminal ended/); assert.doesNotMatch(row()?.textContent ?? '', /live in terminal/);
  writer = 'live'; const afterFocus = reads;
  emitEvent('sessions.writers', {released: ['terminal-session']}); await settle();
  assert.ok(reads > afterFocus, 'a release event re-reads the saved rows'); assert.match(row()?.textContent ?? '', /live in terminal/);
});
