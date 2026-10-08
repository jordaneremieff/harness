import type { OperationView } from '../shared/api.ts';
export function inputOperation(operation: OperationView): boolean {return operation.kind === 'primary.input' || operation.kind === 'agent.input';}
function uncertainLabel(operation: OperationView): string {
  if (inputOperation(operation)) return 'Send not confirmed';
  return operation.kind === 'primary.handoff' ? 'Handoff not confirmed' : 'Control response not confirmed';
}
function completedLabel(operation: OperationView): string {
  if (operation.kind === 'primary.handoff') return 'Released for terminal';
  if (operation.kind === 'primary.control') return ({model: 'Model changed', thinking: 'Thinking changed', compact: 'Compaction completed'} as Record<string, string>)[operation.action ?? ''] ?? 'Control completed';
  return 'Control completed';
}
export function operationLabel(operation: OperationView): string {
  if (operation.state === 'uncertain') return uncertainLabel(operation);
  if (operation.state === 'completed') return completedLabel(operation);
  if (operation.state === 'accepted') return inputOperation(operation) ? 'Input admitted' : 'Control accepted';
  if (operation.error) return operation.error.message;
  if (operation.state === 'rejected') return inputOperation(operation) ? 'Input refused' : 'Control refused';
  return operation.state === 'reserved' ? 'Reserved' : 'Requested';
}
