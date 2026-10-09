export const SLOW_SAVE_MS = 1000;
export type DraftPresentation = {connected: boolean; unsaved: boolean; text: string; failed: boolean; conflict: boolean; outstandingSince?: number};
export function draftPresentation(state: DraftPresentation, now: number): string {
  if (state.conflict) return '';
  if (state.failed) return 'Draft not saved';
  if (!state.connected && state.unsaved && state.text.length) return 'Draft not saved · offline';
  if (state.outstandingSince !== undefined && now - state.outstandingSince >= SLOW_SAVE_MS) return 'Saving draft…';
  return '';
}
