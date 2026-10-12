import assert from 'node:assert/strict';
import test from 'node:test';
import {BrowserDiagnostics, type BrowserDiagnosticEvent, type BrowserDiagnosticsOptions, type DiagnosticClock, type DiagnosticTiming} from './diagnostics.ts';

const event = (): BrowserDiagnosticEvent => ({event: 'connection', code: 'none', status: 200});
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function gate() {
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<unknown>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function reply(count: number, dropped = 0, failed = false) { return {ok: true, data: {accepted: count - dropped, dropped, failed}}; }
class Clock implements DiagnosticClock {
  at = 0;
  serial = 0;
  timers = new Map<number, {at: number; callback: () => void}>();
  now = () => this.at;
  set = (callback: () => void, delay: number) => {const id = ++this.serial; this.timers.set(id, {at: this.at + delay, callback}); return id;};
  clear = (id: unknown) => {this.timers.delete(id as number);};
  async advance(ms: number) {
    const end = this.at + ms;
    for (let steps = 0; steps < 1000; steps++) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) {this.at = end; await tick(); return;}
      this.at = next[1].at; this.timers.delete(next[0]); next[1].callback(); await tick();
    }
    assert.fail('unbounded timer loop');
  }
}
function fixture(options: BrowserDiagnosticsOptions = {}, active = true) {
  const clock = new Clock();
  const entries = new Map<string, Array<{start: number; end: number}>>(); entries.set('other-library', [{start: 0, end: 1}]);
  const timing: DiagnosticTiming = {
    measure: (name, span) => {const list = entries.get(name) ?? []; list.push(span); entries.set(name, list);},
    clearMeasures: name => {entries.delete(name);},
  };
  const requests: Array<{at: number; records: BrowserDiagnosticEvent[]; dropped: number; encoded: string}> = [];
  const sink = new BrowserDiagnostics({clock, timing, send: async body => {
    const data = JSON.parse(body); requests.push({at: clock.now(), ...data, encoded: body}); return reply(data.records.length);
  }, ...options});
  if (active) sink.setActive(true);
  return {sink, clock, entries, requests};
}

test('construction and unauthenticated use produce no timers, records or requests', async () => {
  const f = fixture({}, false);
  assert.equal(f.sink.emit(event()), false); assert.equal(f.sink.measure('reducer', 0, 1), false);
  assert.equal(await f.sink.flush(), false); assert.equal(f.clock.timers.size, 0); assert.equal(f.sink.state().buffered, 0);
  f.sink.setActive(true); f.sink.emit(event()); await f.clock.advance(1000);
  assert.equal(f.requests.length, 1); f.sink.close();
});

test('closed metadata snapshots reject body, identity, error, prototype, symbol and accessor payloads', async () => {
  const f = fixture(); let invoked = 0;
  const invalid: unknown[] = [null, [], undefined, {event: 'measure'}, {event: 'connection', code: 'SECRET'},
    {event: 'connection', durationMs: Infinity}, {event: 'connection', bytes: -1}, {event: 'connection', status: 99},
    {event: 'connection', status: 600}, {event: 'connection', count: 0.5}, {event: 'connection', count: Number.MAX_SAFE_INTEGER + 1},
    {event: 'connection', durationMs: 60001}, {event: 'connection', metric: 'toString'}, {event: 'connection', bytes: 16777217},
    Object.assign(Object.create({body: 'SECRET'}), event()), {...event(), [Symbol('SECRET')]: 'SECRET'},
    Object.defineProperty(event(), 'status', {get() {invoked++; throw new Error('SECRET');}}),
    {...event(), toJSON() {invoked++; return 'SECRET';}}, new Proxy(event(), {ownKeys() {throw new Error('SECRET');}})];
  for (const name of ['body', 'prompt', 'tool', 'headers', 'cookies', 'capability', 'error', 'stack', 'path', 'identity', 'at', 'boot', 'source', 'build']) invalid.push({...event(), [name]: 'SECRET /synthetic/private'});
  for (const item of invalid) assert.equal(f.sink.emit(item as BrowserDiagnosticEvent), false);
  assert.equal(invoked, 0); assert.equal(f.sink.state().dropped, invalid.length);
  await f.clock.advance(1000);
  assert.deepEqual(f.requests[0]?.records, []); assert.equal(f.requests[0]?.dropped, invalid.length);
  assert.doesNotMatch(f.requests[0]?.encoded ?? '', /SECRET|synthetic|cookies|capability/);
  f.sink.close();
});

