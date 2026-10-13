import {draftImageFingerprint} from '../shared/api.ts';
import type {DraftImage, StoredDraft, Target} from '../shared/api.ts';

export type EditorSelection = {start: number; end: number; direction: 'forward' | 'backward' | 'none'; scrollTop: number; scrollLeft: number; text: string; revision: number; edit: number; imageFingerprint?: string};
export function clampSelection(selection: EditorSelection, text: string, revision: number, edit: number, images: readonly DraftImage[] = []): EditorSelection {
  const start = Math.min(text.length, Math.max(0, selection.start));
  return {...selection, start, end: Math.max(start, Math.min(text.length, Math.max(0, selection.end))), text, revision, edit, imageFingerprint: draftImageFingerprint(images),
    scrollTop: text ? selection.scrollTop : 0, scrollLeft: text ? selection.scrollLeft : 0};
}
export function editorSelectionKey(workspace: string, target: Target): string { return `ui:editor:${JSON.stringify([workspace, target])}`; }
/** Reload restores only the exact saved draft, never a different epoch or revision. */
export function readEditorSelection(raw: string | null, draft: StoredDraft): EditorSelection | undefined {
  if (!raw) return;
  try {
    const value = JSON.parse(raw);
    if (!value || value.text !== draft.text || value.revision !== draft.revision || value.mode !== draft.mode || (value.imageFingerprint ?? draftImageFingerprint([])) !== draftImageFingerprint(draft.images ?? []) ||
      !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < 0 || value.end < value.start || value.end > draft.text.length ||
      !['forward', 'backward', 'none'].includes(value.direction) || !Number.isFinite(value.scrollTop) || value.scrollTop < 0 || !Number.isFinite(value.scrollLeft) || value.scrollLeft < 0) return;
    return {...value, edit: 0, imageFingerprint: draftImageFingerprint(draft.images ?? [])};
  } catch { return; }
}

export const SLOW_SAVE_MS = 1000;
export type DraftPresentation = {connected: boolean; unsaved: boolean; text: string; images?: readonly DraftImage[]; failed: boolean; conflict: boolean; outstandingSince?: number};
export function draftPresentation(state: DraftPresentation, now: number): string {
  if (state.conflict) return '';
  if (state.failed) return 'Draft not saved';
  if (!state.connected && state.unsaved && (state.text.length || state.images?.length)) return 'Draft not saved';
  if (state.outstandingSince !== undefined && now - state.outstandingSince >= SLOW_SAVE_MS) return 'Saving draft…';
  return '';
}
