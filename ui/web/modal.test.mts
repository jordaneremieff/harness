import assert from 'node:assert/strict';
import test from 'node:test';
import { Modal } from './modal.ts';
class FakeNode extends EventTarget {
  textContent = ''; open = false; isConnected = true; focused = false; disabled = false; buttons: FakeNode[] = [];
  querySelectorAll(): FakeNode[] {return this.buttons;}
  replaceChildren(): void {this.textContent = '';}
  showModal(): void {this.open = true;}
  close(): void {this.open = false; this.dispatchEvent(new Event('close'));}
  focus(): void {this.focused = true;}
}
function setup(): {restore: () => void; nodes: Map<string, FakeNode>} {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const nodes = new Map(['modal', 'modal-body', 'modal-close', 'modal-title', 'modal-error', 'primary-editor', 'invoke'].map(id => [id, new FakeNode()]));
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: FakeNode});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {getElementById(id: string) {return nodes.get(id);}, activeElement: nodes.get('invoke')}});
  return {nodes, restore() {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else Reflect.deleteProperty(globalThis, 'document');
    if (elementDescriptor) Object.defineProperty(globalThis, 'HTMLElement', elementDescriptor); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }};
}
test('an old async action never closes a replacement dialog', async () => {
  const fake = setup();
  try {
    const modal = new Modal(); modal.open('First');
    let finish: () => void = () => undefined;
    const action = modal.run(() => new Promise<void>(resolve => {finish = resolve;}));
    modal.open('Permission request'); finish(); await action;
    assert.equal(modal.openNow, true); assert.equal(fake.nodes.get('modal-title')?.textContent, 'Permission request');
  } finally {fake.restore();}
});
test('an async action closes only its own unchanged dialog and restores focus', async () => {
  const fake = setup();
  try {
    const modal = new Modal(); modal.open('Action'); await modal.run(async () => undefined);
    assert.equal(modal.openNow, false); assert.equal(fake.nodes.get('invoke')?.focused, true);
  } finally {fake.restore();}
});
test('a pending action blocks duplicate dispatch and preserves disabled controls', async () => {
  const fake = setup();
  try {
    const modal = new Modal(); modal.open('Open session'); const enabled = new FakeNode(); const disabled = new FakeNode(); disabled.disabled = true;
    const body = fake.nodes.get('modal-body'); assert.ok(body); body.buttons = [enabled, disabled];
    let finish: () => void = () => undefined; let calls = 0;
    const pending = modal.run(() => {calls++; return new Promise<void>(done => {finish = done;});}, false);
    await modal.run(async () => {calls++;}, false);
    assert.equal(calls, 1); assert.equal(enabled.disabled, true); assert.equal(fake.nodes.get('modal-close')?.disabled, false);
    finish(); await pending; assert.equal(enabled.disabled, false); assert.equal(disabled.disabled, true);
  } finally {fake.restore();}
});
test('Escape invokes protocol cancellation rather than untracked dismissal', () => {
  const fake = setup();
  try {
    const modal = new Modal(); let cancels = 0; modal.open('Request', () => {cancels++;});
    const event = new Event('cancel', {cancelable: true}); fake.nodes.get('modal')?.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true); assert.equal(cancels, 1); assert.equal(modal.openNow, true);
  } finally {fake.restore();}
});
test('stale errors do not overwrite a replacement dialog', async () => {
  const fake = setup();
  try {
    const modal = new Modal(); modal.open('First'); let reject: (error: Error) => void = () => undefined;
    const action = modal.run(() => new Promise((_, fail) => {reject = fail;}));
    modal.open('Next'); reject(new Error('Old failure')); await action;
    assert.equal(fake.nodes.get('modal-error')?.textContent, '');
  } finally {fake.restore();}
});