test('caller mutations never alter serialized queue records', async () => {
  const f = fixture(); const original = event(); f.sink.emit(original);
  original.status = 599; Object.assign(original, {body: 'SECRET'});
  await f.sink.flush(); assert.deepEqual(f.requests[0]?.records, [event()]); f.sink.close();
});

test('queue and in-flight reservations stay within 64 records and count exact overflow', async () => {
  const held = gate(); const bodies: string[] = [];
  const f = fixture({send: body => {bodies.push(body); return held.promise;}});
  for (let i = 0; i < 64; i++) assert.equal(f.sink.emit(event()), true);
  assert.equal(f.sink.emit(event()), false);
  const first = f.sink.flush(); const second = f.sink.flush(); assert.equal(first, second); await tick();
  assert.equal(bodies.length, 1); assert.equal(JSON.parse(bodies[0] ?? '').records.length, 16);
  assert.equal(f.sink.state().queued, 48); assert.equal(f.sink.state().buffered, 64);
  for (let i = 0; i < 100; i++) assert.equal(f.sink.emit(event()), false);
  assert.equal(f.sink.state().dropped, 101); assert.equal(f.sink.state().pendingDropped, 100);
  assert.ok(f.sink.state().bytes <= 65536); assert.ok(Buffer.byteLength(bodies[0] ?? '') <= 16384);
  held.resolve(reply(16)); assert.equal(await first, true);
  assert.equal(f.sink.state().buffered, 48); f.sink.close();
});

test('batches and explicit flush calls share the one-second rate limit with exact envelope bytes', async () => {
  const f = fixture();
  for (let i = 0; i < 64; i++) f.sink.emit({event: 'connection', code: 'none', durationMs: 60000, count: Number.MAX_SAFE_INTEGER, bytes: 16777216, status: 599});
  await f.sink.flush(); assert.equal(await f.sink.flush(), false);
  await f.clock.advance(999); assert.equal(f.requests.length, 1);
  await f.clock.advance(2001); assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests.map(r => r.records.length), [16, 16, 16, 16]);
  assert.deepEqual(f.requests.map(r => r.at), [0, 1000, 2000, 3000]);
  for (const r of f.requests) assert.ok(Buffer.byteLength(r.encoded) <= 16384);
  assert.equal(f.sink.state().bytes, 0); assert.equal(f.sink.state().accepted, 64); f.sink.close();
});

test('hidden transitions cancel scheduled work; visibility restoration resumes without background polling', async () => {
  const f = fixture(); f.sink.emit(event()); f.sink.setHidden(true);
  assert.equal(await f.sink.flush(), false); await f.clock.advance(20000);
  assert.equal(f.requests.length, 0); assert.equal(f.clock.timers.size, 0);
  f.sink.setHidden(false); await f.clock.advance(1000); assert.equal(f.requests.length, 1); f.sink.close();
});

test('all measure ingress aggregates over five seconds, including a quiet final sample', async () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) f.sink.measure('editor-echo', 0, 60000);
  f.sink.emit({event: 'measure', metric: 'editor-echo', durationMs: 0, count: 1000});
  assert.equal(f.entries.get('ui:editor-echo')?.length, 1);
  await f.clock.advance(4999); assert.equal(f.requests.length, 0);
  await f.clock.advance(1);
  assert.deepEqual(f.requests[0]?.records, [{event: 'measure', metric: 'editor-echo', durationMs: 30000, count: 2000}]);
  assert.equal(f.sink.state().aggregates, 0); assert.equal(f.clock.timers.size, 0); f.sink.close();
});

