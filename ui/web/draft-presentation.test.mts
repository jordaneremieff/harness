import assert from 'node:assert/strict';
import test from 'node:test';
import { draftImageFingerprint } from '../shared/api.ts';
import { clampSelection, draftPresentation, editorSelectionKey, readEditorSelection, SLOW_SAVE_MS } from './draft-presentation.ts';
import type { DraftPresentation, EditorSelection } from './draft-presentation.ts';
const range: EditorSelection = {start: 2, end: 5, direction: 'backward', text: 'sample', revision: 4, edit: 7, scrollTop: 48, scrollLeft: 12, imageFingerprint: '[]'};
test('editor checkpoint keys distinguish workspace, primary epoch and exact agent identity', () => {
  const targets = [{kind: 'primary', key: 'a', epoch: 1}, {kind: 'primary', key: 'a', epoch: 2}, {kind: 'agent', identity: 'storage:1'}, {kind: 'agent', identity: 'storage:2'}] as const;
  assert.equal(new Set(targets.flatMap(target => ['w1', 'w2'].map(workspace => editorSelectionKey(workspace, target)))).size, 8);
});
test('reload ranges require exact text, mode and revision and contain malformed offsets', () => {
  const draft = {revision: 4, text: 'sample', mode: 'prompt', images: [], persisted: true} as const;
  const raw = JSON.stringify({...range, mode: draft.mode});
  assert.deepEqual(readEditorSelection(raw, draft), {...range, mode: 'prompt', edit: 0});
  for (const patch of [{revision: 5}, {text: 'remote'}, {mode: 'steer'}]) assert.equal(readEditorSelection(raw, {...draft, ...patch}), undefined);
  for (const patch of [{start: -1}, {end: 99}, {start: 5, end: 2}, {direction: 'invalid'}, {scrollTop: -1}, {scrollLeft: null}]) assert.equal(readEditorSelection(JSON.stringify({...range, mode: 'prompt', ...patch}), draft), undefined);
  assert.equal(readEditorSelection('{', draft), undefined);
});
test('stored caret checkpoints require a fingerprint without changing the saved draft', () => {
  const image = {digest: 'a'.repeat(64), mimeType: 'image/png' as const, bytes: 64, width: 1, height: 1, name: 'a.png'};
  for (const images of [[], [image]]) {
    const draft = {revision: 4, text: 'sample', mode: 'prompt', images, persisted: true as const};
    const before = structuredClone(draft);
    const {imageFingerprint: _fingerprint, ...obsolete} = {...range, mode: draft.mode};
    assert.equal(readEditorSelection(JSON.stringify(obsolete), draft), undefined);
    assert.deepEqual(draft, before);
    for (const imageFingerprint of [null, 0, false, [], {}, '']) {
      assert.equal(readEditorSelection(JSON.stringify({...obsolete, imageFingerprint}), draft), undefined);
      assert.deepEqual(draft, before);
    }
  }
});
test('current caret checkpoints accept exact empty and ordered nonempty image fingerprints', () => {
  const image = {digest: 'a'.repeat(64), mimeType: 'image/png' as const, bytes: 64, width: 1, height: 1, name: 'a.png'};
  for (const images of [[], [image, {...image, digest: 'b'.repeat(64), name: 'b.png'}]]) {
    const draft = {revision: 4, text: 'sample', mode: 'prompt', images, persisted: true as const};
    const saved = {...range, mode: draft.mode, imageFingerprint: draftImageFingerprint(images)};
    const before = structuredClone(draft);
    assert.deepEqual(readEditorSelection(JSON.stringify(saved), draft), {...saved, edit: 0});
    if (images.length) assert.equal(readEditorSelection(JSON.stringify(saved), {...draft, images: [...images].reverse()}), undefined);
    assert.deepEqual(draft, before);
  }
});
test('explicit replacement clamps selection and cleared drafts reset editor scroll', () => {
  assert.deepEqual(clampSelection(range, 'abc', 5, 8), {...range, start: 2, end: 3, text: 'abc', revision: 5, edit: 8});
  assert.deepEqual(clampSelection(range, '', 5, 8), {...range, start: 0, end: 0, scrollTop: 0, scrollLeft: 0, text: '', revision: 5, edit: 8});
});
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
  assert.equal(draftPresentation({...pending, connected: false}, 5000), 'Draft not saved');
});
test('save failures and conflicts use exception presentation instead of routine success text', () => {
  assert.equal(draftPresentation({...pending, failed: true}, 5000), 'Draft not saved');
  assert.equal(draftPresentation({...pending, failed: true, conflict: true}, 5000), '');
});

test('attachment changes invalidate caret checkpoints and image-only offline edits stay visible', () => {
  const image = {digest: 'a'.repeat(64), mimeType: 'image/png' as const, bytes: 64, width: 1, height: 1, name: 'a.png'};
  const draft = {revision: 4, text: 'sample', mode: 'prompt', images: [image], persisted: true as const};
  const range = clampSelection({start: 1, end: 1, direction: 'none', text: 'sample', revision: 4, edit: 0, scrollTop: 0, scrollLeft: 0}, draft.text, 4, 0, draft.images);
  const raw = JSON.stringify({...range, mode: draft.mode}); assert.ok(readEditorSelection(raw, draft));
  assert.equal(readEditorSelection(raw, {...draft, images: [{...image, name: 'renamed.png'}]}), undefined);
  assert.equal(readEditorSelection(raw, {...draft, images: []}), undefined);
  assert.equal(draftPresentation({...pending, connected: false, text: '', images: [image], outstandingSince: undefined}, 5000), 'Draft not saved');
});
