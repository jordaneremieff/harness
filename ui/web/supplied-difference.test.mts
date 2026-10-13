import assert from 'node:assert/strict';
import test from 'node:test';
import {suppliedDifference, differenceNotice} from './supplied-difference.ts';

function bounded(oldText: string, newText: string, chars: number, lines: number): void {
  const shown = suppliedDifference(oldText, newText, chars, lines);
  for (const text of [shown.oldText, shown.newText]) {
    assert.ok(text.length <= chars); assert.ok(text.split(/\r\n|\r|\n/).length <= lines);
    assert.equal(text.isWellFormed(), true);
  }
}
test('short supplied pairs retain their exact sides without a file-diff claim', () => {
  assert.deepEqual(suppliedDifference('old\n', 'new\n'), {oldText: 'old\n', newText: 'new\n', omittedBefore: false, omittedAfter: false, scanLimited: false, same: false});
  assert.equal(differenceNotice(suppliedDifference('old', 'new')), '');
});
test('the first differing region survives long same-line and multiline matching prefixes', () => {
  for (const prefix of ['same\n'.repeat(2000), 'x'.repeat(12000), '😀'.repeat(6000)]) {
    const oldText = `${prefix}OLD\n${'tail\n'.repeat(100)}`, newText = `${prefix}NEW\n${'tail\n'.repeat(100)}`;
    const shown = suppliedDifference(oldText, newText, 500, 2);
    assert.match(shown.oldText, /OLD/); assert.match(shown.newText, /NEW/);
    assert.equal(shown.omittedBefore, true); assert.equal(shown.omittedAfter, true); assert.equal(shown.scanLimited, false);
    assert.match(differenceNotice(shown), /Later context omitted/); bounded(oldText, newText, 500, 2);
  }
});
test('insertion, deletion and empty sides retain truthful windows', () => {
  for (const [oldText, newText] of [['', 'inserted'], ['deleted', ''], ['', '']]) {
    const shown = suppliedDifference(oldText, newText);
    assert.equal(shown.oldText, oldText); assert.equal(shown.newText, newText);
    assert.equal(shown.omittedBefore, false); assert.equal(shown.omittedAfter, false);
  }
  const prefix = 'unchanged\n'.repeat(1000);
  const inserted = suppliedDifference(prefix, `${prefix}inserted`);
  assert.equal(inserted.oldText, ''); assert.equal(inserted.newText, 'inserted'); assert.equal(inserted.same, false);
  const deleted = suppliedDifference(`${prefix}deleted`, prefix);
  assert.equal(deleted.oldText, 'deleted'); assert.equal(deleted.newText, ''); assert.equal(deleted.same, false);
});
test('Unicode boundaries never split a surrogate pair at the window start or end', () => {
  const prefix = '😀'.repeat(500);
  const oldText = `${prefix}😃tail`, newText = `${prefix}😄tail`;
  for (const chars of [4, 5, 20, 79, 80, 81, 500]) {
    const shown = suppliedDifference(oldText, newText, chars, 2);
    assert.match(shown.oldText, /😃/); assert.match(shown.newText, /😄/); bounded(oldText, newText, chars, 2);
  }
  bounded('😀'.repeat(1000), '😀'.repeat(1000), 499, 2);
});
test('LF, CRLF and CR windows locate the change without spending their lines on preceding context', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const prefix = `same${newline}`.repeat(1000);
    const oldText = `${prefix}old${newline}tail${newline}end`, newText = `${prefix}new${newline}tail${newline}end`;
    const shown = suppliedDifference(oldText, newText, 500, 2);
    assert.equal(shown.oldText, `old${newline}tail`); assert.equal(shown.newText, `new${newline}tail`);
    bounded(oldText, newText, 500, 2);
  }
  const shown = suppliedDifference('a\r\nb', 'a\r\nC', 1, 2);
  assert.equal(shown.oldText, 'b'); assert.equal(shown.newText, 'C');
  bounded('a\r\nb', 'a\r\nb', 2, 2);
});
test('scan exhaustion is explicit and does not claim a located change or an identical pair', () => {
  const prefix = 'x'.repeat(65536);
  const shown = suppliedDifference(`${prefix}old`, `${prefix}new`, 500, 2);
  assert.equal(shown.scanLimited, true); assert.equal(shown.same, false); assert.equal(shown.omittedBefore, false);
  assert.equal(shown.oldText, 'x'.repeat(500)); assert.equal(shown.newText, 'x'.repeat(500));
  assert.match(differenceNotice(shown), /First difference not located within scan limit/);
  assert.doesNotMatch(differenceNotice(shown), /No differing text/);
  assert.equal(suppliedDifference(prefix, `${prefix}added`).scanLimited, false);
});
test('a complete retained identical pair is distinct from an unlocated difference', () => {
  const shown = suppliedDifference('same\n'.repeat(1000), 'same\n'.repeat(1000), 500, 2);
  assert.equal(shown.same, true); assert.equal(shown.scanLimited, false); assert.equal(shown.omittedAfter, true);
  assert.match(differenceNotice(shown), /No differing text in supplied pair/);
  assert.equal(differenceNotice(suppliedDifference('', '')), '');
});
test('zero text room never invents an empty original side or exceeds its budget', () => {
  const shown = suppliedDifference('same-old', 'same-new', 0, 2);
  assert.equal(shown.oldText, ''); assert.equal(shown.newText, ''); assert.equal(shown.same, false);
  assert.equal(shown.omittedBefore, true); assert.equal(shown.omittedAfter, true);
});
