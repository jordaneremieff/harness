import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { icon, installIcons, setIcon } from './icons.ts';

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  classes = new Set<string>();
  classList = {add: (name: string) => this.classes.add(name)};
  readonly name: string; readonly namespace: string; readonly text: string;
  constructor(name: string, namespace = '', text = '') { this.name = name; this.namespace = namespace; this.text = text; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(...children: Element[]): void { this.children = children; }
  querySelector(selector: string): Element | null { return this.children.find(child => `#${child.attributes.get('id')}` === selector) ?? null; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_html: string) { throw new Error('SVG controls must not parse HTML'); }
}
const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); });
function setup(nodes = new Map<string, Element>()): void {
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {
    createElementNS: (namespace: string, name: string) => new Element(name, namespace),
    createTextNode: (text: string) => new Element('#text', '', text),
    getElementById: (id: string) => nodes.get(id) ?? null,
  }});
}
test('icons use inert SVG paths with consistent dimensions and accessibility', () => {
  setup();
  const svg = icon('copy') as unknown as Element;
  assert.equal(svg.namespace, 'http://www.w3.org/2000/svg');
  assert.equal(svg.attributes.get('viewBox'), '0 0 24 24');
  assert.equal(svg.attributes.get('aria-hidden'), 'true');
  assert.equal(svg.attributes.get('focusable'), 'false');
  assert.equal(svg.attributes.get('stroke'), 'currentColor');
  assert.equal(svg.children.length, 1);
  assert.equal(svg.children[0]?.name, 'path');
  assert.ok(svg.children[0]?.attributes.get('d'));
});
test('icon updates retain the control and its accessible label', () => {
  setup(); const control = new Element('button');
  control.setAttribute('aria-label', 'Copy tool output');
  setIcon(control as unknown as HTMLElement, 'copy');
  setIcon(control as unknown as HTMLElement, 'check');
  assert.equal(control.attributes.get('aria-label'), 'Copy tool output');
  assert.equal(control.children.length, 1);
  assert.equal(control.classes.has('icon-button'), true);
  setIcon(control as unknown as HTMLElement, 'arrowLeft', 'Agents');
  assert.equal(control.textContent, 'Agents');
});
test('static control icons retain the notice badge node and leave text controls as text', () => {
  const badge = new Element('span', '', '3'); badge.setAttribute('id', 'notices-count');
  const notice = new Element('button'); notice.append(badge);
  const agents = new Element('button'); const stop = new Element('button');
  setup(new Map([['notices-button', notice], ['agents-button', agents], ['primary-stop', stop]]));
  installIcons();
  assert.equal(notice.children.at(-1), badge);
  assert.equal(agents.textContent, 'Agents');
  assert.equal(stop.children.length, 0);
  installIcons();
  assert.equal(notice.children.filter(child => child === badge).length, 1);
});
