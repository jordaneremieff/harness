import assert from 'node:assert/strict';
import test from 'node:test';
import type {HistoryPage, Target} from '../shared/api.ts';
import {app, arrive, settle, event, primaryControl, primaryFixture, targetFixture, entryFixture, messageFixture, textPart, coverage} from './app-fixture.mts';
import {targetIdentity} from './state.ts';

const row = (id: string) => entryFixture(id, [messageFixture(`message-${id}`, [textPart(id)])]);
const response = (target: Target, items: HistoryPage['items'], nextCursor: string | null) => Response.json({ok: true, data: {target, items, nextCursor, coverage: {...coverage, complete: nextCursor === null, truncated: nextCursor !== null, omitted: nextCursor ? 50 : 0}}});

test('empty startup yields the resumed boundary once, while tail refreshes preserve earlier progress and exhaustion', async t => {
  const original = globalThis.fetch, target = {kind: 'primary' as const, key: 'p', epoch: 11001};
  const saved = targetFixture('history-resume', target);
  const cursors: (string | null)[] = []; let resumed = false;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname !== '/api/primaries/p/history') return original(input, init);
    const cursor = url.searchParams.get('cursor'); cursors.push(cursor);
    if (!resumed) return response(target, [], null);
    if (cursor === 'older') return response(target, [row('middle')], 'oldest');
    if (cursor === 'oldest') return response(target, [row('first')], null);
    return response(target, [row('tail')], 'older');
  };
  const current = primaryFixture({epoch: target.epoch, lifecycle: 'starting'});
  const baseline = {workspace: {id: 'history-resume', revision: 1, primaryKey: 'p'}, primaries: [current], roster: [], targets: [saved]};
  await arrive(baseline);
  const editor = primaryControl('editor'), earlier = primaryControl('earlier');
  assert.equal(earlier.hidden, true); assert.equal(app.state.conversations.get(targetIdentity(target))?.historyCursor, undefined);
  await app.reload(); await settle(); assert.equal(earlier.hidden, true);
  resumed = true;
  const ready = {...current, lifecycle: 'ready' as const, sessionId: 'resumed-session', sessionFile: '/fixture/project/resumed.jsonl'};
  event('primary.state', ready, target); await settle();
  assert.equal(primaryControl('editor'), editor); assert.equal(earlier.hidden, false);
  assert.equal(app.state.conversations.get(targetIdentity(target))?.historyCursor, 'older');
  await arrive({...baseline, primaries: [ready], selectedPage: {target, items: [row('tail')], nextCursor: 'older', coverage}});
  earlier.click(); await settle();
  assert.equal(app.state.conversations.get(targetIdentity(target))?.historyCursor, 'oldest');
  await app.reload(); await settle();
  assert.equal(app.state.conversations.get(targetIdentity(target))?.historyCursor, 'oldest');
  earlier.click(); await settle(); assert.equal(earlier.hidden, true);
  await app.reload(); await settle(); assert.equal(earlier.hidden, true);
  const conversation = app.state.conversations.get(targetIdentity(target));
  assert.equal(conversation?.historyCursor, null);
  assert.deepEqual([...conversation?.entries.keys() ?? []].sort(), ['first', 'middle', 'tail']);
  assert.deepEqual(cursors, [null, null, null, null, 'older', null, 'oldest', null]);
});

test('preloaded resumed entries do not prevent cursor adoption after a cursorless startup page', async t => {
  const original = globalThis.fetch, target = {kind: 'primary' as const, key: 'p', epoch: 11002}; let resumed = false;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname === '/api/primaries/p/history' ? response(target, resumed ? [row('preloaded-tail')] : [], resumed ? 'preloaded-older' : null) : original(input, init);
  const baseline = {workspace: {id: 'history-preloaded', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: []};
  await arrive(baseline); assert.equal(primaryControl('earlier').hidden, true);
  resumed = true;
  await arrive({...baseline, selectedPage: {target, items: [row('preloaded-tail')], nextCursor: 'preloaded-older', coverage}});
  assert.equal(app.state.conversations.get(targetIdentity(target))?.historyCursor, 'preloaded-older');
  assert.equal(primaryControl('earlier').hidden, false);
});

test('an empty bounded page with a cursor owns its pagination boundary', async t => {
  const original = globalThis.fetch, target = {kind: 'primary' as const, key: 'p', epoch: 11003}; let refreshed = false;
  t.after(() => {globalThis.fetch = original;});
  const cursors: (string | null)[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test');
    if (url.pathname !== '/api/primaries/p/history') return original(input, init);
    cursors.push(url.searchParams.get('cursor'));
    return response(target, [], refreshed ? 'newer-tail' : 'filtered-older');
  };
  await arrive({workspace: {id: 'history-filtered', revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: []});
  assert.equal(primaryControl('earlier').hidden, false); refreshed = true; await app.reload(); await settle();
  primaryControl('earlier').click(); await settle();
  assert.deepEqual(cursors, [null, null, 'filtered-older']);
});

for (const change of ['epoch', 'workspace', 'hidden'] as const) {
  test(`late startup history cannot claim a boundary after ${change} ownership changes`, async t => {
    const original = globalThis.fetch, target = {kind: 'primary' as const, key: 'p', epoch: 11010};
    const pending = Promise.withResolvers<Response>(); let first = true;
    t.after(() => {globalThis.fetch = original; pending.resolve(response(target, [row('late-tail')], 'late-older'));});
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'http://ui.test');
      if (url.pathname !== '/api/primaries/p/history') return original(input, init);
      if (first) {first = false; return pending.promise;}
      return response({...target, epoch: change === 'epoch' ? target.epoch + 1 : target.epoch}, [row('current-tail')], 'current-older');
    };
    const workspace = `history-stale-${change}`;
    const baseline = {workspace: {id: workspace, revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: []};
    await arrive(baseline);
    const oldRoot = primaryControl('root'), oldEarlier = primaryControl('earlier');
    if (change === 'hidden') {
      await arrive({...baseline, workspace: {...baseline.workspace, selectedTarget: {kind: 'agent', identity: 'other-history-owner'}}});
      assert.equal(oldRoot.hidden, true);
    } else {
      await arrive({...baseline, workspace: {...baseline.workspace, id: change === 'workspace' ? `${workspace}-new` : workspace}, primaries: [primaryFixture({epoch: change === 'epoch' ? target.epoch + 1 : target.epoch})]});
      assert.equal(primaryControl('earlier').hidden, false);
    }
    pending.resolve(response(target, [row('late-tail')], 'late-older')); await settle();
    assert.equal(oldEarlier.hidden, true);
    assert.notEqual(app.state.conversations.get(targetIdentity(target))?.entries.has('late-tail'), true);
    if (change !== 'hidden') {
      const current = change === 'epoch' ? {...target, epoch: target.epoch + 1} : target;
      assert.equal(app.state.conversations.get(targetIdentity(current))?.historyCursor, 'current-older');
    }
  });
}
