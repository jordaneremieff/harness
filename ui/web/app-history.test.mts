import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type {AgentHistoryPage, HistoryPage, ProjectedFrame, Target} from '../shared/api.ts';
import {createAppFixture} from './app-fixture.mts';
const fixtureHost = await createAppFixture();
const {app, arrive, settle, event, primaryControl, agentControl, primaryFixture, agentFixture, observation, targetFixture, entryFixture, messageFixture, textPart, coverage} = fixtureHost;
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
    const baseline = {workspace: {id: workspace, revision: 1, primaryKey: 'p'}, primaries: [primaryFixture({epoch: target.epoch})], roster: [],
      targets: [targetFixture(workspace, target, {reading: {revision: 9, anchorId: 'late-tail', offsetPx: 25, followTail: false}})]};
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

let readingSerial = 12000;
async function pendingResume(t: TestContext) {
  const original = globalThis.fetch, target = {kind: 'primary' as const, key: 'p', epoch: ++readingSerial}, workspace = `reading-${target.epoch}`;
  const reading = {revision: 9, anchorId: 'saved-anchor', offsetPx: 25, followTail: false};
  const saved = targetFixture(workspace, target, {reading}), ready = primaryFixture({epoch: target.epoch});
  const items = [row('before-anchor'), row('saved-anchor'), ...Array.from({length: 12}, (_, i) => row(`after-${i}`))];
  const pending = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>(); let phase = 'loaded', held = false;
  t.after(() => {globalThis.fetch = original; pending.resolve(response(target, items, null));});
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), 'http://ui.test').pathname !== '/api/primaries/p/history') return original(input, init);
    if (phase === 'resume' && !held) {held = true; entered.resolve(); return pending.promise;}
    return response(target, phase === 'stopped' ? [] : items, null);
  };
  const baseline = {workspace: {id: workspace, revision: 1, primaryKey: 'p'}, primaries: [ready], roster: [], targets: [saved]};
  await arrive(baseline); const root = primaryControl('root'), transcript = primaryControl('transcript');
  // The shared host fixes its event boot ID; relabel the prior boot before the real snapshot replacement.
  app.state.bootId = 'prior-boot'; app.state.cursor = `prior-boot:${app.state.sequence}`;
  phase = 'stopped'; await arrive({...baseline, primaries: [{...ready, lifecycle: 'stopped', capabilities: {}}]});
  transcript.scrollTop = 0; transcript.dispatch('scroll');
  assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading, reading);
  phase = 'resume'; event('primary.state', ready, target); await entered.promise; await settle();
  return {target, workspace, saved, reading, items, root, transcript, baseline,
    finish: async () => {pending.resolve(response(target, items, null)); await settle();},
    fail: async () => {pending.reject(new Error('History read unavailable')); await settle();},
    notifyScroll: () => {transcript.scrollTop = 0; transcript.dispatch('scroll'); transcript.dispatch('scroll'); transcript.dispatch('scrollend');}};
}

