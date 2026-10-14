import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentHistoryPage, HistoryPage, ProjectedFrame, Target} from '../shared/api.ts';
import {app, arrive, settle, event, primaryControl, agentControl, primaryFixture, agentFixture, observation, targetFixture, entryFixture, messageFixture, textPart, coverage} from './app-fixture.mts';
import {targetIdentity} from './state.ts';

const row = (id: string) => entryFixture(id, [messageFixture(`message-${id}`, [textPart(id)])]);
const response = (target: Target, items: HistoryPage['items'], nextCursor: string | null) => Response.json({ok: true, data: {target, items, nextCursor, coverage: {...coverage, complete: nextCursor === null, truncated: nextCursor !== null, omitted: nextCursor ? 50 : 0}}});

test('agent Earlier advances through history boundaries despite unchanged and newer tail frames', async t => {
  const original = globalThis.fetch, identity = 'history-agent-pages', target = {kind: 'agent' as const, identity};
  const rows = (first: number, last: number) => Array.from({length: last - first + 1}, (_, i) => row(String(first + i)));
  const tail = rows(61, 110), frame: ProjectedFrame = {revision: 1, observedAt: 'now', entries: tail, live: [], nextBefore: 61, status: {busy: false}, coverage};
  const boundaries: (number | null)[] = []; const page = (entries: AgentHistoryPage['entries'], nextBefore: number | null) => Response.json({ok: true, data: {target, entries, nextBefore, coverage, revision: 'history'}});
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://ui.test'); if (url.pathname !== `/api/agents/${identity}/history`) return original(input, init);
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null; boundaries.push(before);
    if (before === 61) return page(rows(11, 60), 11);
    if (before === 11) return page(rows(1, 10), null);
    return page(tail, 61);
  };
  const baseline = {workspace: {id: identity, revision: 1, selectedTarget: target}, primaries: [], roster: [agentFixture(identity)], targets: [targetFixture(identity, target)], observations: [observation(identity, frame, 10)]};
  await arrive(baseline); const earlier = agentControl('earlier'), editor = agentControl('editor');
  assert.equal(earlier.hidden, false); earlier.click(); await settle();
  event('agent.frame', {identity, connectionEpoch: 10, frame: {...frame, revision: 2}}); await settle();
  earlier.click(); await settle();
  assert.deepEqual(boundaries, [null, 61, 11]);
  assert.equal(app.state.conversations.get(targetIdentity(target))?.entries.has('5'), true); assert.equal(earlier.hidden, true);
  event('agent.frame', {identity, connectionEpoch: 10, frame: {...frame, revision: 3, entries: [...tail, row('111')], nextBefore: 62}}); await settle();
  assert.equal(earlier.hidden, true);
  await arrive({...baseline, observations: [observation(identity, {...frame, revision: 4}, 10)]});
  assert.equal(agentControl('editor'), editor); assert.equal(earlier.hidden, true); earlier.click(); await settle();
  assert.deepEqual(boundaries, [null, 61, 11, null]);
});
test('agent empty startup permits a populated frame and page to supply the first history boundary', async t => {
  const original = globalThis.fetch, identity = 'history-agent-resume', target = {kind: 'agent' as const, identity}; let resumed = false;
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => new URL(String(input), 'http://ui.test').pathname === `/api/agents/${identity}/history`
    ? Response.json({ok: true, data: {target, entries: resumed ? [row('tail')] : [], nextBefore: resumed ? 61 : null, coverage, revision: 'history'}}) : original(input, init);
  const frame: ProjectedFrame = {revision: 1, observedAt: 'now', entries: [], live: [], nextBefore: null, status: {busy: false}, coverage};
  const baseline = {workspace: {id: identity, revision: 1, selectedTarget: target}, primaries: [], roster: [agentFixture(identity)], targets: [targetFixture(identity, target)], observations: [observation(identity, frame, 10)]};
  await arrive(baseline); const earlier = agentControl('earlier'); assert.equal(earlier.hidden, true); resumed = true;
  event('agent.frame', {identity, connectionEpoch: 10, frame: {...frame, revision: 2, entries: [row('tail')], nextBefore: 61}}); await settle(); assert.equal(earlier.hidden, false);
  await arrive({...baseline, observations: [observation(identity, {...frame, revision: 3, entries: [row('tail')], nextBefore: 61}, 10)]}); assert.equal(earlier.hidden, false);
});
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
