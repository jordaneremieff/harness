import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogPage, CatalogRow } from '../agents/index.mts';
import { decodePublication } from '../agents/contract.mts';
import type { Publication, Summary } from '../agents/contract.mts';
import { jsonDisplay, projectEntry, projectFrame, projectJson, projectMessage, projectRoster, projectSavedEntry, protectedTextPage, safeText } from './projection.mts';

import type { MessageView, PartView } from '../shared/api.ts';
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function resultText(message: MessageView | undefined): Extract<PartView, {type: 'text'}> {
  const result = message?.parts.find(part => part.type === 'toolResult'); assert.ok(result?.type === 'toolResult');
  const text = result.parts.find(part => part.type === 'text'); assert.ok(text?.type === 'text'); return text;
}
const retainedResult = (text: string) => ({type: 'message', id: 'result', parentId: null,
  message: {role: 'toolResult', toolCallId: 'call', toolName: 'generic', content: [{type: 'text', text}]}});

test('saved structured documents derive from complete text before the raw preview', () => {
  const document = `# Document\n${'A useful paragraph with "quotes".\n'.repeat(300)}`;
  const text = JSON.stringify({document}); assert.ok(Buffer.byteLength(text) > 8192);
  const part = resultText(projectSavedEntry(retainedResult(text)).messages?.[0]);
  assert.ok(part.structured); assert.equal((part.structured.value as {document: string}).document, document);
  assert.equal(part.structured?.truncated, false);
  assert.equal(part.text, protectedTextPage(text, 0).text);
  assert.throws(() => JSON.parse(part.text), SyntaxError);
  assert.equal(part.more?.offset, Buffer.byteLength(part.text));
  assert.ok(bytes(part.structured) <= 16 * 1024);
});
test('complete JSON lines preserve grouped prose, blank lines and malformed lines in source order', () => {
  const text = ['lead', '', '{"body":"# One"}', 'between', '{"broken":', '{"body":"# Two"}', 'tail', ''].join('\n');
  const part = resultText(projectSavedEntry(retainedResult(text)).messages?.[0]); assert.ok(part.structured);
  assert.ok(JSON.stringify(part.structured.value) === JSON.stringify(['lead\n', {body: '# One'}, 'between\n{"broken":', {body: '# Two'}, 'tail\n']));
  assert.equal(part.structured.truncated, false); assert.equal(part.text, text); assert.equal(part.more, undefined);
  const pure = resultText(projectMessage(retainedResult('{"status":"one"}\n{"status":"two"}').message, 'lines'));
  assert.ok(pure.structured); assert.equal((pure.structured.value as {status: string}[])[1]?.status, 'two');
});
test('line, root and complete-input limits fall back to existing protected raw text', () => {
  const sources = [Array(129).fill('{"status":"row"}').join('\n'), `${'prose\n'.repeat(512)}{"body":"last"}`,
    `{"body":"first"}\n${' '.repeat(128 * 1024)}`];
  for (const text of sources) {
    const part = resultText(projectSavedEntry(retainedResult(text)).messages?.[0]);
    assert.equal(part.structured, undefined); assert.equal(part.text, protectedTextPage(text, 0).text);
  }
});
test('failed whole parse, complete lines and nested decode debit one aggregate parse allowance', () => {
  const nested = JSON.stringify({document: '# Parsed', id: '2026'});
  const lines = [JSON.stringify({body: nested}), JSON.stringify({status: 'done'})], text = lines.join('\n');
  const expected = Buffer.byteLength(text) + lines.reduce((total, line) => total + Buffer.byteLength(line), 0) + Buffer.byteLength(nested);
  const budget = {input: 128 * 1024, output: 16 * 1024, nodes: 0};
  const part = resultText(projectMessage(retainedResult(text).message, 'budget', 'final', undefined, {budget}));
  assert.ok(part.structured); assert.equal(budget.input, 128 * 1024 - expected); assert.ok(budget.nodes <= 2048);
  assert.equal((part.structured.value as {body: {id: string}}[])[0]?.body.id, '2026');
  const limited = resultText(projectMessage(retainedResult(text).message, 'limited', 'final', undefined,
    {budget: {input: expected - 1, output: 16 * 1024, nodes: 0}}));
  assert.equal(limited.structured?.truncated, true); assert.equal(limited.text, text);
  const tooSmall = resultText(projectMessage(retainedResult(text).message, 'too-small', 'final', undefined,
    {budget: {input: Buffer.byteLength(text), output: 16 * 1024, nodes: 0}}));
  assert.equal(tooSmall.structured, undefined); assert.equal(tooSmall.text, text);
});
test('decoded public redacted text and thinking records withhold every content field', () => {
  for (const record of [{type: 'thinking', redacted: true, thinking: 'withheld-thought'},
    {type: 'thinking', redacted: true, text: 'withheld-alias'}, {type: 'text', redacted: true, text: 'withheld-text'}]) {
    const value = {body: [JSON.stringify(record)], document: '# Public\nVisible content'};
    const part = resultText(projectSavedEntry(retainedResult(JSON.stringify(value))).messages?.[0]);
    assert.ok(part.structured); assert.equal(part.structured.truncated, true);
    assert.doesNotMatch(JSON.stringify(part.structured), /withheld-/); assert.match(JSON.stringify(part.structured), /Visible content/);
    const trusted = resultText(projectMessage({role: 'toolResult', content: [{type: 'text', text: 'plain',
      structured: {value, truncated: false}}]}, 'trusted', 'final', undefined, {trustedStructured: true}));
    assert.doesNotMatch(JSON.stringify(trusted.structured), /withheld-/); assert.equal(trusted.structured?.truncated, true);
  }
});
test('large metadata, coverage and limits precede body in source but cannot spend its display budget', () => {
  const document = `# Important\n${'Useful paragraph\n'.repeat(350)}`;
  for (const field of ['metadata', 'coverage', 'limits']) {
    const text = JSON.stringify({[field]: Array(3000).fill({label: 'transport'}), body: document});
    const part = resultText(projectSavedEntry(retainedResult(text)).messages?.[0]); assert.ok(part.structured);
    assert.ok((part.structured.value as {body: string}).body === document);
    assert.equal(part.structured.truncated, true); assert.ok(bytes(part.structured) <= 16 * 1024);
  }
});
test('protection changes in mixed segments set truncation without changing raw page identity', () => {
  const text = 'Bearer private-token\n{"body":"visible"}\n{"body":"second"}';
  const part = resultText(projectSavedEntry(retainedResult(text)).messages?.[0]); assert.ok(part.structured);
  assert.equal(part.structured.truncated, true); assert.doesNotMatch(JSON.stringify(part.structured), /private-token/);
  assert.equal(part.text, protectedTextPage(text, 0).text);
});
test('nested complete JSON decodes before protection without changing raw Unicode offsets', () => {
  const document = `# Nested\n${'雪と文書 "quoted"\n'.repeat(350)}`;
  const text = JSON.stringify({body: JSON.stringify({document, api_key: 'private-value', signature: 'private-signature',
    picture: JSON.stringify({type: 'image', data: 'private-image'}), authorization: 'Bearer private-authorization'})});
  const entry = projectSavedEntry(retainedResult(text)), part = resultText(entry.messages?.[0]);
  assert.ok(part.structured); assert.equal(((part.structured.value as {body: {document: string}}).body).document, document);
  assert.doesNotMatch(JSON.stringify(part.structured), /private-value|private-signature|private-image|private-authorization/);
  assert.equal(part.structured?.truncated, true);
  let raw = part.text, offset = part.more?.offset ?? null;
  while (offset !== null) { const page = protectedTextPage(text, offset); raw += page.text; offset = page.nextOffset; }
  assert.equal(raw, safeText(text, Number.MAX_SAFE_INTEGER)); assert.doesNotMatch(raw, /\ufffd/);
});
test('native sidecars are ignored and trusted UI sidecars are reprotected', () => {
  const raw = {role: 'toolResult', toolCallId: 'c', toolName: 'generic', content: [{type: 'text', text: 'plain',
    structured: {value: JSON.stringify({body: 'document', password: 'hidden-password', type: 'record', image: 'hidden-image'}), truncated: false}}]};
  assert.equal(resultText(projectMessage(raw, 'native')).structured, undefined);
  const trusted = resultText(projectMessage(raw, 'trusted', 'final', undefined, {trustedStructured: true}));
  assert.ok(trusted.structured); assert.equal((trusted.structured.value as {body: string}).body, 'document');
  assert.doesNotMatch(JSON.stringify(trusted.structured), /hidden-password|hidden-image/);
  assert.equal(trusted.structured?.truncated, true);
  const source = projectSavedEntry(retainedResult(JSON.stringify({body: `# Document\n${'text\n'.repeat(2000)}`})));
  const repeated = projectEntry(source, source.id, {trustedStructured: true});
  assert.deepEqual(resultText(repeated.messages?.[0]).more, resultText(source.messages?.[0]).more);
  assert.ok(resultText(repeated.messages?.[0]).structured);
  const prefix = {role: 'toolResult', coverage: {truncated: true}, content: [{type: 'text', text: '{"status":"prefix"}'}]};
  assert.equal(resultText(projectMessage(prefix, 'prefix', 'final', undefined, {trustedStructured: true})).structured, undefined);
});
test('malformed, over-input-budget and explicitly truncated source has no fabricated structure', () => {
  for (const text of ['{"body":"incomplete', JSON.stringify({body: 'long'.repeat(100)})]) {
    const part = resultText(projectMessage(retainedResult(text).message, 'bounded', 'final', undefined,
      {budget: {input: 64, output: 16 * 1024, nodes: 0}}));
    assert.equal(part.structured, undefined); assert.equal(part.text, text);
  }
  const source = {...retainedResult('{"status":"partial"}').message, coverage: {truncated: true}};
  assert.equal(resultText(projectMessage(source, 'partial')).structured, undefined);
});
test('document and record fields get budgets before earlier usage and provenance', () => {
  const text = JSON.stringify({usage: Array(3000).fill({tokens: 1}), provenance: 'transport'.repeat(1000),
    body: '# Important\nUseful document', records: [{name: 'row', content: 'useful record'}], status: 'done'});
  const part = resultText(projectSavedEntry(retainedResult(text)).messages?.[0]);
  const value = part.structured?.value as {body: string; records: unknown[]};
  assert.equal(value.body, '# Important\nUseful document'); assert.equal(value.records.length, 1);
  assert.equal(part.structured?.truncated, true); assert.ok(bytes(part.structured) <= 16 * 1024);
});
test('useful records receive projection budgets before query arrays and scan machinery', () => {
  const raw = JSON.stringify({query: Array(3000).fill('repeated selection terms'), scan: {visited: 3000, complete: true},
    consistency: 'Scope notes '.repeat(500), representation: 'Offset notes '.repeat(500), matches: [{title: 'Useful record', body: '# Useful document\nReadable prose'}]});
  const part = resultText(projectSavedEntry(retainedResult(raw)).messages?.[0]);
  const value = part.structured?.value as {matches: {title: string; body: string}[]};
  assert.equal(value.matches[0]?.title, 'Useful record'); assert.equal(value.matches[0]?.body, '# Useful document\nReadable prose');
  assert.equal(part.structured?.truncated, true); assert.ok(bytes(part.structured) <= 16 * 1024);
  assert.equal(part.text, protectedTextPage(raw, 0).text);
});

