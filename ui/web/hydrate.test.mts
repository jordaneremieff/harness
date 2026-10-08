import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrimaryView, Snapshot, TargetState } from '../shared/api.ts';
import { hydrateVisible } from './hydrate.ts';
import type { SnapshotReader } from './hydrate.ts';
const primary: PrimaryView = {key: 'p', epoch: 2, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingOperationIds: [], pendingDialogs: [], capabilities: {input: true}};
const target: TargetState = {targetKey: 'p2', target: {kind: 'primary', key: 'p', epoch: 2}, draft: {revision: 4, text: ' exact\n', mode: 'prompt', persisted: true}, reading: {revision: 0, anchorId: null, offsetPx: 0, followTail: true}, unconfirmed: []};
const snapshot = (): Snapshot => ({bootId: 'boot', cursor: 'boot:4', workspace: {id: 'workspace', revision: 2, primaryKey: 'p'}, primaries: [primary], roster: {rows: [], scan: {state: 'ready', complete: true, visited: 0, skipped: 0, omitted: 0}, stale: false}, dialogs: [], pendingOperations: [], targets: [target], targetIndex: [{targetKey: 'p2', target: target.target, draftRevision: 4, hasDraft: true, unconfirmedOperationIds: []}]});
function reader(values: Record<string, unknown>, seen: string[]): SnapshotReader {
  return async <T>(path: string): Promise<T> => {seen.push(path); assert.ok(path in values, path); return values[path] as T;};
}
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
test('a hidden selected agent does not hydrate its editor target', async () => {
  const seen: string[] = []; const original = snapshot(); original.workspace = {...original.workspace, panelVisible: false, selectedTarget: {kind: 'agent', identity: 'a'}};
  original.targetIndex?.push({targetKey: 'a', target: {kind: 'agent', identity: 'a'}, draftRevision: 2, hasDraft: true, unconfirmedOperationIds: []});
  await hydrateVisible(original, reader({}, seen)); assert.deepEqual(seen, []);
});
test('a failed hydration never turns a missing draft into a blank saved draft', async () => {
  const original = {...snapshot(), targets: []};
  await assert.rejects(hydrateVisible(original, async () => {throw new Error('read unavailable');}), /read unavailable/);
  assert.deepEqual(original.targets, []);
});