test('owned resume history restores the surviving controller and never persists an interim tail', async t => {
  const h = await pendingResume(t);
  h.notifyScroll(); await settle();
  assert.deepEqual(app.state.targets.get(h.saved.targetKey)?.reading, h.reading);
  await h.finish();
  assert.equal(primaryControl('root'), h.root);
  const anchor = h.transcript.querySelector('[data-entry-id="saved-anchor"]'); assert.ok(anchor);
  assert.equal(h.transcript.scrollTop, anchor.offsetTop - h.transcript.offsetTop + h.reading.offsetPx);
  assert.deepEqual(app.state.targets.get(h.saved.targetKey)?.reading, h.reading);
  h.transcript.dispatch('scrollend'); await settle();
  assert.deepEqual(app.state.targets.get(h.saved.targetKey)?.reading, h.reading);
});
test('the final reading intent returns to A after an in-flight B write completes', async t => {
  const h = await pendingResume(t); await h.finish();
  const forward = globalThis.fetch, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const puts: {expectedRevision: number; anchorId: string | null; offsetPx: number; followTail: boolean}[] = [];
  t.after(async () => {release.resolve(); await app.drainDev(AbortSignal.timeout(2000));});
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'PUT' && new URL(String(input), 'http://ui.test').pathname === `/api/workspaces/${h.workspace}/targets/${encodeURIComponent(h.saved.targetKey)}/reading`) {
      puts.push(JSON.parse(String(init.body)));
      if (puts.length === 1) {entered.resolve(); await release.promise;}
    }
    return forward(input, init);
  };
  const durableReading = () => fixtureHost.fixture.targets?.find(saved => saved.targetKey === h.saved.targetKey)?.reading;
  const positionA = h.transcript.scrollTop, valueA = {anchorId: h.reading.anchorId, offsetPx: h.reading.offsetPx, followTail: false};
  assert.deepEqual(durableReading(), h.reading);
  h.transcript.scrollTop = positionA + 30; h.transcript.dispatch('scroll'); h.transcript.dispatch('scrollend');
  await entered.promise;
  assert.deepEqual(puts, [{expectedRevision: h.reading.revision, ...valueA, offsetPx: valueA.offsetPx + 30}]);
  assert.deepEqual(app.state.targets.get(h.saved.targetKey)?.reading, h.reading);
  assert.deepEqual(durableReading(), h.reading);
  h.transcript.scrollTop = positionA; h.transcript.dispatch('scroll'); h.transcript.dispatch('scrollend'); await settle();
  assert.equal(h.transcript.scrollTop, positionA);
  assert.equal(puts.length, 1, 'The final A must wait behind the in-flight B');
  assert.deepEqual(app.state.targets.get(h.saved.targetKey)?.reading, h.reading);
  release.resolve(); await app.drainDev(AbortSignal.timeout(2000)); await settle();
  const finalA = {...h.reading, revision: h.reading.revision + 2};
  assert.deepEqual(app.state.targets.get(h.saved.targetKey)?.reading, finalA);
  assert.deepEqual(durableReading(), finalA);
  assert.deepEqual(puts, [{expectedRevision: h.reading.revision, ...valueA, offsetPx: valueA.offsetPx + 30}, {expectedRevision: h.reading.revision + 1, ...valueA}]);
  assert.equal(app.captureDevCheckpoint().targets.find(saved => saved.targetKey === h.saved.targetKey)?.readingRevision, finalA.revision);
});
test('Latest keeps its newer intent after pane focus refreshes history from a stale saved position', async t => {
  const original=globalThis.fetch,target={kind:'primary' as const,key:'p',epoch:++readingSerial},workspace=`latest-history-${target.epoch}`,side=agentFixture('latest-history-side');
  const reading={revision:9,anchorId:'saved-anchor',offsetPx:25,followTail:false},saved=targetFixture(workspace,target,{reading}),items=[row('before-anchor'),row('saved-anchor'),...Array.from({length:12},(_,index)=>row(`after-${index}`))];
  const tailEntered=Promise.withResolvers<void>(),tailRelease=Promise.withResolvers<void>(),historyEntered=Promise.withResolvers<void>(),history=Promise.withResolvers<Response>();
  const writes:{expectedRevision:number;anchorId:string|null;offsetPx:number;followTail:boolean}[]=[];let refreshing=false,held=false;
  t.after(async()=> {tailRelease.resolve();history.resolve(response(target,items,null));await app.drainDev(AbortSignal.timeout(2000));globalThis.fetch=original;});
  globalThis.fetch=async(input,init)=> {
    const path=new URL(String(input),'http://ui.test').pathname;
    if(refreshing && !held && path === '/api/primaries/p/history') {held=true;historyEntered.resolve();return history.promise;}
    if(refreshing && init?.method === 'PUT' && path === `/api/workspaces/${workspace}/targets/${encodeURIComponent(saved.targetKey)}/reading`) {
      writes.push(JSON.parse(String(init.body)));if(writes.length === 1) {tailEntered.resolve();await tailRelease.promise;}
    }
    return original(input,init);
  };
  await arrive({workspace:{id:workspace,revision:1,primaryKey:'p',conversationLayout:fixtureHost.twoPanes(side.identity)},primaries:[primaryFixture({epoch:target.epoch})],roster:[side],targets:[saved,targetFixture(`${workspace}-side`,{kind:'agent',identity:side.identity})],history:items});
  event('ready',{bootId:'boot',connectionId:'latest-history-stream'});await settle();const transcript=primaryControl('transcript'),latest=primaryControl('latest'),anchor=transcript.querySelector('[data-entry-id="saved-anchor"]');assert.ok(anchor);
  assert.equal(transcript.scrollTop-(anchor.offsetTop-transcript.offsetTop),reading.offsetPx);assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading,reading);assert.equal(app.state.workspace?.conversationLayout?.focusedPane,'agent-pane');
  refreshing=true;latest.dispatch('pointerdown',{isTrusted:true});latest.click();transcript.dispatch('scrollend');assert.equal(app.state.workspace?.conversationLayout?.focusedPane,'primary-pane');await settle();
  assert.equal(writes.length,1,'Latest must enqueue its tail intent before history completes');assert.equal(held,true,'The pane-focus selection must start a history refresh');await tailEntered.promise;await historyEntered.promise;assert.equal(writes[0]?.followTail,true);
  tailRelease.resolve();await settle();assert.equal(app.state.targets.get(saved.targetKey)?.reading.followTail,true);
  history.resolve(response(target,items,null));await settle();transcript.dispatch('scrollend');await app.drainDev(AbortSignal.timeout(2000));await settle();
  assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading,{revision:reading.revision+1,anchorId:null,offsetPx:0,followTail:true});
  assert.deepEqual(fixtureHost.fixture.targets?.find(value=>value.targetKey === saved.targetKey)?.reading,app.state.targets.get(saved.targetKey)?.reading);assert.equal(latest.hidden,true);assert.equal(writes.length,1);
});
test('a same-session stopped snapshot retains the native reader and editor as Last observed across a backend boot', async t => {
  const original=globalThis.fetch,target={kind:'primary' as const,key:'p',epoch:++readingSerial},workspace=`stopped-history-${target.epoch}`;
  const current=primaryFixture({epoch:target.epoch,sessionId:'retained',sessionFile:'/fixture/project/retained.jsonl'}),reading={revision:9,anchorId:'retained-anchor',offsetPx:25,followTail:false},saved=targetFixture(workspace,target,{reading});
  const items=[row('before'),row('retained-anchor'),row('after')];
  t.after(()=>{globalThis.fetch=original;});
  await arrive({workspace:{id:workspace,revision:1,primaryKey:'p'},primaries:[current],roster:[],targets:[saved],history:items});
  const editor=primaryControl('editor'),transcript=primaryControl('transcript'),anchor=transcript.querySelector('[data-entry-id="retained-anchor"]');assert.ok(anchor);editor.focus();editor.setSelectionRange(0,0,'none');editor.scrollTop=16;
  const before=transcript.scrollTop;
  fixtureHost.fixture={...fixtureHost.fixture,primaries:[{...current,lifecycle:'stopped',activity:'unknown',pid:undefined}],history:[],selectedPage:{target,items:[],nextCursor:null,coverage}};
  globalThis.fetch=async(input,init)=>new URL(String(input),'http://ui.test').pathname==='/api/snapshot'?Response.json({ok:true,data:{...fixtureHost.snapshotOf(fixtureHost.fixture,0),bootId:'restarted',cursor:'restarted:0'}}):original(input,init);
  await app.reload();await settle();await app.drainDev(AbortSignal.timeout(2000));await settle();
  assert.equal(primaryControl('editor'),editor);assert.equal(primaryControl('transcript'),transcript);assert.equal(transcript.querySelector('[data-entry-id="retained-anchor"]'),anchor);assert.equal(transcript.scrollTop,before);assert.equal(editor.scrollTop,16);assert.equal(fixtureHost.hostDocument.activeElement,editor);
  assert.equal(app.state.bootId,'restarted');assert.equal(app.state.primaries.get('p')?.lifecycle,'stopped');assert.deepEqual(app.state.conversations.get(targetIdentity(target))?.retainedSession,{id:'retained',file:'/fixture/project/retained.jsonl'});
  assert.equal(primaryControl('observed').hidden,false);assert.equal(primaryControl('observed').textContent,'Last observed');assert.equal(primaryControl('earlier').hidden,true);assert.equal(editor.disabled,false);assert.equal(primaryControl('send').disabled,true);assert.equal(app.state.primaries.get('p')?.lifecycle,'stopped');assert.deepEqual(app.state.targets.get(saved.targetKey)?.reading,reading);
});
test('a failed resume read releases reading persistence without applying the saved position', async t => {
  const h = await pendingResume(t);
  h.notifyScroll(); await settle();
  assert.deepEqual(app.state.targets.get(h.saved.targetKey)?.reading, h.reading);
  await h.fail();
  assert(primaryControl('view-notice').textContent.includes('History could not be loaded'));
  assert.equal(h.transcript.scrollTop, 0);
  h.transcript.dispatch('scrollend'); await settle();
  assert.notDeepEqual(app.state.targets.get(h.saved.targetKey)?.reading, h.reading);
});
for (const type of ['pointerdown', 'keydown', 'beforeinput', 'input', 'change', 'compositionstart', 'compositionend', 'wheel']) {
  test(`trusted ${type} cancels a pending resume reading before late history returns`, async t => {
    const h = await pendingResume(t);
    h.root.dispatch(type, {isTrusted: true});
    await h.finish();
    assert.equal(primaryControl('root'), h.root);
    assert.equal(app.state.conversations.get(targetIdentity(h.target))?.entries.has('saved-anchor'), true);
    assert.equal(h.transcript.scrollTop, 0, 'Late history restored a position after actual input');
    h.transcript.scrollTop = 13; h.transcript.dispatch('scroll'); h.transcript.dispatch('scrollend'); await settle();
    assert.notDeepEqual(app.state.targets.get(h.saved.targetKey)?.reading, h.reading, 'Canceled ownership still blocks later reading persistence');
  });
}
test('untrusted input notifications do not cancel the owned resume reading', async t => {
  const h = await pendingResume(t);
  h.root.dispatch('input', {isTrusted: false}); h.notifyScroll(); await settle();
  assert.deepEqual(app.state.targets.get(h.saved.targetKey)?.reading, h.reading);
  await h.finish();
  const anchor = h.transcript.querySelector('[data-entry-id="saved-anchor"]'); assert.ok(anchor);
  assert.equal(h.transcript.scrollTop, anchor.offsetTop - h.transcript.offsetTop + h.reading.offsetPx);
});
test('hiding a surviving controller cancels resume ownership and rejects its late history', async t => {
  const h = await pendingResume(t);
  await arrive({...h.baseline, workspace: {...h.baseline.workspace, selectedTarget: {kind: 'agent', identity: 'other-reading-owner'}}});
  assert.equal(h.root.hidden, true);
  await h.finish();
  assert.notEqual(app.state.conversations.get(targetIdentity(h.target))?.entries.has('saved-anchor'), true);
  assert.deepEqual(app.state.targets.get(h.saved.targetKey)?.reading, h.reading);
});
test('a tab whose page-load read was aborted by a tab switch reads again when it is selected again', async t => {
  const original = globalThis.fetch, held = Promise.withResolvers<Response>(); let reads = 0;
  const A = {kind: 'agent' as const, identity: 'reselect-a'}, B = {kind: 'agent' as const, identity: 'reselect-b'};
  t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://ui.test').pathname;
    // The selection write is answered locally, so the server state never changes.
    if (init?.method === 'PUT' && path.endsWith('/selection') && app.state.workspace) return Response.json({ok: true, data: {...app.state.workspace, ...JSON.parse(String(init.body)), revision: app.state.workspace.revision + 1}});
    if (path !== `/api/agents/${A.identity}/history`) return original(input, init);
    reads++;
    if (reads > 1) return Response.json({ok: true, data: {target: A, entries: [row('answer')], nextBefore: null, coverage, revision: 'r'}});
    return held.promise;
  };
  await arrive({workspace: {id: 'reselect', revision: 1, selectedTarget: A, conversationLayout: fixtureHost.singlePane([A, B])}, primaries: [], roster: [agentFixture(A.identity, {availability: 'stored', capabilities: {input: false}}), agentFixture(B.identity, {availability: 'stored', capabilities: {input: false}})], targets: [targetFixture('reselect-ta', A), targetFixture('reselect-tb', B)]});
  await settle(); assert.equal(agentControl('history-note-line').textContent, 'Loading messages…'); assert.equal(reads, 1);
  const tab = async (identity: string) => {const node = fixtureHost.paneNode(app.focusedPane).querySelector('.conversation-tabs')?.querySelector(`[data-tab-key="agent:${identity}"]`); assert.ok(node); node.click(); await settle();};
  await tab(B.identity); held.reject(new DOMException('aborted', 'AbortError')); await settle(); await tab(A.identity);
  assert.equal(reads, 2); assert.equal(agentControl('history-note-line').textContent, ''); assert.match(agentControl('transcript').textContent, /answer/);
});
