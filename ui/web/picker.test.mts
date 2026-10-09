import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bootstrap, RecentProjectPage, SavedSessionPage } from '../shared/api.ts';
import type { Modal } from './modal.ts';
import { ProjectPicker } from './picker.ts';

class Node {
  children: Node[] = []; className = ''; id = ''; value = ''; title = ''; hidden = false; disabled = false;
  scrollLeft = 100; selectionStart = -1; selectionEnd = -1; focused = false; htmlFor = '';
  private handlers = new Map<string, Array<() => void>>();
  classList = {contains: (name: string) => this.className.split(' ').includes(name)};
  attributes: Record<string, string> = {}; private text = '';
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]): void { this.children = nodes; this.text = ''; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(name: string, callback: () => void): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], callback]); }
  dispatch(name: string): void { for (const callback of this.handlers.get(name) ?? []) callback(); }
  click(): void { this.dispatch('click'); }
  querySelectorAll(selector: string): Node[] { return descendants(this).filter(node => selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tag === selector); }
  querySelector(selector: string): Node | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus(): void { this.focused = true; }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
}
function descendants(node: Node): Node[] { return node.children.flatMap(child => [child, ...descendants(child)]); }
const saved: SavedSessionPage = {items: [{id: 's', path: '/project/s.jsonl', project: '/project', revision: 'r', title: 'Saved title', titleState: 'ready', modifiedAt: '2026-01-01T00:00:00Z', size: 10}], total: 1, omitted: 0, nextCursor: null, titleCursor: null, observedAt: '2026-01-01T00:00:00Z'};
for (const [name, page, status] of [
  ['complete', saved, 'Saved list · now'],
  ['more pages', {...saved, total: 2, nextCursor: 'more'}, '1 of 2 shown · Saved list · now'],
  ['omissions', {...saved, omitted: 1}, '1 of 1 shown · 1 unavailable or outside the scan bound · Saved list · now'],
  ['unavailable title', {...saved, items: saved.items.map(item => ({...item, titleState: 'unavailable' as const}))}, '1 of 1 shown · Saved list · now'],
] as const) test(`saved session status merges freshness and coverage for ${name}`, async t => {
  t.mock.method(Date, 'now', () => Date.parse(saved.observedAt));
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const oldFetch = globalThis.fetch; const body = new Node('div');
  Object.defineProperty(globalThis, 'HTMLElement', {configurable: true, value: Node});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {activeElement: null, createElement: (tag: string) => new Node(tag), createDocumentFragment: () => new Node('fragment')}});
  globalThis.fetch = async url => new Response(JSON.stringify({ok: true, data: String(url).includes('/api/projects') ? {items: [], total: 0, omitted: 0, nextCursor: null, observedAt: saved.observedAt} : page}), {status: 200, headers: {'content-type': 'application/json'}});
  const modal = {token: 1, open: () => { body.replaceChildren(); return body; }, owns: (token: number) => token === 1, actions: (...buttons: Node[]) => body.append(...buttons), error: (error: unknown) => { throw error; }};
  try {
    const picker = new ProjectPicker({modal: modal as unknown as Modal, snapshot: () => ({launchCwd: '/project', primaries: []}) as unknown as Bootstrap, primary: () => undefined, selection: async () => {}, reload: async () => {}});
    picker.open(); const next = descendants(body).find(node => node.textContent === 'Continue'); assert.ok(next); next.click();
    await new Promise<void>(resolve => setImmediate(resolve));
    const nodes = descendants(body); const search = nodes.find(node => node.id === 'picker-search'); assert.ok(search);
    const label = nodes.find(node => node.tag === 'label' && node.htmlFor === search.id); assert.ok(label);
    assert.equal(label.className, 'sr-only'); assert.equal(label.textContent, 'Search saved sessions');
    const heading = body.children.findIndex(node => node.textContent === 'Resume a saved session');
    assert.equal(body.children[heading + 1], label); assert.equal(body.children[heading + 2], search);
    const coverage = nodes.find(node => node.id === 'picker-coverage'); assert.ok(coverage);
    assert.equal(coverage.className, 'secondary'); assert.equal(coverage.attributes['aria-live'], 'polite');
    assert.equal(coverage.textContent, status);
    assert.equal(body.children.filter(node => node.textContent.includes('Saved list ·')).length, 1);
    assert.ok(nodes.find(node => node.tag === 'button' && node.textContent === 'Refresh'));
    search.value = 'no match'; search.dispatch('input');
    assert.equal(coverage.textContent, name === 'complete' ? status : `0 matches in loaded sessions · ${status}`);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (oldElement) Object.defineProperty(globalThis, 'HTMLElement', oldElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }
});
test('project loading retains its list surface and autofocus exposes the start of long paths', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-01-01T00:00:00Z'));
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousFetch = globalThis.fetch;
  const body = new Node('div');
  let release: (response: Response) => void = () => { throw new Error('Request not started'); };
  const response = new Promise<Response>(resolve => { release = resolve; });
  globalThis.fetch = async () => response;
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new Node(tag)}});
  const path = `/projects/${'long-project-'.repeat(24)}`;
  const modal = {token: 1, open: () => body, owns: (token: number) => token === 1, actions: (...buttons: Node[]) => body.append(...buttons), error: (error: unknown) => { throw error; }};
  try {
    const picker = new ProjectPicker({modal: modal as unknown as Modal, snapshot: () => ({launchCwd: path, primaries: []}) as unknown as Bootstrap, primary: () => undefined, selection: async () => {}, reload: async () => {}});
    picker.open();
    const nodes = descendants(body); const field = nodes.find(node => node.id === 'picker-project');
    assert.ok(field); assert.equal(field.value, path); assert.equal(field.focused, true);
    assert.equal(field.selectionStart, 0); assert.equal(field.selectionEnd, 0); assert.equal(field.scrollLeft, 0);
    const list = nodes.find(node => node.className === 'options picker-projects'); assert.ok(list);
    assert.equal(list.children.length, 0);
    const page: RecentProjectPage = {items: [{path, name: 'Long project'}], total: 1, omitted: 0, nextCursor: null, observedAt: '2026-01-01T00:00:00Z'};
    release(new Response(JSON.stringify({ok: true, data: page}), {status: 200, headers: {'content-type': 'application/json'}}));
    await response; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(descendants(body).find(node => node.className === 'options picker-projects'), list);
    assert.equal(list.children.length, 1); assert.equal(list.children[0].textContent, 'Long project');
    assert.equal(list.children[0].title, path); assert.match(list.children[0].attributes['aria-label'], /Long project/);
    const status = descendants(body).find(node => node.className === 'secondary picker-project-status');
    assert.equal(status?.textContent, 'Saved list · now');
    const refresh = descendants(body).find(node => node.textContent === 'Refresh recent projects'); assert.ok(refresh);
    page.nextCursor = 'more'; page.total = 2; page.omitted = 1;
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true, data: page}), {status: 200, headers: {'content-type': 'application/json'}});
    refresh.click();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(status?.textContent, '1 of 2 projects shown · Saved list · now · 1 file or directory entries unexamined');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
