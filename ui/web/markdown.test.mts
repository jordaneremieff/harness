import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInline, parseMarkdown, safeLink } from './markdown.ts';
import { markdownDom } from './safe-markdown.ts';
import { HIGHLIGHT_BYTES } from './highlight.ts';

class MarkdownNode {
  children: MarkdownNode[] = []; className = ''; dataset: Record<string, string> = {}; private text = '';
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: MarkdownNode[]): void { for (const node of nodes) this.children.push(...(node.tag === '#fragment' ? node.children : [node])); }
  addEventListener(): void {}
  setAttribute(): void {}
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
}
function mockDocument(context: {after: (callback: () => void) => void}): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  context.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {
    createElement: (tag: string) => new MarkdownNode(tag), createDocumentFragment: () => new MarkdownNode('#fragment'),
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
  assert.equal(wrap.className, 'code-block');
  assert.deepEqual(wrap.children.map(node => node.tag), ['button', 'pre']);
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
test('inline and fenced code preserve source without evaluation', () => {
  assert.deepEqual(parseInline('a `x < y` b'), [{type: 'text', text: 'a '}, {type: 'code', text: 'x < y'}, {type: 'text', text: ' b'}]);
  assert.deepEqual(parseInline('`` a ` b ``'), [{type: 'code', text: 'a ` b'}]);
  assert.deepEqual(parseMarkdown('```ts\nconst x = "<script>";\n```'), [{type: 'code', language: 'ts', text: 'const x = "<script>";'}]);
  assert.deepEqual(parseMarkdown('~~~\nunclosed\nnext'), [{type: 'code', language: '', text: 'unclosed\nnext'}]);
  assert.equal(parseMarkdown('````\n```\n````')[0].type, 'code');
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
test('raw HTML is always text and remote images are omissions', () => {
  assert.deepEqual(parseInline('<img src="https://example.test/a" onerror="run()">'), [{type: 'text', text: '<img src="https://example.test/a" onerror="run()">'}]);
  const ast = parseMarkdown('<script>alert(1)</script>\n\n![photo](https://example.test/a.png) ![other][ref]');
  assert.equal(ast[0].type, 'paragraph');
  assert.deepEqual(parseInline('![photo](https://example.test/a.png)'), [{type: 'omitted', label: 'Image omitted: photo'}]);
  assert.deepEqual(parseInline('![other][ref]'), [{type: 'omitted', label: 'Image omitted: other'}]);
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
