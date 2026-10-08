import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationKind, OperationView } from '../shared/api.ts';
import { inputOperation, operationLabel } from './operation-label.ts';
const operation = (kind: OperationKind, state: OperationView['state']): OperationView => ({id: 'op', kind, state, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z'});
test('uncertain handoff and controls never masquerade as unconfirmed input', () => {
  assert.equal(operationLabel(operation('primary.handoff', 'uncertain')), 'Handoff not confirmed');
  assert.equal(operationLabel(operation('primary.control', 'uncertain')), 'Control response not confirmed');
  assert.equal(operationLabel(operation('agent.abort', 'uncertain')), 'Control response not confirmed');
});
test('a completed handoff replaces its earlier uncertainty with release state', () => {assert.equal(operationLabel(operation('primary.handoff', 'completed')), 'Released for terminal');});
test('accepted input describes admission, never eventual work completion', () => {
  for (const kind of ['primary.input', 'agent.input'] as const) {assert.equal(inputOperation(operation(kind, 'accepted')), true); assert.equal(operationLabel(operation(kind, 'accepted')), 'Input admitted');}
  assert.equal(inputOperation(operation('primary.dialog', 'accepted')), false);
});
test('a definite receipt supersedes a retained provisional error label', () => {
  const error = {code: 'delivery_uncertain', message: 'Target exited before a receipt arrived', retry: 'read' as const};
  assert.equal(operationLabel({...operation('primary.handoff', 'completed'), error}), 'Released for terminal');
  assert.equal(operationLabel({...operation('primary.input', 'accepted'), error}), 'Input admitted');
});
test('input uncertainty and refusal retain their separate meanings', () => {
  assert.equal(operationLabel(operation('primary.input', 'uncertain')), 'Send not confirmed');
  assert.equal(operationLabel(operation('primary.input', 'rejected')), 'Input refused');
});

test('completed controls use their exact action and retain unknown-action fallback', () => {
  for (const [action, label] of [['model', 'Model changed'], ['thinking', 'Thinking changed'], ['compact', 'Compaction completed']]) assert.equal(operationLabel({...operation('primary.control','completed'), action}), label);
  assert.equal(operationLabel({...operation('primary.control','completed'), action: 'unfamiliar'}), 'Control completed');
  assert.equal(operationLabel({...operation('primary.control','accepted'), action: 'model'}), 'Control accepted');
});
