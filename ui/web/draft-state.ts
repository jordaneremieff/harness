import type { DraftView, Target } from '../shared/api.ts';

export interface DraftSave {
  expectedRevision: number;
  edit: number;
  text: string;
  mode: string;
}
export interface Submission {
  operationId: string;
  target: Target;
  text: string;
  mode: string;
  draftRevision: number;
  edit: number;
}
export interface DraftState {
  server: DraftView;
  text: string;
  mode: string;
  edit: number;
  savedEdit: number;
  inFlight?: DraftSave;
  conflict?: DraftView;
  suggestion?: string;
  submissions: ReadonlyMap<string, Submission>;
}

export function createDraft(draft: DraftView): DraftState {
  return { server: draft, text: draft.text, mode: draft.mode, edit: 0, savedEdit: 0, submissions: new Map() };
}
export function draftSaved(state: DraftState): boolean {
  return state.edit === state.savedEdit && !state.conflict && !state.inFlight;
}
export function editDraft(state: DraftState, text: string, mode = state.mode): DraftState {
  if (text === state.text && mode === state.mode) return state;
  return { ...state, text, mode, edit: state.edit + 1 };
}
export function beginDraftSave(state: DraftState): { state: DraftState; request?: DraftSave } {
  if (state.inFlight || state.conflict || state.edit === state.savedEdit) return { state };
  const request = { expectedRevision: state.server.revision, edit: state.edit, text: state.text, mode: state.mode };
  return { state: { ...state, inFlight: request }, request };
}
export function acknowledgeDraft(state: DraftState, request: DraftSave, draft: DraftView): DraftState {
  if (state.inFlight !== request) return state;
  if (draft.revision <= request.expectedRevision) return { ...state, inFlight: undefined };
  if (draft.text !== request.text || draft.mode !== request.mode) return rejectDraftSave(state, request, draft);
  // An event from another tab can arrive before this save's older HTTP response.
  if (draft.revision < state.server.revision) return { ...state, inFlight: undefined };
  return { ...state, server: draft, inFlight: undefined, savedEdit: request.edit,
    conflict: state.conflict && state.conflict.revision > draft.revision ? state.conflict : undefined };
}
export function rejectDraftSave(state: DraftState, request: DraftSave, current?: DraftView): DraftState {
  if (state.inFlight !== request) return state;
  const next = { ...state, inFlight: undefined };
  return current ? receiveDraft(next, current, true) : next;
}
export function receiveDraft(state: DraftState, draft: DraftView, forceConflict = false): DraftState {
  if (draft.revision <= state.server.revision) return state;
  const cleared = [...state.submissions.values()].find(item => draft.text === '' && draft.revision === item.draftRevision + 1);
  if (cleared) return admissionDraft(state, cleared, draft);
  const matchesSave = state.inFlight && draft.revision === state.inFlight.expectedRevision + 1 &&
    draft.text === state.inFlight.text && draft.mode === state.inFlight.mode;
  if (matchesSave) return { ...state, server: draft, savedEdit: state.inFlight?.edit ?? state.savedEdit };
  if (forceConflict || state.edit !== state.savedEdit || state.inFlight) {
    return { ...state, server: draft, conflict: draft };
  }
  return { ...state, server: draft, text: draft.text, mode: draft.mode, conflict: undefined };
}
/** A conflict requires an explicit choice. Keeping local text creates a new save. */
export function resolveDraftConflict(state: DraftState, choice: 'local' | 'server'): DraftState {
  if (!state.conflict || state.inFlight) return state;
  if (choice === 'local') return { ...state, conflict: undefined, edit: state.edit + 1 };
  const edit = state.edit + 1;
  return { ...state, text: state.server.text, mode: state.server.mode, conflict: undefined, edit, savedEdit: edit };
}
export function captureSubmission(state: DraftState, target: Target, operationId: string): { state: DraftState; submission?: Submission } {
  if (!draftSaved(state) || !state.text.trim() || state.submissions.has(operationId)) return { state };
  for (const item of state.submissions.values()) if (item.edit === state.edit) return { state };
  const submission = { operationId, target, text: state.text, mode: state.mode, draftRevision: state.server.revision, edit: state.edit };
  const submissions = new Map(state.submissions);
  submissions.set(operationId, submission);
  return { state: { ...state, submissions }, submission };
}
function admissionDraft(state: DraftState, submission: Submission, draft: DraftView): DraftState {
  if (draft.revision <= state.server.revision) return state;
  if (state.edit !== submission.edit) return { ...state, server: draft, conflict: undefined };
  const edit = state.edit + 1;
  return { ...state, server: draft, text: draft.text, mode: draft.mode, edit, savedEdit: edit, conflict: undefined };
}
export function settleSubmission(state: DraftState, submission: Submission,
  outcome: 'accepted' | 'rejected' | 'uncertain', draft?: DraftView): DraftState {
  if (state.submissions.get(submission.operationId) !== submission) return state;
  if (outcome === 'uncertain') return state;
  const submissions = new Map(state.submissions);
  submissions.delete(submission.operationId);
  let next = { ...state, submissions };
  if (outcome === 'accepted' && state.edit === submission.edit && state.text === submission.text) {
    next = { ...next, text: '', edit: state.edit + 1 };
    if (draft && draft.revision > state.server.revision && draft.text === '') {
      return { ...next, server: draft, mode: draft.mode, savedEdit: next.edit, conflict: undefined };
    }
  }
  if (outcome === 'accepted' && draft?.text === '') return admissionDraft(next, submission, draft);
  return draft ? receiveDraft(next, draft) : next;
}
export function applyEditorSuggestion(state: DraftState, text: string, baselineEdit: number): DraftState {
  if (state.edit !== baselineEdit || state.conflict || state.inFlight) return { ...state, suggestion: text };
  return { ...editDraft(state, text), suggestion: undefined };
}
export function useEditorSuggestion(state: DraftState): DraftState {
  if (state.suggestion === undefined) return state;
  return { ...editDraft(state, state.suggestion), suggestion: undefined };
}
