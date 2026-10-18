import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppFixture} from './app-fixture.mts';
const {arrive, settle, agentControl, primaryFixture, agentFixture, targetFixture, entryFixture, messageFixture, textPart, coverage} = await createAppFixture();

test('one upward scroll near the top reads 50-entry pages until they add ten rows, and never overlaps itself', async t => {
  const original = globalThis.fetch;
  t.after(() => {globalThis.fetch = original;});
  const identity = 'earlier-history-agent', target = {kind: 'agent' as const, identity};
  const requests: (string | null)[] = [];
  let release: (() => void) | undefined;
  const pages = new Map<string | null, {ids: number[]; next: number | null}>([
    [null, {ids: [96, 97, 98, 99, 100, 101], next: 96}],
    ['96', {ids: [90, 91, 92, 93, 94, 95], next: 90}],
    ['90', {ids: [84, 85, 86, 87, 88, 89], next: 84}],
    ['84', {ids: [78, 79, 80, 81, 82, 83], next: 78}],
    ['78', {ids: [72, 73, 74, 75, 76, 77], next: 72}],
    ['72', {ids: [66, 67, 68, 69, 70, 71], next: null}],
  ]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname !== `/api/agents/${identity}/history`) return original(input, init);
    const before = url.searchParams.get('before'); requests.push(before);
    const page = pages.get(before); assert.ok(page, `unexpected boundary ${before}`);
    if (before !== null && release === undefined && requests.length === 2) await new Promise<void>(resolve => { release = resolve; });
    const entries = page.ids.map(id => entryFixture(`h${id}`, [{...messageFixture(`m${id}`, [textPart(`Message ${id}`)]), role: 'assistant'}]));
    return Response.json({ok: true, data: {target, entries, nextBefore: page.next, coverage, revision: `r${before}`}});
  };
  await arrive({workspace: {id: 'earlier-history', revision: 1, primaryKey: 'p', selectedTarget: target}, primaries: [primaryFixture({epoch: 12200})], roster: [agentFixture(identity)], targets: [targetFixture('earlier-history-draft', target)]});
  await settle();
  assert.deepEqual(requests, [null], 'the newest page loads once');
  const transcript = agentControl('transcript');
  const up = async (to: number) => {transcript.scrollTop = 900; transcript.dispatch('scroll'); transcript.scrollTop = to; transcript.dispatch('scroll'); await settle();};
  await up(100);
  assert.deepEqual(requests.slice(1), ['96'], 'the first page is still loading');
  transcript.scrollTop = 900; transcript.dispatch('scroll'); transcript.scrollTop = 50; transcript.dispatch('scroll');
  transcript.dispatch('wheel', {deltaY: -30}); await settle();
  assert.deepEqual(requests.slice(1), ['96'], 'more triggers while a page is loading start nothing');
  release?.(); await settle(); await settle();
  assert.deepEqual(requests.slice(1), ['96', '90'], 'two pages of six rows reach ten rows and stop');
  await up(100);
  assert.deepEqual(requests.slice(1), ['96', '90', '84', '78'], 'the next trigger reads two more');
  await up(100);
  assert.deepEqual(requests.slice(1), ['96', '90', '84', '78', '72'], 'the last page ends the loop');
  await up(100);
  assert.equal(requests.length, 6, 'no earlier page remains, so nothing more is requested');
});
