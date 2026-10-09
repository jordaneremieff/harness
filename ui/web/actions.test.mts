import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { OperationView, PrimaryControl, PrimaryView } from '../shared/api.ts';
import { Actions, COMMAND_INVENTORY_PAGE_LIMIT } from './actions.ts';
import type { ActionContext } from './actions.ts';
const originalFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch = originalFetch;});
const primary: PrimaryView = {key: 'p', epoch: 1, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingDialogs: [], pendingOperationIds: [], capabilities: {control: true}};
const operation: OperationView = {id: 'op', kind: 'primary.control', state: 'completed', target: {kind: 'primary', key: 'p', epoch: 1}, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z'};
function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {snapshot: () => undefined, primary: () => primary, composer: {commandsChanged: () => {}} as ActionContext['composer'], modal: {} as ActionContext['modal'], selection: async () => undefined, reload: async () => undefined, result: () => undefined, rosterRefresh: () => undefined, find: () => undefined, recovery: () => undefined, primaryEntries: () => [], ...overrides};
}
test('model and thinking choices bind the displayed primary rather than a later selection', async () => {
  const seen: string[] = []; const emitted: OperationView[] = [];
  globalThis.fetch = async (path, init) => {
    seen.push(String(path));
    if (String(path) === '/api/operations') {assert.deepEqual(JSON.parse(String(init?.body)), {kind: 'primary.control', target: operation.target}); return Response.json({ok: true, data: {operationId: 'op'}});}
    assert.equal(path, '/api/primaries/p/control'); assert.equal(((init?.headers ?? {}) as Record<string, string>)['Idempotency-Key'], 'op');
    assert.deepEqual(JSON.parse(String(init?.body)), {action: 'thinking', level: 'high', epoch: 1});
    return Response.json({ok: true, data: operation});
  };
  const actions = new Actions(context({primary: () => ({...primary, key: 'later', epoch: 4}), result: value => emitted.push(value)}));
  await actions.control({action: 'thinking', level: 'high'} as PrimaryControl, primary);
  assert.deepEqual(seen, ['/api/operations', '/api/primaries/p/control']); assert.deepEqual(emitted, [operation]);
});
test('a refused control retains its typed outcome and raises its actual error', async () => {
  const refused = {...operation, state: 'rejected' as const, error: {code: 'not_ready', message: 'Primary is busy', retry: 'manual' as const}};
  let emitted: OperationView | undefined;
  globalThis.fetch = async path => Response.json({ok: true, data: String(path) === '/api/operations' ? {operationId: 'op'} : refused});
  await assert.rejects(new Actions(context({result: value => {emitted = value;}})).control({action: 'compact'} as PrimaryControl), /Primary is busy/);
  assert.equal(emitted?.state, 'rejected');
});
class FakeNode extends EventTarget {
  children: FakeNode[] = []; textContent = ''; className = ''; type = '';
  append(...nodes: FakeNode[]): void {this.children.push(...nodes);}
  replaceChildren(...nodes: FakeNode[]): void {this.children = nodes;}
  querySelector(): null {return null;}
  focus(): void {}
}
test('journal and HTTP copies of one handoff completion open its result once', () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => new FakeNode()}});
  try {
    let opened = 0; const body = new FakeNode();
    const modal = {body, open() {opened++; return body;}} as unknown as ActionContext['modal'];
    const actions = new Actions(context({modal}));
    const result: OperationView = {...operation, kind: 'primary.handoff', receipt: {kind: 'rpc', result: {value: {command: 'pi --session fixture-session.jsonl'}, truncated: false}}};
    actions.handoffResult({...result, state: 'uncertain'}); assert.equal(opened, 0);
    actions.handoffResult(result); actions.handoffResult({...result}); assert.equal(opened, 1);
    assert.equal(body.children[0]?.textContent, 'pi --session fixture-session.jsonl');
  } finally {if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');}
});

test('resource cache skips startup and warms once on the ready transition without page reload', async () => {
  let selected: PrimaryView = {...primary, lifecycle: 'starting'}; let calls = 0;
  const commands = [{name: 'fixture', description: 'public command', source: 'extension'}];
  globalThis.fetch = async () => {calls++; return Response.json({ok: true, data: {items: commands, nextCursor: null, revision: '2'}});};
  const actions = new Actions(context({primary: () => selected}));
  actions.warm(); assert.deepEqual((await actions.load('commands')).items, []); assert.equal(calls, 0);
  selected = {...primary}; actions.warm();
  assert.deepEqual((await actions.load('commands')).items, commands); assert.equal(calls, 1);
  actions.warm(); await actions.load('commands'); assert.equal(calls, 1);
  assert.equal(actions.unknown('/fixture argument', () => {}), false);
  selected = {...primary, lifecycle: 'switching'}; actions.warm();
  selected = {...primary}; actions.warm(); await actions.load('commands'); assert.equal(calls, 2);
});

