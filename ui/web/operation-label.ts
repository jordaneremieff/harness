import type { OperationView } from '../shared/api.ts';
export function inputOperation(operation: OperationView): boolean {return operation.kind === 'primary.input' || operation.kind === 'agent.input';}
function uncertainLabel(operation: OperationView): string {
  if (inputOperation(operation)) return 'Delivery not confirmed';
  if (operation.kind === 'agent.command') return 'Command may have run';
  if (operation.kind === 'agent.configure') return 'Settings update not confirmed';
  return operation.kind === 'primary.handoff' ? 'Terminal switch not confirmed' : 'Action not confirmed';
}
function completedLabel(operation: OperationView): string {
  if(operation.kind==='agent.configure')return operation.receipt?.kind==='configuration'&&operation.receipt.clamped?'Settings changed to supported values':'Settings changed';
  if (operation.kind === 'agent.command') return operation.receipt?.kind === 'command' ? `Command /${operation.receipt.name} ran` : 'Command ran';
  if (operation.kind === 'primary.handoff') return 'Ready for terminal';
  if (operation.kind === 'primary.control') return ({model: 'Model changed', thinking: 'Thinking changed', compact: 'Compaction completed'} as Record<string, string>)[operation.action ?? ''] ?? 'Action completed';
  return 'Action completed';
}
function acceptedLabel(operation: OperationView): string {
  if (!inputOperation(operation)) return 'Action requested';
  return operation.receipt?.kind === 'rpc' && operation.receipt.disposition === 'queued' ? 'Message queued' : 'Message sent';
}
export function operationLabel(operation: OperationView): string {
  if (operation.state === 'uncertain') return uncertainLabel(operation);
  if (operation.state === 'completed') return completedLabel(operation);
  if (operation.state === 'accepted') return acceptedLabel(operation);
  if (operation.state === 'rejected') return inputOperation(operation) ? 'Message not sent' : operation.kind === 'agent.command' ? 'Command did not run' : 'Action not completed';
  if (operation.error) return operation.error.message;
  if (operation.state === 'reserved') return inputOperation(operation) ? 'Preparing message' : 'Preparing action';
  return 'Action requested';
}
