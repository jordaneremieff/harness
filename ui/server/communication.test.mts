import assert from 'node:assert/strict';
import test from 'node:test';
import { projectEntry, projectMessage, projectSavedEntry } from './projection.mts';
import { transferFrame } from '../agents/transfer.mts';
import { projectFrame } from './projection.mts';
import type { Communication } from '../shared/api.ts';
import type { ConversationFrame } from '../agents/contract.mts';

const identity = '10000000-0000-4000-8000-000000000001';
const timestamp = 1700000000000;
const value: Communication = {format: 'agent.communication/1', sender: {identity, name: 'Peer'}, body: {text: 'The supplied contribution.', complete: true, redacted: false}, recordedAt: timestamp, kind: 'report', metadata: {sourceId: 'source', requestId: 'request'}};
function native(communication: unknown, model: unknown[] = [{role: 'user', content: 'Original transport content.'}]) {
  return projectEntry({id: '41', kind: 'pi.user', model, communication});
}
function wire(current: unknown = value) {
  return {state: 'ready', recordEntryId: '42', target: {mode: 'input', storageId: identity, conversationId: 1, entryId: '41', submissionId: 7, requestId: 'request'}, value: current};
}
function ordinary(details: unknown, extra: Record<string, unknown> = {}) {
  return projectMessage({role: 'custom', customType: 'agent.peer', content: 'Transport prose is not a contribution source.', details, timestamp, ...extra}, 'message:peer');
}
function report(extra: Record<string, unknown> = {}) { return {kind: 'report', senderIdentity: identity, message: 'Report contribution', requestId: 'request', reportSourceId: 'source', ...extra}; }
function ready(message: ReturnType<typeof projectMessage>) {
  assert.equal(message.communication?.state, 'ready');
  if (message.communication?.state !== 'ready') throw new Error('Expected ready communication');
  return message.communication;
}

