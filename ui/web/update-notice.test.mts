import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { UiIdentity } from '../shared/version.ts';
import { UpdateNotice } from './update-notice.ts';
import { UPDATE_KEY } from './update-record.ts';

class Node {
  tag = ''; className = ''; hidden = false; title = ''; type = ''; children: Node[] = []; parent?: Node; attributes = new Map<string, string>();
  private text = ''; private listeners = new Map<string, (() => void)[]>();
  constructor(tag = 'div') {this.tag = tag;}
  get textContent(): string {return this.text + this.children.map(child => child.textContent).join('');}
  set textContent(value: string) {this.text = value; this.children = [];}
  append(...nodes: Node[]) {for (const node of nodes) {node.parent = this; this.children.push(node);}}
  replaceChildren(...nodes: Node[]) {this.text = ''; this.children = []; this.append(...nodes);}
  setAttribute(name: string, value: string) {this.attributes.set(name, value);}
  addEventListener(name: string, listener: () => void) {this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]);}
  click() {for (const listener of this.listeners.get('click') ?? []) listener();}
  before(node: Node) {const parent = this.parent; assert.ok(parent); node.parent = parent; parent.children.splice(parent.children.indexOf(this), 0, node);}
  find(label: string): Node | undefined {return this.children.find(child => child.textContent === label);}
}
const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => {if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');});
const id = (digit: string) => digit.repeat(40);
const identity = (commit: string, recent?: {commit: string; subject: string}[]): UiIdentity => ({iteration: '1.10', git: {commit, shortCommit: commit.slice(0, 8), branch: 'main', modified: false, committedAt: '2026-10-19T00:00:00.000Z'}, ...(recent ? {recent} : {})});
function fixture() {
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new Node(tag)}});
  const footer = new Node('footer'), version = new Node('button'); footer.append(version);
  const store = new Map<string, string>(), opened: {title: string; body: Node[]}[] = [], copied: string[] = [];
  const storage = {getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => {store.set(key, value);}};
  const hooks = {storage, before: version as unknown as HTMLElement, details: (title: string, body: HTMLElement[]) => {opened.push({title, body: body as unknown as Node[]});}, copy: (text: string) => {copied.push(text);}};
  return {footer, version, store, opened, copied, hooks, load: (value: UiIdentity) => new UpdateNotice(value, hooks)};
}
const history = Array.from({length: 30}, (_, index) => ({commit: (index + 1).toString(16).padStart(40, '0'), subject: `Change ${index}`}));

test('the first load in a tab shows nothing and remembers the release', () => {
  const f = fixture(); const notice = f.load(identity(id('a')));
  assert.equal(notice.node.hidden, true); assert.equal(f.footer.children.length, 2, 'the item is placed beside the version');
  assert.deepEqual(JSON.parse(f.store.get(UPDATE_KEY) ?? ''), {to: id('a'), dismissed: true});
});
test('a different release shows "Updated to <commit>" with Details and Dismiss, placed before the version', () => {
  const f = fixture(); f.load(identity(id('a')));
  const notice = f.load(identity(id('b')));
  assert.equal(notice.node.hidden, false); assert.equal(f.footer.children.at(-2), notice.node, 'directly before the version control'); assert.equal(f.footer.children.at(-1), f.version);
  assert.deepEqual(notice.node.children.map(child => child.textContent), ['Updated to bbbbbbbb', 'Details', 'Dismiss']);
  assert.equal(notice.node.title, 'Updated from aaaaaaaa to bbbbbbbb'); assert.equal(notice.node.attributes.get('role'), 'status');
});
test('Details lists the subjects since the earlier release, twenty at most with the rest counted, and Copy holds all of them', () => {
  const f = fixture(); const earlier = history[27]?.commit as string; f.load(identity(earlier));
  const notice = f.load(identity(history[0]?.commit as string, history));
  notice.node.find('Details')?.click();
  const [{title, body}] = f.opened as [{title: string; body: Node[]}];
  assert.match(title, /^Updated from [0-9a-f]{8} to [0-9a-f]{8}$/);
  const list = body.find(item => item.className === 'update-changes'); assert.ok(list); assert.equal(list.children.length, 20);
  assert.match(list.children[0]?.textContent ?? '', /Change 0$/);
  assert.ok(body.some(item => item.textContent === '7 more'));
  const copy = body.find(item => item.textContent === 'Copy changes'); assert.ok(copy); copy.click();
  assert.equal(f.copied[0]?.split('\n').length, 27); assert.ok(body.some(item => item.textContent === `From ${earlier}`));
});
test('Details says when the earlier release is not in the kept list, and when a release has no list at all', () => {
  const f = fixture(); f.load(identity(id('a')));
  const withList = f.load(identity(id('b'), history)); withList.node.find('Details')?.click();
  assert.ok(f.opened[0]?.body.some(item => item.textContent.includes('not in this release')));
  const g = fixture(); g.load(identity(id('a'))); const bare = g.load(identity(id('b')));
  bare.node.find('Details')?.click(); assert.ok(g.opened[0]?.body.some(item => item.textContent.includes('not in this release')));
  assert.ok(g.opened[0]?.body.some(item => item.textContent === `From ${id('a')}`) && g.opened[0]?.body.some(item => item.textContent === `To ${id('b')}`));
});
test('Dismiss closes the line, a reload of the same release keeps it closed, and the next update shows it again', () => {
  const f = fixture(); f.load(identity(id('a'))); const notice = f.load(identity(id('b')));
  notice.node.find('Dismiss')?.click(); assert.equal(notice.node.hidden, true); assert.equal(notice.node.children.length, 0);
  assert.equal(f.load(identity(id('b'))).node.hidden, true);
  assert.equal(f.load(identity(id('c'))).node.hidden, false);
});
test('a reload of the same release before any dismissal keeps the line', () => {
  const f = fixture(); f.load(identity(id('a'))); f.load(identity(id('b')));
  const again = f.load(identity(id('b'))); assert.equal(again.node.hidden, false); assert.equal(again.node.children[0]?.textContent, 'Updated to bbbbbbbb');
});
test('storage that refuses, and an identity with no commit, show nothing and break nothing', () => {
  const f = fixture();
  const refusing = new UpdateNotice(identity(id('a')), {...f.hooks, storage: {getItem: () => {throw new Error('blocked');}, setItem: () => {throw new Error('blocked');}}});
  assert.equal(refusing.node.hidden, true);
  const bare = new UpdateNotice({iteration: '1.10'}, f.hooks); assert.equal(bare.node.hidden, true);
});
