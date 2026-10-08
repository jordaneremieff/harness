import { LIMITS } from '../shared/api.ts';
import type { OperationView } from '../shared/api.ts';
function definite(operation: OperationView): boolean {return ['accepted', 'rejected', 'completed'].includes(operation.state);}
/** HTTP and journal delivery order cannot undo one operation's definite outcome. */
export function newerOperation(previous: OperationView | undefined, incoming: OperationView): OperationView {
  if (!previous || previous.id !== incoming.id) return incoming;
  if (definite(previous) && previous.state !== incoming.state) return previous;
  if (previous.updatedAt > incoming.updatedAt) return previous;
  return incoming;
}
export function mergeOperationMap(previous: ReadonlyMap<string, OperationView>, incoming: OperationView): ReadonlyMap<string, OperationView> {
  const value = newerOperation(previous.get(incoming.id), incoming);
  if (value === previous.get(incoming.id)) return previous;
  const operations = new Map(previous).set(value.id, value);
  while (operations.size > LIMITS.operations) operations.delete(operations.keys().next().value as string);
  return operations;
}
