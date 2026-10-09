import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptCommand, commandToken, emptyMenu, menuKey, rankCommands, updateMenu } from './command-menu-state.ts';
import type { CommandInventory, CommandOption } from './command-menu-state.ts';
const option = (name: string, description = ''): CommandOption => ({name, description, source: 'extension'});
const inventory: CommandInventory = {items: [option('compact'), option('model'), option('thinking')], state: 'ready'};
const open = (text = '/mo') => updateMenu(emptyMenu(), text, text.length, text.length, inventory);
test('a collapsed caret in the leading slash token is the only trigger', () => {
  assert.deepEqual(commandToken('/', 1), {name: '', end: 1});
  assert.deepEqual(commandToken('/mo arguments', 2), {name: 'mo', end: 3});
  assert.deepEqual(commandToken('/mo arguments', 3), {name: 'mo', end: 3});
  for (const [text, start, end] of [[' /mo', 4, 4], ['hello /mo', 9, 9], ['\n/mo', 4, 4], ['/mo args', 4, 4], ['/mo', 0, 0], ['/mo', 1, 3]] as const) assert.equal(commandToken(text, start, end), undefined);
});
test('ranking orders exact, name prefix, segment prefix, subsequence, and description matches with alphabetical ties', () => {
  const items = [option('other', 'Choose a model'), option('more'), option('m-o'), option('skill:mo'), option('mo'), option('mode'), option('foo-mo-foo'), option('mfoo:mo')];
  const result = rankCommands(items, 'Mo');
  assert.deepEqual(result.map(match => [match.item.name, match.rank]), [['mo', 0], ['mode', 1], ['more', 1], ['foo-mo-foo', 2], ['mfoo:mo', 2], ['skill:mo', 2], ['m-o', 3], ['other', 4]]);
  assert.deepEqual(result.find(match => match.item.name === 'skill:mo')?.marks, [6, 7]);
  assert.deepEqual(result.find(match => match.item.name === 'm-o')?.marks, [0, 2]);
  assert.deepEqual(result.find(match => match.item.name === 'other')?.marks, []);
  assert.equal(rankCommands(items, 'zzzz').length, 0);
  assert.deepEqual(rankCommands([option('z'), option('a')], '').map(match => match.item.name), ['a', 'z']);
});
test('arrow keys clamp and inventory updates preserve the selected name', () => {
  let state = open('/'); state = menuKey(state, {key: 'ArrowUp'}).state; assert.equal(state.active, 0);
  for (let index = 0; index < 6; index++) state = menuKey(state, {key: 'ArrowDown'}).state;
  assert.equal(state.active, 2);
  state = updateMenu(state, '/', 1, 1, {state: 'ready', items: [option('aaa'), ...inventory.items]});
  assert.equal(state.matches[state.active]?.item.name, 'thinking');
  state = updateMenu(state, '/mo', 3, 3, inventory); assert.equal(state.active, 0);
});
test('Escape suppresses the same token across inventory, focus, and caret changes until a token edit', () => {
  let state = menuKey(open(), {key: 'Escape'}).state; assert.equal(state.open, false);
  state = updateMenu(state, '/mo rest', 3, 3, inventory); assert.equal(state.open, false);
  state = updateMenu(state, '/mo rest', 8, 8, inventory); assert.equal(state.open, false);
  state = updateMenu(state, '/mo rest', 2, 2, inventory); assert.equal(state.open, false);
  state = updateMenu(state, '/mod rest', 4, 4, inventory); assert.equal(state.open, true);
  assert.equal(state.suppressed, undefined);
});
test('Enter and Tab accept including exact names, without a send action', () => {
  for (const text of ['/mo', '/model']) for (const key of ['Enter', 'Tab']) assert.equal(menuKey(open(text), {key}).action, 'accept');
  assert.equal(menuKey(emptyMenu(), {key: 'Enter'}).action, 'native');
  assert.equal(menuKey(open(), {key: 'Tab', shiftKey: true}).action, 'native');
});
test('empty and loading lists consume Enter and unavailable inventories never open', () => {
  const empty = open('/missing'); assert.equal(empty.open, true); assert.equal(empty.matches.length, 0);
  assert.equal(menuKey(empty, {key: 'Enter'}).action, 'handled');
  const loading = updateMenu(emptyMenu(), '/', 1, 1, {state: 'loading', items: []});
  assert.equal(loading.open, true); assert.equal(menuKey(loading, {key: 'Enter'}).action, 'handled');
  assert.equal(updateMenu(emptyMenu(), '/', 1, 1, {state: 'unavailable', items: []}).open, false);
});
test('ShiftEnter dismisses for a native newline and IME or modified keys never accept', () => {
  const state = open(); const newline = menuKey(state, {key: 'Enter', shiftKey: true});
  assert.equal(newline.state.open, false); assert.equal(newline.action, 'native');
  for (const extra of [{isComposing: true}, {keyCode: 229}, {repeat: true}, {ctrlKey: true}, {metaKey: true}, {altKey: true}]) assert.equal(menuKey(state, {key: 'Enter', ...extra}).action, 'native');
  assert.equal(updateMenu(state, '/mo', 3, 3, inventory, true).open, false);
});
test('acceptance changes only the command token and its separator, preserves arguments and positions the caret', () => {
  for (const [text, expected] of [['/mo', '/model '], ['/mo keep  these\nlines', '/model keep  these\nlines'], ['/mo  spaced', '/model  spaced'], ['/mo\nnext', '/model \nnext']]) {
    const token = commandToken(text, 3); assert.ok(token);
    assert.deepEqual(acceptCommand(text, token, 'model'), {text: expected, caret: 7});
  }
});
test('partial inventory remains ready but carries its incompleteness through empty matches', () => {
  const state = updateMenu(emptyMenu(), '/missing', 8, 8, {...inventory, incomplete: true});
  assert.equal(state.open, true); assert.equal(state.incomplete, true); assert.equal(state.matches.length, 0);
  assert.equal(updateMenu(state, '/missing', 8, 8, inventory).incomplete, undefined);
});
