import type { PrimaryView } from '../shared/api.ts';

/** Initial startup and conversation replacement hydrate the newly ready history once. */
export function historyBecameReady(previous: PrimaryView | undefined, current: PrimaryView, selectedKey?: string): boolean {
  return current.key === selectedKey && current.lifecycle === 'ready' && (previous?.lifecycle !== 'ready' || previous.epoch !== current.epoch);
}
