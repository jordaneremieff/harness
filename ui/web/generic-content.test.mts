import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { JsonDisplay } from '../shared/api.ts';
import { presentArguments, presentResult, PreviewBudget, previewLimits, structuredResultPreview } from './generic-content.ts';
import type { PresentationContext } from './transcript-presentation.ts';

class DomNode extends EventTarget {
  childNodes: DomNode[] = []; className = ''; open = false; parent?: DomNode;
  style: Record<string, unknown> = {}; dataset: Record<string, unknown> = {};
  private text = '';
  readonly tag: string;
  constructor(tag: string) { super(); this.tag = tag; }
  get textContent(): string { return this.text + this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value: string) {
    this.text = this.tag === '#text' ? value : ''; this.childNodes = [];
    if (this.tag !== '#text' && value) { const node = new DomNode('#text'); node.textContent = value; this.append(node); }
  }
  append(...nodes: DomNode[]): void {
    for (const node of nodes) {
      if (node.tag === '#fragment') this.append(...node.childNodes);
      else { node.parent = this; this.childNodes.push(node); }
    }
  }
  prepend(...nodes: DomNode[]): void {for (const node of nodes) node.parent = this; this.childNodes.unshift(...nodes);}
  remove(): void { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter(child => child !== this); }
  querySelectorAll(selector: string): DomNode[] { return descendants(this).filter(child => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tag === selector); }
  querySelector(selector: string): DomNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  setAttribute(key: string, value: string): void { this.dataset[key] = value; if (key === 'class') this.className = value; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
}
function descendants(node: DomNode): DomNode[] { return [node, ...node.childNodes.flatMap(descendants)]; }
function cast(node: HTMLElement | undefined): DomNode { assert.ok(node); return node as unknown as DomNode; }
function classes(node: DomNode, name: string): DomNode[] { return descendants(node).filter(child => child.className.split(' ').includes(name)); }
function open(node: DomNode): void { node.open = true; node.dispatchEvent(new Event('toggle')); }
function frames(node: DomNode): void {
  for (const pre of node.querySelectorAll('pre')) {
    assert.equal(pre.childNodes.length, 1);
    const frame = pre.childNodes[0]; assert.ok(frame);
    assert.equal(frame.tag, 'span'); assert.equal(frame.className, 'pre-text-frame');
    assert.equal(classes(pre, 'pre-text-frame').length, 1);
    assert.equal(frame.textContent, pre.textContent);
  }
}
function bounded(node: DomNode): void {
  frames(node);
  assert.ok(node.textContent.length <= 16384, `Text count ${node.textContent.length}`);
  assert.ok(descendants(node).length <= 512, `Node count ${descendants(node).length}`);
  assert.equal(node.textContent.isWellFormed(), true);
}
const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
function setup(): PresentationContext {
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {
    createElement: (tag: string) => new DomNode(tag),
    createElementNS: (_namespace: string, tag: string) => new DomNode(tag),
    createDocumentFragment: () => new DomNode('#fragment'),
    createTextNode: (text: string) => { const node = new DomNode('#text'); node.textContent = text; return node; },
  }});
  return {
    bounded: (text, limit = 65536) => text.slice(0, limit),
    rawText: () => { throw new Error('Raw rendering belongs to the outer renderer'); },
    inspection: () => { throw new Error('Raw inspection belongs to the outer renderer'); },
    structured: () => { throw new Error('Generic previews do not duplicate raw structure'); },
  };
}
function result(value: unknown, context = setup()): DomNode { return cast(presentResult({value, truncated: false}, context)); }
function args(value: unknown, context = setup()): DomNode { return cast(presentArguments({value, truncated: false}, context)); }

