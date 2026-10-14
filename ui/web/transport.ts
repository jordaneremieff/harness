import { LIMITS } from '../shared/api.ts';
import type { ApiResult, DraftImage, ImageUploadView, ErrorView, EventEnvelope, EventName, OperationKind, OperationView, Target } from '../shared/api.ts';

export class ApiError extends Error {
  readonly view: ErrorView;
  constructor(view: ErrorView) { super(view.message); this.view = view; }
}
let requestTiming: ((start: number, end: number) => void) | undefined;
export function setRequestTiming(timing?: (start: number, end: number) => void): void {requestTiming = timing;}
let unauthorizedHandler: ((error: ApiError) => void) | undefined;
export function setUnauthorizedHandler(handler?: (error: ApiError) => void): void { unauthorizedHandler = handler; }
export async function request<T>(path: string, method = 'GET', body?: unknown, operationId?: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (operationId) headers['Idempotency-Key'] = operationId;
  const startedAt = performance.now(), timing = requestTiming;
  const response = await fetch(workspacePath(path), {method, body: body === undefined ? undefined : JSON.stringify(body), headers, signal: signal ?? (method === 'GET' ? AbortSignal.timeout(15_000) : undefined), credentials: 'same-origin'});
  const result = await response.json() as ApiResult<T>;
  try {timing?.(startedAt, performance.now());} catch { /* Diagnostics do not change the API result. */ }
  return responseValue(response, result);
}
function responseValue<T>(response: Response, result: ApiResult<T>): T {
  if (!result.ok) {
    const error = new ApiError(result.error);
    if (response.status === 401 || error.view.code === 'unauthorized') unauthorizedHandler?.(error);
    throw error;
  }
  return result.data;
}
/** The path workspace and captured epoch are authoritative for binary intake. */
export async function uploadDraftImage(workspace: string, targetKey: string, target: Target, image: Pick<DraftImage, 'mimeType' | 'name'>, bytes: Blob, signal: AbortSignal): Promise<ImageUploadView> {
  if (!bytes.size || bytes.size > LIMITS.imageBytes) throw new Error('Image exceeds the upload limit.');
  const query = new URLSearchParams({name: image.name});
  if (target.kind === 'primary') query.set('epoch', String(target.epoch));
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace)}/targets/${encodeURIComponent(targetKey)}/images?${query}`, {
    method: 'POST', body: bytes, headers: {'Content-Type': image.mimeType}, credentials: 'same-origin',
    signal: AbortSignal.any([signal, AbortSignal.timeout(LIMITS.imageReceiveMs)]),
  });
  return responseValue(response, await response.json() as ApiResult<ImageUploadView>);
}
export function draftImageUrl(workspace: string, targetKey: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid image identity.');
  return `/api/workspaces/${encodeURIComponent(workspace)}/targets/${encodeURIComponent(targetKey)}/images/${digest}`;
}
export function workspacePath(path: string): string {
  if (typeof location === 'undefined' || !path.startsWith('/api/')) return path;
  const workspace = new URL(location.href).searchParams.get('workspace');
  if (!workspace) return path;
  const url = new URL(path, location.href);
  if (!url.searchParams.has('workspace')) url.searchParams.set('workspace', workspace);
  return `${url.pathname}${url.search}`;
}
export async function reserve(kind: OperationKind, target?: Target): Promise<string> {
  const reservation = await request<{operationId: string}>('/api/operations', 'POST', {kind, target});
  return reservation.operationId;
}
export async function operation(kind: OperationKind, path: string, body: unknown, target?: Target, reserved?: string): Promise<OperationView> {
  const id = reserved ?? await reserve(kind, target);
  return request<OperationView>(path, 'POST', body, id);
}
export const eventNames: EventName[] = ['ready', 'resync', 'primary.state', 'primary.message', 'primary.delta', 'primary.tool', 'primary.entry', 'primary.queue', 'primary.recovery', 'extension.request', 'extension.expired', 'agent.roster', 'agent.frame', 'agent.availability', 'workspace.changed', 'files.changed', 'draft.changed', 'reading.changed', 'operation.changed', 'notice'];
export type ReceivedEvent = {name: EventName; id: string; envelope: EventEnvelope; bytes?: number; receivedAt?: number};
export function connect(workspace: string, cursor: string, receive: (event: ReceivedEvent) => void, lost: () => void): EventSource {
  const source = new EventSource(`/api/events?workspace=${encodeURIComponent(workspace)}&after=${encodeURIComponent(cursor)}`);
  for (const name of eventNames) source.addEventListener(name, (event: MessageEvent<string>) => {
    const receivedAt = performance.now();
    try { receive({name, id: event.lastEventId, envelope: JSON.parse(event.data) as EventEnvelope, bytes: event.data.length * 2, receivedAt}); }
    catch { source.close(); lost(); }
  });
  source.onerror = () => { source.close(); lost(); };
  return source;
}
export async function authenticate(): Promise<void> {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const capability = fragment.get('launch');
  if (!capability) return;
  url.hash = '';
  history.replaceState(null, '', url);
  await request('/api/auth/launch', 'POST', {capability});
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'The request failed.'; }
