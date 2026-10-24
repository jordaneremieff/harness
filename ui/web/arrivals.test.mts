import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryView, MessageView } from '../shared/api.ts';
import { ARRIVAL_CAP, ArrivalCounter, latestLabel } from './arrivals.ts';

const coverage = {complete: true, truncated: false, omitted: 0};
const message = (id: string, parts: MessageView['parts'], role = 'assistant'): MessageView => ({id, role, state: 'final', parts, coverage});
const say = (id: string, text = id, role = 'assistant'): EntryView => ({id: `e-${id}`, kind: 'message', messages: [message(id, [{type: 'text', text}], role)]});
const tools = (id: string): EntryView => ({id: `e-${id}`, kind: 'message', messages: [message(id, [{type: 'toolCall', callId: id, name: 'read', arguments: {value: {}, truncated: false}}])]});

test('the first observation, and entries that reach the end while following, never count', () => {
  const counter = new ArrivalCounter();
  assert.equal(counter.observe([say('a'), say('b')], true, false), 0);
  assert.equal(counter.observe([say('a'), say('b'), say('c')], false, false), 0); assert.equal(counter.count, 0);
  assert.equal(counter.observe([say('a'), say('b'), say('c'), say('d')], true, false), 1); assert.equal(counter.count, 1);
});
test('an arrival is a new readable message at the end: text, an image or a typed communication', () => {
  const counter = new ArrivalCounter(); const base = [say('a')]; counter.observe(base, true, false);
  const image: EntryView = {id: 'e-i', kind: 'message', messages: [message('i', [{type: 'image', mimeType: 'image/png', width: 1, height: 1, bytes: 1, ref: {}} as never])]};
  const report: EntryView = {id: 'e-r', kind: 'custom', messages: [{...message('r', []), role: 'custom', communication: {state: 'unresolved'}}]};
  assert.equal(counter.observe([...base, image, report], true, false), 2);
});
test('tool calls, tool results, thinking alone, blank text, event groups and browser echoes are not arrivals', () => {
  const counter = new ArrivalCounter(); const base = [say('a')]; counter.observe(base, true, false);
  const thinking: EntryView = {id: 'e-t', kind: 'message', messages: [message('t', [{type: 'thinking', text: 'hmm'}])]};
  const result: EntryView = {id: 'e-x', kind: 'message', messages: [message('x', [{type: 'toolResult', callId: 'c', name: 'read', parts: [{type: 'text', text: 'output'}], isError: false}], 'toolResult')]};
  const blank: EntryView = {id: 'e-b', kind: 'message', messages: [message('b', [{type: 'text', text: '   '}])]};
  const group: EntryView = {id: 'e-g', kind: 'pi.event'};
  const echo: EntryView = {id: 'e-u', kind: 'ui.input', messages: [message('u', [{type: 'text', text: 'typed'}], 'user')]};
  assert.equal(counter.observe([...base, tools('k'), thinking, result, blank, group, echo], true, false), 0);
});
test('older history added above the known messages never counts', () => {
  const counter = new ArrivalCounter(); const known = [say('c'), say('d')]; counter.observe(known, true, false);
  assert.equal(counter.observe([say('a'), say('b'), ...known], true, false), 0);
  assert.equal(counter.observe([say('a'), say('b'), ...known, say('e')], true, false), 1);
});
test('a streaming message counts once when it first has readable content, and its final copy does not count again', () => {
  const counter = new ArrivalCounter(); const base = [say('a')]; counter.observe(base, true, false);
  const streaming = (parts: MessageView['parts'], state: 'partial' | 'final', entry: string): EntryView => ({id: entry, kind: 'message', messages: [{...message('m', parts), state}]});
  assert.equal(counter.observe([...base, streaming([{type: 'thinking', text: '...'}], 'partial', 'live')], true, false), 0);
  assert.equal(counter.observe([...base, streaming([{type: 'text', text: 'Hel'}], 'partial', 'live')], true, false), 1);
  assert.equal(counter.observe([...base, streaming([{type: 'text', text: 'Hello there'}], 'partial', 'live')], true, false), 0, 'growth is not an arrival');
  assert.equal(counter.observe([...base, streaming([{type: 'text', text: 'Hello there'}], 'final', 'saved-7')], true, false), 0, 'the saved copy keeps the message identity');
  assert.equal(counter.count, 1);
});
test('the operator\'s own user messages are skipped only where user input is the operator', () => {
  const own = new ArrivalCounter(), shared = new ArrivalCounter(); const base = [say('a')]; own.observe(base, true, false); shared.observe(base, true, false);
  const withInput = [...base, say('u', 'my question', 'user')];
  assert.equal(own.observe(withInput, true, true), 0); assert.equal(shared.observe(withInput, true, false), 1);
});
test('returning to the end clears the count, and known messages stay known', () => {
  const counter = new ArrivalCounter(); const base = [say('a')]; counter.observe(base, true, false);
  counter.observe([...base, say('b')], true, false); counter.clear(); assert.equal(counter.count, 0);
  assert.equal(counter.observe([...base, say('b')], true, false), 0);
  assert.equal(counter.observe([...base, say('b'), say('c')], true, false), 1);
  counter.reset(); assert.equal(counter.count, 0); assert.equal(counter.observe([say('z')], true, false), 0, 'a reset conversation primes again');
});
test('the control shows no text until messages arrive, then a capped count badge', () => {
  assert.deepEqual(latestLabel(0), {text: '', accessible: 'Latest message'});
  assert.deepEqual(latestLabel(1), {text: '1', accessible: 'Latest message, 1 new'});
  assert.deepEqual(latestLabel(ARRIVAL_CAP), {text: '99', accessible: 'Latest message, 99 new'});
  assert.deepEqual(latestLabel(ARRIVAL_CAP + 1), {text: '99+', accessible: 'Latest message, more than 99 new'});
});
const stamped = (id: string, entry: string, text: string, timestamp: number, state: 'partial' | 'final' = 'final'): EntryView =>
  ({id: entry, kind: 'message', messages: [{...message(id, [{type: 'text', text}]), state, timestamp}]});
test('an agent reply streamed under a live id and saved under another counts once, and the next turn under the same live id counts again', () => {
  const counter = new ArrivalCounter(); const base = [say('a')]; counter.observe(base, true, false);
  assert.equal(counter.observe([...base, stamped('live:agent', 'live:agent', 'Hel', 100, 'partial')], true, false), 1);
  assert.equal(counter.count, 1);
  assert.equal(counter.observe([...base, stamped('saved-7', 'e-7', 'Hello', 100)], true, false), 0, 'the saved copy shares the live message\'s role and timestamp');
  assert.equal(counter.count, 1);
  assert.equal(counter.observe([...base, stamped('saved-7', 'e-7', 'Hello', 100), stamped('live:agent', 'live:agent', 'Next', 200, 'partial')], true, false), 1);
  assert.equal(counter.count, 2);
  assert.equal(counter.observe([...base, stamped('saved-7', 'e-7', 'Hello', 100), stamped('saved-9', 'e-9', 'Next turn', 200)], true, false), 0);
  assert.equal(counter.count, 2);
});
test('saved assistant messages that share a timestamp stay separate when no live copy preceded them', () => {
  const counter = new ArrivalCounter(); const base = [say('a')]; counter.observe(base, true, false);
  assert.equal(counter.observe([...base, stamped('s1', 'e-1', 'One', 300), stamped('s2', 'e-2', 'Two', 300)], true, false), 2);
});
