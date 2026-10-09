import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogPage, CatalogRow } from '../agents/index.mts';
import { decodePublication } from '../agents/contract.mts';
import type { Publication, Summary } from '../agents/contract.mts';
import { jsonDisplay, projectEntry, projectFrame, projectJson, projectMessage, projectRoster, safeText } from './projection.mts';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test('safe text preserves ordinary prose, strips terminal escapes, redacts credentials, and truncates on Unicode boundaries', () => {
  assert.equal(safeText('\x1b[31mordinary\x1b[0m\ttext\n'), 'ordinary\ttext\n');
  assert.equal(safeText('\x1b]title\x1b\\between\x1b]title2\x1b\\'), 'between');
  assert.equal(safeText('long content', 0), '');
  assert.equal(safeText('secret recipe, token budget, https://example.test/'), 'secret recipe, token budget, https://example.test/');
  assert.doesNotMatch(safeText(`Bearer a-secret-token https://user:password@example.test/ sk-${'a'.repeat(24)}`), /a-secret-token|password|sk-/);
  const text = safeText('😀'.repeat(100_000), 1024); assert.ok(Buffer.byteLength(text) <= 1024); assert.doesNotMatch(text, /\ufffd/); assert.match(text, /truncated/);
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
