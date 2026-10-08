import type { ApiResult, ErrorView, EventEnvelope, EventName, OperationKind, OperationView, Target } from '../shared/api.ts';

export class ApiError extends Error {
  readonly view: ErrorView;
  constructor(view: ErrorView) { super(view.message); this.view = view; }
}
export async function request<T>(path: string, method = 'GET', body?: unknown, operationId?: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (operationId) headers['Idempotency-Key'] = operationId;
  const startedAt = performance.now();
  const response = await fetch(workspacePath(path), {method, body: body === undefined ? undefined : JSON.stringify(body), headers, signal: signal ?? (method === 'GET' ? AbortSignal.timeout(15_000) : undefined), credentials: 'same-origin'});
  const result = await response.json() as ApiResult<T>;
  performance.measure('ui:control-roundtrip', {start: startedAt, end: performance.now(), detail: {method, operationId}});
  if (!result.ok) throw new ApiError(result.error);
  return result.data;
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
export const eventNames: EventName[] = ['ready', 'resync', 'primary.state', 'primary.message', 'primary.delta', 'primary.tool', 'primary.entry', 'primary.queue', 'primary.recovery', 'extension.request', 'extension.expired', 'agent.roster', 'agent.frame', 'agent.availability', 'workspace.changed', 'draft.changed', 'reading.changed', 'operation.changed', 'notice'];
export type ReceivedEvent = {name: EventName; id: string; envelope: EventEnvelope; bytes?: number};
export function connect(workspace: string, cursor: string, receive: (event: ReceivedEvent) => void, lost: () => void): EventSource {
  const source = new EventSource(`/api/events?workspace=${encodeURIComponent(workspace)}&after=${encodeURIComponent(cursor)}`);
  for (const name of eventNames) source.addEventListener(name, (event: MessageEvent<string>) => {
    performance.mark('ui:event:receive');
    try { receive({name, id: event.lastEventId, envelope: JSON.parse(event.data) as EventEnvelope, bytes: event.data.length * 2}); }
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
