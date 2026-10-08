import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { OperationView, PrimaryControl, PrimaryView } from '../shared/api.ts';
import { Actions } from './actions.ts';
import type { ActionContext } from './actions.ts';
const originalFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch = originalFetch;});
const primary: PrimaryView = {key: 'p', epoch: 1, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingDialogs: [], pendingOperationIds: [], capabilities: {control: true}};
const operation: OperationView = {id: 'op', kind: 'primary.control', state: 'completed', target: {kind: 'primary', key: 'p', epoch: 1}, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z'};
function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {snapshot: () => undefined, primary: () => primary, composer: {} as ActionContext['composer'], modal: {} as ActionContext['modal'], selection: async () => undefined, reload: async () => undefined, result: () => undefined, rosterRefresh: () => undefined, find: () => undefined, recovery: () => undefined, primaryEntries: () => [], ...overrides};
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
