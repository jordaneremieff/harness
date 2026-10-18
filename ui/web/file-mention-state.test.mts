import assert from 'node:assert/strict';
import test from 'node:test';
import { directoryOf, mentionToken, shortDirectory } from './file-mention-state.ts';

test('an at sign that starts a word with the caret inside it is a mention', () => {
  assert.deepEqual(mentionToken('@read', 5, 5), {start: 0, end: 5, query: 'read'});
  assert.deepEqual(mentionToken('see @src/a and more', 10, 10), {start: 4, end: 10, query: 'src/a'});
  assert.deepEqual(mentionToken('see @src/a and more', 7, 7), {start: 4, end: 10, query: 'src/a'}, 'the whole word names the query');
  assert.deepEqual(mentionToken('line one\n@two', 13, 13), {start: 9, end: 13, query: 'two'});
  assert.deepEqual(mentionToken('@', 1, 1), {start: 0, end: 1, query: ''});
});
test('addresses, selections, and carets outside the word are not mentions', () => {
  assert.equal(mentionToken('mail me@example.com', 19, 19), undefined);
  assert.equal(mentionToken('@read', 0, 0), undefined, 'before the at sign');
  assert.equal(mentionToken('@read', 1, 4), undefined, 'a selection');
  assert.equal(mentionToken('word @', 3, 3), undefined);
  assert.equal(mentionToken('a @b c', 6, 6), undefined, 'after the space that ends the word');
  assert.equal(mentionToken('', 0, 0), undefined);
});
test('a long directory keeps its distinguishing tail', () => {
  assert.equal(shortDirectory('ui/web'), 'ui/web'); assert.equal(shortDirectory(''), '');
  const long = 'very/long/directory/name/that/keeps/going/web/ui';
  const short = shortDirectory(long); assert.ok(short.startsWith('…/')); assert.ok(short.endsWith('web/ui')); assert.ok(short.length <= 28);
  assert.equal(directoryOf('a/b/c.txt'), 'a/b'); assert.equal(directoryOf('c.txt'), '');
});
