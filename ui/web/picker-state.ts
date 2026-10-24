import type { PrimaryView, SavedSession, SavedSessionPage } from '../shared/api.ts';
import {senderCaption,sessionCaptionRecord,type SenderCaptionRoster} from './sender-caption.ts';

export function sessionLabel(item: SavedSession,roster?:SenderCaptionRoster): string {
  return senderCaption({identity:item.id},roster,sessionCaptionRecord(item));
}

/** A newer loaded snapshot supersedes older title evidence, even when its title is unavailable. */
export function loadedPrimarySession(primary: PrimaryView | undefined, pages: readonly SavedSessionPage[]): SavedSession | undefined {
  if (!primary?.sessionId || !primary.sessionFile) return;
  const matches = pages.flatMap(page => page.items.filter(item => item.path === primary.sessionFile).map(item => ({item, at: page.observedAt}))).sort((a,b) => b.at.localeCompare(a.at));
  const latest = matches[0]; if (!latest || latest.item.id !== primary.sessionId) return;
  if (matches.some(other => other.at === latest.at && (other.item.id !== latest.item.id || other.item.revision !== latest.item.revision || other.item.modifiedAt !== latest.item.modifiedAt || other.item.size !== latest.item.size || other.item.titleState !== latest.item.titleState || other.item.titleSource !== latest.item.titleSource || other.item.title !== latest.item.title))) return;
  return latest.item;
}
export type SessionList = SavedSessionPage & {pendingTitles: SavedSessionPage[]};
export function mergeSessions(previous: SessionList | undefined, page: SavedSessionPage, append = false): SessionList {
  const items = new Map((append ? previous?.items ?? [] : []).map(item => [item.path, item]));
  for (const item of page.items) items.set(item.path, item);
  const pendingTitles = append ? [...(previous?.pendingTitles ?? [])] : [];
  if (page.titleCursor && page.items.some(item => item.titleState === 'pending')) pendingTitles.push(page);
  return {...page, items: [...items.values()], pendingTitles};
}
export function mergeSessionTitles(list: SessionList, page: SavedSessionPage): SessionList {
  const updates = new Map(page.items.map(item => [item.path, item]));
  const items = list.items.map(item => {
    const update = updates.get(item.path);
    if (item.titleState === 'ready' && update?.titleState !== 'ready') return item;
    return update?.id === item.id && update.revision === item.revision && update.modifiedAt === item.modifiedAt && update.size === item.size ? {...item, title: update.title, titleSource: update.titleSource, titleState: update.titleState, lastUserAt: update.lastUserAt} : item;
  });
  const current = new Map(items.map(item => [item.path, item]));
  const pendingTitles = list.pendingTitles.filter(page => page.items.some(item => {
    const loaded = current.get(item.path); return loaded?.revision === item.revision && loaded.titleState === 'pending';
  }));
  return {...list, items, pendingTitles};
}
export function filterSessions(items: SavedSession[], search: string): SavedSession[] {
  const query = search.trim().toLocaleLowerCase();
  return query ? items.filter(item => `${item.title}\n${item.id}\n${item.path}`.toLocaleLowerCase().includes(query)) : items;
}
export function sessionCoverage(list: SavedSessionPage): string {
  return `${list.items.length} of ${list.total} sessions loaded${list.omitted ? ` · ${list.omitted} ${list.omitted === 1 ? 'candidate file is' : 'candidate files are'} outside the discovery limit.` : ''}`;
}
export function sessionEmptyMessage(search: string): string {
  return search.trim() ? 'No matches in this group.' : 'No loaded sessions in this group.';
}
export function savedPathValid(path: string): boolean {
  return path.startsWith('/') && path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(path);
}
export function sessionOwner(items: PrimaryView[], path: string): PrimaryView | undefined {
  return items.find(primary => primary.sessionFile === path && primary.lifecycle !== 'stopped' && primary.lifecycle !== 'failed');
}
export function sessionSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
