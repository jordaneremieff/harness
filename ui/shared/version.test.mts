import assert from 'node:assert/strict';
import test from 'node:test';
import { UI_ITERATION, identityLabel, identityText, readIdentity, type UiIdentity } from './version.ts';
const identity = {iteration: UI_ITERATION, git: {commit: 'a'.repeat(40), shortCommit: 'a'.repeat(7), branch: 'feature/ui', modified: false,
  committedAt: '2026-10-12T00:00:00.000Z'}, assets: {digest: 'b'.repeat(64), builtAt: '2026-10-12T01:00:00.000Z'},
  startedAt: '2026-10-12T02:00:00.000Z', pi: '1.1.0', durable: '1.1.0'} satisfies UiIdentity;
test('one declared iteration drives clean and modified labels', () => {
  assert.equal(identityLabel(identity), `ui ${UI_ITERATION} · aaaaaaa`);
  assert.equal(identityLabel({...identity, git: {...identity.git, modified: true}}), `ui ${UI_ITERATION} · aaaaaaa · modified`);
  assert.equal(identityLabel({iteration: UI_ITERATION}), `ui ${UI_ITERATION}`);
});
test('full identity retains source, served bytes, times and independently resolved runtimes', () => {
  const text = identityText(identity);
  for (const value of [identity.git.commit, 'feature/ui', 'clean', identity.git.committedAt, identity.assets.digest,
    identity.assets.builtAt, identity.startedAt, 'Pi runtime: 1.1.0', 'Resolved Durable: 1.1.0']) assert.ok(text.includes(value), value);
  assert.equal(identityText({...identity, git: undefined}), `ui ${UI_ITERATION}`);
  assert.match(identityText({...identity, assets: {digest: 'b'.repeat(64)}}), /Asset build time: unknown/);
});
test('served metadata round-trips without replacing it with the browser checkout', () => {
  const served = {...identity, iteration: '4.2', git: {...identity.git, branch: 'feature/<quoted>"'}};
  assert.deepEqual(readIdentity(encodeURIComponent(JSON.stringify(served))), served);
  assert.equal(readIdentity(encodeURIComponent(JSON.stringify({iteration: '4.2'}))).iteration, '4.2');
});
test('malformed current metadata exposes only the declared iteration', () => {
  for (const encoded of [null, '', '%not-json', 'x'.repeat(16385), encodeURIComponent('null'), encodeURIComponent(JSON.stringify({...identity,
    git: {...identity.git, shortCommit: 'fffffff'}})), encodeURIComponent(JSON.stringify({...identity, iteration: ['0.3']})),
    encodeURIComponent(JSON.stringify({...identity, assets: {digest: 'invalid'}})), encodeURIComponent(JSON.stringify({...identity, startedAt: 'unknown'}))]) {
    assert.deepEqual(readIdentity(encoded), {iteration: UI_ITERATION});
  }
});
import { RECENT_COMMITS, RECENT_ENCODED_CHARS, RECENT_SUBJECT_CHARS, boundedRecent, parseRecentCommits, readRecent } from './version.ts';
const hash = (digit: string) => digit.repeat(40);
test('git log output becomes a bounded newest-first list, with control characters removed and malformed lines skipped', () => {
  const output = [`${hash('a')}\0First change`, `${hash('b')}\0Tab\there \u001b[31mand escape`, 'not a record', `${'z'.repeat(40)}\0Not a hash`, `${hash('c')}\0${'x'.repeat(300)}`, `${hash('d')}\0`].join('\n');
  const list = parseRecentCommits(output);
  assert.deepEqual(list.map(item => item.commit), [hash('a'), hash('b'), hash('c')]);
  assert.equal(list[1]?.subject, 'Tab here  [31mand escape', 'each run of control characters becomes one space');
  assert.equal(list[2]?.subject.length, RECENT_SUBJECT_CHARS); assert.ok(list[2]?.subject.endsWith('…'));
  assert.deepEqual(parseRecentCommits(''), []);
});
test('the list keeps at most thirty commits and shrinks to fit the identity even for non-ASCII subjects', () => {
  const many = Array.from({length: 50}, (_, index) => ({commit: String(index % 10).repeat(40), subject: `Change ${index}`}));
  assert.equal(boundedRecent(many).length, RECENT_COMMITS);
  const wide = Array.from({length: 30}, (_, index) => ({commit: String(index % 10).repeat(40), subject: '\u00e9'.repeat(RECENT_SUBJECT_CHARS)}));
  const kept = boundedRecent(wide);
  assert.ok(kept.length > 0 && kept.length < 30); assert.ok(encodeURIComponent(JSON.stringify(kept)).length <= RECENT_ENCODED_CHARS);
  assert.deepEqual(kept, wide.slice(0, kept.length));
});
test('served identity carries the recent list, and an unsafe list is dropped without losing the identity', () => {
  const recent = [{commit: hash('a'), subject: 'Newest'}, {commit: hash('b'), subject: 'Older'}];
  assert.deepEqual(readIdentity(encodeURIComponent(JSON.stringify({...identity, recent}))), {...identity, recent});
  assert.deepEqual(readIdentity(encodeURIComponent(JSON.stringify(identity))), identity, 'no recent key appears when none was served');
  for (const bad of [[], 'text', [{commit: 'short', subject: 'x'}], [{commit: hash('a'), subject: 'a\u0001b'}], [{commit: hash('a'), subject: 'x'.repeat(RECENT_SUBJECT_CHARS + 1)}], Array.from({length: RECENT_COMMITS + 1}, () => ({commit: hash('a'), subject: 'x'}))]) {
    assert.deepEqual(readIdentity(encodeURIComponent(JSON.stringify({...identity, recent: bad}))), identity);
    assert.equal(readRecent(bad), undefined);
  }
});
