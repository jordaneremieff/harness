import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { presentTool, presentToolPreview, readRange, cardPreviewLimits, resultPreview } from './cards.ts';
import type { PartView } from '../shared/api.ts';
import type { PresentationContext, ToolPresentationSource } from './transcript-presentation.ts';

class Node extends EventTarget {
  children: Node[] = []; private text = ''; className = ''; open = false;
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: Node[]): void { for (const node of nodes) this.children.push(...(node.tag === '#fragment' ? node.children : [node])); }
  readonly tag: string;
  constructor(tag: string) { super(); this.tag = tag; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
}
const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document'); });
function setup(): {context: PresentationContext; inspections: {title: string; source: () => string}[]} {
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: (tag: string) => new Node(tag), createDocumentFragment: () => new Node('#fragment'), createTextNode: (text: string) => { const node = new Node('#text'); node.textContent = text; return node; }}});
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
  // Expectations use the display labels while preserving source and action checks.
  assert.equal(card.children[0]?.textContent, 'Supplied replacement');
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
  assert.match(written.textContent, /Supplied content<img src=x onerror=alert\(1\)>\nhello/);
  assert.equal(written.children[0]?.tag, 'p'); assert.equal(written.children[0]?.className, 'secondary tool-caption');
  assert.equal(written.children[0]?.textContent, 'Supplied content');
  for (const status of ['working', 'error']) {
    const pending = node(presentTool(source('write', {content: ''}, status), context));
    assert.match(pending.textContent, /Supplied content\(empty content\)/);
    assert.equal(pending.children[0]?.tag, 'p'); assert.equal(pending.children[0]?.className, 'secondary tool-caption');
    assert.equal(pending.children[0]?.textContent, 'Supplied content');
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
test('public single replacements work; unfamiliar or malformed calls keep the generic fallback', () => {
  const {context} = setup();
  assert.match(node(presentTool(source('edit', {oldText: 'old', newText: 'new'}), context)).textContent, /- old\n\+ new/);
  for (const [name, args] of [['other', {edits: [{oldText: 'old', newText: 'new'}]}], ['edit', {edits: [{oldText: 'old'}]}], ['edit', {edits: []}], ['write', {content: 5}], ['edit', null]] as const) assert.equal(presentTool(source(name, args), context), undefined);
  assert.equal(presentTool({callId: 'tool', name: 'edit', status: 'working', argumentText: '{"edits":'}, context), undefined);
});
test('read ranges use supplied offset and limit, not inferred output lines', () => {
  assert.equal(readRange({offset: 7, limit: 4}), 'lines 7–10');
  assert.equal(readRange({limit: 2}), 'lines 1–2');
  assert.equal(readRange({offset: 7}), 'lines 7 onward');
  assert.equal(readRange({offset: null, limit: 4}), 'lines 1–4');
  assert.equal(readRange({offset: 7, limit: null}), 'lines 7 onward');
  assert.equal(readRange({offset: null, limit: null}), '');
  for (const args of [{}, {offset: 0}, {limit: 0}, {offset: '7'}, {limit: -1}, {offset: Infinity}, {offset: Number.MAX_SAFE_INTEGER, limit: 2}]) assert.equal(readRange(args), '');
});
test('bash command uses inert supplied text and preserves multiline commands on expansion', () => {
  const {context} = setup();
  const card = node(presentTool(source('bash', {command: 'printf "<script>"\nprintf done'}), context));
  assert.equal(card.children[0]?.className, 'tool-command');
  assert.equal(card.textContent, '$ printf "<script>"\nprintf done');
  assert.equal(presentTool(source('bash', {command: 7}), context), undefined);
});
test('collapsed write and edit previews expose supplied content with diff classes', () => {
  setup();
  const edit = node(presentToolPreview(source('edit', {edits: [{oldText: '<script>\nold', newText: 'new\ntext'}, {oldText: 'x', newText: 'y'}]})));
  assert.deepEqual(edit.children.filter(child => child.tag === 'span').map(child => child.className), ['diff-del', 'diff-del', 'diff-add', 'diff-add']);
  assert.match(edit.textContent, /- <script>\n- old\n\+ new\n\+ text\n1 more replacement in Arguments\./);
  assert.equal(edit.className, 'tool-content-preview');
  const write = node(presentToolPreview(source('write', {content: 'one\ntwo\nthree'})));
  assert.equal(write.textContent, "one\ntwo\nthree");
  assert.equal(node(presentToolPreview(source('write', {content: ''}))).textContent, '(empty content)');
  assert.equal(presentToolPreview(source('write', {content: 'file text'}, 'error')), undefined);
  assert.equal(presentToolPreview(source('unknown', {content: 'text'})), undefined);
  const long = node(presentToolPreview(source('edit', {oldText: '😀'.repeat(5000), newText: '😀'.repeat(5000)})));
  assert.equal(long.textContent.isWellFormed(), true); assert.ok(long.textContent.length < 1800);
});
test('write previews highlight by extension and preserve exact supplied text and edit colors', () => {
  const {context} = setup(); const content = 'const value: number = 42;';
  const call = source('write', {path: 'source.ts', content});
  for (const preview of [node(presentToolPreview(call)), node(presentTool(call, context)).children.find(child => child.tag === 'pre')]) {
    assert.ok(preview); assert.equal(preview.textContent, content);
    assert.ok(preview.children.some(child => child.className === 'syn-keyword'));
    assert.ok(preview.children.some(child => child.className === 'syn-number'));
  }
  const edit = node(presentTool(source('edit', {path: 'source.ts', oldText: content, newText: 'return 2;'}), context));
  const lines = edit.children.filter(child => child.tag === 'pre').flatMap(child => child.children).filter(child => child.tag === 'span');
  assert.equal(lines.every(child => child.className === 'diff-del' || child.className === 'diff-add'), true);
  assert.equal(lines.every(child => child.children.length === 0), true);
});
test('collapsed supplied comparisons reveal later changes with bounded context and remaining counts', () => {
  setup();
  for (const prefix of ['same\n'.repeat(2000), '😀'.repeat(5000)]) {
    const call = source('edit', {edits: [{oldText: `${prefix}OLD\n${'tail\n'.repeat(20)}`, newText: `${prefix}NEW\n${'tail\n'.repeat(20)}`}, {oldText: 'x', newText: 'y'}]});
    assert.ok(call.args); call.args = {...call.args, truncated: true}; const retained = JSON.stringify(call);
    const preview = node(presentToolPreview(call));
    assert.match(preview.textContent, /Earlier context omitted/); assert.match(preview.textContent, /- [^\n]*OLD/); assert.match(preview.textContent, /\+ [^\n]*NEW/);
    assert.match(preview.textContent, /Later context omitted/); assert.match(preview.textContent, /1 more replacement in Arguments/);
    assert.match(preview.textContent, /Some arguments are unavailable/);
    assert.ok(preview.textContent.length <= 1200); assert.ok(preview.textContent.trimEnd().split('\n').length <= 6);
    assert.equal(preview.textContent.isWellFormed(), true); assert.equal(JSON.stringify(call), retained);
  }
  const exhausted = node(presentToolPreview(source('edit', {oldText: `${'x'.repeat(65536)}old`, newText: `${'x'.repeat(65536)}new`})));
  assert.match(exhausted.textContent, /First difference not located within scan limit/); assert.doesNotMatch(exhausted.textContent, /No differing text/);
});
test('bounded expanded comparisons keep exact lazy inspections and never scan replacement tails', () => {
  const {context, inspections} = setup();
  const prefix = 'same\n'.repeat(2000), oldText = `${prefix}OLD\n${'old-tail\n'.repeat(100)}`, newText = `${prefix}NEW\n${'new-tail\n'.repeat(100)}`;
  const edited = node(presentTool(source('edit', {oldText, newText}), context));
  assert.match(edited.textContent, /- OLD/); assert.match(edited.textContent, /\+ NEW/); assert.match(edited.textContent, /Earlier context omitted/);
  assert.equal(inspections[0]?.source(), oldText); assert.equal(inspections[1]?.source(), newText);
  const edits = Array.from({length: 8}, () => ({oldText: 'old', newText: 'new'}));
  Object.defineProperty(edits, 8, {get: () => {throw new Error('Unvisited replacement tail');}}); edits.length = 10000;
  const card = node(presentTool(source('edit', {edits}), context));
  assert.equal(card.children.filter(child => child.tag === 'pre').length, 8); assert.match(card.textContent, /9992 more replacements in Arguments/);
});
test('collapsed summaries preserve redacted literal sources while preferring supplied warnings and documents', () => {
  const parts: PartView[] = [{type: 'text', text: 'original JSON text', structured: {value: {cursor: 'next', digest: 'hash', coverage: {}, document: 'Actual document', warning: 'Some results omitted'}, truncated: true}}];
  const retained = JSON.stringify(parts), shown = resultPreview(parts);
  assert.match(shown, /warning: Some results omitted/); assert.match(shown, /document: Actual document/); assert.match(shown, /Partial preview/);
  assert.doesNotMatch(shown, /cursor|digest|coverage/); assert.equal(JSON.stringify(parts), retained);
  assert.equal(resultPreview([{...parts[0], type: 'text', text: '[protected text]', redacted: true}]), '[protected text]');
});
test('card preview limits describe the applied bounds for tool details', () => {
  assert.match(cardPreviewLimits(), /8192 characters and 80 lines per text/);
  assert.match(cardPreviewLimits(), /16384 characters of supplied text in total, and 8 replacements/);
});
test('collapsed results summarize supplied structure without parsing literal text or changing source', () => {
  const parts: PartView[] = [{type: 'text', text: '{\n  "count": 2\n}', structured: {value: {count: 2, valid: false, tag: 'kept', extra: 'expanded only'}, truncated: false}}];
  const before = JSON.stringify(parts);
  assert.equal(resultPreview(parts), 'count: 2 · valid: false · tag: kept');
  assert.equal(JSON.stringify(parts), before);
  assert.equal(resultPreview([{type: 'text', text: "{\n\"role\": \"assistant\"\n}"}]), "{\n\"role\": \"assistant\"\n}");
  assert.equal(resultPreview([{type: 'text', text: 'retained', structured: {value: ['one', 'two'], truncated: true}}]), 'Array preview limited');
  assert.equal(resultPreview([{type: 'text', text: 'retained', structured: {value: ['one', 'two'], truncated: false}}]), '2 items');
  assert.equal(resultPreview([{type: 'text', text: 'retained', structured: {value: ['one', '[omitted]'], truncated: false}}]), '2 items');
  assert.equal(resultPreview([{type: 'text', text: 'retained', structured: {value: ['one', '[omitted]'], truncated: true}}]), 'Array preview limited');
  assert.equal(resultPreview([{type: 'text', text: '[protected text]', redacted: true, structured: {value: {hidden: 'never preview'}, truncated: false}}]), '[protected text]');
});
test('nested retained results use supplied structured summaries without changing the literal source', () => {
  const parts: PartView[] = [{type: 'toolResult', callId: 'nested', name: 'query', isError: false, parts: [
    {type: 'text', text: '{"count":2}', structured: {value: {count: 2}, truncated: false}},
  ]}];
  const before = JSON.stringify(parts); assert.equal(resultPreview(parts), 'count: 2'); assert.equal(JSON.stringify(parts), before);
});
test('collapsed literal results have a six-line and 1200-character limit without a source-loss promise', () => {
  for (const text of ['one\ntwo\nthree', 'one\rtwo\rthree', 'one\r\ntwo\r\nthree', 'x'.repeat(10000), '😀'.repeat(10000)]) {
    const parts: PartView[] = [{type: 'text', text}];
    const shown = resultPreview(parts);
    assert.ok(shown.length <= 1200); assert.ok(shown.split(/\r\n|\r|\n/).length <= 6);
    assert.equal(shown.isWellFormed(), true); assert.equal(parts[0].type === 'text' && parts[0].text, text);
    assert.doesNotMatch(shown, /not retained|Copy|Raw output/);
  }
  assert.equal(resultPreview([]), ''); assert.equal(resultPreview([{type: 'omitted', label: 'Image unavailable'}]), '');
  assert.equal(resultPreview([{type: 'text', text: ''}, {type: 'text', text: 'Second supplied text'}]), 'Second supplied text');
});
test('supplied write and edit source labels remain independent of reported success', () => {
  const {context} = setup();
  for (const status of ['success', 'working', 'error', 'unknown']) {
    const write = node(presentTool(source('write', {content: 'exact'}, status), context));
    const edit = node(presentTool(source('edit', {oldText: 'old', newText: 'new'}, status), context));
    assert.equal(write.children[0]?.textContent, 'Supplied content');
    assert.equal(edit.children[0]?.textContent, 'Supplied replacement');
    assert.match(edit.textContent, /- old\n\+ new/); assert.match(write.textContent, /exact/);
    assert.doesNotMatch(write.textContent, /Written content|filesystem|current file/);
  }
});
test('incomplete retained arguments have a visible omission warning', () => {
  const {context} = setup(); const value = source('edit', {edits: [{oldText: '[omitted]', newText: 'new'}]}); assert.ok(value.args); value.args = {...value.args, truncated: true};
  assert.match(node(presentTool(value, context)).textContent, /Some arguments are not available/);
});
