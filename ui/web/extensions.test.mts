import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { DialogView, PrimaryView } from '../shared/api.ts';
import { enqueueDialog } from './dialog-state.ts';
import { ExtensionDialogs, extensionStatus } from './extensions.ts';
import type { Modal } from './modal.ts';
import { createState } from './state.ts';
const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => {globalThis.fetch = originalFetch; if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');});
const target = {kind: 'primary' as const, key: 'p', epoch: 1};
const primary: PrimaryView = {...target, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingDialogs: [], pendingOperationIds: [], capabilities: {}};
function gate<T>() {let resolve: (value: T) => void = () => undefined; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
class FakeNode extends EventTarget {
  children: FakeNode[] = []; className = ''; type = ''; disabled = false; open = false;
  readonly tag: string; private text = ''; attributes = new Map<string, string>();
  constructor(tag = 'div') {super(); this.tag = tag;}
  get childNodes(): FakeNode[] {return this.children;}
  get textContent(): string {return this.text + this.children.map(node => node.textContent).join('');}
  set textContent(value: string) {this.text = value; this.children = [];}
  set innerHTML(_value: string) {throw new Error('Unsafe HTML');}
  append(...nodes: FakeNode[]): void {this.children.push(...nodes);}
  prepend(...nodes: FakeNode[]): void {this.children.unshift(...nodes);}
  replaceChildren(...nodes: FakeNode[]): void {this.text = ''; this.children = nodes;}
  setAttribute(name: string, value: string): void {this.attributes.set(name, value);}
  focus(): void {}
  querySelectorAll(): FakeNode[] {return this.children.flatMap(node => [...(node.type === 'button' ? [node] : []), ...node.querySelectorAll()]);}
}
function fixture(dialog: DialogView) {
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => new FakeNode()}});
  let state = {...createState(), dialogs: enqueueDialog(createState().dialogs, target, dialog)};
  const closed = gate<void>(); const failed = gate<unknown>();
  const modal = {token: 0, openNow: false, body: new FakeNode(), cancelAction: undefined as (() => void) | undefined,
    open(_title?: string, cancel?: () => void) {this.token++; this.openNow = true; this.body = new FakeNode(); this.cancelAction = cancel; return this.body;},
    owns(token: number) {return this.openNow && token === this.token;},
    actions(...nodes: FakeNode[]) {this.body.append(...nodes);},
    close() {this.openNow = false; closed.resolve();}, error(error: unknown) {failed.resolve(error);},
  };
  const ui = new ExtensionDialogs(modal as unknown as Modal, () => state, value => {state = value;}, () => primary); ui.update();
  return {modal, ui, closed, failed, get state() {return state;}};
}
function response(data: unknown): Response {return {json: async () => ({ok: true, data})} as Response;}
const select: DialogView = {id: 'd', method: 'select', title: 'Pick', options: ['Safe label'], optionKeys: ['option:0']};
function statusFixture() {
  const root = new FakeNode();
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new FakeNode(tag), createElementNS: (_namespace: string, tag: string) => new FakeNode(tag), getElementById: (id: string) => {assert.equal(id, 'extension-status'); return root;}}});
  return root;
}
test('extension widgets use only the supplied target roots and leave another target untouched', () => {
  statusFixture(); const first = {above: new FakeNode(), below: new FakeNode()}, second = {above: new FakeNode(), below: new FakeNode()};
  const roots = (value: typeof first) => value as unknown as {above: HTMLElement; below: HTMLElement};
  extensionStatus({...primary, extension: {statuses: {}, widgets: {a: {lines: ['one', 'two', 'three', '<four>']}, b: {lines: ['below'], placement: 'belowEditor'}}}}, roots(first));
  assert.equal(first.above.children[0]?.textContent, 'one\ntwo\nthree'); assert.equal(first.above.children[1]?.children[1]?.textContent, 'one\ntwo\nthree\n<four>');
  assert.equal(first.below.textContent, 'below'); const retained = first.above.children[0];
  extensionStatus({...primary, epoch: 2, extension: {statuses: {}, widgets: {other: {lines: ['other target']}}}}, roots(second));
  assert.equal(first.above.children[0], retained); assert.equal(second.above.textContent, 'other target'); assert.equal(second.below.children.length, 0);
  extensionStatus(primary, roots(first)); assert.equal(first.above.children.length, 0); assert.equal(first.below.children.length, 0); assert.equal(second.above.textContent, 'other target');
  extensionStatus({...primary, extension: {statuses: {}, widgets: {closed: {lines: ['not mounted']}}}}); assert.equal(second.above.textContent, 'other target');
});
test('compact extension status counts hidden cells and native expansion retains every full keyed fact', () => {
  const root = statusFixture(); const statuses = {one: 'first', two: 'x'.repeat(60), three: '<script>inert</script>'};
  extensionStatus({...primary, extension: {statuses, widgets: {}}});
  const disclosure = root.children[0]; assert.ok(disclosure); assert.equal(disclosure.tag, 'details');
  const summary = disclosure.children[0]; const list = disclosure.children[1]; assert.ok(summary && list);
  // Expectations use the display labels while preserving source and action checks.
  assert.equal(summary.tag, 'summary'); assert.equal(summary.textContent, 'first · 2 more');
  assert.equal(summary.children[0]?.tag, 'svg'); assert.equal(summary.children[0]?.attributes.get('viewBox'), '0 0 16 16');
  assert.equal(summary.children[0]?.children[0]?.attributes.get('d'), 'M3 8h10 M8 3v10');
  assert.match(summary.attributes.get('aria-label') ?? '', /3 extension statuses\. Expand for details\./);
  assert.equal(list.children.length, 0);
  disclosure.open = true; disclosure.dispatchEvent(new Event('toggle'));
  assert.deepEqual(list.children.map(node => node.textContent), Object.entries(statuses).flat());
  extensionStatus({...primary, extension: {statuses, widgets: {}}});
  assert.equal(root.children[0], disclosure); assert.equal(disclosure.open, true); assert.equal(disclosure.children[0], summary);
  assert.equal(summary.children.filter(child => child.tag === 'svg').length, 1, 'Summary refresh retains exactly one shared SVG disclosure');
  extensionStatus({...primary, extension: {statuses: {...statuses, one: 'changed'}, widgets: {}}});
  assert.equal(root.children[0], disclosure); assert.equal(disclosure.open, true); assert.equal(list.children[1]?.textContent, 'changed');
});
test('Primary extension status does not replace the active conversation browser title', () => {
  statusFixture(); document.title = 'Pi · Selected agent';
  extensionStatus({...primary, extension: {title: 'Background Primary', statuses: {one: 'Useful fact'}, widgets: {}}});
  assert.equal(document.title, 'Pi · Selected agent');
});
test('dialog deadlines name the response deadline without replacing supplied content', () => {
  const deadline = '2030-01-01T00:00:00.000Z';
  const f = fixture({...select, deadline, message: 'Supplied message'});
  assert.match(f.modal.body.textContent, /Supplied message/);
  assert.ok(f.modal.body.textContent.includes(`Respond before ${new Date(deadline).toLocaleString()}.`));
  assert.doesNotMatch(f.modal.body.textContent, /Pi owns|Pi limits/);
});
test('one long Unicode status keeps its full text accessible without inventing another hidden cell', () => {
  const root = statusFixture(); const value = `\x1b[31m${'😀'.repeat(70)}\x1b[0m`;
  extensionStatus({...primary, extension: {statuses: {key: value, empty: ''}, widgets: {}}});
  const disclosure = root.children[0]; assert.ok(disclosure); const summary = disclosure.children[0]; assert.ok(summary);
  assert.equal(summary.textContent, `${'😀'.repeat(55)}…`); assert.doesNotMatch(summary.textContent, /\ufffd|\+1/);
  disclosure.open = true; disclosure.dispatchEvent(new Event('toggle'));
  assert.deepEqual(disclosure.children[1]?.children.map(node => node.textContent), ['key', '😀'.repeat(70)]);
  extensionStatus(primary); assert.equal(root.children.length, 0);
});
test('select displays a safe label but dispatches its exact opaque option key once', async () => {
  const f = fixture(select); const reserved = gate<Response>(); const calls: {path: string; body: unknown}[] = [];
  globalThis.fetch = async (path, init) => {
    calls.push({path: String(path), body: JSON.parse(String(init?.body))});
    if (String(path) === '/api/operations') return reserved.promise;
    return response({id: 'op', kind: 'primary.dialog', state: 'completed', target, createdAt: '', updatedAt: ''});
  };
  const choice = f.modal.body.querySelectorAll().find(node => node.textContent === 'Safe label'); assert.ok(choice);
  choice.dispatchEvent(new Event('click')); choice.dispatchEvent(new Event('click'));
  assert.equal(calls.length, 1); reserved.resolve(response({operationId: 'op'})); await f.closed.promise;
  assert.equal(calls.length, 2); assert.deepEqual(calls[1]?.body, {epoch: 1, value: 'option:0'});
});
test('failed reservation leaves the protocol request pending and permits explicit retry', async () => {
  const f = fixture(select); let calls = 0;
  globalThis.fetch = async () => {calls++; throw new Error('reservation unavailable');};
  const choice = f.modal.body.querySelectorAll().find(node => node.textContent === 'Safe label'); assert.ok(choice);
  choice.dispatchEvent(new Event('click')); await f.failed.promise;
  assert.equal(choice.disabled, false); assert.equal(calls, 1);
  assert.equal([...f.state.dialogs.items.values()][0]?.status, 'pending');
});
test('Escape closes an uncertain response without another native response', async () => {
  const f = fixture(select); let calls = 0;
  globalThis.fetch = async () => {calls++; if (calls === 1) return response({operationId: 'op'}); throw new Error('response not confirmed');};
  const choice = f.modal.body.querySelectorAll().find(node => node.textContent === 'Safe label'); assert.ok(choice);
  choice.dispatchEvent(new Event('click')); await f.failed.promise;
  assert.equal([...f.state.dialogs.items.values()][0]?.status, 'responded'); f.modal.cancelAction?.(); await f.closed.promise;
  assert.equal(calls, 2); assert.equal(f.modal.openNow, false); f.ui.update(); assert.equal(f.modal.openNow, false);
});
test('an expired old request never closes a replacement modal', () => {
  const f = fixture(select); f.modal.open();
  f.state.dialogs.items.clear(); f.ui.update();
  assert.equal(f.modal.openNow, true);
});