test('payload parts receive structured budgets before metadata-only parts', () => {
  const entry = projectSavedEntry({id: 'parts', type: 'message', message: {role: 'toolResult', toolCallId: 'c', toolName: 'generic', content: [
    {type: 'text', text: JSON.stringify({usage: Array(3000).fill({tokens: 1})})},
    {type: 'text', text: JSON.stringify({body: '# Useful\nBody before metadata budget'})}]}});
  const result = entry.messages?.[0]?.parts[0]; assert.ok(result?.type === 'toolResult');
  const document = result.parts[1]; assert.ok(document?.type === 'text'); assert.ok(document.structured);
  assert.equal((document.structured.value as {body: string}).body, '# Useful\nBody before metadata budget');
});
test('native retained tool results receive safe generic sidecars without a host change', () => {
  const native = projectFrame({entries: [retainedResult(JSON.stringify({records: [{status: 'done', id: 'short'}]}))]});
  const part = resultText(native.entries[0]?.messages?.[0]); assert.ok(part.structured);
  assert.equal((part.structured.value as {records: {status: string}[]}).records[0]?.status, 'done');
  const forged = projectFrame({entries: [{...retainedResult('plain'), message: {...retainedResult('plain').message,
    content: [{type: 'text', text: 'plain', structured: {value: {body: 'forged'}, truncated: false}}]}}]});
  assert.equal(resultText(forged.entries[0]?.messages?.[0]).structured, undefined);
});
test('structured depth, nodes and multiple-part output share bounded budgets', () => {
  let nested: unknown = {body: 'leaf'}; for (let depth = 0; depth < 20; depth++) nested = {body: nested};
  const source = {role: 'toolResult', toolCallId: 'c', toolName: 'generic', content: [
    {type: 'text', text: JSON.stringify(nested)}, {type: 'text', text: JSON.stringify({records: Array(5000).fill('value')})},
    {type: 'text', text: JSON.stringify({body: 'document'.repeat(1500)})}]};
  const message = projectSavedEntry({type: 'message', id: 'bounded', message: source}).messages?.[0]; assert.ok(message);
  const result = message.parts[0]; assert.ok(result?.type === 'toolResult');
  const sidecars = result.parts.flatMap(part => part.type === 'text' && part.structured ? [part.structured] : []);
  assert.ok(sidecars.some(sidecar => sidecar.truncated));
  assert.ok(sidecars.reduce((total, sidecar) => total + bytes(sidecar), 0) <= 16 * 1024);
  assert.ok(bytes(message) <= 60 * 1024);
});
test('sidecars preserve ordinary raw text and cannot sacrifice a multi-message entry', () => {
  const text = JSON.stringify({body: 'document'.repeat(3000)});
  const message = projectMessage(retainedResult(text).message, 'live');
  assert.equal(resultText(message).text, text); assert.ok(resultText(message).text.length > 8192);
  const raw = {id: 'multiple', type: 'message', messages: [retainedResult(text).message, retainedResult(text).message]};
  const entry = projectEntry(raw); assert.equal(entry.messages?.length, 2);
  assert.equal(resultText(entry.messages?.[0]).text, text); assert.equal(resultText(entry.messages?.[1]).text, text);
  assert.ok(bytes(entry) <= 60 * 1024);
});

