import { LIMITS, sameDraftTuple, sameDraftImages } from '../shared/api.ts';
import type { DraftImage, DraftView, StoredDraft, RecoveryOrigin, Target } from '../shared/api.ts';

export interface DraftSave { expectedRevision: number; edit: number; text: string; mode: string; images: DraftImage[]; recoverySource?: string; }
export interface Submission { operationId: string; target: Target; text: string; mode: string; images: DraftImage[]; draftRevision: number; edit: number; differentMessage?: true; }
export interface DraftState {
  server: DraftView; text: string; mode: string; images: DraftImage[]; recoveryOrigin?: RecoveryOrigin;
  edit: number; savedEdit: number; inFlight?: DraftSave; conflict?: DraftView; suggestion?: string;
  submissions: ReadonlyMap<string, Submission>;
}
function imageCopy(images: readonly DraftImage[]): DraftImage[] {
  if (images.length > LIMITS.imagesPerDraft || new Set(images.map(image => image.digest)).size !== images.length || images.reduce((sum, image) => sum + image.bytes, 0) > LIMITS.draftImageBytes) throw new RangeError('Invalid draft image list');
  return images.map(image => ({...image}));
}
function view(draft: StoredDraft): DraftView {
  const result: DraftView = {...draft, images: imageCopy(draft.images)};
  if (result.recoveryOrigin) result.recoveryOrigin = {...result.recoveryOrigin};
  if (result.recoverySendGuard) result.recoverySendGuard = {...result.recoverySendGuard};
  return result;
}
export function createDraft(draft: StoredDraft): DraftState {
  const server = view(draft);
  return {server, text: server.text, mode: server.mode, images: imageCopy(server.images), recoveryOrigin: server.recoveryOrigin, edit: 0, savedEdit: 0, submissions: new Map()};
}
export function draftSaved(state: DraftState): boolean { return state.edit === state.savedEdit && !state.conflict && !state.inFlight; }
export function editDraft(state: DraftState, text: string, mode = state.mode, images: readonly DraftImage[] = state.images): DraftState {
  if (text === state.text && mode === state.mode && sameDraftImages(images, state.images)) return state;
  return {...state, text, mode, images: imageCopy(images), edit: state.edit + 1};
}
export function beginDraftSave(state: DraftState): {state: DraftState; request?: DraftSave} {
  if (state.inFlight || state.conflict || state.edit === state.savedEdit) return {state};
  const request: DraftSave = {expectedRevision: state.server.revision, edit: state.edit, text: state.text, mode: state.mode, images: imageCopy(state.images), ...(state.recoveryOrigin ? {recoverySource: state.recoveryOrigin.recoveryOperationId} : {})};
  return {state: {...state, inFlight: request}, request};
}
export function acknowledgeDraft(state: DraftState, request: DraftSave, raw: StoredDraft): DraftState {
  if (state.inFlight !== request) return state;
  const draft = view(raw);
  if (draft.revision <= request.expectedRevision) return {...state, inFlight: undefined};
  if (!sameDraftTuple(draft, request)) return rejectDraftSave(state, request, draft);
  if (draft.revision < state.server.revision) return {...state, inFlight: undefined};
  return {...state, server: draft, inFlight: undefined, savedEdit: request.edit,
    recoveryOrigin: state.edit === request.edit ? draft.recoveryOrigin : state.recoveryOrigin,
    conflict: state.conflict && state.conflict.revision > draft.revision ? state.conflict : undefined};
}
export function rejectDraftSave(state: DraftState, request: DraftSave, current?: StoredDraft): DraftState {
  if (state.inFlight !== request) return state;
  const next = {...state, inFlight: undefined}; return current ? receiveDraft(next, current, true) : next;
}
function clearedDraft(draft: DraftView, submission: Submission): boolean {
  return draft.text === '' && !draft.images.length && draft.mode === submission.mode && draft.revision === submission.draftRevision + 1;
}
export function receiveDraft(state: DraftState, raw: StoredDraft, forceConflict = false): DraftState {
  const draft = view(raw);
  if (draft.revision < state.server.revision) return state;
  if (draft.revision === state.server.revision) {
    if (!sameDraftTuple(draft, state.server)) return state;
    const before = state.server;
    const samePolicy = draft.recoveryOrigin?.clearOperationId === before.recoveryOrigin?.clearOperationId && draft.recoveryOrigin?.recoveryOperationId === before.recoveryOrigin?.recoveryOperationId && draft.recoverySendGuard?.state === before.recoverySendGuard?.state && draft.recoverySendGuard?.imageCopies === before.recoverySendGuard?.imageCopies;
    return samePolicy ? state : {...state, server: draft};
  }
  const cleared = [...state.submissions.values()].find(item => clearedDraft(draft, item));
  if (cleared) return admissionDraft(state, cleared, draft);
  const matchesSave = state.inFlight && draft.revision === state.inFlight.expectedRevision + 1 && sameDraftTuple(draft, state.inFlight);
  if (matchesSave) return {...state, server: draft, savedEdit: state.inFlight?.edit ?? state.savedEdit};
  if (forceConflict || state.edit !== state.savedEdit || state.inFlight) return {...state, server: draft, conflict: draft};
  return {...state, server: draft, text: draft.text, mode: draft.mode, images: imageCopy(draft.images), recoveryOrigin: draft.recoveryOrigin, conflict: undefined};
}
/** A conflict chooses one complete tuple, never a union of image sets. */
export function resolveDraftConflict(state: DraftState, choice: 'local' | 'server'): DraftState {
  if (!state.conflict || state.inFlight) return state;
  if (choice === 'local') return {...state, conflict: undefined, edit: state.edit + 1};
  const edit = state.edit + 1;
  return {...state, text: state.server.text, mode: state.server.mode, images: imageCopy(state.server.images), recoveryOrigin: state.server.recoveryOrigin, conflict: undefined, edit, savedEdit: edit};
}
export function captureSubmission(state: DraftState, target: Target, operationId: string, differentMessage?: true): {state: DraftState; submission?: Submission} {
  const guard = state.server.recoverySendGuard;
  if ((!state.text.trim() && !state.images.length) || state.submissions.has(operationId) || guard?.state === 'unavailable' || guard?.state === 'blocked' && differentMessage !== true) return {state};
  for (const item of state.submissions.values()) if (item.edit === state.edit) return {state};
  const submission: Submission = {operationId, target: structuredClone(target), text: state.text, mode: state.mode, images: imageCopy(state.images), draftRevision: state.server.revision, edit: state.edit, ...(differentMessage === true ? {differentMessage} : {})};
  const submissions = new Map(state.submissions); submissions.set(operationId, submission);
  return {state: {...state, submissions}, submission};
}
function admissionDraft(state: DraftState, submission: Submission, draft: DraftView): DraftState {
  if (draft.revision <= state.server.revision) return state;
  if (state.edit !== submission.edit) return {...state, server: draft, conflict: undefined};
  const edit = state.edit + 1;
  return {...state, server: draft, text: draft.text, mode: draft.mode, images: imageCopy(draft.images), recoveryOrigin: draft.recoveryOrigin, edit, savedEdit: edit, conflict: undefined};
}
export function settleSubmission(state: DraftState, submission: Submission, outcome: 'accepted' | 'rejected' | 'uncertain', raw?: StoredDraft, clearAccepted = submission.images.length === 0): DraftState {
  if (state.submissions.get(submission.operationId) !== submission || outcome === 'uncertain') return state;
  const submissions = new Map(state.submissions); submissions.delete(submission.operationId);
  let next = {...state, submissions}; const draft = raw ? view(raw) : undefined;
  if (outcome === 'accepted' && clearAccepted && state.edit === submission.edit && sameDraftTuple(state, submission)) {
    next = {...next, text: '', images: [], recoveryOrigin: undefined, edit: state.edit + 1};
    if (draft && draft.revision > state.server.revision && clearedDraft(draft, submission)) return {...next, server: draft, mode: draft.mode, savedEdit: next.edit, conflict: undefined};
  }
  if (outcome === 'accepted' && clearAccepted && draft && clearedDraft(draft, submission)) return admissionDraft(next, submission, draft);
  return draft ? receiveDraft(next, draft) : next;
}
export function applyEditorSuggestion(state: DraftState, text: string, baselineEdit: number): DraftState {
  if (state.edit !== baselineEdit || state.conflict || state.inFlight) return {...state, suggestion: text};
  return {...editDraft(state, text), suggestion: undefined};
}
export function useEditorSuggestion(state: DraftState): DraftState {
  return state.suggestion === undefined ? state : {...editDraft(state, state.suggestion), suggestion: undefined};
}