test('explicit shell command presentation colors only the root command and retains supplied text and bounds', () => {
  const context = setup(), command = 'if test "$READY" = 1; then\n  printf "<script>😀"\nfi';
  const value = {command, content: 'echo plain', nested: {command: 'echo nested'}, timeout: 30}; const retained = JSON.stringify(value);
  const plain = cast(presentArguments({value, truncated: false}, context)); assert.equal(classes(plain, 'syn-keyword').length, 0);
  const shown = cast(presentArguments({value, truncated: false}, context, undefined, {shellCommand: true}));
  const sources = classes(shown, 'tool-source');
  const root = sources.find(source => source.querySelector('summary')?.textContent === 'command'); assert.ok(root);
  assert.equal(root.querySelector('pre')?.textContent, command); assert.ok(classes(root, 'syn-keyword').length > 0); assert.ok(classes(root, 'syn-string').length > 0);
  for (const source of sources.filter(source => source !== root)) assert.equal(descendants(source).some(child => child.className.startsWith('syn-')), false);
  assert.equal(JSON.stringify(value), retained); bounded(shown);
  const long = cast(presentArguments({value: {command: 'echo "😀"\n'.repeat(10000)}, truncated: true}, context, undefined, {shellCommand: true}));
  bounded(long); assert.match(long.textContent, /Preview shortened|Some output was not retained/);
});
test('collapsed summaries prefer useful payloads and explicit facts over reordered transport metadata', () => {
  for (const value of [
    {cursor: 'next', digest: 'hash', coverage: {complete: true}, document: '# Actual document\nUseful excerpt', count: 2},
    {document: '# Actual document\nUseful excerpt', count: 2, coverage: {complete: true}, digest: 'hash', cursor: 'next'},
  ]) {
    const before = JSON.stringify(value), shown = structuredResultPreview({value, truncated: false}); assert.ok(shown);
    assert.match(shown, /^# Actual document/); assert.match(shown, /count: 2/);
    assert.doesNotMatch(shown, /cursor|digest|coverage/); assert.equal(JSON.stringify(value), before);
  }
  const shown = structuredResultPreview({value: {cursor: 'next', metadata: {digest: 'hash', document: 'Actual nested content', warning: 'Source incomplete'}, count: 3}, truncated: false});
  assert.match(shown ?? '', /metadata\.warning: Source incomplete/); assert.match(shown ?? '', /Actual nested content/);
  assert.match(shown ?? '', /count: 3/); assert.doesNotMatch(shown ?? '', /digest|cursor/);
});
test('frontmatter document summaries show body words without plain catalog facts', () => {
  const page = {
    format: 'guide', name: 'sample-guide', contentDigest: 'a'.repeat(64), bodyBytes: 900, offset: 0, endOffset: 900,
    text: '---\ntitle: "Sample Guide"\nsummary: "x"\n---\n\n# Sample Guide\n\n## Overview\n\nThis guide explains how the sample works.\nA later line stays expanded.',
  };
  const entry = {ok: true, kind: 'entry', name: 'n', content: '---\ntitle: "T"\n---\n\n# T\n\n## Details\n\nA plain **sample** with `code`.'};
  for (const [value, expected] of [[page, 'This guide explains how the sample works.'], [entry, 'A plain sample with code.']] as const) {
    const before = JSON.stringify(value);
    assert.equal(structuredResultPreview({value, truncated: false}), expected);
    assert.equal(JSON.stringify(value), before);
    const expanded = result(value); assert.match(expanded.textContent, /title:/); bounded(expanded);
    const supplied = args(value); assert.match(supplied.textContent, /title:/); bounded(supplied);
    assert.equal(JSON.stringify(value), before);
  }
});
test('frontmatter summaries retain explicit facts and partial or limited scan notices', () => {
  const text = '---\ntitle: Sample\n---\n# Sample\n\nDocument words.';
  for (const [key, value, expected] of [
    ['errors', ['bad'], 'errors: 1 item'], ['warning', 'Check source', 'warning: Check source'],
    ['truncated', true, 'truncated: true'], ['omissions', 2, 'omissions: 2'],
  ] as const) {
    assert.equal(structuredResultPreview({value: {text, [key]: value, status: 'ready'}, truncated: false}), `${expected} · Document words.`);
  }
  const value = {text, ...Object.fromEntries(Array.from({length: 24}, (_, i) => [`field${i}`, i]))};
  assert.equal(structuredResultPreview({value, truncated: true}), 'Document words. · Partial preview. Summary scan limited.');
});
test('frontmatter summaries use heading words or no document words when the body has no prose', () => {
  assert.equal(structuredResultPreview({value: {text: '---\ntitle: x\n---\n# Only heading\n\n###### Later heading', kind: 'guide'}, truncated: false}), 'Only heading');
  for (const text of ['---\ntitle: x\n---', '---\ntitle: x\n---\n\n \t']) {
    assert.equal(structuredResultPreview({value: {text, kind: 'guide'}, truncated: false}), '');
    assert.equal(structuredResultPreview({value: {text, kind: 'guide'}, truncated: true}), 'Partial preview.');
    assert.equal(structuredResultPreview({value: {text, errors: ['bad']}, truncated: false}), 'errors: 1 item');
  }
  assert.equal(structuredResultPreview({value: {text: '\uFEFF--- \r\ntitle: x\r\n---\t\r\n\r\n# Title\r\n\r\n> A [sample](https://example.com) line.'}, truncated: false}), 'A sample line.');
  const long = structuredResultPreview({value: {text: `---\ntitle: x\n---\n# Title\n${'😀'.repeat(50)}\nLater line`}, truncated: false});
  assert.ok(long); assert.ok(long.length <= 240); assert.equal(long.includes('\n'), false); assert.equal(long.isWellFormed(), true);
});
test('non-frontmatter summaries retain literal prefixes and plain facts', () => {
  assert.equal(structuredResultPreview({value: {text: '---\ntitle: x\nno end', status: 'queued'}, truncated: false}), '---\ntitle: x · status: queued');
  assert.equal(structuredResultPreview({value: {text: 'plain', status: 'queued'}, truncated: false}), 'plain · status: queued');
  assert.equal(structuredResultPreview({value: {text: '# Heading\nBody', status: 'queued'}, truncated: false}), '# Heading\nBody · status: queued');
});
test('summary warnings, outcomes and array counts remain supplied facts with explicit partial coverage', () => {
  const shown = structuredResultPreview({value: {cursor: 'next', document: 'Useful document', error: {message: 'Request refused'}, status: 'failed'}, truncated: false});
  assert.match(shown ?? '', /error\.message: Request refused/); assert.match(shown ?? '', /Useful document/); assert.match(shown ?? '', /status: failed/);
  assert.equal(structuredResultPreview({value: {cursor: 'next', rows: [{id: 1}, {id: 2}]}, truncated: false}), 'rows: 2 items');
  const partial = structuredResultPreview({value: {cursor: 'next', records: [{id: 1}]}, truncated: true});
  assert.match(partial ?? '', /records: Array preview limited/); assert.match(partial ?? '', /Partial preview/); assert.doesNotMatch(partial ?? '', /1 item/);
  assert.match(structuredResultPreview({value: 'retained scalar', truncated: true}) ?? '', /retained scalar · Partial preview/);
});
test('summary selection bounds field scans and depth, never evaluates getters, and names incomplete search', () => {
  const value = Object.fromEntries(Array.from({length: 24}, (_, i) => [`cursor_${i}`, i]));
  Object.defineProperty(value, 'outside', {enumerable: true, get: () => {throw new Error('Outside scan');}});
  const shown = structuredResultPreview({value, truncated: false}); assert.ok(shown);
  assert.match(shown, /Summary scan limited/); assert.doesNotMatch(shown, /outside/); assert.ok(shown.length <= 240);
  const cycle: Record<string, unknown> = {body: 'Retained cycle document'}; cycle.again = cycle;
  assert.match(structuredResultPreview({value: cycle, truncated: false}) ?? '', /Retained cycle document.*Summary scan limited/);
  let nested: unknown = {body: 'Outside depth'};
  for (let i = 0; i < 10; i++) nested = {payload: nested};
  const deep = structuredResultPreview({value: nested, truncated: false}); assert.ok(deep);
  assert.match(deep, /Summary scan limited/); assert.doesNotMatch(deep, /Outside depth/);
  let reads = 0; const broad = Object.fromEntries(Array.from({length: 24}, (_, i) => [`metadata_${i}`, Object.fromEntries(Array.from({length: 24}, (_, j) => [`metadata_${j}`, j]))]));
  const guarded = new Proxy(broad, {getOwnPropertyDescriptor: (target, key) => {reads++; return Reflect.getOwnPropertyDescriptor(target, key);}});
  const limited = structuredResultPreview({value: guarded, truncated: false}); assert.ok(limited);
  assert.match(limited, /Summary scan limited/); assert.ok(reads <= 49);
});
test('structured collapsed summaries use at most three supplied facts or an array count', () => {
  const display = (value: unknown): JsonDisplay => ({value, truncated: false});
  assert.equal(structuredResultPreview(undefined), undefined);
  assert.equal(structuredResultPreview(display(undefined)), undefined);
  assert.equal(structuredResultPreview(display({alpha: 'kept', count: 0, ready: true, ignored: 'only after expansion'})), 'alpha: kept · count: 0 · ready: true');
  assert.equal(structuredResultPreview(display({nested: {role: 'assistant'}, records: [1, 2], nullable: null})), 'records: 2 items · nullable: null · nested');
  assert.equal(structuredResultPreview(display([])), '0 items'); assert.equal(structuredResultPreview(display([{}])), '1 item');
  assert.equal(structuredResultPreview(display([{}, {}, {}])), '3 items');
  assert.equal(structuredResultPreview(display({})), 'Empty object');
  for (const value of [0, false, null, 'literal']) assert.equal(structuredResultPreview(display(value)), String(value));
});
test('limited array summaries do not present a projected length as the original item count', () => {
  for (const display of [
    {value: ['one', 'two'], truncated: true},
    {value: ['one', '[omitted]'], truncated: true},
    {value: [], truncated: true},
  ]) {
    const before = JSON.stringify(display);
    const summary = structuredResultPreview(display);
    assert.equal(summary, 'Array preview limited'); assert.equal(JSON.stringify(display), before);
    assert.ok(summary.length <= 240); assert.ok(summary.split('\n').length <= 2);
    assert.doesNotMatch(summary, /\d/);
  }
  assert.equal(structuredResultPreview({value: ['one', 'two'], truncated: false}), '2 items');
  const complete = {value: ['one', '[omitted]'], truncated: false}; const before = JSON.stringify(complete);
  assert.equal(structuredResultPreview(complete), '2 items'); assert.equal(JSON.stringify(complete), before);
  assert.equal(structuredResultPreview({...complete, truncated: true}), 'Array preview limited');
  assert.equal(structuredResultPreview({value: ['one'], truncated: false}), '1 item');
  assert.equal(structuredResultPreview({value: [], truncated: false}), '0 items');
});
test('structured summaries never decode text or derive a role or lifecycle state', () => {
  const text = '{"role":"assistant","status":"success"}';
  assert.equal(structuredResultPreview({value: text, truncated: false}), text);
  assert.equal(structuredResultPreview({value: {message: text}, truncated: true}), `message: ${text} · Partial preview.`);
  assert.equal(structuredResultPreview({value: {role: 'assistant', status: 'success'}, truncated: false}), 'role: assistant · status: success');
});
test('structured summaries bound keys and strings without evaluating getters or nested values', () => {
  let reads = 0;
  const value = {['😀'.repeat(500)]: '😀'.repeat(500), second: 'line1\nline2', third: 'kept', fourth: 'not in summary'};
  const shown = structuredResultPreview({value, truncated: false}); assert.ok(shown);
  assert.ok(shown.length <= 240); assert.ok(shown.split('\n').length <= 2); assert.equal(shown.isWellFormed(), true);
  assert.equal(shown, 'second: line1 · third: kept · fourth: not in summary');
  const guarded = {next: 7}; Object.defineProperty(guarded, 'protected', {enumerable: true, get: () => { reads++; throw new Error('Getter invoked'); }});
  assert.equal(structuredResultPreview({value: guarded, truncated: false}), 'next: 7 · protected'); assert.equal(reads, 0);
  const unchanged = JSON.stringify(value); structuredResultPreview({value, truncated: true}); assert.equal(JSON.stringify(value), unchanged);
});
test('collapsed summaries leave full rich fields and omission callbacks in the shared expanded budget', () => {
  const context = setup(); let calls = 0;
  const value = {alpha: 'A', beta: 0, gamma: true, delta: 'D'};
  const display = {value, truncated: false};
  assert.equal(structuredResultPreview(display), 'alpha: A · beta: 0 · gamma: true');
  const expanded = cast(presentResult(display, context)); assert.match(expanded.textContent, /deltaD/); bounded(expanded);
  const budget = new PreviewBudget({copySavedText: () => { calls++; }});
  const argument = cast(presentArguments({value: {code: 'x'.repeat(10000)}, truncated: false}, context, budget));
  const result = cast(presentResult({value: {body: 'y'.repeat(6000)}, truncated: true}, context, budget));
  assert.ok([argument, result].reduce((sum, node) => sum + descendants(node).length, 0) <= 512);
  assert.ok(argument.textContent.length + result.textContent.length <= 16384);
  assert.equal([argument, result].flatMap(node => classes(node, 'preview-omission')).length, 1);
  const action = result.querySelectorAll('button')[0]; assert.ok(action); assert.equal(action.textContent, 'Copy saved text');
  assert.match(result.textContent, /Some output was not retained/); action.dispatchEvent(new Event('click')); assert.equal(calls, 1);
  assert.equal(value.delta, 'D');
});
test('structured preview limits describe the shared bounds for tool details', () => {
  assert.match(previewLimits(), /8192 characters and 80 lines per document/);
  assert.match(previewLimits(), /16384 total characters \(112 reserved for the notice\)/);
  assert.match(previewLimits(), /24 fields per object, 12 rows per array, 6 table columns, depth 8/);
  assert.match(previewLimits(), /128 visited values, 2048 scanned fields, and 512 display nodes/);
});
test('only a supplied projection produces a result preview and arguments retain their record contract', () => {
  const context = setup();
  assert.equal(presentResult(undefined, context), undefined);
  assert.equal(presentArguments(undefined, context), undefined);
  for (const value of [null, 42, 'text', []]) assert.equal(presentArguments({value, truncated: false}, context), undefined);
  assert.equal(presentArguments({value: {}, truncated: false}, context), undefined);
});

test('complete projected documents bypass raw paging and use bounded readable previews', () => {
  const body = `# Complete document\n\n${'x'.repeat(90000)}\nRetained tail`;
  const projection = {value: {body}, truncated: false};
  const node = cast(presentResult(projection, setup()));
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Complete document');
  assert.ok(classes(node, 'tool-document')[0]);
  assert.match(node.textContent, /Preview shortened/);
  assert.doesNotMatch(node.textContent, /Retained tail/);
  assert.equal(projection.value.body, body); bounded(node);
});

test('decoded nested records stack labeled fields and expose documents without disclosures', () => {
  const node = result({results: [{record: {role: 'writer', content: '# Title\n\nDecoded paragraph', usage: {input: 10}}}]});
  assert.equal(node.querySelectorAll('table').length, 0);
  assert.equal(classes(node, 'tool-record').length, 0);
  assert.doesNotMatch(node.textContent, /results\.1|record|rolewriter/);
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Title');
  assert.match(node.textContent, /Decoded paragraph/); assert.doesNotMatch(node.textContent, /input10/);
  assert.equal(node.querySelectorAll('details').length, 1);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.match(meta.textContent, /results\.1\.record\.usage\.input10/);
  assert.match(meta.textContent, /results\.1\.record\.content/); assert.match(meta.textContent, /results\.1\.record\.rolewriter/); bounded(node);
});

test('short uniform rows use a shallow table with all ordered keys', () => {
  const node = result({rows: Array.from({length: 20}, (_, i) => ({id: i, ready: true, empty: null, count: 2.5, label: 'x'.repeat(80), state: 'ok'}))});
  assert.equal(node.querySelectorAll('table').length, 1);
  assert.equal(node.querySelectorAll('th').length, 6);
  assert.equal(node.querySelectorAll('tbody')[0]?.childNodes.length, 12);
  assert.equal(node.querySelectorAll('td').length, 72);
  assert.equal(node.querySelectorAll('details').length, 0);
  assert.match(node.textContent, /Preview shortened/); bounded(node);
});

test('long, nested, mismatched, reordered, multiline and wide rows never use a table', () => {
  for (const rows of [
    [{body: 'x'.repeat(81)}], [{body: 'line\nline'}], [{body: {text: 'nested'}}], [{body: ['nested']}],
    [{a: 1}, {b: 2}], [{a: 1}, {a: 2, b: 3}], [{a: 1, b: 2}, {b: 3, a: 4}],
    [{a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7}],
    [{['x'.repeat(33)]: 'too wide'}], [{'multi\nline': 'header'}], [{value: Infinity}], [{value: NaN}],
    [{a: 1}, 'other'], [{metadata: {note: 'hidden'}, a: 1}],
  ]) {
    const node = result({rows}); assert.equal(node.querySelectorAll('table').length, 0);
    assert.equal(classes(node, 'tool-row-content').length, 0); bounded(node);
  }
  const node = result({rows: [{body: '# Visible\nBody'}, {body: 'x'.repeat(10000)}]});
  assert.equal(classes(node, 'tool-document').length, 1);
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Visible');
  assert.equal(node.querySelectorAll('details').length, 1);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.match(meta.textContent, /rows\.1\.body|rows\.2\.body/); assert.doesNotMatch(meta.textContent, /Visible|x{100}/);
});

test('all displayed rows decide table eligibility including the final row and exact header boundary', () => {
  const rows = Array.from({length: 12}, () => ({a: 'short'})); rows[11] = {a: 'x'.repeat(81)};
  assert.equal(result({rows}).querySelectorAll('table').length, 0);
  const displayed = Array.from({length: 12}, () => ({a: 'short'})); displayed.push({a: 'line\nnot displayed'});
  assert.equal(result({rows: displayed}).querySelectorAll('table').length, 1);
  assert.equal(result({rows: [{['x'.repeat(32)]: 'ok'}]}).querySelectorAll('table').length, 1);
});

test('classification precedes the field, visit and text budgets and preserves order within each rank', () => {
  const value = Object.fromEntries(Array.from({length: 2000}, (_, i) => [`provenance_${i}`, {unused: i}]));
  value.body = '# Late body\nReadable before metadata'; value.otherBody = '# Second body\nSecond paragraph';
  const node = result(value);
  assert.deepEqual(node.querySelectorAll('h1').map(h => h.textContent), ['Late body', 'Second body']);
  assert.equal(classes(node, 'tool-document').length, 2);
  assert.match(node.textContent, /Readable before metadata/);
  assert.doesNotMatch(node.textContent, /unused/);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta);
  assert.equal(node.childNodes[node.childNodes.length - 2], meta);
  assert.equal(classes(node, 'preview-omission').length, 1);
  assert.match(node.textContent, /Preview shortened/); bounded(node);
});

