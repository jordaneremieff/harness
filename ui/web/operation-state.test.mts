import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../shared/api.ts';
import type { OperationView } from '../shared/api.ts';
import { newerOperation, mergeOperationMap } from './operation-state.ts';
const view = (state: OperationView['state'], updatedAt = '2026-10-08T12:00:00.000Z'): OperationView => ({id: 'op', kind: 'primary.handoff', state, createdAt: '2026-10-08T12:00:00.000Z', updatedAt});
test('a delayed provisional record never replaces an HTTP definite receipt', () => {
  for (const state of ['accepted', 'rejected', 'completed'] as const) {
    const definite = view(state); assert.equal(newerOperation(definite, view('uncertain')), definite); assert.equal(newerOperation(definite, view('dispatched')), definite);
  }
});
test('newer definite outcomes replace earlier uncertainty', () => {const final = view('completed', '2026-10-08T12:00:01.000Z'); assert.equal(newerOperation(view('uncertain'), final), final);});
test('volatile receipt maps stay bounded and unchanged receipts retain the map', () => {
  const definite = view('completed'); const old = new Map([[definite.id, definite]]);
  assert.equal(mergeOperationMap(old, view('uncertain')), old);
  const crowded = new Map(Array.from({length: LIMITS.operations}, (_, index) => [`op${index}`, {...definite, id: `op${index}`} ]));
  const next = mergeOperationMap(crowded, {...definite, id: 'last'}); assert.equal(next.size, LIMITS.operations); assert.equal(next.has('op0'), false); assert.equal(next.has('last'), true);
});
test('old timestamps never replace newer state and separate operation IDs remain separate', () => {
  const current = view('dispatched', '2026-10-08T12:00:01.000Z'); assert.equal(newerOperation(current, view('reserved')), current);
  const other = {...view('reserved'), id: 'other'}; assert.equal(newerOperation(current, other), other);
});
