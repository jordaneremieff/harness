import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationKind, OperationView } from '../shared/api.ts';
import { inputOperation, operationLabel } from './operation-label.ts';
const operation = (kind: OperationKind, state: OperationView['state']): OperationView => ({id: 'op', kind, state, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z'});
test('uncertain handoff and controls never masquerade as unconfirmed input', () => {
  assert.equal(operationLabel(operation('primary.handoff', 'uncertain')), 'Terminal switch not confirmed');
  assert.equal(operationLabel(operation('primary.control', 'uncertain')), 'Action not confirmed');
  assert.equal(operationLabel(operation('agent.abort', 'uncertain')), 'Action not confirmed');
});
test('a completed handoff replaces its earlier uncertainty with release state', () => {assert.equal(operationLabel(operation('primary.handoff', 'completed')), 'Ready for terminal');});
test('accepted input describes admission, never eventual work completion', () => {
  for (const kind of ['primary.input', 'agent.input'] as const) {assert.equal(inputOperation(operation(kind, 'accepted')), true); assert.equal(operationLabel(operation(kind, 'accepted')), 'Message sent');}
  assert.equal(inputOperation(operation('primary.dialog', 'accepted')), false);
});
test('a definite receipt supersedes a retained provisional error label', () => {
  const error = {code: 'delivery_uncertain', message: 'Target exited before a receipt arrived', retry: 'read' as const};
  assert.equal(operationLabel({...operation('primary.handoff', 'completed'), error}), 'Ready for terminal');
  assert.equal(operationLabel({...operation('primary.input', 'accepted'), error}), 'Message sent');
});
test('input uncertainty and refusal retain their separate meanings', () => {
  assert.equal(operationLabel(operation('primary.input', 'uncertain')), 'Send not confirmed');
  assert.equal(operationLabel(operation('primary.input', 'rejected')), 'Message not sent');
});

test('completed controls use their exact action and retain unknown-action fallback', () => {
  for (const [action, label] of [['model', 'Model changed'], ['thinking', 'Thinking changed'], ['compact', 'Compaction completed']]) assert.equal(operationLabel({...operation('primary.control','completed'), action}), label);
  assert.equal(operationLabel({...operation('primary.control','completed'), action: 'unfamiliar'}), 'Action completed');
  assert.equal(operationLabel({...operation('primary.control','accepted'), action: 'model'}), 'Action requested');
});
test('a command run says what is known: it ran, it may have run, or it did not run', () => {
  assert.equal(operationLabel(operation('agent.command', 'uncertain')), 'Command may have run');
  assert.equal(operationLabel(operation('agent.command', 'rejected')), 'Command did not run');
  assert.equal(operationLabel({...operation('agent.command', 'completed'), receipt: {kind: 'command', name: 'ping', text: 'pong', truncated: false}}), 'Command /ping ran');
  assert.equal(inputOperation(operation('agent.command', 'completed')), false);
});
