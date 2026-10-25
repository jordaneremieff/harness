import type {OperationView, Target} from '../shared/api.ts';
import {operation, request} from './transport.ts';

/** Capture the admitted input group. The observed generation task is not the Stop selector. */
export async function stopNativeRun(identity:string,isCurrent:()=>boolean=()=>true):Promise<OperationView|undefined|false> {
  const scope=await request<{sessionId:string;runId:number|null;taskId:number|null}>(`/api/agents/${encodeURIComponent(identity)}/run-scope`);
  if(!isCurrent())return false;
  if(scope.sessionId!==identity)throw new Error('The observed run belongs to another conversation.');
  if(scope.runId===null)return;
  if(!Number.isSafeInteger(scope.runId)||scope.runId<1)throw new Error('The native run identity is unavailable.');
  const target:Target={kind:'agent',identity};
  return operation('agent.control',`/api/agents/${encodeURIComponent(identity)}/control`,{method:'run-stop',params:{runId:scope.runId}},target);
}
/** A result selector permits queued withdrawal, not ownership of another active run. */
export function cancelNativeRequest(result:{sessionId:string;submissionId:number;requestId?:string}):Promise<OperationView> {
  const target:Target={kind:'agent',identity:result.sessionId};
  return operation('agent.control',`/api/agents/${encodeURIComponent(result.sessionId)}/control`,{method:'request-cancel',params:{result}},target);
}
