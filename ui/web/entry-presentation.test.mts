import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryView, MessageView, PartView } from '../shared/api.ts';
import { entryVisible, presentEntry, presentMessage } from './entry-presentation.ts';
import type { PresentationContext } from './transcript-presentation.ts';

const coverage = {complete: true, truncated: false, omitted: 0};
function message(parts: PartView[] = [], changes: Partial<MessageView> = {}): MessageView { return {id: 'message', role: 'system', state: 'final', parts, coverage, ...changes}; }
test('contentless messages and entries have no visible chrome', () => {
  for (const parts of [[], [{type: 'text' as const, text: ''}], [{type: 'text' as const, text: ' \n\t'}]]) {
    const value = message(parts); assert.equal(presentMessage(value).visible, false);
    assert.equal(entryVisible({id: 'entry', kind: 'message', messages: [value]}), false);
  }
  assert.equal(entryVisible({id: 'entry', kind: 'message', messages: []}), false);
  assert.equal(presentMessage(message([], {role: 'assistant', state: 'partial'})).visible, false);
  assert.deepEqual(presentMessage(message([{type: 'text', text: 'hello'}], {role: 'user'})), {label: 'You', visible: true});
});
test('errors, aborted responses, redacted thinking, tools, and reported omissions stay visible', () => {
  const cases = [message([], {error: 'failure'}), message([], {stopReason: 'error'}), message([], {stopReason: 'aborted'}), message([], {coverage: {...coverage, truncated: true}}), message([], {coverage: {...coverage, omitted: 1}}), message([], {coverage: {...coverage, complete: false}}), message([{type: 'omitted', label: 'Image omitted'}]), message([{type: 'thinking', text: '', redacted: true}]), message([{type: 'toolCall', callId: 'call', name: 'unknown', arguments: {value: {}, truncated: false}}])];
  for (const value of cases) { assert.equal(presentMessage(value).visible, true); assert.equal(entryVisible({id: 'entry', kind: 'message', messages: [value]}), true); }
  assert.equal(entryVisible({id: 'entry', kind: 'custom', data: {value: {}, truncated: false}}), true);
});
class Node {
  children: Node[] = []; private text = ''; className = '';
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; }
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
}
test('entry headings use public head text and session changes keep collapsed inspection', () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => new Node()}});
  try {
    const inspectionTitles: string[] = []; const sources: (() => string)[] = [];
    const context: PresentationContext = {bounded: text => text, rawText: JSON.stringify, structured: () => { throw new Error('Generic entries must not create nested structured disclosures'); },
      inspection: (title, source) => { inspectionTitles.push(title); sources.push(source); const node = new Node(); node.textContent = title; return node as unknown as HTMLDetailsElement; }};
    const entry: EntryView = {id: 'entry', kind: 'custom', head: '<public-type>', data: {value: {text: 'data'}, truncated: false}};
    assert.equal(presentEntry(entry, context).textContent, '<public-type> · data');
    const generic = presentEntry({...entry, head: undefined}, context);
    assert.equal(generic.textContent, 'custom · data'); assert.equal(generic.children.length, 1);
    presentEntry({...entry, kind: 'model_change', data: {value: {provider: 'p', modelId: 'm'}, truncated: false}}, context);
    presentEntry({...entry, kind: 'thinking_level_change', data: {value: {thinkingLevel: 'high'}, truncated: false}}, context);
    assert.deepEqual(inspectionTitles, ['<public-type> · data', 'custom · data', 'model changed to p/m', 'thinking changed to high']);
    assert.equal(sources[0](), JSON.stringify({text: 'data'}));
    const omitted = presentEntry({...entry, head: 'message', data: {value: {values: ['<script>']}, truncated: true, omittedBytes: 42}}, context);
    assert.equal(omitted.textContent, 'message · valuesOutput omitted by host · 42 bytes');
    assert.equal(sources.at(-1)?.(), JSON.stringify({values: ['<script>']}));
    const fields = presentEntry({...entry, head: undefined, data: {value: {a: 1, b: 2, c: 3, d: 4, e: 5}, truncated: false}}, context);
    assert.equal(fields.textContent, 'custom · a, b, c, d, …');
    const multiline = presentEntry({...entry, head: undefined, data: {value: 'first line\n  second', truncated: false}}, context);
    assert.equal(multiline.textContent, 'custom · first line second');
  } finally { if (old) Object.defineProperty(globalThis, 'document', old); else Reflect.deleteProperty(globalThis, 'document'); }
});
