import type { PrimaryView } from '../shared/api.ts';
export function primaryBusy(primary?: PrimaryView, queued = 0): boolean {
  return primary?.lifecycle === 'ready' && (['running', 'retrying', 'compacting'].includes(primary.activity) || queued > 0);
}
export function primaryActivityLabel(primary?: PrimaryView): string {
  if (!primary) return '';
  if (primary.lastError) return primary.lastError.message;
  if (primary.lifecycle === 'stopped') return 'Browser control stopped';
  return primaryBusy(primary) ? primary.activity : '';
}
