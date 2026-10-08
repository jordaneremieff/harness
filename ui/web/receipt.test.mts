import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationView, Target } from '../shared/api.ts';
import { routineReceipt, targetReceipts } from './receipt.ts';
const target: Target = {kind: 'primary', key: 'p', epoch: 2};
const operation = (id: string, updatedAt: string, extra: Partial<OperationView> = {}): OperationView => ({id, updatedAt, createdAt: updatedAt, kind: 'primary.input', state: 'accepted', target, ...extra});
test('receipt projection retains both producers and selects the newest target-bound result', () => {
  const records = targetReceipts([operation('input', '2026-10-08T12:00:00Z'), operation('control', '2026-10-08T12:01:00Z', {kind: 'primary.control', state: 'completed'})], target);
  assert.deepEqual(records.map(item => item.id), ['control', 'input']); assert.equal(routineReceipt(records), 'Control completed');
});
test('receipt projection excludes other identities, epochs, pending operations, and missing targets', () => {
  const operations = [operation('old', '', {target: {...target, epoch: 1}}), operation('agent', '', {target: {kind: 'agent', identity: 'p'}}), operation('pending', '', {state: 'dispatched'}), operation('current', '')];
  assert.deepEqual(targetReceipts(operations, target).map(item => item.id), ['current']); assert.deepEqual(targetReceipts(operations), []);
});
test('receipt summaries do not turn admission or uncertainty into completion', () => {
  assert.equal(routineReceipt([operation('input', '')]), 'Admitted');
  assert.equal(routineReceipt([operation('queued', '', {receipt: {kind: 'rpc', disposition: 'queued'}})]), 'Follow-up queued');
  assert.equal(routineReceipt([operation('uncertain', '', {state: 'uncertain'})]), '');
});
