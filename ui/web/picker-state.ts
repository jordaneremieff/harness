import type { PrimaryView, SavedSession, SavedSessionPage } from '../shared/api.ts';

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
    return update?.revision === item.revision && update.modifiedAt === item.modifiedAt && update.size === item.size ? {...item, title: update.title, titleState: update.titleState} : item;
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
export function sessionCoverage(list: SessionList, matches: number, search: string): string {
  const coverage = `${list.items.length} of ${list.total} shown${list.omitted ? ` · ${list.omitted} unavailable or outside the scan bound` : ''}`;
  return search.trim() ? `${matches} matches in loaded sessions · ${coverage}` : coverage;
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
