import type { ThreadFrame, ThreadList, ThreadPage } from '../agents/index.mts';
import type { ThreadEventView, ThreadFrameView, ThreadListItem, ThreadPageView } from '../shared/api.ts';
import { safeText } from './projection.mts';

const FRAME_FIELDS = ['title', 'purpose', 'authority', 'source', 'restrictions', 'acceptance', 'integrator'] as const;
const FRAME_BYTES = 16 * 1024;
const MESSAGE_BYTES = 48 * 1024;

function frameView(source: ThreadFrame): ThreadFrameView {
  const view = {} as Record<string, string>;
  for (const key of FRAME_FIELDS) view[key] = safeText(source[key], FRAME_BYTES);
  return view as ThreadFrameView;
}
/** The text of a create or revise event is the JSON of the frame at that revision; any other shape stays plain text. */
function eventFrame(kind: string, message: string): ThreadFrameView | undefined {
  if (kind !== 'create' && kind !== 'revise') return undefined;
  try {
    const parsed: unknown = JSON.parse(message);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== FRAME_FIELDS.length || FRAME_FIELDS.some(key => typeof record[key] !== 'string')) return undefined;
    return frameView(record as ThreadFrame);
  } catch { return undefined; }
}
export function projectThreadItems(storageId: string, source: ThreadList): ThreadListItem[] {
  return source.items.map(item => ({id: item.id, storageId, title: safeText(item.title, 1024), purpose: safeText(item.purpose, 2048),
    updatedAt: item.updatedAt, closed: item.closed, members: item.members}));
}
export function projectThreadPage(storageId: string, source: ThreadPage, observedAt = new Date().toISOString()): ThreadPageView {
  const thread = source.thread;
  const events = source.events.map((event): ThreadEventView => {
    const frame = eventFrame(event.kind, event.message);
    return {sequence: event.sequence, at: event.at, sender: event.sender, origin: event.origin, kind: safeText(event.kind, 128),
      message: frame ? '' : safeText(event.message, MESSAGE_BYTES), source: safeText(event.source, 8 * 1024), replyTo: event.replyTo,
      revision: event.revision, notify: [...event.notify], ...(frame ? {frame} : {})};
  });
  return {storageId, ...(source.source ? {source: source.source} : {}), nextBefore: source.nextBefore, pending: source.pending, coverage: {complete: source.coverage.complete}, events, observedAt,
    thread: {...frameView(thread), id: thread.id, creator: thread.creator, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      revision: thread.revision, closed: thread.closed, sequence: thread.sequence,
      members: thread.members.map(member => ({identity: member.identity, contribution: safeText(member.contribution, 1024), joinedAt: member.joinedAt}))}};
}
