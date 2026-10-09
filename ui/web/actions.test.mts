import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { OperationView, PrimaryControl, PrimaryView } from '../shared/api.ts';
import { Actions, COMMAND_INVENTORY_PAGE_LIMIT, rankPalette } from './actions.ts';
import { Modal } from './modal.ts';
import { rankCommands } from './command-menu-state.ts';
import type { ActionContext } from './actions.ts';
const originalFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch = originalFetch;});
const primary: PrimaryView = {key: 'p', epoch: 1, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingDialogs: [], pendingOperationIds: [], capabilities: {control: true}};
const operation: OperationView = {id: 'op', kind: 'primary.control', state: 'completed', target: {kind: 'primary', key: 'p', epoch: 1}, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z'};
function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {snapshot: () => undefined, primary: () => primary, composer: {commandsChanged: () => {}} as ActionContext['composer'], modal: {} as ActionContext['modal'], selection: async () => undefined, reload: async () => undefined, result: () => undefined, rosterRefresh: () => undefined, find: () => undefined, recovery: () => undefined, primaryEntries: () => [], agents: () => [], selectedAgent: () => undefined, selectAgent: () => {}, notices: () => {}, sidebar: () => {}, view: () => {}, copyAgent: () => {}, inspectAgent: () => {}, ...overrides};
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
  title = ''; tagName = ''; children: FakeNode[] = []; textContent = ''; className = ''; type = ''; id = ''; value = ''; disabled = false; hidden = false; tabIndex = 0; dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  append(...nodes: FakeNode[]): void {this.children.push(...nodes);}
  replaceChildren(...nodes: FakeNode[]): void {this.children = nodes;}
  open = false; isConnected = true;
  querySelector(): null {return null;}
  querySelectorAll(): FakeNode[] {return this.children.filter(node => node.tagName === 'button');}
  showModal(): void {this.open = true;}
  close(): void {this.open = false; this.dispatchEvent(new Event('close'));}
  setAttribute(name: string, value: string): void {this.attributes.set(name, value);}
  removeAttribute(name: string): void {this.attributes.delete(name);}
  scrollIntoView(): void {}
  focus(): void {focused = this;}
}
let focused: FakeNode | undefined;
function fakeDocument() {return {createElement: (tagName: string) => {const node = new FakeNode(); node.tagName = tagName; return node;}, getElementById: () => new FakeNode()};}
function textOf(node: FakeNode): string {return node.textContent + node.children.map(textOf).join('');}
test('journal and HTTP copies of one handoff completion open its result once', () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: fakeDocument()});
  try {
    let opened = 0; const body = new FakeNode();
    const modal = {node: new FakeNode(), body, open() {opened++; return body;}} as unknown as ActionContext['modal'];
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
  Object.defineProperty(globalThis, 'document', {configurable: true, value: fakeDocument()});
  try {
    let selected = {...primary, lifecycle: 'starting' as PrimaryView['lifecycle']}; const body = new FakeNode();
    const modal = {node: new FakeNode(), body, token: 1, open() {return body;}, owns(token: number) {return token === 1;}} as unknown as ActionContext['modal'];
    globalThis.fetch = async () => Response.json({ok: true, data: {items: [{name: 'fixture', description: 'public', source: 'extension'}], nextCursor: null, revision: '2'}});
    const actions = new Actions(context({primary: () => selected, modal})); actions.warm(); actions.palette(); await actions.load('commands');
    const list = body.children[1]; assert.ok(list); assert.equal(list.children.some(node => textOf(node).startsWith('/fixture')), false);
    selected = {...primary}; actions.warm(); await actions.load('commands');
    assert.equal(list.children.some(node => textOf(node).startsWith('/fixture')), true);
  } finally {if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');}
});

