import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRow, EventData, TargetPreparation, Workspace } from '../shared/api.ts';
import type { SelectionChange } from './actions.ts';
import { MessageTarget, SelectionQueue, navigationState, visibleReceipt } from './selection-state.ts';
test('navigation separates the selected conversation, sidebar preference and narrow drawer', () => {
  const workspace: Workspace = {id: 'w', revision: 1, panelVisible: false, selectedTarget: {kind: 'agent', identity: 'a'}};
  assert.deepEqual(navigationState(workspace, false), {sidebarVisible: true, agentSelected: true, editor: 'agent-editor'});
  assert.equal(navigationState(workspace, true).sidebarVisible, false);
  assert.equal(navigationState(workspace, true, true).sidebarVisible, true);
  assert.equal(navigationState({...workspace, sidebarVisible: false}, false).sidebarVisible, false);
  assert.deepEqual(navigationState({...workspace, selectedTarget: undefined}, false), {sidebarVisible: true, agentSelected: false, editor: 'primary-editor'});
  assert.equal(workspace.sidebarVisible, undefined);
});
function setup() {
  let current: Workspace = {id: 'workspace', revision: 0, primaryKey: 'p'};
  const calls: {workspace: Workspace; change: SelectionChange; resolve: (value: Workspace) => void; reject: (error: Error) => void}[] = [];
  const frames: Workspace[] = []; let reloads = 0;
  const queue = new SelectionQueue({current: () => current, paint(workspace) {current = workspace; frames.push(workspace);}, reload: async () => {reloads++;}, save: (workspace, change) => new Promise<Workspace>((resolve, reject) => {calls.push({workspace, change, resolve, reject});})});
  return {queue, calls, frames, get reloads() {return reloads;}};
}
test('cached last selection appears before any network response', async () => {
  const fixture = setup();
  const first = fixture.queue.select({selectedTarget: {kind: 'agent', identity: 'a'}});
  const second = fixture.queue.select({selectedTarget: {kind: 'agent', identity: 'b'}});
  assert.deepEqual(fixture.frames.at(-1)?.selectedTarget, {kind: 'agent', identity: 'b'});
  await Promise.resolve(); assert.equal(fixture.calls.length, 1);
  fixture.calls[0]?.resolve({id: 'workspace', revision: 1, selectedTarget: {kind: 'agent', identity: 'a'}}); await first;
  await Promise.resolve(); assert.equal(fixture.calls[1]?.workspace.revision, 1);
  assert.deepEqual(fixture.frames.at(-1)?.selectedTarget, {kind: 'agent', identity: 'b'});
  fixture.calls[1]?.resolve({id: 'workspace', revision: 2, selectedTarget: {kind: 'agent', identity: 'b'}}); await second;
  assert.equal(fixture.reloads, 1);
});
test('external selection acknowledgment cannot replace pending local intent', async () => {
  const fixture = setup(); const action = fixture.queue.select({selectedTarget: null}); await Promise.resolve();
  const observed = fixture.queue.observe({id: 'workspace', revision: 4, selectedTarget: {kind: 'agent', identity: 'external'}});
  assert.equal(observed.selectedTarget, undefined);
  fixture.calls[0]?.resolve({id: 'workspace', revision: 5}); await action;
  assert.equal(fixture.frames.at(-1)?.selectedTarget, undefined);
});
test('failed selection preserves the confirmed workspace and never retries', async () => {
  const fixture = setup(); const action = fixture.queue.select({primaryKey: 'new'}); await Promise.resolve();
  fixture.calls[0]?.reject(new Error('selection refused'));
  await assert.rejects(action, /selection refused/);
  assert.equal(fixture.frames.at(-1)?.primaryKey, 'p'); assert.equal(fixture.calls.length, 1);
});
test('selection errors use the visible receipt after rollback in either direction', async () => {
  const agent = {kind: 'agent' as const, identity: 'a'};
  for (const previous of [undefined, agent]) {
    const fixture = setup(); fixture.queue.observe({id: 'workspace', revision: 1, primaryKey: 'p', selectedTarget: previous});
    const attempted = previous ? null : agent; const pending = fixture.queue.select({selectedTarget: attempted});
    const optimisticSlot = visibleReceipt(fixture.frames.at(-1));
    let errorSlot = ''; const handled = pending.catch(() => {errorSlot = visibleReceipt(fixture.frames.at(-1));});
    await Promise.resolve(); fixture.calls[0]?.reject(new Error('Selection refused')); await handled;
    assert.equal(errorSlot, previous ? 'agent-receipt' : 'primary-receipt'); assert.notEqual(errorSlot, optimisticSlot);
  }
});
test('sidebar failure uses the current conversation receipt without a connection owner', async () => {
  const fixture = setup(); fixture.queue.observe({id: 'workspace', revision: 1, selectedTarget: {kind: 'agent', identity: 'a'}, sidebarVisible: true});
  const pending = fixture.queue.select({sidebarVisible: false}); let slot = '';
  const handled = pending.catch(() => {slot = visibleReceipt(fixture.frames.at(-1));});
  await Promise.resolve(); fixture.calls[0]?.reject(new Error('Sidebar save refused')); await handled;
  assert.equal(slot, 'agent-receipt'); assert.equal(fixture.frames.at(-1)?.sidebarVisible, true);
});
test('a refused selection does not discard the next queued choice', async () => {
  const fixture = setup(); const first = fixture.queue.select({primaryKey: 'a'}); const second = fixture.queue.select({primaryKey: 'b'}); await Promise.resolve();
  fixture.calls[0]?.reject(new Error('refused')); await assert.rejects(first, /refused/); await Promise.resolve();
  assert.equal(fixture.frames.at(-1)?.primaryKey, 'b'); fixture.calls[1]?.resolve({id: 'workspace', revision: 1, primaryKey: 'b'}); await second;
  assert.equal(fixture.frames.at(-1)?.primaryKey, 'b');
});

