import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import type { AgentRow, Appearance, HandoffView, OperationView, PrimaryControl, PrimaryView, Snapshot, Target } from '../shared/api.ts';
import { Actions, COMMAND_INVENTORY_PAGE_LIMIT, MODEL_NAME_PAGE_LIMIT, rankPalette } from './actions.ts';
import { Modal } from './modal.ts';
import { rankCommands } from './command-menu-state.ts';
import type { ActionContext, PaletteEntry } from './actions.ts';
const originalFetch = globalThis.fetch;
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed = new Set<Element>(); disconnected = false;
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {this.callback = callback; FakeResizeObserver.instances.push(this);}
  observe(node: Element): void {this.observed.add(node);}
  disconnect(): void {this.disconnected = true; this.observed.clear();}
  fire(): void {this.callback([], this as unknown as ResizeObserver);}
}
beforeEach(() => {FakeResizeObserver.instances = []; Object.defineProperty(globalThis, 'ResizeObserver', {configurable: true, value: FakeResizeObserver});});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalResizeObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver); else Reflect.deleteProperty(globalThis, 'ResizeObserver');
});
const primary: PrimaryView = {key: 'p', epoch: 1, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingDialogs: [], pendingOperationIds: [], capabilities: {control: true}};
const handoff: HandoffView = {cwd: '/handed-project', sessionFile: '/handed-project/session.jsonl', executable: 'pi', argv: ['--session', '/handed-project/session.jsonl'], command: 'pi --session /handed-project/session.jsonl'};
const operation: OperationView = {id: 'op', kind: 'primary.control', state: 'completed', target: {kind: 'primary', key: 'p', epoch: 1}, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z'};
function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {agentPresentation: row => ({name: row.name ?? 'Unnamed conversation', activity: 'Running', tone: 'secondary', cwd: row.cwd}), snapshot: () => undefined, primary: () => primary, composer: {commandsChanged: () => {}} as ActionContext['composer'], commandsChanged: () => {overrides.composer?.commandsChanged?.();}, modal: {} as ActionContext['modal'], selection: async () => undefined, reload: async () => undefined, result: () => undefined, rosterRefresh: () => undefined, hasTranscript: () => !!(overrides.primary ?? (() => primary))(), find: () => undefined, recovery: () => undefined, primaryEntries: () => [], agents: () => [], selectedAgent: () => undefined, agentStatus: row => row.availability === 'live' ? row.state : row.availability, selectAgent: () => {}, selectPrimary: () => {}, notices: () => {}, sidebar: () => {}, sidebarShown: () => true, view: () => {}, copyAgent: () => {}, inspectAgent: () => {}, ...overrides};
}
test('model holds start before reservation and release only their own authoritative receipt', async () => {
  const reserved = Promise.withResolvers<Response>(); let count = 0, changed = 0;
  globalThis.fetch = async path => {
    if (String(path) === '/api/operations') {if (++count === 1) return reserved.promise; return Response.json({ok: true, data: {operationId: 'new'}});}
    if (count === 1) throw new Error('response lost');
    return Response.json({ok: true, data: {...operation, id: 'new', state: 'rejected'}});
  };
  const actions = new Actions(context({modelChanged: () => {changed++;}})), target = operation.target; assert.ok(target);
  const first = actions.control({action: 'model', provider: 'fixture', modelId: 'model'} as PrimaryControl);
  assert.equal(actions.modelChanging(target), true); reserved.resolve(Response.json({ok: true, data: {operationId: 'old'}})); await assert.rejects(first, /response lost/);
  await actions.control({action: 'model', provider: 'fixture', modelId: 'other'} as PrimaryControl);
  assert.equal(actions.modelChanging(target), true); assert.equal(actions.modelChanging({...target, epoch: 2} as Target), false);
  assert.equal(actions.modelChanging(target, [{...operation, id: 'old', state: 'uncertain'}]), true);
  assert.equal(actions.modelChanging(target, [{...operation, id: 'old'}]), false); assert.equal(changed, 4);
});
test('failed model reservation has no control effect and releases the local hold', async () => {
  let calls = 0; globalThis.fetch = async () => {calls++; throw new Error('reservation lost');};
  const actions = new Actions(context()); await assert.rejects(actions.control({action: 'model'} as PrimaryControl), /reservation lost/);
  assert.equal(actions.modelChanging(operation.target as Target), false); assert.equal(calls, 1);
});
test('resource invalidation notifies the existing command owner without acquiring a Primary composer', () => {
  let selected: PrimaryView | undefined = {...primary, lifecycle: 'starting'}, changed = 0; const ctx = context({primary: () => selected, commandsChanged: () => {changed++;}});
  Object.defineProperty(ctx, 'composer', {get: () => {throw Error('No Primary editor is mounted');}});
  const actions = new Actions(ctx); actions.warm(); selected = undefined; actions.warm(); assert.equal(changed, 2);
});
test('agent palette descriptions use the required recipient status callback without a catalog fallback', () => {
  const row: AgentRow = {identity: 'agent', storageId: 'store', cwd: '/project', availability: 'incompatible', state: 'working'};
  let label = 'Recipient status'; const seen: AgentRow[] = [];
  const actions = new Actions(context({agents: () => [row], agentStatus: value => {seen.push(value); return label;}}));
  const entry = actions.paletteEntries().find(item => item.source === 'agent'); assert.ok(entry);
  assert.equal(entry.description, label); assert.deepEqual(seen, [row]);
  label = ''; assert.equal(actions.paletteEntries().find(item => item.source === 'agent')?.description, '');
});
test('New session starts once without confirmation and leaves the old recipient draft unchanged', async () => {
  const started = Promise.withResolvers<void>(); const response = Promise.withResolvers<Response>(); const reloaded = Promise.withResolvers<void>();
  const draft = {target: {kind: 'primary' as const, key: 'p', epoch: 1}, editor: {value: 'Keep this old session draft'}, commandsChanged() {}};
  let current = primary; const seen: string[] = []; const emitted: OperationView[] = [];
  globalThis.fetch = async (path, init) => {
    seen.push(String(path));
    if (String(path) === '/api/operations') { assert.deepEqual(JSON.parse(String(init?.body)), {kind: 'primary.session', target: draft.target}); return Response.json({ok: true, data: {operationId: 'op'}}); }
    assert.equal(path, '/api/primaries/p/session'); assert.deepEqual(JSON.parse(String(init?.body)), {epoch: 1, action: 'new'});
    started.resolve(); return response.promise;
  };
  const actions = new Actions(context({primary: () => current, composer: draft as ActionContext['composer'], modal: {confirm() {throw new Error('New session needs no confirmation');}} as unknown as ActionContext['modal'], result: value => emitted.push(value), reload: async () => {reloaded.resolve();}}));
  actions.newSession(); actions.newSession(); await started.promise; current = {...primary, key: 'other', epoch: 4};
  response.resolve(Response.json({ok: true, data: {...operation, kind: 'primary.session'}})); await reloaded.promise;
  assert.deepEqual(seen, ['/api/operations', '/api/primaries/p/session']); assert.equal(emitted.length, 1);
  assert.deepEqual(draft.target, {kind: 'primary', key: 'p', epoch: 1}); assert.equal(draft.editor.value, 'Keep this old session draft');
});
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
  title = ''; tagName = ''; children: FakeNode[] = []; textContent = ''; className = ''; type = ''; id = ''; value = ''; disabled = false; hidden = false; checked = false; tabIndex = 0; dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  classList = {add: (name: string) => {this.className = `${this.className} ${name}`.trim();}};
  append(...nodes: FakeNode[]): void {this.children.push(...nodes);}
  prepend(...nodes: FakeNode[]): void {this.children.unshift(...nodes);}
  replaceChildren(...nodes: FakeNode[]): void {this.children = nodes;}
  open = false; isConnected = true; clientHeight = 0; offsetHeight = 0; scrollHeight = 0; clientTop = 0; scrollTop = 0; rowSize = 32;
  box = {top: 0, bottom: 0}; properties = new Map<string, string>(); styleWrites = 0;
  style = {visibility: '', getPropertyValue: (name: string) => this.properties.get(name) ?? '', setProperty: (name: string, value: string) => {this.properties.set(name, value); this.styleWrites++;}};
  get ownerDocument(): Document {return globalThis.document;}
  getBoundingClientRect(): {top: number; bottom: number} {return this.box;}
  querySelector(selector: string): FakeNode | null {return this.querySelectorAll(selector)[0] ?? null;}
  querySelectorAll(selector = ''): FakeNode[] {
    if (selector.startsWith('#')) return this.children.filter(node => node.id === selector.slice(1));
    return this.children.filter(node => node.tagName === 'button' && (!selector.includes(':disabled') || !node.disabled) && (!selector.includes('[hidden]') || !node.hidden));
  }
  showModal(): void {this.open = true;}
  show(): void {this.open = true;}
  close(): void {this.open = false; this.dispatchEvent(new Event('close'));}
  setAttribute(name: string, value: string): void {this.attributes.set(name, value);}
  removeAttribute(name: string): void {this.attributes.delete(name);}
  scrollIntoView(): void {throw new Error('Palette selection must scroll only its owned containers.');}
  focus(): void {focused = this;}
}
let focused: FakeNode | undefined;
class FakeView extends EventTarget {
  limit = 630;
  getComputedStyle(node: FakeNode) {return {maxHeight: `${this.limit}px`, getPropertyValue: (name: string) => name === '--palette-row-size' ? `${node.rowSize}px` : ''};}
}
function fakeDocument() {return {createElementNS: (_ns: string, tagName: string) => {const node = new FakeNode(); node.tagName = tagName; return node;}, defaultView: new FakeView(), get activeElement() {return focused;}, createElement: (tagName: string) => {const node = new FakeNode(); node.tagName = tagName; return node;}, getElementById: () => new FakeNode()};}
function textOf(node: FakeNode): string {return node.textContent + node.children.map(textOf).join('');}
test('Find keeps one captured session across query edits and native keys, and closes it on replacement', () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const nodes = new Map(['modal', 'modal-body', 'modal-close', 'modal-title', 'modal-error'].map(id => [id, new FakeNode()]));
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {...fakeDocument(), getElementById: (id: string) => nodes.get(id)}});
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: FakeNode});
  try {
    let captures = 0, closed = 0, resets = 0; const steps: [string, string][] = [];
    const modal = new Modal(), ctx = context({modal, find: () => {captures++; return {
      next: query => {steps.push(['next', query]); return {total: query === 'none' ? 0 : 2, position: 1, moved: true, end: query === 'none' ? 'none' : null};},
      previous: query => {steps.push(['previous', query]); return {total: 2, position: 1, moved: false, end: 'first'};}, reset: () => {resets++;}, close: () => {closed++;}};}});
    Object.defineProperty(ctx, 'composer', {get: () => {throw Error('Find must not acquire the editor');}});
    const actions = new Actions(ctx); actions.find(); const body = nodes.get('modal-body'); assert.ok(body);
    const query = body.children[1], status = body.children[2], row = body.children[4]; assert.ok(query); assert.ok(status); assert.ok(row);
    assert.equal(nodes.get('modal')?.dataset.variant, 'find'); assert.equal(body.children[3]?.textContent, 'Searches loaded messages only.');
    query.value = 'needle'; query.dispatchEvent(Object.assign(new Event('keydown', {cancelable: true}), {key: 'Enter', shiftKey: false, isComposing: false}));
    assert.equal(status.textContent, 'Match 1 of 2 in loaded messages.'); assert.equal(modal.openNow, true); assert.equal(focused, query);
    query.dispatchEvent(Object.assign(new Event('keydown'), {key: 'Enter', shiftKey: true, isComposing: false})); assert.match(status.textContent, /First loaded match/);
    query.dispatchEvent(Object.assign(new Event('keydown'), {key: 'Enter', isComposing: true})); assert.equal(steps.length, 2);
    query.value = 'none'; query.dispatchEvent(new Event('input')); assert.equal(resets, 1); row.children[1]?.dispatchEvent(new Event('click'));
    assert.equal(status.textContent, 'No loaded matches.'); assert.equal(captures, 1);
    modal.open('Appearance'); assert.equal(closed, 1); query.dispatchEvent(Object.assign(new Event('keydown'), {key: 'Enter'})); assert.equal(steps.length, 3);
    modal.close(); assert.equal(closed, 1);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (oldElement) Object.defineProperty(globalThis, 'HTMLElement', oldElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }
});
test('journal and HTTP copies of one handoff completion open its result once', () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: fakeDocument()});
  try {
    let opened = 0; const body = new FakeNode();
    const modal = {node: new FakeNode(), body, open() {opened++; return body;}, actions(...buttons: FakeNode[]) {body.append(...buttons);}} as unknown as ActionContext['modal'];
    const actions = new Actions(context({modal}));
    const result: OperationView = {...operation, kind: 'primary.handoff', receipt: {kind: 'rpc', result: {value: handoff, truncated: false}}};
    actions.handoffResult({...result, state: 'uncertain'}); assert.equal(opened, 0);
    actions.handoffResult(result); actions.handoffResult({...result}); assert.equal(opened, 1);
    assert.equal(body.children[0]?.textContent, handoff.command);
  } finally {if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');}
});

