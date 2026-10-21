import assert from 'node:assert/strict';
import test from 'node:test';
import {handoverPickup, pickupInput, pickupTerminal} from './handover.ts';
import {handoverPrimary} from './handover-view.ts';
import type {PrimaryView} from '../shared/api.ts';
const id = '20260101T000000Z-sample-handover';

test('pickup text accepts the documented terminal, command, and identity forms', () => {
  for (const text of [id, `/stash get ${id}`, `pi "/stash get ${id}"`, `pi '/stash get ${id}'`]) {
    const parsed = handoverPickup(text); assert.ok(parsed); assert.equal(parsed.id, id); assert.equal(parsed.note, '');
  }
  assert.deepEqual(handoverPickup(`/stash get ${id} remember the new port`), {id, note: 'remember the new port', terminal: false});
  for (const text of ['', `pi "/stash new ${id}"`, 'two words', 'folder/id', `/stash pickup ${id}`, `pi "/stash get ${id}" extra`]) assert.equal(handoverPickup(text), undefined);
});
test('terminal copies retain exact notes without shell expansion and parse back to the same input', () => {
  const pickup = {id, note: 'Keep $HOME, `text`, "quotes", and \\paths'};
  const terminal = pickupTerminal(pickup); const parsed = handoverPickup(terminal); assert.ok(parsed);
  assert.equal(pickupInput(parsed), pickupInput(pickup)); assert.match(terminal, /\\\$HOME/); assert.match(terminal, /\\`text\\`/);
  assert.equal(pickupTerminal({id, note: ''}), `pi "/stash get ${id}"`);
});
test('only ready idle Primaries without outstanding work are pickup targets', () => {
  const primary = {lifecycle: 'ready', activity: 'idle', pendingOperationIds: [], pendingDialogs: []} as unknown as PrimaryView;
  assert.equal(handoverPrimary(primary), true);
  for (const change of [{lifecycle: 'starting'}, {activity: 'running'}, {activity: 'unknown'}, {pendingOperationIds: ['one']}, {pendingDialogs: [{id: 'one'}]}]) assert.equal(handoverPrimary({...primary, ...change} as PrimaryView), false);
});