test('safe text preserves ordinary prose, strips terminal escapes, redacts credentials, and truncates on Unicode boundaries', () => {
  assert.equal(safeText('\x1b[31mordinary\x1b[0m\ttext\n'), 'ordinary\ttext\n');
  assert.equal(safeText('\x1b]title\x1b\\between\x1b]title2\x1b\\'), 'between');
  assert.equal(safeText('long content', 0), '');
  assert.equal(safeText('secret recipe, token budget, https://example.test/'), 'secret recipe, token budget, https://example.test/');
  assert.doesNotMatch(safeText(`Bearer a-secret-token https://user:password@example.test/ sk-${'a'.repeat(24)}`), /a-secret-token|password|sk-/);
  const text = safeText('😀'.repeat(100_000), 1024); assert.ok(Buffer.byteLength(text) <= 1024); assert.doesNotMatch(text, /\ufffd/); assert.match(text, /truncated/);
});

test('structured string and key cuts end in budgeted ellipses without marking complete host strings or changing raw pages', () => {
  const body = '😀 useful prose '.repeat(2000); const source = {body};
  for (const cap of [512, 2048]) {
    const display = projectJson(source, cap); const shown = (display.value as {body: string}).body;
    assert.equal(display.truncated, true); assert.ok(shown.endsWith('…')); assert.equal(Buffer.from(shown).toString('utf8'), shown);
    assert.ok(bytes(display.value) <= cap); assert.equal(source.body, body);
  }
  const key = 'longSegment'.repeat(40); const keyed = projectJson({[key]: 'value'});
  const shownKey = Object.keys(keyed.value as object)[0]; assert.ok(shownKey?.endsWith('…'));
  assert.ok(Buffer.byteLength(shownKey) <= 256); assert.equal(keyed.truncated, true);
  const complete = 'A complete host string'; const protectedValue = projectJson({body: complete, password: 'private-value'});
  assert.equal(protectedValue.truncated, true); assert.equal((protectedValue.value as {body: string}).body, complete);
  const marker = 'A literal host marker\n[truncated]'; assert.equal((projectJson({body: marker}).value as {body: string}).body, marker);
  const raw = JSON.stringify({body}); const part = resultText(projectSavedEntry(retainedResult(raw)).messages?.[0]);
  assert.ok(part.structured); assert.ok((part.structured.value as {body: string}).body.endsWith('…'));
  assert.equal(part.text, protectedTextPage(raw, 0).text); assert.equal(raw, JSON.stringify(source));
  assert.ok(bytes(part.structured) <= 16 * 1024);
});

