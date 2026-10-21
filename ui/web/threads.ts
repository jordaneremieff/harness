import { compactAge, formatDate } from './format.ts';
import type {ThreadEventView, ThreadFrameView, ThreadListItem, ThreadOverview, ThreadPageView} from '../shared/api.ts';

/** Longer loaded sidebar lists offer a filter field. */
export const THREAD_FILTER_THRESHOLD = 8;
/** One page of events per read; the route accepts at most 20. */
export const THREAD_PAGE_EVENTS = 20;
const DEFAULT_SENTENCES = new Set(['Joined the thread.', 'Left the thread.']);
const INLINE_LIMIT = 140;

export const FRAME_LABELS: ReadonlyArray<readonly [keyof ThreadFrameView, string]> = [
  ['title', 'Title'], ['purpose', 'Purpose'], ['integrator', 'Integrator'], ['authority', 'Authority'], ['source', 'Source'], ['restrictions', 'Restrictions'], ['acceptance', 'Acceptance']];

export type ThreadNameFor = (identity: string, origin: 'model' | 'operator') => string;

/** Rows whose title, purpose or identity contains every word of the query, in any case. */
export function filterThreads(items: readonly ThreadListItem[], query: string): ThreadListItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter(item => { const text = `${item.title}\n${item.purpose}\n${item.id}`.toLowerCase(); return words.every(word => text.includes(word)); });
}
/** The second line of a list row: state, member count and an age that reads as an age. */
export function threadMeta(item: ThreadListItem, now: number): string {
  const members = `${item.members} ${item.members === 1 ? 'member' : 'members'}`;
  const age = compactAge(item.updatedAt, now);
  const when = !age ? '' : age === 'now' ? 'just now' : /^\d+[a-z]+$/.test(age) ? `${age} ago` : age;
  return [item.closed ? 'Closed' : '', members, when].filter(Boolean).join(' · ');
}
/** The heading carries the list size; a cut list adds a plus sign. */
export function threadCount(overview: ThreadOverview | undefined): string {
  if (!overview?.items.length) return '';
  return `${overview.items.length}${overview.truncated ? '+' : ''}`;
}
/** Names known stopped agents whose threads use the independent saved-storage reader. */
function stoppedAgentsLine(count: number): string {
  return `${count} stopped ${count === 1 ? 'agent uses' : 'agents use'} saved storage reads.`;
}
/** Quiet lines under the list. Each one states what the list does not cover. */
export function overviewLines(overview: ThreadOverview): string[] {
  const lines: string[] = [];
  const {hosts} = overview;
  const coverage: string[] = [];
  if (hosts.total > 0 && hosts.total - hosts.answered > hosts.failed + hosts.unavailable) coverage.push(`Listed by ${hosts.answered} of ${hosts.total} ${hosts.total === 1 ? 'agent' : 'agents'}`);
  if (overview.omitted > 0) coverage.push(`Showing the newest ${overview.items.length} threads; ${overview.omitted} more not shown`);
  else if (overview.truncated) coverage.push('Some threads are not shown');
  if (!overview.rosterComplete) coverage.push('Agent list incomplete');
  if (coverage.length) lines.push(coverage.join(' · '));
  if (hosts.unavailable > 0) lines.push(`${hosts.unavailable} ${hosts.unavailable === 1 ? 'agent does' : 'agents do'} not offer threads`);
  if (hosts.failed > 0) lines.push(`${hosts.failed} ${hosts.failed === 1 ? 'agent' : 'agents'} did not answer`);
  if (hosts.notRunning > 0) lines.push(stoppedAgentsLine(hosts.notRunning));
  return lines;
}
/** The empty-list sentence, chosen by why the list is empty. */
export function emptyListText(overview: ThreadOverview): string {
  if (overview.items.length) return '';
  if (overview.hosts.total === 0) return 'No known agent storage is available.';
  return overview.hosts.answered === 0 ? 'No agent storage listed its threads.' : 'No threads yet.';
}

export type FrameChange = {field: keyof ThreadFrameView; label: string; before: string; after: string};
export function frameChanges(before: ThreadFrameView, after: ThreadFrameView): FrameChange[] {
  return FRAME_LABELS.flatMap(([field, label]) => before[field] === after[field] ? [] : [{field, label, before: before[field], after: after[field]}]);
}

export type ExchangeRow =
  | {type: 'message'; sequence: number; at: number; sender: string; origin: 'model' | 'operator'; carried: boolean; message: string; source: string; replyTo: number | null; replyToName?: string}
  | {type: 'line'; sequence: number; at: number; text: string; sender: string; origin: 'model' | 'operator'; note?: string; changes?: FrameChange[]};

