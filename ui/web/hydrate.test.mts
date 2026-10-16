import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrimaryView, Snapshot, TargetState } from '../shared/api.ts';
import { hydrateVisible, refreshVisible } from './hydrate.ts';
import { ConnectionRecovery } from './connection-state.ts';
import type { SnapshotReader } from './hydrate.ts';
const primary: PrimaryView = {key: 'p', epoch: 2, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingOperationIds: [], pendingDialogs: [], capabilities: {input: true}};
const target: TargetState = {targetKey: 'p2', target: {kind: 'primary', key: 'p', epoch: 2}, draft: {revision: 4, text: ' exact\n', mode: 'prompt', persisted: true}, reading: {revision: 0, anchorId: null, offsetPx: 0, followTail: true}, unconfirmed: []};
const snapshot = (): Snapshot => ({bootId: 'boot', cursor: 'boot:4', workspace: {id: 'workspace', revision: 2, primaryKey: 'p'}, primaries: [primary], roster: {rows: [], scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}, stale: false}, dialogs: [], pendingOperations: [], targets: [target], targetIndex: [{targetKey: 'p2', target: target.target, draftRevision: 4, hasDraft: true, unconfirmedOperationIds: []}]});
function reader(values: Record<string, unknown>, seen: string[]): SnapshotReader {
  return async <T>(path: string): Promise<T> => {seen.push(path); assert.ok(path in values, path); return values[path] as T;};
}
test('stalled history cannot hold connection recovery after snapshot and stream readiness', async () => {
  const baseline = Promise.withResolvers<void>(); const stream = Promise.withResolvers<void>(); const history = Promise.withResolvers<void>();
  const failures: unknown[] = []; let historyStarted = false; let attempt: Promise<void> | undefined;
  const recovery = new ConnectionRecovery({attempt: () => {
    attempt = refreshVisible(() => baseline.promise, () => {historyStarted = true; return history.promise;}, error => failures.push(error)).then(() => stream.promise);
    return attempt;
  }, paint: () => {}}, {now: () => 0, set: () => 1, clear: () => {}});
  recovery.reconnect(); assert.equal(historyStarted, false);
  baseline.resolve(); await baseline.promise; await Promise.resolve();
  assert.equal(historyStarted, true); assert.equal(recovery.phase, 'quiet');
  stream.resolve(); await attempt; await Promise.resolve();
  assert.equal(recovery.phase, 'healthy'); assert.deepEqual(failures, []);
  history.reject(new Error('History timed out')); await Promise.resolve();
  assert.equal(recovery.phase, 'healthy'); assert.match(String(failures[0]), /History timed out/);
});
test('failed snapshot never launches a detached history refresh', async () => {
  let historyStarted = false;
  await assert.rejects(refreshVisible(async () => {throw new Error('No baseline');}, async () => {historyStarted = true;}, () => {}), /No baseline/);
  assert.equal(historyStarted, false);
});
test('a complete visible snapshot needs no hydration requests', async () => {
  const seen: string[] = []; const original = snapshot(); const result = await hydrateVisible(original, reader({}, seen));
  assert.deepEqual(seen, []); assert.deepEqual(result, original);
});
test('missing active draft fetches only its exact current epoch target key', async () => {
  const seen: string[] = []; const original = {...snapshot(), targets: []};
  original.targetIndex?.push({targetKey: 'p1', target: {kind: 'primary', key: 'p', epoch: 1}, draftRevision: 9, hasDraft: true, unconfirmedOperationIds: []});
  const result = await hydrateVisible(original, reader({'/api/workspaces/workspace/targets/p2': target}, seen));
  assert.deepEqual(seen, ['/api/workspaces/workspace/targets/p2']); assert.equal(result.targets?.[0]?.draft.text, ' exact\n');
});
test('omitted active primary metadata hydrates before target selection', async () => {
  const seen: string[] = []; const original = {...snapshot(), primaries: [], targets: [], omitted: ['primaries', 'targets'] as const};
  const result = await hydrateVisible({...original, omitted: [...original.omitted]}, reader({'/api/primaries/p': primary, '/api/workspaces/workspace/targets/p2': target}, seen));
  assert.deepEqual(seen, ['/api/primaries/p', '/api/workspaces/workspace/targets/p2']); assert.equal(result.primaries[0]?.epoch, 2);
});
test('omitted roster reads cached data and never starts discovery', async () => {
  const seen: string[] = []; const original = snapshot(); original.omitted = ['roster'];
  await hydrateVisible(original, reader({'/api/agents?limit=20': original.roster}, seen));
  assert.deepEqual(seen, ['/api/agents?limit=20']);
});
test('selected agent draft hydrates while observation and sidebar are hidden', async () => {
  const seen: string[] = []; const original = snapshot(); original.workspace = {...original.workspace, panelVisible: false, sidebarVisible: false, selectedTarget: {kind: 'agent', identity: 'a'}};
  original.targetIndex?.push({targetKey: 'a', target: {kind: 'agent', identity: 'a'}, draftRevision: 2, hasDraft: true, unconfirmedOperationIds: []});
  const agent = {...target, targetKey: 'a', target: {kind: 'agent' as const, identity: 'a'}};
  const result = await hydrateVisible(original, reader({'/api/workspaces/workspace/targets/a': agent}, seen));
  assert.deepEqual(seen, ['/api/workspaces/workspace/targets/a']); assert.equal(result.targets?.at(-1), agent);
});
test('active leaves hydrate independent drafts without preparing inactive tabs or duplicating a Message target', async () => {
  const original = snapshot(); const seen: string[] = [];
  original.workspace.conversationLayout = {root: {kind: 'split', id: 's1', axis: 'x', ratio: 50,
    first: {kind: 'pane', id: 'primary', tabs: [{kind: 'primary'}], active: 'primary'},
    second: {kind: 'split', id: 's2', axis: 'y', ratio: 50,
      first: {kind: 'pane', id: 'a', tabs: [{kind: 'agent', identity: 'a'}, {kind: 'agent', identity: 'inactive'}], active: 'agent:a'},
      second: {kind: 'pane', id: 'b', tabs: [{kind: 'agent', identity: 'b'}], active: 'agent:b'}}}, focusedPane: 'primary'};
  const a = {...target, targetKey: 'a', target: {kind: 'agent' as const, identity: 'a'}, draft: {...target.draft, text: 'Draft A'}};
  const b = {...target, targetKey: 'b', target: {kind: 'agent' as const, identity: 'b'}, draft: {...target.draft, text: 'Draft B'}};
  original.targetIndex?.push(...[a, b].map(saved => ({targetKey: saved.targetKey, target: saved.target, draftRevision: saved.draft.revision, hasDraft: true, unconfirmedOperationIds: []})));
  const result = await hydrateVisible(original, reader({'/api/workspaces/workspace/targets/a': a, '/api/workspaces/workspace/targets/b': b}, seen), a.target);
  assert.deepEqual(seen, ['/api/workspaces/workspace/targets/a', '/api/workspaces/workspace/targets/b']);
  assert.deepEqual(result.targets?.map(saved => saved.draft.text), [' exact\n', 'Draft A', 'Draft B']); assert.equal(result.workspace, original.workspace);
});
test('an unindexed restored target stays passive until explicit input intent', async () => {
  const original = snapshot(); original.workspace.selectedTarget = {kind:'agent',identity:'new'};
  const seen:string[] = [];const result = await hydrateVisible(original,reader({},seen));
  assert.deepEqual(seen,[]);assert.deepEqual(result.targets,original.targets);
});
test('an unindexed passive destination never prepares a target during snapshot hydration', async () => {
  for (const destination of [{kind: 'agent' as const, identity: 'inspect'}, {kind: 'primary' as const, key: 'p', epoch: 2}]) {
    const original = snapshot(); original.workspace.selectedTarget = destination;
    if (destination.kind === 'primary') {original.targets = []; original.targetIndex = [];}
    const seen: string[] = []; const result = await hydrateVisible(original, reader({}, seen));
    assert.deepEqual(seen, []); assert.equal(result.targets?.some(saved => saved.target.kind === 'agent'), false);
    assert.equal(result.targets?.find(saved => JSON.stringify(saved.target) === JSON.stringify(destination)), undefined);
  }
});
test('indexed passive hydration still reads the exact complete image draft without preparation', async () => {
  const original = snapshot(); original.targets = [];
  const images = [{name: 'saved.png', digest: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, width: 1, height: 1}];
  const saved = {...target, draft: {...target.draft, images}}; const seen: string[] = [];
  const result = await hydrateVisible(original, reader({'/api/workspaces/workspace/targets/p2': saved}, seen));
  assert.deepEqual(seen, ['/api/workspaces/workspace/targets/p2']); assert.deepEqual(result.targets?.[0]?.draft, saved.draft);
});
test('a failed hydration never turns a missing draft into a blank saved draft', async () => {
  const original = {...snapshot(), targets: []};
  await assert.rejects(hydrateVisible(original, async () => {throw new Error('read unavailable');}), /read unavailable/);
  assert.deepEqual(original.targets, []);
});

