import assert from 'node:assert/strict';
import test from 'node:test';
import { AnsiPainter } from './ansi.ts';

const paint = (...chunks: string[]) => { const painter = new AnsiPainter(); return chunks.flatMap(chunk => painter.feed(chunk)); };
const flat = (runs: {text: string; cls: string}[]) => runs.map(run => `${run.cls || '-'}|${run.text}`);
test('the sixteen colours map to modelled tokens and bright colours share them', () => {
  const names = (codes: number[]) => codes.map(code => paint(`\x1b[${code}mx`)[0]?.cls);
  assert.deepEqual(names([30, 31, 32, 33, 34, 35, 36, 37]), ['ansi-fg-dim', 'ansi-fg-error', 'ansi-fg-success', 'ansi-fg-warning', 'ansi-fg-link', 'ansi-fg-agent', 'ansi-fg-search', 'ansi-fg-fg']);
  assert.deepEqual(names([90, 91, 92, 93, 94, 95, 96, 97]), names([30, 31, 32, 33, 34, 35, 36, 37]));
});
test('256 and truecolour map to the nearest token and never to an inline colour', () => {
  assert.equal(paint('\x1b[38;5;196mx')[0]?.cls, 'ansi-fg-error');
  assert.equal(paint('\x1b[38;5;46mx')[0]?.cls, 'ansi-fg-success');
  assert.equal(paint('\x1b[38;5;226mx')[0]?.cls, 'ansi-fg-warning');
  assert.equal(paint('\x1b[38;5;27mx')[0]?.cls, 'ansi-fg-link');
  assert.equal(paint('\x1b[38;5;201mx')[0]?.cls, 'ansi-fg-agent');
  assert.equal(paint('\x1b[38;5;51mx')[0]?.cls, 'ansi-fg-search');
  assert.equal(paint('\x1b[38;5;244mx')[0]?.cls, 'ansi-fg-muted');
  assert.equal(paint('\x1b[38;2;250;40;40mx')[0]?.cls, 'ansi-fg-error');
  assert.equal(paint('\x1b[38;2;20;20;20mx')[0]?.cls, 'ansi-fg-dim');
  assert.equal(paint('\x1b[38;9;1mx')[0]?.cls ?? '', '', 'an unknown extended mode sets nothing');
  assert.equal(paint('\x1b[38;5mx')[0]?.cls ?? '', '', 'missing values set nothing');
  assert.equal(paint('\x1b[31;38;5;46;1mx')[0]?.cls, 'ansi-fg-success ansi-b');
  for (const run of paint('\x1b[38;2;1;2;3;48;5;100mx\x1b[38;5;999mx')) assert.doesNotMatch(run.cls, /#|rgb|style/);
});
test('styles combine, background and inverse become a mark, and reset clears everything', () => {
  assert.deepEqual(flat(paint('\x1b[1;3;4;9;31mA\x1b[0mB')), ['ansi-fg-error ansi-b ansi-i ansi-u ansi-s|A', '-|B']);
  assert.deepEqual(flat(paint('\x1b[43;30mmatch\x1b[49;39m rest')), ['ansi-fg-dim ansi-mark|match', '-| rest']);
  assert.deepEqual(flat(paint('\x1b[7mi\x1b[27mn')), ['ansi-mark|i', '-|n']);
  assert.deepEqual(flat(paint('\x1b[1;2mx\x1b[22my')), ['ansi-b ansi-dim|x', '-|y']);
  assert.deepEqual(flat(paint('\x1b[31mred\x1b[mnormal')), ['ansi-fg-error|red', '-|normal']);
  assert.deepEqual(flat(paint('\x1b[31;mx')), ['-|x']);
});
test('style carries across lines and chunks, and a sequence cut at a chunk boundary waits for its rest', () => {
  assert.deepEqual(flat(paint('\x1b[32mone\ntwo\n')), ['ansi-fg-success|one\ntwo\n']);
  assert.deepEqual(flat(paint('\x1b[3', '1mred', '\x1b', '[0m!')), ['ansi-fg-error|red', '-|!']);
  assert.deepEqual(flat(paint('a\x1b[', '32mb')), ['-|a', 'ansi-fg-success|b']);
  const painter = new AnsiPainter(); painter.feed('\x1b[31mkeep'); assert.deepEqual(flat(painter.feed(' going')), ['ansi-fg-error| going']);
  assert.deepEqual(flat(new AnsiPainter().feed('fresh')), ['-|fresh'], 'a new output starts from the default style');
});
test('anything that is not colour is dropped and no markup is produced', () => {
  assert.deepEqual(flat(paint('a\x1b[2Kb\x1b]0;t\x07c\x1b[?25lde\x07\x00f<b>x</b>')), ['-|abc' + 'd' + 'e' + 'f<b>x</b>']);
  assert.deepEqual(flat(paint('\x1b[31 mx')), ['-|x']);
  assert.deepEqual(flat(paint('\x1b[38:2::1:2:3mx')), ['-|x']);
});
