import { LIMITS, LAYOUT_VERSION, LAYOUT_VERSION_HEADER } from '../shared/api.ts';
import type { ApiResult, DraftImage, ImageUploadView, ErrorView, EventEnvelope, EventName, OperationKind, OperationView, Target } from '../shared/api.ts';

export class ApiError extends Error {
  readonly view: ErrorView;
  constructor(view: ErrorView) { super(view.message); this.view = view; }
}
let requestTiming: ((start: number, end: number) => void) | undefined;
export function setRequestTiming(timing?: (start: number, end: number) => void): void {requestTiming = timing;}
export async function request<T>(path: string, method = 'GET', body?: unknown, operationId?: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (method === 'PUT' && /^\/api\/workspaces\/[^/?]+\/selection(?:\?|$)/.test(path) || path === '/api/dev/ack') headers[LAYOUT_VERSION_HEADER] = String(LAYOUT_VERSION);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (operationId) headers['Idempotency-Key'] = operationId;
  const startedAt = performance.now(), timing = requestTiming;
  const response = await fetch(workspacePath(path), {method, body: body === undefined ? undefined : JSON.stringify(body), headers, signal: signal ?? (method === 'GET' ? AbortSignal.timeout(15_000) : undefined), credentials: 'same-origin'});
  const result = await response.json() as ApiResult<T>;
  try {timing?.(startedAt, performance.now());} catch { /* Diagnostics do not change the API result. */ }
  return responseValue(result);
}
/** Existing lease routes bind this loaded module family to its layout capability. */
export async function acknowledgeLayoutPage(signal:AbortSignal):Promise<boolean> {
  const meta=(name:string)=>document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  const client=meta('ui-client'),generation=meta('ui-generation')?.content,family=meta('ui-module-family')?.content;
  const css=[...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link=>/^\/_ui\/([a-f0-9]{64})\/style\.css$/.exec(new URL(link.href).pathname)?.[1]).find(Boolean);
  if(!client||!/^[a-f0-9]{24}$/.test(client.content)||!generation||!family||!css)return false;
  const prior=client.content;
  const lease=await request<{lease:'present'|'missing'|'replaced';client?:string}>('/api/dev/lease','POST',{client:prior,generation,cssGeneration:css,family},undefined,signal);
  if(client.content!==prior||signal.aborted||!['present','replaced'].includes(lease.lease))return false;
  if(lease.lease==='replaced'){
    if(!lease.client||!/^[a-f0-9]{24}$/.test(lease.client))throw new Error('The page lease identity is invalid.');
    client.content=lease.client;
  }
  await request('/api/dev/ack','POST',{client:client.content,generation,cssGeneration:css},undefined,signal);
  return true;
}
function responseValue<T>(result: ApiResult<T>): T {
  if (!result.ok) {
    const error = new ApiError(result.error);
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
  return responseValue(await response.json() as ApiResult<ImageUploadView>);
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
export const eventNames: EventName[] = ['ready', 'resync', 'primary.state', 'primary.message', 'primary.delta', 'primary.tool', 'primary.entry', 'primary.queue', 'primary.recovery', 'extension.request', 'extension.expired', 'agent.roster', 'agent.frame', 'agent.availability', 'workspace.changed', 'files.changed', 'sessions.writers', 'sessions.metadata', 'draft.changed', 'reading.changed', 'operation.changed', 'notice', 'control.request'];
export type ReceivedEvent = {name: EventName; id: string; envelope: EventEnvelope; bytes?: number; receivedAt?: number};
export function connect(workspace: string, cursor: string, receive: (event: ReceivedEvent) => void, lost: () => void, clientId?:string, agents?:readonly string[]): EventSource {
  const source = new EventSource(`/api/events?workspace=${encodeURIComponent(workspace)}&after=${encodeURIComponent(cursor)}${clientId ? `&clientId=${encodeURIComponent(clientId)}` : ''}${agents !== undefined ? `&agents=${encodeURIComponent(JSON.stringify(agents))}` : ''}`);
  for (const name of eventNames) source.addEventListener(name, (event: MessageEvent<string>) => {
    const receivedAt = performance.now();
    try { receive({name, id: event.lastEventId, envelope: JSON.parse(event.data) as EventEnvelope, bytes: event.data.length * 2, receivedAt}); }
    catch { source.close(); lost(); }
  });
  source.onerror = () => { source.close(); lost(); };
  return source;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'The request failed.'; }