test('an explicit message draft hydrates independently of main selection', async () => {
  const seen: string[] = []; const original = snapshot(); const explicit = {kind: 'agent' as const, identity: 'a'};
  original.targetIndex?.push({targetKey: 'a', target: explicit, draftRevision: 2, hasDraft: true, unconfirmedOperationIds: []});
  const agent = {...target, targetKey: 'a', target: explicit};
  const result = await hydrateVisible(original, reader({'/api/workspaces/workspace/targets/a': agent}, seen), explicit);
  assert.deepEqual(seen, ['/api/workspaces/workspace/targets/a']); assert.equal(result.targets?.at(-1), agent); assert.deepEqual(result.workspace, original.workspace);
});

test('visible target hydration reconciles newer indexed drafts and missing unresolved inputs', async () => {
  for (const newerDraft of [false, true]) {
    const seen: string[] = []; const original = snapshot(); const explicit = {kind: 'agent' as const, identity: 'a'};
    const saved = {...target, targetKey: 'a', target: explicit, draft: {...target.draft, revision: 2, text: ''}};
    const fresh = {...saved, draft: {...saved.draft, revision: newerDraft ? 3 : 2, text: newerDraft ? 'remote draft' : ''}, unconfirmed: newerDraft ? [] : [{operationId: 'remote', target: explicit, text: 'remote input', mode: 'followUp', submittedDraftRevision: 2, createdAt: '', reason: 'unknown'}]};
    original.targets?.push(saved); original.targetIndex?.push({targetKey: 'a', target: explicit, draftRevision: fresh.draft.revision, hasDraft: newerDraft, unconfirmedOperationIds: newerDraft ? [] : ['remote']});
    const result = await hydrateVisible(original, reader({'/api/workspaces/workspace/targets/a': fresh}, seen), explicit);
    assert.deepEqual(seen, ['/api/workspaces/workspace/targets/a']); assert.equal(result.targets?.filter(item => item.targetKey === 'a').length, 1); assert.equal(result.targets?.find(item => item.targetKey === 'a'), fresh);
  }
});