test('JSON projection bounds depth, nodes and bytes, omits secrets/signatures/images, and does not throw on malformed values', () => {
  const source: Record<string, unknown> = {text: 'normal', signature: 'provider-secret', apiKey: 'credential', image: {data: 'base64'}, password: 'hidden'};
  source.circular = source;
  const projected = projectJson(source); assert.equal(projected.truncated, true);
  assert.doesNotMatch(JSON.stringify(projected), /provider-secret|credential|base64|hidden/);
  assert.equal(jsonDisplay, projectJson);
  assert.equal(projectJson({data: Array(5000).fill('value')}).truncated, true);
  let nested: unknown = 'leaf'; for (let index = 0; index < 20; index++) nested = {nested};
  assert.equal(projectJson(nested).truncated, true);
  assert.ok(bytes(projectJson('x'.repeat(100_000))) < 65536);
  const broken = Object.defineProperty({}, 'bad', {enumerable: true, get: () => { throw new Error('bad getter'); }});
  assert.match(String(projectJson(broken).value), /malformed/);
  assert.equal(projectJson(1n).truncated, true);
});

test('messages preserve text-first content, tool joins and partial/final IDs through repeated projection', () => {
  const raw = {role: 'assistant', timestamp: 42, content: [
    {type: 'text', text: 'hello'}, {type: 'thinking', thinking: 'consider'},
    {type: 'toolCall', id: 'call-1', name: 'read', arguments: {path: 'file', api_key: 'private'}},
    {type: 'image', data: 'private-payload'}, {type: 'thinking', thinking: 'hidden-thought', redacted: true},
  ]};
  const message = projectMessage(raw, 'message-1', 'partial');
  assert.equal(message.id, 'message-1'); assert.equal(message.state, 'partial'); assert.equal(message.timestamp, 42);
  assert.doesNotMatch(JSON.stringify(message), /private-payload|hidden-thought|private"/);
  assert.equal(message.coverage.truncated, true);
  const repeated = projectMessage(message, message.id, 'final'); assert.equal(repeated.parts[0]?.type, 'text');
  assert.equal((repeated.parts[0] as {text: string}).text, 'hello');
  const result = projectMessage({role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: true, content: [{type: 'text', text: 'failure'}]}, 'result-1');
  assert.equal(result.parts[0]?.type, 'toolResult');
  assert.equal((projectMessage(result, result.id).parts[0] as {parts: {text: string}[]}).parts[0]?.text, 'failure');
  const huge = projectMessage({role: 'assistant', content: [{type: 'text', text: '\n'.repeat(100_000)}]}, 'huge');
  assert.ok(bytes(huge) < 65536); assert.equal(huge.coverage.truncated, true);
});

test('assistant usage events and final projection retain only exact cache fields', () => {
  // Inline fixtures of the host JSON-event shapes: a usage update carries no message replay, and message_end replays the final message.
  const usage = {input: 10, output: 12, cacheRead: 30, cacheWrite: 20, totalTokens: 72, cost: {input: 0, output: 1, cacheRead: 0, cacheWrite: 0, total: 1}};
  const message = {role: 'assistant' as const, api: 'openai-responses' as const, provider: 'fixture', model: 'fixture', stopReason: 'stop' as const,
    timestamp: 42, usage, content: [{type: 'text' as const, text: 'final'}]};
  const update = {type: 'message_update' as const, usage};
  assert.deepEqual(update.usage, usage); assert.equal('message' in update, false);
  const end = {type: 'message_end' as const, message}; assert.ok(end.type === 'message_end'); assert.equal(end.message, message);
  const projected = projectMessage(end.message, 'turn'); assert.deepEqual(projected.usage, {input: 10, cacheRead: 30, cacheWrite: 20});
  assert.deepEqual(projectMessage(projected, 'turn'), projected); assert.equal(projectMessage({...message, role: 'toolResult'}, 'tool').usage, undefined);
  assert.equal(projectMessage({...message, usage: undefined}, 'absent').usage, undefined);
  for (const malformed of [{...usage, input: -1}, {...usage, cacheRead: Infinity}, {...usage, cacheWrite: '20'}, {...usage, input: 0.5}, {input: 1}, null]) assert.equal(projectMessage({...message, usage: malformed}, 'bad').usage, undefined);
});
test('saved/native image metadata preserves original indices without bytes and live images have no invented source', () => {
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const image = {type: 'image', mimeType: 'image/png', data};
  const raw = {id: 'saved', type: 'message', message: {role: 'toolResult', toolCallId: 'read', toolName: 'read', content: [{type: 'text', text: 'caption'}, image]}};
  const saved = projectSavedEntry(raw); const result = saved.messages?.[0]?.parts[0]; assert.ok(result?.type === 'toolResult');
  const part = result.parts[1]; assert.ok(part?.type === 'image'); assert.deepEqual(part.source, {entryId: 'saved', message: 0, part: 1});
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(data)); assert.deepEqual(projectEntry(saved), saved);
  const native = projectFrame({entries: [{id: 12, kind: 'message', model: [{role: 'user', content: [image]}]}], live: [{id: 13, kind: 'message', model: [{role: 'user', content: [image]}]}], coverage: {complete: true}});
  const committed = native.entries[0]?.messages?.[0]?.parts[0]; const live = native.live[0]?.messages?.[0]?.parts[0];
  assert.ok(committed?.type === 'image' && live?.type === 'image'); assert.deepEqual(committed.source, {entryId: '12', message: 0, part: 0}); assert.equal(live.source, undefined);
  const rpc = projectMessage(raw.message, 'rpc'); assert.ok(rpc.parts[0]?.type === 'toolResult'); const rpcImage = rpc.parts[0].parts[1]; assert.ok(rpcImage?.type === 'image'); assert.equal(rpcImage.source, undefined);
});
test('generic typed image objects never expose data while ordinary data keys remain displayable', () => {
  const payload = 'a'.repeat(4000); const projected = projectJson({nested: [{type: 'image', mimeType: 'image/png', data: payload}], ordinary: {data: 'ordinary public data'}});
  assert.equal(projected.truncated, true); assert.equal(JSON.stringify(projected).includes(payload), false);
  assert.match(JSON.stringify(projected), /Image data omitted/); assert.match(JSON.stringify(projected), /ordinary public data/);
});
test('entry projections retain known IDs and bounded custom values without private format interpretation', () => {
  const entry = projectEntry({id: 4, kind: 'custom', data: {title: '<script>bad()</script>', payload: 'x'.repeat(100_000)}});
  assert.equal(entry.id, '4'); assert.equal(entry.kind, 'custom'); assert.equal(entry.data?.truncated, true); assert.ok(bytes(entry) < 65536);
  const original = projectEntry({id: 'entry-1', kind: 'model', model: [{role: 'assistant', content: 'retained text'}]});
  assert.equal((projectEntry(original).messages?.[0]?.parts[0] as {text: string} | undefined)?.text, 'retained text');
  const malformed = Object.defineProperty({}, 'id', {get: () => { throw new Error('bad getter'); }});
  assert.equal(projectEntry(malformed, 'known-id').id, 'known-id');
  assert.equal(projectMessage(malformed, 'known-message').coverage.truncated, true);
});