test('primary text actions with no ready target open the picker without changing drafts', () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: fakeDocument()});
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
  assert.deepEqual(options.items.find(item => item.name === 'model'), {name: 'model', description: 'Choose a model for the primary', source: 'app'});
  assert.equal(options.items.find(item => item.name === 'fixture')?.source, 'extension');
  assert.deepEqual(options.items.filter(item => item.source === 'app').map(item => item.name).sort(), ['compact', 'fork', 'model', 'new', 'resume', 'thinking']);
  assert.equal(notifications, 2); const first = options.items[0]; assert.ok(first); first.description = 'mutated'; assert.equal(actions.commandOptions().items[0]?.description, 'Choose a model for the primary');
  selected = {...primary, epoch: 2}; assert.equal(actions.commandOptions().state, 'loading'); actions.warm(); await actions.load('commands'); assert.ok(notifications > 2);
  selected = undefined; actions.warm(); assert.equal(actions.commandOptions().state, 'unavailable');
});
test('a failed Pi command load leaves the App actions usable and never stays in a loading state', async () => {
  globalThis.fetch = async () => {throw new Error('offline');};
  const actions = new Actions(context()); await assert.rejects(actions.load('commands'), /offline/);
  assert.equal(actions.commandOptions().state, 'ready'); assert.equal(actions.commandOptions().items.every(item => item.source === 'app'), true);
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
  Object.defineProperty(globalThis, 'document', {configurable: true, value: fakeDocument()});
  try {
    const reached = deferred<void>(); const second = deferred<Response>(); const paths: string[] = [];
    const names = Array.from({length: 100}, (_, index) => `command${index}`); const body = new FakeNode();
    globalThis.fetch = async path => {
      paths.push(String(path)); if (paths.length === 1) return commandResponse(names, 'next page');
      reached.resolve(); return second.promise;
    };
    const modal = {node: new FakeNode(), body, token: 1, open: () => body, owns: (token: number) => token === 1} as unknown as ActionContext['modal'];
    const actions = new Actions(context({modal})); const loading = actions.load('commands'); await reached.promise;
    assert.equal(actions.commandOptions().state, 'loading'); actions.palette(); assert.equal(paths.length, 2);
    second.resolve(commandResponse(['later-command'], null)); const page = await loading; await actions.load('commands'); await Promise.resolve();
    assert.equal(page.items.length, names.length + 1); assert.equal(actions.commandOptions().state, 'ready'); assert.equal(actions.commandOptions().incomplete, undefined);
    assert.equal(actions.commandOptions().items.some(item => item.name === 'later-command'), true); assert.equal(actions.unknown('/later-command', () => {}), false);
    assert.deepEqual(paths, ['/api/primaries/p/resources/commands?limit=100', '/api/primaries/p/resources/commands?limit=100&cursor=next%20page']);
    assert.equal(body.children[1]?.children.some(node => textOf(node).startsWith('/later-command')), true);
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
  Object.defineProperty(globalThis, 'document', {configurable: true, value: fakeDocument()});
  try {
    const paths: string[] = []; const body = new FakeNode(); const runs: Promise<unknown>[] = [];
    globalThis.fetch = async path => {
      paths.push(String(path)); const page = paths.length;
      return commandResponse([`page-${page}`], page <= COMMAND_INVENTORY_PAGE_LIMIT ? `cursor-${page}` : null);
    };
    const modal = {node: new FakeNode(), body, token: 1, open: () => body, owns: () => true, run: (action: () => Promise<unknown>) => {const run = action(); runs.push(run); return run;}} as unknown as ActionContext['modal'];
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

function paletteFixture(overrides: Partial<ActionContext> = {}) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: fakeDocument()});
  const body = new FakeNode(); const node = new FakeNode(); let open = true;
  const modal = {node, body, token: 1, open: () => body, owns: () => open, close: () => {open = false;}, error: () => {}} as unknown as ActionContext['modal'];
  globalThis.fetch = async () => commandResponse([], null);
  return {actions: new Actions(context({modal, ...overrides})), body, node, isOpen: () => open, restore: () => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  }};
}
function key(node: FakeNode, name: string, options: Record<string, unknown> = {}) {
  const event = new Event('keydown', {cancelable: true}); Object.assign(event, {key: name, ...options}); node.dispatchEvent(event); return event;
}
test('palette covers every displaced control and session availability follows the menu', () => {
  const actions = new Actions(context());
  const names = actions.paletteEntries().filter(item => item.source === 'app').map(item => item.name);
  assert.deepEqual(names, ['New session', 'Resume saved session', 'Fork from message…', 'Compact…', 'Automatic retry…', 'Automatic compaction…', 'Continue in terminal…', 'Session details', 'Saved drafts and input copies', 'Appearance', 'Help', 'Expand loaded tools', 'Collapse loaded tools', 'Show thinking', 'Hide thinking', 'Find in loaded messages', 'Notifications', 'Refresh agent roster', 'New agent through primary', 'Hide sidebar', 'Show sidebar', 'Open project or session', 'Model', 'Thinking']);
  const absent = new Actions(context({primary: () => undefined})).paletteEntries();
  const disabled = absent.filter(item => !item.enabled).map(item => item.name);
  assert.deepEqual(disabled, ['New session', 'Fork from message…', 'Compact…', 'Automatic retry…', 'Automatic compaction…', 'Continue in terminal…', 'Session details', 'Expand loaded tools', 'Collapse loaded tools', 'Show thinking', 'Hide thinking', 'Find in loaded messages', 'Model', 'Thinking']);
  const starting = new Actions(context({primary: () => ({...primary, lifecycle: 'starting'})})).paletteEntries();
  assert.equal(starting.find(item => item.name === 'New session')?.enabled, true);
  assert.equal(starting.find(item => item.name === 'Model')?.enabled, false);
  assert.equal(starting.find(item => item.name === 'Thinking')?.enabled, false);
});
test('retry and selected-agent palette entries require their evidence and capability', () => {
  const actions = new Actions(context({primary: () => ({...primary, lastError: {code: 'failed', message: 'Failure', retry: 'manual'}}), selectedAgent: () => ({identity: 'agent-id'})}));
  assert.equal(actions.paletteEntries().some(item => item.name === 'Review retry prompt'), true);
  assert.equal(actions.paletteEntries().some(item => item.name === 'Copy agent identity'), true);
  assert.equal(actions.paletteEntries().some(item => item.name === 'Inspect agent activity'), false);
  const inspect = new Actions(context({selectedAgent: () => ({identity: 'agent-id', capabilities: {history: true, observe: true, input: false, abort: false, configure: false, inspect: true}})}));
  assert.equal(inspect.paletteEntries().some(item => item.name === 'Inspect agent activity'), true);
  assert.equal(new Actions(context()).paletteEntries().some(item => /Copy agent|Inspect agent|Review retry/.test(item.name)), false);
});
test('palette uses ranked rows, marked names and input-owned keyboard selection', async () => {
  const f = paletteFixture(); try {
    let selected = ''; f.actions.paletteEntries = () => [
      {name: 'zxyz', description: '', source: 'app', enabled: true, run: () => {selected = 'sequence';}},
      {name: 'tool:xy', description: '', source: 'extension', enabled: true, run: () => {selected = 'segment';}},
      {name: 'xy-long', description: '', source: 'app', enabled: true, run: () => {selected = 'prefix';}},
      {name: 'xy', description: '', source: 'app', enabled: true, run: () => {selected = 'exact';}},
      {name: 'other', description: 'xy description', source: 'skill', enabled: true, run: () => {selected = 'description';}},
    ];
    f.actions.palette(); await f.actions.load('commands'); await Promise.resolve();
    assert.equal(f.node.dataset.variant, 'palette');
    const line = f.body.children[0]; const list = f.body.children[1]; assert.ok(line && list);
    assert.equal(line.className, 'palette-input'); assert.equal(line.children[0]?.textContent, '›');
    const field = line.children[2]; assert.ok(field); field.value = 'xy'; field.dispatchEvent(new Event('input'));
    assert.deepEqual(list.children.map(row => textOf(row.children[0] as FakeNode)), ['xy', 'xy-long', 'tool:xy', 'zxyz', 'other']);
    assert.equal(list.attributes.get('role'), 'listbox'); assert.equal(list.children[0]?.attributes.get('aria-selected'), 'true');
    assert.equal(field.attributes.get('aria-activedescendant'), list.children[0]?.id);
    assert.deepEqual(list.children[0]?.children[0]?.children.map(node => node.tagName), ['mark', 'mark']);
    assert.deepEqual(list.children[0]?.children.map(node => node.className), ['palette-name', 'palette-desc', 'palette-source']);
    assert.equal(list.children[0]?.attributes.get('role'), 'option');
    assert.equal(key(field, 'ArrowDown').defaultPrevented, true); assert.equal(focused, field);
    assert.equal(list.children[1]?.attributes.get('aria-selected'), 'true'); key(field, 'ArrowUp'); key(field, 'Enter');
    assert.equal(selected, 'exact'); assert.equal(f.isOpen(), false);
  } finally {f.restore();}
});
test('palette blocks disabled Enter and click, and ignores composition keys', () => {
  const f = paletteFixture({primary: () => undefined}); try {
    let calls = 0; f.actions.paletteEntries = () => [{name: 'Unavailable', description: '', source: 'app', enabled: false, run: () => {calls++;}}];
    f.actions.palette(); const field = f.body.children[0]?.children[2]; const row = f.body.children[1]?.children[0]; assert.ok(field && row);
    assert.equal(key(field, 'Enter', {isComposing: true}).defaultPrevented, false);
    key(field, 'Enter'); row.dispatchEvent(new Event('click')); assert.equal(calls, 0); assert.equal(f.isOpen(), true);
    assert.equal(row.disabled, true); assert.equal(row.attributes.get('aria-disabled'), 'true');
  } finally {f.restore();}
});
test('agent rows search names, handles and identity and mouse selection selects the agent', () => {
  const agent = {identity: 'stored-identity', storageId: 'store', cwd: '/project', name: 'Builder', handle: 'build-handle', modifiedAt: 1, state: 'idle', owner: 'unknown' as const, availability: 'stored' as const, partial: false};
  let picked = ''; const f = paletteFixture({agents: () => [agent], selectAgent: row => {picked = row.identity;}}); try {
    f.actions.palette(); const field = f.body.children[0]?.children[2]; const list = f.body.children[1]; assert.ok(field && list);
    for (const query of ['Builder', 'build-handle', 'stored-identity']) {field.value = query; field.dispatchEvent(new Event('input')); assert.equal(list.children.length, 1);}
    assert.equal(list.children[0]?.children[2]?.textContent, 'agent');
    assert.equal(list.children[0]?.title, agent.identity);
    assert.doesNotMatch(textOf(list.children[0] as FakeNode), /stored-identity|build-handle|\/project/);
    field.value = '/project'; field.dispatchEvent(new Event('input')); assert.equal(list.children.length, 0);
    field.value = agent.identity; field.dispatchEvent(new Event('input')); list.children[0]?.dispatchEvent(new Event('click'));
    assert.equal(picked, agent.identity); assert.equal(f.isOpen(), false);
  } finally {f.restore();}
});

