import type { PrimaryView } from '../shared/api.ts';
export function primaryEmpty(primary: PrimaryView | undefined, _hasEntries: boolean, historyReady: boolean): {heading: string; caption: string} | undefined {
  if (!primary) return {heading: 'Sessions', caption: ''};
  if (primary.lifecycle === 'starting') return {heading: 'Starting session', caption: ''};
  if (primary.lifecycle === 'switching') return {heading: 'Switching session', caption: ''};
  if (primary.lifecycle === 'ready' && !historyReady) return {heading: 'Loading messages', caption: ''};
  return undefined;
}
export function primaryBusy(primary?: PrimaryView, queued = 0): boolean {
  return primary?.lifecycle === 'ready' && (['running', 'retrying', 'compacting'].includes(primary.activity) || queued > 0);
}
export function primaryActivityLabel(primary?: PrimaryView): string {
  if (!primary) return '';
  if (primary.lastError) return primary.lastError.message;
  if (primary.lifecycle === 'stopped') return 'Browser control stopped';
  return primaryBusy(primary) ? primary.activity : '';
}
