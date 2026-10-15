import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {DevReload, browserDevReloadEnvironment, validateDevReloadCheckpoint, type DevBuild, type DevInteraction, type DevReloadCheckpoint, type DevReloadEnvironment, type DevReloadHooks, type DevReloadNotice, type DevReloadView, type DevStylesheet} from './dev-reload.ts';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const OLD = '1'.repeat(24), NEW = '2'.repeat(24);
const NOW = 1_000_000;
function build(revision = 1, generation = B, change: DevBuild['change'] = 'css', status: DevBuild['status'] = 'ready'): DevBuild {
  return {revision, generation, previous: A, change, status, code: status === 'restart-required' ? 'backend-change' : 'none'};
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function flush(): Promise<void> {for (let i = 0; i < 32; i++) await Promise.resolve();}
class Clock {
  time = NOW; next = 0; timers = new Map<number, {at: number; callback: () => void}>();
  now = () => this.time;
  set = (callback: () => void, delay: number) => {const id = ++this.next; this.timers.set(id, {at: this.time + delay, callback}); return id;};
  clear = (id: number) => {this.timers.delete(id);};
  advance(delay: number): void {
    this.time += delay;
    for (;;) {
      const due = [...this.timers].filter(([, value]) => value.at <= this.time).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break; this.timers.delete(due[0]); due[1].callback();
    }
  }
}
class Source {
  closed = 0;
  readonly receive: (data: string) => void; readonly lost: () => void; readonly trace: string[];
  constructor(receive: (data: string) => void, lost: () => void, trace: string[]) {this.receive = receive; this.lost = lost; this.trace = trace;}
  emit(value: DevBuild): void {this.receive(JSON.stringify(value));}
  close(): void {this.closed++; this.trace.push('close');}
}
class Stylesheet implements DevStylesheet {
  applied = false; discarded = false;
  readonly trace: string[];
  constructor(trace: string[]) {this.trace = trace;}
  apply(): void {assert.equal(this.discarded, false); this.applied = true; this.trace.push('apply');}
  discard(): void {if (!this.applied) this.discarded = true;}
}
const view = (): DevReloadView => ({workspaceId: 'w', focusedPane: 'pane-a', files: [], messageRecipient: 'agent:a', focusedControl: {targetKey: 'agent:a', kind: 'message'}, targets: [
  {targetKey: 'primary:p', target: {kind: 'primary', key: 'p', epoch: 2}, draftRevision: 4, imageFingerprint: '[]', readingRevision: 5, presentationRevision: 6},
  {targetKey: 'agent:a', target: {kind: 'agent', identity: 'agent-a', connectionEpoch: 3}, draftRevision: 7, imageFingerprint: '[]', readingRevision: 8, presentationRevision: 9, selection: {start: 2, end: 5, direction: 'backward'}},
]});
function checkpoint(generation = B): DevReloadCheckpoint {return {...view(), version: 1, generation, oldClient: OLD, capturedAt: NOW, interactionRevision: 1};}
function response(status = 200, data: unknown = {ok: true, data: build(0, A, 'reload')}) {return Promise.resolve({ok: status === 200, status, json: async () => data});}
class Fixture {
  trace: string[] = []; clock = new Clock(); sources: Source[] = [];
  posts: {path: string; init: RequestInit; body: Record<string, unknown>}[] = [];
  styles: {path: string; signal: AbortSignal; result: ReturnType<typeof deferred<DevStylesheet>>; candidate: Stylesheet}[] = [];
  navigations: string[] = []; notices: DevReloadNotice[] = [];
  generation: string | null = A; client: string | null = OLD;
  href = `https://ui.invalid/path?workspace=w&secret=synthetic#launch=synthetic`;
  state: DevInteraction = {revision: 1, safe: true}; stored: unknown = null;
  restoreCount = 0; drains = 0;
  drain = async (_signal: AbortSignal): Promise<void> => {};
  restore = async (_checkpoint: DevReloadCheckpoint, _signal: AbortSignal): Promise<boolean> => true;
  fetch = (path: string, _init: RequestInit): ReturnType<DevReloadEnvironment['fetch']> => response(200, {ok: true, data: path === '/api/dev/lease' ? {lease: 'present', build: build(0, A, 'reload')} : path === '/api/dev/release' ? {release: 'released', build: build(0, A, 'reload')} : build(0, A, 'reload')});
  hooks: DevReloadHooks = {
    interaction: () => ({...this.state}),
    drain: signal => {this.drains++; this.trace.push('drain'); return this.drain(signal);},
    captureCheckpoint: () => {this.trace.push('capture'); return view();},
    writeCheckpoint: value => {this.trace.push('write'); this.stored = value;},
    readCheckpoint: () => {this.trace.push('read'); return this.stored;},
    restoreCheckpoint: (value, signal) => {this.trace.push('restore'); this.restoreCount++; return this.restore(value, signal);},
    clearCheckpoint: () => {this.trace.push('clear'); this.stored = null;},
    captureCssState: () => {this.trace.push('geometry'); return {anchor: 'retained', tail: false};},
    afterCssApply: state => {assert.deepEqual(state, {anchor: 'retained', tail: false}); this.trace.push('remeasure');},
    status: value => {this.notices.push(value);},
  };
  env: DevReloadEnvironment = {
    meta: name => name === 'ui-generation' ? this.generation : this.client,
    href: () => this.href,
    navigate: url => {this.trace.push('navigate'); this.navigations.push(url);},
    events: (url, receive, lost) => {
      assert.equal(url, `/api/dev/events?client=${this.client}`);
      assert.equal(this.sources.filter(source => !source.closed).length, 0);
      this.trace.push('events'); const source = new Source(receive, lost, this.trace); this.sources.push(source); return source;
    },
    fetch: (path, init) => {this.trace.push(path); this.posts.push({path, init, body: JSON.parse(String(init.body)) as Record<string, unknown>}); return this.fetch(path, init);},
    prepareStylesheet: (path, signal) => {const item = {path, signal, result: deferred<DevStylesheet>(), candidate: new Stylesheet(this.trace)}; this.styles.push(item); return item.result.promise;},
    clock: this.clock,
  };
  dev = () => new DevReload(this.hooks, this.env);
  emit(value = build()): void {assert.ok(this.sources[0]); this.sources.at(-1)?.emit(value);}
  loaded(index = 0): void {const item = this.styles[index]; assert.ok(item); item.result.resolve(item.candidate);}
  acks() {return this.posts.filter(post => post.path === '/api/dev/ack');}
  releases() {return this.posts.filter(post => post.path === '/api/dev/release');}
}

test('missing or malformed metadata is inert, including the deferred browser default', async () => {
  for (const [generation, client] of [[null, OLD], [A, null], ['A'.repeat(64), OLD], [A, 'bad']]) {
    const f = new Fixture(); f.generation = generation ?? null; f.client = client ?? null;
    const dev = f.dev(); await dev.ready; await dev.resume(); dev.reconnect(); dev.destroy();
    assert.equal(dev.active, false); assert.deepEqual(f.trace, []); assert.equal(f.clock.timers.size, 0);
  }
  const f = new Fixture(); const dev = new DevReload(f.hooks); await dev.ready; assert.equal(dev.active, false); assert.deepEqual(f.trace, []);
});
test('initial acknowledgment precedes the only build stream and uses the exact page lease', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready;
  assert.deepEqual(f.acks()[0]?.body, {client: OLD, generation: A, cssGeneration: A});
  assert.equal(f.acks()[0]?.init.credentials, 'same-origin'); assert.deepEqual(f.trace, ['read', '/api/dev/ack', 'events']);
  assert.equal(f.sources.length, 1); assert.equal(f.clock.timers.size, 0);
});
test('CSS waits for load, preserves JS generation and applies geometry before acknowledgment', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready; f.emit(); await flush();
  assert.equal(f.styles[0]?.path, `/_ui/${B}/style.css`); assert.equal(f.styles[0]?.candidate.applied, false); assert.equal(f.acks().length, 1);
  f.loaded(); await flush();
  assert.equal(f.styles[0]?.candidate.applied, true); assert.deepEqual(f.trace.slice(-4), ['geometry', 'apply', 'remeasure', '/api/dev/ack']);
  assert.deepEqual(f.acks()[1]?.body, {client: OLD, generation: A, cssGeneration: B}); assert.equal(f.navigations.length, 0);
  f.emit(build(2, C)); await flush(); f.loaded(1); await flush(); assert.deepEqual(f.acks()[2]?.body, {client: OLD, generation: A, cssGeneration: C});
});
test('CSS load failure leaves old styles and sends no new acknowledgment', async () => {
  const f = new Fixture(); await f.dev().ready; f.emit(); await flush(); f.styles[0]?.result.reject(new Error('synthetic')); await flush();
  assert.equal(f.styles[0]?.candidate.applied, false); assert.equal(f.acks().length, 1); assert.equal(f.notices.at(-1)?.code, 'stylesheet');
});
test('newest CSS supersedes a late old load without an old acknowledgment', async () => {
  const f = new Fixture(); await f.dev().ready; f.emit(); await flush(); f.emit(build(2, C)); await flush();
  assert.equal(f.styles[0]?.signal.aborted, true); assert.equal(f.styles.length, 2);
  f.loaded(1); await flush(); f.loaded(0); await flush();
  assert.equal(f.styles[0]?.candidate.discarded, true); assert.equal(f.styles[0]?.candidate.applied, false);
  assert.equal(f.styles[1]?.candidate.applied, true); assert.equal(f.acks().length, 2); assert.equal(f.acks()[1]?.body.cssGeneration, C);
});
test('CSS protected interaction holds both preparation and installation until explicit resume', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready;
  f.state = {revision: 1, safe: false, reason: 'ime'}; f.emit(); await flush(); assert.equal(f.styles.length, 0);
  f.state.safe = true; const resumed = dev.resume(); await flush(); assert.equal(f.styles.length, 1);
  f.state = {revision: 2, safe: false, reason: 'selection'}; f.loaded(); await resumed;
  assert.equal(f.styles[0]?.candidate.applied, false); assert.equal(f.styles[0]?.candidate.discarded, true); assert.equal(f.acks().length, 1);
  f.state = {revision: 3, safe: true}; const retry = dev.resume(); await flush(); f.loaded(1); await retry;
  assert.equal(f.styles[1]?.candidate.applied, true);
});
test('CSS rechecks interaction after the geometry capture hook', async () => {
  const f = new Fixture(); await f.dev().ready; f.hooks.captureCssState = () => {f.state.revision++; return null;};
  f.emit(); await flush(); f.loaded(); await flush(); assert.equal(f.styles[0]?.candidate.applied, false); assert.equal(f.acks().length, 1);
});
test('uncertain CSS acknowledgment keeps installed styles and blocks later builds until explicit retry', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready;
  f.fetch = () => Promise.reject(new Error('synthetic')); f.emit(); await flush(); f.loaded(); await flush();
  assert.equal(f.styles[0]?.candidate.applied, true); assert.equal(f.styles[0]?.candidate.discarded, false); assert.equal(f.notices.at(-1)?.code, 'ack');
  f.emit(build(2, C)); await flush(); assert.equal(f.styles.length, 1); assert.equal(f.acks().length, 2);
  f.fetch = () => response(); const retry = dev.resume(); await flush(); assert.equal(f.acks()[2]?.body.cssGeneration, B);
  assert.equal(f.styles.length, 2); f.loaded(1); await retry; assert.equal(f.acks()[3]?.body.cssGeneration, C);
});
test('a newer build during an acknowledgment cannot cancel the installed generation acknowledgment', async () => {
  const f = new Fixture(); await f.dev().ready; const pending = deferred<Awaited<ReturnType<DevReloadEnvironment['fetch']>>>(); f.fetch = () => pending.promise;
  f.emit(); await flush(); f.loaded(); await flush(); const signal = f.acks()[1]?.init.signal; f.emit(build(2, C)); await flush();
  assert.equal(signal?.aborted, false); assert.equal(f.styles.length, 1);
  f.fetch = () => response(); pending.resolve(await response()); await flush(); assert.equal(f.styles.length, 2);
});
test('reload drains before the checkpoint and navigates in the same origin with only workspace and generation', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready; const drain = deferred<void>(); f.drain = () => drain.promise;
  f.emit(build(1, B, 'reload')); await flush(); assert.equal(f.navigations.length, 0); assert.equal(f.stored, null);
  drain.resolve(); await flush(); assert.deepEqual(f.trace.slice(-5), ['drain', 'capture', 'write', 'navigate', 'close']);
  assert.equal(f.navigations[0], `https://ui.invalid/?generation=${B}&workspace=w`); assert.deepEqual(f.stored, checkpoint());
  assert.equal(f.releases().length, 0); dev.destroy(); assert.equal(f.releases().length, 0);
});
test('reload persists and restores the app capture with empty or populated file checkpoints', async () => {
  const file = {tab: {kind: 'file' as const, rootId: 'r', path: 'source.ts'}, position: {scrollTop: 240, scrollLeft: 32}, digest: A, focused: false,selection:{start:3,end:7,direction:'backward' as const}};
  for (const files of [[], [file], [{...file, focused: true}]]) {
    const f = new Fixture(); const captured = {...view(), files};
    if (files.some(item => item.focused)) delete captured.focusedControl;
    f.hooks.captureCheckpoint = () => captured;
    await f.dev().ready; f.emit(build(1, B, 'reload')); await flush();
    const expected = {...captured, version: 1, generation: B, oldClient: OLD, capturedAt: NOW, interactionRevision: 1};
    assert.deepEqual(f.stored, expected); assert.deepEqual(f.trace.slice(-4), ['drain', 'write', 'navigate', 'close']);
    assert.equal(f.navigations[0], `https://ui.invalid/?generation=${B}&workspace=w`);
    const next = new Fixture(); next.generation = B; next.client = NEW; next.stored = f.stored;
    next.restore = async value => {assert.deepEqual(value.files, files); assert.deepEqual(value.targets, captured.targets); return true;};
    await next.dev().ready;
    assert.equal(next.restoreCount, 1); assert.equal(next.stored, null); assert.deepEqual(next.releases()[0]?.body, {client: OLD});
  }
});
test('reload refuses malformed file checkpoints before persistence and navigation', async () => {
  for (const files of [null, [{tab: {kind: 'file', rootId: 'r', path: 'source.ts'}, position: {scrollTop: 0, scrollLeft: 0}, digest: 'invalid', focused: false}]]) {
    const f = new Fixture(); const captured = view(); Object.defineProperty(captured, 'files', {value: files});
    f.hooks.captureCheckpoint = () => captured;
    await f.dev().ready; f.emit(build(1, B, 'reload')); await flush();
    assert.equal(f.stored, null); assert.equal(f.navigations.length, 0); assert.equal(f.notices.at(-1)?.code, 'checkpoint');
  }
});
test('each unsafe interaction reason refuses reload before queue drainage', async () => {
  for (const reason of ['input', 'ime', 'selection', 'resize', 'modal', 'offline', 'auth', 'conflict', 'uncertain'] as const) {
    const f = new Fixture(); await f.dev().ready; f.state = {revision: 1, safe: false, reason}; f.emit(build(1, B, 'reload')); await flush();
    assert.equal(f.drains, 0); assert.equal(f.navigations.length, 0); assert.equal(f.notices.at(-1)?.code, reason);
  }
});
test('interaction during drainage refuses navigation and a fresh safe-point resumes once', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready; const drain = deferred<void>(); f.drain = () => drain.promise;
  f.emit(build(1, B, 'reload')); await flush(); f.state.revision++; drain.resolve(); await flush();
  assert.equal(f.navigations.length, 0); assert.equal(f.stored, null);
  f.drain = async () => {}; await dev.resume(); assert.equal(f.navigations.length, 1); assert.equal(f.drains, 2);
});
test('failed or timed out drainage holds the old page and aborts late work', async () => {
  const failure = new Fixture(); await failure.dev().ready; failure.drain = async () => {throw new Error('synthetic');}; failure.emit(build(1, B, 'reload')); await flush();
  assert.equal(failure.notices.at(-1)?.code, 'drain'); assert.equal(failure.navigations.length, 0);
  const f = new Fixture(); await f.dev().ready; const drain = deferred<void>(); let signal: AbortSignal | undefined;
  f.drain = value => {signal = value; return drain.promise;}; f.emit(build(1, B, 'reload')); await flush(); f.clock.advance(10_000); await flush();
  assert.equal(signal?.aborted, true); assert.equal(f.notices.at(-1)?.code, 'timeout'); assert.equal(f.clock.timers.size, 0);
  drain.resolve(); await flush(); assert.equal(f.navigations.length, 0); assert.equal(f.stored, null);
});
test('storage refusal and interaction during checkpoint write prevent navigation', async () => {
  for (const change of [false, true]) {
    const f = new Fixture(); await f.dev().ready; f.hooks.writeCheckpoint = () => {if (change) f.state.revision++; else throw new Error('synthetic');};
    f.emit(build(1, B, 'reload')); await flush(); assert.equal(f.navigations.length, 0); assert.equal(f.releases().length, 0);
    assert.equal(f.notices.at(-1)?.code, change ? 'input' : 'storage');
  }
});
test('capture rejects extra text and getters before storage or navigation', async () => {
  for (const getter of [false, true]) {
    const f = new Fixture(); await f.dev().ready; let reads = 0; const v = view();
    if (getter) Object.defineProperty(v, 'workspaceId', {get: () => {reads++; return 'w';}}); else Object.assign(v, {text: 'synthetic-body'});
    f.hooks.captureCheckpoint = () => v; f.emit(build(1, B, 'reload')); await flush();
    assert.equal(reads, 0); assert.equal(f.stored, null); assert.equal(f.navigations.length, 0); assert.equal(f.notices.at(-1)?.code, 'checkpoint');
  }
});
test('checkpoint validation is closed, bounded and rejects duplicate or missing recipients', () => {
  assert.deepEqual(validateDevReloadCheckpoint(checkpoint(), B, NOW), checkpoint());
  const bad: unknown[] = [
    {...checkpoint(), text: 'synthetic-body'}, {...checkpoint(), version: 2}, {...checkpoint(), generation: C}, {...checkpoint(), oldClient: 'bad'},
    {...checkpoint(), capturedAt: NOW + 1}, {...checkpoint(), capturedAt: NOW - 900001}, {...checkpoint(), interactionRevision: NaN},
    {...checkpoint(), workspaceId: 'x'.repeat(129)}, {...checkpoint(), messageRecipient: 'missing'},
    {...checkpoint(), focusedControl: {kind: 'message', targetKey: 'primary:p'}}, Object.assign(Object.create({nodeType: 1}), checkpoint()),
    {...checkpoint(), targets: Array(17).fill(view().targets[0])}, {...checkpoint(), targets: [view().targets[0], view().targets[0]]},
    {...checkpoint(), targets: [{...view().targets[0], draftRevision: -1}]},
    {...checkpoint(), targets: [{...view().targets[0], imageFingerprint: undefined}]},
    {...checkpoint(), targets: [{...view().targets[0], imageFingerprint: 'x'.repeat(8193)}]},
    {...checkpoint(), targets: [{...view().targets[1], target: {kind: 'agent', identity: 'agent-a', connectionEpoch: 0}}]},
    {...checkpoint(), targets: [{...view().targets[1], selection: {start: 5, end: 2, direction: 'none'}}]},
    {...checkpoint(), targets: [{...view().targets[1], selection: {start: 0, end: 262145, direction: 'none'}}]},
    {...checkpoint(), targets: [view().targets[1], {...view().targets[1], targetKey: 'other', target: {kind: 'agent', identity: 'agent-a', connectionEpoch: 8}}]},
  ];
  for (const value of bad) assert.equal(validateDevReloadCheckpoint(value, B, NOW), null);
  const original = checkpoint(); const validated = validateDevReloadCheckpoint(original, B, NOW); const agent = original.targets[1]; assert.ok(agent); agent.draftRevision++;
  assert.equal(validated?.targets[1]?.draftRevision, 7);
});
test('file checkpoints contain bounded source ranges, identities, digests, position and focus',()=> {
  const file = {tab:{kind:'file' as const,rootId:'r',path:'note.md'},position:{scrollTop:120,scrollLeft:8},digest:A,focused:false,selection:{start:24,end:44,direction:'backward' as const}};
  const value = {...checkpoint(),files:[file]};assert.deepEqual(validateDevReloadCheckpoint(value,B,NOW),value);
  const many = {...checkpoint(),files:Array.from({length:40},(_,index)=>({...file,tab:{...file.tab,path:`file-${index}.md`}}))};assert.deepEqual(validateDevReloadCheckpoint(many,B,NOW),many);
  const preview = {...value,files:[file,{tab:{...file.tab,view:'preview' as const},position:file.position,digest:A,focused:false}]};assert.deepEqual(validateDevReloadCheckpoint(preview,B,NOW),preview);
  for (const files of [[file,file],[{...file,text:'source'}],[{...file,focused:true}],[{...file,position:{scrollTop:-1,scrollLeft:0}}],[{...file,digest:'wrong'}],[{...file,tab:{...file.tab,path:'../escape'}}]]) assert.equal(validateDevReloadCheckpoint({...value,files},B,NOW),null);
  for(const selection of [undefined,{start:-1,end:2,direction:'none'},{start:2,end:1,direction:'none'},{start:0,end:1.5,direction:'none'},{start:0,end:1048577,direction:'none'},{start:0,end:1,direction:'wrong'},{start:0,end:1,direction:'none',text:'not stored'}])assert.equal(validateDevReloadCheckpoint({...value,files:[{...file,selection}]},B,NOW),null);
  assert.ok(validateDevReloadCheckpoint({...value,files:[{...file,selection:{start:300000,end:300000,direction:'none'}}]},B,NOW));
  assert.equal(validateDevReloadCheckpoint({...value,files:[{...file,tab:{...file.tab,view:'preview'}}]},B,NOW),null);
  let reads = 0;const entries = [file];Object.defineProperty(entries,'0',{get:()=> {reads++;return file;}});assert.equal(validateDevReloadCheckpoint({...value,files:entries},B,NOW),null);assert.equal(reads,0);
  const range={...file};Object.defineProperty(range,'selection',{get:()=> {reads++;return file.selection;}});assert.equal(validateDevReloadCheckpoint({...value,files:[range]},B,NOW),null);assert.equal(reads,0);
});
test('checkpoint validation does not invoke accessors on objects or array entries', () => {
  let reads = 0; const accessor = checkpoint(); Object.defineProperty(accessor, 'workspaceId', {get: () => {reads++; return 'w';}});
  assert.equal(validateDevReloadCheckpoint(accessor, B, NOW), null);
  const array = checkpoint(); Object.defineProperty(array.targets, '0', {get: () => {reads++; return view().targets[0];}});
  assert.equal(validateDevReloadCheckpoint(array, B, NOW), null); assert.equal(reads, 0);
});
test('a restoration acknowledgment failure never reports or performs a retry', async () => {
  const f = new Fixture(); f.generation = B; f.client = NEW; f.stored = checkpoint(); f.fetch = () => Promise.reject(new Error('ack lost'));
  const dev = f.dev(); await dev.ready;
  assert.equal(f.notices.at(-1)?.state, 'failed'); assert.equal(f.notices.at(-1)?.code, 'ack'); assert.equal(f.notices.at(-1)?.retryable, false);
  const before = [...f.trace]; await dev.resume(); dev.reconnect(); assert.deepEqual(f.trace, before);
  assert.equal(f.releases().length, 0); assert.ok(f.stored); assert.equal(f.sources.length, 0);
});
test('an unsafe checkpoint settles fatal restoration before its final notice', async () => {
  const f = new Fixture(); f.generation = B; f.client = NEW; f.stored = checkpoint(); f.state = {revision: 1, safe: false, reason: 'ime'};
  const dev = f.dev(); await dev.ready;
  assert.equal(f.notices.at(-1)?.state, 'failed'); assert.equal(f.notices.at(-1)?.code, 'restore'); assert.equal(f.notices.at(-1)?.retryable, false);
  f.state.safe = true; const before = [...f.trace]; await dev.resume(); dev.reconnect(); assert.deepEqual(f.trace, before);
  assert.equal(f.restoreCount, 0); assert.equal(f.posts.length, 0); assert.ok(f.stored);
});
test('new page restores the explicit recipient once before acknowledgment, old release and clear', async () => {
  const f = new Fixture(); f.generation = B; f.client = NEW; f.stored = checkpoint();
  f.restore = async value => {assert.equal(value.messageRecipient, 'agent:a'); assert.equal(value.targets[1]?.draftRevision, 7); return true;};
  const dev = f.dev(); await dev.ready; await dev.resume();
  assert.deepEqual(f.trace, ['read', 'restore', '/api/dev/ack', '/api/dev/release', 'clear', 'events']); assert.equal(f.restoreCount, 1); assert.equal(f.stored, null);
  assert.deepEqual(f.releases()[0]?.body, {client: OLD}); assert.deepEqual(f.acks()[0]?.body, {client: NEW, generation: B, cssGeneration: B});
});
test('invalid, expired, wrong workspace or same-client checkpoints retain storage and refuse restoration', async () => {
  for (const stored of [{...checkpoint(), generation: C}, {...checkpoint(), capturedAt: 0}, {...checkpoint(), workspaceId: 'other'}, {...checkpoint(), oldClient: NEW}]) {
    const f = new Fixture(); f.generation = B; f.client = NEW; f.stored = stored; const dev = f.dev(); await dev.ready; await dev.resume(); dev.reconnect();
    assert.equal(f.restoreCount, 0); assert.equal(f.posts.length, 0); assert.equal(f.sources.length, 0); assert.equal(f.stored, stored); assert.equal(f.notices.at(-1)?.code, 'checkpoint');
  }
});
test('semantic restoration refusal or newer interaction retains the checkpoint without acknowledgment', async () => {
  for (const changed of [false, true]) {
    const f = new Fixture(); f.generation = B; f.client = NEW; const stored = checkpoint(); f.stored = stored;
    f.restore = async () => {if (changed) f.state.revision++; return changed;};
    const dev = f.dev(); await dev.ready; await dev.resume(); assert.equal(f.restoreCount, 1); assert.equal(f.stored, stored); assert.equal(f.posts.length, 0); assert.equal(f.notices.at(-1)?.code, 'restore');
  }
});
test('failed release retains a restored checkpoint and never repeats its restoration', async () => {
  const f = new Fixture(); f.generation = B; f.client = NEW; const stored = checkpoint(); f.stored = stored;
  f.fetch = path => path.endsWith('/release') ? Promise.reject(new Error('synthetic')) : response();
  const dev = f.dev(); await dev.ready; await dev.resume(); assert.equal(f.restoreCount, 1); assert.equal(f.releases().length, 1);
  assert.equal(f.sources.length, 0); assert.equal(f.stored, stored); assert.equal(f.notices.at(-1)?.code, 'release');
});
test('restoration timeout stops automatic updates and late completion cannot release or clear', async () => {
  const f = new Fixture(); f.generation = B; f.client = NEW; const stored = checkpoint(); f.stored = stored; const restore = deferred<boolean>(); f.restore = () => restore.promise;
  const dev = f.dev(); await flush(); f.clock.advance(10_000); await dev.ready; restore.resolve(true); await flush(); await dev.resume();
  assert.equal(f.restoreCount, 1); assert.equal(f.posts.length, 0); assert.equal(f.stored, stored); assert.equal(f.notices.at(-1)?.code, 'timeout');
});
test('building then ready at the same revision advances, while old revisions and duplicate readiness do not', async () => {
  const f = new Fixture(); await f.dev().ready; f.emit(build(2, B, 'css', 'building')); await flush(); assert.equal(f.styles.length, 0);
  f.emit(build(2, B)); await flush(); f.emit(build(1, C)); f.emit(build(2, B)); await flush(); assert.equal(f.styles.length, 1);
  f.loaded(); await flush(); assert.equal(f.acks().length, 2);
});
test('held, failed and restart-required only report status and cancel an older candidate', async () => {
  for (const status of ['held', 'failed', 'restart-required'] as const) {
    const f = new Fixture(); await f.dev().ready; f.emit(); await flush(); f.emit(build(2, C, 'reload', status)); await flush(); f.loaded(); await flush();
    assert.equal(f.notices.at(-1)?.state, status); assert.equal(f.styles[0]?.candidate.applied, false); assert.equal(f.drains, 0); assert.equal(f.navigations.length, 0); assert.equal(f.acks().length, 1);
  }
});
test('reconnect closes before replacement, refuses closed-source events and never releases for SSE loss', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready; const old = f.sources[0]; assert.ok(old); old.lost();
  assert.equal(old.closed, 1); assert.equal(f.sources.length, 1); assert.equal(f.releases().length, 0); f.clock.advance(250); await flush(); assert.equal(f.sources.length, 2);
  old.emit(build(99, C)); old.lost(); await flush(); assert.equal(f.styles.length, 0); assert.equal(f.clock.timers.size, 0);
  dev.reconnect(); await flush(); assert.equal(f.sources[1]?.closed, 1); assert.equal(f.sources.length, 3); assert.equal(f.releases().length, 0);
});
test('four reconnect delays end offline with no native retry or extra timer until explicit reconnect', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready;
  for (const delay of [250, 1000, 3000, 6000]) {
    f.sources.at(-1)?.lost(); assert.equal(f.clock.timers.size, 1); const before = f.sources.length;
    f.clock.advance(delay - 1); assert.equal(f.sources.length, before); f.clock.advance(1); await flush(); assert.equal(f.sources.length, before + 1);
  }
  f.sources.at(-1)?.lost(); assert.equal(f.notices.at(-1)?.state, 'offline'); assert.equal(f.clock.timers.size, 0); assert.equal(f.sources.length, 5);
  dev.reconnect(); await flush(); assert.equal(f.sources.length, 6); assert.equal(f.releases().length, 0);
});
test('reconnect reconciles retained CSS acknowledgment before strict lease comparison, with or without a lost server effect', async () => {
  for (const applied of [false, true]) {
    const f = new Fixture(); const dev = f.dev(); await dev.ready; let serverCss = A, acks = 0;
    f.fetch = (path, init) => {
      const body = JSON.parse(String(init.body)) as {cssGeneration: string};
      if (path.endsWith('/ack')) {
        acks++; if (acks === 1) {if (applied) serverCss = B; return Promise.reject(new Error('lost acknowledgment'));}
        serverCss = body.cssGeneration; return response();
      }
      assert.equal(path, '/api/dev/lease'); assert.equal(body.cssGeneration, serverCss);
      return response(200, {ok: true, data: {lease: 'present', build: build(1, B)}});
    };
    f.emit(); await flush(); f.loaded(); await flush(); assert.equal(f.notices.at(-1)?.code, 'ack');
    const start = f.posts.length; dev.reconnect(); const resumed = dev.resume(); await flush(); await resumed;
    assert.deepEqual(f.posts.slice(start).map(post => post.path), ['/api/dev/ack', '/api/dev/lease']);
    assert.equal(serverCss, B); assert.equal(f.sources.length, 2); assert.equal(f.notices.at(-1)?.state, 'applied');
    assert.equal(f.navigations.length, 0); assert.equal(f.clock.timers.size, 0);
  }
});
test('reconnect waits for in-flight CSS acknowledgment before its lease check without concurrent acknowledgments', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready; const pending = deferred<Awaited<ReturnType<DevReloadEnvironment['fetch']>>>(); let acknowledged = false;
  f.fetch = path => {
    if (path.endsWith('/ack')) return pending.promise;
    assert.equal(acknowledged, true); return response(200, {ok: true, data: {lease: 'present', build: build(1, B)}});
  };
  f.emit(); await flush(); f.loaded(); await flush(); dev.reconnect(); const resumed = dev.resume(); await flush();
  assert.equal(f.posts.filter(post => post.path === '/api/dev/lease').length, 0); assert.equal(f.acks().length, 2);
  acknowledged = true; pending.resolve(await response()); await resumed; await flush();
  assert.equal(f.posts.filter(post => post.path === '/api/dev/lease').length, 1); assert.equal(f.acks().length, 2); assert.equal(f.sources.length, 2);
});
test('pending CSS refusal recovers only a separately proven missing lease and never treats auth capacity or network failure as absence', async () => {
  for (const status of [401, 409, 429, 0]) {
    const f = new Fixture(); const dev = f.dev(); await dev.ready;
    f.fetch = () => Promise.reject(new Error('initial ack lost'));
    f.emit(); await flush(); f.loaded(); await flush();
    f.fetch = path => path.endsWith('/ack') ? status ? response(status) : Promise.reject(new Error('offline')) : response(200, {ok: true, data: {lease: 'missing', build: build(0, A, 'reload')}});
    dev.reconnect(); await flush();
    assert.equal(f.posts.filter(post => post.path === '/api/dev/lease').length, status === 409 ? 1 : 0);
    assert.equal(f.navigations.length, status === 409 ? 1 : 0);
    if (status === 401) assert.equal(f.notices.at(-1)?.code, 'auth');
    if (status === 429) assert.equal(f.notices.at(-1)?.code, 'capacity');
    dev.destroy();
  }
  const f = new Fixture(); const dev = f.dev(); await dev.ready; f.fetch = () => Promise.reject(new Error('lost'));
  f.emit(); await flush(); f.loaded(); await flush(); f.fetch = () => response(409);
  dev.reconnect(); await flush(); assert.equal(f.notices.at(-1)?.code, 'invalid-assets'); assert.equal(f.notices.at(-1)?.retryable, false); assert.equal(f.navigations.length, 0);
});
test('a missing restart lease forces a same-generation fresh document through the bounded checkpoint', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready;
  f.emit(build(20, A, 'reload', 'restart-required')); await flush();
  f.fetch = () => response(200, {ok: true, data: {lease: 'missing', build: build(0, A, 'css')}});
  f.sources[0]?.lost(); f.clock.advance(250); await flush();
  assert.equal(f.drains, 1); assert.equal(f.navigations.length, 1); assert.equal(f.sources.length, 1);
  const navigation = f.navigations[0]; assert.ok(navigation); assert.equal(new URL(navigation).searchParams.get('generation'), A);
  assert.deepEqual(f.posts.find(post => post.path === '/api/dev/lease')?.body, {client: OLD, generation: A, cssGeneration: A});
  assert.equal((f.stored as DevReloadCheckpoint).generation, A); assert.equal(f.acks().length, 1); assert.equal(f.releases().length, 0);
  const next = new Fixture(); next.clock.time = f.clock.time; next.generation = A; next.client = NEW; next.stored = f.stored;
  next.fetch = path => response(200, {ok: true, data: path.endsWith('/release') ? {release: 'absent', build: build(0, A, 'reload')} : build(0, A, 'reload')});
  await next.dev().ready; assert.equal(next.restoreCount, 1); assert.equal(next.stored, null); assert.equal(next.sources.length, 1);
});
test('a missing lease respects unsafe work and changed interaction during drainage', async () => {
  for (const hold of [true, false]) {
    const f = new Fixture(); const dev = f.dev(); await dev.ready;
    const drain = deferred<void>(); f.drain = () => drain.promise;
    f.state = {revision: 1, safe: !hold, reason: hold ? 'offline' : undefined};
    f.fetch = () => response(200, {ok: true, data: {lease: 'missing', build: build(0, A, 'reload')}});
    dev.reconnect(); await flush(); assert.equal(f.navigations.length, 0);
    if (hold) {assert.equal(f.drains, 0); f.state = {revision: 2, safe: true}; void dev.resume(); await flush();}
    else f.state.revision++;
    drain.resolve(); await flush();
    assert.equal(f.navigations.length, hold ? 1 : 0); if (!hold) assert.equal(f.stored, null);
  }
});
test('lease identity refusals and authentication loss never become missing-lease recovery', async () => {
  for (const status of [400, 401, 409]) {
    const f = new Fixture(); const dev = f.dev(); await dev.ready; f.fetch = () => response(status);
    dev.reconnect(); await flush(); assert.equal(f.navigations.length, 0); assert.equal(f.drains, 0); assert.equal(f.clock.timers.size, 0);
    assert.equal(f.notices.at(-1)?.code, status === 401 ? 'auth' : 'invalid-assets');
    assert.equal(f.notices.at(-1)?.retryable, status === 401);
  }
  for (const data of [{lease: 'missing', build: {...build(), generation: 'bad'}}, {lease: 'absent', build: build()}, {lease: 'missing', build: build(), client: NEW}]) {
    const f = new Fixture(); const dev = f.dev(); await dev.ready; f.fetch = () => response(200, {ok: true, data});
    dev.reconnect(); await flush(); assert.equal(f.notices.at(-1)?.code, 'invalid-assets'); assert.equal(f.navigations.length, 0);
  }
});
test('capacity and network failures exhaust only four lease checks without navigation or identity recreation', async () => {
  for (const capacity of [true, false]) {
    const f = new Fixture(); const dev = f.dev(); await dev.ready;
    f.fetch = () => capacity ? response(429) : Promise.reject(new Error('offline'));
    f.sources[0]?.lost();
    for (const delay of [250, 1000, 3000, 6000]) {f.clock.advance(delay); await flush();}
    assert.equal(f.posts.filter(post => post.path === '/api/dev/lease').length, 4);
    assert.equal(f.notices.at(-1)?.state, 'offline'); assert.equal(f.notices.at(-1)?.code, capacity ? 'capacity' : 'offline');
    assert.equal(f.clock.timers.size, 0); assert.equal(f.drains, 0); assert.equal(f.navigations.length, 0);
  }
});
test('cancelled and timed-out lease checks cannot navigate from late responses', async () => {
  for (const cancel of [true, false]) {
    const f = new Fixture(); const dev = f.dev(); await dev.ready; const pending = deferred<Awaited<ReturnType<DevReloadEnvironment['fetch']>>>(); f.fetch = () => pending.promise;
    dev.reconnect(); await flush(); const signal = f.posts.at(-1)?.init.signal;
    if (cancel) dev.destroy(); else f.clock.advance(10_000);
    await flush(); assert.equal(signal?.aborted, true);
    pending.resolve(await response(200, {ok: true, data: {lease: 'missing', build: build(0, A, 'reload')}})); await flush();
    assert.equal(f.navigations.length, 0); assert.equal(f.drains, 0); if (cancel) assert.equal(f.clock.timers.size, 0); else dev.destroy();
  }
});
test('invalid build payload closes the stream and performs no update', async () => {
  for (const payload of ['bad-json', JSON.stringify({...build(), text: 'synthetic-body'}), JSON.stringify({...build(), revision: -1}), 'x'.repeat(4097)]) {
    const f = new Fixture(); await f.dev().ready; f.sources[0]?.receive(payload); await flush();
    assert.equal(f.sources[0]?.closed, 1); assert.equal(f.styles.length, 0); assert.equal(f.clock.timers.size, 0); assert.equal(f.notices.at(-1)?.code, 'invalid-assets');
  }
});
test('destroy cancels a pending candidate, one retry timer and all late stream events', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready; f.emit(); await flush(); f.sources[0]?.lost(); dev.destroy(); dev.destroy();
  assert.equal(f.clock.timers.size, 0); assert.equal(f.styles[0]?.signal.aborted, true); f.loaded(); f.sources[0]?.emit(build(9, C, 'reload')); f.clock.advance(6000); await flush();
  assert.equal(f.styles[0]?.candidate.applied, false); assert.equal(f.styles[0]?.candidate.discarded, true); assert.equal(f.sources.length, 1); assert.equal(f.navigations.length, 0);
  assert.equal(f.releases().length, 1); assert.equal(f.releases()[0]?.init.keepalive, true); assert.equal(f.acks().length, 1);
});
test('destroy before initialization or during drainage prevents future hooks, acknowledgment or navigation', async () => {
  const early = new Fixture(); const abandoned = early.dev(); abandoned.destroy(); await abandoned.ready;
  assert.deepEqual(early.trace, ['/api/dev/release']);
  const f = new Fixture(); const dev = f.dev(); await dev.ready; const drain = deferred<void>(); f.drain = () => drain.promise;
  f.emit(build(1, B, 'reload')); await flush(); dev.destroy(); drain.resolve(); await flush(); assert.equal(f.stored, null); assert.equal(f.navigations.length, 0); assert.equal(f.acks().length, 1);
});
test('HTTP auth refusal and malformed acknowledgment report fixed status without a stream', async () => {
  for (const auth of [true, false]) {
    const f = new Fixture(); f.fetch = () => auth ? response(401) : response(200, {ok: true, data: {text: 'synthetic-body'}});
    const dev = f.dev(); await dev.ready; assert.equal(f.sources.length, 0); assert.equal(f.notices.at(-1)?.code, auth ? 'auth' : 'ack'); assert.equal(f.acks().length, 1);
    f.fetch = () => response(); await dev.resume(); assert.equal(f.sources.length, 1); assert.equal(f.acks().length, 2);
  }
});