test('public custom types become entry headings without private data interpretation', () => {
  for (const type of ['custom', 'custom_message']) {
    const entry = projectEntry({id: 'custom-id', type, customType: '<public-type>', content: 'shown', display: true, data: {customType: 'not-the-heading'}});
    assert.equal(entry.head, '<public-type>'); assert.equal(projectEntry(entry).head, '<public-type>');
  }
  const unfamiliar = projectEntry({id: 'unknown', type: 'unfamiliar', customType: 'not-public-custom', data: {text: 'data'}});
  assert.equal(unfamiliar.head, undefined);
  assert.equal(projectEntry({type: 'custom', data: {customType: 'nested-only'}}).head, undefined);
});
test('hidden public custom messages never expose content or details across projection paths', () => {
  const raw = {role: 'custom', customType: 'public-type', display: false, content: 'hidden policy text', details: {snapshot: 'hidden detail'}};
  const message = projectMessage(raw, 'hidden'); assert.deepEqual(message.parts, []); assert.equal(message.coverage.complete, true);
  assert.deepEqual(projectMessage(message, 'hidden').parts, []);
  const entry = projectEntry({id: 'hidden-entry', type: 'custom_message', ...raw});
  assert.equal(entry.head, 'public-type'); assert.equal(entry.data, undefined); assert.deepEqual(entry.messages?.[0]?.parts, []);
  const envelope = projectEntry({id: 'message-entry', type: 'message', message: raw});
  const frame = projectFrame({entries: [entry, envelope], live: [{type: 'message', message: raw}], coverage: {complete: true}});
  assert.doesNotMatch(JSON.stringify([message, entry, projectEntry(entry), envelope, frame]), /hidden policy text|hidden detail|snapshot/);
  assert.equal(projectMessage({...raw, display: true}, 'shown').parts[0]?.type, 'text');
  assert.equal(projectMessage({...raw, role: 'assistant'}, 'other-role').parts[0]?.type, 'text');
  assert.equal(projectMessage({...raw, errorMessage: 'reported failure'}, 'error').error, 'reported failure');
});

