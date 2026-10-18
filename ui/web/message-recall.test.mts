import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryView, MessageView } from '../shared/api.ts';
import { onEdge, RECALL_LIMITS, recallItems, recallLabel, recallText } from './message-recall.ts';

const coverage = {complete: true, truncated: false, omitted: 0};
const message = (text: string, changes: Partial<MessageView> = {}): MessageView => ({id: 'm', role: 'user', state: 'final', parts: [{type: 'text', text}], coverage, ...changes});
const entry = (id: string, messages: MessageView[], changes: Partial<EntryView> = {}): EntryView => ({id, kind: 'pi.user', messages, ...changes});

test('only complete finished plain user text is recallable', () => {
  assert.equal(recallText(message('hello')), 'hello');
  assert.equal(recallText(message('  ')), undefined);
  for (const changes of [{role: 'assistant'}, {state: 'partial' as const}, {error: 'failed'}, {communication: {state: 'unresolved' as const}}, {coverage: {...coverage, truncated: true}}, {coverage: {...coverage, omitted: 1}}, {coverage: {...coverage, complete: false}}] as Partial<MessageView>[]) assert.equal(recallText(message('hello', changes)), undefined, JSON.stringify(changes));
  assert.equal(recallText(message('', {parts: [{type: 'text', text: 'x', redacted: true}]})), undefined);
  assert.equal(recallText(message('', {parts: [{type: 'text', text: 'x', more: {} as never}]})), undefined);
  assert.equal(recallText(message('', {parts: [{type: 'text', text: 'a'}, {type: 'omitted', label: 'x'}]})), undefined);
  assert.equal(recallText(message('look\n\nAttached image "a.png"')), undefined, 'a message that carried an image would lose it');
});
test('the list runs oldest first, drops carriers, collapses repeats and keeps the newest within the bounds', () => {
  const entries = [entry('1', [message('one')]), entry('2', [message('two')]), entry('3', [message('two')]), entry('4', [message('report', {communication: {state: 'unresolved'}})]), entry('5', [message('three')])];
  assert.deepEqual(recallItems(entries), ['one', 'two', 'three']);
  const many = Array.from({length: RECALL_LIMITS.entries + 5}, (_, index) => entry(String(index), [message(`m${index}`)]));
  const kept = recallItems(many); assert.equal(kept.length, RECALL_LIMITS.entries); assert.equal(kept.at(-1), `m${RECALL_LIMITS.entries + 4}`);
  const heavy = [entry('a', [message('x'.repeat(RECALL_LIMITS.bytes + 1))]), entry('b', [message('y'.repeat(RECALL_LIMITS.bytes - 10))]), entry('c', [message('z'.repeat(20))])];
  assert.deepEqual(recallItems(heavy).map(text => text[0]), ['z'], 'the byte bound keeps the newest and never truncates one message');
});
test('browser copies count only after accepted delivery', () => {
  const echo = (delivery: string): EntryView => entry('ui', [message('typed')], {kind: 'ui.input', data: {value: {delivery}, truncated: false}});
  assert.deepEqual(recallItems([echo('Sent')]), ['typed']);
  for (const delivery of ['Sending…', 'Delivery not confirmed', 'Message not sent']) assert.deepEqual(recallItems([echo(delivery)]), [], delivery);
  assert.deepEqual(recallItems([echo('Sent'), entry('native', [message('typed')])]), ['typed'], 'the same text arriving in history appears once');
});
test('edges name the first and last logical line and the label states its scope', () => {
  assert.equal(onEdge('one\ntwo', 2, 'first'), true); assert.equal(onEdge('one\ntwo', 5, 'first'), false);
  assert.equal(onEdge('one\ntwo', 5, 'last'), true); assert.equal(onEdge('one\ntwo', 2, 'last'), false);
  assert.equal(recallLabel(11, 12).visible.startsWith('Earlier message 1 of 12'), true, 'the newest is first');
  assert.deepEqual(recallLabel(9, 12), {visible: 'Earlier message 3 of 12 · Esc restores your draft', spoken: 'Earlier message 3 of 12 from the loaded conversation. Escape restores your draft.'});
});