test('palette Escape uses the shared modal and restores focus without an action', () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'); const oldElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const invoke = new FakeNode(); const nodes = new Map(['modal', 'modal-body', 'modal-title', 'modal-close', 'modal-error', 'primary-editor'].map(id => [id, new FakeNode()]));
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: FakeNode});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {...fakeDocument(), activeElement: invoke, getElementById: (id: string) => nodes.get(id)}});
  globalThis.fetch = async () => commandResponse([], null);
  try {
    const modal = new Modal(); let calls = 0; const actions = new Actions(context({modal, notices: () => {calls++;}})); actions.palette();
    assert.equal(nodes.get('modal-title')?.textContent, 'Commands'); assert.equal(nodes.get('modal')?.dataset.variant, 'palette');
    const event = new Event('cancel', {cancelable: true}); nodes.get('modal')?.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true); assert.equal(modal.openNow, false); assert.equal(calls, 0); assert.equal(focused, invoke);
    modal.open('Details'); assert.equal(nodes.get('modal')?.dataset.variant, undefined);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (oldElement) Object.defineProperty(globalThis, 'HTMLElement', oldElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }
});

test('agent palette descriptions use only state and compact age', () => {
  const originalNow = Date.now; const now = new Date('2026-10-09T12:00:00Z').getTime(); Date.now = () => now;
  try {
    const base = {identity: 'agent-identity', storageId: 'store', cwd: '/project', name: 'Builder', handle: 'builder-handle', modifiedAt: now, state: 'working', owner: 'unknown' as const, availability: 'live' as const, partial: false};
    const cases: [number, string][] = [[0, 'now'], [61_000, '1m'], [3_600_000, '1h'], [3 * 3_600_000, '3h'], [86_400_000, '1d'], [29 * 86_400_000, '29d'], [30 * 86_400_000, 'Sep 9']];
    for (const [age, label] of cases) {
      const actions = new Actions(context({agents: () => [{...base, modifiedAt: now - age}]}));
      const item = actions.paletteEntries().find(item => item.source === 'agent'); assert.ok(item);
      assert.equal(item.description, `working · ${label}`); assert.equal(item.title, base.identity); assert.deepEqual(item.search, [base.identity, base.handle]);
    }
    const stored = new Actions(context({agents: () => [{...base, availability: 'stored', modifiedAt: now - 3 * 3_600_000}]}));
    assert.equal(stored.paletteEntries().find(item => item.source === 'agent')?.description, 'stored · 3h');
    const invalid = new Actions(context({agents: () => [{...base, modifiedAt: Number.NaN}]}));
    assert.equal(invalid.paletteEntries().find(item => item.source === 'agent')?.description, 'working');
  } finally {Date.now = originalNow;}
});
test('hidden agent aliases reuse command ranking without false marks on the display name', () => {
  const entry = (name: string, search: string[]) => ({name, search, description: 'stored · 3h', source: 'agent', enabled: true, run: () => {}});
  const items = [entry('First', ['xy-extra']), entry('Second', ['xy']), entry('Third', ['tool:xy']), entry('Fourth', ['x-y'])];
  const matches = rankPalette(items, 'xy'); assert.deepEqual(matches.map(match => match.item.name), ['Second', 'First', 'Third', 'Fourth']);
  assert.deepEqual(matches.map(match => match.rank), [0, 1, 2, 3]); assert.equal(matches.every(match => match.marks.length === 0), true);
  const visible = rankPalette(items, 'First'); assert.equal(visible[0]?.item.name, 'First'); assert.deepEqual(visible[0]?.marks, [0, 1, 2, 3, 4]);
});

