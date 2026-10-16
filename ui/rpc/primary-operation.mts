import {AsyncLocalStorage} from 'node:async_hooks';
import type {OwnerMutation} from '../shared/owner.ts';
const operations = new AsyncLocalStorage<{operationId: string; digest: string; step: number}>();
export function withPrimaryOperation<T>(operationId: string, digest: string, work: () => Promise<T>): Promise<T> {return operations.run({operationId, digest, step: 0}, work);}
export function primaryMutation(command: string): OwnerMutation | undefined {
  const current = operations.getStore();
  return current ? {operationId: current.operationId, digest: current.digest, step: `${++current.step}:${command}`} : undefined;
}
