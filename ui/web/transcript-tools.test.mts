import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryView, PartView } from '../shared/api.ts';
import { TranscriptIndex } from './transcript-tools.ts';

const coverage = {complete: true, truncated: false, omitted: 0};
function entry(id: string, parts: PartView[]): EntryView { return {id, kind: 'message', messages: [{id, role: 'assistant', state: 'final', parts, coverage}]}; }
const call = (id: string): PartView => ({type: 'toolCall', callId: id, name: 'read', arguments: {value: {}, truncated: false}});
const result = (id: string, text: string): PartView => ({type: 'toolResult', callId: id, name: 'read', isError: false, parts: [{type: 'text', text}]});

test('text deltas inspect changed entries without reading retained message parts', () => {
  const index = new TranscriptIndex(); let reads = 0;
  const retained = entry('retained', [call('tool')]); const parts = retained.messages?.[0]?.parts;
  Object.defineProperty(retained.messages?.[0], 'parts', {get: () => { reads++; return parts; }});
  const tail = entry('tail', [{type: 'text', text: 'a'}]);
  index.update([retained, tail], new Map()); const before = reads; const tool = index.joined.get('tool');
  index.update([retained, entry('tail', [{type: 'text', text: 'ab'}])], new Map());
  assert.equal(reads, before); assert.equal(index.joined.get('tool'), tool);
  assert.deepEqual([...index.changed], ['tail']);
});
test('changed results and tool state update the call owner and preserve exact result parts', () => {
  const index = new TranscriptIndex(); const owner = entry('call', [call('x')]); const answer = entry('result', [result('x', 'one')]);
  index.update([owner, answer], new Map());
  assert.equal(index.joined.get('x')?.owner, 'call');
  assert.equal(index.disclosures.get('tool:x'), 'call');
  const parts: PartView[] = [{type: 'text', text: 'two'}];
  index.update([owner, answer], new Map([['x', {callId: 'x', name: 'read', phase: 'end', parts, isError: true}]]));
  assert.equal(index.joined.get('x')?.result, parts); assert.equal(index.joined.get('x')?.status, 'error');
  assert.equal(index.changed.has('call'), true); assert.equal(index.changed.has('result'), true);
  index.update([answer], new Map()); assert.equal(index.joined.get('x')?.owner, 'result');
  index.update([], new Map()); assert.equal(index.joined.size, 0); assert.equal(index.disclosures.size, 0);
});
test('reorder reassigns duplicate calls and disclosure owners without losing tool results', () => {
  const index = new TranscriptIndex(); const a = entry('a', [call('x'), {type: 'thinking', text: 'thought'}]); const b = entry('b', [call('x'), result('x', 'retained')]);
  index.update([a, b], new Map()); assert.equal(index.joined.get('x')?.owner, 'a');
  index.update([b, a], new Map()); assert.equal(index.joined.get('x')?.owner, 'b');
  assert.equal(index.disclosures.get('thinking:a:a:1'), 'a');
  index.update([b], new Map()); assert.equal(index.disclosures.has('thinking:a:a:1'), false);
});
