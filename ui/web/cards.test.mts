import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { presentTool } from './cards.ts';
import type { PresentationContext, ToolPresentationSource } from './transcript-presentation.ts';

class Node extends EventTarget {
  children: Node[] = []; private text = ''; className = ''; open = false;
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  readonly tag: string;
  constructor(tag: string) { super(); this.tag = tag; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
}
const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document'); });
function setup(): {context: PresentationContext; inspections: {title: string; source: () => string}[]} {
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new Node(tag), createTextNode: (text: string) => { const node = new Node('#text'); node.textContent = text; return node; }}});
  const inspections: {title: string; source: () => string}[] = [];
  const context: PresentationContext = {bounded: (text, limit = 65536) => text.slice(0, limit), rawText: value => JSON.stringify(value), structured: () => new Node('div') as unknown as HTMLElement,
    inspection: (title, source) => { inspections.push({title, source}); const node = new Node('details'); node.textContent = title; return node as unknown as HTMLDetailsElement; }};
  return {context, inspections};
}
function source(name: string, value: unknown, status = 'success'): ToolPresentationSource { return {callId: 'tool', name, args: {value, truncated: false}, status}; }
function node(value: HTMLElement | undefined): Node { assert.ok(value); return value as unknown as Node; }

test('structured edit previews every supplied old/new pair without invented file context', () => {
  const {context} = setup();
  const card = node(presentTool(source('edit', {path: 'math.ts', edits: [{oldText: 'return a - b;\n', newText: 'return a + b;\n'}, {oldText: '<script>', newText: ''}]}), context));
  assert.match(card.textContent, /- return a - b;\n- \n\+ return a \+ b;\n\+ /);
  assert.match(card.textContent, /- <script>\nNew text: empty\n/);
  assert.equal(card.children[0]?.tag, 'p'); assert.equal(card.children[0]?.className, 'secondary tool-caption');
  assert.equal(card.children[0]?.textContent, 'Supplied old and new text, not an inferred diff');
  assert.equal(card.children.some(child => ['h3', 'h4'].includes(child.tag)), false);
  const blocks = card.children.filter(child => child.tag === 'pre');
  assert.deepEqual(blocks[0]?.children.filter(child => child.tag === 'span').map(child => [child.className, child.textContent]),
    [['diff-del', '- return a - b;'], ['diff-del', '- '], ['diff-add', '+ return a + b;'], ['diff-add', '+ ']]);
  for (const block of blocks) for (let i = 1; i < block.children.length; i += 2) {
    assert.equal(block.children[i]?.tag, '#text'); assert.equal(block.children[i]?.textContent, '\n');
  }
  assert.deepEqual(blocks[1]?.children.map(child => [child.tag, child.className, child.textContent]),
    [['span', 'diff-del', '- <script>'], ['#text', '', '\n'], ['#text', '', 'New text: empty'], ['#text', '', '\n']]);
  assert.doesNotMatch(card.textContent, /@@|successfully replaced/);
  assert.equal(card.children.filter(child => child.tag === 'pre').length, 2);
});
test('empty supplied old and new text keep plain labels inside their replacement', () => {
  const {context} = setup();
  const card = node(presentTool(source('edit', {oldText: '', newText: ''}), context));
  const block = card.children.find(child => child.tag === 'pre'); assert.ok(block);
  assert.equal(block.textContent, 'Old text: empty\nNew text: empty\n');
  assert.equal(block.children.every(child => child.tag === '#text' && child.className === ''), true);
});
test('write shows supplied content with a truthful success, pending, or error label', () => {
  const {context} = setup();
  const contents = '<img src=x onerror=alert(1)>\nhello';
  const written = node(presentTool(source('write', {content: contents}), context));
  assert.match(written.textContent, /Written content<img src=x onerror=alert\(1\)>\nhello/);
  assert.equal(written.children[0]?.tag, 'p'); assert.equal(written.children[0]?.className, 'secondary tool-caption');
  assert.equal(written.children[0]?.textContent, 'Written content');
  for (const status of ['working', 'error']) {
    const pending = node(presentTool(source('write', {content: ''}, status), context));
    assert.match(pending.textContent, /Content to write\(empty content\)/);
    assert.equal(pending.children[0]?.tag, 'p'); assert.equal(pending.children[0]?.className, 'secondary tool-caption');
    assert.equal(pending.children[0]?.textContent, 'Content to write');
  }
});
test('long replacements and written content have bounded previews and lazy retained inspection', () => {
  const {context, inspections} = setup(); const content = 'line\n'.repeat(10000);
  const written = node(presentTool(source('write', {content}), context));
  assert.ok(written.textContent.length < 9000); assert.equal(inspections.length, 1); assert.equal(inspections[0]?.source(), content);
  inspections.length = 0;
  const edited = node(presentTool(source('edit', {edits: Array.from({length: 20}, () => ({oldText: content, newText: 'x'.repeat(10000)}))}), context));
  assert.equal(edited.children.filter(child => child.tag === 'pre').length, 8); assert.match(edited.textContent, /12 more replacements in Arguments/);
  assert.ok(edited.textContent.length < 22000); assert.equal(inspections.length, 16); assert.equal(inspections[0]?.source(), content);
  const unicode = node(presentTool(source('edit', {edits: Array.from({length: 8}, () => ({oldText: '😀'.repeat(10000), newText: '😀'.repeat(10000)}))}), context));
  assert.equal(unicode.textContent.isWellFormed(), true);
  assert.ok(unicode.children.filter(child => child.tag === 'pre').reduce((total, child) => total + child.textContent.length, 0) <= 16384);
});
test('public legacy replacements work; unfamiliar or malformed calls keep the generic fallback', () => {
  const {context} = setup();
  assert.match(node(presentTool(source('edit', {oldText: 'old', newText: 'new'}), context)).textContent, /- old\n\+ new/);
  for (const [name, args] of [['other', {edits: [{oldText: 'old', newText: 'new'}]}], ['edit', {edits: [{oldText: 'old'}]}], ['edit', {edits: []}], ['write', {content: 5}], ['edit', null]] as const) assert.equal(presentTool(source(name, args), context), undefined);
  assert.equal(presentTool({callId: 'tool', name: 'edit', status: 'working', argumentText: '{"edits":'}, context), undefined);
});
test('incomplete retained arguments have a visible omission warning', () => {
  const {context} = setup(); const value = source('edit', {edits: [{oldText: '[omitted]', newText: 'new'}]}); assert.ok(value.args); value.args = {...value.args, truncated: true};
  assert.match(node(presentTool(value, context)).textContent, /Arguments omitted by host/);
});
