import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInline, parseMarkdown, safeLink } from './markdown.ts';
import { markdownDom } from './safe-markdown.ts';
import { HIGHLIGHT_BYTES, HIGHLIGHT_LINES } from './highlight.ts';

class MarkdownNode extends EventTarget {
  children: MarkdownNode[] = []; className = ''; dataset: Record<string, string> = {}; private text = '';
  readonly tag: string;
  attributes: Record<string, string> = {};
  constructor(tag: string) { super(); this.tag = tag; }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: MarkdownNode[]): void { for (const node of nodes) this.children.push(...(node.tag === '#fragment' ? node.children : [node])); }
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  querySelector(selector: string): MarkdownNode | null { for (const child of this.children) {if (selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1))) return child; const nested = child.querySelector(selector); if (nested) return nested;} return null; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
}
function mockDocument(context: {after: (callback: () => void) => void}): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  context.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {
    getElementById: () => new MarkdownNode('span'),
    createElement: (tag: string) => new MarkdownNode(tag), createElementNS: (_namespace: string, tag: string) => new MarkdownNode(tag), createDocumentFragment: () => new MarkdownNode('#fragment'),
    createTextNode: (text: string) => { const node = new MarkdownNode('#text'); node.textContent = text; return node; },
  }});
}

test('paragraphs, headings, and quotes form safe blocks', () => {
  const blocks = parseMarkdown('# Heading\n\nA paragraph\nwith two lines.\n\n> quote\n>\n> ## nested');
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'quote']);
  assert.deepEqual(blocks[0], {type: 'heading', level: 1, children: [{type: 'text', text: 'Heading'}]});
  assert.equal(blocks[2].type === 'quote' && blocks[2].children[1].type, 'heading');
  assert.equal(parseMarkdown('Title\n---')[0].type, 'heading');
});
test('horizontal rules use standalone marker runs without replacing setext headings or fenced code', () => {
  for (const source of ['---', '***', '___', '----', '  ***\t']) assert.deepEqual(parseMarkdown(source), [{type: 'rule'}]);
  assert.deepEqual(parseMarkdown('before\n***\nafter').map(block => block.type), ['paragraph', 'rule', 'paragraph']);
  assert.deepEqual(parseMarkdown('before\n\n---\n\nafter').map(block => block.type), ['paragraph', 'rule', 'paragraph']);
  assert.deepEqual(parseMarkdown('> ___'), [{type: 'quote', children: [{type: 'rule'}]}]);
  assert.equal(parseMarkdown('Title\n---')[0]?.type, 'heading');
  assert.deepEqual(parseMarkdown('```\n---\n***\n___\n```'), [{type: 'code', text: '---\n***\n___', language: ''}]);
  for (const source of ['--', '**', '__', '--- text', 'text *** text', '    ___']) assert.equal(parseMarkdown(source)[0]?.type, 'paragraph');
});
test('opening frontmatter is preformatted while body headings and lists stay Markdown', () => {
  const metadata = '---\ntitle: "Example"\ntags:\n  - one\n  - two\nsummary: |\n  First line\n  Second line\n---';
  const blocks = parseMarkdown(`${metadata}\n\n# Document\n\n- first\n- **second**\n\n## Details\n\nBody text.`);
  assert.deepEqual(blocks.map(block => block.type), ['code', 'heading', 'list', 'heading', 'paragraph']);
  assert.deepEqual(blocks[0], {type: 'code', text: metadata, language: 'yaml'});
  assert.deepEqual(blocks[1], {type: 'heading', level: 1, children: [{type: 'text', text: 'Document'}]});
  assert.equal(blocks[2].type === 'list' && blocks[2].items.length, 2);
  assert.deepEqual(blocks[3], {type: 'heading', level: 2, children: [{type: 'text', text: 'Details'}]});
  assert.equal(parseMarkdown(`${metadata}\n# Body`)[1]?.type, 'heading');
  assert.deepEqual(parseMarkdown(metadata.replace(/\n/g, '\r\n')), [{type: 'code', text: metadata, language: 'yaml'}]);
});
test('frontmatter preserves markup as inert code text without parsing metadata values', () => {
  const metadata = '--- \t\n# metadata\n\ntitle: "<script>alert(1)</script>"\nlink: "[unsafe](javascript:alert(1))"\nimage: "![remote](https://example.test/image.png)"\n---\t';
  assert.deepEqual(parseMarkdown(`${metadata}\n\n# Body`)[0], {type: 'code', text: metadata, language: 'yaml'});
});
test('frontmatter DOM uses a safe highlighted pre block and keeps body Markdown elements', context => {
  mockDocument(context);
  const metadata = '---\ntitle: "<img onerror=run()>"\nready: true\n---';
  const dom = markdownDom(`${metadata}\n\n# Body\n\n- item\n\n<script>alert(1)</script>`) as unknown as MarkdownNode;
  assert.deepEqual(dom.children.map(node => node.tag), ['div', 'h1', 'ul', 'p']);
  const wrap = dom.children[0];
  assert.equal(wrap.className, 'code-block markdown-content');
  assert.ok(dom.children.every(node=>node.className.split(' ').includes('markdown-content')));
  assert.deepEqual(wrap.children.map(node => node.tag), ['div', 'pre']);
  assert.equal(wrap.children[0].className, 'source-header');
  assert.equal(wrap.children[0].children[0].textContent, 'yaml');
  assert.deepEqual(wrap.children[0].children.slice(1).map(node => node.attributes['aria-label']), ['Copy code', 'Wrap source lines']);
  assert.equal(wrap.children[0].children[1].children[0].tag, 'svg');
  const code = wrap.children[1].children[0];
  assert.equal(code.tag, 'code');
  assert.equal(code.dataset.language, 'yaml');
  assert.equal(code.textContent, metadata);
  assert.equal(code.children.every(node => node.tag === '#text' || node.tag === 'span'), true);
  assert.equal(code.children.some(node => node.className === 'syn-string'), true);
  assert.equal(dom.children[3].textContent, '<script>alert(1)</script>');
  assert.equal(dom.children[3].children.every(node => node.tag === '#text'), true);
});
test('over-budget frontmatter DOM retains exact plain metadata and a separate body', context => {
  mockDocument(context);
  const metadata = `---\ntitle: "${'x'.repeat(HIGHLIGHT_BYTES)}"\n---`;
  const dom = markdownDom(`${metadata}\n\n# Body`) as unknown as MarkdownNode;
  assert.deepEqual(dom.children.map(node => node.tag), ['div', 'h1']);
  const code = dom.children[0].children[1].children[0];
  assert.equal(code.textContent, metadata);
  assert.deepEqual(code.children.map(node => node.tag), ['#text']);
});
test('ordinary opening rules and metadata-shaped body text do not become frontmatter', () => {
  assert.deepEqual(parseMarkdown('---\n\nA paragraph.\n\n---\n\n# Body').map(block => block.type), ['rule', 'paragraph', 'rule', 'heading']);
  assert.deepEqual(parseMarkdown('---\n---'), [{type: 'rule'}, {type: 'rule'}]);
  const metadata = '---\ntitle: Example\n---';
  assert.equal(parseMarkdown(`Introduction\n\n${metadata}`).some(block => block.type === 'code'), false);
  const quote = parseMarkdown('> ---\n> title: Example\n> ---')[0];
  assert.equal(quote.type, 'quote');
  assert.equal(quote.type === 'quote' && quote.children.some(block => block.type === 'code'), false);
});
test('incomplete frontmatter stays safe and literal without consuming the document body', () => {
  const blocks = parseMarkdown('---\ntitle: "<img onerror=run()>"\nlink: [unsafe](javascript:alert(1)\n--\n\n# Body\n\n- item');
  assert.deepEqual(blocks.map(block => block.type), ['rule', 'paragraph', 'heading', 'list']);
  assert.deepEqual(blocks[1], {type: 'paragraph', children: [{type: 'text', text: 'title: "<img onerror=run()>"\nlink: [unsafe](javascript:alert(1)\n--'}]});
});
test('ordered, unordered, and nested lists preserve item structure', () => {
  const blocks = parseMarkdown('3. first\n4. second\n\n- outer\n  - nested\n  - next\n- last');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type === 'list' && blocks[0].ordered, true);
  assert.equal(blocks[0].type === 'list' && blocks[0].start, 3);
  assert.equal(blocks[1].type === 'list' && blocks[1].items[0][1].type, 'list');
  assert.equal(blocks[1].type === 'list' && blocks[1].items.length, 2);
});
test('an empty supplied list item does not absorb the following unindented paragraph', context => {
  mockDocument(context);
  const source = '1. Restart ordinary Pi to load the changed manager.\n2. \n\nUse agent_inspect for retained source evidence.';
  const blocks = parseMarkdown(source);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {type: 'list', ordered: true, start: 1, items: [
    [{type: 'paragraph', children: [{type: 'text', text: 'Restart ordinary Pi to load the changed manager.'}]}], [],
  ]});
  assert.deepEqual(blocks[1], {type: 'paragraph', children: [{type: 'text', text: 'Use agent_inspect for retained source evidence.'}]});
  const dom = markdownDom(source) as unknown as MarkdownNode;
  assert.deepEqual(dom.children.map(node => node.tag), ['ol', 'p']);
  assert.deepEqual(dom.children[0].children.map(node => [node.tag, node.textContent]), [
    ['li', 'Restart ordinary Pi to load the changed manager.'], ['li', ''],
  ]);
  assert.equal(dom.children[1].textContent, 'Use agent_inspect for retained source evidence.');
});
test('loose list items keep every paragraph node inside its own item', context => {
  mockDocument(context);
  for (const [source, tag, start] of [
    ['3. First paragraph.\n\n   More first-item text.\n\n4. Second paragraph.\n\n   More second-item text.', 'ol', '3'],
    ['- First paragraph.\n\n  More first-item text.\n\n- Second paragraph.\n\n  More second-item text.', 'ul', undefined],
  ] as const) {
    const blocks = parseMarkdown(source);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type === 'list' && blocks[0].items.every(item => item.length === 2 && item.every(node => node.type === 'paragraph')), true);
    const dom = markdownDom(source) as unknown as MarkdownNode;
    assert.equal(dom.children.length, 1);
    const list = dom.children[0]; assert.equal(list.tag, tag); assert.equal(list.attributes.start, start);
    assert.equal(list.children.length, 2);
    assert.deepEqual(list.children.map(item => item.tag), ['li', 'li']);
    assert.deepEqual(list.children.map(item => item.children.map(node => [node.tag, node.textContent])), [
      [['p', 'First paragraph.'], ['p', 'More first-item text.']],
      [['p', 'Second paragraph.'], ['p', 'More second-item text.']],
    ]);
  }
});
test('a list marker with an indented paragraph continuation keeps the paragraph inside the item', context => {
  mockDocument(context);
  const source = '1. First item.\n\n2. \n\n   Use agent_inspect for retained source evidence.';
  const blocks = parseMarkdown(source);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {type: 'list', ordered: true, start: 1, items: [
    [{type: 'paragraph', children: [{type: 'text', text: 'First item.'}]}],
    [{type: 'paragraph', children: [{type: 'text', text: 'Use agent_inspect for retained source evidence.'}]}],
  ]});
  const dom = markdownDom(source) as unknown as MarkdownNode;
  assert.deepEqual(dom.children.map(node => node.tag), ['ol']);
  const item = dom.children[0].children[1];
  assert.equal(item.tag, 'li'); assert.deepEqual(item.children.map(node => node.tag), ['p']);
  assert.equal(item.textContent, 'Use agent_inspect for retained source evidence.');
});
test('inline and fenced code preserve source without evaluation', () => {
  assert.deepEqual(parseInline('a `x < y` b'), [{type: 'text', text: 'a '}, {type: 'code', text: 'x < y'}, {type: 'text', text: ' b'}]);
  assert.deepEqual(parseInline('`` a ` b ``'), [{type: 'code', text: 'a ` b'}]);
  assert.deepEqual(parseMarkdown('```ts\nconst x = "<script>";\n```'), [{type: 'code', language: 'ts', text: 'const x = "<script>";'}]);
  assert.deepEqual(parseMarkdown('~~~\nunclosed\nnext'), [{type: 'code', language: '', text: 'unclosed\nnext'}]);
  assert.equal(parseMarkdown('````\n```\n````')[0].type, 'code');
});
test('fence syntax markers follow known languages without spans or after scan bounds are exceeded', context => {
  mockDocument(context);
  const cases: [string, string, boolean, boolean][] = [
    ['ts', 'const count = 42;', true, true], ['TS', 'identifier', true, false],
    ['md', 'plain text', true, false], ['', 'const count = 42;', false, false],
    ['custom-grammar', 'const count = 42;', false, false], ['__proto__', 'identifier', false, false],
    ['ts', 'x'.repeat(HIGHLIGHT_BYTES + 1), true, false],
    ['ts', 'identifier\n'.repeat(HIGHLIGHT_LINES), true, false],
  ];
  for (const [language, source, known, spans] of cases) {
    const dom = markdownDom([`\`\`\`${language}`, source, '```'].join('\n')) as unknown as MarkdownNode;
    const code = dom.children[0].children[1].children[0];
    assert.equal(code.dataset.language, language || undefined);
    assert.equal(code.dataset.syntax, known ? 'known' : undefined, language);
    assert.equal(code.textContent, source);
    assert.equal(code.children.some(node => node.tag === 'span'), spans, language);
  }
});
test('emphasis includes strong and nested emphasis with escapes', () => {
  assert.deepEqual(parseInline('**bold and *soft***'), [{type: 'strong', children: [{type: 'text', text: 'bold and '}, {type: 'emphasis', children: [{type: 'text', text: 'soft'}]}]}]);
  assert.deepEqual(parseInline('_soft_ **bold**'), [{type: 'emphasis', children: [{type: 'text', text: 'soft'}]}, {type: 'text', text: ' '}, {type: 'strong', children: [{type: 'text', text: 'bold'}]}]);
  assert.deepEqual(parseInline('snake_case_word \\*plain\\*'), [{type: 'text', text: 'snake_case_word *plain*'}]);
});
test('links require explicit HTTP or HTTPS URLs', () => {
  assert.equal(safeLink('HTTPS://example.test/path'), 'https://example.test/path');
  for (const value of ['javascript:alert(1)', 'data:text/html,x', '//example.test', '/local', 'file:///secret', 'https:\n//example.test', 'https://', 'http:example.test']) assert.equal(safeLink(value), null, value);
  assert.deepEqual(parseInline('[safe](https://example.test/a_(b))'), [{type: 'link', href: 'https://example.test/a_(b)', children: [{type: 'text', text: 'safe'}]}]);
  assert.deepEqual(parseInline('[unsafe](javascript:alert(1))'), [{type: 'text', text: 'unsafe'}]);
  assert.equal(parseInline('[label](https://example.test "Title")')[0].type, 'link');
});
test('bare HTTP(S) addresses require opt-in and retain exact labels outside sentence punctuation', () => {
  const addresses = ['HTTPS://Example.test/A?q=One&x=Two#Part', 'http://localhost:4318/path', 'https://example.test/a_b?q=a*b&next=%2Fpage', 'https://example.test/a_(b_(c))', 'https://example.test/a)b', 'https://[::1]:4318/path'];
  for (const address of addresses) {
    assert.deepEqual(parseInline(address), [{type: 'text', text: address}]);
    for (const [before, after] of [['', ''], ['(', ').'], ['See ', ','], ['"', '"'], ['[', '].'], ['', '!?;:']]) {
      const source = before + address + after, nodes = parseInline(source, 0, true);
      const links = nodes.filter(node => node.type === 'link');
      assert.deepEqual(links, [{type: 'link', href: safeLink(address), children: [{type: 'text', text: address}]}], source);
      assert.equal(nodes.map(node => 'text' in node ? node.text : node.type === 'link' ? node.children.map(child => 'text' in child ? child.text : '').join('') : '').join(''), source);
    }
  }
});
test('bare addresses respect adjacent Markdown, code, existing labels and unsafe schemes', () => {
  const address = 'https://example.test/a_(b)?x=1&y=2';
  for (const marker of ['*', '**', '_', '__']) {
    const nodes = parseInline(`${marker}${address}${marker}`, 0, true);
    assert.equal(nodes[0]?.type, marker.length === 1 ? 'emphasis' : 'strong');
    assert.equal(nodes[0] && 'children' in nodes[0] && nodes[0].children[0]?.type, 'link');
  }
  const nodes = parseInline(`\`${address}\` [${address}](https://other.test) [${address}](javascript:bad) <img src="${address}">`, 0, true);
  assert.equal(nodes.filter(node => node.type === 'link').length, 1);
  const link = nodes.find(node => node.type === 'link');
  assert.deepEqual(link, {type: 'link', href: 'https://other.test/', children: [{type: 'text', text: address}]});
  for (const source of ['javascript:alert(1)', 'data:text/html,x', 'file:///secret', '//example.test', 'https://', 'https://[bad]', 'prefixhttps://example.test', 'javascript:https://example.test', 'https:\n//example.test']) {
    assert.equal(parseInline(source, 0, true).some(node => node.type === 'link'), false, source);
  }
});
test('full-prose bare links reach nested Markdown blocks but never fenced code or frontmatter', () => {
  const source = '---\nurl: https://metadata.test\n---\n\n# https://heading.test\n\n> https://quote.test\n\n- https://list.test\n\n| Address |\n| --- |\n| https://table.test |\n\n```\nhttps://code.test\n```';
  const serialised = JSON.stringify(parseMarkdown(source, 0, true));
  for (const host of ['heading', 'quote', 'list', 'table']) assert.match(serialised, new RegExp(`"href":"https://${host}\\.test/"`));
  assert.doesNotMatch(serialised, /"href":"https:\/\/(?:code|metadata)\.test/);
  assert.doesNotMatch(JSON.stringify(parseMarkdown(source)), /"type":"link"/);
});
test('raw HTML is always text and remote images are omissions', () => {
  assert.deepEqual(parseInline('<img src="https://example.test/a" onerror="run()">'), [{type: 'text', text: '<img src="https://example.test/a" onerror="run()">'}]);
  const ast = parseMarkdown('<script>alert(1)</script>\n\n![photo](https://example.test/a.png) ![other][ref]');
  assert.equal(ast[0].type, 'paragraph');
  // Expectations use the display labels while preserving source and action checks.
  assert.deepEqual(parseInline('![photo](https://example.test/a.png)'), [{type: 'omitted', label: 'Image not shown: photo'}]);
  assert.deepEqual(parseInline('![other][ref]'), [{type: 'omitted', label: 'Image not shown: other'}]);
  assert.equal(JSON.stringify(ast).includes('"type":"link"'), false);
});
test('simple tables preserve alignment, escaped pipes, and inline code', () => {
  const blocks = parseMarkdown('| Left | Center | Right |\n| :--- | :---: | ---: |\n| a\\|b | `x|y` | **z** |');
  assert.equal(blocks[0].type, 'table');
  if (blocks[0].type !== 'table') assert.fail();
  assert.deepEqual(blocks[0].align, ['left', 'center', 'right']);
  assert.deepEqual(blocks[0].rows[0][0], [{type: 'text', text: 'a|b'}]);
  assert.deepEqual(blocks[0].rows[0][1], [{type: 'code', text: 'x|y'}]);
  assert.equal(blocks[0].rows[0][2][0].type, 'strong');
});
test('incomplete and unknown markup remains readable', () => {
  assert.deepEqual(parseInline('**open [label](broken'), [{type: 'text', text: '**open [label](broken'}]);
  assert.equal(parseMarkdown('text\n\n---')[1].type, 'rule');
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseInline('plain'), [{type: 'text', text: 'plain'}]);
});

