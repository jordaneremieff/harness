import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {ContextMenu, menuPosition, nativeEditingTarget} from './context-menu.ts';

type Handler = (event: Record<string, unknown>) => void;
class Node {
  children: Node[] = []; parent?: Node; className = ''; textContent = ''; type = ''; tabIndex = 0;
  attrs = new Map<string, string>(); style: Record<string, string> = {}; tag: string;
  handlers = new Map<string, Handler[]>(); ownerDocument: Doc; scrolled = false;
  constructor(doc: Doc, tag = 'div') { this.ownerDocument = doc; this.tag = tag; }
  get isConnected(): boolean { return this === this.ownerDocument.body || !!this.parent?.isConnected; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  append(...nodes: Node[]): void { for (const node of nodes) {node.remove(); node.parent = this; this.children.push(node);} }
  remove(): void { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; }
  contains(node?: Node): boolean { return !!node && (this === node || this.children.some(child => child.contains(node))); }
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  fire(name: string, extra: Record<string, unknown> = {}) {
    const event = {target: this, defaultPrevented: false, stopped: false, preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.stopped = true;}, ...extra};
    for (const handler of this.handlers.get(name) ?? []) handler(event); return event;
  }
  click(): void { this.fire('click'); }
  focus(): void { this.ownerDocument.activeElement = this; }
  scrollIntoView(): void { this.scrolled = true; }
  getBoundingClientRect() { return {width: 260, height: 96}; }
  closest(): Node | null { return ['input', 'textarea', 'select', 'editable'].includes(this.tag) ? this : this.parent?.closest() ?? null; }
}
class Events {
  handlers = new Map<string, Handler[]>();
  addEventListener(name: string, handler: Handler): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  removeEventListener(name: string, handler: Handler): void { this.handlers.set(name, (this.handlers.get(name) ?? []).filter(item => item !== handler)); }
  fire(name: string, target?: Node): void { for (const handler of [...this.handlers.get(name) ?? []]) handler({target}); }
}
class Doc extends Events {
  body = new Node(this); activeElement?: Node; announcements = new Node(this);
  defaultView = Object.assign(new Events(), {innerWidth: 320, innerHeight: 240});
  createElement(tag: string): Node { return new Node(this, tag); }
  getElementById(): Node { return this.announcements; }
}
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document'); });
function fixture() {
  const doc = new Doc(); Object.defineProperty(globalThis, 'document', {configurable: true, value: doc});
  const origin = new Node(doc); doc.body.append(origin); origin.focus();
  const controller = new ContextMenu(); const runs: string[] = []; let valid = true;
  controller.open(origin as unknown as HTMLElement, {x: 315, y: 235}, 'Tab actions', [
    {label: 'Activate', run: () => runs.push('activate')}, {label: 'Close', enabled: false, run: () => runs.push('close')}, {label: 'Close others', run: () => runs.push('others')},
  ], () => valid);
  const menu = doc.body.children.at(-1); assert.ok(menu);
  const key = (key: string, extra: Record<string, unknown> = {}) => menu.fire('keydown', {key, ...extra});
  return {doc, origin, controller, runs, menu, key, invalidate: () => {valid = false;}};
}
test('menu focus, ARIA, arrow wrapping and endpoints include disabled items without activating them', () => {
  const f = fixture(); assert.equal(f.menu.attrs.get('role'), 'menu'); assert.equal(f.menu.attrs.get('aria-label'), 'Tab actions');
  assert.equal(f.doc.activeElement, f.menu.children[0]); assert.ok(f.menu.children.every(node => node.attrs.get('role') === 'menuitem' && node.tabIndex === -1));
  assert.equal(f.menu.children[1]?.attrs.get('aria-disabled'), 'true');
  const down = f.key('ArrowDown'); assert.equal(down.defaultPrevented, true); assert.equal(down.stopped, true);
  assert.equal(f.doc.activeElement, f.menu.children[1]); f.key('Enter'); assert.deepEqual(f.runs, []); assert.equal(f.controller.openNow, true);
  f.key('End'); assert.equal(f.doc.activeElement, f.menu.children[2]); f.key('ArrowDown'); assert.equal(f.doc.activeElement, f.menu.children[0]);
  f.key('ArrowUp'); assert.equal(f.doc.activeElement, f.menu.children[2]); f.key('Home'); assert.equal(f.doc.activeElement, f.menu.children[0]);
  f.key(' ', {repeat: true}); assert.deepEqual(f.runs, []); f.key(' '); assert.deepEqual(f.runs, ['activate']); assert.equal(f.controller.openNow, false); assert.equal(f.doc.activeElement, f.origin);
});
test('Escape, outside dismissal, viewport changes and focus departure release listeners and restore context', () => {
  for (const dismiss of ['escape', 'outside', 'resize', 'blur', 'focus']) {
    const f = fixture();
    if (dismiss === 'escape') f.key('Escape');
    else if (dismiss === 'outside') f.doc.fire('pointerdown', f.origin);
    else if (dismiss === 'focus') {const other = new Node(f.doc); f.doc.body.append(other); other.focus(); f.doc.fire('focusin', other); assert.equal(f.doc.activeElement, other);}
    else f.doc.defaultView.fire(dismiss);
    assert.equal(f.controller.openNow, false); assert.equal(f.menu.isConnected, false);
    if (dismiss !== 'focus') assert.equal(f.doc.activeElement, f.origin);
    assert.ok([...f.doc.handlers.values(), ...f.doc.defaultView.handlers.values()].every(list => list.length === 0));
  }
});
test('an action never dispatches after its captured target changes', () => {
  const f = fixture(); f.invalidate(); f.key('End'); f.key('Enter');
  assert.deepEqual(f.runs, []); assert.equal(f.controller.openNow, false); assert.match(f.doc.announcements.textContent, /target changed/);
});
test('menus clamp to both viewport edges and retain a scrollable size in very narrow viewports', () => {
  assert.deepEqual(menuPosition({x: 315, y: 235}, {width: 260, height: 96}, {width: 320, height: 240}), {x: 56, y: 140});
  assert.deepEqual(menuPosition({x: -20, y: -20}, {width: 100, height: 100}, {width: 320, height: 240}), {x: 4, y: 4});
  const f = fixture(); assert.equal(f.menu.style.left, '56px'); assert.equal(f.menu.style.top, '140px');
  assert.equal(f.menu.style.maxWidth, '312px'); assert.equal(f.menu.style.maxHeight, '232px'); f.controller.close();
  f.doc.defaultView.innerWidth = 180; f.doc.defaultView.innerHeight = 80;
  f.controller.open(f.origin as unknown as HTMLElement, {x: 180, y: 80}, 'Actions', [{label: 'A', run() {}}]);
  const narrow = f.doc.body.children.at(-1); assert.equal(narrow?.style.maxWidth, '172px'); assert.equal(narrow?.style.maxHeight, '72px'); assert.equal(narrow?.style.left, '4px');
  f.controller.close();
});
test('text inputs and editable descendants retain native editing menus', () => {
  const doc = new Doc();
  for (const tag of ['input', 'textarea', 'select', 'editable']) {const editor = new Node(doc, tag); const child = new Node(doc); editor.append(child); assert.equal(nativeEditingTarget(child as unknown as EventTarget), true);}
  assert.equal(nativeEditingTarget(new Node(doc) as unknown as EventTarget), false); assert.equal(nativeEditingTarget(null), false);
});
