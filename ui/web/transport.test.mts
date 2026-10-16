import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, operation, request, reserve, setRequestTiming, connect, uploadDraftImage, draftImageUrl } from './transport.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setRequestTiming(); });
function json(data: unknown): Response { return Response.json({ok: true, data}); }
test('working-folder requests carry the page workspace and the exact root selection body',async t=> {
  const previous = Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://fixture/?workspace=workspace'}});
  t.after(()=> {if (previous) Object.defineProperty(globalThis,'location',previous);else Reflect.deleteProperty(globalThis,'location');});
  const seen:{path:string;method:string;body:unknown}[] = [];
  globalThis.fetch = async(path,init)=> {
    seen.push({path:String(path),method:init?.method ?? 'GET',body:init?.body === undefined ? undefined : JSON.parse(String(init.body))});
    return json({revision:0,root:null});
  };
  const path = '/api/workspaces/workspace/files/root',body = {path:'/project',expectedRevision:0};
  await request(path);await request(path,'PUT',body);
  assert.deepEqual(seen,[{path:`${path}?workspace=workspace`,method:'GET',body:undefined},{path:`${path}?workspace=workspace`,method:'PUT',body}]);
});
test('raw image upload retains its captured path, bytes and cancellation across page workspace changes', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {configurable: true, value: {href: 'http://fixture/?workspace=new-page'}});
  t.after(() => {if (previous) Object.defineProperty(globalThis, 'location', previous); else Reflect.deleteProperty(globalThis, 'location');});
  const controller = new AbortController(), bytes = new Blob(['image']); let seen: RequestInit | undefined;
  globalThis.fetch = async (path, init) => {assert.equal(path, '/api/workspaces/old%20workspace/targets/old%20target/images?name=one.png&epoch=7'); seen = init; return json({targetKey: 'old target'});};
  await uploadDraftImage('old workspace', 'old target', {kind: 'primary', key: 'p', epoch: 7}, {name: 'one.png', mimeType: 'image/png'}, bytes, controller.signal);
  assert.equal(seen?.body, bytes); assert.deepEqual(seen?.headers, {'Content-Type': 'image/png'}); assert.equal(seen?.credentials, 'same-origin');
  controller.abort(); assert.equal(seen?.signal?.aborted, true);
  assert.equal(draftImageUrl('w', 't', 'a'.repeat(64)), `/api/workspaces/w/targets/t/images/${'a'.repeat(64)}`); assert.throws(() => draftImageUrl('w', 't', '../file'));
});
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
test('event connections preserve the supplied page scope across reconnects and workspace changes',t=> {
  const previous = Object.getOwnPropertyDescriptor(globalThis,'EventSource'),urls:string[] = [];class Source {constructor(url:string) {urls.push(url);}addEventListener() {}close() {}}
  Object.defineProperty(globalThis,'EventSource',{configurable:true,value:Source});t.after(()=> {if (previous) Object.defineProperty(globalThis,'EventSource',previous);else Reflect.deleteProperty(globalThis,'EventSource');});const clientId = crypto.randomUUID();
  connect('one','first',()=>{},()=>{},clientId);connect('one','second',()=>{},()=>{},clientId);connect('two','next',()=>{},()=>{},clientId);connect('other','plain',()=>{},()=>{});
  assert.deepEqual(urls.map(url=>new URL(url,'http://fixture').searchParams.get('clientId')),[clientId,clientId,clientId,null]);assert.deepEqual(urls.map(url=>new URL(url,'http://fixture').searchParams.get('workspace')),['one','one','two','other']);
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
