import assert from 'node:assert/strict';
import test from 'node:test';
import { Modal } from './modal.ts';
import { ProjectPicker } from './picker.ts';
import { contextMenu } from './context-menu.ts';
import type { Bootstrap } from '../shared/api.ts';
class FakeNode extends EventTarget {
  textContent = ''; open = false; isConnected = true; focused = false; disabled = false; buttons: FakeNode[] = [];
  children: FakeNode[] = []; className = '';
  readonly classList = {add: (name: string) => {this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' ');}};
  dataset: Record<string, string> = {}; properties = new Map<string, string>(); box = {left: 0, top: 0, right: 0, bottom: 0};
  style = {setProperty: (name: string, value: string) => { this.properties.set(name, value); }};
  getBoundingClientRect(): {left: number; top: number; right: number; bottom: number} {return this.box;}
  querySelectorAll(): FakeNode[] {return this.buttons;}
  append(...nodes: FakeNode[]): void {this.children.push(...nodes); this.textContent += nodes.map(node => node.textContent).join('');}
  prepend(...nodes: FakeNode[]): void {this.children.unshift(...nodes); this.textContent = nodes.map(node => node.textContent).join('') + this.textContent;}
  replaceChildren(...nodes: FakeNode[]): void {this.children = []; this.textContent = ''; this.append(...nodes);}
  setAttribute(name: string, value: string): void {this.properties.set(name, value); if (name === 'class') this.className = value;}
  querySelector(selector: string): FakeNode | undefined {return this.children.find(node => node.className.split(' ').includes(selector.slice(1)));}
  modal = false;
  showModal(): void {this.open = true; this.modal = true;}
  show(): void {this.open = true; this.modal = false;}
  close(): void {this.open = false; this.dispatchEvent(new Event('close'));}
  focus(): void {this.focused = true;}
}
function setup(): {restore: () => void; nodes: Map<string, FakeNode>} {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const nodes = new Map(['modal', 'modal-body', 'modal-close', 'modal-title', 'modal-error', 'primary-editor', 'invoke'].map(id => [id, new FakeNode()]));
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: FakeNode});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement() {return new FakeNode();}, createElementNS() {return new FakeNode();}, getElementById(id: string) {return nodes.get(id);}, activeElement: nodes.get('invoke')}});
  return {nodes, restore() {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else Reflect.deleteProperty(globalThis, 'document');
    if (elementDescriptor) Object.defineProperty(globalThis, 'HTMLElement', elementDescriptor); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }};
}
test('a delayed close event cannot cancel or restore focus over a replacement dialog', t => {
  const fake = setup();
  try {
    const dialog = fake.nodes.get('modal'); assert.ok(dialog);
    t.mock.method(dialog, 'close', () => {dialog.open = false;});
    const modal = new Modal(); let oldClosed = 0, newClosed = 0;
    modal.open('First', undefined, () => {oldClosed++;}); modal.close(false);
    assert.equal(oldClosed, 1); assert.equal(fake.nodes.get('invoke')?.focused, false);
    modal.open('Replacement', undefined, () => {newClosed++;});
    dialog.dispatchEvent(new Event('close'));
    assert.equal(modal.openNow, true); assert.equal(oldClosed, 1); assert.equal(newClosed, 0);
    assert.equal(fake.nodes.get('invoke')?.focused, false);
    modal.close(); assert.equal(newClosed, 1); assert.equal(fake.nodes.get('invoke')?.focused, true);
    const origin = fake.nodes.get('invoke'); assert.ok(origin); origin.focused = false; dialog.dispatchEvent(new Event('close'));
    assert.equal(newClosed, 1); assert.equal(fake.nodes.get('invoke')?.focused, false);
  } finally {fake.restore();}
});
test('dialog-to-project-menu closes only the old request and leaves popup focus and loading owned', async t => {
  const fake = setup(); const previousFetch = globalThis.fetch;
  try {
    const dialog = fake.nodes.get('modal'); assert.ok(dialog);
    t.mock.method(dialog, 'close', () => {dialog.open = false;});
    const popup = new FakeNode(); let open = false; const signals: AbortSignal[] = [];
    t.mock.method(contextMenu, 'open', () => {open = true; popup.focus();});
    t.mock.method(contextMenu, 'close', () => {open = false;});
    t.mock.method(contextMenu, 'owns', () => open);
    globalThis.fetch = async (_url, init) => {signals.push(init?.signal as AbortSignal); return new Promise<Response>(() => {});};
    const modal = new Modal(); const picker = new ProjectPicker({modal,
      snapshot: () => ({primaries: [], launchCwd: '/project'}) as unknown as Bootstrap,
      primary: () => undefined, selection: async () => {}, reload: async () => {}});
    picker.open('/project');
    const origin = fake.nodes.get('invoke'); assert.ok(origin);
    picker.openProject(origin as unknown as HTMLElement);
    assert.equal(signals.length, 2); assert.equal(signals[0]?.aborted, true); assert.equal(signals[1]?.aborted, false);
    assert.equal(popup.focused, true); assert.equal(origin.focused, false);
    dialog.dispatchEvent(new Event('close'));
    assert.equal(signals[1]?.aborted, false); assert.equal(origin.focused, false); assert.equal(open, true);
  } finally {globalThis.fetch = previousFetch; fake.restore();}
});
test('a close callback that opens another dialog keeps the new callback and focus owner', () => {
  const fake = setup();
  try {
    const modal = new Modal(); let nextClosed = 0;
    modal.open('First', undefined, () => {modal.open('Next', undefined, () => {nextClosed++;});});
    modal.close(); assert.equal(modal.openNow, true); assert.equal(nextClosed, 0);
    assert.equal(fake.nodes.get('invoke')?.focused, false);
    modal.close(); assert.equal(nextClosed, 1);
  } finally {fake.restore();}
});
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
test('a detached modal origin uses only the explicit current-focus hook', () => {
  const fake = setup();
  try {
    const current = new FakeNode(); const modal = new Modal(() => current.focus()); modal.open('Action');
    const origin = fake.nodes.get('invoke'); assert.ok(origin); origin.isConnected = false;
    fake.nodes.delete('primary-editor'); modal.close();
    assert.equal(origin.focused, false); assert.equal(current.focused, true);
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
test('a menu anchors under its trigger, closes on an outside click, and reverts on the next open', () => {
  const fake = setup(); const width = Object.getOwnPropertyDescriptor(globalThis, 'innerWidth');
  Object.defineProperty(globalThis, 'innerWidth', {configurable: true, value: 1440});
  try {
    const modal = new Modal(); const dialog = fake.nodes.get('modal'); const trigger = new FakeNode(); assert.ok(dialog);
    trigger.box = {left: 1180, top: 12, right: 1208, bottom: 40};
    modal.open('Session actions'); modal.anchor(trigger as unknown as HTMLElement);
    assert.equal(dialog.dataset.variant, 'menu'); assert.equal(dialog.properties.get('--menu-top'), '44px'); assert.equal(dialog.properties.get('--menu-right'), '232px');
    dialog.box = {left: 1000, top: 44, right: 1208, bottom: 300};
    const inside = Object.assign(new Event('click'), {clientX: 1100, clientY: 100}); dialog.dispatchEvent(inside); assert.equal(modal.openNow, true);
    const outside = Object.assign(new Event('click'), {clientX: 200, clientY: 500}); dialog.dispatchEvent(outside); assert.equal(modal.openNow, false);
    assert.equal(fake.nodes.get('invoke')?.focused, true);
    modal.open('Commands'); dialog.dataset.variant = 'palette';
    dialog.dispatchEvent(Object.assign(new Event('click'), {clientX: 200, clientY: 500})); assert.equal(modal.openNow, false, 'an outside click closes the palette');
    modal.open('Compact'); assert.equal(dialog.dataset.variant, undefined);
    dialog.dispatchEvent(Object.assign(new Event('click'), {clientX: 200, clientY: 500})); assert.equal(modal.openNow, true);
  } finally {
    if (width) Object.defineProperty(globalThis, 'innerWidth', width); else Reflect.deleteProperty(globalThis, 'innerWidth');
    fake.restore();
  }
});
test('Find uses a nonmodal dialog and replacement or Escape closes its session once', () => {
  const fake = setup();
  try {
    const modal = new Modal(); let closed = 0;
    modal.open('Find text', undefined, () => {closed++;}, 'find');
    assert.equal(fake.nodes.get('modal')?.dataset.variant, 'find'); assert.equal(fake.nodes.get('modal')?.modal, false);
    modal.open('Appearance'); assert.equal(closed, 1); assert.equal(fake.nodes.get('modal')?.dataset.variant, undefined); assert.equal(fake.nodes.get('modal')?.modal, true);
    modal.close(); assert.equal(closed, 1);
    modal.open('Find text', undefined, () => {closed++;}, 'find');
    const key = Object.assign(new Event('keydown', {cancelable: true}), {key: 'Escape', isComposing: false}); fake.nodes.get('modal')?.dispatchEvent(key);
    assert.equal(key.defaultPrevented, true); assert.equal(modal.openNow, false); assert.equal(closed, 2);
    assert.equal(fake.nodes.get('invoke')?.focused, true);
    modal.open('Find text', undefined, () => {closed++;}, 'find');
    fake.nodes.get('modal-close')?.dispatchEvent(new Event('click'));
    assert.equal(modal.openNow, false); assert.equal(closed, 3);
  } finally {fake.restore();}
});
test('modal failures disclose the exact cause and preserve caller summaries and confirmation actions', () => {
  const fake = setup();
  try {
    const modal = new Modal(); modal.open('Action'); modal.error(new Error('Exact host cause'));
    const error = fake.nodes.get('modal-error'); assert.ok(error);
    assert.equal(error.children[0]?.textContent, 'The action failed.');
    assert.equal(error.children[1]?.children[0]?.textContent, 'Details');
    assert.equal(error.children[1]?.children[1]?.textContent, 'Exact host cause');
    modal.error(new Error('Response cause'), 'Response not confirmed.');
    assert.equal(error.children[0]?.textContent, 'Response not confirmed.');
    assert.doesNotMatch(error.textContent, /Exact host cause/);
    modal.confirm('Delete copy', 'Copy only', async () => undefined);
    assert.equal(error.textContent, '');
    const body = fake.nodes.get('modal-body'); assert.ok(body);
    assert.deepEqual(body.children[1]?.children.map(node => node.textContent), ['Cancel', 'Confirm']);
  } finally {fake.restore();}
});
test('an async failure uses the caller summary and keeps the host cause in Details', async () => {
  const fake = setup();
  try {
    const modal = new Modal(); modal.open('Models');
    await modal.run(async () => {throw new Error('Host resource failed');}, false, 'Models could not be loaded.');
    const error = fake.nodes.get('modal-error'); assert.ok(error);
    assert.equal(error.children[0]?.textContent, 'Models could not be loaded.');
    assert.equal(error.children[1]?.children[1]?.textContent, 'Host resource failed');
    assert.equal(modal.openNow, true);
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
