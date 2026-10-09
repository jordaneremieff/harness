import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bootstrap, RecentProjectPage } from '../shared/api.ts';
import type { Modal } from './modal.ts';
import { ProjectPicker } from './picker.ts';

class Node {
  children: Node[] = []; className = ''; id = ''; value = ''; title = ''; hidden = false; disabled = false;
  scrollLeft = 100; selectionStart = -1; selectionEnd = -1; focused = false;
  attributes: Record<string, string> = {}; private text = '';
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]): void { this.children = nodes; this.text = ''; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(): void {}
  focus(): void { this.focused = true; }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
}
function descendants(node: Node): Node[] { return node.children.flatMap(child => [child, ...descendants(child)]); }
test('project loading retains its list surface and autofocus exposes the start of long paths', async () => {
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
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