test('timing names describe schedule and receive to DOM-update spans and never erase foreign entries', async () => {
  const f = fixture();
  f.sink.measure('render', 100, 120); f.sink.measure('stream-to-render', 80, 120);
  assert.deepEqual(f.entries.get('ui:schedule-to-dom-update'), [{start: 100, end: 120}]);
  assert.deepEqual(f.entries.get('ui:stream-receive-to-dom-update'), [{start: 80, end: 120}]);
  assert.equal(f.entries.has('ui:stream-receive-to-paint'), false);
  f.sink.close(); assert.deepEqual([...f.entries.keys()], ['other-library']);
});

test('invalid spans never record User Timing and aggregate counters never overflow', async () => {
  const f = fixture();
  for (const [start, end] of [[-1, 1], [2, 1], [0, 60001], [NaN, 1], [0, Infinity]]) assert.equal(f.sink.measure('render', start as number, end as number), false);
  assert.equal(f.sink.measure('SECRET' as never, 0, 1), false);
  f.sink.emit({event: 'measure', metric: 'render', durationMs: 1, count: Number.MAX_SAFE_INTEGER});
  assert.equal(f.sink.measure('render', 0, 1), false);
  await f.clock.advance(5000);
  assert.equal(f.requests[0]?.records[0]?.count, Number.MAX_SAFE_INTEGER);
  assert.equal(f.requests[0]?.records[0]?.durationMs, 1); assert.equal(f.sink.state().lostSamples, 7); f.sink.close();
});

test('unavailable User Timing never interrupts input or aggregate delivery', async () => {
  const f = fixture({timing: {clearMeasures() {throw new Error('unsupported');}, measure() {throw new Error('unsupported');}}});
  assert.equal(f.sink.measure('reducer', 0, 1), true); await f.clock.advance(5000);
  assert.equal(f.requests[0]?.records[0]?.durationMs, 1); assert.doesNotThrow(() => f.sink.close());
});

test('transport failures stop automatic work, retain new records within bounds and never replay uncertain batches', async () => {
  const held = gate(); const bodies: string[] = []; let working = false;
  const f = fixture({send: body => {bodies.push(body); return working ? Promise.resolve(reply(JSON.parse(body).records.length)) : held.promise;}});
  f.sink.emit({...event(), status: 201}); f.sink.emit({...event(), body: 'SECRET'} as BrowserDiagnosticEvent);
  const pending = f.sink.flush(); await tick(); f.sink.emit({...event(), status: 202});
  held.reject(new Error('SECRET capability')); assert.equal(await pending, false);
  assert.equal(f.sink.state().unconfirmed, 1); assert.equal(f.sink.state().unconfirmedLoss, 1);
  assert.equal(f.sink.state().failed, true); await f.clock.advance(20000); assert.equal(bodies.length, 1);
  working = true; f.sink.setActive(true); await f.clock.advance(1000);
  assert.deepEqual(JSON.parse(bodies[1] ?? ''), {records: [{...event(), status: 202}], dropped: 0});
  assert.equal(f.sink.state().accepted, 1); f.sink.close();
});

test('server acceptance, losses and failure are honored rather than treating HTTP success as full delivery', async () => {
  const f = fixture({send: async () => reply(2, 1, true)});
  f.sink.emit(event()); f.sink.emit(event()); assert.equal(await f.sink.flush(), false);
  assert.equal(f.sink.state().accepted, 1); assert.equal(f.sink.state().serverDropped, 1); assert.equal(f.sink.state().failed, true);
  assert.equal(f.sink.state().unconfirmed, 0); f.sink.close();
});

test('malformed or refused response envelopes remain unconfirmed without automatic retry', async () => {
  for (const response of [undefined, {ok: false, error: {message: 'SECRET'}}, reply(2), {ok: true, data: {accepted: -1, dropped: 2, failed: false}}]) {
    const f = fixture({send: async () => response}); f.sink.emit(event());
    assert.equal(await f.sink.flush(), false); assert.equal(f.sink.state().unconfirmed, 1);
    await f.clock.advance(10000); assert.equal(f.clock.timers.size, 0); f.sink.close();
  }
});

