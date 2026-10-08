import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { DialogView, PrimaryView } from '../shared/api.ts';
import { enqueueDialog } from './dialog-state.ts';
import { ExtensionDialogs } from './extensions.ts';
import type { Modal } from './modal.ts';
import { createState } from './state.ts';
const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => {globalThis.fetch = originalFetch; if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');});
const target = {kind: 'primary' as const, key: 'p', epoch: 1};
const primary: PrimaryView = {...target, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingDialogs: [], pendingOperationIds: [], capabilities: {}};
function gate<T>() {let resolve: (value: T) => void = () => undefined; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
class FakeNode extends EventTarget {
  children: FakeNode[] = []; className = ''; textContent = ''; type = ''; disabled = false;
  append(...nodes: FakeNode[]): void {this.children.push(...nodes);}
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