test('the palette keeps canonical browser actions and their slash aliases without duplicate rows', async () => {
  globalThis.fetch = async () => Response.json({ok: true, data: {items: [{name: 'fixture', description: 'Public command', source: 'extension'}], nextCursor: null, revision: '1'}});
  const actions = new Actions(context()); await actions.load('commands'); const inventory = actions.commandOptions();
  const rows = actions.paletteEntries(); const aliases = [['new', 'New session'], ['resume', 'Resume saved session'], ['fork', 'Fork from message…'], ['compact', 'Compact…'], ['model', 'Model'], ['thinking', 'Thinking']] as const;
  for (const [alias, name] of aliases) {
    assert.equal(rows.filter(row => row.name === name).length, 1);
    assert.equal(rows.some(row => row.name === `/${alias}` && row.source === 'app'), false);
    for (const query of [alias, `/${alias}`]) assert.equal(rankPalette(rows, query)[0]?.item.name, name);
    assert.equal(inventory.items.some(item => item.name === alias && item.source === 'app'), true);
  }
  assert.equal(rows.some(row => row.name === '/fixture' && row.source === 'extension'), true);
  assert.deepEqual(rankPalette(rows, 'compact')[0]?.marks, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(actions.commandOptions(), inventory);
});
test('non-browser discovered commands retain palette rows even with a browser alias of the same name', async () => {
  globalThis.fetch = async () => Response.json({ok: true, data: {items: [{name: 'model', description: 'Public model command', source: 'extension'}], nextCursor: null, revision: '1'}});
  const actions = new Actions(context()); await actions.load('commands');
  assert.equal(actions.paletteEntries().some(item => item.name === '/model' && item.source === 'extension'), true);
  assert.equal(actions.paletteEntries().some(item => item.name === 'Model' && item.source === 'app'), true);
  assert.equal(actions.commandOptions().items.find(item => item.name === 'model')?.source, 'app');
});

test('an empty palette groups actions, Pi commands and agents without alphabetic interleaving', () => {
  const entry = (name: string, source: string) => ({name, source, description: '', enabled: true, run: () => {}});
  const items = [entry('Z agent', 'agent'), entry('/z-command', 'extension'), entry('Z action', 'app'), entry('/a-command', 'skill'), entry('A agent', 'agent'), entry('A action', 'app')];
  for (const query of ['', '   ']) {
    const result = rankPalette(items, query);
    assert.deepEqual(result.map(match => match.item.name), ['Z action', 'A action', '/z-command', '/a-command', 'Z agent', 'A agent']);
    assert.equal(result.every(match => match.marks.length === 0), true);
  }
  assert.deepEqual(rankPalette(items, 'a'), rankCommands(items, 'a'));
  assert.equal(rankPalette(items, 'A agent')[0]?.item.name, 'A agent');
});
test('empty palette agents put live and working agents first with stable roster order', () => {
  const base = {storageId: 'store', cwd: '/project', modifiedAt: Date.now(), state: 'idle', owner: 'unknown' as const, availability: 'stored' as const, partial: false};
  const rows = [
    {...base, identity: 'stored-z', name: 'Z stored'},
    {...base, identity: 'live-z', name: 'Z live', availability: 'live' as const},
    {...base, identity: 'stored-a', name: 'A stored'},
    {...base, identity: 'working-y', name: 'Y working', state: 'working'},
    {...base, identity: 'live-a', name: 'A live', availability: 'live' as const},
  ];
  const original = rows.map(row => row.identity); const actions = new Actions(context({agents: () => rows}));
  const result = rankPalette(actions.paletteEntries(), '').filter(match => match.item.source === 'agent');
  assert.deepEqual(result.map(match => (match.item as {title?: string}).title), ['live-z', 'working-y', 'live-a', 'stored-z', 'stored-a']);
  assert.deepEqual(rows.map(row => row.identity), original);
  assert.deepEqual(rankPalette(actions.paletteEntries(), 'stored').filter(match => match.item.source === 'agent').map(match => match.item.name), ['A stored', 'Z stored', 'Y working']);
});

test('duplicate agent names receive conversation or shortest unique identity tails only', () => {
  const base = {storageId: 'store', cwd: '/project', modifiedAt: Date.now(), state: 'idle', owner: 'unknown' as const, availability: 'stored' as const, partial: false};
  const pairs = [
    ['Four', 'rootaaaa', 'rootbbbb', 'aaaa', 'bbbb'],
    ['Five', 'rootxaaaa', 'rootyaaaa', 'xaaaa', 'yaaaa'],
    ['Eight', 'rootxabcdefg', 'rootyabcdefg', 'xabcdefg', 'yabcdefg'],
    ['Full', 'firstzabcdefgh', 'secondzabcdefgh', 'firstzabcdefgh', 'secondzabcdefgh'],
    ['Conversation', 'store:conversation-a', 'store:conversation-b', 'conversation-a', 'conversation-b'],
  ] as const;
  const rows = pairs.flatMap(([name, first, second]) => [{...base, name, identity: first}, {...base, name, identity: second}]);
  rows.push({...base, name: 'Unique', identity: 'anotheraaaa'});
  const actions = new Actions(context({agents: () => rows})); const agents = actions.paletteEntries().filter(item => item.source === 'agent');
  for (const [name, first, second, firstTail, secondTail] of pairs) {
    assert.equal(agents.find(item => item.title === first)?.tail, firstTail); assert.equal(agents.find(item => item.title === second)?.tail, secondTail);
    assert.equal(agents.find(item => item.title === first)?.name, name);
  }
  assert.equal(agents.find(item => item.name === 'Unique')?.tail, undefined);
  const handles = new Actions(context({agents: () => [{...base, handle: 'builder', identity: 'first1111'}, {...base, handle: 'builder', identity: 'second2222'}]}));
  assert.deepEqual(handles.paletteEntries().filter(item => item.source === 'agent').map(item => item.tail), ['1111', '2222']);
});
test('duplicate palette rows render dim-tail spans and retain exact keyboard selection after repaint', async () => {
  const base = {storageId: 'store', cwd: '/project', modifiedAt: Date.now(), name: 'Builder', state: 'idle', owner: 'unknown' as const, availability: 'stored' as const, partial: false};
  const rows = [{...base, identity: 'store:conversation-a'}, {...base, identity: 'store:conversation-b'}, {...base, name: 'Unique', identity: 'store:conversation-c'}];
  let selected = ''; const f = paletteFixture({agents: () => rows, selectAgent: row => {selected = row.identity;}}); const page = deferred<Response>(); globalThis.fetch = async () => page.promise;
  try {
    f.actions.palette(); const field = f.body.children[0]?.children[2]; const list = f.body.children[1]; assert.ok(field && list);
    const unique = list.children.find(row => row.title === 'store:conversation-c'); assert.ok(unique);
    assert.equal(unique.children[0]?.children.some(node => node.className === 'palette-tail'), false);
    field.value = 'Builder'; field.dispatchEvent(new Event('input')); assert.equal(list.children.length, 2);
    for (const [index, row] of list.children.entries()) {
      const name = row.children[0]; assert.ok(name); const tail = name.children.at(-1); assert.ok(tail);
      assert.equal(tail.className, 'palette-tail'); assert.equal(tail.tagName, 'span'); assert.equal(tail.textContent, index === 0 ? ' conversation-a' : ' conversation-b');
      assert.equal(name.children[0]?.tagName, 'mark');
    }
    key(field, 'ArrowDown'); assert.equal(list.children[1]?.attributes.get('aria-selected'), 'true');
    page.resolve(commandResponse([], null)); await f.actions.load('commands'); await Promise.resolve();
    assert.equal(list.children[1]?.attributes.get('aria-selected'), 'true'); assert.equal(list.children[1]?.title, 'store:conversation-b');
    field.value = 'conversation-b'; field.dispatchEvent(new Event('input')); assert.equal(list.children.length, 1); assert.equal(list.children[0]?.title, 'store:conversation-b');
    key(field, 'Enter'); assert.equal(selected, 'store:conversation-b');
  } finally {f.restore();}
});
