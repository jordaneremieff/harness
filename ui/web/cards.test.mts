import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { presentResultPreview, presentTool, presentToolPreview, readRange, cardPreviewLimits, resultPreview, withoutTrailingJson } from './cards.ts';
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
  assert.match(card.textContent, /- return a - b;\n\+ return a \+ b;\n/);
  assert.match(card.textContent, /- <script>\nNew text: empty\n/);
  assert.equal(card.children[0]?.tag, 'p'); assert.equal(card.children[0]?.className, 'secondary tool-caption');
  // Expectations use the display labels while preserving source and action checks.
  assert.equal(card.children[0]?.textContent, 'Supplied replacement');
  assert.equal(card.children.some(child => ['h3', 'h4'].includes(child.tag)), false);
  const blocks = card.children.filter(child => child.tag === 'pre');
  assert.deepEqual(blocks[0]?.children.filter(child => child.tag === 'span').map(child => [child.className, child.textContent]),
    [['diff-row diff-del', '- return a - b;\n'], ['diff-row diff-add', '+ return a + b;\n']]);
  assert.deepEqual(blocks[1]?.children.map(child => [child.tag, child.className, child.textContent]),
    [['span', 'diff-row diff-del', '- <script>\n'], ['#text', '', 'New text: empty'], ['#text', '', '\n']]);
  assert.doesNotMatch(card.textContent, /@@|successfully replaced/);
  assert.equal(card.children.filter(child => child.tag === 'pre').length, 2);
});
test('collapsed and expanded diff rows preserve literal markers, indentation, blank lines and newline text', () => {
  const {context} = setup();
  const oldText = '  head\n\told <script>😀\n\n  tail';
  const long = `\tnew ${'wide '.repeat(35)}😀`;
  const newText = `  head\n${long}\n  extra\n  tail`;
  const value = {oldText, newText}; const retained = JSON.stringify(value);
  const call = source('edit', value);
  const expected = [['  ', '  head\n'], ['- ', '\told <script>😀\n'], ['- ', '\n'], ['+ ', `${long}\n`], ['+ ', '  extra\n'], ['  ', '  tail\n']];
  for (const block of [node(presentToolPreview(call)), node(presentTool(call, context)).children.find(child => child.tag === 'pre')]) {
    assert.ok(block);
    assert.equal(block.textContent, expected.map(([marker, text]) => `${marker}${text}`).join(''));
    assert.deepEqual(block.children.map(row => row.className), ['diff-row', 'diff-row diff-del', 'diff-row diff-del', 'diff-row diff-add', 'diff-row diff-add', 'diff-row']);
    assert.deepEqual(block.children.map(row => row.children.map(child => [child.className, child.textContent])),
      expected.map(([marker, text]) => [['diff-marker', marker], ['diff-text', text]]));
    assert.equal(block.children.every(row => row.tag === 'span' && row.children.every(child => child.tag === 'span')), true);
  }
  assert.equal(JSON.stringify(value), retained);
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
  assert.ok(card.children[0]?.children.some(child => child.className === 'syn-fn'));
  assert.ok(card.children[0]?.children.some(child => child.className === 'syn-string'));
  const retained = 'printf "😀"\r\necho done';
  const bounded = node(presentTool(source('bash', {command: retained}), {...context, bounded: text => text.slice(0, 12)}));
  assert.equal(bounded.children[0]?.textContent, `$ ${retained}`.slice(0, 12));
  assert.equal(presentTool(source('bash', {command: 7}), context), undefined);
});
test('collapsed write and edit previews expose supplied content with diff classes', () => {
  setup();
  const edit = node(presentToolPreview(source('edit', {edits: [{oldText: '<script>\nold', newText: 'new\ntext'}, {oldText: 'x', newText: 'y'}]})));
  assert.deepEqual(edit.children.filter(child => child.tag === 'span').map(child => child.className), ['diff-row diff-del', 'diff-row diff-del', 'diff-row diff-add', 'diff-row diff-add']);
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
  assert.equal(lines.every(child => child.className === 'diff-row diff-del' || child.className === 'diff-row diff-add'), true);
  assert.equal(lines.every(child => child.children.length === 2 && child.children[0]?.className === 'diff-marker' && child.children[1]?.className === 'diff-text'), true);
});
test('collapsed successful source reads add syntax without changing their bounded literal preview or source', () => {
  setup();
  for (const pathKey of ['path', 'file_path']) {
    for (const [path, text] of [['source.ts', '\n  const value: number = 42;\r\nreturn value;\n\n'], ['data.json', '{"value":42,"ok":true}'], ['script.py', 'def answer():\n    return 42']] as const) {
      const result: PartView[] = [{type: 'text', text}];
      const call = {...source('read', {[pathKey]: path}), result}; const retained = JSON.stringify(call);
      const preview = node(presentResultPreview(call));
      assert.equal(preview.tag, 'pre'); assert.equal(preview.className, 'tool-content-preview');
      assert.equal(preview.textContent, resultPreview(result, {tidy: true}));
      assert.ok(preview.children.some(child => child.className.startsWith('syn-')));
      assert.equal(JSON.stringify(call), retained);
    }
  }
  for (const text of ['const value = 42;\n'.repeat(100), `const value = "${'😀'.repeat(10000)}";`]) {
    const result: PartView[] = [{type: 'text', text}];
    const preview = node(presentResultPreview({...source('read', {path: 'source.ts'}), result}));
    assert.equal(preview.textContent, resultPreview(result, {tidy: true}));
    assert.ok(preview.textContent.length <= 1200); assert.ok(preview.textContent.split(/\r\n|\r|\n/).length <= 6);
    assert.equal(preview.textContent.isWellFormed(), true); assert.equal(result[0]?.type === 'text' && result[0].text, text);
  }
});
test('source read colors exclude errors, redaction, unknown paths, other tools and transformed structured text', () => {
  setup(); const text = 'const value = 42;'; const result: PartView[] = [{type: 'text', text}];
  for (const call of [source('read', {path: 'source.ts'}, 'working'), source('read', {path: 'source.ts'}, 'error'), source('bash', {path: 'source.ts'}), source('read', {}), source('read', {path: 'source.unknown'})]) {
    assert.equal(presentResultPreview({...call, result}), undefined);
  }
  assert.equal(presentResultPreview({...source('read', {path: 'source.ts'}), result: [{type: 'text', text, redacted: true}]}), undefined);
  const summary = node(presentResultPreview({...source('read', {path: 'source.ts'}), result: [{type: 'text', text: '{"count":2}', structured: {value: {count: 2}, truncated: false}}]}));
  assert.equal(summary.className, 'tool-prose-preview'); assert.equal(summary.textContent, 'count: 2');
  assert.equal(summary.children.some(child => child.className.startsWith('syn-')), false);
  assert.equal(presentResultPreview({...source('read', {path: 'source.ts'}), result: [{type: 'text', text: 'Listed\n{"count":2}', structured: {value: ['Listed', {count: 2}], truncated: false}}]}), undefined);
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
  assert.match(shown, /warning: Some results omitted/); assert.match(shown, /Actual document/); assert.match(shown, /Partial preview/);
  assert.doesNotMatch(shown, /cursor|digest|coverage/); assert.equal(JSON.stringify(parts), retained);
  assert.equal(resultPreview([{...parts[0], type: 'text', text: '[protected text]', redacted: true}]), '[protected text]');
});
test('card preview limits describe the applied bounds for tool details', () => {
  assert.match(cardPreviewLimits(), /8192 characters and 80 lines per text/);
  assert.match(cardPreviewLimits(), /16384 characters of supplied text in total, and 8 replacements/);
});
test('collapsed results summarize supplied structure without parsing literal text or changing source', () => {
  const parts: PartView[] = [{type: 'text', text: '{\n  "count": 2\n}', structured: {value: {count: 2, valid: true, tag: 'kept', extra: 'expanded only'}, truncated: false}}];
  const before = JSON.stringify(parts);
  assert.equal(resultPreview(parts), 'count: 2 · valid: true · tag: kept');
  assert.equal(JSON.stringify(parts), before);
  assert.equal(resultPreview([{type: 'text', text: "{\n\"role\": \"assistant\"\n}"}]), "{\n\"role\": \"assistant\"\n}");
  assert.equal(resultPreview([{type: 'text', text: '["one","two"]', structured: {value: ['one', 'two'], truncated: true}}]), 'Array preview limited');
  assert.equal(resultPreview([{type: 'text', text: '  ["one","two"]', structured: {value: ['one', 'two'], truncated: false}}]), '2 items');
  assert.equal(resultPreview([{type: 'text', text: '["one","[omitted]"]', structured: {value: ['one', '[omitted]'], truncated: false}}]), '2 items');
  assert.equal(resultPreview([{type: 'text', text: '["one","[omitted]"]', structured: {value: ['one', '[omitted]'], truncated: true}}]), 'Array preview limited');
  assert.equal(resultPreview([{type: 'text', text: '[protected text]', redacted: true, structured: {value: {hidden: 'never preview'}, truncated: false}}]), '[protected text]');
});
test('text made of prose and JSON lines previews each element in order, never as raw JSON or an item count', () => {
  const parts = (text: string, value: unknown, truncated = false): PartView[] => [{type: 'text', text, structured: {value, truncated}}];
  const id = 'a600b075-03c4-193c-1c9b-bc5416a82e99', commit = 'bd08c44c0d6f2a91b7e35c48f1a0923be6d7c514', digest = 'f'.repeat(64);
  // A JSON object then a prose line: the object's readable text, then the prose line, with no brace and no identifier.
  const object = {requestId: id, ownerId: id, message: 'The composer round is released.\n\nReleased:\n- the first change', senderIdentity: id};
  const reported = resultPreview(parts(`${JSON.stringify(object)}\nIf the recipient is busy, this report waits.`, [object, 'If the recipient is busy, this report waits.']));
  assert.equal(reported, 'The composer round is released.\nReleased:…\nIf the recipient is busy, this report waits.'); assert.doesNotMatch(reported, /[{}]|requestId|[0-9a-f]{8}-[0-9a-f]{4}/);
  // Prose then an object: the prose line, then the object's readable facts; identifiers and digests are left out.
  const facts = {iteration: '1.10', commit, assetDigest: digest}, fatal = 'fatal: Needed a single revision';
  const built = resultPreview(parts(`${fatal}\n${JSON.stringify(facts)}`, [fatal, facts])); assert.equal(built, `${fatal}\niteration: 1.10`);
  assert.equal(resultPreview(parts(`${fatal}\n${JSON.stringify(facts)}`, [fatal, facts]), {tidy: true}), `${fatal}\niteration: 1.10`);
  assert.equal(resultPreview(parts('{"a":1}\n{"b":2}', [{a: 1}, {b: 2}])), 'a: 1\nb: 2');
  assert.equal(resultPreview(parts('Listed\n[1,2,3]', ['Listed', [1, 2, 3]])), 'Listed\n3 items');
  assert.equal(resultPreview(parts(`${JSON.stringify({requestId: id})}\nDone.`, [{requestId: id}, 'Done.'])), 'Done.', 'an object that holds only identifiers adds no line');
  assert.equal(resultPreview(parts(`${JSON.stringify({requestId: id})}\n${JSON.stringify({ownerId: id})}`, [{requestId: id}, {ownerId: id}])), '', 'nothing readable shows no line');
  const long = Array.from({length: 9}, (_, index) => `line ${index}`);
  assert.equal(resultPreview(parts(`${long.join('\n')}\n{"a":1}`, [long.join('\n'), {a: 1}])).split('\n').length, 6, 'the six-line bound stays');
  assert.equal(resultPreview(parts('[1,2,3]', [1, 2, 3])), '3 items');
  assert.equal(resultPreview(parts('\n  [{"a":1}]\n', [{a: 1}])), '1 item');
  assert.equal(resultPreview(parts('{"a":1}', {a: 1})), 'a: 1');
  assert.equal(resultPreview([{type: 'text', text: `${fatal}\n{"x":1}`, redacted: true, structured: {value: [fatal, {x: 1}], truncated: false}}]), `${fatal}\n{"x":1}`, 'protected text stays literal');
  const shown = presentResultPreview({callId: 'tool', name: 'custom', status: 'success', result: parts(`${fatal}\n{"cwd":"/work"}`, [fatal, {cwd: '/work'}])});
  assert.equal(shown, undefined, 'mixed lines keep their own line structure, not the prose summary block');
});
test('a summary that repeats the card title or only holds false flags shows no preview line', () => {
  setup();
  const session = 'ead53d8c-af9d-0bda-1416-21a6ba18ab6c:57', name = (identity: string) => identity === session ? 'Web UI designer' : undefined;
  const value = {identity: session, result: {sessionId: session}, deduped: false};
  const result: PartView[] = [{type: 'text', text: JSON.stringify(value), structured: {value, truncated: false}}];
  const title = 'Sent a message to Web UI designer: “Round 8”';
  assert.equal(resultPreview(result, {resolve: name, title}), '');
  assert.equal(resultPreview(result, {resolve: name}), 'Web UI designer');
  assert.equal(presentResultPreview({callId: 'tool', name: 'custom', status: 'success', result}, name, title), undefined);
  assert.equal(node(presentResultPreview({callId: 'tool', name: 'custom', status: 'success', result}, name)).textContent, 'Web UI designer');
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

function walk(root: Node): Node[] { return [root, ...root.children.flatMap(walk)]; }
function readSource(path: string, text: string, status = 'success', name = 'read', redacted = false): ToolPresentationSource {
  return {callId: 'tool', name, args: {value: {path}, truncated: false}, status, result: [{type: 'text', text, ...(redacted ? {redacted: true} : {})}]};
}
test('a successful Markdown read previews as noninteractive prose without source punctuation', () => {
  setup();
  const text = '# Release notes\nThe **bold** and _soft_ [label](https://example.com/x) with `code()` and ![chart](x.png).\n- first\n- second\n<script>alert(1)</script>';
  const shown = node(presentResultPreview(readSource('docs/NOTES.MD', text)));
  assert.equal(shown.tag, 'span'); assert.equal(shown.className, 'tool-prose-preview');
  const tags = new Set(walk(shown).map(child => child.tag));
  for (const forbidden of ['a', 'button', 'img', 'pre', 'script', 'details', 'summary', 'input']) assert.equal(tags.has(forbidden), false, forbidden);
  assert.equal(shown.textContent, 'Release notesThe bold and soft label with code() and Image not shown: chart. \u2022 first \u2022 second <script>alert(1)</script>');
  assert.doesNotMatch(shown.textContent, /[#*_[\]]|https:/);
  const classes = walk(shown).map(child => child.className);
  assert.ok(classes.includes('prose-preview-block prose-preview-heading prose-preview-title')); assert.ok(classes.includes('prose-preview-code'));
  assert.deepEqual(walk(shown).filter(child => child.tag === 'strong' || child.tag === 'em').map(child => [child.tag, child.textContent]), [['strong', 'bold'], ['em', 'soft']]);
});
test('a leading heading is its own title line and later headings stay inline in the body', () => {
  setup();
  const shown = node(presentResultPreview(readSource('docs/a.md', '# A\n\n## B\n\ntext')));
  const spans = shown.children.filter(child => child.tag === 'span'), [title, body] = spans; assert.ok(title && body); assert.equal(spans.length, 2);
  assert.equal(title.textContent, 'A'); assert.ok(title.className.split(' ').includes('prose-preview-title'));
  assert.equal(body.className, 'prose-preview-body'); assert.equal(body.textContent, 'B text');
  const [heading, paragraph] = body.children.filter(child => child.tag === 'span'); assert.ok(heading && paragraph);
  assert.ok(heading.className.split(' ').includes('prose-preview-heading')); assert.equal(heading.className.includes('prose-preview-title'), false);
  assert.equal(heading.textContent, 'B'); assert.equal(paragraph.textContent, 'text');
  assert.equal(shown.textContent, 'AB text');
  const plain = node(presentResultPreview(readSource('docs/a.md', 'one\n\ntwo')));
  assert.equal(plain.children.filter(child => child.tag === 'span').length, 1); assert.equal(plain.children.find(child => child.tag === 'span')?.className, 'prose-preview-body'); assert.equal(plain.textContent, 'one two');
});
test('frontmatter is omitted from the compact prose projection only', () => {
  setup();
  const front = '---\ntitle: Notes\ntags: [a, b]\nauthor: x\ndate: 2026\nstatus: draft\nkind: note\n---\n# Doc\n\nbody';
  const shown = node(presentResultPreview(readSource('docs/a.md', front)));
  assert.equal(shown.textContent, 'Docbody'); assert.equal(shown.children.find(child => child.tag === 'span')?.textContent, 'Doc');
  assert.equal(resultPreview(readSource('docs/a.md', front).result ?? []).startsWith('---\ntitle: Notes'), true);
  assert.equal(node(presentResultPreview(readSource('docs/a.md', '---\nnot closed\n\ntext'))).textContent.includes('not closed'), true);
  assert.equal(node(presentResultPreview(readSource('docs/a.md', 'text\n---\nmore'))).textContent.includes('text'), true);
});
test('prose classification uses only explicit content facts', () => {
  setup();
  const markdown = '# Title\n\nBody';
  const source = node(presentResultPreview(readSource('src/main.ts', markdown)));
  assert.equal(source.className, 'tool-content-preview'); assert.equal(source.tag, 'pre'); assert.equal(source.textContent, markdown);
  assert.equal(presentResultPreview(readSource('notes', markdown)), undefined);
  assert.equal(presentResultPreview(readSource('docs/a.md', markdown, 'success', 'bash')), undefined);
  assert.equal(presentResultPreview(readSource('docs/a.md', markdown, 'error')), undefined);
  assert.equal(presentResultPreview(readSource('docs/a.md', markdown, 'working')), undefined);
  assert.equal(presentResultPreview(readSource('docs/a.md', '[protected text]', 'success', 'read', true)), undefined);
  assert.equal(presentResultPreview({callId: 'tool', name: 'bash', status: 'success', result: [{type: 'text', text: '# not markdown\n**raw**'}]}), undefined);
  assert.equal(presentResultPreview({callId: 'tool', name: 'read', status: 'success', args: {value: {path: 'a.md'}, truncated: false}, result: []}), undefined);
  assert.equal(presentResultPreview({callId: 'tool', name: 'read', status: 'success', args: {value: {path: 'a.md'}, truncated: false}, result: [{type: 'text', text: '```\n```'}]}), undefined);
  assert.equal(presentResultPreview({callId: 'tool', name: 'read', status: 'success', args: {value: {file_path: 'a.markdown'}, truncated: false}, result: [{type: 'text', text: 'Hi'}]})?.textContent, 'Hi');
});
test('a structured summary is plain prose text and is never parsed as Markdown', () => {
  setup();
  const result: PartView[] = [{type: 'text', text: 'raw retained', structured: {value: {message: '**kept** [x](https://example.com)', count: 2}, truncated: true}}];
  const shown = node(presentResultPreview({callId: 'tool', name: 'custom', status: 'success', result}));
  assert.equal(shown.className, 'tool-prose-preview'); assert.equal(shown.children.length, 0);
  assert.equal(shown.textContent, resultPreview(result)); assert.match(shown.textContent, /\*\*kept\*\*/); assert.match(shown.textContent, /Partial preview\./);
  assert.equal(presentResultPreview({callId: 'tool', name: 'custom', status: 'error', result}), undefined);
  assert.equal(presentResultPreview({callId: 'tool', name: 'custom', status: 'success', result: [{type: 'text', text: '[protected text]', redacted: true, structured: {value: {hidden: 'never'}, truncated: false}}]}), undefined);
});
test('prose previews keep the shortened-text mark and bound their own nodes', () => {
  setup();
  const long = node(presentResultPreview(readSource('a.md', `# Heading\n\n${'word '.repeat(400)}`)));
  assert.match(long.textContent, /…$/);
  const dense = `${'*a* '.repeat(200)}`.trim();
  const bounded = node(presentResultPreview(readSource('a.md', dense)));
  assert.ok(walk(bounded).length < 400); assert.match(bounded.textContent, /…$/);
  const table = node(presentResultPreview(readSource('a.md', '| A | B |\n| --- | --- |\n| 1 | `two` |')));
  assert.equal(table.textContent, 'A · B 1 · two');
  const quote = node(presentResultPreview(readSource('a.md', '> quoted **text**\n\n1. one\n2. two')));
  assert.equal(quote.textContent, 'quoted text 1. one 2. two');
});

test('a prose line that ends in a labeled JSON literal reads as the sentence alone, and other lines stay literal', () => {
  const line = 'Admitted to conversation 57; the answer will report back. Result: {"sessionId":"ead53d8c-af9d-0bda-1416-21a6ba18ab6c:57","submissionId":20039}';
  assert.equal(withoutTrailingJson(line), 'Admitted to conversation 57; the answer will report back.');
  assert.equal(withoutTrailingJson('{"a":1}'), '{"a":1}'); assert.equal(withoutTrailingJson('ok {"a":1}'), 'ok {"a":1}');
  assert.equal(withoutTrailingJson('Value is [1, 2'), 'Value is [1, 2'); assert.equal(withoutTrailingJson('lowercase start here {"a":1}'), 'lowercase start here {"a":1}');
  assert.equal(resultPreview([{type: 'text', text: line}], {tidy: true}), 'Admitted to conversation 57; the answer will report back.');
  assert.equal(resultPreview([{type: 'text', text: line}]), line);
  assert.equal(resultPreview([{type: 'text', text: line, redacted: true}], {tidy: true}), line);
});
test('a collapsed result made only of identifiers shows nothing, and a known name stands in for an identity', () => {
  const session = 'ead53d8c-af9d-0bda-1416-21a6ba18ab6c:57';
  const part: PartView = {type: 'text', text: JSON.stringify({sessionId: session, submissionId: 1}), structured: {value: {sessionId: session, submissionId: 1}, truncated: false}};
  assert.equal(resultPreview([part]), ''); assert.equal(resultPreview([part], {resolve: identity => identity === session ? 'Web UI lead' : undefined}), 'Web UI lead');
});
test('a labeled JSON line is dropped from a success preview only after a line of prose', () => {
  const tidy = (text: string) => resultPreview([{type: 'text', text}], {tidy: true});
  const spawned = 'Started Scroll blank diagnosis.\nResult: {"sessionId":"7074","submissionId":16,"requestId":"spawn:1"}';
  assert.equal(tidy(spawned), 'Started Scroll blank diagnosis.');
  assert.equal(tidy('Started the task.\nIt is running.\nDetails: [1, 2, 3]\nDone.'), 'Started the task.\nIt is running.\nDone.');
  assert.equal(resultPreview([{type: 'text', text: spawned}]), spawned, 'the literal text is kept outside tidy mode, as for every error preview');
  const jsonOnly = 'Result: {"sessionId":"7074","submissionId":16}';
  assert.equal(tidy(jsonOnly), jsonOnly, 'a result that is only a labeled JSON line stays');
  assert.equal(tidy('{"a":1}\nResult: {"b":2}'), '{"a":1}\nResult: {"b":2}', 'a JSON line is not prose');
  assert.equal(tidy('Result: {"b":2}\nStarted the task.'), 'Result: {"b":2}\nStarted the task.', 'a JSON line with no prose before it stays');
  assert.equal(tidy('Started the task.\nNote: not json at all'), 'Started the task.\nNote: not json at all');
  assert.equal(tidy('Started the task.\nResult: {"broken":'), 'Started the task.\nResult: {"broken":');
  assert.equal(tidy('Started the task.\nlowercase: {"a":1}'), 'Started the task.\nlowercase: {"a":1}');
  assert.equal(tidy('Started the task.\nSupercalifragilisticexpialidocious: {"a":1}'), 'Started the task.\nSupercalifragilisticexpialidocious: {"a":1}');
  assert.equal(tidy('Started the task.\nResult: 42'), 'Started the task.\nResult: 42', 'a scalar is not an object or array');
  assert.equal(resultPreview([{type: 'text', text: spawned, redacted: true}], {tidy: true}), spawned, 'redacted text is never rewritten');
});

const KNOWN = 'ead53d8c-af9d-0bda-1416-21a6ba18ab6c:57', OTHER = '1f2e3d4c-0000-4000-8000-123456789abc';
const names = (identity: string): string | undefined => identity === KNOWN ? 'Round 12 builder K4' : undefined;
function awaitedSource(results: unknown[], extra: Record<string, unknown> = {}): ToolPresentationSource {
  const value = {results, unresolved: [], originalInputs: [1953], decision: 'settled', queuedInputCount: 19, ...extra};
  return {callId: 'wait', name: 'agent_await', status: 'success', result: [{type: 'text', text: JSON.stringify(value), structured: {value, truncated: false}}]};
}
const answered = (identity: string, answer: string, status = 'done') => ({result: {sessionId: identity, submissionId: 7, requestId: 'r'}, answer, status, answerEntryId: 4, entryId: 3});
const awaitedText = (source: ToolPresentationSource, resolve = names): string | undefined => presentResultPreview(source, resolve) ? node(presentResultPreview(source, resolve)).textContent : undefined;

test('a wait card line names the responder and quotes the first line of the answer', () => {
  setup();
  assert.equal(awaitedText(awaitedSource([answered(KNOWN, 'I reverted the change.\nSecond line.')])), 'Round 12 builder K4: “I reverted the change.”');
  const long = 'word '.repeat(30).trim(), line = awaitedText(awaitedSource([answered(KNOWN, long)])) ?? '';
  assert.equal(line, `Round 12 builder K4: “${long.slice(0, 80).trimEnd()}…”`);
  assert.doesNotMatch(line, /decision|queuedInputCount|settled/);
});
test('a wait card line uses plain words and keeps the full answer source', () => {
  setup();
  for (const [answer, expected] of [
    ['## Result\nNext text', 'Result'], ['Commit `9a852288` is **done**', 'Commit 9a852288 is done'],
    ['__Done__ with *care*', 'Done with care'], ['- first item', 'first item'],
    ['2) second item', 'second item'], ['> quoted words', 'quoted words'], ['[Pi](https://example.test)', 'Pi'],
  ]) {
    const source = awaitedSource([answered(KNOWN, answer)]), raw = source.result?.[0];
    assert.equal(awaitedText(source), `Round 12 builder K4: “${expected}”`);
    assert.equal(raw?.type === 'text' && raw.text, JSON.stringify({results: [answered(KNOWN, answer)], unresolved: [], originalInputs: [1953], decision: 'settled', queuedInputCount: 19}));
  }
});
test('a wait card line keeps its 80-character cut after mark removal and skips blank lines', () => {
  setup();
  const line = (answer: string) => awaitedText(awaitedSource([answered(KNOWN, answer)]));
  assert.equal(line(`**${'a'.repeat(80)}**`), `Round 12 builder K4: “${'a'.repeat(80)}”`);
  assert.equal(line(`**${'a'.repeat(81)}**`), `Round 12 builder K4: “${'a'.repeat(80)}…”`);
  assert.equal(line(' \r\n\t\r## Result\nNext text'), 'Round 12 builder K4: “Result”');
  assert.equal(line(' \t\n'), 'Round 12 builder K4: answer unavailable');
  assert.equal(line(`\`${'😀'.repeat(40)}\``), `Round 12 builder K4: “${'😀'.repeat(40)}”`);
  assert.equal(line(`\`${'😀'.repeat(41)}\``), `Round 12 builder K4: “${'😀'.repeat(40)}…”`);
});
test('a wait card line counts further answers and results still waiting, and marks missing answers', () => {
  setup();
  assert.equal(awaitedText(awaitedSource([answered(KNOWN, 'First'), answered(OTHER, 'Second'), answered(OTHER, 'Third')])), 'Round 12 builder K4: “First” · 2 more answers');
  assert.equal(awaitedText(awaitedSource([answered(KNOWN, 'First'), answered(OTHER, 'Second')], {unresolved: [{sessionId: OTHER}, {sessionId: OTHER}]})), 'Round 12 builder K4: “First” · 1 more answer · 2 still waiting');
  assert.equal(awaitedText(awaitedSource([answered(KNOWN, '', 'unanswered')])), 'Round 12 builder K4: no answer yet');
  assert.equal(awaitedText(awaitedSource([answered(KNOWN, '', 'unavailable')])), 'Round 12 builder K4: answer unavailable');
});
test('a wait card line says "Another conversation" for an unknown session and never shows an identifier', () => {
  setup();
  const line = awaitedText(awaitedSource([answered(OTHER, 'Done.')])) ?? '';
  assert.equal(line, 'Another conversation: “Done.”'); assert.doesNotMatch(line, /1f2e3d4c|ead53d8c/);
  assert.equal(awaitedText(awaitedSource([{answer: 'No reference', status: 'done'}])), 'Another conversation: “No reference”');
});
test('a result without a results array of objects, or from another tool, keeps the generic preview', () => {
  setup();
  const generic = (value: unknown, name = 'agent_await'): ToolPresentationSource => ({callId: 'wait', name, status: 'success', result: [{type: 'text', text: JSON.stringify(value), structured: {value, truncated: false}}]});
  for (const source of [generic({decision: 'settled', results: []}), generic({decision: 'settled', results: ['text']}), generic({decision: 'settled', results: [answered(KNOWN, 'Hi')]}, 'custom')]) {
    const expected = resultPreview(source.result ?? [], {resolve: names});
    assert.equal(awaitedText(source), expected); assert.doesNotMatch(expected, /Round 12 builder K4: “|Another conversation/);
  }
  assert.match(resultPreview(generic({decision: 'settled', results: [answered(KNOWN, 'Hi')]}, 'custom').result ?? [], {resolve: names}), /decision: settled/);
});
test('a wait released with no answers yet reads as the number of answers still awaited', () => {
  setup();
  assert.equal(awaitedText(awaitedSource([], {unresolved: [{sessionId: KNOWN}]})), 'Still waiting for 1 answer');
  assert.equal(awaitedText(awaitedSource([], {unresolved: [{sessionId: KNOWN}, {sessionId: OTHER}]})), 'Still waiting for 2 answers');
  const empty = awaitedSource([]);
  assert.equal(awaitedText(empty), resultPreview(empty.result ?? [], {resolve: names}), 'no results and nothing unresolved keeps the generic preview');
});
test('edit previews mark shared lines with a space and color only changed lines', () => {
  const {context} = setup();
  const append = {edits: [{oldText: 'a\nb.', newText: 'a\nb.\nc\nd'}]};
  const rows = (block: Node | undefined) => (block?.children ?? []).filter(child => child.tag !== '#text' || child.textContent !== '\n').map(child => [child.className, child.textContent]);
  const collapsed = node(presentToolPreview(source('edit', append)));
  assert.deepEqual(rows(collapsed), [['', 'Earlier context omitted.'], ['diff-row', '  b.\n'], ['diff-row diff-add', '+ c\n'], ['diff-row diff-add', '+ d\n']]);
  const expanded = node(presentTool(source('edit', append), context)).children.find(child => child.tag === 'pre');
  assert.deepEqual(rows(expanded), [['', 'Earlier context omitted.'], ['diff-row', '  b.\n'], ['diff-row diff-add', '+ c\n'], ['diff-row diff-add', '+ d\n']]);
  const insertion = node(presentToolPreview(source('edit', {oldText: 'x\ny\nz', newText: 'x\nI\ny\nz'})));
  assert.deepEqual(rows(insertion), [['diff-row', '  x\n'], ['diff-row diff-add', '+ I\n'], ['diff-row', '  y\n'], ['', 'Later context omitted.']]);
  const deletion = node(presentToolPreview(source('edit', {oldText: 'x\ny\nz', newText: 'x\nz'})));
  assert.deepEqual(rows(deletion), [['diff-row', '  x\n'], ['diff-row diff-del', '- y\n'], ['diff-row', '  z\n']]);
});