test('request deadlines release accounting even when a transport ignores abort; late success has no effect', async () => {
  const held = gate(); let signal: AbortSignal | undefined;
  const f = fixture({send: (_body, captured) => {signal = captured; return held.promise;}});
  f.sink.emit(event()); const pending = f.sink.flush(); await tick(); await f.clock.advance(5000);
  assert.equal(await pending, false); assert.equal(signal?.aborted, true);
  const state = f.sink.state(); assert.equal(state.buffered, 0); assert.equal(state.bytes, 0);
  held.resolve(reply(1)); await tick(); assert.deepEqual(f.sink.state(), state); f.sink.close();
});

test('close cancels delivery without awaiting it and discards queued work exactly once', async () => {
  const held = gate(); const f = fixture({send: () => held.promise});
  for (let i = 0; i < 20; i++) f.sink.emit(event());
  f.sink.measure('render', 0, 1); const pending = f.sink.flush(); await tick();
  f.sink.close(); f.sink.close(); assert.equal(await pending, false);
  assert.equal(f.sink.state().unconfirmed, 16); assert.equal(f.sink.state().dropped, 4); assert.equal(f.sink.state().lostSamples, 1);
  assert.equal(f.sink.state().buffered, 0); assert.equal(f.sink.state().bytes, 0);
  assert.equal(f.sink.emit(event()), false); f.sink.setActive(true); f.sink.setHidden(false);
  await f.clock.advance(20000); assert.equal(f.clock.timers.size, 0);
});

test('authentication loss aborts an active request and disables future recording and sends', async () => {
  const held = gate(); const f = fixture({send: () => held.promise});
  f.sink.emit(event()); const pending = f.sink.flush(); await tick(); f.sink.setActive(false);
  assert.equal(await pending, false); assert.equal(f.sink.emit(event()), false); assert.equal(await f.sink.flush(), false);
  assert.equal(f.clock.timers.size, 0); f.sink.close();
});

test('a late aborted request cannot suspend a newer authenticated lifecycle', async () => {
  const held = gate(); let calls = 0;
  const f = fixture({send: async () => {calls++; return calls === 1 ? held.promise : reply(1);}});
  f.sink.emit(event()); const old = f.sink.flush(); await tick();
  f.sink.setActive(false); f.sink.setActive(true); f.sink.emit(event());
  assert.equal(await old, false); assert.equal(f.sink.state().failed, false);
  await f.clock.advance(1000); assert.equal(calls, 2); assert.equal(f.sink.state().accepted, 1); f.sink.close();
});

test('a saturated queue reports both dropped aggregate records and their sample count', async () => {
  const f = fixture(); f.sink.setHidden(true);
  for (let i = 0; i < 64; i++) f.sink.emit(event());
  for (let i = 0; i < 100; i++) f.sink.measure('render', 0, 1);
  await f.clock.advance(5000); f.sink.setHidden(false); await f.sink.flush();
  assert.equal(f.sink.state().dropped, 1); assert.equal(f.sink.state().lostSamples, 100);
  assert.equal(f.requests[0]?.dropped, 1); assert.equal(f.sink.state().aggregates, 0); f.sink.close();
});

test('default sender uses only the fixed same-origin endpoint and no instrumented transport', async () => {
  const prior = globalThis.fetch; const calls: Array<{path: unknown; options: RequestInit | undefined}> = [];
  globalThis.fetch = (async (path: unknown, options?: RequestInit) => {
    calls.push({path, options}); return {ok: true, json: async () => reply(1)};
  }) as typeof fetch;
  try {
    const f = fixture({send: undefined}); f.sink.emit(event()); await f.sink.flush();
    assert.equal(calls[0]?.path, '/api/dev/diagnostics'); assert.equal(calls[0]?.options?.credentials, 'same-origin');
    assert.equal(calls[0]?.options?.redirect, 'error'); assert.deepEqual(calls[0]?.options?.headers, {'Content-Type': 'application/json'});
    assert.deepEqual(JSON.parse(String(calls[0]?.options?.body)), {records: [event()], dropped: 0}); f.sink.close();
  } finally {globalThis.fetch = prior;}
});