test('nested native tools project as tasks without model messages or invented timing', () => {
  const nestedTool = {callId: 'parent/child', name: 'read', taskId: 3, parentTaskId: 2, parentCallId: 'parent',
    arguments: {path: 'notes.md', password: 'private-argument'}, status: 'running', output: 'partial output', droppedLines: 2};
  const live = {id: 'live:tool:parent/child', kind: 'pi.tool-result', data: {live: true, nestedTool}};
  const frame = projectFrame({live: [live], entries: [], status: {busy: true}, coverage: {complete: true}});
  const entry = frame.live[0]; assert.ok(entry?.tool);
  assert.equal(entry.messages, undefined); assert.equal(entry.tool.status, 'running'); assert.equal(entry.tool.parentCallId, 'parent');
  assert.equal(entry.tool.taskId, 3); assert.equal(entry.tool.parentTaskId, 2); assert.equal(entry.tool.durationMs, undefined);
  assert.equal(entry.tool.isError, undefined); assert.equal(entry.tool.output?.truncation?.truncated, true);
  assert.deepEqual(entry.tool.parts, [{type: 'text', text: 'partial output'}]); assert.equal(frame.coverage.truncated, true);
  assert.doesNotMatch(JSON.stringify(frame), /private-argument|timestamp|observedStart/);
  const done = projectEntry({...live, data: {live: true, nestedTool: {...nestedTool, status: 'done', summary: {isError: true, durationMs: 0, error: 'failed'}}}});
  assert.equal(done.tool?.isError, true); assert.equal(done.tool?.durationMs, 0); assert.equal(done.tool?.status, 'done');
  const unknown = projectEntry({...live, data: {live: true, nestedTool: {...nestedTool, status: 'done'}}}); assert.equal(unknown.tool?.isError, undefined);
  const malformed = projectEntry({...live, data: {live: true, nestedTool: {...nestedTool, taskId: 0}}}); assert.equal(malformed.tool, undefined);
  const large = projectEntry({...live, data: {live: true, nestedTool: {...nestedTool, output: 'x'.repeat(100_000)}}}); assert.ok(bytes(large) <= 60 * 1024);
  assert.ok(large.tool); assert.equal(large.tool.coverage.truncated, true);
  assert.deepEqual(projectEntry(entry), entry); assert.deepEqual(projectEntry(large), large);
});
test('compaction state preserves retries and absent failure timestamps under display bounds', () => {
  const compactions = [{taskId: 4, reason: 'threshold', blocking: true, attempt: 1, retry: {at: 2000, error: 'retry'}}];
  const compactionFailure = {taskId: 5, reason: 'manual', error: 'Bearer private-token'};
  const frame = projectFrame({entries: [], live: [], status: {busy: true, live: {compactions, compactionFailure}}, coverage: {complete: true}});
  assert.deepEqual(JSON.parse(JSON.stringify(frame.status.compactions?.value)), compactions);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.status.compactionFailure?.value)), {taskId: 5, reason: 'manual', error: 'Bearer [redacted]'});
  assert.equal(Object.hasOwn(frame.status.compactionFailure?.value as object, 'at'), false);
  const next = projectFrame({entries: [], live: [], status: {busy: false, live: {}}, coverage: {complete: true}});
  assert.equal(next.status.compactions, undefined); assert.equal(next.status.compactionFailure, undefined);
  const bounded = projectFrame({status: {live: {compactions: Array(500).fill({...compactions[0], retry: {at: 1, error: 'x'.repeat(20000)}})}}});
  assert.ok(bytes(bounded.status.compactions) < 8300); assert.equal(bounded.status.compactions?.truncated, true);
  assert.equal(bounded.coverage.truncated, true); assert.equal(bounded.coverage.complete, false);
});
test('native execution channels do not replace the public model message content', () => {
  const entry = projectEntry({id: '8', kind: 'pi.tool-result', model: [{role: 'toolResult', toolCallId: 'call', toolName: 'custom',
    content: [{type: 'text', text: 'model output'}], isError: false, timestamp: 12}], data: {diagnostics: []}});
  assert.equal(resultText(entry.messages?.[0]).text, 'model output');
  const direct = projectMessage({role: 'toolResult', toolCallId: 'call', toolName: 'custom',
    output: [{type: 'text', text: 'execution-only output'}], structuredOutput: {secret: 'program-only result'}}, 'unsupported');
  assert.doesNotMatch(JSON.stringify(direct), /execution-only|program-only/);
});

test('native frames whitelist status, bound oversized entries, and retain partial output separately', () => {
  const frame = projectFrame({revision: 12, observedAt: 'now', entries: Array.from({length: 1000}, (_, index) => ({id: String(index), kind: 'custom', data: {text: 'x'.repeat(20_000)}})),
    live: [{id: 'live:1', kind: 'model', model: [{role: 'assistant', content: 'stream text'}]}], nextBefore: 2,
    status: {busy: true, agent: {model: {provider: 'p', modelId: 'm', headers: {apiKey: 'no'}}, thinkingLevel: 'high', instructions: 'never disclose'}, inbox: 'private inbox', tasks: [{id: 1, kind: 'task', status: 'done', opaque: 'private data'}]}, coverage: {complete: true}});
  assert.equal(frame.revision, 12); assert.equal(frame.nextBefore, 2); assert.equal(frame.status.model?.modelId, 'm');
  assert.equal(frame.live[0]?.messages?.[0]?.state, 'partial'); assert.ok(frame.entries.length < 1000);
  assert.equal(frame.coverage.complete, false); assert.ok(frame.coverage.omitted > 0); assert.ok(bytes(frame) < 256 * 1024);
  assert.doesNotMatch(JSON.stringify(frame), /never disclose|private inbox|private data|apiKey/);
  assert.equal(projectFrame(null).coverage.complete, false);
});