function handoffSetup(t: TestContext, overrides: Partial<ActionContext> = {}) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const nodes = new Map(['modal', 'modal-body', 'modal-close', 'modal-title', 'modal-error'].map(id => [id, new FakeNode()]));
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {...fakeDocument(), getElementById: (id: string) => nodes.get(id)}});
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: FakeNode});
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (oldElement) Object.defineProperty(globalThis, 'HTMLElement', oldElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  });
  const body = nodes.get('modal-body'); assert.ok(body);
  const descendants = (node: FakeNode): FakeNode[] => node.children.flatMap(child => [child, ...descendants(child)]);
  body.querySelectorAll = selector => descendants(body).filter(node => node.tagName === selector);
  const modal = new Modal(), actions = new Actions(context({...overrides, modal}));
  const result: OperationView = {...operation, kind: 'primary.handoff', receipt: {kind: 'rpc', result: {value: handoff, truncated: false}}};
  const find = (text: string) => {const node = descendants(body).find(node => node.tagName === 'button' && node.textContent === text); assert.ok(node, text); return node;};
  return {actions, modal, nodes, body, result, find};
}
test('handoff return explicitly opens the captured file once without a picker or another dialog', async t => {
  let selected = primary, reloads = 0;
  const setup = handoffSetup(t, {primary: () => selected, reload: async () => {reloads++;}});
  const admitted = Promise.withResolvers<void>(), reply = Promise.withResolvers<Response>(); const calls: {path: string; body: unknown}[] = [];
  globalThis.fetch = async (path, init) => {
    calls.push({path: String(path), body: JSON.parse(String(init?.body))});
    if (String(path) === '/api/operations') return Response.json({ok: true, data: {operationId: 'resume'}});
    assert.equal(String(path), '/api/primaries'); admitted.resolve(); return reply.promise;
  };
  const receipt = {...handoff}; setup.actions.handoffResult({...setup.result, receipt: {kind: 'rpc', result: {value: receipt, truncated: false}}});
  receipt.cwd = '/other-project'; receipt.sessionFile = '/other-project/other.jsonl';
  assert.equal(calls.length, 0); assert.equal(setup.modal.token, 1);
  assert.match(textOf(setup.body), /Exit Pi in the terminal before you resume here\. The browser does not detect other writers\./);
  assert.equal(setup.find('Resume here').className, 'main-action'); setup.find('Open session…');
  selected = {...primary, cwd: '/other-project', sessionFile: '/other-project/other.jsonl'};
  const resume = setup.find('Resume here'); resume.dispatchEvent(new Event('click')); resume.dispatchEvent(new Event('click')); await admitted.promise;
  assert.equal(resume.disabled, true); assert.equal(setup.modal.token, 1);
  assert.deepEqual(calls, [{path: '/api/operations', body: {kind: 'primary.open'}}, {path: '/api/primaries', body: {cwd: handoff.cwd, sessionFile: handoff.sessionFile}}]);
  reply.resolve(Response.json({ok: true, data: {primaryKey: 'resumed', operation: {...operation, kind: 'primary.open'}}}));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reloads, 1); assert.equal(setup.modal.openNow, false); assert.equal(setup.modal.token, 1);
});
for (const state of ['rejected', 'uncertain'] as const) test(`handoff return retains the command and controls after ${state} admission without replay`, async t => {
  let reloads = 0; const setup = handoffSetup(t, {reload: async () => {reloads++;}}); const calls: string[] = [];
  globalThis.fetch = async path => {
    calls.push(String(path));
    return Response.json({ok: true, data: String(path) === '/api/operations' ? {operationId: 'resume'} : {operation: {...operation, kind: 'primary.open', state, error: {code: state === 'rejected' ? 'operation_conflict' : 'delivery_uncertain', message: 'No confirmed return.', retry: 'manual'}}}});
  };
  setup.actions.handoffResult(setup.result); const resume = setup.find('Resume here'); resume.dispatchEvent(new Event('click'));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['/api/operations', '/api/primaries']); assert.equal(reloads, 0);
  assert.equal(setup.modal.openNow, true); assert.equal(setup.modal.token, 1); assert.equal(resume.disabled, false);
  assert.equal(setup.body.children[0]?.textContent, handoff.command); assert.match(textOf(setup.nodes.get('modal-error') as FakeNode), /No confirmed return/);
  setup.find('Open session…');
});
test('handoff results with invalid receipt paths retain the command and discovery without direct resume or effect', t => {
  const setup = handoffSetup(t); let calls = 0; globalThis.fetch = async () => {calls++; throw Error('No request expected');};
  const values = [{command: handoff.command}, {...handoff, cwd: 'relative'}, {...handoff, sessionFile: 'relative.jsonl'}, {...handoff, sessionFile: '/bad\u0000path'}, {...handoff, sessionFile: `/${'a'.repeat(4096)}`}];
  for (const [index, value] of values.entries()) {
    const result = {...setup.result, id: `handoff-${index}`, receipt: {kind: 'rpc' as const, result: {value, truncated: false}}};
    setup.actions.handoffResult(result);
    assert.equal(setup.modal.token, index + 1); assert.equal(setup.modal.openNow, true);
    assert.equal(setup.body.children[0]?.textContent, handoff.command); setup.find('Open session…');
    const buttons = setup.body.querySelectorAll('button');
    assert.ok(buttons.some(node => node.attributes.get('aria-label') === 'Copy command'));
    assert.equal(buttons.some(node => node.textContent === 'Resume here'), false); assert.equal(calls, 0);
    setup.actions.handoffResult(result); assert.equal(setup.modal.token, index + 1, 'duplicate receipt does not replace the dialog');
  }
  setup.actions.handoffResult({...setup.result, id: 'uncertain', state: 'uncertain'});
  assert.equal(setup.modal.token, values.length); assert.equal(calls, 0);
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
    const list = body.children[1]; assert.ok(list); assert.equal(list.children.some(node => textOf(node).startsWith('Insert /fixture')), false);
    selected = {...primary}; actions.warm(); await actions.load('commands');
    assert.equal(list.children.some(node => textOf(node).startsWith('Insert /fixture')), true);
  } finally {if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');}
});

