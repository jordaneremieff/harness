import assert from 'node:assert/strict';
import test from 'node:test';
import {suppliedDifference, differenceNotice} from './supplied-difference.ts';

const shape = (oldText: string, newText: string, chars?: number, lines?: number) => {
  const {contextBefore, removed, added, contextAfter} = suppliedDifference(oldText, newText, chars, lines);
  return {contextBefore, removed, added, contextAfter};
};
function bounded(oldText: string, newText: string, chars: number, lines: number): void {
  const shown = suppliedDifference(oldText, newText, chars, lines);
  for (const side of [shown.removed, shown.added]) {
    const text = side.join('\n');
    assert.ok(text.length <= chars); assert.ok(side.length <= lines); assert.equal(text.isWellFormed(), true);
  }
  for (const line of [shown.contextBefore, shown.contextAfter]) if (line !== null) { assert.ok(line.length <= chars / 2); assert.equal(line.isWellFormed(), true); }
}
test('an append shows the last old line once as context and only the new lines as added', () => {
  assert.deepEqual(shape('a\nb.', 'a\nb.\nc'), {contextBefore: 'b.', removed: [], added: ['c'], contextAfter: null});
  assert.deepEqual(shape('a\nb.\n', 'a\nb.\nc\nd\n'), {contextBefore: 'b.', removed: [], added: ['c', 'd'], contextAfter: null});
  assert.equal(suppliedDifference('a\nb.', 'a\nb.\nc').omittedBefore, true);
  assert.equal(suppliedDifference('b.', 'b.\nc').omittedBefore, false);
});
test('an insertion in the middle shows the new lines between two shared lines and repeats nothing', () => {
  const shown = suppliedDifference('x\ny\nz', 'x\nI\ny\nz');
  assert.deepEqual(shape('x\ny\nz', 'x\nI\ny\nz'), {contextBefore: 'x', removed: [], added: ['I'], contextAfter: 'y'});
  assert.equal(shown.omittedBefore, false); assert.equal(shown.omittedAfter, true);
  assert.equal(differenceNotice(shown), 'Later context omitted.');
  const everything = [shown.contextBefore, ...shown.removed, ...shown.added, shown.contextAfter];
  assert.equal(everything.includes('z'), false);
});
test('a deletion shows only the removed lines between two shared lines', () => {
  const shown = suppliedDifference('x\ny\nz', 'x\nz');
  assert.deepEqual(shape('x\ny\nz', 'x\nz'), {contextBefore: 'x', removed: ['y'], added: [], contextAfter: 'z'});
  assert.equal(shown.omittedBefore, false); assert.equal(shown.omittedAfter, false); assert.equal(differenceNotice(shown), '');
  assert.deepEqual(shape('a\nb\nc.\nd', 'a\nb'), {contextBefore: 'b', removed: ['c.', 'd'], added: [], contextAfter: null});
  assert.deepEqual(shape('a\nb\nc', 'a\nb\n'), {contextBefore: 'b', removed: ['c'], added: [], contextAfter: null});
});
test('a change inside one line keeps that line as one removed and one added line', () => {
  assert.deepEqual(shape('a\nfoo bar\nc', 'a\nfoo baz\nc'), {contextBefore: 'a', removed: ['foo bar'], added: ['foo baz'], contextAfter: 'c'});
  assert.deepEqual(shape('old\n', 'new\n'), {contextBefore: null, removed: ['old'], added: ['new'], contextAfter: null});
  assert.equal(differenceNotice(suppliedDifference('old', 'new')), '');
  assert.deepEqual(shape('return a - b;\n', 'return a + b;\n'), {contextBefore: null, removed: ['return a - b;'], added: ['return a + b;'], contextAfter: null});
});
test('a removed empty line is a line; an empty side has none', () => {
  assert.deepEqual(shape('a\n\nb', 'a\nb'), {contextBefore: 'a', removed: [''], added: [], contextAfter: 'b'});
  assert.deepEqual(shape('', 'text'), {contextBefore: null, removed: [], added: ['text'], contextAfter: null});
  assert.deepEqual(shape('text', ''), {contextBefore: null, removed: ['text'], added: [], contextAfter: null});
  assert.deepEqual(shape('a', 'a\n'), {contextBefore: 'a', removed: [], added: [''], contextAfter: null});
});
test('identical texts keep the notice and mark no shared context', () => {
  const shown = suppliedDifference('same\nlines', 'same\nlines');
  assert.equal(shown.same, true); assert.equal(shown.contextBefore, null); assert.equal(shown.contextAfter, null);
  assert.equal(differenceNotice(shown), 'No differing text in supplied pair.');
  assert.equal(differenceNotice(suppliedDifference('', '')), '');
});
test('line endings that differ alone keep the line as removed and added', () => {
  assert.deepEqual(shape('a\r\nb', 'a\nb'), {contextBefore: null, removed: ['a'], added: ['a'], contextAfter: 'b'});
});
test('the first differing region survives long same-line and multiline matching prefixes', () => {
  for (const prefix of ['same\n'.repeat(2000), 'x'.repeat(12000), '😀'.repeat(6000)]) {
    const oldText = `${prefix}OLD\n${'tail\n'.repeat(100)}`, newText = `${prefix}NEW\n${'tail\n'.repeat(100)}`;
    const shown = suppliedDifference(oldText, newText, 500, 2);
    assert.match(shown.removed.join('\n'), /OLD/); assert.match(shown.added.join('\n'), /NEW/);
    assert.equal(shown.omittedBefore, true); assert.equal(shown.omittedAfter, true); assert.equal(shown.scanLimited, false);
    assert.match(differenceNotice(shown), /Later context omitted/); bounded(oldText, newText, 500, 2);
  }
});
test('insertion, deletion and empty sides retain truthful windows', () => {
  for (const [oldText, newText] of [['', 'inserted'], ['deleted', ''], ['', '']]) {
    const shown = suppliedDifference(oldText, newText);
    assert.deepEqual(shown.removed, oldText ? [oldText] : []); assert.deepEqual(shown.added, newText ? [newText] : []);
    assert.equal(shown.omittedBefore, false); assert.equal(shown.omittedAfter, false);
  }
  const prefix = 'unchanged\n'.repeat(1000);
  const inserted = suppliedDifference(prefix, `${prefix}inserted`);
  assert.deepEqual(inserted.removed, []); assert.deepEqual(inserted.added, ['inserted']); assert.equal(inserted.same, false);
  assert.equal(inserted.contextBefore, 'unchanged'); assert.equal(inserted.omittedBefore, true);
  const deleted = suppliedDifference(`${prefix}deleted`, prefix);
  assert.deepEqual(deleted.removed, ['deleted']); assert.deepEqual(deleted.added, []); assert.equal(deleted.same, false);
});
test('Unicode boundaries never split a surrogate pair at the window start or end', () => {
  const prefix = '😀'.repeat(500);
  const oldText = `${prefix}😃tail`, newText = `${prefix}😄tail`;
  for (const chars of [4, 5, 20, 79, 80, 81, 500]) {
    const shown = suppliedDifference(oldText, newText, chars, 2);
    assert.match(shown.removed.join('\n'), /😃/); assert.match(shown.added.join('\n'), /😄/); bounded(oldText, newText, chars, 2);
  }
  bounded('😀'.repeat(1000), '😀'.repeat(1000), 499, 2);
  const shared = '😀'.repeat(300);
  for (const chars of [2, 3, 5, 99, 401]) bounded(`${shared}\nold\n${shared}`, `${shared}\nnew\n${shared}`, chars, 2);
});
test('LF, CRLF and CR windows locate the change without spending their lines on preceding context', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const prefix = `same${newline}`.repeat(1000);
    const oldText = `${prefix}old${newline}tail${newline}end`, newText = `${prefix}new${newline}tail${newline}end`;
    const shown = suppliedDifference(oldText, newText, 500, 2);
    assert.deepEqual(shown.removed, ['old']); assert.deepEqual(shown.added, ['new']);
    assert.equal(shown.contextBefore, 'same'); assert.equal(shown.contextAfter, 'tail'); assert.equal(shown.omittedAfter, true);
    bounded(oldText, newText, 500, 2);
  }
  const shown = suppliedDifference('a\r\nb', 'a\r\nC', 1, 2);
  assert.deepEqual(shown.removed, ['b']); assert.deepEqual(shown.added, ['C']);
  assert.equal(shown.contextBefore, null); assert.equal(shown.omittedBefore, true);
  bounded('a\r\nb', 'a\r\nb', 2, 2);
});
test('shared lines longer than the context bound are shortened and reported as omitted', () => {
  const long = 'y'.repeat(300);
  const shown = suppliedDifference(`${long}\nold\n${long}`, `${long}\nnew\n${long}`);
  assert.equal(shown.contextBefore, 'y'.repeat(200)); assert.equal(shown.contextAfter, 'y'.repeat(200));
  assert.equal(shown.omittedBefore, true); assert.equal(shown.omittedAfter, true);
  const tight = suppliedDifference('abcdef\nold\nabcdef', 'abcdef\nnew\nabcdef', 5, 2);
  assert.equal(tight.contextBefore, 'ab'); assert.equal(tight.contextAfter, 'ab');
});
test('scan exhaustion is explicit and does not claim a located change or an identical pair', () => {
  const prefix = 'x'.repeat(65536);
  const shown = suppliedDifference(`${prefix}old`, `${prefix}new`, 500, 2);
  assert.equal(shown.scanLimited, true); assert.equal(shown.same, false); assert.equal(shown.omittedBefore, false);
  assert.deepEqual(shown.removed, ['x'.repeat(500)]); assert.deepEqual(shown.added, ['x'.repeat(500)]);
  assert.equal(shown.contextBefore, null); assert.equal(shown.contextAfter, null);
  assert.match(differenceNotice(shown), /First difference not located within scan limit/);
  assert.doesNotMatch(differenceNotice(shown), /No differing text/);
  assert.equal(suppliedDifference(prefix, `${prefix}added`).scanLimited, false);
});
test('a complete retained identical pair is distinct from an unlocated difference', () => {
  const shown = suppliedDifference('same\n'.repeat(1000), 'same\n'.repeat(1000), 500, 2);
  assert.equal(shown.same, true); assert.equal(shown.scanLimited, false); assert.equal(shown.omittedAfter, true);
  assert.match(differenceNotice(shown), /No differing text in supplied pair/);
});
test('zero text room never invents an empty original side or exceeds its budget', () => {
  const shown = suppliedDifference('same-old', 'same-new', 0, 2);
  assert.deepEqual(shown.removed, []); assert.deepEqual(shown.added, []); assert.equal(shown.same, false);
  assert.equal(shown.omittedBefore, true); assert.equal(shown.omittedAfter, true);
});