test('roster projection preserves coverage and capabilities without raw catalog details', () => {
  const roster = projectRoster({rows: [{identity: 'storage:1', storageId: 'storage', cwd: '/project', modifiedAt: 1, state: 'working', owner: 'here', availability: 'live', partial: false, name: '<b>Name</b>', databasePath: '/private/database', model: {provider: 'p', modelId: 'm', apiKey: 'private'}, capabilities: {input: true, observe: true}}], stale: false, scan: {state: 'ready', complete: true, visited: 1, skipped: 0, omitted: 0}});
  const cursor = projectRoster({rows: roster.rows, nextCursor: 'cached-page-cursor', scan: {complete: false}});
  assert.equal(cursor.nextCursor, 'cached-page-cursor'); assert.equal(cursor.scan.complete, false);
  assert.equal(projectRoster({rows: [], nextCursor: null}).nextCursor, null);
  const invalidCursor = projectRoster({rows: [], nextCursor: 'x'.repeat(4097), scan: {complete: true}});
  assert.equal(invalidCursor.nextCursor, null); assert.equal(invalidCursor.error?.code, 'protocol_error');
  assert.equal(roster.rows[0]?.capabilities?.input, true); assert.equal(roster.scan.complete, true); assert.equal(roster.stale, false);
  assert.doesNotMatch(JSON.stringify(roster), /databasePath|apiKey/);
  const partial = projectRoster({rows: [{identity: 1}], scan: {complete: true}}); assert.equal(partial.scan.complete, false); assert.equal(partial.scan.omitted, 1);
  const failed = projectRoster({rows: [], scan: {state: 'failed', complete: false, error: 'Catalog worker failed'}});
  assert.equal(failed.error?.message, 'Catalog worker failed'); assert.equal(failed.error?.retry, 'read');
  assert.equal(projectRoster({rows: [], scan: {state: 'ready', complete: true, error: 'stale text'}}).error, undefined);
});

test('safe omission parts and prior coverage remain stable through repeated message and entry projection', () => {
  const fixtures = [
    {role: 'assistant', content: [{type: 'thinking', thinking: 'hidden', redacted: true}, {type: 'image', data: 'hidden image'}]},
    {role: 'toolResult', toolCallId: 'call-image', toolName: 'read', content: [{type: 'image', data: 'hidden image'}]},
    {role: 'assistant', content: [{type: 'unsupported', data: 'hidden content'}]},
    {role: 'assistant', content: Array.from({length: 100}, () => ({type: 'unsupported'}))},
    {role: 'assistant', content: [{type: 'text', text: 'x'.repeat(100_000)}, {type: 'image', data: 'hidden image'}]},
  ];
  for (const [index, raw] of fixtures.entries()) {
    const original = projectMessage(raw, `message-${index}`);
    assert.equal(original.coverage.omitted, index === 3 ? 100 : 1);
    assert.deepEqual(projectMessage(original, original.id), original);
    assert.deepEqual(projectMessage(projectMessage(original, original.id), original.id), original);
    const entry = projectEntry({id: String(index), kind: 'model', model: [raw]});
    assert.deepEqual(projectEntry(entry), entry);
  }
  const prior = projectMessage(fixtures[0], 'prior'); prior.coverage.reason = 'Output omitted by host';
  assert.deepEqual(projectMessage(prior, prior.id).coverage, prior.coverage);
});

const catalogStorage = '00000000-0000-4000-8000-000000000001';
const catalogStamp = '2026-10-08T00:00:00.000Z';
const catalogSummary: Summary = {
  id: catalogStorage, storageId: catalogStorage, cwd: '/fixture-project', modifiedAt: Date.parse(catalogStamp),
  owner: 'here', state: 'working', cost: 0, partial: false, name: 'Fixture agent',
  model: {provider: 'fixture-provider', modelId: 'fixture-model', thinkingLevel: 'high'},
  currentTool: {name: 'read', argument: 'fixture.txt'}, latestReply: 'Last reply', firstMessage: 'First input',
  creatingOwnerId: 'not-exposed-owner', profile: {secret: 'not-exposed-profile'},
};

test('current CatalogRow IDs map to safe AgentRow metadata without granting host capabilities', () => {
  const row: CatalogRow = {...catalogSummary, claim: 'live', publishedAt: catalogStamp};
  const roster = projectRoster({rows: [row]});
  assert.equal(roster.rows.length, 1); assert.equal(roster.scan.omitted, 0);
  const selectedAgent = projectRoster({rows: [row]}).rows[0];
  assert.deepEqual(selectedAgent, {
    identity: row.id, storageId: row.storageId, cwd: row.cwd, modifiedAt: row.modifiedAt,
    owner: 'here', state: 'working', availability: 'live', partial: false,
    name: row.name, model: row.model, thinkingLevel: 'high', currentTool: row.currentTool,
    latestReply: row.latestReply, firstMessage: row.firstMessage, observedAt: catalogStamp,
  });
  assert.equal(selectedAgent?.capabilities, undefined);
  assert.doesNotMatch(JSON.stringify(selectedAgent), /not-exposed|creatingOwnerId|profile|publishedAt|claim|cost/);
  assert.deepEqual(projectRoster(roster), roster);
  for (const claim of ['absent', 'dead', 'unknown'] as const) {
    const retained: CatalogRow = {...row, claim, owner: claim === 'unknown' ? 'unavailable' : 'unknown'};
    const projected = projectRoster({rows: [retained]}).rows[0]; assert.ok(projected);
    assert.equal(projected.identity, retained.id); assert.equal(projected.state, 'interrupted'); assert.equal(projected.currentTool, undefined);
    assert.equal(projected.availability, claim === 'unknown' ? 'unavailable' : 'stored'); assert.equal(projected.capabilities, undefined);
  }
});