test('sidebar preference queues without changing selection or observation', async () => {
  const fixture = setup(); fixture.queue.observe({id: 'workspace', revision: 1, panelVisible: true, selectedTarget: {kind: 'agent', identity: 'a'}});
  const action = fixture.queue.select({sidebarVisible: false});
  assert.equal(fixture.frames.at(-1)?.sidebarVisible, false); assert.equal(fixture.frames.at(-1)?.panelVisible, true);
  assert.deepEqual(fixture.frames.at(-1)?.selectedTarget, {kind: 'agent', identity: 'a'});
  await Promise.resolve(); assert.deepEqual(fixture.calls[0]?.change, {sidebarVisible: false});
  fixture.calls[0]?.resolve({id: 'workspace', revision: 2, panelVisible: true, sidebarVisible: false, selectedTarget: {kind: 'agent', identity: 'a'}}); await action;
});

test('agent panel selection has no primary dependency and sends only the panel intent', async () => {
  const fixture = setup(); fixture.queue.observe({id: 'workspace', revision: 1, panelVisible: false});
  const action = fixture.queue.select({panelVisible: true}); assert.equal(fixture.frames.at(-1)?.primaryKey, undefined); assert.equal(fixture.frames.at(-1)?.panelVisible, true);
  await Promise.resolve(); assert.deepEqual(fixture.calls[0]?.change, {panelVisible: true});
  fixture.calls[0]?.resolve({id: 'workspace', revision: 2, panelVisible: true}); await action;
  assert.equal(fixture.frames.at(-1)?.panelVisible, true); assert.equal(fixture.frames.at(-1)?.primaryKey, undefined);
});

function messageFixture() {
  let workspace: Workspace = {id: 'w', revision: 0}; let paints = 0;
  const calls: {workspaceId: string; target: {kind: 'agent'; identity: string}; result: ReturnType<typeof Promise.withResolvers<TargetPreparation>>}[] = [];
  const message = new MessageTarget({workspace: () => workspace, paint: () => { paints++; }, prepare: (workspaceId, target) => {
    const result = Promise.withResolvers<TargetPreparation>(); calls.push({workspaceId, target, result}); return result.promise;
  }});
  return {message, calls, workspace: (value: Workspace) => { workspace = value; }, paints: () => paints};
}
function prepared(identity: string, availability: TargetPreparation['availability'] = 'live', input = true): TargetPreparation {
  return {availability, capabilities: {input, abort: true, history: true, observe: true, configure: false}, targetState: {targetKey: identity, target: {kind: 'agent', identity}, draft: {revision: 0, text: '', mode: 'followUp', persisted: true}, reading: {revision: 0, anchorId: null, offsetPx: 0, followTail: true}, unconfirmed: []}};
}
test('message prepare captures workspace and exact identity and ignores superseded responses', async () => {
  const f = messageFixture(); const first = f.message.open('storage:first'); const second = f.message.open('storage:second');
  assert.deepEqual(f.calls.map(({workspaceId, target}) => ({workspaceId, target})), [{workspaceId: 'w', target: {kind: 'agent', identity: 'storage:first'}}, {workspaceId: 'w', target: {kind: 'agent', identity: 'storage:second'}}]);
  f.calls[0]?.result.resolve(prepared('storage:first')); await first;
  assert.equal(f.message.current?.prepared, undefined); assert.equal(f.message.ready, false);
  f.calls[1]?.result.resolve(prepared('storage:second')); await second;
  assert.equal(f.message.current?.identity, 'storage:second'); assert.equal(f.message.ready, true); assert.equal(f.paints(), 3);
});
test('close, workspace change and main agent selection each invalidate preparation', async () => {
  for (const invalidate of ['close', 'workspace', 'selection']) {
    const f = messageFixture(); const pending = f.message.open('a'); const before = f.paints();
    if (invalidate === 'close') f.message.close();
    else f.workspace({id: invalidate === 'workspace' ? 'other' : 'w', revision: 1, selectedTarget: invalidate === 'selection' ? {kind: 'agent', identity: 'a'} : undefined});
    f.calls[0]?.result.resolve(prepared('a')); await pending;
    assert.equal(f.paints(), before); assert.equal(f.message.ready, false); assert.equal(f.message.current?.prepared, undefined);
  }
});
test('prepare response alone supplies readiness and stored targets remain safe drafts', async () => {
  for (const availability of ['live', 'stored', 'unavailable', 'incompatible'] as const) for (const input of [false, true]) {
    const f = messageFixture(); const pending = f.message.open('a'); f.calls[0]?.result.resolve(prepared('a', availability, input)); await pending;
    assert.equal(f.message.ready, availability === 'live' && input); assert.equal(f.message.current?.prepared?.targetState.targetKey, 'a');
  }
  const f = messageFixture(); f.workspace({id: 'w', revision: 0, selectedTarget: {kind: 'agent', identity: 'main'}});
  await f.message.open('a'); assert.equal(f.calls.length, 0);
});
test('same-identity reopen rejects the prior generation and mismatched prepared target', async () => {
  const f = messageFixture(); const first = f.message.open('a'); f.message.close(); const second = f.message.open('a');
  f.calls[0]?.result.resolve(prepared('a')); await first; assert.equal(f.message.ready, false);
  f.calls[1]?.result.resolve(prepared('wrong')); await second; assert.match(f.message.current?.error ?? '', /did not match/); assert.equal(f.message.ready, false);
});

