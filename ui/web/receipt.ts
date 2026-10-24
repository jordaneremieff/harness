import type { OperationView, Target } from '../shared/api.ts';
import { operationLabel } from './operation-label.ts';

export function targetReceipts(operations: Iterable<OperationView>, target?: Target): OperationView[] {
  if (!target) return [];
  return [...operations].filter(item => item.target?.kind === target.kind && (item.target.kind === 'agent' ? target.kind === 'agent' && item.target.identity === target.identity : target.kind === 'primary' && item.target.key === target.key && item.target.epoch === target.epoch) && item.state !== 'reserved' && item.state !== 'dispatched')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
}
export function routineReceipt(records: OperationView[]): string {
  const latest = records[0];
  if (!latest || (latest.state !== 'accepted' && latest.state !== 'completed')) return '';
  return operationLabel(latest);
}