test('invalid payload cancels a valid pending candidate and refuses its late completion', async () => {
  const f = new Fixture(); await f.dev().ready; f.emit(); await flush(); f.sources[0]?.receive('bad-json'); await flush(); f.loaded(); await flush();
  assert.equal(f.styles[0]?.signal.aborted, true); assert.equal(f.styles[0]?.candidate.discarded, true); assert.equal(f.styles[0]?.candidate.applied, false); assert.equal(f.acks().length, 1);
});
test('stylesheet and acknowledgment deadlines preserve installed state without automatic retries', async () => {
  const loading = new Fixture(); await loading.dev().ready; loading.emit(); await flush(); loading.clock.advance(10_000); await flush(); loading.loaded(); await flush();
  assert.equal(loading.styles[0]?.candidate.discarded, true); assert.equal(loading.acks().length, 1); assert.equal(loading.notices.at(-1)?.code, 'timeout');
  const f = new Fixture(); const dev = f.dev(); await dev.ready; const pending = deferred<Awaited<ReturnType<DevReloadEnvironment['fetch']>>>(); f.fetch = () => pending.promise;
  f.emit(); await flush(); f.loaded(); await flush(); f.clock.advance(10_000); await flush();
  assert.equal(f.styles[0]?.candidate.applied, true); assert.equal(f.acks()[1]?.init.signal?.aborted, true); assert.equal(f.clock.timers.size, 0);
  f.emit(build(2, C)); await flush(); assert.equal(f.styles.length, 1); assert.equal(f.acks().length, 2); pending.resolve(await response()); await flush();
  f.fetch = () => response(); const retry = dev.resume(); await flush(); f.loaded(1); await retry; assert.equal(f.acks().length, 4);
});
test('a burst during drainage coalesces to one latest checkpoint and navigation', async () => {
  const f = new Fixture(); await f.dev().ready; const drain = deferred<void>(); f.drain = () => drain.promise; f.emit(build(1, B, 'reload')); await flush();
  for (let revision = 2; revision <= 200; revision++) f.emit(build(revision, revision === 200 ? C : B, 'reload'));
  f.drain = async () => {}; await flush(); drain.resolve(); await flush(); assert.equal(f.drains, 2); assert.equal(f.navigations.length, 1);
  assert.equal(f.navigations[0], `https://ui.invalid/?generation=${C}&workspace=w`); assert.equal(f.clock.timers.size, 0); assert.equal(f.releases().length, 0);
});
test('destroy during checkpoint restoration retains it and never releases the old lease', async () => {
  const f = new Fixture(); f.generation = B; f.client = NEW; const stored = checkpoint(); f.stored = stored; const restore = deferred<boolean>(); f.restore = () => restore.promise;
  const dev = f.dev(); await flush(); dev.destroy(); restore.resolve(true); await dev.ready;
  assert.equal(f.stored, stored); assert.equal(f.acks().length, 0); assert.equal(f.releases().length, 1); assert.equal(f.releases()[0]?.body.client, NEW); assert.equal(f.clock.timers.size, 0);
});

