import type { PrimaryView } from '../shared/api.ts';
export function primaryEmpty(primary: PrimaryView | undefined, hasEntries: boolean, historyReady: boolean): {heading: string; caption: string} | undefined {
  if (!primary) return {heading: 'No session open', caption: 'Open a project to start or resume a session.'};
  if (primary.lifecycle === 'ready' && primary.activity === 'idle' && historyReady && !hasEntries) return {heading: 'Start a conversation', caption: 'Type a message, or / for commands.'};
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
