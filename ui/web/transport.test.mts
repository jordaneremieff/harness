import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, authenticate, operation, request, reserve, setUnauthorizedHandler, setRequestTiming, connect } from './transport.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setUnauthorizedHandler(); setRequestTiming(); });
function json(data: unknown): Response { return Response.json({ok: true, data}); }
test('request timing supplies only its own numeric interval without creating UserTiming entries', async () => {
  const samples: number[][] = [], pending = Promise.withResolvers<Response>(); const count = performance.getEntriesByName('ui:control-roundtrip').length;
  globalThis.fetch = () => pending.promise; setRequestTiming((start, end) => {samples.push([start, end]);});
  const result = request('/api/primaries/p/inputs', 'POST', {message: 'private text'}, 'private operation'); let other = 0; setRequestTiming(() => {other++;});
  pending.resolve(json({value: 'exact'})); assert.deepEqual(await result, {value: 'exact'}); assert.equal(other, 0); assert.equal(samples.length, 1);
  assert.equal(samples[0]?.length, 2); assert.ok(samples[0]?.every(Number.isFinite)); assert.ok((samples[0]?.[1] ?? -1) >= (samples[0]?.[0] ?? 0));
  assert.equal(performance.getEntriesByName('ui:control-roundtrip').length, count);
  setRequestTiming(() => {throw Error('diagnostic failure');}); globalThis.fetch = async () => json({value: 'still exact'});
  assert.deepEqual(await request('/api/primaries/p'), {value: 'still exact'});
});
test('event receipt carries a monotonic timestamp without a global receive mark', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource'); const listeners = new Map<string, (event: {data: string; lastEventId: string}) => void>();
  class Source {onerror?: () => void; addEventListener(name: string, callback: (event: {data: string; lastEventId: string}) => void) {listeners.set(name, callback);} close() {}}
  Object.defineProperty(globalThis, 'EventSource', {configurable: true, value: Source});
  try {
    const received: import('./transport.ts').ReceivedEvent[] = []; let lost = 0; connect('w', 'cursor', event => {received.push(event);}, () => {lost++;});
    const count = performance.getEntriesByName('ui:event:receive').length, start = performance.now(), envelope = {workspaceId: 'w', data: {text: 'exact payload'}};
    listeners.get('primary.delta')?.({data: JSON.stringify(envelope), lastEventId: 'cursor2'});
    assert.equal(received.length, 1); assert.deepEqual(received[0]?.envelope, envelope); assert.equal(received[0]?.id, 'cursor2');
    assert.ok((received[0]?.receivedAt ?? -1) >= start); assert.ok((received[0]?.receivedAt ?? Infinity) <= performance.now());
    assert.equal(lost, 0); assert.equal(performance.getEntriesByName('ui:event:receive').length, count);
  } finally {if (original) Object.defineProperty(globalThis, 'EventSource', original); else Reflect.deleteProperty(globalThis, 'EventSource');}
});
test('later draft and control refusals report access without replacing the typed error or retrying', async () => {
  for (const [path, method] of [['/api/workspaces/w/drafts', 'PUT'], ['/api/primaries/p/control', 'POST']]) {
    let notified: ApiError | undefined; let calls = 0; let reports = 0;
    setUnauthorizedHandler(error => { notified = error; reports++; });
    globalThis.fetch = async () => { calls++; return Response.json({ok: false, error: {code: 'unauthorized', message: 'Access required', retry: 'none'}}, {status: 401}); };
    await assert.rejects(request(path, method, {text: 'retained'}), error => error === notified && error instanceof ApiError && error.view.code === 'unauthorized');
    assert.equal(calls, 1); assert.equal(reports, 1);
  }
});
test('an unauthorized control reservation reports access without dispatching its mutation', async () => {
  const paths: string[] = []; let reports = 0; setUnauthorizedHandler(() => { reports++; });
  globalThis.fetch = async path => { paths.push(String(path)); return Response.json({ok: false, error: {code: 'unauthorized', message: 'Access required', retry: 'none'}}, {status: 401}); };
  await assert.rejects(operation('primary.control', '/api/primaries/p/control', {epoch: 1, action: 'thinking', level: 'high'}), ApiError);
  assert.deepEqual(paths, ['/api/operations']); assert.equal(reports, 1);
});
test('ordinary API refusals do not change browser access', async () => {
  let reports = 0; setUnauthorizedHandler(() => { reports++; });
  globalThis.fetch = async () => Response.json({ok: false, error: {code: 'stale_epoch', message: 'Conversation changed', retry: 'read'}}, {status: 409});
  await assert.rejects(request('/api/primaries/p/control', 'POST', {}), ApiError); assert.equal(reports, 0);
});

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
