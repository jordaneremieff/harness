import type { PrimaryView, ReadingView } from '../shared/api.ts';

/** Initial startup and conversation replacement hydrate the newly ready history once. */
export function historyBecameReady(previous: PrimaryView | undefined, current: PrimaryView, selectedKey?: string): boolean {
  return current.key === selectedKey && current.lifecycle === 'ready' && (previous?.lifecycle !== 'ready' || previous.epoch !== current.epoch);
}

export type AnchorHistory = {
  hasEntry: (id: string) => boolean;
  nextCursor: () => string | null;
  loadEarlier: (cursor: string) => Promise<void>;
  current: () => boolean;
};

/** Each request uses one bounded history page; newer reading intent stops the search. */
export async function pageToReadingAnchor(reading: ReadingView | undefined, history: AnchorHistory): Promise<'found' | 'exhausted' | 'interrupted' | 'unavailable' | 'tail' | 'start'> {
  if (!reading || reading.followTail) return 'tail';
  if (!reading.anchorId) return 'start';
  const requested = new Set<string>();
  for (;;) {
    if (!history.current()) return 'interrupted';
    if (history.hasEntry(reading.anchorId)) return 'found';
    const cursor = history.nextCursor();
    if (!cursor) return 'exhausted';
    if (requested.has(cursor)) return 'unavailable';
    requested.add(cursor);
    await history.loadEarlier(cursor);
  }
}
