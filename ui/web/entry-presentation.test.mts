import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { EntryView, MessageView, PartView } from '../shared/api.ts';
import { entryVisible, messageAriaLabel, presentEntry, presentMessage, sessionEventsSummary } from './entry-presentation.ts';
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
  assert.deepEqual(presentMessage(message([{type: 'text', text: 'hello'}], {role: 'user'})), {label: '', visible: true});
  assert.deepEqual(presentMessage(message([{type: 'text', text: 'hello'}], {role: 'user'}), true), {label: 'You', visible: true});
  assert.deepEqual(presentMessage(message([{type: 'text', text: 'hello'}], {role: 'assistant'}), true), {label: '', visible: true});
  assert.equal(messageAriaLabel(message([], {role: 'assistant'})), 'Agent response');
  assert.equal(messageAriaLabel(message([], {role: 'user'})), 'Incoming message');
  assert.equal(messageAriaLabel(message([], {role: 'user'}), true), 'Your message');
});
test('communication state remains visible without original content', () => {
  const value = message([], {communication: {state: 'unresolved'}}); assert.equal(presentMessage(value).visible, true); assert.equal(entryVisible({id: 'entry', kind: 'message', messages: [value]}), true);
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
    assert.equal(omitted.textContent, 'message · valuesSome output is not available. · 42 bytes');
    assert.equal(sources.at(-1)?.(), JSON.stringify({values: ['<script>']}));
    const fields = presentEntry({...entry, head: undefined, data: {value: {a: 1, b: 2, c: 3, d: 4, e: 5}, truncated: false}}, context);
    assert.equal(fields.textContent, 'custom · a, b, c, d, …');
    const multiline = presentEntry({...entry, head: undefined, data: {value: 'first line\n  second', truncated: false}}, context);
    assert.equal(multiline.textContent, 'custom · first line second');
  } finally { if (old) Object.defineProperty(globalThis, 'document', old); else Reflect.deleteProperty(globalThis, 'document'); }
});
test('a dotted type name never labels a row and raw inspection keeps the original type', () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => new Node()}});
  try {
    const sources: (() => string)[] = [];
    const context: PresentationContext = {bounded: text => text, rawText: JSON.stringify, structured: () => { throw new Error('Generic entries must not create nested structured disclosures'); },
      inspection: (title, source) => { sources.push(source); const node = new Node(); node.textContent = title; return node as unknown as HTMLDetailsElement; }};
    const readable = presentEntry({id: 'a', kind: 'vendor.feature.event', data: {value: {delivery: 'Sent'}, truncated: false}}, context);
    assert.equal(readable.textContent, 'Record · Sent'); assert.doesNotMatch(readable.textContent, /vendor|feature|\./);
    assert.equal(sources[0]?.(), `vendor.feature.event\n${JSON.stringify({delivery: 'Sent'})}`);
    const headed = presentEntry({id: 'b', kind: 'custom', head: 'acme.status', data: {value: {text: 'ready'}, truncated: false}}, context);
    assert.equal(headed.textContent, 'Record · ready'); assert.equal(sources[1]?.(), `acme.status\n${JSON.stringify({text: 'ready'})}`);
    const bare = presentEntry({id: 'c', kind: 'x.y', data: {value: {count: 3}, truncated: false}}, context);
    assert.equal(bare.textContent, 'Record');
    const uuid = '01a150ef-eb01-76be-93eb-e251e623e852', digest = 'ab'.repeat(32);
    const mixed = presentEntry({id: 'e', kind: 'vendor.thing', data: {value: {id: uuid, digest, state: 'sent'}, truncated: false}}, context);
    assert.equal(mixed.textContent, 'Record · sent'); assert.doesNotMatch(mixed.textContent, /01a150ef|abab/);
    const only = presentEntry({id: 'f', kind: 'vendor.thing', data: {value: {sessionId: uuid, ref: `${uuid}:7`, digest}, truncated: false}}, context);
    assert.equal(only.textContent, 'Record'); assert.equal(sources.at(-1)?.(), `vendor.thing\n${JSON.stringify({sessionId: uuid, ref: `${uuid}:7`, digest})}`);
    assert.equal(sources.at(-2)?.(), `vendor.thing\n${JSON.stringify({id: uuid, digest, state: 'sent'})}`);
    assert.equal(presentEntry({id: 'd', kind: 'custom', head: 'v1.2 status', data: {value: 'ok', truncated: false}}, context).textContent, 'v1.2 status · ok');
  } finally { if (old) Object.defineProperty(globalThis, 'document', old); else Reflect.deleteProperty(globalThis, 'document'); }
});
test('the session events line names the settings or counts each kind, never a bare count', () => {
  const model: EntryView = {id: 'm', kind: 'model_change', data: {value: {provider: 'p', modelId: 'claude-haiku-5-5'}, truncated: false}};
  const thinking: EntryView = {id: 't', kind: 'thinking_level_change', data: {value: {thinkingLevel: 'low'}, truncated: false}};
  const custom: EntryView = {id: 'c', kind: 'custom', data: {value: {a: 1}, truncated: false}};
  assert.equal(sessionEventsSummary([model, thinking]), 'Model claude-haiku-5-5 · Thinking low');
  assert.equal(sessionEventsSummary([thinking]), 'Thinking low');
  assert.equal(sessionEventsSummary([model, {...thinking, id: 't2'}, {...model, id: 'm2'}, {...thinking, id: 't3'}, {...model, id: 'm3'}]), '5 settings changes');
  assert.equal(sessionEventsSummary([model, custom, {...custom, id: 'c2'}]), '1 settings change, 2 extension records');
  assert.equal(sessionEventsSummary([{id: 'u', kind: 'vendor.thing'}, {id: 'v', kind: 'unknown_kind'}, {id: 'i', kind: 'session_info'}]), '2 records, 1 session info update');
  assert.equal(sessionEventsSummary([{...model, data: {value: {provider: 'p'}, truncated: false}}]), '1 settings change');
});
test('a user-role block takes the width of its text and keeps Message actions at its edge when it has no role word', async () => {
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(css, /\.message\.user \{ width: fit-content; max-width: min\(100%, calc\(72ch \+ 24px\)\)/);
  assert.match(css, /\.message\.user > \.message-header \{ max-width: 100%; \}/);
  assert.match(css, /\.message\.user:has\(> \.message-header > :is\(\.message-role, \.communication-sender\)\[hidden\]\) > \.message-header \{ position: absolute; top: 4px; right: 4px;/);
  assert.match(css, /\.message\.user:has\(> \.message-header > :is\(\.message-role, \.communication-sender\)\[hidden\]\) \{ max-width: min\(100%, calc\(72ch \+ 52px\)\); \}/);
  assert.match(css, /\[hidden\]\) > \.message-body \{ margin-top: 0; padding-right: 40px; \}/);
});
