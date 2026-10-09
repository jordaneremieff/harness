import assert from 'node:assert/strict';
import test from 'node:test';
import { draftPresentation, SLOW_SAVE_MS } from './draft-presentation.ts';
import type { DraftPresentation } from './draft-presentation.ts';
const pending: DraftPresentation = {connected: true, unsaved: true, text: 'draft', failed: false, conflict: false, outstandingSince: 50};
test('routine dirty, fast in-flight, and acknowledged states stay empty', () => {
  assert.equal(draftPresentation({...pending, outstandingSince: undefined}, 5000), '');
  assert.equal(draftPresentation(pending, 50 + SLOW_SAVE_MS - 1), '');
  assert.equal(draftPresentation({...pending, unsaved: false, outstandingSince: undefined}, 5000), '');
});
test('only an actual outstanding request reaches the slow-save threshold', () => {
  assert.equal(draftPresentation(pending, 50 + SLOW_SAVE_MS), 'Saving draft…');
  assert.equal(draftPresentation({...pending, outstandingSince: undefined}, 5000), '');
  assert.equal(draftPresentation({...pending, outstandingSince: 5000}, 5001), '');
});
test('disconnection never changes a clean acknowledged draft into unsaved text', () => {
  assert.equal(draftPresentation({...pending, connected: false, unsaved: false, outstandingSince: undefined}, 5000), '');
  assert.equal(draftPresentation({...pending, connected: false, text: '', outstandingSince: undefined}, 5000), '');
  assert.equal(draftPresentation({...pending, connected: false}, 5000), 'Draft not saved · offline');
});
test('save failures and conflicts use exception presentation instead of routine success text', () => {
  assert.equal(draftPresentation({...pending, failed: true}, 5000), 'Draft not saved');
  assert.equal(draftPresentation({...pending, failed: true, conflict: true}, 5000), '');
});