test('long incomplete marker runs stay readable without recursive expansion', () => {
  for (const source of ['['.repeat(32768), '<'.repeat(32768), String.fromCharCode(96).repeat(32768)]) {
    assert.deepEqual(parseInline(source), [{type: 'text', text: source}]);
  }
});

test('source controls reserve a header and toggles and Copy keep exact highlighted text', async context => {
  mockDocument(context);
  let copied = '';
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  context.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator'); });
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {clipboard: {writeText: async (text: string) => { copied = text; }}}});
  const source = '  const n = 1;\n\n\treturn n;  ';
  const dom = markdownDom(['```ts', source, '```'].join('\n')) as unknown as MarkdownNode;
  const block = dom.children[0]; const header = block.children[0]; const pre = block.children[1];
  const original = pre.children[0];
  assert.equal(header.className, 'source-header'); assert.equal(header.children[0].textContent, 'ts');
  assert.equal(pre.textContent, source); assert.equal(pre.dataset.wrap, 'false');
  const wrap = header.children[2]; const copy = header.children[1];
  wrap.dispatchEvent(new Event('click')); assert.equal(pre.dataset.wrap, 'true');
  assert.equal(wrap.attributes['aria-pressed'], 'true'); assert.equal(pre.textContent, source);
  copy.dispatchEvent(new Event('click')); await Promise.resolve(); assert.equal(copied, source);
  wrap.dispatchEvent(new Event('click')); assert.equal(pre.dataset.wrap, 'false');
  assert.equal(pre.children[0], original); assert.equal(pre.textContent, source);
});
