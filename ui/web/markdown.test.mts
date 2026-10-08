import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInline, parseMarkdown, safeLink } from './markdown.ts';

test('paragraphs, headings, and quotes form safe blocks', () => {
  const blocks = parseMarkdown('# Heading\n\nA paragraph\nwith two lines.\n\n> quote\n>\n> ## nested');
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'quote']);
  assert.deepEqual(blocks[0], {type: 'heading', level: 1, children: [{type: 'text', text: 'Heading'}]});
  assert.equal(blocks[2].type === 'quote' && blocks[2].children[1].type, 'heading');
  assert.equal(parseMarkdown('Title\n---')[0].type, 'heading');
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
  assert.equal(parseMarkdown('text\n\n---')[1].type, 'paragraph');
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseInline('plain'), [{type: 'text', text: 'plain'}]);
});

test('long incomplete marker runs stay readable without recursive expansion', () => {
  for (const source of ['['.repeat(32768), '<'.repeat(32768), String.fromCharCode(96).repeat(32768)]) {
    assert.deepEqual(parseInline(source), [{type: 'text', text: source}]);
  }
});
