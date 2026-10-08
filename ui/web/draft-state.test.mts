import assert from 'node:assert/strict';
import test from 'node:test';
import type { DraftView, Target } from '../shared/api.ts';
import { acknowledgeDraft, applyEditorSuggestion, beginDraftSave, captureSubmission, createDraft, draftSaved,
  editDraft, receiveDraft, rejectDraftSave, resolveDraftConflict, settleSubmission, useEditorSuggestion } from './draft-state.ts';
const view = (revision = 0, text = '', mode = 'prompt'): DraftView => ({revision, text, mode, persisted: true});
const target: Target = {kind: 'primary', key: 'p', epoch: 1};

test('a draft save never replaces newer edits and sends only one revision at a time', () => {
  let state = editDraft(createDraft(view()), 'first');
  const save = beginDraftSave(state); assert.ok(save.request); state = save.state;
  state = editDraft(state, 'newer');
  assert.equal(beginDraftSave(state).request, undefined);
  state = acknowledgeDraft(state, save.request, view(1, 'first'));
  assert.equal(state.text, 'newer'); assert.equal(draftSaved(state), false);
  const next = beginDraftSave(state); assert.equal(next.request?.expectedRevision, 1);
  assert.equal(next.request?.text, 'newer');
  assert.equal(acknowledgeDraft(next.state, save.request, view(1, 'first')), next.state);
});
test('matching stream acknowledgment precedes the HTTP response without a false conflict', () => {
  const save = beginDraftSave(editDraft(createDraft(view()), 'first')); assert.ok(save.request);
  let state = receiveDraft(save.state, view(1, 'first'));
  assert.equal(state.conflict, undefined); assert.equal(state.text, 'first');
  state = acknowledgeDraft(state, save.request, view(1, 'first'));
  assert.equal(draftSaved(state), true);
});
test('another tab creates an explicit conflict without losing local text', () => {
  let state = editDraft(createDraft(view()), 'local');
  state = receiveDraft(state, view(1, 'remote'));
  assert.equal(state.text, 'local'); assert.equal(state.conflict?.text, 'remote');
  assert.equal(beginDraftSave(state).request, undefined);
  const local = resolveDraftConflict(state, 'local');
  assert.equal(local.text, 'local'); assert.equal(beginDraftSave(local).request?.expectedRevision, 1);
  const remote = resolveDraftConflict(state, 'server');
  assert.equal(remote.text, 'remote'); assert.equal(draftSaved(remote), true);
});
test('late save acknowledgment cannot replace a newer remote revision', () => {
  const save = beginDraftSave(editDraft(createDraft(view()), 'mine')); assert.ok(save.request);
  let state = receiveDraft(save.state, view(2, 'remote'));
  state = acknowledgeDraft(state, save.request, view(1, 'mine'));
  assert.equal(state.server.revision, 2); assert.equal(state.text, 'mine'); assert.equal(state.conflict?.text, 'remote');
});
test('save rejection retains local text and exposes the current server revision', () => {
  const save = beginDraftSave(editDraft(createDraft(view()), 'mine')); assert.ok(save.request);
  const state = rejectDraftSave(save.state, save.request, view(1, 'remote'));
  assert.equal(state.text, 'mine'); assert.equal(state.conflict?.revision, 1);
  assert.equal(state.inFlight, undefined);
  assert.equal(receiveDraft(state, view(0, 'old')), state);
});
test('submission captures exact target and saved text and blocks duplicate pending edits', () => {
  const state = createDraft(view(4, 'exact text', 'steer'));
  const captured = captureSubmission(state, target, 'operation'); assert.ok(captured.submission);
  assert.equal(captured.submission.target, target); assert.equal(captured.submission.draftRevision, 4);
  assert.equal(captureSubmission(captured.state, target, 'other').submission, undefined);
  assert.equal(captureSubmission(editDraft(state, 'unsaved'), target, 'operation').submission, undefined);
  assert.equal(captureSubmission(createDraft(view(0, '  ')), target, 'operation').submission, undefined);
});
test('admission clears only the submitted edit; newer text survives', () => {
  const captured = captureSubmission(createDraft(view(4, 'sent')), target, 'operation'); assert.ok(captured.submission);
  const edited = editDraft(captured.state, 'newer');
  const state = settleSubmission(edited, captured.submission, 'accepted', view(5, ''));
  assert.equal(state.text, 'newer'); assert.equal(draftSaved(state), false);
  const unchanged = settleSubmission(captured.state, captured.submission, 'accepted', view(5, ''));
  assert.equal(unchanged.text, ''); assert.equal(draftSaved(unchanged), true);
  assert.equal(settleSubmission(unchanged, captured.submission, 'accepted', view(6, '')), unchanged);
});
test('uncertain admission retains its submission and refused input retains its draft', () => {
  const captured = captureSubmission(createDraft(view(1, 'sent')), target, 'operation'); assert.ok(captured.submission);
  assert.equal(settleSubmission(captured.state, captured.submission, 'uncertain'), captured.state);
  const rejected = settleSubmission(captured.state, captured.submission, 'rejected');
  assert.equal(rejected.text, 'sent'); assert.equal(rejected.submissions.size, 0);
  assert.ok(captureSubmission(rejected, target, 'new-operation').submission);
});
test('extension suggestions replace only untouched drafts', () => {
  const empty = createDraft(view());
  assert.equal(applyEditorSuggestion(empty, 'suggested', 0).text, 'suggested');
  const edited = editDraft(empty, 'mine');
  const conflict = applyEditorSuggestion(edited, 'suggested', 0);
  assert.equal(conflict.text, 'mine'); assert.equal(conflict.suggestion, 'suggested');
  assert.equal(useEditorSuggestion(conflict).text, 'suggested');
});

test('an admission clear event preserves newer edits without a false tab conflict', () => {
  const captured = captureSubmission(createDraft(view(4, 'sent')), target, 'operation'); assert.ok(captured.submission);
  const edited = editDraft(captured.state, 'newer');
  const state = receiveDraft(edited, view(5, ''));
  assert.equal(state.text, 'newer'); assert.equal(state.conflict, undefined);
  const settled = settleSubmission(state, captured.submission, 'accepted', view(5, ''));
  assert.equal(settled.text, 'newer'); assert.equal(settled.conflict, undefined);
  assert.equal(beginDraftSave(settled).request?.expectedRevision, 5);
});
test('an admission clear event also clears an unchanged submitted edit once', () => {
  const captured = captureSubmission(createDraft(view(4, 'sent')), target, 'operation'); assert.ok(captured.submission);
  const state = receiveDraft(captured.state, view(5, ''));
  assert.equal(state.text, ''); assert.equal(draftSaved(state), true);
  assert.equal(settleSubmission(state, captured.submission, 'accepted', view(5, '')).text, '');
});