test('the own-field scan stops at 2048 without evaluating accessors or fields outside the scan', () => {
  const value = Object.fromEntries(Array.from({length: 2047}, (_, i) => [`provenance_${i}`, 'hidden']));
  value.body = '# Boundary body\nReadable'; value.outside = '# Outside body\nNot read';
  const node = result(value); assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Boundary body');
  assert.doesNotMatch(node.textContent, /Outside body/); assert.match(node.textContent, /Preview shortened/);
  const getter = Object.create(null); getter.body = '# Own body\nSafe';
  Object.defineProperty(getter, 'hidden', {enumerable: true, get: () => { throw new Error('Do not invoke getters'); }});
  assert.match(result(getter).textContent, /Safe/);
});

test('status and identity outcomes remain visible and explicit flags never become metadata', () => {
  for (const value of [{id: 'abc', status: 'done'}, {status: 'failed', error: 'Explicit error', content_digest_truncated: true, omissions: 'Some entries omitted'}]) {
    const node = result(value); assert.equal(node.querySelectorAll('details').length, 0);
    for (const [key, child] of Object.entries(value)) assert.match(node.textContent, new RegExp(`${key}${child}`));
  }
  for (const value of [null, 42, true, 'done']) assert.match(result(value).textContent, new RegExp(`Result${value}`));
  const node = result({body: '# Body\nVisible', metadata: {error: 'Visible error', truncated: true, note: 'Hidden note'}, usage: {omissions: 'Visible omission', count: 12}});
  assert.match(node.textContent, /metadata\.errorVisible error/); assert.match(node.textContent, /metadata\.truncatedtrue/);
  assert.match(node.textContent, /usage\.omissionsVisible omission/); assert.doesNotMatch(node.textContent, /Hidden note|count12/);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.doesNotMatch(meta.textContent, /Visible error|Visible omission|truncatedtrue/);
  assert.match(meta.textContent, /metadata\.noteHidden note/); assert.match(meta.textContent, /usage\.count12/);
});

test('metadata uses one lazy disclosure with source paths and no budget reset on toggles', () => {
  const context = setup(); let calls = 0;
  context.bounded = (text, limit = 65536) => { calls++; return text.slice(0, limit); };
  const node = result({metadata: {note: 'top'}, body: '# Payload\nFirst', nested: {body: '# Nested\nSecond', metadata: {note: 'nested'}}, usage: {input: 3}}, context);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta);
  assert.equal(meta.open, false); assert.equal(meta.childNodes.length, 1);
  assert.doesNotMatch(node.textContent, /top|input3/);
  open(meta); assert.match(meta.textContent, /metadata\.notetop/); assert.match(meta.textContent, /nested\.metadata\.notenested/);
  assert.match(meta.textContent, /usage\.input3/);
  const count = descendants(node).length; const text = node.textContent; const builtCalls = calls;
  meta.open = false; meta.dispatchEvent(new Event('toggle')); open(meta);
  assert.equal(descendants(node).length, count); assert.equal(node.textContent, text); assert.equal(calls, builtCalls);
  assert.equal(classes(node, 'tool-metadata').length, 1); bounded(node);
});

test('long single-line metadata stays lazy while multiline documents and named payloads stay visible', () => {
  for (const argumentsMode of [false, true]) {
    const context = setup(); const budget = new PreviewBudget();
    const display = {value: {usage: {note: 'deferred statistic '.repeat(900), arbitrary: '# Document\nVisible prose', body: 'named payload '.repeat(100)}}, truncated: false};
    const node = cast((argumentsMode ? presentArguments : presentResult)(display, context, budget));
    assert.doesNotMatch(node.textContent, /deferred statistic/);
    assert.match(node.textContent, /Visible prose/); assert.match(node.textContent, /named payload/);
    const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); assert.equal(meta.childNodes.length, 1);
    const before = budget.text; open(meta); assert.ok(budget.text < before);
    assert.match(meta.textContent, /usage\.note/); assert.doesNotMatch(meta.textContent, /deferred statistic/);
    assert.doesNotMatch(meta.textContent, /Visible prose|named payload/);
    assert.match(node.textContent, /Preview shortened/); bounded(node);
  }
});

test('nested metadata flags remain visible while scalar statistics stay collapsed', () => {
  const node = result({usage: {stats: {warning: 'Retained warning', count: 12, nested: {error: 'Retained error', truncated: true, omitted: 3, omission: 'Retained omission'}}}, body: '# Document\nReadable'});
  assert.match(node.textContent, /usage\.stats\.warningRetained warning/);
  assert.match(node.textContent, /usage\.stats\.nested\.errorRetained error/);
  assert.match(node.textContent, /usage\.stats\.nested\.truncatedtrue/);
  assert.match(node.textContent, /usage\.stats\.nested\.omitted3/);
  assert.match(node.textContent, /usage\.stats\.nested\.omissionRetained omission/);
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Document');
  assert.doesNotMatch(node.textContent, /count12/);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.match(meta.textContent, /usage\.stats\.count12/);
  assert.doesNotMatch(meta.textContent, /Retained warning|Retained error|Retained omission|truncatedtrue|omitted3/); bounded(node);
});

test('mixed transport wrappers expose their payload document and retain headers as metadata', () => {
  const node = result({transport: {headers: {code: 200, accept: 'plain'}, payload: {body: '# Document\nReadable', id: 7, status: 'done'}}});
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Document'); assert.match(node.textContent, /transport\.payload\.body/);
  assert.doesNotMatch(node.textContent, /transport\.payload\.id7|transport\.payload\.statusdone|code200|acceptplain/);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.match(meta.textContent, /transport\.payload\.id7/); assert.match(meta.textContent, /transport\.payload\.statusdone/);
  assert.match(meta.textContent, /transport\.headers\.code200/); assert.match(meta.textContent, /transport\.headers\.acceptplain/);
  assert.doesNotMatch(meta.textContent, /Readable/);
  assert.equal(node.querySelectorAll('h1').length, 1); bounded(node);
});

test('promoted payload records retain their own scalar metadata without duplicate document or warning paths', () => {
  const node = result({transport: {payload: {body: '# Body\nReadable payload', id: 1, usage: {stats: {count: 7, warning: 'Nested warning'}}}, headers: {code: 200}}});
  assert.match(node.textContent, /transport\.payload\.usage\.stats\.warningNested warning/);
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Body'); assert.doesNotMatch(node.textContent, /count7|code200/);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.match(meta.textContent, /transport\.payload\.usage\.stats\.count7/); assert.match(meta.textContent, /transport\.headers\.code200/);
  assert.doesNotMatch(meta.textContent, /Readable payload|Nested warning/);
  assert.equal(node.textContent.split('Nested warning').length - 1, 1); assert.equal(node.querySelectorAll('h1').length, 1); bounded(node);
  const document = result({metadata: '# Metadata document\nVisible text'});
  const disclosure = classes(document, 'tool-metadata')[0]; if (disclosure) open(disclosure);
  assert.equal(document.querySelectorAll('h1').length, 1); assert.equal(document.textContent.split('Visible text').length - 1, 1); bounded(document);
});

test('generic payload keys lift useful records without lifting ordinary scalar stats or headers', () => {
  for (const key of ['payload', 'content', 'body', 'text', 'document', 'data', 'records', 'results', 'items', 'entries', 'value']) {
    const node = result({usage: {stats: {[key]: {id: 7, label: 'readable'}}}});
    assert.ok(node.textContent.includes(`usage.stats.${key}.id7`));
    assert.ok(node.textContent.includes(`usage.stats.${key}.labelreadable`));
    const meta = classes(node, 'tool-metadata')[0]; if (meta) { open(meta); assert.doesNotMatch(meta.textContent, /readable|id7/); }
    bounded(node);
  }
  const scalar = result({status: 'done', usage: {stats: {count: 12, value: 3}, headers: {accept: 'plain', code: 200}}});
  assert.match(scalar.textContent, /statusdone/); assert.doesNotMatch(scalar.textContent, /count12|value3|acceptplain|code200/);
  assert.equal(classes(scalar, 'tool-document').length, 0);
});

test('metadata record arrays lift documents and flags once with complete source labels', () => {
  const node = result({metadata: {records: [{id: 1, body: '# First\nFirst paragraph', warning: 'First warning'}, {id: 2, body: '# Second\nSecond paragraph'}], stats: {count: 2}}});
  assert.deepEqual(node.querySelectorAll('h1').map(h => h.textContent), ['First', 'Second']);
  assert.match(node.textContent, /metadata\.records\.1\.body/); assert.match(node.textContent, /metadata\.records\.2\.body/);
  assert.match(node.textContent, /metadata\.records\.1\.warningFirst warning/);
  assert.equal(node.querySelectorAll('table').length, 0);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.doesNotMatch(meta.textContent, /First paragraph|Second paragraph|First warning/);
  assert.equal(node.textContent.split('First paragraph').length - 1, 1);
  assert.equal(node.textContent.split('First warning').length - 1, 1); bounded(node);
});

test('promoted flags preserve source order within their category before documents', () => {
  const node = args({usage: {left: {warning: 'First', details: {error: 'Deep first'}}, right: {warning: 'Second'}, stats: {warnings: 'Third'}}, warning: 'Root last', body: '# Visible\nBody'});
  assert.deepEqual(classes(node, 'kv').map(pair => pair.textContent), ['usage.left.warningFirst', 'usage.left.details.errorDeep first', 'usage.right.warningSecond', 'usage.stats.warningsThird', 'warningRoot last']);
  assert.equal(classes(node, 'tool-document')[0]?.textContent, '# Visible\nBody');
  assert.ok(node.textContent.indexOf('warningRoot last') < node.textContent.indexOf('Body'));
});

test('documents precede promoted flags while flags retain source order within their category', () => {
  const node = result({usage: {left: {warning: 'First', details: {error: 'Deep first'}}, right: {warning: 'Second'}, stats: {warnings: 'Third'}}, warning: 'Root last', body: '# Visible\nBody'});
  assert.deepEqual(classes(node, 'kv').map(pair => pair.textContent), ['usage.left.warningFirst', 'usage.left.details.errorDeep first', 'usage.right.warningSecond', 'usage.stats.warningsThird', 'warningRoot last']);
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Visible');
  assert.ok(node.textContent.indexOf('Body') < node.textContent.indexOf('usage.left.warning'));
});

test('metadata classification respects shared scans, depth, cycles and accessor safety', () => {
  const context = setup(); const budget = new PreviewBudget();
  const metadata = Object.fromEntries(Array.from({length: 2100}, (_, i) => [`field${i}`, i])); metadata.warning = 'Outside scan';
  const node = cast(presentResult({value: {metadata, body: {text: '# Nested body\nReadable first'}}, truncated: false}, context, budget));
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Nested body');
  assert.ok(budget.scanned <= 2048); assert.match(node.textContent, /Preview shortened/); assert.doesNotMatch(node.textContent, /Outside scan|No warnings/); bounded(node);
  const cyclic = Object.create(null); cyclic.warning = 'Cycle warning'; cyclic.loop = cyclic;
  const cycle = result({usage: {data: cyclic}, body: '# Safe\nReadable'});
  assert.equal(cycle.textContent.split('Cycle warning').length - 1, 1); assert.match(cycle.textContent, /Preview shortened/); bounded(cycle);
  const guarded = Object.create(null); guarded.count = 3;
  Object.defineProperty(guarded, 'warning', {enumerable: true, get: () => { throw new Error('Do not invoke metadata accessors'); }});
  const safe = result({usage: {stats: guarded}, body: '# Own body\nSafe'}); assert.equal(safe.querySelectorAll('h1')[0]?.textContent, 'Own body'); assert.match(safe.textContent, /Preview shortened/); bounded(safe);
  let deep: unknown = {warning: 'Beyond depth'}; for (let i = 0; i < 9; i++) deep = {child: deep};
  const depth = result({usage: deep, body: '# Depth body\nReadable'});
  assert.match(depth.textContent, /Preview shortened/); assert.doesNotMatch(depth.textContent, /Beyond depth/); bounded(depth);
});

