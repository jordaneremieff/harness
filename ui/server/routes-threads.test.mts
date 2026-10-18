import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadList, ThreadPage } from '../agents/index.mts';
import { CHILD, STORAGE, THREAD, threadList, threadPage } from '../agents/fake-host.mts';
import { ROUTES, type ThreadListPage, type ThreadPageView } from '../shared/api.ts';
import { ApiError } from './errors.mts';
import type { RequestContext } from './http.mts';
import type { Registry } from './registry.mts';
import { dispatchAgent } from './routes-agent.mts';
import { projectThreadList, projectThreadPage } from './threads.mts';

type Call = [string, ...unknown[]];
function registryFor(calls: Call[], overrides: Record<string, unknown> = {}) {
  return {agents: {
    threads: async (identity: string, options: unknown) => {calls.push(['threads', identity, options]); return threadList() as unknown as ThreadList;},
    thread: async (identity: string, threadId: string, options: unknown) => {calls.push(['thread', identity, threadId, options]); return threadPage({threadId, ...(options as object)}) as unknown as ThreadPage;},
    ...overrides,
  }} as unknown as Registry;
}
function context(identity: string, query = '', read = false, method = 'GET'): RequestContext {
  return {method, parts: ['api', 'agents', identity, 'threads', ...(read ? ['read'] : [])], body: {}, url: new URL(`http://localhost/api${query}`)};
}
const invalid = (error: unknown) => error instanceof ApiError && error.code === 'invalid_request';

test('thread routes are declared as read-only GET routes', () => {
  assert.ok(ROUTES.includes('GET /api/agents/:identity/threads'));
  assert.ok(ROUTES.includes('GET /api/agents/:identity/threads/read'));
  assert.equal(ROUTES.some(route => /threads/.test(route) && !route.startsWith('GET ')), false);
});

test('the thread list route forwards bounded options for the exact identity storage', async () => {
  const calls: Call[] = [];
  const result = await dispatchAgent(registryFor(calls), context(CHILD, '?limit=5&cursor=12&query=design')) as ThreadListPage;
  assert.deepEqual(calls, [['threads', CHILD, {limit: 5, cursor: '12', query: 'design'}]]);
  assert.equal(result.storageId, STORAGE);
  assert.equal(result.items[0].id, THREAD);
  assert.equal(result.nextCursor, null);
  assert.equal(result.coverage.complete, true);
  assert.equal(typeof result.observedAt, 'string');
  calls.length = 0;
  await dispatchAgent(registryFor(calls), context(STORAGE));
  assert.deepEqual(calls, [['threads', STORAGE, {}]]);
});

test('the thread read route validates its selector and page options before the adapter', async () => {
  const calls: Call[] = [];
  const registry = registryFor(calls);
  const result = await dispatchAgent(registry, context(STORAGE, `?threadId=${encodeURIComponent(THREAD)}&limit=2&before=6`, true)) as ThreadPageView;
  assert.deepEqual(calls, [['thread', STORAGE, THREAD, {limit: 2, before: 6}]]);
  assert.equal(result.storageId, STORAGE);
  assert.equal(result.thread.id, THREAD);
  assert.deepEqual(result.events.map(event => event.sequence), [4, 5]);
  calls.length = 0;
  const bad = ['', '?limit=2', `?threadId=${THREAD}&limit=0`, `?threadId=${THREAD}&limit=21`, `?threadId=${THREAD}&limit=1.5`, `?threadId=${THREAD}&limit=01`,
    `?threadId=${THREAD}&before=0`, `?threadId=${THREAD}&before=-1`, `?threadId=${THREAD}&before=abc`, `?threadId=${THREAD}&threadId=${THREAD}`,
    `?threadId=${THREAD}&cursor=1`, `?threadId=${'a'.repeat(129)}`, `?threadId=%00`];
  for (const query of bad) await assert.rejects(dispatchAgent(registry, context(STORAGE, query, true)), invalid, query);
  assert.deepEqual(calls, []);
});

test('thread list queries refuse unknown, repeated and oversized parameters', async () => {
  const calls: Call[] = [];
  const registry = registryFor(calls);
  for (const query of ['?before=1', '?threadId=x', '?limit=0', '?limit=21', '?cursor=', `?cursor=${'1'.repeat(17)}`, `?query=${'x'.repeat(257)}`, '?query=', '?limit=1&limit=2'])
    await assert.rejects(dispatchAgent(registry, context(STORAGE, query)), invalid, query);
  assert.deepEqual(calls, []);
});

test('thread routes accept only well-formed conversation identities and the GET method', async () => {
  const calls: Call[] = [];
  const registry = registryFor(calls);
  for (const identity of ['invalid', `${STORAGE}:0`, `${STORAGE}:02`, `${STORAGE}:2:3`, '../escape'])
    await assert.rejects(dispatchAgent(registry, context(identity)), invalid, identity);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    await assert.rejects(dispatchAgent(registry, context(STORAGE, '', false, method)), error => error instanceof ApiError && error.status === 405);
    await assert.rejects(dispatchAgent(registry, context(STORAGE, `?threadId=${THREAD}`, true, method)), error => error instanceof ApiError && error.status === 405);
  }
  await assert.rejects(dispatchAgent(registry, {...context(STORAGE), parts: ['api', 'agents', STORAGE, 'threads', 'write']}), error => error instanceof ApiError && error.status === 405);
  assert.deepEqual(calls, []);
});

test('thread routes need no workspace and never call a mutating adapter member', async () => {
  const forbidden = () => {throw new Error('No mutation or workspace access belongs to a thread read.');};
  const registry = {workspace: forbidden, startAgent: forbidden, store: {target: forbidden},
    agents: {threads: async () => threadList(), thread: async () => threadPage({threadId: THREAD}), submit: forbidden, retrySubmit: forbidden, abort: forbidden, configure: forbidden, select: forbidden, hide: forbidden}} as unknown as Registry;
  await dispatchAgent(registry, context(STORAGE));
  await dispatchAgent(registry, context(STORAGE, `?threadId=${THREAD}`, true));
});

test('adapter failures keep their safe codes and reach the caller unchanged', async () => {
  const failure = Object.assign(new Error('Stored metadata; no live compatible host.'), {code: 'stored'});
  await assert.rejects(dispatchAgent(registryFor([], {threads: async () => {throw failure;}}), context(STORAGE)), caught => caught === failure);
  await assert.rejects(dispatchAgent(registryFor([], {thread: async () => {throw failure;}}), context(STORAGE, `?threadId=${THREAD}`, true)), caught => caught === failure);
});

test('thread projection keeps shape, cleans display text and unpacks frame events', () => {
  const list = threadList() as unknown as ThreadList;
  list.items[0].title = 'Design \u001b[31mred\u001b[0m Bearer abcdef1234567890';
  const listed = projectThreadList(STORAGE, list, '2026-01-01T00:00:00.000Z');
  assert.equal(listed.items[0].title, 'Design red Bearer [redacted]');
  assert.equal(listed.observedAt, '2026-01-01T00:00:00.000Z');
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
