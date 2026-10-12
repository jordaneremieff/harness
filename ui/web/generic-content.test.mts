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
  remove(): void { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter(child => child !== this); }
  querySelectorAll(selector: string): DomNode[] { return descendants(this).filter(child => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tag === selector); }
  setAttribute(key: string, value: string): void { this.dataset[key] = value; }
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

test('structured collapsed summaries use at most three top-level supplied facts or an array count', () => {
  const display = (value: unknown): JsonDisplay => ({value, truncated: false});
  assert.equal(structuredResultPreview(undefined), undefined);
  assert.equal(structuredResultPreview(display(undefined)), undefined);
  assert.equal(structuredResultPreview(display({alpha: 'kept', count: 0, ready: false, ignored: 'only after expansion'})), 'alpha: kept · count: 0 · ready: false');
  assert.equal(structuredResultPreview(display({nested: {role: 'assistant'}, records: [1, 2], nullable: null})), 'nested · records · nullable: null');
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
  assert.equal(structuredResultPreview({value: {message: text}, truncated: true}), `message: ${text}`);
  assert.equal(structuredResultPreview({value: {role: 'assistant', status: 'success'}, truncated: false}), 'role: assistant · status: success');
});
test('structured summaries bound keys and strings without evaluating getters or nested values', () => {
  let reads = 0;
  const value = {['😀'.repeat(500)]: '😀'.repeat(500), second: 'line1\nline2', third: 'kept', fourth: 'not in summary'};
  const shown = structuredResultPreview({value, truncated: false}); assert.ok(shown);
  assert.ok(shown.length <= 240); assert.ok(shown.split('\n').length <= 2); assert.equal(shown.isWellFormed(), true);
  assert.doesNotMatch(shown, /fourth|not in summary/);
  const guarded = {next: 7}; Object.defineProperty(guarded, 'protected', {enumerable: true, get: () => { reads++; throw new Error('Getter invoked'); }});
  assert.equal(structuredResultPreview({value: guarded, truncated: false}), 'next: 7 · protected'); assert.equal(reads, 0);
  const unchanged = JSON.stringify(value); structuredResultPreview({value, truncated: true}); assert.equal(JSON.stringify(value), unchanged);
});
test('collapsed summaries leave full rich fields and omission callbacks in the shared expanded budget', () => {
  const context = setup(); let calls = 0;
  const value = {alpha: 'A', beta: 0, gamma: false, delta: 'D'};
  const display = {value, truncated: false};
  assert.equal(structuredResultPreview(display), 'alpha: A · beta: 0 · gamma: false');
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
  assert.equal(classes(node, 'tool-document').length, 2);
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
    assert.match(meta.textContent, /usage\.notedeferred statistic/);
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
  const node = args({edits}); assert.equal(classes(node, 'diff-del').length, 8); assert.equal(classes(node, 'diff-add').length, 8);
  assert.match(node.textContent, /- before0\n- <script>/); assert.match(node.textContent, /\+ after0\n\+ <strong>/);
  assert.doesNotMatch(node.textContent, /@@/); assert.equal(node.querySelectorAll('script').length, 0);
  // The caption identifies supplied text; diff safety remains checked above.
  assert.match(node.textContent, /Supplied replacement/); assert.match(node.textContent, /Preview shortened/); bounded(node);
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
    if (length < 512) { assert.equal(previews.length, 0); assert.equal(classes(node, 'kv').length, 2); }
    else {
      const preview = previews[0]; assert.ok(preview); assert.equal(preview.tag, 'pre');
      assert.equal(preview.textContent, content.length > 8192 ? `${content.slice(0, 8191)}…` : content);
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
  for (let i = 0; i < 8; i++) presentResult({value: {body: 'x'.repeat(10000)}, truncated: false}, context, full);
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
  for (let i = 0; i < 4; i++) presentResult({value: {body: 'x'.repeat(10000)}, truncated: false}, context, full);
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

test('character and line cuts end in ellipses within budgets without changing projected source strings', () => {
  const scalar = 'x'.repeat(511); const supplied = {description: scalar}; const short = args(supplied);
  assert.equal(short.querySelectorAll('dd')[0]?.textContent, `${scalar.slice(0, 239)}…`);
  assert.equal(supplied.description, scalar); assert.match(short.textContent, /Preview shortened/);
  const source = 'line\n'.repeat(100); const display = {value: {document: source}, truncated: true};
  const document = cast(presentArguments(display, setup())); const pre = classes(document, 'tool-document')[0]; assert.ok(pre);
  assert.ok(pre.textContent.endsWith('…')); assert.ok(pre.textContent.split('\n').length <= 80);
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
