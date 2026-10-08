import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { renderFacts } from './facts.ts';
const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => {if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');});
class FakeNode {
  tag: string; children: FakeNode[] = []; parent?: FakeNode; dataset: Record<string, string> = {}; textContent = ''; className = ''; open = false;
  constructor(tag: string) {this.tag = tag;}
  append(...nodes: FakeNode[]): void {for (const node of nodes) {node.parent = this; this.children.push(node);}}
  querySelector(tag: string): FakeNode | undefined {return this.children.find(node => node.tag === tag);}
  remove(): void {if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this);}
  set innerHTML(_value: string) {throw new Error('HTML assignment forbidden');}
}
function root(): HTMLElement {
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new FakeNode(tag)}});
  return new FakeNode('div') as unknown as HTMLElement;
}
test('reported fact updates retain the disclosure node and its open state', () => {
  const node = root(); renderFacts(node, [{key: 'tasks', label: 'Reported tasks', text: 'first'}]);
  const disclosure = node.children[0] as unknown as FakeNode; disclosure.open = true;
  renderFacts(node, [{key: 'tasks', label: 'Reported tasks', text: 'new exact facts'}]);
  assert.equal(node.children[0], disclosure); assert.equal(disclosure.open, true); assert.equal(disclosure.querySelector('pre')?.textContent, 'new exact facts');
});
test('absent facts disappear and untrusted markup remains literal text', () => {
  const node = root(); renderFacts(node, [{key: 'old', label: 'Old', text: 'old'}]);
  renderFacts(node, [{key: 'reply', label: 'Retained reply', text: '<script>never execute()</script>'}]);
  assert.equal(node.children.length, 1); assert.equal((node.children[0] as unknown as FakeNode).querySelector('pre')?.textContent, '<script>never execute()</script>');
});
