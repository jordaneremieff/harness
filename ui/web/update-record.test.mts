import assert from 'node:assert/strict';
import test from 'node:test';
import { changesSince, changesText, DETAIL_SUBJECTS, nextUpdateRecord, readUpdateRecord } from './update-record.ts';

const id = (digit: string) => digit.repeat(40);
const commits = (count: number) => Array.from({length: count}, (_, index) => ({commit: index.toString(16).padStart(40, '0'), subject: `Change ${index}`}));

test('a tab\'s first load stores the release and shows nothing', () => {
  assert.deepEqual(nextUpdateRecord(undefined, id('a')), {to: id('a'), dismissed: true});
});
test('a different release makes a new notice from the one the tab showed last, and the same release keeps the earlier answer', () => {
  const first = nextUpdateRecord(undefined, id('a'));
  const changed = nextUpdateRecord(first, id('b'));
  assert.deepEqual(changed, {from: id('a'), to: id('b'), dismissed: false});
  assert.equal(nextUpdateRecord(changed, id('b')), changed, 'a reload of the same release brings nothing new back');
  const dismissed = {...changed, dismissed: true};
  assert.deepEqual(nextUpdateRecord(dismissed, id('b')), dismissed, 'a dismissed notice stays dismissed on reload');
  assert.deepEqual(nextUpdateRecord(dismissed, id('c')), {from: id('b'), to: id('c'), dismissed: false}, 'the next update shows again');
});
test('a stored record is read only in its exact shape', () => {
  assert.deepEqual(readUpdateRecord(JSON.stringify({from: id('a'), to: id('b'), dismissed: false})), {from: id('a'), to: id('b'), dismissed: false});
  assert.deepEqual(readUpdateRecord(JSON.stringify({to: id('b'), dismissed: true})), {to: id('b'), dismissed: true});
  for (const bad of [null, '', 'not json', 'null', '[]', JSON.stringify({to: 'short', dismissed: true}), JSON.stringify({to: id('b')}), JSON.stringify({from: 'x', to: id('b'), dismissed: true}), 'x'.repeat(2000)]) assert.equal(readUpdateRecord(bad), undefined);
});
test('the changes are the kept commits newer than the previous release, newest first, twenty shown and the rest counted', () => {
  const list = commits(30);
  assert.deepEqual(changesSince(list, list[3]?.commit), {known: true, subjects: list.slice(0, 3), more: 0});
  const wide = changesSince(list, list[28]?.commit);
  assert.equal(wide.subjects.length, DETAIL_SUBJECTS); assert.equal(wide.more, 28 - DETAIL_SUBJECTS); assert.deepEqual(wide.subjects, list.slice(0, DETAIL_SUBJECTS));
  assert.equal(changesText(list, list[28]?.commit).split('\n').length, 28, 'Copy keeps every kept subject');
  assert.match(changesText(list, list[1]?.commit), /^00000000 Change 0$/);
});
test('an unknown starting point or a missing list gives no changes, never a guess', () => {
  const list = commits(5);
  for (const [recent, from] of [[list, id('f')], [undefined, list[2]?.commit], [list, undefined]] as const) {
    assert.deepEqual(changesSince(recent, from), {known: false, subjects: [], more: 0}); assert.equal(changesText(recent, from), '');
  }
  assert.deepEqual(changesSince(list, list[0]?.commit), {known: true, subjects: [], more: 0}, 'the previous release is the newest one kept');
});