test('a safe-point notification during drainage coalesces one fresh attempt after an interaction change', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready; const drain = deferred<void>(); f.drain = () => drain.promise;
  f.emit(build(1, B, 'reload')); await flush(); f.state.revision++; const resume = dev.resume(); f.drain = async () => {}; drain.resolve(); await resume; await flush();
  assert.equal(f.drains, 2); assert.equal(f.navigations.length, 1); assert.equal((f.stored as DevReloadCheckpoint).interactionRevision, 2);
});
test('the final status callback cannot bypass the immediate interaction check before navigation', async () => {
  const f = new Fixture(); await f.dev().ready; f.hooks.status = notice => {if (notice.state === 'navigating') f.state.revision++;};
  f.emit(build(1, B, 'reload')); await flush(); assert.ok(f.stored); assert.equal(f.navigations.length, 0); assert.equal(f.releases().length, 0);
});
test('synchronous abandonment-release failure cannot prevent stream and timer disposal', async () => {
  const f = new Fixture(); const dev = f.dev(); await dev.ready; f.sources[0]?.lost(); f.fetch = () => {throw new Error('synthetic');};
  assert.doesNotThrow(() => dev.destroy()); assert.equal(f.clock.timers.size, 0); assert.equal(f.sources[0]?.closed, 1); assert.equal(f.releases().length, 1);
});

