import type { ThreadOverview, ThreadPageView } from '../shared/api.ts';
import type { RequestContext } from './http.mts';
import { AgentError } from '../agents/index.mts';
import { ApiError } from './errors.mts';
import type { Registry } from './registry.mts';
import { safeText } from './projection.mts';
import { collectThreads } from './threads-overview.mts';
import { projectThreadPage } from './threads.mts';
import * as v from './validate.mts';

const THREAD_ID = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/[0-9a-f]{32}$/;

/** Thread routes are read only. The list fans out across live storages; a read goes to the storage that owns the thread. */
export async function dispatchThreads(registry: Registry, context: RequestContext): Promise<ThreadOverview | ThreadPageView> {
  const {parts, method, url, signal} = context;
  if (method !== 'GET' || parts.length > 3 || (parts.length === 3 && parts[2] !== 'read')) throw new ApiError('invalid_request', 'The route does not accept this method.', 405);
  const read = parts.length === 3;
  queryNames(url, read ? ['threadId', 'before', 'limit'] : []);
  return read ? readThread(registry, url, signal) : collectThreads(registry.agents, {signal});
}
function queryNames(url: URL, allowed: string[]): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key)) throw new ApiError('invalid_request', 'The thread query is invalid.');
    seen.add(key);
  }
}
async function readThread(registry: Registry, url: URL, signal?: AbortSignal): Promise<ThreadPageView> {
  const threadId = v.string(url.searchParams.get('threadId'), 'thread ID', 128);
  const match = THREAD_ID.exec(threadId);
  if (!match) throw new ApiError('invalid_request', 'The thread ID is invalid.');
  const limit = url.searchParams.get('limit'), before = url.searchParams.get('before');
  const options = {...(limit !== null ? {limit: number(limit, 'thread page limit', 1, 20)} : {}), ...(before !== null ? {before: number(before, 'thread boundary', 1)} : {})};
  try {
    return projectThreadPage(match[1], await registry.agents.thread(match[1], threadId, options, signal));
  } catch (error) {
    if (error instanceof AgentError && error.code === 'threads_unavailable') throw new ApiError('threads_unavailable', safeText(error.message, 512), 501);
    throw error;
  }
}
function number(raw: string, name: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  const value = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ApiError('invalid_request', `The ${name} is invalid.`);
  return value;
}
