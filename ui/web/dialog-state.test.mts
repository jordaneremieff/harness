import assert from 'node:assert/strict';
import test from 'node:test';
import type { DialogView } from '../shared/api.ts';
import { activeDialog, cancelDialogs, createDialogs, enqueueDialog, expireDialog, expirePrimaryDialogs, reconcileDialogs, respondDialog } from './dialog-state.ts';
const target = {kind: 'primary' as const, key: 'primary', epoch: 1};
const dialog = (id: string, method: DialogView['method'] = 'input'): DialogView => ({id, method, title: id, options: ['exact option', 'second']});

test('dialog queue preserves request order and excludes background primaries', () => {
  let state = enqueueDialog(createDialogs(), {...target, key: 'background'}, dialog('background'));
  state = enqueueDialog(state, target, dialog('first'));
  state = enqueueDialog(state, target, dialog('second'));
  assert.equal(activeDialog(state, target)?.dialog.id, 'first');
  assert.equal(enqueueDialog(state, target, dialog('first')), state);
  const result = respondDialog(state, target, 'first', {value: ' exact\ntext '});
  assert.deepEqual(result.command?.response, {epoch: 1, value: ' exact\ntext '});
  assert.equal(activeDialog(result.state, target)?.dialog.id, 'second');
});
test('exactly one command leaves a dialog despite duplicate clicks and snapshots', () => {
  const state = enqueueDialog(createDialogs(), target, dialog('id', 'confirm'));
  const first = respondDialog(state, target, 'id', {confirmed: false});
  assert.ok(first.command);
  assert.equal(respondDialog(first.state, target, 'id', {confirmed: true}).command, undefined);
  assert.equal(respondDialog(reconcileDialogs(first.state, target, [dialog('id', 'confirm')]), target, 'id', {cancelled: true}).command, undefined);
  assert.equal(respondDialog(state, {...target, epoch: 2}, 'id', {confirmed: true}).command, undefined);
});
test('response shape and exact select options require validation', () => {
  const confirm = enqueueDialog(createDialogs(), target, dialog('c', 'confirm'));
  assert.equal(respondDialog(confirm, target, 'c', {value: 'yes'}).command, undefined);
  const select = enqueueDialog(createDialogs(), target, dialog('s', 'select'));
  assert.equal(respondDialog(select, target, 's', {value: 'exact'}).command, undefined);
  assert.equal(respondDialog(select, target, 's', {value: 'exact option'}).command?.response.epoch, 1);
  const editor = enqueueDialog(createDialogs(), target, dialog('e', 'editor'));
  assert.ok(respondDialog(editor, target, 'e', {value: ''}).command);
});
test('stop cancels each pending request once in queue order', () => {
  let state = enqueueDialog(createDialogs(), target, dialog('a'));
  state = enqueueDialog(state, target, dialog('b'));
  state = enqueueDialog(state, {...target, key: 'other'}, dialog('other'));
  const cancelled = cancelDialogs(state, target);
  assert.deepEqual(cancelled.commands.map(command => command.id), ['a', 'b']);
  assert.deepEqual(cancelled.commands[0].response, {epoch: 1, cancelled: true});
  assert.equal(cancelDialogs(cancelled.state, target).commands.length, 0);
  assert.equal(activeDialog(cancelled.state, {...target, key: 'other'})?.dialog.id, 'other');
});
test('host timeout expires locally without a second response or a browser countdown', () => {
  let state = enqueueDialog(createDialogs(), target, {...dialog('id'), deadline: '2000-01-01T00:00:00Z'});
  assert.equal(activeDialog(state, target)?.dialog.id, 'id');
  state = expireDialog(state, target, 'id', 'timeout');
  assert.equal(activeDialog(state, target), undefined);
  assert.equal(respondDialog(state, target, 'id', {value: 'late'}).command, undefined);
});
test('epoch replacement expires old requests without affecting a new request ID', () => {
  let state = enqueueDialog(createDialogs(), target, dialog('same'));
  const replacement = {...target, epoch: 2};
  state = expirePrimaryDialogs(state, target.key, 2);
  state = enqueueDialog(state, replacement, dialog('same'));
  assert.equal(activeDialog(state, target), undefined);
  assert.equal(activeDialog(state, replacement)?.dialog.id, 'same');
  assert.equal(respondDialog(state, target, 'same', {value: 'old'}).command, undefined);
});
test('snapshot reconciliation expires absent pending requests without implicit cancellation', () => {
  let state = enqueueDialog(createDialogs(), target, dialog('old'));
  state = reconcileDialogs(state, target, [dialog('new')]);
  assert.equal(activeDialog(state, target)?.dialog.id, 'new');
  assert.equal(respondDialog(state, target, 'old', {cancelled: true}).command, undefined);
});

test('select responses use opaque option keys instead of display labels', () => {
  const request: DialogView = {...dialog('safe', 'select'), options: ['Visible choice'], optionKeys: ['option-0']};
  const state = enqueueDialog(createDialogs(), target, request);
  const label = respondDialog(state, target, 'safe', {value: 'Visible choice'});
  assert.equal(label.state, state); assert.equal(label.command, undefined);
  assert.equal(respondDialog(state, target, 'safe', {value: 'unknown-key'}).command, undefined);
  const selected = respondDialog(state, target, 'safe', {value: 'option-0'});
  assert.deepEqual(selected.command?.response, {epoch: 1, value: 'option-0'});
  assert.equal(respondDialog(selected.state, target, 'safe', {value: 'option-0'}).command, undefined);
});
test('a present empty option key list never authorizes a display label', () => {
  const request: DialogView = {...dialog('empty', 'select'), options: ['Visible choice'], optionKeys: []};
  const state = enqueueDialog(createDialogs(), target, request);
  assert.equal(respondDialog(state, target, 'empty', {value: 'Visible choice'}).command, undefined);
  assert.deepEqual(respondDialog(state, target, 'empty', {cancelled: true}).command?.response, {epoch: 1, cancelled: true});
});