function globalValue(context: TestContext, key: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  context.after(() => {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);});
}
class Link {
  href: string; media = 'screen'; onload: (() => void) | null = null; onerror: (() => void) | null = null; nonce = 'synthetic';
  readonly links: Link[];
  constructor(links: Link[], href = `https://ui.invalid/_ui/${A}/style.css`) {this.links = links; this.href = href;}
  get parentNode() {return this.isConnected ? {} : null;}
  get isConnected() {return this.links.includes(this);}
  cloneNode() {const clone = new Link(this.links, this.href); clone.media = this.media; clone.nonce = this.nonce; return clone;}
  after(link: Link): void {this.links.splice(this.links.indexOf(this) + 1, 0, link);}
  remove(): void {const index = this.links.indexOf(this); if (index >= 0) this.links.splice(index, 1);}
}
test('browser stylesheet adapter keeps the old link through load and preserves its attributes on apply', async context => {
  const links: Link[] = []; const old = new Link(links); links.push(old);
  globalValue(context, 'document', {querySelectorAll: () => links}); globalValue(context, 'location', {href: 'https://ui.invalid/'});
  const controller = new AbortController(); const pending = browserDevReloadEnvironment().prepareStylesheet(`/_ui/${B}/style.css`, controller.signal);
  const candidate = links[1]; assert.ok(candidate); assert.equal(old.isConnected, true); assert.equal(candidate.media, 'not all'); candidate.onload?.();
  const sheet = await pending; assert.equal(old.isConnected, true); sheet.apply(); sheet.discard();
  assert.deepEqual(links, [candidate]); assert.equal(candidate.media, 'screen'); assert.equal(candidate.nonce, 'synthetic'); assert.equal(candidate.onload, null);
});
test('browser stylesheet load error or abort removes only the candidate and detaches listeners', async context => {
  const links: Link[] = []; const old = new Link(links); links.push(old);
  globalValue(context, 'document', {querySelectorAll: () => links}); globalValue(context, 'location', {href: 'https://ui.invalid/'});
  for (const abort of [false, true]) {
    const controller = new AbortController(); const pending = browserDevReloadEnvironment().prepareStylesheet(`/_ui/${B}/style.css`, controller.signal);
    const candidate = links[1]; assert.ok(candidate); if (abort) controller.abort(); else candidate.onerror?.(); await assert.rejects(pending);
    assert.deepEqual(links, [old]); assert.equal(candidate.onload, null); assert.equal(candidate.onerror, null);
  }
});
test('browser EventSource adapter uses the build event without a cursor and closes on coordinator replacement', async context => {
  const ports: {url: string; closed: number; onerror?: () => void; receive?: (event: {data: string}) => void; close(): void}[] = [];
  class FakeEventSource {
    closed = 0; onerror?: () => void; receive?: (event: {data: string}) => void;
    readonly url: string;
    constructor(url: string) {this.url = url; ports.push(this);}
    addEventListener(name: string, callback: (event: {data: string}) => void) {assert.equal(name, 'build'); this.receive = callback;}
    close() {this.closed++;}
  }
  globalValue(context, 'EventSource', FakeEventSource);
  const f = new Fixture(); f.env.events = browserDevReloadEnvironment().events; const dev = f.dev(); await dev.ready;
  assert.equal(ports[0]?.url, `/api/dev/events?client=${OLD}`); ports[0]?.onerror?.(); assert.equal(ports[0]?.closed, 1);
  f.clock.advance(250); await flush(); assert.equal(ports.length, 2); ports[0]?.receive?.({data: JSON.stringify(build(99, C))}); await flush(); assert.equal(f.styles.length, 0);
  dev.destroy(); assert.equal(ports[1]?.closed, 1);
});