test('late resources from a previous lifecycle never replace current commands', async () => {
  let selected = {...primary}; let calls = 0;
  let resolveOld: (value: Response) => void = () => {};
  globalThis.fetch = async () => {
    calls++; if (calls === 1) return new Promise<Response>(resolve => {resolveOld = resolve;});
    return Response.json({ok: true, data: {items: [{name: 'current', description: '', source: 'extension'}], nextCursor: null, revision: '2'}});
  };
  const actions = new Actions(context({primary: () => selected})); const old = actions.load('commands');
  selected = {...primary, lifecycle: 'switching'}; actions.warm(); selected = {...primary}; actions.warm(); await actions.load('commands');
  resolveOld(Response.json({ok: true, data: {items: [], nextCursor: null, revision: '1'}})); await old;
  assert.equal(actions.unknown('/current argument', () => {}), false); await actions.load('commands'); assert.equal(calls, 2);
  selected = {...primary, epoch: 2}; await actions.load('commands'); assert.equal(calls, 3);
});

test('an open Commands palette repaints when startup resources become ready', async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => new FakeNode()}});
  try {
    let selected = {...primary, lifecycle: 'starting' as PrimaryView['lifecycle']}; const body = new FakeNode();
    const modal = {body, token: 1, open() {return body;}, owns(token: number) {return token === 1;}} as unknown as ActionContext['modal'];
    globalThis.fetch = async () => Response.json({ok: true, data: {items: [{name: 'fixture', description: 'public', source: 'extension'}], nextCursor: null, revision: '2'}});
    const actions = new Actions(context({primary: () => selected, modal})); actions.warm(); actions.palette(); await actions.load('commands');
    const list = body.children[2]; assert.ok(list); assert.equal(list.children.some(node => node.textContent === '/fixture'), false);
    selected = {...primary}; actions.warm(); await actions.load('commands');
    assert.equal(list.children.some(node => node.textContent === '/fixture'), true);
  } finally {if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');}
});

test('primary text actions with no ready target open the picker without changing drafts', () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => new FakeNode()}});
  try {
    let opened = 0; let edits = 0; const body = new FakeNode();
    const actions = new Actions(context({primary: () => undefined, composer: {editor: {value: 'retained'}, setText: () => {edits++;}} as unknown as ActionContext['composer'], modal: {body} as unknown as ActionContext['modal']}));
    actions.projectPicker = () => {opened++;}; actions.prepareText('/agent attach retained');
    assert.equal(opened, 1); assert.equal(edits, 0); assert.match(body.children[1]?.textContent ?? '', /agent attach retained/);
  } finally {if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');}
});

