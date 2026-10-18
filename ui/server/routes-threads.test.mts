import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentError, type ThreadList, type ThreadPage } from '../agents/index.mts';
import { CHILD, STORAGE, THREAD, threadList, threadPage } from '../agents/fake-host.mts';
import { ROUTES, type ThreadPageView } from '../shared/api.ts';
import { ApiError } from './errors.mts';
import type { RequestContext } from './http.mts';
import type { Registry } from './registry.mts';
import { dispatchThreads } from './routes-threads.mts';
import { projectThreadItems, projectThreadPage } from './threads.mts';

type Call = [string, ...unknown[]];
function registryFor(calls: Call[], overrides: Record<string, unknown> = {}) {
  return {agents: {
    roster: () => ({rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}, stale: false, scan: {}}),
    threads: async () => threadList() as unknown as ThreadList,
    thread: async (identity: string, threadId: string, options: unknown) => {calls.push(['thread', identity, threadId, options]); return threadPage({threadId, ...(options as object)}) as unknown as ThreadPage;},
    ...overrides,
  }} as unknown as Registry;
}
function context(query = '', read = true, method = 'GET'): RequestContext {
  return {method, parts: ['api', 'threads', ...(read ? ['read'] : [])], body: {}, url: new URL(`http://localhost/api${query}`)};
}
const invalid = (error: unknown) => error instanceof ApiError && error.code === 'invalid_request';

test('thread routes are declared as two read-only GET routes and no identity route remains', () => {
  assert.ok(ROUTES.includes('GET /api/threads'));
  assert.ok(ROUTES.includes('GET /api/threads/read'));
  assert.equal(ROUTES.filter(route => /threads/.test(route)).length, 2);
  assert.equal(ROUTES.some(route => /threads/.test(route) && !route.startsWith('GET ')), false);
});

test('the thread read route goes to the storage that owns the thread and forwards bounded options', async () => {
  const calls: Call[] = [];
  const registry = registryFor(calls);
  const result = await dispatchThreads(registry, context(`?threadId=${encodeURIComponent(THREAD)}&limit=2&before=6`)) as ThreadPageView;
  assert.deepEqual(calls, [['thread', STORAGE, THREAD, {limit: 2, before: 6}]]);
  assert.equal(result.storageId, STORAGE);
  assert.equal(result.thread.id, THREAD);
  assert.deepEqual(result.events.map(event => event.sequence), [4, 5]);
  calls.length = 0;
  await dispatchThreads(registry, context(`?threadId=${THREAD}`));
  assert.deepEqual(calls, [['thread', STORAGE, THREAD, {}]]);
});

test('the thread read route validates its selector and page options before the adapter', async () => {
  const calls: Call[] = [];
  const registry = registryFor(calls);
  const bad = ['', '?limit=2', `?threadId=${STORAGE}`, `?threadId=${THREAD}x`, `?threadId=${THREAD}&limit=0`, `?threadId=${THREAD}&limit=21`, `?threadId=${THREAD}&limit=1.5`,
    `?threadId=${THREAD}&limit=01`, `?threadId=${THREAD}&before=0`, `?threadId=${THREAD}&before=-1`, `?threadId=${THREAD}&before=abc`, `?threadId=${THREAD}&threadId=${THREAD}`,
    `?threadId=${THREAD}&cursor=1`, `?threadId=${'a'.repeat(129)}`, '?threadId=%00'];
  for (const query of bad) await assert.rejects(dispatchThreads(registry, context(query)), invalid, query);
  assert.deepEqual(calls, []);
});

test('the thread list takes no query and thread routes accept only GET', async () => {
  const registry = registryFor([]);
  for (const query of ['?limit=1', '?cursor=0', '?query=x', `?identity=${STORAGE}`]) await assert.rejects(dispatchThreads(registry, context(query, false)), invalid, query);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    await assert.rejects(dispatchThreads(registry, context('', false, method)), error => error instanceof ApiError && error.status === 405);
    await assert.rejects(dispatchThreads(registry, context(`?threadId=${THREAD}`, true, method)), error => error instanceof ApiError && error.status === 405);
  }
  await assert.rejects(dispatchThreads(registry, {...context(), parts: ['api', 'threads', 'write']}), error => error instanceof ApiError && error.status === 405);
});