test('metadata payload traversal precedes large header scans and never decodes serialized strings', () => {
  const headers = Object.fromEntries(Array.from({length: 2100}, (_, i) => [`header${i}`, 'short']));
  const node = result({transport: {headers, payload: {body: '# Kept body\nReadable'}}, metadata: {hidden: '{"body":"# Hidden\\nLiteral"}'}});
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Kept body'); assert.match(node.textContent, /transport\.payload\.body/);
  assert.equal(node.querySelectorAll('h1').length, 1); assert.match(node.textContent, /Preview shortened/); bounded(node);
});

test('one omission note distinguishes host cuts from local preview cuts outside metadata', () => {
  const node = cast(presentResult({value: {metadata: {note: 'hidden'}, body: '# Kept\nBody'}, truncated: true}, setup()));
  // Source omissions remain distinct from local display cuts.
  assert.match(node.textContent, /Some output was not retained/);
  assert.doesNotMatch(node.textContent, /Preview shortened/);
  const notice = node.childNodes.find(child => child.textContent === 'Some output was not retained.'); assert.ok(notice);
  assert.equal(notice.parent, node);
  const long = cast(presentResult({value: {body: 'x'.repeat(10000)}, truncated: true}, setup()));
  assert.match(long.textContent, /Preview shortened\. Some output was not retained\./);
  assert.equal(classes(long, 'preview-omission').length, 1); bounded(long);
});