function note(text: string): string | undefined {
  const value = text.trim();
  return value && !DEFAULT_SENTENCES.has(value) ? value : undefined;
}
/**
 * Classifies events for display. Messages and carried authority read as message blocks; every other kind is one quiet line.
 * A revision shows what changed only when an earlier frame is among the loaded events.
 */
export function exchangeRows(events: readonly ThreadEventView[], nameFor: ThreadNameFor): ExchangeRow[] {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const bySequence = new Map(ordered.map(event => [event.sequence, event]));
  let frame: ThreadFrameView | undefined;
  return ordered.map((event): ExchangeRow => {
    const actor = nameFor(event.sender, event.origin);
    const base = {sequence: event.sequence, at: event.at, sender: event.sender, origin: event.origin};
    const earlier = frame;
    if (event.frame) frame = event.frame;
    switch (event.kind) {
      case 'contribution': case 'carried-authority': {
        const parent = event.replyTo === null ? undefined : bySequence.get(event.replyTo);
        return {type: 'message', ...base, carried: event.kind === 'carried-authority', message: event.message, source: event.source, replyTo: event.replyTo,
          ...(parent ? {replyToName: nameFor(parent.sender, parent.origin)} : {})};
      }
      default: return lineRow(event, actor, earlier);
    }
  });
}
function lineRow(event: ThreadEventView, actor: string, earlier: ThreadFrameView | undefined): ExchangeRow {
  const base = {sequence: event.sequence, at: event.at, sender: event.sender, origin: event.origin};
  switch (event.kind) {
    case 'create': return {type: 'line', ...base, text: `Thread created by ${actor}`};
    case 'join': return {type: 'line', ...base, text: `${actor} joined`, ...withNote(event.message)};
    case 'leave': return {type: 'line', ...base, text: `${actor} left`, ...withNote(event.message)};
    case 'close': return {type: 'line', ...base, text: `Thread closed by ${actor}`, ...withNote(event.message)};
    case 'revise': {
      const changes = earlier && event.frame ? frameChanges(earlier, event.frame) : undefined;
      return {type: 'line', ...base, text: `Frame revised to revision ${event.revision} by ${actor}`, ...(changes?.length ? {changes} : {})};
    }
    default: return {type: 'line', ...base, text: `${actor} ${event.kind}`};
  }
}
function withNote(text: string): {note?: string} {
  const value = note(text);
  return value ? {note: value} : {};
}
/** A note that fits one line stays inline; a longer one goes behind a control. */
export function noteFitsInline(text: string): boolean {
  return text.length <= INLINE_LIMIT && !text.includes('\n');
}

/** Events from a newer read join the loaded ones by sequence; a gap means the older events are no longer contiguous and are dropped. */
export function mergeEvents(loaded: readonly ThreadEventView[], page: readonly ThreadEventView[]): ThreadEventView[] {
  if (!loaded.length) return [...page].sort((a, b) => a.sequence - b.sequence);
  if (!page.length) return [...loaded];
  const newestLoaded = Math.max(...loaded.map(event => event.sequence));
  const oldestPage = Math.min(...page.map(event => event.sequence));
  if (oldestPage > newestLoaded + 1) return [...page].sort((a, b) => a.sequence - b.sequence);
  const merged = new Map(loaded.map(event => [event.sequence, event]));
  for (const event of page) merged.set(event.sequence, event);
  return [...merged.values()].sort((a, b) => a.sequence - b.sequence);
}
/** Events from an older read join the loaded ones by sequence. */
export function prependEvents(older: readonly ThreadEventView[], loaded: readonly ThreadEventView[]): ThreadEventView[] {
  const merged = new Map(older.map(event => [event.sequence, event]));
  for (const event of loaded) merged.set(event.sequence, event);
  return [...merged.values()].sort((a, b) => a.sequence - b.sequence);
}
/** Older events remain when the oldest loaded event is not the first. Event sequences start at 1. */
export function olderBoundary(events: readonly ThreadEventView[]): number | null {
  const first = events[0];
  return first && first.sequence > 1 ? first.sequence : null;
}
export function pageEvents(page: ThreadPageView): ThreadEventView[] {
  return [...page.events].sort((a, b) => a.sequence - b.sequence);
}

/** Time of an event: clock time on the current day, date and time otherwise. */
export function eventTime(at: number, now: number, timeZone?: string): string {
  const day: Intl.DateTimeFormatOptions = {year: 'numeric', month: 'numeric', day: 'numeric'};
  const sameDay = formatDate(at, day, timeZone) === formatDate(now, day, timeZone);
  return formatDate(at, sameDay ? {hour: 'numeric', minute: '2-digit'} : {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}, timeZone);
}

/** The purpose shows its first lines; a long one offers expansion. */
export function purposeNeedsExpansion(purpose: string): boolean {
  return purpose.length > 220 || purpose.split('\n').length > 3;
}