test('thread routes need no workspace and never call a mutating adapter member', async () => {
  const forbidden = () => {throw new Error('No mutation or workspace access belongs to a thread read.');};
  const registry = {workspace: forbidden, startAgent: forbidden, store: {target: forbidden},
    agents: {roster: () => ({rows: [], nextCursor: null, coverage: {complete: true, omitted: 0}}), threads: async () => threadList(), thread: async () => threadPage({threadId: THREAD}),
      submit: forbidden, retrySubmit: forbidden, abort: forbidden, configure: forbidden, select: forbidden, hide: forbidden}} as unknown as Registry;
  await dispatchThreads(registry, context('', false));
  await dispatchThreads(registry, context(`?threadId=${THREAD}`));
});

test('absent or unequal thread operations map to threads_unavailable with a status other than 500; other failures pass through', async () => {
  const unavailable = new AgentError('threads_unavailable', 'Host operation collaboration-list is unavailable.');
  await assert.rejects(dispatchThreads(registryFor([], {thread: async () => {throw unavailable;}}), context(`?threadId=${THREAD}`)),
    error => error instanceof ApiError && error.code === 'threads_unavailable' && error.status === 501 && error.retry === 'none');
  for (const code of ['stored', 'host_unavailable', 'protocol_error']) {
    const failure = new AgentError(code, 'The host did not answer.');
    await assert.rejects(dispatchThreads(registryFor([], {thread: async () => {throw failure;}}), context(`?threadId=${THREAD}`)), caught => caught === failure);
  }
});

test('thread projection keeps shape, cleans display text and unpacks frame events', () => {
  const list = threadList() as unknown as ThreadList;
  list.items[0].title = 'Design \u001b[31mred\u001b[0m Bearer abcdef1234567890';
  const listed = projectThreadItems(STORAGE, list);
  assert.equal(listed[0].title, 'Design red Bearer [redacted]');
  assert.equal(listed[0].storageId, STORAGE);
  const source = threadPage({threadId: THREAD}) as unknown as ThreadPage;
  source.events[2].message = 'Token sk-abcdefghijklmnopqrstuvwxyz is mine\u0007';
  source.events[4].source = 'Operator\u0000';
  const view = projectThreadPage(STORAGE, source, '2026-01-01T00:00:00.000Z');
  assert.equal(view.events.length, 5);
  assert.equal(view.events[2].message, 'Token [redacted credential] is mine');
  assert.equal(view.events[4].source, 'Operator');
  assert.equal(view.thread.members[1].identity, CHILD);
  assert.equal(view.thread.members[1].contribution, 'Challenge');
  assert.equal(view.thread.integrator, STORAGE);
  assert.equal(view.coverage.complete, true);
  assert.equal(view.nextBefore, null);
  const create = view.events[0], revise = view.events[3];
  assert.equal(create.kind, 'create');
  assert.equal(create.frame?.purpose, 'Keep peers');
  assert.equal(create.message, '');
  assert.equal(revise.frame?.purpose, 'Keep peers useful');
  assert.equal(revise.revision, 2);
  assert.equal(view.events[1].frame, undefined);
  assert.equal(view.events[1].message, 'Challenge');
  assert.equal(view.events[2].replyTo, 1);
  assert.deepEqual(view.events[2].notify, [CHILD]);
});

test('a frame event whose text is not a complete frame stays plain text', () => {
  const source = threadPage({threadId: THREAD}) as unknown as ThreadPage;
  source.events[0].message = '{"title":"Only a title"}';
  source.events[3].message = 'not json';
  const view = projectThreadPage(STORAGE, source);
  assert.equal(view.events[0].frame, undefined);
  assert.equal(view.events[0].message, '{"title":"Only a title"}');
  assert.equal(view.events[3].frame, undefined);
  assert.equal(view.events[3].message, 'not json');
});

test('thread pages keep their continuation for older events', () => {
  const view = projectThreadPage(STORAGE, threadPage({threadId: THREAD, limit: 2}) as unknown as ThreadPage);
  assert.deepEqual(view.events.map(event => event.sequence), [4, 5]);
  assert.equal(view.nextBefore, 4);
  assert.equal(view.coverage.complete, false);
  assert.equal(view.pending, 0);
});