test('generic omission notices promise no action without an owner callback', () => {
  const context = setup();
  for (const [body, truncated, expected] of [
    ['Kept body', false, undefined],
    ['x'.repeat(10000), false, 'Preview shortened.'],
    ['Kept body', true, 'Some output was not retained.'],
    ['x'.repeat(10000), true, 'Preview shortened. Some output was not retained.'],
  ] as const) {
    const display = {value: {body}, truncated};
    const node = cast(presentResult(display, context));
    assert.equal(classes(node, 'preview-omission')[0]?.textContent, expected);
    assert.equal(node.querySelectorAll('button').length, 0);
    assert.doesNotMatch(node.textContent, /Open Raw|Copy for|saved output|saved text/);
    assert.equal(display.value.body, body); assert.equal(display.truncated, truncated); bounded(node);
  }
});
test('omission actions invoke only their supplied owner callbacks at the notice', () => {
  const context = setup(); let shown = 0; let copied = 0;
  const budget = new PreviewBudget({showSavedOutput: () => { shown++; }, copySavedText: () => { copied++; }});
  const node = cast(presentResult({value: {body: 'x'.repeat(10000), metadata: {digest: 'exact digest'}}, truncated: true}, context, budget));
  const notice = classes(node, 'preview-omission')[0]; assert.ok(notice);
  const buttons = notice.querySelectorAll('button');
  assert.deepEqual(buttons.map(node => node.textContent), ['Show saved output', 'Copy saved text']);
  assert.equal(shown, 0); assert.equal(copied, 0);
  buttons[0].dispatchEvent(new Event('click')); assert.equal(shown, 1); assert.equal(copied, 0);
  buttons[1].dispatchEvent(new Event('click')); assert.equal(shown, 1); assert.equal(copied, 1);
  const metadata = classes(node, 'tool-metadata')[0]; assert.ok(metadata);
  assert.equal(metadata.childNodes[0].textContent, 'Details'); assert.equal(metadata.childNodes.length, 1);
  open(metadata); assert.match(metadata.textContent, /metadata\.digestexact digest/);
  budget.limit('rows'); budget.truncate();
  assert.equal(classes(node, 'preview-omission')[0], notice);
  assert.deepEqual(notice.querySelectorAll('button'), buttons);
  assert.match(notice.textContent, /^Preview shortened\. Some output was not retained\./);
  assert.equal(shown, 1); assert.equal(copied, 1); bounded(node);
});
test('each saved-content action requires its own owner callback and a real omission', () => {
  const context = setup(); let calls = 0;
  for (const [actions, label] of [
    [{showSavedOutput: () => { calls++; }}, 'Show saved output'],
    [{copySavedText: () => { calls++; }}, 'Copy saved text'],
  ] as const) {
    const complete = cast(presentResult({value: {body: 'Exact body'}, truncated: false}, context, new PreviewBudget(actions)));
    assert.equal(classes(complete, 'preview-omission').length, 0); assert.equal(complete.querySelectorAll('button').length, 0);
    const cut = cast(presentResult({value: {body: 'Exact retained body'}, truncated: true}, context, new PreviewBudget(actions)));
    assert.match(cut.textContent, /Some output was not retained\./); assert.doesNotMatch(cut.textContent, /Preview shortened/);
    assert.deepEqual(cut.querySelectorAll('button').map(node => node.textContent), [label]); bounded(cut);
  }
  assert.equal(calls, 0);
});
test('owner actions share the same text and node caps across adopted previews and lazy metadata', () => {
  const context = setup(); let calls = 0;
  const old = new PreviewBudget();
  const argument = cast(presentArguments({value: {code: 'x'.repeat(10000), metadata: {note: 'argument metadata'}}, truncated: false}, context, old));
  const budget = new PreviewBudget({showSavedOutput: () => { calls++; }, copySavedText: () => { calls++; }});
  assert.equal(budget.adopt(argument as unknown as HTMLElement), true);
  const roots = [argument];
  for (let i = 0; i < 8; i++) {
    const node = presentResult({value: {body: `# Retained body\n${'x'.repeat(6000)}`, metadata: {count: i}}, truncated: true}, context, budget);
    if (node) roots.push(cast(node));
  }
  for (const root of roots) for (const metadata of classes(root, 'tool-metadata')) open(metadata);
  assert.equal(roots.flatMap(root => classes(root, 'preview-omission')).length, 1);
  assert.equal(roots.flatMap(root => root.querySelectorAll('button')).length, 2);
  assert.ok(roots.reduce((sum, root) => sum + descendants(root).length, 0) <= 512);
  assert.ok(roots.map(root => root.textContent).join('').length <= 16384);
  assert.ok(budget.visits <= 128); assert.ok(budget.scanned <= 2048);
  assert.equal(calls, 0); for (const root of roots) frames(root);
});
test('hidden serialized strings remain literal and never receive browser decoding', () => {
  const hidden = '{"body":"# Hidden\\nLiteral"}';
  const node = result({body: '# Visible\nDecoded', payload: hidden, metadata: {hidden}});
  assert.equal(node.querySelectorAll('h1').length, 1); assert.match(node.textContent, /\\nLiteral/);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.match(meta.textContent, /\{"body":/); assert.equal(node.querySelectorAll('h1').length, 1);
  assert.match(result({payload: '"escaped\\nstring"'}).textContent, /"escaped\\nstring"/);
});

test('prototype-shaped keys stay inert and argument inheritance does not supply content', () => {
  const value = Object.create(null); Object.defineProperty(value, '__proto__', {value: {polluted: 'safe'}, enumerable: true}); value.constructor = 'inert'; value.toString = 'text';
  const node = result(value); assert.match(node.textContent, /pollutedsafe/); assert.match(node.textContent, /constructorinert/);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  const inherited = Object.create({script: 'hidden\ncommand'}); inherited.name = 'own';
  assert.equal(presentArguments({value: inherited, truncated: false}, setup()), undefined);
  const plain = Object.create(null); plain.name = 'own';
  Object.defineProperty(plain, 'script', {enumerable: true, get: () => { throw new Error('Do not execute accessors'); }});
  assert.match(args(plain).textContent, /nameown/);
  const rows = [{a: 'safe'}]; Object.defineProperty(rows, 1, {get: () => { throw new Error('Do not execute row accessors'); }});
  assert.match(result({rows}).textContent, /safe/);
  const display = Object.create(null); Object.defineProperty(display, 'value', {get: () => { throw new Error('Do not execute projection accessors'); }});
  assert.equal(presentResult(display, setup()), undefined);
});

test('depth, shown fields and visits bound recursive records and scalar arrays', () => {
  let deep: unknown = {secret: 'too deep'};
  for (let i = 0; i < 9; i++) deep = {child: deep};
  const node = result({deep}); assert.doesNotMatch(node.textContent, /too deep/); assert.match(node.textContent, /Preview shortened/); bounded(node);
  const fields = result(Object.fromEntries(Array.from({length: 80}, (_, i) => [`field${i}`, i])));
  assert.equal(classes(fields, 'kv').length, 24); assert.doesNotMatch(fields.textContent, /field24/);
  const values = Object.fromEntries(Array.from({length: 24}, (_, i) => [`group${i}`, Array.from({length: 12}, () => ({value: 'short'}))]));
  const visits = result(values); assert.equal(visits.querySelectorAll('td').length, 61);
  assert.doesNotMatch(visits.textContent, /group6/); assert.match(visits.textContent, /Preview shortened/); bounded(visits);
  assert.equal(classes(result(Array.from({length: 50}, () => ({a: {b: 'stack'}}))), 'tool-record').length, 12);
});

test('documents use safe Markdown with text, line and final DOM limits', () => {
  const doc = result({content: '# Heading\n\n**Strong** and [safe](https://example.com).\n\n<script>alert(1)</script>\n[bad](javascript:alert(1)) ![image](https://example.com/a.png)'});
  assert.equal(doc.querySelectorAll('h1').length, 1); assert.equal(doc.querySelectorAll('strong').length, 1); assert.equal(doc.querySelectorAll('a').length, 1);
  assert.equal(doc.querySelectorAll('script').length, 0); assert.equal(doc.querySelectorAll('img').length, 0);
  const references = result({document: `# Reference images\n${'![x] '.repeat(1000)}`});
  assert.equal(classes(references, 'tool-document')[0]?.tag, 'pre');
  const long = result({a: 'line\n'.repeat(100), b: `first\n${'x'.repeat(12000)}`, c: `second\n${'y'.repeat(12000)}`});
  for (const preview of classes(long, 'tool-document')) { assert.ok(preview.textContent.length <= 8192); assert.ok(preview.textContent.split('\n').length <= 80); }
  bounded(long); bounded(references);
});

test('complex Markdown and source highlighting fall back to bounded plain pre', () => {
  const text = `# Heading\n${'*x* '.repeat(1000)}`;
  const doc = result({text}); const pre = classes(doc, 'tool-document')[0]; assert.ok(pre); assert.equal(pre.tag, 'pre'); assert.equal(pre.textContent, text);
  const code = `${'const value = 1; '.repeat(260)}\nreturn value;`;
  const node = args({program: code, language: 'ts'}); const source = classes(node, 'tool-command')[0]; assert.ok(source);
  assert.equal(source.textContent, code); assert.equal(source.childNodes.length, 1);
  assert.equal(source.childNodes[0]?.childNodes.length, 1); assert.equal(source.childNodes[0]?.childNodes[0]?.tag, '#text');
  bounded(node);
});

test('argument source details select generic hints and path extensions and own their collapse', () => {
  for (const [key, extra, value] of [
    ['command', {language: 'sh'}, 'echo "hi"\necho done'],
    ['program', {lang: 'python'}, 'def greet():\n  return 3'],
    ['code', {path: 'source.ts'}, 'const value = 2;\nreturn value;'],
    ['script', {file_path: 'source.go'}, 'func main() {\n return\n}'],
    ['code', {path: 'source.ts'}, 'const value = 2;'],
  ] as const) {
    const node = args({[key]: value, ...extra}); const source = classes(node, 'tool-source')[0]; assert.ok(source); assert.equal(source.open, true);
    assert.equal(source.childNodes[0]?.textContent, key); assert.equal(classes(source, 'tool-command')[0]?.textContent, value);
    assert.ok(descendants(source).some(child => child.className.startsWith('syn-')));
    source.open = false; source.dispatchEvent(new Event('toggle')); assert.equal(source.open, false);
    assert.equal(classes(source, 'tool-command')[0]?.textContent, value);
  }
  const unknown = args({code: 'alien syntax\nunchanged', language: 'unknown'});
  assert.equal(classes(unknown, 'tool-command')[0]?.textContent, 'alien syntax\nunchanged');
  assert.equal(descendants(unknown).some(child => child.className.startsWith('syn-')), false);
  const typed = args({code: 'const value = 2;', path: 'source.ts'});
  assert.ok(classes(typed, 'syn-keyword').some(child => child.textContent === 'const'));
  frames(typed); frames(unknown);
});

test('supplied edits use at most eight old and new pairs without an inferred diff or tail scan', () => {
  const edits = Array.from({length: 8}, (_, i) => ({oldText: `before${i}\n<script>`, newText: `after${i}\n<strong>`}));
  Object.defineProperty(edits, 8, {get: () => { throw new Error('Do not scan the edit tail'); }}); edits.length = 10000;
  const node = args({edits}); assert.equal(classes(node, 'diff-del').length, 16); assert.equal(classes(node, 'diff-add').length, 16);
  assert.match(node.textContent, /- before0\n- <script>/); assert.match(node.textContent, /\+ after0\n\+ <strong>/);
  assert.doesNotMatch(node.textContent, /@@/); assert.equal(node.querySelectorAll('script').length, 0);
  // The caption identifies supplied text; diff safety remains checked above.
  assert.match(node.textContent, /Supplied replacement/); assert.match(node.textContent, /Preview shortened/); bounded(node);
});

test('supplied edits color only changed lines and show shared lines in plain text', () => {
  const append = args({edits: [{oldText: 'a\nb.', newText: 'a\nb.\nc\nd'}]});
  assert.deepEqual(classes(append, 'diff-add').map(child => child.textContent), ['+ c\n', '+ d\n']); assert.equal(classes(append, 'diff-del').length, 0);
  assert.ok(append.textContent.includes('Earlier context omitted.\n  b.\n+ c\n+ d\n'));
  const insertion = args({edits: [{oldText: 'x\ny\nz', newText: 'x\nI\ny\nz'}]});
  assert.deepEqual(classes(insertion, 'diff-add').map(child => child.textContent), ['+ I\n']); assert.equal(classes(insertion, 'diff-del').length, 0);
  assert.ok(insertion.textContent.includes('  x\n+ I\n  y\nLater context omitted.'));
  const deletion = args({edits: [{oldText: 'x\ny\nz', newText: 'x\nz'}]});
  assert.deepEqual(classes(deletion, 'diff-del').map(child => child.textContent), ['- y\n']); assert.equal(classes(deletion, 'diff-add').length, 0);
  assert.ok(deletion.textContent.includes('  x\n- y\n  z\n'));
  const inline = args({edits: [{oldText: 'a\nfoo bar\nc', newText: 'a\nfoo baz\nc'}]});
  assert.deepEqual([classes(inline, 'diff-del'), classes(inline, 'diff-add')].map(list => list.map(child => child.textContent)), [['- foo bar\n'], ['+ foo baz\n']]);
  const empty = args({edits: [{oldText: '', newText: 'new'}]});
  assert.match(empty.textContent, /Old text: empty\n\+ new/); assert.equal(classes(empty, 'diff-del').length, 0);
});

test('complete supplied single-line replacements emphasise exact changed text without changing the full lines', () => {
  const context = setup();
  for (const [oldText, newText, expected] of [
    ['return a - b;', 'return a + b;', ['-', '+']],
    ['ab', 'a+b', ['+']], ['a+b', 'ab', ['+']],
    ['\t  a b  ', '\t  a\tb  ', [' ', '\t']],
    ['😀😃tail', '😀😄tail', ['😃', '😄']], ['x😀z', 'x🈀z', ['😀', '🈀']],
  ] as const) {
    const value = {oldText, newText}; const retained = JSON.stringify(value);
    const node = cast(presentArguments({value, truncated: false}, context, undefined, {replacement: true}));
    const frame = classes(node, 'pre-text-frame')[0]; assert.ok(frame);
    assert.equal(frame.textContent, `- ${oldText}\n+ ${newText}\n`);
    assert.deepEqual(classes(frame, 'diff-change').map(span => span.textContent), expected);
    for (const child of descendants(frame)) assert.equal(child.textContent.isWellFormed(), true);
    assert.equal(JSON.stringify(value), retained); bounded(node);
  }
});
test('incomplete and bounded supplied replacements retain whole-line presentation without changed-span guesses', () => {
  const context = setup();
  for (const [value, truncated] of [
    [{oldText: 'old', newText: 'new'}, true],
    [{oldText: 'old\nrows', newText: 'new\nlines'}, false],
    [{oldText: 'x'.repeat(9000), newText: 'new'}, false],
    [{oldText: 'a\nb\nold', newText: 'a\nb\nnew'}, false],
    [{oldText: 'old\na\nb', newText: 'new\na\nb'}, false],
    [{oldText: `${'same\n'.repeat(14000)}old`, newText: `${'same\n'.repeat(14000)}new`}, false],
    [{oldText: '', newText: 'new'}, false], [{oldText: 'old', newText: ''}, false],
  ] as const) {
    const node = cast(presentArguments({value, truncated}, context, undefined, {replacement: true}));
    assert.equal(classes(node, 'diff-change').length, 0); bounded(node);
  }
  const value = {oldText: 'return a - b;', newText: 'return a + b;'};
  const cut = cast(presentArguments({value, truncated: false}, {...context, bounded: text => text.slice(0, 4)}, undefined, {replacement: true}));
  assert.equal(classes(cut, 'diff-change').length, 0); bounded(cut);
  const oneSideCut = cast(presentArguments({value: {oldText: 'a-b', newText: `a${'x'.repeat(30)}b`}, truncated: false},
    {...context, bounded: text => text.slice(0, 12)}, undefined, {replacement: true}));
  assert.equal(classes(oneSideCut, 'diff-change').length, 0); bounded(oneSideCut);
});
test('supplied diff rows separate literal markers from exact indented and blank source lines', () => {
  const oldText = '  head\n\told <script>😀\n\n  tail';
  const long = `\tnew ${'wide '.repeat(35)}😀`;
  const newText = `  head\n${long}\n  extra\n  tail`;
  const value = {edits: [{oldText, newText}]}; const retained = JSON.stringify(value);
  const node = args(value); const frame = classes(node, 'pre-text-frame')[0]; assert.ok(frame);
  const expected = [['  ', '  head\n'], ['- ', '\told <script>😀\n'], ['- ', '\n'], ['+ ', `${long}\n`], ['+ ', '  extra\n'], ['  ', '  tail\n']];
  const rows = classes(frame, 'diff-row'); assert.equal(rows.length, expected.length);
  assert.deepEqual(rows.map(row => row.childNodes.map(child => [child.className, child.textContent])),
    expected.map(([marker, text]) => [['diff-marker', marker], ['diff-text', text]]));
  assert.deepEqual(rows.map(row => row.className), ['diff-row', 'diff-row diff-del', 'diff-row diff-del', 'diff-row diff-add', 'diff-row diff-add', 'diff-row']);
  assert.equal(frame.textContent, expected.map(([marker, text]) => `${marker}${text}`).join(''));
  assert.equal(frame.childNodes.every(child => child.className.split(' ').includes('diff-row')), true);
  assert.equal(node.querySelectorAll('script').length, 0); assert.equal(JSON.stringify(value), retained); bounded(node);
});

test('dense supplied diff rows retain exact text when the shared node limit requires plain output', () => {
  const old = Array.from({length: 80}, (_, index) => `old ${index}`);
  const next = Array.from({length: 80}, (_, index) => `new ${index}`);
  const node = args({edits: [{oldText: old.join('\n'), newText: next.join('\n')}]});
  const frame = classes(node, 'pre-text-frame')[0]; assert.ok(frame);
  assert.equal(frame.textContent, [...old.map(line => `- ${line}\n`), ...next.map(line => `+ ${line}\n`)].join(''));
  assert.equal(classes(frame, 'diff-row').length, 0); bounded(node);
});

test('expanded supplied replacements locate later changes and preserve their shared content budget', () => {
  const context = setup();
  const prefix = 'same\r\n'.repeat(2000);
  const value = {oldText: `${prefix}OLD\r\n${'tail\r\n'.repeat(100)}`, newText: `${prefix}NEW\r\n${'tail\r\n'.repeat(100)}`, path: 'source.ts'};
  const retained = JSON.stringify(value), budget = new PreviewBudget();
  const node = cast(presentArguments({value, truncated: false}, context, budget, {replacement: true}));
  assert.match(node.textContent, /Earlier context omitted/); assert.match(node.textContent, /- OLD/); assert.match(node.textContent, /\+ NEW/);
  assert.match(node.textContent, /Later context omitted/); assert.match(node.textContent, /Preview shortened/);
  assert.equal(JSON.stringify(value), retained); assert.equal(node.querySelectorAll('button').length, 0); bounded(node);
  const result = cast(presentResult({value: {body: '# Result\nRetained outcome', metadata: {digest: 'hash'}}, truncated: false}, context, budget));
  const meta = classes(result, 'tool-metadata')[0]; if (meta) open(meta);
  assert.ok(node.textContent.length + result.textContent.length <= 16384);
  assert.ok(descendants(node).length + descendants(result).length <= 512); bounded(node); bounded(result);
});
test('expanded supplied comparisons retain empty sides, Unicode, replacement counts and scan-limit truth', () => {
  const context = setup();
  for (const value of [{oldText: '', newText: 'added'}, {oldText: 'deleted', newText: ''}, {oldText: '', newText: ''}]) {
    const node = cast(presentArguments({value, truncated: false}, context, undefined, {replacement: true}));
    if (!value.oldText) assert.match(node.textContent, /Old text: empty/);
    if (!value.newText) assert.match(node.textContent, /New text: empty/); bounded(node);
  }
  const prefix = '😀'.repeat(1000);
  const node = args({edits: Array.from({length: 10}, () => ({oldText: `${prefix}OLD`, newText: `${prefix}NEW`}))});
  assert.match(node.textContent, /- [^\n]*OLD/); assert.match(node.textContent, /\+ [^\n]*NEW/);
  assert.match(node.textContent, /2 more replacements in Arguments/); bounded(node);
  const exhausted = args({edits: [{oldText: `${'x'.repeat(65536)}old`, newText: `${'x'.repeat(65536)}new`}]});
  assert.match(exhausted.textContent, /First difference not located within scan limit/); assert.doesNotMatch(exhausted.textContent, /No differing text/); bounded(exhausted);
});
test('argument documents preserve exact supplied lines and generic highlighting hints', () => {
  const content = '# Supplied heading\n\nconst value = 1;\nreturn value;\n<script>inert</script>';
  for (const extra of [{language: 'ts'}, {lang: 'typescript'}, {path: 'source.ts'}, {file_path: 'source.mts'}]) {
    const node = args({content, ...extra}); const preview = classes(node, 'tool-document')[0]; assert.ok(preview);
    assert.equal(preview.tag, 'pre'); assert.equal(preview.textContent, content);
    assert.ok(descendants(preview).some(child => child.className.startsWith('syn-')));
    assert.equal(node.querySelectorAll('h1').length, 0); assert.equal(node.querySelectorAll('script').length, 0);
    assert.equal(classes(node, 'tool-source').length, 0);
  }
  const doc = args({docstring: '# Doc\n\nSupplied argument document'});
  assert.equal(classes(doc, 'tool-document')[0]?.tag, 'pre'); assert.equal(classes(doc, 'tool-source').length, 0);
});

test('single-line argument documents use supplied previews at the 512-character boundary', () => {
  for (const length of [511, 512, 20000]) {
    const content = 'const value = 3;'.padEnd(length, ' ');
    const value = {content, path: 'source.ts'}; const retained = value.content;
    const node = args(value); const previews = classes(node, 'tool-document');
    if (length > 8192) assert.equal(previews.length, 0);
    else if (length < 512) { assert.equal(previews.length, 0); assert.equal(classes(node, 'kv').length, 2); }
    else {
      const preview = previews[0]; assert.ok(preview); assert.equal(preview.tag, 'pre');
      assert.equal(preview.textContent, content);
      assert.ok(descendants(preview).some(child => child.className.startsWith('syn-')));
    }
    assert.equal(value.content, retained); bounded(node);
  }
  assert.equal(classes(result({value: 'x'.repeat(512), short: 'compact'}), 'tool-document').length, 1);
});

test('visible content and lazy metadata share final text, DOM and visit budgets without resets', () => {
  const display: JsonDisplay = {value: {script: 'const value = 3;\n'.repeat(80), language: 'ts', docstring: `plain\n${'😀'.repeat(4500)}`, edits: Array.from({length: 8}, () => ({oldText: 'old\n'.repeat(100), newText: 'new\n'.repeat(100)})), metadata: {note: `hidden\n${'z'.repeat(8192)}`}}, truncated: true};
  const retained = display.value; const node = cast(presentArguments(display, setup()));
  const meta = classes(node, 'tool-metadata')[0]; if (meta) open(meta);
  assert.equal(display.value, retained); bounded(node); assert.equal(node.querySelectorAll('button').length, 0);
  const dense = result({rows: Array.from({length: 12}, () => Object.fromEntries(Array.from({length: 24}, (_, i) => [`value${i}`, {a: 1, b: 2, c: 3}]))), metadata: {note: 'hidden'}});
  for (const disclosure of dense.querySelectorAll('details')) open(disclosure);
  bounded(dense); assert.match(dense.textContent, /Preview shortened/);
});

test('lazy metadata omissions emit one visible bounded notice outside the disclosure', () => {
  const metadata = Object.fromEntries(Array.from({length: 30}, (_, i) => [`field${i}`, 'x'.repeat(70)]));
  const node = args({content: 'Small supplied\ndocument', metadata});
  assert.doesNotMatch(node.textContent, /Preview shortened/);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  const notices = classes(node, 'preview-omission');
  assert.match(notices[0]?.textContent ?? '', /Preview shortened/);
  assert.equal(notices.length, 1); assert.equal(notices[0]?.parent, node); bounded(node);
  const total = descendants(node).length; meta.open = false; meta.dispatchEvent(new Event('toggle')); open(meta);
  assert.equal(descendants(node).length, total);
});

test('one tool budget bounds arguments, multiple result previews and all lazy metadata together', () => {
  const context = setup(); const budget = new PreviewBudget();
  const nodes = [cast(presentArguments({value: {code: `const value = 1;\n${'a'.repeat(5000)}`, metadata: {note: 'argument metadata'}}, truncated: false}, context, budget))];
  for (let i = 0; i < 8; i++) {
    const node = presentResult({value: {body: `# Part ${i}\n${'x'.repeat(6000)}`, metadata: {note: `hidden\n${'y'.repeat(9000)}`}}, truncated: i === 7}, context, budget);
    if (node) nodes.push(cast(node));
  }
  for (const node of nodes) for (const meta of classes(node, 'tool-metadata')) open(meta);
  const text = nodes.map(node => node.textContent).join('');
  assert.ok(text.length <= 16384); assert.ok(nodes.reduce((sum, node) => sum + descendants(node).length, 0) <= 512);
  const notices = nodes.flatMap(node => classes(node, 'preview-omission')); assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0]?.textContent ?? '', /Some output is not available/);
  assert.match(notices[0]?.textContent ?? '', /Preview shortened/);
  assert.ok(classes(nodes[0], 'tool-source')[0]);
  const count = nodes.reduce((sum, node) => sum + descendants(node).length, 0);
  for (const node of nodes) for (const meta of classes(node, 'tool-metadata')) { meta.open = false; meta.dispatchEvent(new Event('toggle')); open(meta); }
  assert.equal(nodes.map(node => node.textContent).join(''), text);
  assert.equal(nodes.reduce((sum, node) => sum + descendants(node).length, 0), count);
});

