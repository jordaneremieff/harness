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
