import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, authenticate, operation, request, reserve } from './transport.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function json(data: unknown): Response { return Response.json({ok: true, data}); }
test('request preserves the issued operation key and exact captured body', async () => {
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_path, init) => { captured = init; return json({state: 'accepted'}); };
  const body = {message: '  exact\ntext  ', epoch: 2};
  const result = await request('/api/primaries/p/inputs', 'POST', body, 'issued-key');
  assert.deepEqual(result, {state: 'accepted'});
  assert.equal(captured?.body, JSON.stringify(body));
  assert.deepEqual(captured?.headers, {'Content-Type': 'application/json', 'Idempotency-Key': 'issued-key'});
  assert.equal(captured?.credentials, 'same-origin');
});
test('typed API refusal retains its retry and target details', async () => {
  const view = {code: 'stale_epoch', message: 'Conversation changed', retry: 'read', target: {kind: 'primary', key: 'p', epoch: 1}};
  globalThis.fetch = async () => Response.json({ok: false, error: view}, {status: 409});
  await assert.rejects(request('/api/primaries/p'), error => error instanceof ApiError && error.view.code === 'stale_epoch' && error.view.retry === 'read' && error.message === view.message);
});
test('input operation uses its existing reservation without another request', async () => {
  const calls: string[] = [];
  globalThis.fetch = async path => { calls.push(String(path)); return json({id: 'reserved', state: 'accepted'}); };
  await operation('primary.input', '/api/primaries/p/inputs', {message: 'hello'}, {kind: 'primary', key: 'p', epoch: 1}, 'reserved');
  assert.deepEqual(calls, ['/api/primaries/p/inputs']);
});
test('a control reserves before dispatch and binds the captured target', async () => {
  const bodies: unknown[] = []; const paths: string[] = [];
  const target = {kind: 'agent' as const, identity: 'agent'};
  globalThis.fetch = async (path, init) => { paths.push(String(path)); bodies.push(JSON.parse(String(init?.body))); return paths.length === 1 ? json({operationId: 'issued', state: 'reserved'}) : json({id: 'issued'}); };
  await operation('agent.abort', '/api/agents/agent/abort', {background: false}, target);
  assert.deepEqual(paths, ['/api/operations', '/api/agents/agent/abort']);
  assert.deepEqual(bodies, [{kind: 'agent.abort', target}, {background: false}]);
});
test('a transport loss does not resend an ordinary mutation', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('connection lost'); };
  await assert.rejects(operation('primary.input', '/api/primaries/p/inputs', {}, undefined, 'known'), /connection lost/);
  assert.equal(calls, 1);
});
test('an unsuccessful reservation never dispatches its control', async () => {
  const paths: string[] = [];
  globalThis.fetch = async path => { paths.push(String(path)); return Response.json({ok: false, error: {code: 'capacity', message: 'Capacity', retry: 'none'}}, {status: 429}); };
  await assert.rejects(operation('agent.abort', '/api/agents/a/abort', {}), /Capacity/);
  assert.deepEqual(paths, ['/api/operations']);
});
test('read cancellation reaches fetch without another request', async () => {
  const controller = new AbortController();
  globalThis.fetch = async (_path, init) => { assert.equal(init?.signal, controller.signal); return json({}); };
  await request('/api/agents/a/history', 'GET', undefined, undefined, controller.signal);
});
test('reservation issues no target mutation', async () => {
  globalThis.fetch = async (path, init) => { assert.equal(path, '/api/operations'); assert.deepEqual(JSON.parse(String(init?.body)), {kind: 'primary.open'}); return json({operationId: 'issued'}); };
  assert.equal(await reserve('primary.open'), 'issued');
});
test('launch removes capability material before authentication transport', async () => {
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const oldHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  let current = 'http://127.0.0.1:1234/#launch=one-use';
  Object.defineProperty(globalThis, 'location', {configurable: true, value: {get href() {return current;}}});
  Object.defineProperty(globalThis, 'history', {configurable: true, value: {replaceState(_data: unknown, _title: string, value: URL) {current = String(value);}}});
  globalThis.fetch = async (_path, init) => { assert.equal(new URL(current).hash, ''); assert.deepEqual(JSON.parse(String(init?.body)), {capability: 'one-use'}); return json({authenticated: true}); };
  try { await authenticate(); } finally {
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else Reflect.deleteProperty(globalThis, 'location');
    if (oldHistory) Object.defineProperty(globalThis, 'history', oldHistory); else Reflect.deleteProperty(globalThis, 'history');
  }
});