test('one tool budget also bounds aggregate DOM nodes, visits and scans across small sidecars', () => {
  const context = setup(); const budget = new PreviewBudget(); const nodes: DomNode[] = [];
  for (let i = 0; i < 300; i++) {
    const node = presentResult({value: {id: i, metadata: {note: 'small'}}, truncated: false}, context, budget);
    if (node) nodes.push(cast(node));
  }
  for (const node of nodes) for (const meta of classes(node, 'tool-metadata')) open(meta);
  assert.ok(nodes.length < 128);
  assert.ok(nodes.reduce((sum, node) => sum + descendants(node).length, 0) <= 512);
  assert.ok(nodes.map(node => node.textContent).join('').length <= 16384);
  assert.match(nodes.at(-1)?.textContent ?? '', /Preview shortened/);
  assert.equal(classes(nodes[0], 'preview-omission').length, 0);
  assert.ok(budget.visits <= 128); assert.ok(budget.scanned <= 2048);
  assert.equal(presentResult({value: {body: '# Further\nNot admitted'}, truncated: false}, context, budget), undefined);
});

test('empty sidecars do not retain roots and each new tool starts with an independent budget', () => {
  const context = setup(); const budget = new PreviewBudget();
  for (let i = 0; i < 600; i++) assert.equal(presentResult({value: {}, truncated: false}, context, budget), undefined);
  assert.match(cast(presentResult({value: {status: 'done'}, truncated: false}, context, budget)).textContent, /statusdone/);
  const full = new PreviewBudget();
  for (let i = 0; i < 8; i++) presentResult({value: {body: `${'x'.repeat(99)}\n`.repeat(100)}, truncated: false}, context, full);
  const fresh = new PreviewBudget();
  const node = cast(presentResult({value: {body: '# Fresh\nReadable'}, truncated: false}, context, fresh));
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Fresh'); assert.doesNotMatch(node.textContent, /Preview shortened/);
});

test('adoption retains argument controls, removes stale result notices and rebinds lazy metadata', () => {
  const context = setup(); const previous = new PreviewBudget();
  const metadata = {note: 'retained metadata', ...Object.fromEntries(Array.from({length: 23}, (_, i) => [`field${i}`, 'z'.repeat(80)]))};
  const node = cast(presentArguments({value: {code: `const value = 1;\n${'a'.repeat(500)}`, language: 'ts', metadata}, truncated: false}, context, previous));
  const source = classes(node, 'tool-source')[0]; const meta = classes(node, 'tool-metadata')[0];
  assert.ok(source); assert.ok(meta); source.open = false;
  const pre = classes(node, 'tool-command')[0]; const visits = previous.visits; const scanned = previous.scanned;
  const oldResults: DomNode[] = [];
  for (let i = 0; i < 6; i++) {
    const result = presentResult({value: {body: 'x'.repeat(10000)}, truncated: i === 5}, context, previous);
    if (result) oldResults.push(cast(result));
  }
  assert.equal(classes(node, 'preview-omission').length, 0);
  assert.match(oldResults.at(-1)?.textContent ?? '', /Preview shortened/);
  assert.doesNotMatch(oldResults.at(-1)?.textContent ?? '', /Some output is not available/);
  const budget = new PreviewBudget(); assert.equal(budget.adopt(node as unknown as HTMLElement), true);
  assert.equal(budget.visits, visits); assert.equal(budget.scanned, scanned);
  assert.equal(classes(node, 'tool-source')[0], source); assert.equal(classes(node, 'tool-command')[0], pre);
  assert.equal(classes(node, 'tool-metadata')[0], meta); assert.equal(source.open, false);
  assert.doesNotMatch(node.textContent, /Preview shortened|Some output is not available/);
  const next = [node, cast(presentResult({value: {body: `# First\n${'x'.repeat(7000)}`}, truncated: false}, context, budget)), cast(presentResult({value: {body: `# Second\n${'y'.repeat(7000)}`}, truncated: false}, context, budget))];
  const oldState = [previous.text, previous.visits, previous.scanned]; open(meta);
  assert.deepEqual([previous.text, previous.visits, previous.scanned], oldState);
  assert.match(meta.textContent, /metadata\.note/); assert.match(next.at(-1)?.textContent ?? '', /Preview shortened/);
  assert.equal(classes(node, 'preview-omission').length, 0);
  assert.ok(next.map(root => root.textContent).join('').length <= 16384);
  assert.ok(next.reduce((sum, root) => sum + descendants(root).length, 0) <= 512);
  assert.ok(budget.visits <= 128); assert.ok(budget.scanned <= 2048);
});

test('adoption preserves retained argument omission notices and is idempotent', () => {
  const context = setup(); const previous = new PreviewBudget();
  const node = cast(presentArguments({value: {document: 'x'.repeat(10000)}, truncated: true}, context, previous));
  const budget = new PreviewBudget(); assert.equal(budget.adopt(node as unknown as HTMLElement), true);
  assert.match(node.textContent, /Preview shortened/); assert.doesNotMatch(node.textContent, /Some output is not available/);
  const state = [budget.text, budget.visits, budget.scanned, descendants(node).length, node.textContent];
  assert.equal(budget.adopt(node as unknown as HTMLElement), true);
  assert.deepEqual([budget.text, budget.visits, budget.scanned, descendants(node).length, node.textContent], state);
  assert.equal(budget.adopt(new DomNode('section') as unknown as HTMLElement), false);
  assert.deepEqual([budget.text, budget.visits, budget.scanned, descendants(node).length, node.textContent], state);
  const result = cast(presentResult({value: {body: '# Fresh\nReadable'}, truncated: false}, context, budget));
  assert.equal(result.querySelectorAll('h1')[0]?.textContent, 'Fresh');
  assert.ok(node.textContent.length + result.textContent.length <= 16384);
  assert.ok(descendants(node).length + descendants(result).length <= 512);
});