test('decoded current publication rows survive the production catalog page boundary with exact selection identity', () => {
  const publication: Publication = {updatedAt: catalogStamp, storageId: catalogStorage, rows: [catalogSummary], coverage: {complete: true, omitted: 0}};
  const decoded = decodePublication(JSON.parse(JSON.stringify(publication)), catalogStorage);
  const rows: CatalogRow[] = decoded.rows.map(row => ({...row, claim: 'live', publishedAt: decoded.updatedAt}));
  const page: CatalogPage = {rows, nextCursor: null, coverage: decoded.coverage, observedAt: catalogStamp, stale: false,
    scan: {state: 'ready', complete: true, visited: 1, skipped: 0, omitted: 0}};
  const projected = projectRoster(page);
  assert.equal(page.rows.length, 1); assert.equal(projected.rows.length, 1); assert.equal(projected.scan.omitted, 0);
  assert.equal(projected.scan.complete, true); assert.equal(projected.stale, false);
  const selected = rows.find(row => row.id === catalogStorage); assert.ok(selected);
  const selectedAgent = projectRoster({rows: [selected]}).rows[0]; assert.ok(selectedAgent);
  assert.equal(selectedAgent.identity, catalogStorage); assert.deepEqual(selectedAgent, projected.rows[0]);
  assert.equal(selectedAgent.model?.thinkingLevel, 'high'); assert.equal(selectedAgent.currentTool?.argument, 'fixture.txt');
  assert.equal(selectedAgent.observedAt, decoded.updatedAt); assert.equal(selectedAgent.capabilities, undefined);
});

test('public tool truncation and inert output references survive saved and repeated projections without details dumps', () => {
  // Inline fixture of the host truncation metadata shape: a lines-limited tail cut of "one\ntwo\nthree".
  const truncation = {truncated: true, truncatedBy: 'lines' as const, totalLines: 3, outputLines: 1,
    totalBytes: 13, outputBytes: 5, maxLines: 1, maxBytes: 20};
  const details = {truncation, fullOutputPath: '/retained/output.txt', diff: 'private diff', content: 'private details'};
  const raw = {role: 'toolResult', toolName: 'bash', toolCallId: 'b', content: [{type: 'text', text: 'three'}], details};
  const projected = projectMessage(raw, 'result'); const part = projected.parts[0]; assert.ok(part?.type === 'toolResult');
  assert.deepEqual(part.output, {truncation: {truncated: true, truncatedBy: 'lines', totalLines: 3, outputLines: 1,
    totalBytes: 13, outputBytes: 5, maxLines: 1, maxBytes: 20}, fullOutputPath: '/retained/output.txt'});
  assert.deepEqual(projectMessage(projected, projected.id), projected);
  const saved = projectSavedEntry({id: 'saved', type: 'message', message: raw});
  const savedPart = saved.messages?.[0]?.parts[0]; assert.ok(savedPart?.type === 'toolResult'); assert.deepEqual(savedPart.output, part.output);
  assert.doesNotMatch(JSON.stringify(projected), /private diff|private details|"content":"three"/);
  const read = projectMessage({...raw, toolName: 'read'}, 'read').parts[0]; assert.ok(read?.type === 'toolResult');
  assert.equal(read.output?.fullOutputPath, undefined); assert.deepEqual(read.output?.truncation, part.output?.truncation);
});
test('tool facts omit malformed or absent counts and bound protected path text without inventing metadata', () => {
  const result = (toolName: string, details?: unknown) => projectMessage({role: 'toolResult', toolName, toolCallId: 'x', content: [], details}, 'x').parts[0];
  const part = result('bash', {truncation: {truncated: true, truncatedBy: 'other', totalLines: -1, outputLines: 0, totalBytes: NaN, outputBytes: Infinity,
    maxLines: Number.MAX_SAFE_INTEGER + 1, maxBytes: '20', firstLineExceedsLimit: true, lastLinePartial: true, content: 'not displayable'},
    fullOutputPath: '\u001b[31m/output/Bearer secret-token/😀'.repeat(200)}); assert.ok(part?.type === 'toolResult');
  assert.deepEqual(part.output?.truncation, {truncated: true, outputLines: 0, firstLineExceedsLimit: true, lastLinePartial: true});
  assert.ok(Buffer.byteLength(part.output?.fullOutputPath ?? '') <= 1024); assert.doesNotMatch(part.output?.fullOutputPath ?? '', /\u001b|secret-token|\ufffd/);
  for (const name of ['bash', 'read', 'edit', 'write', 'custom']) {
    const empty = result(name, name === 'bash' || name === 'read' ? {truncation: {truncated: false}} : {truncation: {truncated: true}, fullOutputPath: '/not-supplied-by-this-tool'});
    assert.ok(empty?.type === 'toolResult'); assert.equal(empty.output, undefined);
  }
  // Inline fixture of the host head-cut shape: a first line over the byte limit yields no output lines.
  const head = result('read', {truncation: {truncated: true, truncatedBy: 'bytes', totalLines: 1, outputLines: 0,
    totalBytes: 20, outputBytes: 0, maxBytes: 2, firstLineExceedsLimit: true}}); assert.ok(head?.type === 'toolResult');
  assert.equal(head.output?.truncation?.firstLineExceedsLimit, true); assert.equal(head.output?.truncation?.outputLines, 0);
});