test('text insertion without a ready Primary shows its prerequisite without changing drafts', () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: fakeDocument()});
  try {
    let opened = 0; let edits = 0; const body = new FakeNode();
    const modal = {body, open: () => body, actions: (...buttons: FakeNode[]) => body.append(...buttons)} as unknown as ActionContext['modal'];
    const actions = new Actions(context({primary: () => undefined, composer: {editor: {value: 'retained'}, setText: () => {edits++;}} as unknown as ActionContext['composer'], modal}));
    actions.projectPicker = () => {opened++;}; actions.prepareText('/fixture argument');
    assert.equal(opened, 0); assert.equal(edits, 0); assert.match(body.children[1]?.textContent ?? '', /fixture argument/);
    assert.match(body.children[0]?.textContent ?? '', /Select a session for Primary/);
    assert.ok(body.children.find(node => node.attributes.get('aria-label') === 'Copy command'));
    body.children.find(node => node.textContent === 'Sessions')?.dispatchEvent(new Event('click'));
    assert.equal(opened, 1); assert.equal(edits, 0);
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
  assert.deepEqual(options.items.find(item => item.name === 'model'), {name: 'model', description: 'Choose Primary model', source: 'app'});
  assert.equal(options.items.find(item => item.name === 'fixture')?.source, 'extension');
  assert.deepEqual(options.items.filter(item => item.source === 'app').map(item => item.name).sort(), ['compact', 'fork', 'model', 'new', 'resume', 'thinking']);
  assert.equal(notifications, 2); const first = options.items[0]; assert.ok(first); first.description = 'mutated'; assert.equal(actions.commandOptions().items[0]?.description, 'Choose Primary model');
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
    assert.equal(body.children[1]?.children.some(node => textOf(node).startsWith('Insert /later-command')), true);
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
    const more = body.children.find(node => node.textContent === 'More commands'); assert.ok(more); more.dispatchEvent(new Event('click')); await runs[0];
    assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT + 1); assert.equal(actions.commandOptions().incomplete, undefined);
    assert.equal(page.items.length, COMMAND_INVENTORY_PAGE_LIMIT + 1); assert.equal(page.nextCursor, null);
    assert.equal(await actions.load('commands'), page); assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT + 1);
  } finally { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document'); }
});
test('composer continuation deliberately extends the cached inventory without editing or dispatching', async () => {
  const paths: string[] = []; let changed = 0;
  const editor = {value: '/command query', selectionStart: 4, selectionEnd: 9, focused: true};
  const saved = {...editor};
  globalThis.fetch = async (path, init) => {
    assert.equal(init?.body, undefined); paths.push(String(path)); const page = paths.length;
    return commandResponse([`page-${page}`], page < COMMAND_INVENTORY_PAGE_LIMIT + 2 ? `cursor-${page}` : null);
  };
  const composer = {editor, commandsChanged() {changed++;}} as unknown as ActionContext['composer'];
  const actions = new Actions(context({composer, selection: async () => {assert.fail('continuation must not select');}, result: () => {assert.fail('continuation must not dispatch');}}));
  const page = await actions.load('commands'); const initialChanged = changed;
  assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT); actions.commandOptions(); actions.commandOptions();
  assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT);
  await actions.continueCommands({kind: 'primary', key: 'p', epoch: 1});
  assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT + 1); assert.equal(page.items.length, COMMAND_INVENTORY_PAGE_LIMIT + 1);
  assert.equal(actions.commandOptions().incomplete, true); assert.ok(changed > initialChanged);
  assert.equal(await actions.load('commands'), page); assert.deepEqual(editor, saved);
  await actions.continueCommands({kind: 'primary', key: 'p', epoch: 1});
  assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT + 2); assert.equal(actions.commandOptions().incomplete, undefined);
  await actions.continueCommands({kind: 'primary', key: 'p', epoch: 1});
  assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT + 2); assert.deepEqual(editor, saved);
});
test('simultaneous palette and composer continuation request and append one cursor only once', async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: fakeDocument()});
  try {
    const paths: string[] = []; const body = new FakeNode(); const runs: Promise<unknown>[] = [];
    const reached = deferred<void>(); const response = deferred<Response>();
    globalThis.fetch = async path => {
      paths.push(String(path)); const page = paths.length;
      if (page > COMMAND_INVENTORY_PAGE_LIMIT) {reached.resolve(); return response.promise;}
      return commandResponse([`page-${page}`], `cursor-${page}`);
    };
    const modal = {node: new FakeNode(), body, token: 1, open: () => body, owns: () => true, run: (action: () => Promise<unknown>) => {const run = action(); runs.push(run); return run;}} as unknown as ActionContext['modal'];
    const actions = new Actions(context({modal})); const page = await actions.load('commands');
    actions.palette(); await actions.load('commands'); await Promise.resolve();
    const more = body.children.find(node => node.textContent === 'More commands'); assert.ok(more);
    more.dispatchEvent(new Event('click')); await reached.promise;
    const composer = actions.continueCommands({kind: 'primary', key: 'p', epoch: 1}); await Promise.resolve();
    response.resolve(commandResponse(['shared-next'], null)); await Promise.all([runs[0], composer]);
    assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT + 1);
    assert.equal(page.items.filter(item => (item as {name: string}).name === 'shared-next').length, 1);
    assert.equal(actions.commandOptions().incomplete, undefined);
  } finally { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document'); }
});
test('failed composer continuation retries the same cursor without reloading confirmed pages', async () => {
  const paths: string[] = []; let failed = false;
  globalThis.fetch = async path => {
    paths.push(String(path)); const page = paths.length;
    if (page <= COMMAND_INVENTORY_PAGE_LIMIT) return commandResponse([`page-${page}`], `cursor-${page}`);
    if (!failed) {failed = true; throw new Error('continuation unavailable');}
    return commandResponse(['recovered'], null);
  };
  const actions = new Actions(context()); const page = await actions.load('commands');
  await assert.rejects(actions.continueCommands({kind: 'primary', key: 'p', epoch: 1}), /continuation unavailable/);
  assert.equal(page.items.length, COMMAND_INVENTORY_PAGE_LIMIT); assert.equal(actions.commandOptions().incomplete, true);
  await actions.continueCommands({kind: 'primary', key: 'p', epoch: 1});
  assert.equal(paths.length, COMMAND_INVENTORY_PAGE_LIMIT + 2); assert.equal(paths.at(-1), paths.at(-2));
  assert.equal(await actions.load('commands'), page); assert.equal(page.items.length, COMMAND_INVENTORY_PAGE_LIMIT + 1);
});
test('composer continuation refuses changed or unusable recipients before any request', async () => {
  let selected = {...primary}; let requests = 0; globalThis.fetch = async () => {requests++; return commandResponse([], null);};
  const actions = new Actions(context({primary: () => selected}));
  await assert.rejects(actions.continueCommands({kind: 'agent', identity: 'a'}), /conversation changed/);
  await assert.rejects(actions.continueCommands({kind: 'primary', key: 'other', epoch: 1}), /conversation changed/);
  await assert.rejects(actions.continueCommands({kind: 'primary', key: 'p', epoch: 2}), /conversation changed/);
  selected = {...primary, lifecycle: 'stopped'};
  await assert.rejects(actions.continueCommands({kind: 'primary', key: 'p', epoch: 1}), /conversation changed/);
  assert.equal(requests, 0);
});
test('composer continuation discards a late page after the captured epoch changes', async () => {
  let selected = {...primary}; let requests = 0; const reached = deferred<void>(); const response = deferred<Response>();
  globalThis.fetch = async () => {
    requests++; if (requests <= COMMAND_INVENTORY_PAGE_LIMIT) return commandResponse([`old-${requests}`], `cursor-${requests}`);
    reached.resolve(); return response.promise;
  };
  const actions = new Actions(context({primary: () => selected})); const page = await actions.load('commands');
  const continuation = actions.continueCommands({kind: 'primary', key: 'p', epoch: 1});
  const rejected = assert.rejects(continuation, /conversation changed/); await reached.promise; selected = {...primary, epoch: 2};
  response.resolve(commandResponse(['late-old'], 'must-not-fetch')); await rejected;
  assert.equal(requests, COMMAND_INVENTORY_PAGE_LIMIT + 1); assert.equal(page.items.length, COMMAND_INVENTORY_PAGE_LIMIT);
  assert.equal(actions.commandOptions().items.some(item => item.name.startsWith('old-') || item.name === 'late-old'), false);
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
  const document = fakeDocument(); Object.defineProperty(globalThis, 'document', {configurable: true, value: document});
  const body = new FakeNode(); const node = new FakeNode(); const error = new FakeNode(); error.id = 'modal-error'; node.append(body, error);
  let open = true; let token = 0; let closed: (() => void) | undefined;
  const modal = {node, body, get token() {return token;}, open: (_title: string, _cancel?: () => void, close?: () => void) => {open = true; token++; closed = close; body.replaceChildren(); return body;}, owns: (value: number) => open && value === token, close: () => {open = false; closed?.(); closed = undefined;}, run: async (action: () => Promise<unknown>) => {await action(); open = false; closed?.(); closed = undefined;}, error: () => {}} as unknown as ActionContext['modal'];
  globalThis.fetch = async () => commandResponse([], null);
  return {actions: new Actions(context({modal, ...overrides})), body, node, error, modal, view: document.defaultView, isOpen: () => open, restore: () => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  }};
}
function key(node: FakeNode, name: string, options: Record<string, unknown> = {}) {
  const event = new Event('keydown', {cancelable: true}); Object.assign(event, {key: name, ...options}); node.dispatchEvent(event); return event;
}
test('Message input opens the workspace preference without mutation and the native checkbox saves its value', async () => {
  for (const enabled of [undefined, false, true]) {
    const selections: unknown[] = [], workspace = {enterSendsMessages: enabled};
    const f = paletteFixture({snapshot: () => ({workspace} as Snapshot), selection: async value => {selections.push(value); workspace.enterSendsMessages = value.enterSendsMessages;}});
    try {
      const entries = f.actions.paletteEntries(), item = entries.find(row => row.name === 'Message input…'); assert.ok(item);
      assert.equal(entries.some(row => row.name === 'Enter sends messages'), false);
      assert.equal(rankPalette(entries, 'Enter sends messages')[0]?.item, item);
      for (const alias of ['newline', 'Shift+Enter', 'Ctrl+Enter', 'Command+Enter']) assert.equal(rankPalette(entries, alias)[0]?.item, item);
      item.run(); assert.deepEqual(selections, []); assert.match(textOf(f.body), /Applies to this workspace/);
      assert.match(textOf(f.body), /When off, Enter adds a new line.*Shift\+Enter adds a new line.*Command\+Enter sends/);
      const label = f.body.children.find(node => node.className === 'message-input-setting'), field = label?.children[0]; assert.ok(field);
      assert.equal(label?.tagName, 'label'); assert.equal(field.type, 'checkbox'); assert.equal(field.checked, enabled === true);
      field.checked = enabled !== true; field.dispatchEvent(new Event('change')); assert.equal(field.disabled, true);
      await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(selections, [{enterSendsMessages: enabled !== true}]); assert.equal(field.disabled, false);
    } finally {f.restore();}
  }
});
test('Message input retains the checkbox and reports a failed preference without a second mutation', async () => {
  let writes = 0; const failure = new Error('Preference unavailable'), errors: unknown[] = [];
  const f = paletteFixture({snapshot: () => ({workspace: {enterSendsMessages: false}} as Snapshot), selection: async () => {if (++writes === 1) throw failure;}});
  f.modal.error = error => {errors.push(error); const note = new FakeNode(); note.textContent = 'The preference was not saved.'; f.error.append(note);};
  try {
    f.actions.messageInput(); const field = f.body.children.find(node => node.className === 'message-input-setting')?.children[0]; assert.ok(field);
    field.checked = true; field.dispatchEvent(new Event('change')); field.dispatchEvent(new Event('change'));
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(writes, 1); assert.deepEqual(errors, [failure]); assert.equal(field.checked, false); assert.equal(field.disabled, false);
    assert.match(textOf(f.error), /not saved/); field.checked = true; field.dispatchEvent(new Event('change')); assert.equal(textOf(f.error), '');
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(writes, 2); assert.equal(field.checked, true); assert.equal(field.disabled, false); assert.equal(textOf(f.error), ''); assert.equal(f.body.children.find(node => node.className === 'message-input-setting')?.children[0], field);
    f.modal.open('Other'); field.dispatchEvent(new Event('change')); assert.equal(writes, 2);
  } finally {f.restore();}
});
test('agent presentation control defaults on and the quiet Commands choice saves its inverse',()=> {
  for(const value of [undefined,true,false]) {
    const selections:unknown[]=[];
    const actions=new Actions(context({snapshot:()=>({workspace:{agentControl:value}} as Snapshot),selection:async change=> {selections.push(change);}}));
    const choice=actions.paletteEntries().find(item=>item.name==='Agent presentation control');assert.ok(choice);assert.equal(choice.checked,value !== false);
    choice.run();assert.deepEqual(selections,[{agentControl:value === false}]);
  }
});
test('the palette lists the one sidebar action that applies and still finds it by either name', () => {
  const sidebarNames = (shown: boolean) => new Actions(context({sidebarShown: () => shown})).paletteEntries().filter(item => /sidebar$/.test(item.name)).map(item => item.name);
  assert.deepEqual(sidebarNames(true), ['Hide sidebar']); assert.deepEqual(sidebarNames(false), ['Show sidebar']);
  for (const [shown, name] of [[true, 'Hide sidebar'], [false, 'Show sidebar']] as const) {
    const sidebarCalls: boolean[] = []; const entries = new Actions(context({sidebarShown: () => shown, sidebar: visible => {sidebarCalls.push(visible);}})).paletteEntries();
    for (const query of ['show sidebar', 'hide sidebar', 'sidebar', 'hide', 'show']) assert.ok(rankPalette(entries, query).some(match => match.item.name === name), query);
    entries.find(item => item.name === name)?.run(); assert.deepEqual(sidebarCalls, [!shown]);
  }
});
test('palette covers every displaced control and session availability follows the menu', () => {
  const actions = new Actions(context());
  const names = actions.paletteEntries().filter(item => item.source === 'app').map(item => item.name);
  assert.deepEqual(names, ['New session', 'Sessions', 'Fork from message…', 'Compact…', 'Automatic retry…', 'Automatic compaction…', 'Continue in terminal…', 'Conversation details', 'Saved drafts and messages', 'Appearance', 'Message input…', 'Agent presentation control', 'Help', 'Expand loaded tools', 'Collapse loaded tools', 'Show thinking', 'Hide thinking', 'Find text', 'Notifications', 'Refresh agents', 'Insert /agent new', 'Hide sidebar', 'Projects', 'Model', 'Thinking', 'Sent and received tasks…']);
  const absent = new Actions(context({primary: () => undefined})).paletteEntries();
  const disabled = absent.filter(item => !item.enabled).map(item => item.name);
  assert.deepEqual(disabled, ['Fork from message…', 'Compact…', 'Automatic retry…', 'Automatic compaction…', 'Continue in terminal…', 'Conversation details', 'Expand loaded tools', 'Collapse loaded tools', 'Show thinking', 'Hide thinking', 'Find text', 'Model', 'Thinking', 'Sent and received tasks…']);
  const starting = new Actions(context({primary: () => ({...primary, lifecycle: 'starting'})})).paletteEntries();
  assert.equal(starting.find(item => item.name === 'New session')?.enabled, true);
  assert.equal(starting.find(item => item.name === 'Model')?.enabled, false);
  assert.equal(starting.find(item => item.name === 'Thinking')?.enabled, false);
});
test('transcript actions follow the focused view without enabling Primary execution', () => {
  const calls: string[] = []; let available = true;
  const actions = new Actions(context({primary: () => undefined, selectedAgent: () => ({identity: 'only-agent'}), hasTranscript: () => available,
    view: (tools, expanded) => {calls.push(`${tools ? 'tools' : 'thinking'}:${expanded}`);}}));
  actions.find = () => {calls.push('find');};
  const names = ['Expand loaded tools', 'Collapse loaded tools', 'Show thinking', 'Hide thinking', 'Find text'];
  for (const name of names) {const item = actions.paletteEntries().find(item => item.name === name); assert.ok(item); assert.equal(item.enabled, true); item.run();}
  assert.deepEqual(calls, ['tools:true', 'tools:false', 'thinking:true', 'thinking:false', 'find']);
  for (const name of ['Fork from message…', 'Compact…', 'Automatic retry…', 'Automatic compaction…', 'Continue in terminal…', 'Model', 'Thinking']) assert.equal(actions.paletteEntries().find(item => item.name === name)?.enabled, false);
  available = false; for (const name of names) assert.equal(actions.paletteEntries().find(item => item.name === name)?.enabled, false);
  const unrelatedPrimary = new Actions(context({hasTranscript: () => false}));
  for (const name of names) assert.equal(unrelatedPrimary.paletteEntries().find(item => item.name === name)?.enabled, false);
  assert.equal(unrelatedPrimary.paletteEntries().find(item => item.name === 'Compact…')?.enabled, true);
});
test('retry requires failure evidence while retained tasks stay reachable without live capability', () => {
  const actions = new Actions(context({primary: () => ({...primary, lastError: {code: 'failed', message: 'Failure', retry: 'manual'}}), selectedAgent: () => ({identity: 'agent-id'})}));
  assert.equal(actions.paletteEntries().some(item => item.name === 'Review message'), true);
  assert.equal(actions.paletteEntries().some(item => item.name === 'Copy agent ID'), true);
  assert.equal(actions.paletteEntries().some(item => item.name === 'Sent and received tasks…'), true);
  const inspect = new Actions(context({selectedAgent: () => ({identity: 'agent-id', capabilities: {history: true, observe: true, input: false, abort: false, configure: false, inspect: true}})}));
  assert.equal(inspect.paletteEntries().some(item => item.name === 'Sent and received tasks…'), true);
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
    assert.equal(line.className, 'palette-input-row'); assert.equal(line.children[0]?.children[0]?.attributes.get('class'), 'card-icon card-icon-search');
    const field = line.children[2]; assert.ok(field); field.value = 'xy'; field.dispatchEvent(new Event('input'));
    assert.deepEqual(list.children.map(row => textOf(row.children[0] as FakeNode)), ['xy', 'xy-long', 'tool:xy', 'zxyz', 'other']);
    assert.equal(list.attributes.get('role'), 'listbox'); assert.equal(list.children[0]?.attributes.get('aria-selected'), 'true');
    assert.equal(field.attributes.get('aria-activedescendant'), list.children[0]?.id);
    assert.deepEqual(list.children[0]?.children[0]?.children.map(node => node.tagName), ['mark', 'mark']);
    assert.deepEqual(list.children[0]?.children.map(node => node.className), ['palette-name', 'palette-desc']);
    assert.equal(list.children[0]?.attributes.get('role'), 'option');
    assert.equal(key(field, 'ArrowDown').defaultPrevented, true); assert.equal(focused, field);
    assert.equal(list.children[1]?.attributes.get('aria-selected'), 'true'); key(field, 'ArrowUp'); key(field, 'Enter');
    assert.equal(selected, 'exact'); assert.equal(f.isOpen(), false);
  } finally {f.restore();}
});
test('palette relevance orders empty queries but never outranks exact disabled search matches', () => {
  const entry = (name: string, priority: number, enabled = true): PaletteEntry => ({name, priority, enabled, description: '', source: 'app', run() {}});
  const entries = [entry('disabled', 0, false), entry('other', 2), entry('workspace', 1), entry('current', 0)];
  assert.deepEqual(rankPalette(entries, '').map(match => match.item.name), ['current', 'workspace', 'other', 'disabled']);
  const search = [entry('find', 0, false), entry('find Z', 0), entry('find A', 1), entry('find B', 0, false)];
  assert.deepEqual(rankPalette(search, 'find').map(match => match.item.name), ['find', 'find Z', 'find A', 'find B']);
  assert.equal(new Actions(context({primary: () => undefined, hasTranscript: () => true})).paletteEntries().find(item => item.name === 'Find text')?.priority, 0);
});
test('agent-selected palette keeps ready Primary actions available but puts their priority after current actions', async () => {
  globalThis.fetch = async () => commandResponse(['imported'], null);
  let compactions = 0; const actions = new Actions(context({selectedAgent: () => ({identity: 'selected'}), hasTranscript: () => true}));
  actions.compact = () => {compactions++;}; await actions.load('commands'); const entries = actions.paletteEntries();
  for (const name of ['Compact…', 'Fork from message…', 'Model', 'Thinking']) {const item = entries.find(entry => entry.name === name); assert.ok(item); assert.equal(item.enabled, true); assert.equal(item.priority, 2);}
  const imported = entries.find(item => item.name === 'Insert /imported'); assert.ok(imported); assert.equal(imported.priority, 2);
  assert.equal(entries.find(item => item.name === 'Message input…')?.priority, 1); assert.equal(entries.find(item => item.name === 'Sent and received tasks…')?.priority, 0);
  const ranked = rankPalette(entries, '').map(match => match.item.name); assert.ok(ranked.indexOf('Sent and received tasks…') < ranked.indexOf('Compact…'));
  entries.find(item => item.name === 'Compact…')?.run(); assert.equal(compactions, 1);
});
test('palette omits App badges while preserving unavailable reasons and meaningful sources', async () => {
  const f = paletteFixture(); try {
    const entries = [
      {name: 'Current', description: 'Current action', source: 'app', enabled: true, priority: 0, run() {}},
      {name: 'Model', description: 'Choose model', source: 'app', enabled: false, disabledReason: 'Requires a ready Primary', run() {}},
      {name: 'Extension', description: 'Extension action', source: 'extension', enabled: true, run() {}},
      {name: 'Agent name', description: 'Agent status', source: 'agent', enabled: true, run() {}},
    ];
    f.actions.paletteEntries = () => entries; f.actions.palette(); await f.actions.load('commands'); await Promise.resolve();
    const list = f.body.children[1]; assert.ok(list); const rows = list.children;
    const current = rows.find(row => textOf(row.children[0] as FakeNode) === 'Current'); assert.ok(current); assert.equal(current.children.some(node => node.className === 'palette-source'), false);
    const model = rows.find(row => textOf(row.children[0] as FakeNode) === 'Model'); assert.ok(model); assert.equal(model.disabled, true); assert.equal(model.title, 'Requires a ready Primary'); assert.equal(model.attributes.get('aria-description'), model.title); assert.match(model.attributes.get('aria-label') ?? '', /Requires a ready Primary/); assert.equal(model.children[1]?.textContent, model.title);
    for (const source of ['extension', 'agent']) assert.ok(rows.find(row => row.dataset.source === source)?.children.some(node => node.className === 'palette-source'));
    assert.equal(entries[0]?.source, 'app'); assert.equal(entries[1]?.description, 'Choose model');
  } finally {f.restore();}
});
test('palette keyboard selection scrolls only the nearest list edge and keeps input focus', () => {
  const f = paletteFixture(); try {
    f.actions.gotoEntries = () => Array.from({length: 5}, (_, index) => ({name: String(index), description: '', source: 'agent', enabled: true, run() {}}));
    f.actions.palette('goto'); const field = f.body.children[0]?.children[2]; const list = f.body.children[1]; assert.ok(field && list);
    f.node.clientHeight = 500; f.node.scrollHeight = 500;
    list.box = {top: 100, bottom: 172}; list.clientTop = 4; list.clientHeight = 64; list.offsetHeight = 72; list.scrollHeight = 160;
    list.children.forEach((row, index) => {row.getBoundingClientRect = () => ({top: 104 + index * 32 - list.scrollTop, bottom: 136 + index * 32 - list.scrollTop});});
    key(field, 'ArrowDown'); assert.equal(list.scrollTop, 0);
    key(field, 'ArrowDown'); assert.equal(list.scrollTop, 32); assert.equal(f.node.scrollTop, 0);
    assert.equal(list.children[2]?.getBoundingClientRect().bottom, 168); assert.equal(focused, field);
    assert.equal(field.attributes.get('aria-activedescendant'), list.children[2]?.id);
    key(field, 'ArrowUp'); assert.equal(list.scrollTop, 32);
    key(field, 'ArrowUp'); assert.equal(list.scrollTop, 0);
    for (let index = 0; index < 6; index++) key(field, 'ArrowDown');
    assert.equal(list.scrollTop, 96); assert.equal(list.children[4]?.getBoundingClientRect().bottom, 168);
  } finally {f.restore();}
});
test('palette height reserves actual input, footer, error and dialog border space with a one-row minimum', () => {
  const f = paletteFixture(); try {
    f.actions.palette('goto'); const list = f.body.children[1]; const observer = FakeResizeObserver.instances[0]; assert.ok(list && observer);
    assert.ok(observer.observed.has(f.body as unknown as Element)); assert.ok(observer.observed.has(f.error as unknown as Element));
    list.offsetHeight = 568; list.clientHeight = 560;
    f.node.offsetHeight = 630; f.node.clientHeight = 628; f.node.scrollHeight = 628;
    observer.fire(); assert.equal(list.properties.get('--palette-available-height'), '568px');
    const more = new FakeNode(); more.textContent = 'More commands'; f.body.append(more); f.node.scrollHeight += 44;
    observer.fire(); assert.equal(list.properties.get('--palette-available-height'), '524px');
    f.error.textContent = 'Resource request failed'; f.node.scrollHeight += 24;
    observer.fire(); assert.equal(list.properties.get('--palette-available-height'), '500px');
    list.offsetHeight = 488; list.clientHeight = 480; f.node.scrollHeight = 616; f.node.offsetHeight = 618; f.node.clientHeight = 616;
    const writes = list.styleWrites; observer.fire(); assert.equal(list.styleWrites, writes, 'rounded layout does not create a resize-write loop');
    f.view.limit = 500; f.node.offsetHeight = 500; f.node.clientHeight = 498; f.view.dispatchEvent(new Event('resize'));
    assert.equal(list.properties.get('--palette-available-height'), '370px');
    f.view.limit = 100;
    for (const size of [32, 44, 56]) {list.rowSize = size; observer.fire(); assert.equal(list.properties.get('--palette-available-height'), `${size + 8}px`);}
  } finally {f.restore();}
});
test('an overflowing palette dialog reveals the selected row after list-local adjustment', () => {
  const f = paletteFixture(); try {
    f.actions.gotoEntries = () => Array.from({length: 5}, (_, index) => ({name: String(index), description: '', source: 'agent', enabled: true, run() {}}));
    f.actions.palette('goto'); const field = f.body.children[0]?.children[2]; const list = f.body.children[1]; assert.ok(field && list);
    f.view.limit = 82; f.node.clientTop = 1; f.node.clientHeight = 80; f.node.offsetHeight = 82; f.node.scrollHeight = 180;
    list.clientTop = 4; list.clientHeight = 32; list.offsetHeight = 40; list.scrollHeight = 160;
    list.getBoundingClientRect = () => ({top: 100 - f.node.scrollTop, bottom: 140 - f.node.scrollTop});
    list.children.forEach((row, index) => {row.getBoundingClientRect = () => ({top: 104 + index * 32 - list.scrollTop - f.node.scrollTop, bottom: 136 + index * 32 - list.scrollTop - f.node.scrollTop});});
    FakeResizeObserver.instances[0]?.fire(); assert.equal(list.properties.get('--palette-available-height'), '40px');
    assert.equal(f.node.scrollTop, 55); assert.equal(list.children[0]?.getBoundingClientRect().bottom, 81);
    for (let index = 0; index < 4; index++) key(field, 'ArrowDown');
    assert.equal(list.scrollTop, 128); assert.equal(f.node.scrollTop, 55);
    assert.equal(list.children[4]?.getBoundingClientRect().top, 49); assert.equal(list.children[4]?.getBoundingClientRect().bottom, 81);
    assert.equal(focused, field);
  } finally {f.restore();}
});
test('palette geometry callbacks release observers on close and reject replacement tokens', () => {
  const f = paletteFixture(); try {
    f.actions.palette('goto'); const first = FakeResizeObserver.instances[0]; const oldList = f.body.children[1]; assert.ok(first && oldList);
    f.modal.close(); assert.equal(first.disconnected, true);
    const writes = oldList.styleWrites; f.view.limit = 200; f.view.dispatchEvent(new Event('resize')); first.fire(); assert.equal(oldList.styleWrites, writes);
    f.actions.palette('goto'); const second = FakeResizeObserver.instances[1]; const nextList = f.body.children[1]; assert.ok(second && nextList);
    f.modal.open('Another dialog'); f.view.limit = 100; const nextWrites = nextList.styleWrites;
    second.fire(); assert.equal(second.disconnected, true); assert.equal(nextList.styleWrites, nextWrites);
    f.view.dispatchEvent(new Event('resize')); assert.equal(nextList.styleWrites, nextWrites);
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
    assert.equal(list.children[0]?.children[2]?.textContent, 'Agent');
    assert.equal(list.children[0]?.title, agent.identity);
    assert.doesNotMatch(textOf(list.children[0] as FakeNode), /stored-identity|build-handle|\/project/);
    field.value = '/project'; field.dispatchEvent(new Event('input')); assert.equal(list.children.length, 1); assert.match(textOf(list.children[0] as FakeNode), /No .*results/); assert.notEqual(list.children[0]?.attributes.get('role'), 'option');
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
  const rows = actions.paletteEntries(); const aliases = [['new', 'New session'], ['resume', 'Sessions'], ['fork', 'Fork from message…'], ['compact', 'Compact…'], ['model', 'Model'], ['thinking', 'Thinking']] as const;
  for (const [alias, name] of aliases) {
    assert.equal(rows.filter(row => row.name === name).length, 1);
    assert.equal(rows.some(row => row.name === `/${alias}` && row.source === 'app'), false);
    for (const query of [alias, `/${alias}`]) assert.equal(rankPalette(rows, query)[0]?.item.name, name);
    assert.equal(inventory.items.some(item => item.name === alias && item.source === 'app'), true);
  }
  assert.equal(rows.some(row => row.name === 'Insert /fixture' && row.source === 'extension'), true);
  assert.deepEqual(rankPalette(rows, 'compact')[0]?.marks, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(actions.commandOptions(), inventory);
});
test('non-browser discovered commands retain palette rows even with a browser alias of the same name', async () => {
  globalThis.fetch = async () => Response.json({ok: true, data: {items: [{name: 'model', description: 'Public model command', source: 'extension'}], nextCursor: null, revision: '1'}});
  const actions = new Actions(context()); await actions.load('commands');
  assert.equal(actions.paletteEntries().some(item => item.name === 'Insert /model' && item.source === 'extension'), true);
  assert.equal(actions.paletteEntries().some(item => item.name === 'Model' && item.source === 'app'), true);
  assert.equal(actions.commandOptions().items.find(item => item.name === 'model')?.source, 'app');
});

test('an empty palette uses declared priorities without rewriting source data or alphabetic interleaving', () => {
  const entry = (name: string, source: string, priority = 2) => ({name, source, priority, description: '', enabled: true, run: () => {}});
  const items = [entry('Z agent', 'agent'), entry('/z-command', 'extension'), entry('Z action', 'app', 0), entry('/a-command', 'skill'), entry('A agent', 'agent'), entry('A action', 'app', 1)];
  for (const query of ['', '   ']) {
    const result = rankPalette(items, query);
    assert.deepEqual(result.map(match => match.item.name), ['Z action', 'A action', 'Z agent', '/z-command', '/a-command', 'A agent']);
    assert.equal(result.every(match => match.marks.length === 0), true);
  }
  assert.deepEqual(rankPalette(items, 'a').map(match => match.rank), rankCommands(items, 'a').map(match => match.rank));
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

test('duplicate agent names receive stable session qualifiers without identity tails', () => {
  const base = {storageId: 'store', cwd: '/project', modifiedAt: Date.now(), state: 'idle', owner: 'unknown' as const, availability: 'stored' as const, partial: false};
  const pairs = [
    ['Four', 'rootaaaa', 'rootbbbb'],
    ['Five', 'rootxaaaa', 'rootyaaaa'],
    ['Eight', 'rootxabcdefg', 'rootyabcdefg'],
    ['Full', 'firstzabcdefgh', 'secondzabcdefgh'],
    ['Conversation', 'store:conversation-a', 'store:conversation-b'],
  ] as const;
  const rows = pairs.flatMap(([name, first, second]) => [{...base, name, identity: first}, {...base, name, identity: second}]);
  rows.push({...base, name: 'Unique', identity: 'anotheraaaa'});
  const actions = new Actions(context({agents: () => rows})); const agents = actions.paletteEntries().filter(item => item.source === 'agent');
  for (const [index, [name, first, second]] of pairs.entries()) {
    assert.equal(agents.find(item => item.title === first)?.tail, String(index * 2 + 1)); assert.equal(agents.find(item => item.title === second)?.tail, String(index * 2 + 2));
    assert.equal(agents.find(item => item.title === first)?.name, name);
  }
  assert.equal(new Set(agents.filter(item => item.name === 'Full').map(item => item.tail)).size, 2);
  assert.deepEqual(rows.map(row => row.identity), [...pairs.flatMap(([, first, second]) => [first, second]), 'anotheraaaa']);
  assert.equal(agents.find(item => item.name === 'Unique')?.tail, undefined);
  const handles = new Actions(context({agents: () => [{...base, handle: 'builder', identity: 'first1111'}, {...base, handle: 'builder', identity: 'second2222'}]}));
  assert.deepEqual(handles.paletteEntries().filter(item => item.source === 'agent').map(item => item.tail), ['1', '2']);
});
test('unnamed palette and Go to agents share readable captions and exact routes', () => {
  const base = {storageId: 'store', cwd: '/project', modifiedAt: Date.now(), state: 'idle', owner: 'unknown' as const, availability: 'stored' as const, partial: false};
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const rows = ids.map(identity => ({...base, identity, name: identity})); let selected = '';
  const actions = new Actions(context({agents: () => rows, selectAgent: row => {selected = row.identity;}}));
  for (const entries of [actions.paletteEntries().filter(item => item.source === 'agent'), actions.gotoEntries().filter(item => item.source === 'agent')]) {
    assert.deepEqual(entries.map(item => item.name), ['Unnamed conversation', 'Unnamed conversation']); assert.deepEqual(entries.map(item => item.tail), ['1', '2']);
    assert.deepEqual(entries.map(item => item.title), ids); entries[1]?.run(); assert.equal(selected, ids[1]);
  }
  const first = rows[0]; assert.ok(first); const singleton = new Actions(context({agents: () => [first]})); assert.equal(singleton.gotoEntries().find(item => item.source === 'agent')?.tail, undefined);
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
      assert.equal(tail.className, 'palette-identity'); assert.equal(tail.tagName, 'span'); assert.equal(tail.textContent, index === 0 ? ' 1' : ' 2');
      assert.equal(name.children[0]?.className, 'palette-title'); assert.equal(name.children[0]?.children[0]?.tagName, 'mark');
    }
    key(field, 'ArrowDown'); assert.equal(list.children[1]?.attributes.get('aria-selected'), 'true');
    page.resolve(commandResponse([], null)); await f.actions.load('commands'); await Promise.resolve();
    assert.equal(list.children[1]?.attributes.get('aria-selected'), 'true'); assert.equal(list.children[1]?.title, 'store:conversation-b');
    field.value = 'conversation-b'; field.dispatchEvent(new Event('input')); assert.equal(list.children.length, 1); assert.equal(list.children[0]?.title, 'store:conversation-b');
    key(field, 'Enter'); assert.equal(selected, 'store:conversation-b');
  } finally {f.restore();}
});

test('session menus reuse palette availability and preserve primary-only actions', () => {
  const actions = new Actions(context({primary: () => undefined})); const palette = actions.paletteEntries();
  for (const item of actions.sessionMenuEntries()) {
    assert.equal(item.source, 'app'); assert.equal(item.enabled, palette.find(row => row.name === item.name)?.enabled);
  }
  assert.equal(actions.sessionMenuEntries().find(item => item.name === 'New session')?.enabled, true);
  assert.equal(actions.sessionMenuEntries().find(item => item.name === 'Sessions')?.enabled, true);
  assert.equal(actions.sessionMenuEntries().some(item => item.name === 'Refresh agents'), false);
  assert.equal(actions.sessionMenuEntries().some(item => item.name === 'Copy agent ID'), false);
  const selected = new Actions(context({selectedAgent: () => ({identity: 'selected-agent'})}));
  assert.equal(selected.sessionMenuEntries(true).some(item => item.name === 'Copy agent ID'), true);
  assert.equal(selected.sessionMenuEntries(true).some(item => item.name === 'Sent and received tasks…'), true);
  assert.equal(selected.sessionMenuEntries(true).some(item => item.name === 'New session'), false);
  const capable = new Actions(context({selectedAgent: () => ({identity: 'selected-agent', capabilities: {history: true, observe: true, input: true, abort: true, configure: false, inspect: true}})}));

  assert.equal(capable.sessionMenuEntries(true).some(item => item.name === 'Sent and received tasks…'), true);
});
test('session menu clicks dispatch named actions and disabled rows reject dispatch', () => {
  const f = paletteFixture(); try {
    let sessions = 0; let palettes = 0; f.actions.newSession = () => {sessions++;}; f.actions.palette = () => {palettes++;};
    f.actions.sessionMenu(); const list = f.body.children[0]; assert.ok(list);
    assert.equal(list.className, 'options session-menu');
    list.children.find(row => row.textContent === 'New session')?.dispatchEvent(new Event('click')); assert.equal(sessions, 1);
    list.children.find(row => row.textContent === 'Commands…')?.dispatchEvent(new Event('click')); assert.equal(palettes, 1);
  } finally {f.restore();}
  const unavailable = paletteFixture({primary: () => undefined}); try {
    let sessions = 0; unavailable.actions.newSession = () => {sessions++;}; unavailable.actions.sessionMenu();
    const row = unavailable.body.children[0]?.children.find(row => row.textContent === 'Compact…'); assert.ok(row);
    assert.equal(row.disabled, true); row.dispatchEvent(new Event('click')); assert.equal(sessions, 0);
  } finally {unavailable.restore();}
});

test('session menu keyboard navigation skips disabled rows and reaches the full palette', () => {
  const f = paletteFixture({primary: () => undefined}); try {
    f.actions.sessionMenu(); const list = f.body.children[0]; assert.ok(list);
    assert.equal(focused?.textContent, 'New session');
    assert.equal(key(list, 'ArrowDown').defaultPrevented, true); assert.equal(focused?.textContent, 'Sessions');
    key(list, 'ArrowDown'); assert.equal(focused?.textContent, 'Saved drafts and messages');
    key(list, 'End'); assert.equal(focused?.textContent, 'Commands…');
    key(list, 'Home'); assert.equal(focused?.textContent, 'New session');
  } finally {f.restore();}
});

const themes: [Appearance, string][] = [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']];
test('Appearance lists System, Dark and Light in order and checks the current workspace choice, reading retired values as the mode they looked like', () => {
  const read: Record<string, Appearance> = {dark: 'dark', light: 'light', system: 'system', latte: 'light', frappe: 'dark', macchiato: 'dark', mocha: 'dark'};
  for (const current of [...Object.keys(read), undefined]) {
    const f = paletteFixture({snapshot: () => current ? {workspace: {appearance: current}} as unknown as Snapshot : undefined}); try {
      f.actions.appearance(); const rows = f.body.children[0]; assert.ok(rows);
      assert.equal(rows.attributes.get('role'), 'menu'); assert.equal(rows.attributes.get('aria-label'), 'Appearance');
      assert.deepEqual(rows.children.map(row => textOf(row)), themes.map(([, label]) => label));
      for (const [index, [value]] of themes.entries()) {
        assert.equal(rows.children[index]?.attributes.get('role'), 'menuitemradio');
        assert.equal(rows.children[index]?.attributes.get('aria-checked'), String(value === (current ? read[current] : 'system')));
      }
      assert.equal(focused && textOf(focused), themes.find(([value]) => value === (current ? read[current] : 'system'))?.[1]);
    } finally {f.restore();}
  }
});
test('Appearance saves each exact theme value through the existing selection path', async () => {
  let current: Appearance = 'system'; const selected: Appearance[] = [];
  const f = paletteFixture({snapshot: () => ({workspace: {appearance: current}} as Snapshot), selection: async change => {assert.ok(change.appearance); selected.push(change.appearance); current = change.appearance;}}); try {
    for (const [index, [value]] of themes.entries()) {
      f.actions.appearance(); f.body.children[0]?.children[index]?.dispatchEvent(new Event('click')); await Promise.resolve();
      assert.equal(current, value); assert.equal(f.isOpen(), false);
      f.actions.appearance(); assert.equal(f.body.children[0]?.children[index]?.attributes.get('aria-checked'), 'true');
    }
    assert.deepEqual(selected, themes.map(([value]) => value));
  } finally {f.restore();}
});
test('Appearance keyboard navigation reaches the other choices without changing the choice', () => {
  const f = paletteFixture({snapshot: () => ({workspace: {appearance: 'dark'}} as Snapshot)}); try {
    f.actions.appearance(); const rows = f.body.children[0]; assert.ok(rows);
    key(rows, 'ArrowDown'); assert.equal(focused && textOf(focused), 'Light');
    key(rows, 'End'); assert.equal(focused && textOf(focused), 'Light');
    key(rows, 'Home'); assert.equal(focused && textOf(focused), 'System');
    assert.equal(rows.children[1]?.attributes.get('aria-checked'), 'true');
  } finally {f.restore();}
});
test('Appearance states from the page link whether the user stylesheet is applied', () => {
  for (const applied of [false, true]) {
    const f = paletteFixture(); const page = globalThis.document as unknown as {querySelector: (selector: string) => unknown};
    page.querySelector = selector => applied && selector === 'link[data-user-stylesheet]' ? {} : null;
    try {
      f.actions.appearance();
      assert.equal(textOf(f.body.children[1] as FakeNode), applied ? 'Your stylesheet is applied.' : 'Add your own stylesheet with ui.userStylesheet in harness.json.');
    } finally {f.restore();}
  }
});
test('theme names discover the single Appearance palette action', () => {
  const actions = new Actions(context()); const entries = actions.paletteEntries();
  const appearance = entries.find(item => item.name === 'Appearance'); assert.ok(appearance);
  assert.equal(appearance.description, 'Choose a theme'); assert.equal(appearance.enabled, true);
  assert.equal(entries.filter(item => item.name === 'Appearance').length, 1); assert.equal(entries.some(item => item.name.startsWith('Theme:')), false);
  for (const query of ['theme', 'css', 'stylesheet', ...themes.flat()]) {
    assert.ok(rankPalette(entries, query).some(match => match.item === appearance), query);
  }
  let opened = false; actions.appearance = () => {opened = true;}; appearance.run(); assert.equal(opened, true);
});

test('Goto lists only the primary and loaded agents and preserves identity-based selection', () => {
  const base = {storageId: 'store', cwd: '/project', modifiedAt: Date.now(), state: 'idle', owner: 'unknown' as const, availability: 'live' as const, partial: false};
  const rows = [{...base, identity: 'agent-first', name: 'Same name'}, {...base, identity: 'agent-second', name: 'Same name'}]; let selected = ''; let primaries = 0;
  const actions = new Actions(context({primary: () => ({...primary, sessionName: 'Primary project'}), agents: () => rows, selectAgent: row => {selected = row.identity;}, selectPrimary: () => {primaries++;}}));
  const entries = actions.gotoEntries(); assert.deepEqual(entries.map(row => row.source), ['primary', 'agent', 'agent']);
  assert.deepEqual(entries.filter(row => row.source === 'agent').map(row => row.tail), ['1', '2']);
  entries[0]?.run(); assert.equal(primaries, 1); entries[2]?.run(); assert.equal(selected, 'agent-second');
  assert.equal(new Actions(context({primary: () => undefined, agents: () => rows})).gotoEntries().some(row => row.source === 'primary'), false);
});
test('Goto uses the shared fuzzy palette and Enter selects without fetching commands', () => {
  let primaries = 0; let calls = 0;
  const f = paletteFixture({primary: () => ({...primary, sessionName: 'Primary project'}), selectPrimary: () => {primaries++;}}); try {
    globalThis.fetch = async () => {calls++; return commandResponse([], null);}; f.actions.palette('goto');
    assert.equal(f.node.dataset.variant, 'palette'); assert.equal(f.node.dataset.mode, 'goto');
    const field = f.body.children[0]?.children[2]; const list = f.body.children[1]; assert.ok(field); assert.ok(list);
    field.value = 'Pj'; field.dispatchEvent(new Event('input'));
    const name = list.children[0]?.children[0]; assert.ok(name); assert.equal(textOf(name), 'Primary project');
    assert.deepEqual(name.children[0]?.children.filter(node => node.tagName === 'mark').map(node => node.textContent), ['P', 'j']);
    assert.equal(key(field, 'Enter').defaultPrevented, true); assert.equal(primaries, 1); assert.equal(f.isOpen(), false); assert.equal(calls, 0);
  } finally {f.restore();}
});
test('the command palette highlights each fuzzy name character and keeps command rank order', () => {
  const f = paletteFixture(); try {
    f.actions.palette(); const field = f.body.children[0]?.children[2]; const list = f.body.children[1]; assert.ok(field); assert.ok(list);
    field.value = 'Nss'; field.dispatchEvent(new Event('input'));
    const row = list.children.find(row => textOf(row.children[0] ?? new FakeNode()) === 'New session'); const name = row?.children[0]; assert.ok(name);
    assert.deepEqual(name.children.filter(node => node.tagName === 'mark').map(node => node.textContent), ['N', 's', 's']);
    assert.deepEqual(list.children.map(row => textOf(row.children[0] ?? new FakeNode())), rankPalette(f.actions.paletteEntries(), 'Nss').map(match => match.item.name));
  } finally {f.restore();}
});

test('tab palette actions retain sessions and expose safe browser keyboard paths', () => {
  const calls: string[] = [];
  const actions = new Actions(context({tabs: {close: () => calls.push('close'), switch: direction => calls.push(String(direction)), layout: () => ({root: {kind: 'pane', id: 'pane-one', tabs: [{kind: 'primary'}], active: 'primary'}, focusedPane: 'pane-one'})}}));
  const entries = actions.paletteEntries();
  for (const label of ['Close conversation tab', 'Next conversation tab', 'Previous conversation tab']) { const entry = entries.find(item => item.name === label); assert.ok(entry); assert.equal(entry.enabled, true); entry.run(); }
  assert.equal(entries.some(item => item.name === 'Toggle split with Primary'), false);
  assert.deepEqual(calls, ['close', '1', '-1']);
});

test('target-choice Goto forwards the displayed Primary and exact agent without ordinary selection or command fetch', () => {
  const base = {storageId: 'store', cwd: '/project', modifiedAt: 0, state: 'idle', availability: 'stored' as const};
  const rows = [{...base, identity: 'agent-a', name: 'Same name'}, {...base, identity: 'agent-b', name: 'Same name'}];
  let current = primary; const chosen: Target[] = []; let requests = 0;
  const f = paletteFixture({primary: () => current, agents: () => rows, selectAgent: () => {throw new Error('Chooser must not select an ordinary agent');}, selectPrimary: () => {throw new Error('Chooser must not select ordinary Primary');}});
  try {
    globalThis.fetch = async () => {requests++; throw new Error('Chooser must not fetch commands or start a session');};
    const choose = (target: Target) => {assert.equal(f.isOpen(), false); chosen.push(target);};
    f.actions.palette('goto', choose); const list = f.body.children[1]; assert.ok(list);
    assert.deepEqual(list.children.map(row => row.title), ['primary:p:1', 'agent-a', 'agent-b']);
    const displayed = list.children[0]; assert.ok(displayed); current = {...primary, key: 'later', epoch: 9}; displayed.dispatchEvent(new Event('click'));
    assert.deepEqual(chosen, [{kind: 'primary', key: 'p', epoch: 1}]); displayed.dispatchEvent(new Event('click')); assert.equal(chosen.length, 1);
    f.actions.palette('goto', choose); const next = f.body.children[1]; assert.ok(next); const agent = next.children.find(row => row.title === 'agent-b'); assert.ok(agent); agent.dispatchEvent(new Event('click'));
    assert.deepEqual(chosen, [{kind: 'primary', key: 'p', epoch: 1}, {kind: 'agent', identity: 'agent-b'}]); assert.equal(requests, 0);
    f.actions.palette('goto', choose); f.modal.close(); assert.equal(chosen.length, 2);
  } finally {f.restore();}
});

test('target chooser omits missing identities and Primary while ordinary Commands keeps its selection path', () => {
  const base = {storageId: 'store', cwd: '/project', modifiedAt: 0, state: 'idle'};
  const rows: AgentRow[] = [{...base, identity: 'live', availability: 'live'}, {...base, identity: 'saved', availability: 'stored'}, {...base, identity: 'offline', availability: 'unavailable'}, {...base, identity: 'incompatible', availability: 'incompatible'}, {...base, identity: '', availability: 'stored', name: 'Missing identity'}];
  const chosen: Target[] = []; const actions = new Actions(context({primary: () => undefined, agents: () => rows, selectAgent: () => {throw new Error('Chooser must not select an ordinary agent');}}));
  const entries = actions.gotoEntries(target => chosen.push(target));
  assert.deepEqual(entries.map(item => item.title), ['live', 'saved', 'offline', 'incompatible']); assert.equal(entries.every(item => item.source === 'agent'), true);
  for (const entry of entries) entry.run(); assert.deepEqual(chosen, entries.map(item => ({kind: 'agent', identity: item.title})));
  const absent = new Actions(context({primary: () => ({...primary, key: ''}), agents: () => []})); assert.deepEqual(absent.gotoEntries(target => chosen.push(target)), []);
  const selected: string[] = []; const f = paletteFixture({agents: () => rows.slice(0, 1), selectAgent: row => selected.push(row.identity)});
  try {
    f.actions.palette('commands', () => {throw new Error('Commands must not use the target-choice callback');}); const list = f.body.children[1]; assert.ok(list);
    list.children.find(row => row.title === 'live')?.dispatchEvent(new Event('click')); assert.deepEqual(selected, ['live']);
  } finally {f.restore();}
});

test('finders label their purpose and separate duplicate identity from the ellipsized title', () => {
  const base = {storageId: 'store', cwd: '/project', modifiedAt: Date.now(), name: 'Review companion', state: 'idle', owner: 'unknown' as const, availability: 'stored' as const, partial: false};
  const f = paletteFixture({agents: () => [{...base, identity: 'first0033'}, {...base, identity: 'second0034'}]});
  try {
    f.actions.palette('goto'); const line = f.body.children[0]; const field = line?.children[2]; const list = f.body.children[1]; assert.ok(field && list);
    assert.equal(line?.className, 'palette-input-row'); assert.equal(field.className, 'palette-input'); assert.equal(field.placeholder, 'Search conversations');
    const row = list.children.find(row => row.title === 'second0034'); assert.ok(row);
    assert.equal(row.dataset.kind, 'conversation'); assert.equal(row.children[0]?.children[0]?.className, 'palette-title'); assert.equal(row.children[0]?.children[1]?.className, 'palette-identity');
    assert.match(row.attributes.get('aria-label') ?? '', /Review companion, 2/);
    field.value = 'nothingmatches'; field.dispatchEvent(new Event('input'));
    assert.match(textOf(list.children[0] as FakeNode), /No results for “nothingmatches”/); assert.equal(field.attributes.has('aria-activedescendant'), false);
    f.actions.palette(); assert.equal(f.body.children[0]?.children[2]?.placeholder, 'Search commands and agents');
  } finally { f.restore(); }
});
test('zero command matches keep incomplete inventory distinct from a complete empty match', async () => {
  const f = paletteFixture(); const page = deferred<Response>(); globalThis.fetch = async () => page.promise;
  try {
    f.actions.palette(); const field = f.body.children[0]?.children[2]; const list = f.body.children[1]; assert.ok(field && list);
    field.value = 'missing-query'; field.dispatchEvent(new Event('input')); assert.match(textOf(list.children[0] as FakeNode), /No results.*list is incomplete/);
    page.resolve(commandResponse([], null)); await f.actions.load('commands'); await Promise.resolve();
    assert.match(textOf(list.children[0] as FakeNode), /No results/); assert.doesNotMatch(textOf(list.children[0] as FakeNode), /incomplete/);
  } finally { f.restore(); }
});

test('conversation details keeps the captured agent and reported facts separate from Primary', () => {
  let selected = {identity: 'agent-first'}; const requested: string[] = [];
  const base = {storageId: 'store', cwd: '/project', modifiedAt: 0, state: 'unavailable', availability: 'live' as const, owner: 'unknown' as const, partial: false};
  const f = paletteFixture({selectedAgent: () => selected, agents: () => [{...base, identity: 'agent-first'}, {...base, identity: 'agent-second'}],
    agentStatus: () => 'Connected', conversationFacts: identity => { requested.push(identity); return [{key: 'task', label: 'Reported task', text: `task for ${identity}`}]; }});
  try {
    const entry = f.actions.sessionMenuEntries(true).find(item => item.name === 'Conversation details'); assert.ok(entry);
    selected = {identity: 'agent-second'}; entry.run();
    assert.deepEqual(requested, ['agent-first']); assert.match(textOf(f.body), /task for agent-first/); assert.doesNotMatch(textOf(f.body), /agent-second/);
    assert.match(f.actions.paletteEntries().find(item => item.source === 'agent')?.description ?? '', /^Connected/);
  } finally {f.restore();}
});
test('model names come from one read of the Primary model list for each Primary session', async () => {
  const reads: string[] = []; let changed = 0, current = primary;
  globalThis.fetch = async path => {
    reads.push(String(path));
    return Response.json({ok: true, data: {items: [{provider: 'vendor', id: 'model-a', name: 'Model A', reasoning: true, input: ['text']}, {provider: 'vendor', id: 'unnamed', name: '  ', reasoning: false, input: ['text']}], nextCursor: null, revision: 'r'}});
  };
  const actions = new Actions(context({primary: () => current, modelNamesChanged: () => {changed++;}}));
  assert.equal(actions.modelName('vendor', 'model-a'), undefined);
  actions.readModelNames(); actions.readModelNames(); actions.readModelNames();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(reads, ['/api/primaries/p/resources/models?limit=100']);
  assert.equal(actions.modelName('vendor', 'model-a'), 'Model A'); assert.equal(actions.modelName('vendor', 'unnamed'), undefined); assert.equal(actions.modelName('other', 'model-a'), 'Model A', 'another provider takes the one name the list gives that id');
  assert.equal(changed, 1);
  actions.readModelNames(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(reads.length, 1);
  current = {...primary, epoch: 2}; actions.readModelNames(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(reads.length, 2);
  assert.equal(changed, 1, 'an unchanged list does not repaint');
});
test('model names are read through the naming Primary when no Primary is selected', async () => {
  const reads: string[] = [];
  globalThis.fetch = async path => {reads.push(String(path)); return Response.json({ok: true, data: {items: [{provider: 'vendor', id: 'model-a', name: 'Model A', reasoning: true, input: ['text']}], nextCursor: null, revision: 'r'}});};
  const actions = new Actions(context({primary: () => undefined, namingPrimary: () => primary}));
  actions.readModelNames(); actions.readModelNames(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(reads, ['/api/primaries/p/resources/models?limit=100']); assert.equal(actions.modelName('vendor', 'model-a'), 'Model A');
});
test('model names are not read for a Primary that is not ready, and a failed read stays quiet', async () => {
  const reads: string[] = []; let current: PrimaryView = {...primary, lifecycle: 'starting'}, changed = 0;
  globalThis.fetch = async path => {reads.push(String(path)); return Response.json({ok: false, error: {code: 'unavailable', message: 'No models', retry: 'manual'}}, {status: 503});};
  const actions = new Actions(context({primary: () => current, modelNamesChanged: () => {changed++;}}));
  actions.readModelNames(); assert.deepEqual(reads, []);
  current = {...primary, lifecycle: 'ready'}; actions.readModelNames(); actions.readModelNames();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reads.length, 1); assert.equal(actions.modelName('vendor', 'model-a'), undefined); assert.equal(changed, 0);
});
test('model names follow the list pages once, stop at the page bound, and stop at a failed page', async () => {
  const reads: string[] = []; let failAt = Infinity;
  globalThis.fetch = async path => {
    reads.push(String(path)); const page = reads.length;
    if (page >= failAt) return Response.json({ok: false, error: {code: 'stale_revision', message: 'The resource cache changed.', retry: 'read'}}, {status: 409});
    return Response.json({ok: true, data: {items: [{provider: 'vendor', id: `model-${page}`, name: `Model ${page}`, reasoning: false, input: ['text']}], nextCursor: `cursor-${page}`, revision: 'r'}});
  };
  const first = new Actions(context());
  first.readModelNames(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads.length, MODEL_NAME_PAGE_LIMIT); assert.match(reads[1] ?? '', /cursor=cursor-1$/); assert.equal(first.modelName('vendor', `model-${MODEL_NAME_PAGE_LIMIT}`), `Model ${MODEL_NAME_PAGE_LIMIT}`);
  reads.length = 0; failAt = 3; const second = new Actions(context());
  second.readModelNames(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads.length, 3); assert.equal(second.modelName('vendor', 'model-2'), 'Model 2'); assert.equal(second.modelName('vendor', 'model-3'), undefined);
});
test('a model without an exact provider match takes the one name every provider gives its id', async () => {
  globalThis.fetch = async () => Response.json({ok: true, data: {items: [{provider: 'openai', id: 'gpt-6-astra', name: 'GPT-6 Astra', reasoning: true, input: ['text']}, {provider: 'vendor-a', id: 'shared', name: 'Shared A', reasoning: false, input: ['text']}, {provider: 'vendor-b', id: 'shared', name: 'Shared B', reasoning: false, input: ['text']}, {provider: 'vendor-c', id: 'same', name: 'Same', reasoning: false, input: ['text']}, {provider: 'vendor-d', id: 'same', name: 'Same', reasoning: false, input: ['text']}], nextCursor: null, revision: 'r'}});
  const actions = new Actions(context()); actions.readModelNames(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(actions.modelName('openai', 'gpt-6-astra'), 'GPT-6 Astra'); assert.equal(actions.modelName('openai-codex', 'gpt-6-astra'), 'GPT-6 Astra');
  assert.equal(actions.modelName('vendor-a', 'shared'), 'Shared A'); assert.equal(actions.modelName('vendor-b', 'shared'), 'Shared B');
  assert.equal(actions.modelName('other', 'shared'), undefined, 'different names for one id leave the id');
  assert.equal(actions.modelName('other', 'same'), 'Same', 'identical names for one id agree');
  assert.equal(actions.modelName('openai-codex', 'unlisted'), undefined);
});
test('the ready Primary names its own model without a list read and follows a model change', async () => {
  let current: PrimaryView = {...primary, model: {provider: 'openai-codex', id: 'gpt-6-astra', name: 'GPT-6 Astra', reasoning: true, input: ['text']}}, changed = 0;
  globalThis.fetch = async () => Response.json({ok: false, error: {code: 'unavailable', message: 'No models', retry: 'manual'}}, {status: 503});
  const actions = new Actions(context({primary: () => current, modelNamesChanged: () => {changed++;}}));
  assert.equal(actions.modelName('openai-codex', 'gpt-6-astra'), undefined);
  actions.readModelNames(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(actions.modelName('openai-codex', 'gpt-6-astra'), 'GPT-6 Astra'); assert.equal(changed, 1);
  actions.readModelNames(); assert.equal(changed, 1, 'an unchanged model repaints nothing');
  current = {...current, model: {provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', reasoning: true, input: ['text']}};
  actions.readModelNames(); assert.equal(actions.modelName('anthropic', 'claude-sonnet-5-5'), 'Claude Sonnet 5.5'); assert.equal(actions.modelName('openai-codex', 'gpt-6-astra'), 'GPT-6 Astra'); assert.equal(changed, 2);
  current = {...primary, lifecycle: 'starting', model: {provider: 'late', id: 'late-id', name: 'Late', reasoning: false, input: ['text']}};
  actions.readModelNames(); assert.equal(actions.modelName('late', 'late-id'), undefined, 'a Primary that is not ready teaches nothing');
});
test('a list name for the Primary model is not replaced by the name the Primary reports', async () => {
  const current: PrimaryView = {...primary, model: {provider: 'vendor', id: 'm', name: 'Reported', reasoning: false, input: ['text']}}; let changed = 0;
  globalThis.fetch = async () => Response.json({ok: true, data: {items: [{provider: 'vendor', id: 'm', name: 'Listed', reasoning: false, input: ['text']}], nextCursor: null, revision: 'r'}});
  const actions = new Actions(context({primary: () => current, modelNamesChanged: () => {changed++;}}));
  actions.readModelNames(); await new Promise(resolve => setTimeout(resolve, 0)); actions.readModelNames();
  assert.equal(actions.modelName('vendor', 'm'), 'Listed'); assert.equal(changed, 2);
});
