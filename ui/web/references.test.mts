import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommunicationPresentation, EntryView } from '../shared/api.ts';
import { communicationReferenceRows } from './communication.ts';
import { loadedReference, ReferenceResolver, type QualifiedReference } from './references.ts';
const storage = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const producer = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function carrier(conversationId = 1): Extract<CommunicationPresentation, {state: 'ready'}> {
  return {state: 'ready', origin: {kind: 'native', recordEntryId: 'record', target: {mode: 'input', storageId: storage, conversationId, entryId: '17', submissionId: 1, requestId: 'request'}},
    value: {format: 'agent.communication/1', sender: {identity: producer}, kind: 'result', body: {text: 'Answer', complete: true, redacted: false}, recordedAt: 1,
      metadata: {status: 'done', references: [{submissionId: 1, entryId: '17', answerEntryId: '18', requestId: 'request'}], omittedReferences: 0}}};
}
function entry(id: string, communication: CommunicationPresentation): EntryView {
  return {id, kind: 'message', messages: [{id: 'message', role: 'custom', state: 'final', parts: [], coverage: {complete: true, truncated: false, omitted: 0}, communication}]};
}
function query(rows: ReturnType<typeof communicationReferenceRows>, label: string): QualifiedReference {
  const row = rows.find(row => row[0] === label); assert.ok(row?.[2]); return row[2];
}
test('Result and receiving references with equal local numbers retain different public owners', () => {
  const source = carrier(); const rows = communicationReferenceRows(source); const entries = [entry('receiving-card', source)];
  const receiving = query(rows, 'Receiving submission'); const result = query(rows, 'Result 1: Submission ID');
  assert.equal(receiving.text, result.text); assert.equal(receiving.owner, storage); assert.equal(result.owner, producer);
  assert.equal(loadedReference(entries, receiving, undefined, storage), 'receiving-card');
  assert.equal(loadedReference(entries, result, undefined, storage), undefined);
  for (const label of ['Input entry ID', 'Answer entry ID', 'Request ID']) assert.equal(query(rows, `Result 1: ${label}`).owner, producer);
  assert.equal(loadedReference(entries, '1'), undefined); assert.equal(loadedReference(entries, '17'), undefined);
});
test('equal numbers in different conversations and different fields never share a destination', () => {
  const entries = [entry('root-card', carrier()), entry('child-card', carrier(2))];
  assert.equal(loadedReference(entries, {text: '1', owner: storage, field: 'submissionId'}), 'root-card');
  assert.equal(loadedReference(entries, {text: '1', owner: `${storage}:2`, field: 'submissionId'}), 'child-card');
  assert.equal(loadedReference(entries, {text: '1', owner: `${storage}:3`, field: 'submissionId'}), undefined);
  assert.equal(loadedReference(entries, {text: '1', owner: storage, field: 'entryId'}), undefined);
  assert.equal(loadedReference([entry('17', carrier())], {text: '17', owner: producer, field: 'entryId'}, undefined, storage), undefined);
  assert.equal(loadedReference([...entries, entry('duplicate', carrier())], {text: '1', owner: storage, field: 'submissionId'}), undefined);
});
test('reference rendering and click revalidation preserve the same owner and field', () => {
  class Node extends EventTarget {
    className = ''; textContent = ''; title = ''; href = ''; isConnected = true;
    setAttribute(): void {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => new Node()}});
  try {
    const qualified: QualifiedReference = {text: '1', owner: `${storage}:2`, field: 'submissionId'}; const seen: unknown[] = []; let navigated = 0; let current = true;
    const resolver = new ReferenceResolver(value => {seen.push(value); return current ? {destination: {target: {kind: 'agent', identity: `${storage}:2`}, entryId: 'child-card'}} : {reason: 'Not loaded'};}, () => {navigated++;});
    const node = resolver.render(qualified, () => true); node.dispatchEvent(new Event('click', {cancelable: true}));
    assert.deepEqual(seen, [qualified, qualified]); assert.equal(navigated, 1);
    current = false; node.dispatchEvent(new Event('click', {cancelable: true})); assert.equal(navigated, 1); assert.equal(seen[2], qualified);
    const inert = resolver.render(qualified, () => true); assert.equal(inert.className, 'reference-unresolved');
  } finally {if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document');}
});
