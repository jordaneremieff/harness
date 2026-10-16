import assert from 'node:assert/strict';
import test from 'node:test';
import { composerSyntax, DECORATION_BYTES, DECORATION_LINES, DECORATION_SPANS } from './composer-syntax.ts';
import { tokenRanges } from './highlight.ts';
test('inline and fenced ranges preserve exact Markdown source and unknown languages', () => {
  const text = 'prose 😀 `x < y`\n```ts\nconst x = "<tag>";\n```\n~~~unknown\nunchanged `raw`\n~~~';
  const ranges = composerSyntax(text); assert.ok(ranges);
  assert.deepEqual(ranges.filter(range => range.tone === 'keyword').map(range => text.slice(range.start, range.end)), ['const']);
  assert.ok(ranges.some(range => text.slice(range.start, range.end) === '`x < y`'));
  assert.equal(ranges.some(range => range.start > text.indexOf('unchanged') && range.start < text.lastIndexOf('~~~')), false);
  let previous = 0;
  for (const range of ranges) {assert.ok(range.start >= previous); assert.ok(range.end > range.start); previous = range.end;}
  assert.deepEqual(composerSyntax('<img src=x> unmatched ` literal'), []);
});
test('fence identity, closing length and malformed labels never mutate source', () => {
  assert.ok(composerSyntax('````ts\nconst x=1\n```\nlet y=2\n````')?.some(range => range.tone === 'keyword'));
  assert.deepEqual(composerSyntax('```bad`label\nno code'), []);
  assert.ok(composerSyntax('```ts\nconst x=1')?.some(range => range.tone === 'keyword'));
  assert.deepEqual(composerSyntax('``a ` b``')?.map(range => [range.start, range.end]), [[0, 9]]);
});
test('dense inline runs keep nearest equal-length pairing across the span bound', () => {
  const text = '`x` '.repeat(DECORATION_SPANS), ranges = composerSyntax(text);assert.ok(ranges);assert.equal(ranges.length,DECORATION_SPANS);
  for (let i = 0;i < ranges.length;i++) assert.deepEqual(ranges[i],{start:i*4,end:i*4+3,tone:'md-code'});
  assert.deepEqual(composerSyntax('a `one `` nested` ``two``` tail')?.map(range=>[range.start,range.end]),[[2,17]]);
});
test('every decoration bound exits to whole-source plain text', () => {
  assert.ok(composerSyntax('x'.repeat(DECORATION_BYTES)));
  assert.equal(composerSyntax('x'.repeat(DECORATION_BYTES + 1)), undefined);
  assert.equal(composerSyntax('é'.repeat(DECORATION_BYTES / 2 + 1)), undefined);
  assert.ok(composerSyntax('\n'.repeat(DECORATION_LINES - 1)));
  assert.equal(composerSyntax('\n'.repeat(DECORATION_LINES)), undefined);
  assert.equal(composerSyntax('`x` '.repeat(DECORATION_SPANS + 1)), undefined);
  assert.equal(tokenRanges('const x=1;', 'ts', 0), undefined);
  assert.deepEqual(tokenRanges('exact plain', 'unknown'), []);
});