test('adoption preserves already built metadata and accurate visit counts across repeated refreshes', () => {
  const context = setup(); let calls = 0;
  context.bounded = (text, limit = 65536) => { calls++; return text.slice(0, limit); };
  let previous = new PreviewBudget();
  const node = cast(presentArguments({value: {code: 'const value = 1;\n'.repeat(20), language: 'ts', metadata: {note: 'retained metadata'}}, truncated: false}, context, previous));
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  const children = [...meta.childNodes]; const argumentVisits = previous.visits; const argumentScans = previous.scanned;
  assert.ok(descendants(node).length > argumentVisits);
  for (let i = 0; i < 10; i++) {
    const budget = new PreviewBudget(); assert.equal(budget.adopt(node as unknown as HTMLElement), true);
    assert.equal(budget.visits, argumentVisits); assert.equal(budget.scanned, argumentScans);
    const builtCalls = calls; meta.open = false; meta.dispatchEvent(new Event('toggle')); open(meta);
    assert.equal(calls, builtCalls); assert.deepEqual(meta.childNodes, children);
    const result = cast(presentResult({value: {body: '# Current\nReadable'}, truncated: false}, context, budget));
    assert.equal(result.querySelectorAll('h1')[0]?.textContent, 'Current');
    assert.ok(node.textContent.length + result.textContent.length <= 16384);
    assert.ok(descendants(node).length + descendants(result).length <= 512);
    previous = budget;
  }
});

test('rejected adoption leaves the retained preview and its old lazy budget unchanged', () => {
  const context = setup(); const previous = new PreviewBudget();
  const node = cast(presentArguments({value: {code: 'const value = 1;', language: 'ts', metadata: {note: 'still available'}}, truncated: false}, context, previous));
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta);
  const full = new PreviewBudget();
  for (let i = 0; i < 4; i++) presentResult({value: {body: `${'x'.repeat(99)}\n`.repeat(100)}, truncated: false}, context, full);
  for (let i = 0; i < 30 && full.text > 3; i++) presentResult({value: {body: 'z'.repeat(Math.max(1, Math.min(full.text - 3, 30)))}, truncated: false}, context, full);
  assert.equal(full.adopt(node as unknown as HTMLElement), false);
  const fullState = [full.text, full.visits, full.scanned]; open(meta);
  assert.deepEqual([full.text, full.visits, full.scanned], fullState);
  assert.match(meta.textContent, /still available/); assert.ok(previous.visits > 2); bounded(node);
});

test('all helper pre branches carry stable frames inside shared DOM and adoption budgets', () => {
  const context = setup(); let budget = new PreviewBudget();
  const argument = cast(presentArguments({value: {code: 'const value = 1;', language: 'ts', document: 'supplied\nargument', edits: Array.from({length: 8}, () => ({oldText: 'before', newText: 'after'})), metadata: {note: 'lazy\nargument'}}, truncated: false}, context, budget));
  const sourceFrame = classes(classes(argument, 'tool-command')[0], 'pre-text-frame')[0]; assert.ok(sourceFrame);
  const nodes = [argument];
  for (let i = 0; i < 100; i++) {
    const node = presentResult({value: {body: '```ts\nconst value = 2;\n```\n\nVisible document', metadata: {note: 'lazy\nresult'}}, truncated: false}, context, budget);
    if (node) nodes.push(cast(node));
  }
  for (const node of nodes) for (const meta of classes(node, 'tool-metadata')) open(meta);
  for (const node of nodes) frames(node);
  assert.ok(nodes.reduce((sum, node) => sum + descendants(node).length, 0) <= 512);
  assert.ok(nodes.map(node => node.textContent).join('').length <= 16384);
  assert.equal(classes(argument, 'diff-del').length, 8); assert.equal(classes(argument, 'diff-add').length, 8);
  budget = new PreviewBudget(); assert.equal(budget.adopt(argument as unknown as HTMLElement), true);
  assert.equal(classes(classes(argument, 'tool-command')[0], 'pre-text-frame')[0], sourceFrame);
  const next = cast(presentResult({value: {body: `# Plain fallback\n${'*x* '.repeat(1000)}`}, truncated: false}, context, budget));
  assert.equal(classes(next, 'tool-document')[0]?.tag, 'pre'); frames(next); frames(argument);
  assert.ok(descendants(argument).length + descendants(next).length <= 512);
  assert.ok(argument.textContent.length + next.textContent.length <= 16384);
});

test('dotted field keys preserve full text with semantic breaks and wide-row hooks', () => {
  const key = 'namespace.records.coverage.omitted'; const node = args({[key]: 3});
  const term = node.querySelectorAll('dt')[0]; assert.ok(term); assert.equal(term.textContent, key);
  assert.equal(term.querySelectorAll('wbr').length, 3);
  assert.ok(term.className.includes('field-key')); assert.ok(term.className.includes('field-key-wide'));
  assert.deepEqual(term.childNodes.filter(child => child.tag === '#text').map(child => child.textContent), ['namespace.', 'records.', 'coverage.', 'omitted']);
  bounded(node);
});

test('character and line cuts stay within budgets without changing projected source strings', () => {
  const scalar = 'x'.repeat(511); const supplied = {description: scalar}; const short = args(supplied);
  assert.equal(short.querySelectorAll('dd')[0]?.textContent, '');
  assert.equal(supplied.description, scalar); assert.match(short.textContent, /Preview shortened/);
  const source = 'line\n'.repeat(100); const display = {value: {document: source}, truncated: true};
  const document = cast(presentArguments(display, setup())); const pre = classes(document, 'tool-document')[0]; assert.ok(pre);
  assert.ok(pre.textContent.split('\n').length <= 80);
  assert.equal(display.value.document, source); assert.equal(classes(document, 'preview-omission').length, 1);
  assert.match(document.textContent, /Preview shortened/);
  const complete = args({description: 'complete'}); assert.equal(complete.querySelectorAll('dd')[0]?.textContent, 'complete');
  bounded(short); bounded(document); bounded(complete);
});

test('useful record arrays precede query, scan, consistency and offset machinery with lazy exact metadata', () => {
  const value = {query: ['repeated search'], scan: {visited: 100, complete: true}, consistency: 'Scope statement '.repeat(20),
    representation: 'Offset representation '.repeat(20), matches: [{title: 'Useful title', excerpt: 'Useful excerpt', state: 'open', field: 'body', start: 0, excerptEnd: 50}]};
  const node = result(value); const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta);
  assert.match(node.textContent, /Useful title/); assert.match(node.textContent, /Useful excerpt/);
  assert.doesNotMatch(node.textContent, /repeated search|visited100|Scope statement|Offset representation|excerptEnd50|fieldbody/);
  assert.ok(node.textContent.indexOf('Useful title') < node.textContent.indexOf('Details'));
  open(meta); assert.match(meta.textContent, /query\.1repeated search/); assert.match(meta.textContent, /scan\.visited100/);
  assert.match(meta.textContent, /matches\.1\.excerptEnd50/); assert.match(meta.textContent, /matches\.1\.fieldbody/);
  assert.equal(value.matches[0]?.excerpt, 'Useful excerpt'); bounded(node);
});

test('single-child container scaffolding reduces to useful prose while genuine omission objects stay concise and inspectable', () => {
  const node = result({omissions: {hiddenFragments: 2, hiddenImages: 0}, truncated: false,
    payload: {layers: [{content: [{type: 'text', text: '# Useful prose\nReadable body'}]}]}});
  assert.equal(node.querySelectorAll('h1')[0]?.textContent, 'Useful prose');
  assert.equal(classes(node, 'tool-document').length, 1); assert.ok(classes(node, 'tool-record').length <= 1);
  const fact = classes(node, 'tool-fact')[0]; assert.ok(fact); assert.equal(fact.childNodes.length, 1);
  assert.match(fact.textContent, /hiddenFragments 2/); assert.doesNotMatch(node.textContent, /hiddenImages0|truncatedfalse/);
  open(fact); assert.match(fact.textContent, /omissions\.hiddenImages0/);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta); assert.match(meta.textContent, /truncatedfalse/);
  bounded(node);
});

test('document-bearing records lift nested excerpts before scalar-only sibling records and null fields', () => {
  const excerpt = 'This useful excerpt describes the result without lifecycle details before it. It ends at TypeScr';
  for (const keys of [['lifecycle', 'freshness', 'sourceMatch', 'excerpt'], ['alpha', 'beta', 'gamma', 'delta']]) {
    const [left, right, branch, leaf] = keys as [string, string, string, string];
    const value = {records: [{title: 'Useful title', [left]: {status: 'active', replacement: null},
      [right]: {checked: '2026-10-09', verified: true, deadline: null, problems: []}, absent: null,
      [branch]: {start: 100, end: 200, [leaf]: excerpt}, id: 7}]};
    const node = result(value); const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta);
    assert.doesNotMatch(node.textContent, /replacement|verified|deadline|problems|absent/);
    assert.doesNotMatch(node.textContent, /Useful title/);
    assert.ok(node.textContent.indexOf(excerpt) < node.textContent.indexOf('Details'));
    assert.equal(classes(node, 'tool-document')[0]?.textContent, excerpt);
    assert.equal(classes(node, 'preview-omission').length, 0);
    open(meta); assert.match(meta.textContent, /replacementnull/); assert.match(meta.textContent, /verifiedtrue/);
    assert.ok(node.textContent.indexOf(excerpt) < node.textContent.indexOf('Useful title')); assert.match(meta.textContent, /id7/);
    assert.match(meta.textContent, /absentnull/); assert.equal(value.records[0]?.[branch]?.[leaf], excerpt);
    assert.equal(node.textContent.split(excerpt).length - 1, 1); bounded(node);
  }
});

test('shape-folded records retain explicit warnings outside metadata without duplication', () => {
  const node = result({body: '# Useful prose\n\nReadable body', envelope: {count: 3, nested: {warning: 'Retained host warning', empty: null}}});
  assert.match(node.textContent, /envelope\.nested\.warningRetained host warning/);
  assert.doesNotMatch(node.textContent, /count3|emptynull/);
  assert.ok(node.textContent.indexOf('Readable body') < node.textContent.indexOf('Retained host warning'));
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.match(meta.textContent, /count3|emptynull/); assert.doesNotMatch(meta.textContent, /Retained host warning/);
  assert.equal(node.textContent.split('Retained host warning').length - 1, 1); bounded(node);
});

test('nested document paths precede explicit omission facts and outer identity scalars', () => {
  const node = result({sessionId: 'opaque-id', entryId: 142, offset: 0, nextOffset: null, truncated: false,
    omissions: {signatures: 1, images: 0}, text: {model: [{role: 'assistant', content: [{type: 'text', text: '# Useful prose\n\nReadable body'}]}]}});
  const doc = classes(node, 'tool-document')[0]; assert.ok(doc);
  assert.ok(node.textContent.indexOf('Readable body') < node.textContent.indexOf('omissions'));
  assert.doesNotMatch(node.textContent, /sessionId|text\.model|content\.1|roleassistant|typetext/);
  assert.equal(classes(node, 'tool-record').length, 0);
  assert.equal(classes(node, 'tool-fact').length, 1);
  assert.doesNotMatch(node.textContent, /nextOffsetnull|truncatedfalse/);
  assert.equal(doc.querySelectorAll('h1')[0]?.textContent, 'Useful prose');
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.match(meta.textContent, /text\.model\.1\.content\.1\.text/); assert.match(meta.textContent, /sessionIdopaque-id/);
  assert.match(meta.textContent, /roleassistant/); assert.match(meta.textContent, /typetext/);
  assert.ok(node.textContent.indexOf('Readable body') < node.textContent.indexOf('sessionId')); bounded(node);
});