function rosterEvent(identity: string, availability?: AgentRow['availability']): EventData['agent.roster'] {
  return {revision: 1, changed: availability ? [{identity, storageId: identity, cwd: '/project', modifiedAt: 0, state: 'idle', availability, owner: 'here', partial: false}] : [], removed: availability ? [] : [identity], scan: {state: 'ready', complete: true, visited: 1, skipped: 0, omitted: 0}, stale: false};
}
test('later roster removal or non-live status revokes readiness but retains the prepared draft', async () => {
  for (const availability of [undefined, 'stored', 'unavailable', 'incompatible'] as const) {
    const f = messageFixture(); const pending = f.message.open('a'); const response = prepared('a'); response.targetState.draft.text = 'keep this draft';
    f.calls[0]?.result.resolve(response); await pending; assert.equal(f.message.ready, true);
    f.message.rosterChanged(rosterEvent('a', availability)); assert.equal(f.message.ready, false);
    assert.equal(f.message.current?.prepared?.targetState.draft.text, 'keep this draft'); assert.equal(f.message.current?.invalidated, true);
    f.message.rosterChanged(rosterEvent('a', 'live')); assert.equal(f.message.ready, false);
    const reopened = f.message.open('a'); f.calls[1]?.result.resolve(prepared('a')); await reopened; assert.equal(f.message.ready, true);
  }
});
test('catalog metadata before an explicit prepare and unrelated later events do not revoke readiness', async () => {
  const f = messageFixture();
  f.message.rosterChanged(rosterEvent('a', 'stored'));
  f.message.availabilityChanged({identity: 'a', state: 'unavailable', capabilities: prepared('a', 'unavailable', false).capabilities});
  const pending = f.message.open('a'); f.calls[0]?.result.resolve(prepared('a')); await pending; assert.equal(f.message.ready, true);
  f.message.rosterChanged(rosterEvent('other')); f.message.availabilityChanged({identity: 'other', state: 'stored', capabilities: prepared('other', 'stored', false).capabilities});
  assert.equal(f.message.ready, true);
  f.message.availabilityChanged({identity: 'a', state: 'stored', capabilities: prepared('a', 'stored', false).capabilities}); assert.equal(f.message.ready, false);
  f.message.availabilityChanged({identity: 'a', state: 'live', capabilities: prepared('a').capabilities}); assert.equal(f.message.ready, false);
});

test('negative evidence during preparation latches through a late live response; unrelated events do not', async () => {
  for (const evidence of ['removed', 'unavailable', 'unrelated']) {
    const f = messageFixture(); const pending = f.message.open('a');
    if (evidence === 'removed') f.message.rosterChanged(rosterEvent('a'));
    else if (evidence === 'unavailable') f.message.availabilityChanged({identity: 'a', state: 'unavailable', capabilities: prepared('a', 'unavailable', false).capabilities});
    else f.message.rosterChanged(rosterEvent('other'));
    const response = prepared('a'); response.targetState.draft.text = 'safe draft'; f.calls[0]?.result.resolve(response); await pending;
    assert.equal(f.message.ready, evidence === 'unrelated'); assert.equal(f.message.current?.prepared?.targetState.draft.text, 'safe draft');
    if (evidence !== 'unrelated') {
      const explicit = f.message.open('a'); f.calls[1]?.result.resolve(prepared('a')); await explicit; assert.equal(f.message.ready, true);
    }
  }
});
