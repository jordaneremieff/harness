import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationLayout } from '../shared/api.ts';
import { TabStrip } from './tabs-view.ts';
import { tabKey } from './tabs.ts';

class Node extends EventTarget {
  children: Node[] = []; parent?: Node; ownerDocument: Doc;
  className = ''; textContent = ''; title = ''; type = ''; tabIndex = 0; draggable = false; hidden = false; dataset: Record<string,string> = {};
  attributes = new Map<string, string>();
  clientWidth = 0; offsetWidth = 22; scrollWidth = 54;
  styleValues = new Map<string, string>();
  style = {setProperty: (name: string, value: string) => this.styleValues.set(name, value)};
  classes = new Set<string>();
  classList = {add: (...names: string[]) => {for (const name of names) this.classes.add(name);}, remove: (...names: string[]) => {for (const name of names) this.classes.delete(name);}};
  constructor(doc: Doc) { super(); this.ownerDocument = doc; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  append(...nodes: Node[]): void { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node: Node, next: Node | null): void { node.remove(); node.parent = this; this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, node); }
  remove(): void { if (this.parent) {const index = this.parent.children.indexOf(this); this.parent.children.splice(index, 1); this.parent = undefined;} }
  contains(node?: Node): boolean { return !!node && (node === this || this.children.some(child => child.contains(node))); }
  querySelector(selector: string): Node | null { return this.children.find(node => node.className === selector.slice(1)) ?? null; }
  focus(): void { this.ownerDocument.activeElement = this; }
}
class Doc { activeElement?: Node; createElement(): Node { return new Node(this); } }
class Observer {
  static instances: Observer[] = [];
  observed = new Set<unknown>();
  private callback: () => void;
  constructor(callback: () => void) { this.callback = callback; Observer.instances.push(this); }
  observe(node: unknown): void { this.observed.add(node); }
  unobserve(node: unknown): void { this.observed.delete(node); }
  resize(): void { this.callback(); }
}
Object.defineProperty(globalThis, 'ResizeObserver', {value: Observer, configurable: true});
Object.defineProperty(globalThis, 'getComputedStyle', {value: () => ({paddingLeft: '14px', paddingRight: '8px', columnGap: '8px', minWidth: '64px'}), configurable: true});
function fixture() {
  const doc = new Doc(); const root = new Node(doc);
  let layout: ConversationLayout = {tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'a', split: false}, {kind: 'agent', identity: 'b', split: true}], active: 0, splitRatio: 50};
  const changes: ConversationLayout[] = [];
  const strip = new TabStrip(root as unknown as HTMLElement, {layout: () => layout, label: tab => tabKey(tab), status: tab => tab.kind === 'agent' ? 'working' : '', change: value => {layout = value; changes.push(value); strip.render();}});
  strip.render();
  return {doc, root, strip, changes, layout: () => layout};
}
function event(node: Node | undefined, type: string, fields: Record<string, unknown> = {}): Event {
  assert.ok(node); const event = new Event(type, {cancelable: true});
  const {target, ...rest} = fields; Object.assign(event, rest);
  if (target) Object.defineProperty(event, 'target', {value: target});
  node.dispatchEvent(event); return event;
}
test('tab nodes retain focus, identity, labels and ARIA through repeated paint', () => {
  const {doc, root, strip} = fixture(); const primary = root.children[0]; assert.ok(primary);
  primary.focus(); strip.render(); assert.equal(root.children[0], primary); assert.equal(doc.activeElement, primary);
  assert.equal(primary.attributes.get('aria-selected'), 'true'); assert.equal(primary.attributes.get('role'), 'tab');
  assert.equal(primary.attributes.get('aria-controls'), 'conversation-panes'); assert.equal(root.children[1]?.tabIndex, -1);
  assert.equal(root.children[2]?.attributes.get('aria-label'), 'agent:b, split with primary, working');
  assert.equal(root.children[2]?.querySelector('.tab-state')?.textContent, 'working'); assert.equal(root.children[2]?.querySelector('.tab-state')?.dataset.state, 'working');
  assert.equal(primary.querySelector('.tab-state')?.hidden, true);
  assert.equal(primary.querySelector('.tab-close')?.attributes.get('aria-label'), 'Close primary tab');
});
test('a 760px workspace bounds a long tab share and drops status before each name minimum', () => {
  const doc = new Doc(); const root = new Node(doc); root.clientWidth = 620;
  const name = 'A very long inactive conversation title that must not starve other names';
  const layout: ConversationLayout = {tabs: [{kind: 'primary'}, {kind: 'agent', identity: 'a', split: false}, {kind: 'agent', identity: 'b', split: false}, {kind: 'agent', identity: 'long', split: false}], active: 1, splitRatio: 50};
  const strip = new TabStrip(root as unknown as HTMLElement, {layout: () => layout, label: tab => tab.kind === 'primary' ? 'Primary' : tab.identity === 'long' ? name : `Agent ${tab.identity}`, status: () => 'working', change() {}});
  strip.render();
  assert.equal(root.styleValues.get('--tab-share'), '155px');
  for (const node of root.children) node.clientWidth = 155;
  const observer = Observer.instances.at(-1); assert.ok(observer); observer.resize();
  for (const node of root.children) {
    assert.equal(node.querySelector('.tab-state')?.hidden, true, 'status loses space before the reserved eight-ch name width');
    assert.ok(node.querySelector('.tab-label')?.textContent);
    assert.match(node.attributes.get('aria-label') ?? '', /working/);
    assert.match(node.title, /working/);
  }
  assert.match(root.children[3]?.title ?? '', new RegExp(name));
  assert.equal(root.children[1]?.attributes.get('aria-selected'), 'true');
  root.clientWidth = 1060;
  for (const node of root.children) node.clientWidth = 230;
  observer.resize();
  assert.equal(root.styleValues.get('--tab-share'), '265px');
  for (const node of root.children) assert.equal(node.querySelector('.tab-state')?.hidden, false);
});
test('coarse close widths and short tabs retain captions while optional statuses collapse', () => {
  const {root, strip, changes} = fixture(); root.clientWidth = 300;
  for (const node of root.children) {node.clientWidth = 152; const close = node.querySelector('.tab-close'); assert.ok(close); close.offsetWidth = 44;}
  strip.render();
  assert.equal(root.children[0]?.querySelector('.tab-state')?.hidden, true);
  for (const node of root.children.slice(1)) {
    assert.equal(node.querySelector('.tab-state')?.hidden, true);
    assert.match(node.querySelector('.tab-label')?.textContent ?? '', /agent:/);
  }
  const removed = root.children[1]; assert.ok(removed); const observer = Observer.instances.at(-1); assert.ok(observer);
  event(removed.querySelector('.tab-close') ?? undefined, 'click');
  assert.equal(observer.observed.has(removed), false); assert.equal(changes.length, 1);
  assert.equal(root.styleValues.get('--tab-share'), '150px');
});
test('click focuses a tab and close or middle click removes only that tab', () => {
  const {root, layout, changes} = fixture();
  event(root.children[1], 'click'); assert.equal(layout().active, 1);
  event(root.children[1]?.querySelector('.tab-close') ?? undefined, 'click');
  assert.deepEqual(layout().tabs.map(tabKey), ['primary', 'agent:b']); assert.equal(layout().active, 1);
  const middle = event(root.children[1], 'auxclick', {button: 1}); assert.equal(middle.defaultPrevented, true);
  assert.deepEqual(layout().tabs.map(tabKey), ['primary']); assert.equal(changes.length, 3);
});
test('arrow and endpoint keys select, modifier reorder preserves active identity, and Delete closes', () => {
  const {root, doc, layout} = fixture();
  assert.equal(event(root.children[0], 'keydown', {key: 'ArrowRight'}).defaultPrevented, true);
  assert.equal(layout().active, 1); assert.equal(doc.activeElement, root.children[1]);
  event(root.children[1], 'keydown', {key: 'ArrowRight', altKey: true, shiftKey: true});
  assert.deepEqual(layout().tabs.map(tabKey), ['primary', 'agent:b', 'agent:a']); assert.equal(layout().active, 2);
  event(root.children[2], 'keydown', {key: 'Home'}); assert.equal(layout().active, 0);
  event(root.children[0], 'keydown', {key: 'End'}); assert.equal(layout().active, 2);
  event(root.children[2], 'keydown', {key: 'Delete'}); assert.equal(layout().tabs.length, 2); assert.equal(layout().active, 1);
  event(root.children[1], 'keydown', {key: 'Home', isComposing: true}); assert.equal(layout().active, 1);
});
test('close-button keys retain native activation without activating or reopening the parent tab', () => {
  for (const key of ['Enter', ' ']) {
    const {root, layout, changes} = fixture(); const row = root.children[1]; const close = row?.querySelector('.tab-close'); assert.ok(row); assert.ok(close);
    close.focus();
    const bubbled = event(row, 'keydown', {key, target: close});
    assert.equal(bubbled.defaultPrevented, false); assert.equal(changes.length, 0); assert.equal(layout().active, 0);
    // A native button dispatches click when its activation key is not canceled.
    event(close, 'click'); assert.equal(changes.length, 1); assert.deepEqual(layout().tabs.map(tabKey), ['primary', 'agent:b']);
    event(root.children[1], 'keydown', {key}); assert.equal(changes.length, 2); assert.equal(layout().active, 1);
  }
});
test('drag reorder accepts only an in-strip source and keeps the active conversation', () => {
  const {root, layout} = fixture(); const source = root.children[2]; const destination = root.children[0];
  assert.ok(source); assert.ok(destination);
  assert.equal(event(destination, 'dragover').defaultPrevented, false);
  event(source, 'dragstart'); assert.equal(source.classes.has('tab-dragging'), true);
  assert.equal(event(destination, 'dragover').defaultPrevented, true);
  event(destination, 'drop'); assert.deepEqual(layout().tabs.map(tabKey), ['agent:b', 'primary', 'agent:a']);
  assert.equal(layout().active, 1); assert.equal(source.classes.has('tab-dragging'), false); assert.equal(destination.classes.has('tab-drop-target'), false);
});
