import { AgentError } from '../agents/index.mts';
import type { ThreadHostState, ThreadListItem, ThreadOverview } from '../shared/api.ts';
import { safeText } from './projection.mts';
import type { AgentAdapter } from './registry.mts';
import { projectThreadItems } from './threads.mts';

/** A host keeps at most 256 threads per storage, so the per-host bound reaches every thread the host can hold. */
export const THREAD_BOUNDS = {perHost: 256, total: 200, hostCalls: 16, pageLimit: 20, concurrency: 4, hostTimeoutMs: 10_000, responseBytes: 160 * 1024} as const;
const ROSTER_PAGES = 50;
const ROSTER_PAGE_ROWS = 100;
type Agents = Pick<AgentAdapter, 'roster' | 'threads'>;
export interface OverviewOptions {signal?: AbortSignal; hostTimeoutMs?: number}

/** Storages with a live writer claim in the cached roster, and how many other storages the roster holds. Reads no directory and starts no host. */
function scanRoster(agents: Agents, live: Set<string>, known: Set<string>): boolean {
  let cursor: string | undefined, complete = true, pages = 0;
  do {
    const page = agents.roster({limit: ROSTER_PAGE_ROWS, ...(cursor === undefined ? {} : {cursor})});
    for (const row of page.rows) { known.add(row.storageId); if (row.claim === 'live') live.add(row.storageId); }
    complete &&= page.coverage.complete;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && ++pages < ROSTER_PAGES);
  return complete && cursor === undefined;
}
function liveStorages(agents: Agents): {storages: string[]; notRunning: number; complete: boolean} {
  let live = new Set<string>(), known = new Set<string>();
  for (let attempt = 0; attempt < 2; attempt++) {
    live = new Set(); known = new Set();
    try { const complete = scanRoster(agents, live, known); return {storages: [...live], notRunning: notRunning(known, live), complete}; }
    catch (error) { if (!(attempt === 0 && error instanceof AgentError && error.code === 'stale_revision')) break; }
  }
  return {storages: [...live], notRunning: notRunning(known, live), complete: false};
}
function notRunning(known: Set<string>, live: Set<string>): number { return [...known].filter(id => !live.has(id)).length; }
function failure(error: unknown): {code: string; message: string} {
  const code = error instanceof AgentError ? error.code : 'host_error';
  return {code, message: safeText(error instanceof Error ? error.message : 'The host did not answer.', 512)};
}
async function listHost(agents: Agents, storageId: string, signal: AbortSignal): Promise<{items: ThreadListItem[]; truncated: boolean}> {
  const items: ThreadListItem[] = [];
  let cursor: string | undefined, calls = 0;
  do {
    const page = await agents.threads(storageId, {limit: THREAD_BOUNDS.pageLimit, ...(cursor === undefined ? {} : {cursor})}, signal);
    calls++;
    for (const item of projectThreadItems(storageId, page)) {
      if (item.id.split('/')[0] !== storageId) throw new AgentError('protocol_error', 'The host listed a thread that another storage owns.');
      items.push(item);
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor !== undefined && (calls >= THREAD_BOUNDS.hostCalls || items.length >= THREAD_BOUNDS.perHost)) return {items, truncated: true};
  } while (cursor !== undefined);
  return {items, truncated: false};
}
function hostFailure(storageId: string, error: unknown, timedOut: boolean): ThreadHostState {
  const base = {storageId, threads: 0, truncated: false};
  if (error instanceof AgentError && error.code === 'threads_unavailable') return {...base, state: 'unavailable', code: error.code, message: safeText(error.message, 512)};
  return {...base, state: 'failed', ...(timedOut ? {code: 'timeout', message: 'The host did not answer in time.'} : failure(error))};
}
async function collectHost(agents: Agents, storageId: string, timeoutMs: number, outer?: AbortSignal): Promise<{state: ThreadHostState; items: ThreadListItem[]}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  outer?.addEventListener('abort', relay, {once: true});
  try {
    const {items, truncated} = await listHost(agents, storageId, controller.signal);
    return {state: {storageId, state: 'answered', threads: items.length, truncated}, items};
  } catch (error) {
    if (outer?.aborted) throw error;
    return {state: hostFailure(storageId, error, controller.signal.aborted), items: []};
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', relay);
  }
}
function order(a: ThreadListItem, b: ThreadListItem): number {
  return Number(a.closed) - Number(b.closed) || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** Open threads first, then the newest update; the total bound and byte bound cut the tail and say so. */
function bound(all: ThreadListItem[]): {items: ThreadListItem[]; omitted: number} {
  const sorted = all.sort(order);
  const items: ThreadListItem[] = [];
  let bytes = 2;
  for (const item of sorted) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (items.length >= THREAD_BOUNDS.total || bytes + size > THREAD_BOUNDS.responseBytes) break;
    items.push(item); bytes += size;
  }
  return {items, omitted: sorted.length - items.length};
}
/** Lists the threads of every live storage, at most four hosts at a time, each with its own deadline. */
export async function collectThreads(agents: Agents, options: OverviewOptions = {}): Promise<ThreadOverview> {
  const {storages, notRunning, complete} = liveStorages(agents);
  const results = new Array<Awaited<ReturnType<typeof collectHost>>>(storages.length);
  let next = 0;
  const worker = async () => {
    while (next < storages.length) {
      options.signal?.throwIfAborted();
      const index = next++;
      results[index] = await collectHost(agents, storages[index], options.hostTimeoutMs ?? THREAD_BOUNDS.hostTimeoutMs, options.signal);
    }
  };
  await Promise.all(Array.from({length: Math.min(THREAD_BOUNDS.concurrency, storages.length)}, worker));
  const unique = new Map<string, ThreadListItem>();
  for (const result of results) for (const item of result.items) if (!unique.has(item.id)) unique.set(item.id, item);
  const {items, omitted} = bound([...unique.values()]);
  const states = results.map(result => result.state);
  const count = (state: ThreadHostState['state']) => states.filter(candidate => candidate.state === state).length;
  return {items, storages: states, hosts: {total: states.length, answered: count('answered'), unavailable: count('unavailable'), failed: count('failed'), notRunning},
    rosterComplete: complete, truncated: omitted > 0 || states.some(state => state.truncated), omitted,
    bounds: {perHost: THREAD_BOUNDS.perHost, total: THREAD_BOUNDS.total}, observedAt: new Date().toISOString()};
}
