import type { ErrorView, Retry } from '../shared/api.ts';
import { StateError } from './state.mts';
import { RpcError } from '../rpc/client.mts';
import { AgentError } from '../agents/index.mts';
import { projectJson, safeText } from './projection.mts';

/** Safe errors carry deliberate public text rather than upstream exception messages. */
export class ApiError extends Error {
  code: string; status: number; retry: Retry; details?: ErrorView['details'];
  constructor(code: string, message: string, status = 400, retry: Retry = 'none', details?: ErrorView['details']) {
    super(message); this.code=code; this.status=status; this.retry=retry; this.details=details;
  }
  view(): ErrorView { return {code: this.code, message: this.message, retry: this.retry, ...(this.details ? {details: this.details} : {})}; }
}
export function errorView(error: unknown): ErrorView {
  if (error instanceof ApiError) return error.view();
  if(error instanceof StateError) return {code:error.code,message:safeText(error.message,512),retry:error.retry,...(error.details?{details:projectJson(error.details)}:{})};
  if(error instanceof RpcError || error instanceof AgentError) return {code:error.code,message:safeText(error.message,512),retry:error.uncertain?'manual':'none'};
  return {code: 'internal', message: 'The local operation failed.', retry: 'manual'};
}