test('native association retains exact input and provenance origins without changing source parts', () => {
  const entry = native(wire()); const message = entry.messages?.[0]; assert.ok(message);
  assert.deepEqual(ready(message).origin, {kind: 'native', recordEntryId: '42', target: wire().target});
  assert.deepEqual(ready(message).value, value);
  assert.equal(message.role, 'user'); assert.equal(message.parts[0]?.type, 'text');
  assert.equal((message.parts[0] as {text: string}).text, 'Original transport content.');
});
test('native unresolved and unavailable states remain distinct', () => {
  for (const communication of [{state: 'unresolved'}, {state: 'unavailable', reason: 'invalid'}, {state: 'unavailable', reason: 'limit'}]) assert.deepEqual(native(communication).messages?.[0]?.communication, communication);
});
test('native mismatched links and multi-message attribution refuse the sender', () => {
  assert.equal(native({...wire(), target: {...wire().target, entryId: '40'}}).messages?.[0]?.communication?.state, 'unavailable');
  const entry = native(wire(), [{role: 'user', content: 'first'}, {role: 'user', content: 'second'}]);
  for (const message of entry.messages ?? []) assert.deepEqual(message.communication, {state: 'unavailable', reason: 'invalid'});
});
test('native passive links require the recorded entry and a supplied passive notice', () => {
  const notice = {...value, kind: 'notice', metadata: {threadId: 'thread', passive: true}};
  const communication = {state: 'ready', recordEntryId: '41', target: {mode: 'passive', storageId: identity, conversationId: 1, entryId: '41', requestId: 'notice'}, value: notice};
  const entry = projectEntry({id: '41', kind: 'agent.thread-notice', model: [{role: 'user', content: 'Transport notice'}], communication});
  assert.equal(entry.messages?.[0]?.communication?.state, 'ready');
  assert.equal(native({...communication, recordEntryId: '42'}).messages?.[0]?.communication?.state, 'unavailable');
});
test('ordinary receipts map supplied answer and grouped submission references', () => {
  const message = ordinary({kind: 'receipt', identity, status: 'done', answer: 'Actual answer', answerEntryId: 55, submissions: [{submissionId: 7, requestId: 'a', entryId: 31}, {submissionId: 8, requestId: 'b', entryId: null}]});
  const presented = ready(message); assert.equal(presented.value.kind, 'result'); assert.equal(presented.value.body.text, 'Actual answer');
  if (presented.value.kind === 'result') assert.deepEqual(presented.value.metadata.references, [{submissionId: 7, requestId: 'a', entryId: '31', answerEntryId: '55'}, {submissionId: 8, requestId: 'b', answerEntryId: '55'}]);
  assert.equal(presented.value.body.complete, false);
});
test('ordinary reports use public fields, not prose, role or transport ownership', () => {
  const presented = ready(ordinary(report({deliveryRecipient: 'not-the-source', originalOwnerId: 'not-the-source', wake: true})));
  assert.equal(presented.value.sender.identity, identity); assert.equal(presented.value.body.text, 'Report contribution');
  assert.equal(presented.value.sender.name, undefined); assert.equal(presented.value.kind, 'report');
  assert.equal(presented.origin.kind, 'ordinary-custom'); assert.ok(presented.rawDetails);
});
test('ordinary names use exact source status, never fallback labels', () => {
  assert.equal(ready(ordinary(report({name: 'Exact source name', label: 'Fallback label'}))).value.sender.name, 'Exact source name');
  for (const name of [undefined, 7, '\u0085', 'x'.repeat(161)]) assert.equal(ready(ordinary(report({name, label: 'Fallback label'}))).value.sender.name, undefined);
  assert.equal(ready(ordinary(report({name: ''}))).value.sender.name, '');
});
test('ordinary check-ins retain only supplied request, elapsed time and origin', () => {
  const presented = ready(ordinary(report({checkIn: {requestId: 'producer', elapsedMs: 30000, origin: 'model'}})));
  assert.equal(presented.value.kind, 'check-in');
  if (presented.value.kind === 'check-in') assert.deepEqual(presented.value.metadata, {sourceId: 'source', producerRequestId: 'producer', elapsedMs: 30000, origin: 'model'});
});
test('ordinary thread notices retain contribution and omit unsupported event facts', () => {
  const presented = ready(ordinary(report({threadId: 'thread', threadTitle: 'Thread title', operatorMessage: 'Actual contribution', event: 9, passive: true})));
  assert.equal(presented.value.kind, 'notice'); assert.equal(presented.value.body.text, 'Actual contribution');
  assert.deepEqual(presented.value.metadata, {threadId: 'thread', title: 'Thread title'}); assert.equal(presented.value.body.complete, false);
});
test('ordinary missing facts stay unresolved and contradictory identities are invalid', () => {
  for (const details of [undefined, {kind: 'report'}, report({message: undefined}), report({requestId: undefined})]) assert.deepEqual(ordinary(details).communication, {state: 'unresolved'});
  assert.deepEqual(ordinary(report({identity: '20000000-0000-4000-8000-000000000002'})).communication, {state: 'unavailable', reason: 'invalid'});
  assert.deepEqual(ordinary(report(), {timestamp: undefined}).communication, {state: 'unresolved'});
  assert.deepEqual(ordinary(report(), {timestamp: new Date(timestamp).toISOString()}).communication, {state: 'unavailable', reason: 'invalid'});
});
test('saved and live ordinary messages share values while saved IDs remain exact', () => {
  const details = report(); const saved = projectSavedEntry({id: 'saved-peer', type: 'custom_message', customType: 'agent.peer', content: 'Transport prose', details, display: true, timestamp: new Date(timestamp).toISOString()});
  const message = saved.messages?.[0]; assert.ok(message); assert.deepEqual(ready(message).value, ready(ordinary(details)).value);
  assert.deepEqual(ready(message).origin, {kind: 'ordinary-custom', customType: 'agent.peer', renderEntryId: 'saved-peer:message:0', sourceEntryId: 'saved-peer'});
});
test('hidden ordinary custom messages expose neither carrier nor source body', () => {
  const live = ordinary(report(), {display: false}); assert.equal(live.communication, undefined); assert.deepEqual(live.parts, []);
  const saved = projectSavedEntry({id: 'hidden-peer', type: 'custom_message', customType: 'agent.peer', content: 'Hidden content', details: report(), display: false, timestamp});
  assert.equal(saved.messages?.[0]?.communication, undefined); assert.deepEqual(saved.messages?.[0]?.parts, []);
});
test('redaction and truncation stay explicit and raw details remain protected and bounded', () => {
  const message = ordinary(report({message: 'x'.repeat(20000), textTruncated: true, secret: 'private-value', other: 'y'.repeat(20000)}));
  const presented = ready(message); assert.ok(Buffer.byteLength(presented.value.body.text) <= 16384); assert.equal(presented.value.body.complete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(presented.rawDetails)) <= 8192); assert.ok(Buffer.byteLength(JSON.stringify(presented)) <= 32768);
  assert.doesNotMatch(JSON.stringify(presented.rawDetails), /private-value/); assert.equal(presented.rawDetails?.truncated, true);
  const redacted = ready(ordinary(report({message: 'Bearer abcdefghijklmnopqrstuvwxyz'}))); assert.equal(redacted.value.body.redacted, true); assert.equal(redacted.value.body.complete, false);
});
test('closed native values reject extra facts, malformed bodies and oversized associations', () => {
  assert.deepEqual(native(wire({...value, extra: true})).messages?.[0]?.communication, {state: 'unavailable', reason: 'invalid'});
  assert.deepEqual(native(wire({...value, body: {...value.body, redacted: true}})).messages?.[0]?.communication, {state: 'unavailable', reason: 'invalid'});
  assert.deepEqual(native(wire({...value, body: {...value.body, text: 'x'.repeat(30000)}})).messages?.[0]?.communication, {state: 'unavailable', reason: 'limit'});
});
test('repeated ordinary projection preserves one carrier, raw coverage and source parts', () => {
  const first = projectEntry({id: 'saved-peer', type: 'custom_message', customType: 'agent.peer', content: 'Transport', details: report({secret: 'private-value'}), timestamp});
  const second = projectEntry(first); assert.deepEqual(second, first); assert.equal(second.messages?.length, 1);
});
test('optional native strings accept empty values while C1 controls stay invalid', () => {
  for (const current of [
    {...value, sender: {identity, name: ''}},
    {...value, kind: 'notice', metadata: {threadId: 'thread', title: '', eventKind: ''}},
    {...value, kind: 'result', metadata: {status: 'unanswered', references: [{submissionId: 1}], omittedReferences: 0, reason: ''}}
  ]) assert.equal(native(wire(current)).messages?.[0]?.communication?.state, 'ready');
  for (const current of [{...value, body: {...value.body, text: '\u0085'}}, {...value, metadata: {sourceId: '\u009f', requestId: 'request'}}]) assert.deepEqual(native(wire(current)).messages?.[0]?.communication, {state: 'unavailable', reason: 'invalid'});
});
test('added metadata and nested reference strings use the existing credential protection', () => {
  const secret = 'Bearer abcdefghijklmnopqrstuvwxyz';
  for (const current of [
    {...value, metadata: {sourceId: secret, requestId: secret}},
    {...value, kind: 'notice', metadata: {threadId: 'thread', eventKind: secret}},
    {...value, kind: 'result', metadata: {status: 'done', references: [{submissionId: 1, requestId: secret}], omittedReferences: 0}}
  ]) { const message = native(wire(current)).messages?.[0]; assert.ok(message); const presented = ready(message); assert.doesNotMatch(JSON.stringify(presented), /abcdefghijklmnopqrstuvwxyz/); assert.equal(presented.value.body.redacted, false); }
  const link = wire(); link.target.requestId = secret; assert.deepEqual(native(link).messages?.[0]?.communication, {state: 'unavailable', reason: 'invalid'});
});
test('malformed ordinary values refuse attribution while missing fields remain unresolved', () => {
  for (const details of [report({senderIdentity: `${identity}:1`}), report({message: '\u0085'}), report({requestId: null}), report({checkIn: {origin: 'unknown'}}), {kind: 'receipt', identity, status: 'done', answer: '', submissions: [1]}]) assert.deepEqual(ordinary(details).communication, {state: 'unavailable', reason: 'invalid'});
  const result = ready(ordinary({kind: 'receipt', identity, storageId: identity, conversationId: 1, status: 'unanswered', answer: '', reason: '', answerEntryId: null, submissions: Array.from({length: 18}, (_, at) => ({submissionId: at + 1, entryId: null}))}));
  assert.equal(result.value.kind, 'result'); if (result.value.kind === 'result') { assert.equal(result.value.metadata.references.length, 16); assert.equal(result.value.metadata.omittedReferences, 2); assert.equal(result.value.metadata.reason, ''); }
  assert.deepEqual(ordinary({kind: 'receipt', identity, conversationId: 2, status: 'done', answer: '', submissions: [{submissionId: 1}]}).communication, {state: 'unavailable', reason: 'invalid'});
});
test('adapter display IDs never replace supplied native or saved origin IDs', () => {
  const nativeEntry = projectEntry({id: '41', kind: 'pi.user', model: [{role: 'user', content: 'Transport'}], communication: wire()}, 'adapter-entry');
  const message = nativeEntry.messages?.[0]; assert.ok(message); assert.equal(ready(message).origin.kind, 'native');
  const saved = projectEntry({id: 'original-peer', type: 'custom_message', customType: 'agent.peer', content: 'Transport', details: report(), timestamp}, 'adapter-entry');
  const savedMessage = saved.messages?.[0]; assert.ok(savedMessage); assert.deepEqual(ready(savedMessage).origin, {kind: 'ordinary-custom', customType: 'agent.peer', renderEntryId: 'original-peer:message:0', sourceEntryId: 'original-peer'});
});
test('native associations and retained carriers refuse contradictory frame recipients', () => {
  const entry = {id: '41', kind: 'pi.user', model: [{role: 'user', content: 'Transport'}], communication: wire()};
  const matched = projectFrame({storageId: identity, conversationId: 1, entries: [entry]}).entries[0]; assert.equal(matched?.messages?.[0]?.communication?.state, 'ready');
  for (const frame of [{storageId: '20000000-0000-4000-8000-000000000002', conversationId: 1}, {storageId: identity, conversationId: 2}]) {
    assert.deepEqual(projectFrame({...frame, entries: [entry]}).entries[0]?.messages?.[0]?.communication, {state: 'unavailable', reason: 'invalid'});
    assert.deepEqual(projectFrame({...frame, entries: [matched]}).entries[0]?.messages?.[0]?.communication, {state: 'unavailable', reason: 'invalid'});
  }
});
test('native transfer and repeated frame projection retain the normalized message carrier only', () => {
  const source = {scope: 'conversation', storageId: identity, conversationId: 1, revision: 1, observedAt: new Date(timestamp).toISOString(), entries: [{id: '41', kind: 'pi.user', model: [{role: 'user', content: 'Transport'}], communication: wire()}], live: [], nextBefore: null, status: {identity, busy: false, lastText: '', agent: {}, tasks: [], submissions: []}, coverage: {complete: true, entries: 1, bytes: 2000, hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: false}} as unknown as ConversationFrame;
  const transferred = transferFrame(source), display = projectFrame(transferred);
  assert.equal(display.entries.length, 1); assert.equal(display.entries[0]?.messages?.length, 1);
  assert.equal(display.entries[0]?.messages?.[0]?.communication?.state, 'ready');
  assert.equal(Object.hasOwn(display.entries[0] ?? {}, 'communication'), false);
});