test('one shared omission note follows the last useful result, including later metadata limits', () => {
  const context = setup(); const budget = new PreviewBudget();
  const argument = cast(presentArguments({value: {code: 'x'.repeat(10000), metadata: Object.fromEntries(Array.from({length: 30}, (_, i) => [`field${i}`, i]))}, truncated: false}, context, budget));
  const first = cast(presentResult({value: {body: '# First\nUseful first result'}, truncated: false}, context, budget));
  const last = cast(presentResult({value: {body: '# Last\nUseful last result'}, truncated: false}, context, budget));
  assert.equal(presentResult({value: {}, truncated: false}, context, budget), undefined);
  const meta = classes(argument, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.equal(classes(argument, 'preview-omission').length, 0); assert.equal(classes(first, 'preview-omission').length, 0);
  const notice = classes(last, 'preview-omission')[0]; assert.ok(notice);
  assert.equal(last.childNodes.at(-1), notice); assert.ok(last.textContent.indexOf('Useful last result') < last.textContent.indexOf(notice.textContent));
  assert.ok([argument, first, last].reduce((sum, root) => sum + descendants(root).length, 0) <= 512);
  assert.ok([argument, first, last].map(root => root.textContent).join('').length <= 16384);
});

test('single-document wrappers fold source paths and scalar siblings after prose', () => {
  for (const keys of [['text', 'model', 'content', 'text'], ['alpha', 'beta', 'gamma', 'delta']]) {
    const [a, b, c, d] = keys as [string, string, string, string];
    const supplied = {id: 'opaque', [a]: {[b]: [{role: 'assistant', [c]: [{type: 'text', [d]: '# Useful document\n\nExact body'}]}]}, warning: 'Genuine host warning'};
    const node = result(supplied); const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta);
    assert.equal(node.childNodes[0], classes(node, 'tool-document')[0]);
    assert.equal(classes(node, 'tool-record').length, 0); assert.equal(meta.childNodes.length, 1);
    const path = `${a}.${b}.1.${c}.1.${d}`;
    assert.equal(node.textContent.includes(path), false); assert.doesNotMatch(node.textContent, /opaque|roleassistant|typetext/);
    assert.match(node.textContent, /Genuine host warning/); assert.ok(node.textContent.indexOf('Exact body') < node.textContent.indexOf('Genuine host warning'));
    open(meta); assert.ok(meta.textContent.includes(path)); assert.match(meta.textContent, /idopaque|roleassistant|typetext/);
    assert.equal(node.textContent.split('Exact body').length - 1, 1); assert.doesNotMatch(meta.textContent, /Exact body|Genuine host warning/);
    bounded(node);
  }
});

test('multiple document branches retain distinct record sections', () => {
  const node = result({rows: [{wrapper: {body: '# First\n\nFirst body', id: 1}}, {wrapper: {body: '# Second\n\nSecond body', id: 2}}]});
  assert.deepEqual(node.querySelectorAll('h1').map(heading => heading.textContent), ['First', 'Second']);
  assert.equal(classes(node, 'tool-record').length, 2); assert.equal(node.querySelectorAll('table').length, 0);
  const records = classes(node, 'tool-record'); assert.match(records[0]?.textContent ?? '', /rows\.1/); assert.match(records[1]?.textContent ?? '', /rows\.2/);
  assert.doesNotMatch(node.textContent, /wrapper\.body|id1|id2/);
  const meta = classes(node, 'tool-metadata')[0]; assert.ok(meta); open(meta);
  assert.match(meta.textContent, /rows\.1\.wrapper\.body/); assert.match(meta.textContent, /rows\.2\.wrapper\.body/);
  assert.match(meta.textContent, /rows\.1\.wrapper\.id1/); assert.match(meta.textContent, /rows\.2\.wrapper\.id2/);
  assert.doesNotMatch(meta.textContent, /First body|Second body/); bounded(node);
  const siblings = result({left: '# Left\n\nLeft body', right: '# Right\n\nRight body'});
  assert.deepEqual(classes(siblings, 'tool-caption').map(caption => caption.textContent), ['left', 'right']);
  assert.equal(classes(siblings, 'tool-document').length, 2); bounded(siblings);
});

test('transparent document metadata preserves shared budgets through adoption', () => {
  const context = setup(); const previous = new PreviewBudget();
  const argument = cast(presentArguments({value: {code: 'const value = 1;', metadata: {note: 'argument metadata'}}, truncated: false}, context, previous));
  const budget = new PreviewBudget(); assert.equal(budget.adopt(argument as unknown as HTMLElement), true);
  const nodes = [argument];
  for (let i = 0; i < 8; i++) {
    const node = presentResult({value: {id: i, envelope: {rows: [{type: 'text', body: `# Document ${i}\n${'x'.repeat(6000)}`}]}, metadata: {count: i}}, truncated: false}, context, budget);
    if (node) nodes.push(cast(node));
  }
  for (const node of nodes) for (const metadata of classes(node, 'tool-metadata')) open(metadata);
  assert.ok(nodes.map(node => node.textContent).join('').length <= 16384);
  assert.ok(nodes.reduce((sum, node) => sum + descendants(node).length, 0) <= 512);
  assert.ok(budget.visits <= 128); assert.ok(budget.scanned <= 2048);
  const text = nodes.map(node => node.textContent).join(''); const visits = budget.visits; const scanned = budget.scanned;
  for (const node of nodes) for (const metadata of classes(node, 'tool-metadata')) { metadata.open = false; metadata.dispatchEvent(new Event('toggle')); open(metadata); }
  assert.equal(nodes.map(node => node.textContent).join(''), text); assert.equal(budget.visits, visits); assert.equal(budget.scanned, scanned);
  assert.equal(nodes.flatMap(node => classes(node, 'preview-omission')).length, 1); for (const node of nodes) frames(node);
});

test('fenced documents do not duplicate outer copy or raw inspection controls', () => {
  const node = result({document: '```ts\nconst value = 1;\n```\n\nDocument'});
  assert.equal(node.querySelectorAll('button').length, 0); assert.equal(classes(node, 'tool-command').length, 0);
  assert.equal(node.querySelectorAll('pre').length, 1); assert.match(node.textContent, /const value = 1;/);
  assert.ok(classes(node, 'syn-keyword').some(child => child.textContent === 'const'));
  assert.equal(node.querySelectorAll('pre')[0]?.childNodes[0]?.childNodes[0]?.tag, 'code');
  bounded(node);
});

const display = (value: unknown) => ({value, truncated: false});
test('compact summaries leave identifiers out and name a conversation only when the name is known', () => {
  const session = 'ead53d8c-af9d-0bda-1416-21a6ba18ab6c:57';
  assert.equal(structuredResultPreview(display({result: {sessionId: session, submissionId: 16781, requestId: 'agent-deliver:20034'}, conversationId: 4250})), '');
  assert.equal(structuredResultPreview(display({threadId: 'ead53d8c-af9d-0bda-1416-21a6ba18ab6c/6e47146e288681286069a74bf69cfd6e', sequence: 292, deduped: true})), 'sequence: 292 · deduped: true');
  assert.equal(structuredResultPreview(display({result: {sessionId: session, submissionId: 20039}}), identity => identity === session ? 'Web UI lead' : undefined), 'Web UI lead');
  assert.equal(structuredResultPreview(display({status: 'queued', owner: session, digestLike: 'a'.repeat(40)})), 'status: queued');
  assert.equal(structuredResultPreview(display({nested: {role: 'assistant', id: 4}})), 'nested');
  assert.equal(structuredResultPreview(display(session)), ''); assert.equal(structuredResultPreview(display(session), () => 'Builder'), 'Builder');
  assert.equal(structuredResultPreview(display({})), 'Empty object');
});
test('compact summaries show a name once, leave out a name the title shows, and leave out false flags', () => {
  const a = 'ead53d8c-af9d-0bda-1416-21a6ba18ab6c:57', b = '4736382d-0d0b-8764-22db-73e3ec0287bd';
  const both = (identity: string) => identity === a || identity === b ? 'Web UI designer' : undefined;
  assert.equal(structuredResultPreview(display({identity: a, result: {sessionId: b}}), both), 'Web UI designer');
  assert.equal(structuredResultPreview(display({identity: a, status: 'queued'}), both, 'Sent a message to Web UI designer'), 'status: queued');
  assert.equal(structuredResultPreview(display({identity: a, status: 'queued'}), both, 'Sent a message to someone'), 'Web UI designer · status: queued');
  assert.equal(structuredResultPreview(display({identity: a, deduped: false}), both, 'Sent a message to Web UI designer: “Hi”'), '');
  assert.equal(structuredResultPreview(display({deduped: false, sequence: 3, deduped2: true}), undefined), 'sequence: 3 · deduped2: true');
  assert.equal(structuredResultPreview(display({deduped: false})), '');
  assert.equal(structuredResultPreview(display({sequence: 3, deduped: true})), 'sequence: 3 · deduped: true');
  assert.equal(structuredResultPreview(display({ok: false, sequence: 3})), 'ok: false · sequence: 3');
  assert.equal(structuredResultPreview(display({success: false, sequence: 3})), 'success: false · sequence: 3');
  assert.match(structuredResultPreview(display({error: {message: 'Request refused'}, deduped: false})) ?? '', /Request refused/);
  assert.equal(structuredResultPreview(display({errors: false, sequence: 3})), 'sequence: 3');
  assert.equal(structuredResultPreview(display({})), 'Empty object');
});
test('a compact line leaves out empty collections and reads words before counts', () => {
  const settled = {results: ['x'], unresolved: [], originalInputs: [1, 2, 3, 4, 5, 6], decision: 'settled', queuedInputCount: 25};
  assert.equal(structuredResultPreview(display(settled)), 'results: 1 item · decision: settled · queuedInputCount: 25');
  const real = {results: ['x'], unresolved: [], originalInputs: [1, 2, 3, 4, 5, 6], queueSnapshot: {conversationId: 1, runId: 1450, source: 'committed InboxDoc'}, decision: 'settled', queuedInputCount: 25};
  assert.equal(structuredResultPreview(display(real)), 'results: 1 item · decision: settled · queuedInputCount: 25', 'an object shown by key name alone reads after scalars');
  assert.equal(structuredResultPreview(display({zeta: {a: 1}, count: 4, name: 'x'})), 'count: 4 · name: x · zeta');
  assert.equal(structuredResultPreview(display({errors: [], checks: {}, ready: true})), 'ready: true', 'empty collections are not facts beside a fact');
  assert.equal(structuredResultPreview(display({errors: []})), 'errors: 0 items', 'an empty collection that is the only fact stays');
  assert.equal(structuredResultPreview(display({errors: [], warnings: []})), 'errors: 0 items · warnings: 0 items');
  assert.equal(structuredResultPreview(display({items: [], note: 'plain'})), 'note: plain');
  assert.equal(structuredResultPreview(display([])), '0 items');
  assert.equal(structuredResultPreview(display({tags: ['a', 'b'], kind: 'file', size: 4})), 'kind: file · size: 4 · tags: 2 items');
  assert.equal(structuredResultPreview(display({records: [1, 2], nested: {role: 'assistant'}, nullable: null})), 'records: 2 items · nullable: null · nested');
});
test('expanded fields keep every identifier', () => {
  const root = result({result: {sessionId: 'ead53d8c-af9d-0bda-1416-21a6ba18ab6c:57', submissionId: 16781}});
  assert.match(root.textContent, /ead53d8c-af9d-0bda-1416-21a6ba18ab6c:57/); assert.match(root.textContent, /16781/);
});
