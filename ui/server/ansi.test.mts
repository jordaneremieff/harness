import assert from 'node:assert/strict';
import test from 'node:test';
import { ansiOf, cutAnsi, plainOf, tokenizeAnsi } from './ansi.mts';

const plain = (value: string) => plainOf(tokenizeAnsi(value));
test('colour and style sequences are kept and everything else is removed', () => {
  const items = tokenizeAnsi('\x1b[1;31mFAIL\x1b[0m ok\x1b[2K\x1b[1A\x1b[?25l\x1b[3;4H');
  assert.equal(plainOf(items), 'FAIL ok');
  assert.equal(ansiOf(items), '\x1b[1;31mFAIL\x1b[0m ok');
});
test('titles, hyperlinks, device strings, bell and single escapes are stripped while link text stays', () => {
  assert.equal(plain('a\x1b]0;window title\x07b'), 'ab');
  assert.equal(plain('a\x1b]0;title\x1b\\b'), 'ab');
  assert.equal(plain('\x1b]8;;https://example.test/x\x1b\\the link\x1b]8;;\x1b\\ end'), 'the link end');
  assert.equal(plain('a\x1bPq#0;2;0;0;0\x1b\\b\x1b_apc\x1b\\c\x1b^pm\x1b\\d\x1bXsos\x1b\\e'), 'abcde');
  assert.equal(plain('x\x07y\x1bcz\x1b7w\x1b(Bv\x1b=u'), 'xyzwvu');
  assert.equal(plain('\u009b31mred\u009d0;t\u0007ok\u0085'), 'redok');
});
test('an unterminated string sequence ends at its line and cannot swallow later lines', () => {
  assert.equal(plain('a\x1b]0;never ends\nnext line'), 'a\nnext line');
  assert.equal(plain('a\x1bPdevice\nnext'), 'a\nnext');
});
test('cursor and erase sequences, including private modes and intermediates, leave no text', () => {
  for (const sequence of ['\x1b[2J', '\x1b[H', '\x1b[10;20f', '\x1b[K', '\x1b[?1049h', '\x1b[>c', '\x1b[1 q', '\x1b[5n', '\x1b[s', '\x1b[u']) assert.equal(plain(`a${sequence}b`), 'ab', sequence);
});
test('only digit and semicolon colour parameters survive, so odd forms cannot carry content', () => {
  assert.equal(ansiOf(tokenizeAnsi('\x1b[38:2::1:2:3mx')), 'x');
  assert.equal(ansiOf(tokenizeAnsi('\x1b[31 mx')), 'x');
  assert.equal(ansiOf(tokenizeAnsi(`\x1b[${'1;'.repeat(60)}mx`)), 'x');
  assert.equal(ansiOf(tokenizeAnsi('\x1b[mx')), '\x1b[mx');
});
test('a trailing incomplete sequence is dropped and the text before it stays', () => {
  assert.equal(ansiOf(tokenizeAnsi('done\x1b[31')), 'done');
  assert.equal(ansiOf(tokenizeAnsi('done\x1b[')), 'done');
  assert.equal(ansiOf(tokenizeAnsi('done\x1b')), 'done');
  assert.equal(ansiOf(tokenizeAnsi('done\x1b]0;tit')), 'done');
});
test('carriage returns keep the last overwrite of a line and its colour state, and CRLF is a line end', () => {
  assert.equal(plain('10%\r50%\r100%\ndone'), '100%\ndone');
  assert.equal(plain('line one\r\nline two\r\n'), 'line one\nline two\n');
  assert.equal(ansiOf(tokenizeAnsi('\x1b[31mA\rB')), '\x1b[31mB');
});
test('backspace removes the previous character on the same line only', () => {
  assert.equal(plain('a\bb'), 'b');
  assert.equal(plain('X\bXY\b\bZ'), 'Z');
  assert.equal(plain('line\n\bnext'), 'line\nnext');
  assert.equal(plain('\b\bx'), 'x');
});
test('other control characters are removed and tabs and newlines stay', () => {
  assert.equal(plain('a\x00b\x01c\x0bd\x0ce\x7ff\tg\nh'), 'abcdef\tg\nh');
});
test('cutting keeps colour sequences before the cut and never splits a surrogate pair', () => {
  const items = tokenizeAnsi('\x1b[31mabc\x1b[0mdef');
  assert.equal(cutAnsi(items, 4), '\x1b[31mabc\x1b[0md');
  assert.equal(cutAnsi(tokenizeAnsi('a😀b'), 2), 'a');
  assert.equal(cutAnsi(items, 0), '\x1b[31m');
});
