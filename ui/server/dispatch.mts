import type { DispatchResult, ExecuteRequest } from './operations.mts';
import type { Registry } from './registry.mts';
import type { OperationView } from '../shared/api.ts';
import { ApiError, errorView } from './errors.mts';
import { RpcError } from '../rpc/client.mts';
import { AgentError } from '../agents/index.mts';
import { StateError } from './state.mts';

/** A definite refusal is not transport uncertainty. Unclassified dispatch errors remain uncertain. */
export async function execute(registry: Registry, id: string | undefined, request: ExecuteRequest, work: ()=>Promise<DispatchResult>): Promise<OperationView> {
  if (!id) throw new ApiError('unknown_operation','Reserve an operation before this action.',404);
  registry.options.measure?.('input.receipt',id,performance.now());
  return registry.operations.execute(id,request,async()=> {
    registry.options.measure?.('persistence.complete',id,performance.now());
    try { return await work(); }
    catch(error) {
      const definite = error instanceof ApiError || error instanceof StateError ||
        (error instanceof RpcError && !error.uncertain && ['invalid_request','unsupported','not_ready','capacity','rpc_rejected','stale_epoch'].includes(error.code)) ||
        (error instanceof AgentError && ['invalid_request','unsupported','not_ready','capacity','host_unavailable','contract_mismatch','stored'].includes(error.code));
      if(!definite) throw error;
      return {state:'rejected',error:errorView(error)};
    }
  });
}