test('command options report lifecycle state, merge Pi with App aliases, and notify the composer on load and reset', async () => {
  let selected: PrimaryView | undefined; let notifications = 0;
  const pi = [{name: 'model', description: 'Pi model', source: 'extension'}, {name: 'fixture', description: 'Public command', source: 'extension'}];
  globalThis.fetch = async () => Response.json({ok: true, data: {items: pi, nextCursor: null, revision: '1'}});
  const actions = new Actions(context({primary: () => selected, composer: {commandsChanged: () => {notifications++;}} as ActionContext['composer']}));
  assert.deepEqual(actions.commandOptions(), {state: 'unavailable', items: []});
  selected = {...primary}; assert.equal(actions.commandOptions().state, 'loading'); await actions.load('commands');
  const options = actions.commandOptions(); assert.equal(options.state, 'ready'); assert.equal(options.items.filter(item => item.name === 'model').length, 1);
  assert.deepEqual(options.items.find(item => item.name === 'model'), {name: 'model', description: 'Choose a model for the primary', source: 'App'});
  assert.equal(options.items.find(item => item.name === 'fixture')?.source, 'extension');
  assert.deepEqual(options.items.filter(item => item.source === 'App').map(item => item.name).sort(), ['compact', 'fork', 'model', 'new', 'resume', 'thinking']);
  assert.equal(notifications, 2); const first = options.items[0]; assert.ok(first); first.description = 'mutated'; assert.equal(actions.commandOptions().items[0]?.description, 'Choose a model for the primary');
  selected = {...primary, epoch: 2}; assert.equal(actions.commandOptions().state, 'loading'); actions.warm(); await actions.load('commands'); assert.ok(notifications > 2);
  selected = undefined; actions.warm(); assert.equal(actions.commandOptions().state, 'unavailable');
});
test('a failed Pi command load leaves the App actions usable and never stays in a loading state', async () => {
  globalThis.fetch = async () => {throw new Error('offline');};
  const actions = new Actions(context()); await assert.rejects(actions.load('commands'), /offline/);
  assert.equal(actions.commandOptions().state, 'ready'); assert.equal(actions.commandOptions().items.every(item => item.source === 'App'), true);
});
test('a stale command response cannot populate options for another epoch', async () => {
  let selected = {...primary}; let resolveOld: (value: Response) => void = () => {};
  globalThis.fetch = async () => new Promise<Response>(resolve => {resolveOld = resolve;});
  const actions = new Actions(context({primary: () => selected})); const old = actions.load('commands'); selected = {...primary, epoch: 2};
  resolveOld(Response.json({ok: true, data: {items: [{name: 'stale', description: '', source: 'extension'}], nextCursor: null, revision: '1'}})); await old;
  assert.equal(actions.commandOptions().state, 'loading'); assert.equal(actions.commandOptions().items.some(item => item.name === 'stale'), false);
});
test('App aliases still open their actions rather than submit Pi or literal input', () => {
  const actions = new Actions(context()); const calls: string[] = []; let literals = 0;
  actions.newSession = () => {calls.push('new');}; actions.projectPicker = () => {calls.push('resume');}; actions.forkPicker = () => {calls.push('fork');};
  actions.compact = () => {calls.push('compact');}; actions.modelPicker = () => {calls.push('model');}; actions.thinkingPicker = () => {calls.push('thinking');};
  for (const name of ['new', 'resume', 'fork', 'compact', 'model', 'thinking']) assert.equal(actions.unknown(`/${name} argument`, () => {literals++;}), true);
  assert.deepEqual(calls, ['new', 'resume', 'fork', 'compact', 'model', 'thinking']); assert.equal(literals, 0);
});
test('primary text actions await primary selection before an edit or focus and reject newer draft text', async () => {
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => {release = resolve;});
  const selected: unknown[] = []; const edits: string[] = []; let focused = 0; const runs: Promise<unknown>[] = [];
  const composer = {target: {kind: 'primary', key: 'p', epoch: 1}, editor: {value: '', focus: () => {focused++;}}, setText(text: string) {edits.push(text); this.editor.value = text;}};
  const actions = new Actions(context({composer: composer as unknown as ActionContext['composer'], selection: async value => {selected.push(value); await gate;},
    modal: {run: (action: () => Promise<unknown>) => {const run = action(); runs.push(run); return run;}} as unknown as ActionContext['modal']}));
  actions.prepareText('/fixture'); assert.deepEqual(selected, [{selectedTarget: composer.target}]); assert.deepEqual(edits, []); assert.equal(focused, 0);
  release(); await runs[0]; assert.deepEqual(edits, ['/fixture']); assert.equal(focused, 1);
  composer.editor.value = ''; actions.prepareText('/other'); composer.editor.value = 'newer'; await runs[1]; assert.deepEqual(edits, ['/fixture']); assert.equal(focused, 1);
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {}; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};
}
const command = (name: string) => ({name, description: 'Public command', source: 'extension' as const});
const commandResponse = (names: string[], nextCursor: string | null) => Response.json({ok: true, data: {items: names.map(command), nextCursor, revision: '1'}});
test('slash inventory loads beyond the first page sequentially and shares the pages with the palette', async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => new FakeNode()}});
  try {
    const reached = deferred<void>(); const second = deferred<Response>(); const paths: string[] = [];
    const names = Array.from({length: 100}, (_, index) => `command${index}`); const body = new FakeNode();
    globalThis.fetch = async path => {
      paths.push(String(path)); if (paths.length === 1) return commandResponse(names, 'next page');
      reached.resolve(); return second.promise;
    };
    const modal = {body, token: 1, open: () => body, owns: (token: number) => token === 1} as unknown as ActionContext['modal'];
    const actions = new Actions(context({modal})); const loading = actions.load('commands'); await reached.promise;
    assert.equal(actions.commandOptions().state, 'loading'); actions.palette(); assert.equal(paths.length, 2);
    second.resolve(commandResponse(['later-command'], null)); const page = await loading; await actions.load('commands'); await Promise.resolve();
    assert.equal(page.items.length, names.length + 1); assert.equal(actions.commandOptions().state, 'ready'); assert.equal(actions.commandOptions().incomplete, undefined);
    assert.equal(actions.commandOptions().items.some(item => item.name === 'later-command'), true); assert.equal(actions.unknown('/later-command', () => {}), false);
    assert.deepEqual(paths, ['/api/primaries/p/resources/commands?limit=100', '/api/primaries/p/resources/commands?limit=100&cursor=next%20page']);
    assert.equal(body.children[2]?.children.some(node => node.textContent === '/later-command'), true);
  } finally { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document'); }
});
test('a page from a stale epoch is discarded and never requests its continuation', async () => {
  let selected = {...primary}; const reached = deferred<void>(); const second = deferred<Response>(); let calls = 0;
  globalThis.fetch = async () => {
    calls++; if (calls === 1) return commandResponse(['old-first'], 'old-next');
    if (calls === 2) {reached.resolve(); return second.promise;}
    return commandResponse(['current'], null);
  };
  const actions = new Actions(context({primary: () => selected})); const old = actions.load('commands'); await reached.promise;
  selected = {...primary, epoch: 2}; await actions.load('commands'); second.resolve(commandResponse(['old-second'], 'must-not-fetch')); await old;
  assert.equal(calls, 3); assert.equal(actions.commandOptions().items.some(item => item.name.startsWith('old-')), false);
  assert.equal(actions.commandOptions().items.some(item => item.name === 'current'), true);
});
test('the automatic page bound marks partial inventory and palette More extends the same cached aggregate', async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => new FakeNode()}});
  try {
    const paths: string[] = []; const body = new FakeNode(); const runs: Promise<unknown>[] = [];
    globalThis.fetch = async path => {
      paths.push(String(path)); const page = paths.length;
      return commandResponse([`page-${page}`], page <= COMMAND_INVENTORY_PAGE_LIMIT ? `cursor-${page}` : null);
    };
    const modal = {body, token: 1, open: () => body, owns: () => true, run: (action: () => Promise<unknown>) => {const run = action(); runs.push(run); return run;}} as unknown as ActionContext['modal'];
    const actions = new Actions(context({modal})); const page = await actions.load('commands');
    assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT); assert.equal(actions.commandOptions().state, 'ready'); assert.equal(actions.commandOptions().incomplete, true);
    assert.equal(page.items.length, COMMAND_INVENTORY_PAGE_LIMIT); assert.equal(page.nextCursor, `cursor-${COMMAND_INVENTORY_PAGE_LIMIT}`);
    actions.palette(); await actions.load('commands'); await Promise.resolve(); assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT);
    const more = body.children.find(node => node.textContent === 'More discovered commands'); assert.ok(more); more.dispatchEvent(new Event('click')); await runs[0];
    assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT + 1); assert.equal(actions.commandOptions().incomplete, undefined);
    assert.equal(page.items.length, COMMAND_INVENTORY_PAGE_LIMIT + 1); assert.equal(page.nextCursor, null);
    assert.equal(await actions.load('commands'), page); assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT + 1);
  } finally { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document'); }
});
test('a failed later page retains incomplete items and retry reuses confirmed earlier pages', async () => {
  const paths: string[] = []; let failed = false;
  globalThis.fetch = async path => {
    paths.push(String(path)); if (!String(path).includes('cursor=')) return commandResponse(['retained'], 'next');
    if (!failed) {failed = true; throw new Error('page unavailable');}
    return commandResponse(['recovered'], null);
  };
  const actions = new Actions(context()); await assert.rejects(actions.load('commands'), /page unavailable/);
  assert.equal(actions.commandOptions().incomplete, true); assert.equal(actions.commandOptions().items.some(item => item.name === 'retained'), true);
  await actions.load('commands'); assert.equal(paths.filter(path => !path.includes('cursor=')).length, 1);
  assert.equal(actions.commandOptions().incomplete, undefined); assert.equal(actions.commandOptions().items.some(item => item.name === 'recovered'), true);
});
