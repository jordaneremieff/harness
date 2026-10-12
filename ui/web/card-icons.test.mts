import assert from 'node:assert/strict';
import test from 'node:test';
import { cardAction, cardActionLabel, cardDisclosure, cardIcon, controlIcon } from './card-icons.ts';

class Node {
  children: Node[] = []; attributes: Record<string, string> = {}; className = ''; textContent = ''; title = '';
  classList = {add: (name: string) => { this.className += ` ${name}`; }};
  get ownerDocument(): Document {return document;}
  replaceChildren(...nodes: Node[]): void {this.children = nodes; this.textContent = '';}
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  prepend(...nodes: Node[]): void { this.children.unshift(...nodes); }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; if (name === 'class') this.className = value; }
  addEventListener(): void {}
  querySelector(selector: string): Node | undefined { return this.children.find(node => node.className.split(' ').includes(selector.slice(1))); }
}
function withDocument(action: () => void): void {
  const original = globalThis.document;
  Reflect.set(globalThis, 'document', {createElement: () => new Node(), createElementNS: () => new Node()});
  try { action(); } finally { Reflect.set(globalThis, 'document', original); }
}
test('card icons keep one SVG size and stroke without executable markup', () => withDocument(() => {
  for (const name of ['copy', 'wrap', 'chevron', 'success', 'error', 'working', 'unknown', 'previous', 'next', 'restart', 'close', 'menu', 'plus', 'search', 'info', 'folder', 'navigation', 'agent', 'latest', 'earlier', 'message', 'more', 'commands', 'notifications', 'appearance', 'send', 'stop', 'disconnected'] as const) {
    const icon = cardIcon(name) as unknown as Node;
    assert.equal(icon.attributes.viewBox, '0 0 16 16'); assert.equal(icon.attributes.stroke, 'currentColor');
    assert.equal(icon.attributes['stroke-width'], '1.5'); assert.equal(icon.attributes['aria-hidden'], 'true');
    assert.equal(icon.attributes.focusable, 'false'); assert.ok(icon.children[0]?.attributes.d);
  }
}));
test('action feedback changes accessible text without replacing its icon or control', () => withDocument(() => {
  const action = cardAction('copy', 'Copy result', () => {}); const node = action as unknown as Node;
  const glyph = node.children[0]; const label = node.children[1];
  cardActionLabel(action, 'Copied', 'Copied retained result');
  assert.equal(node.children[0], glyph); assert.equal(node.children[1], label);
  assert.equal(label?.textContent, 'Copied'); assert.equal(node.attributes['aria-label'], 'Copied retained result');
  assert.equal(node.title, 'Copied retained result');
}));
test('a disclosure keeps its label and uses a separate chevron', () => withDocument(() => {
  const summary = new Node(); summary.textContent = 'Arguments'; cardDisclosure(summary as unknown as HTMLElement);
  assert.equal(summary.textContent, 'Arguments'); assert.equal(summary.children.length, 1);
  assert.equal(summary.children[0]?.attributes.class, 'card-icon card-icon-chevron');
  const icon = summary.children[0]; cardDisclosure(summary as unknown as HTMLElement);
  assert.equal(summary.children.length, 1); assert.equal(summary.children[0], icon);
}));

test('shell controls reuse the vocabulary with an accessible name and tooltip', () => withDocument(() => {
  const node = new Node(); const action = node as unknown as HTMLElement; controlIcon(action, 'plus', 'New conversation or split');
  assert.equal(node.children[0]?.attributes.class, 'card-icon card-icon-plus');
  assert.equal(node.children[1]?.textContent, 'New conversation or split');
  assert.equal(node.attributes['aria-label'], 'New conversation or split'); assert.equal(node.title, 'New conversation or split');
}));
