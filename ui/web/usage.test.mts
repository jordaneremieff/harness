import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryView, MessageView, PrimaryView } from '../shared/api.ts';
import { usageFacts, usageSummary } from './usage.ts';
const primary: PrimaryView = {key: 'p', epoch: 1, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingOperationIds: [], pendingDialogs: [], capabilities: {}};
const usage = {cost: 0.01234, tokens: {input: 9, output: 7, cacheRead: 8, cacheWrite: 0, total: 24}};

test('absent usage creates no invented zero, elapsed, or branch', () => {
  for (const value of [undefined, primary]) {
    assert.deepEqual(usageFacts(value), {facts: [], contextFraction: null}); assert.equal(usageSummary(value), '');
  }
});
test('context tokens and window survive an unavailable percentage', () => {
  const facts = usageFacts({...primary, contextUsage: {tokens: 1234, percent: null, contextWindow: 100_000}});
  assert.deepEqual(facts.facts.map(({key, text}) => ({key, text})), [{key: 'context', text: '?'}, {key: 'contextTokens', text: '1.2k/100k'}]);
  assert.equal(facts.contextFraction, null);
  assert.match(facts.facts[1]?.title ?? '', /1,234.*100,000/);
  assert.equal(usageSummary({...primary, contextUsage: {tokens: 0, percent: null, contextWindow: 100_000}}), '? │ 0/100k');
});
test('reported percentage, current window tokens, and session totals stay separate', () => {
  const result = usageFacts({...primary, contextUsage: {tokens: 100, percent: 10.123, contextWindow: 1000}, usage});
  assert.deepEqual(result.facts.map(fact => [fact.key, fact.text]), [
    ['context', '10.1%'], ['contextTokens', '100/1.0k'], ['cost', '$0.01'], ['cacheHitShare', '47.1% hit'],
  ]);
  assert.equal(result.contextFraction, 0.10122999999999999);
  assert.match(result.facts.find(fact => fact.key === 'cost')?.title ?? '', /0.012340 USD/);
  assert.match(result.facts.find(fact => fact.key === 'cost')?.title ?? '', /input 9, output 7, cache read 8, cache write 0/);
  assert.match(result.facts.find(fact => fact.key === 'context')?.title ?? '', /not a safe remaining budget/);
});
test('unknown context displays question marks while the bar stays absent', () => {
  const result = usageFacts({...primary, contextUsage: {tokens: null, percent: null, contextWindow: 200_000}});
  assert.equal(result.contextFraction, null);
  assert.deepEqual(result.facts.map(fact => fact.text), ['?', '?/200k']);
  assert.match(result.facts[1]?.title ?? '', /200,000/);
});
test('compact token units match the TUI and titles preserve exact totals', () => {
  for (const [tokens, text] of [[999, '999'], [9500, '9.5k'], [42_000, '42k'], [1_200_000, '1.2M'], [12_000_000, '12M']] as const) {
    const result = usageFacts({...primary, contextUsage: {tokens, percent: 20, contextWindow: 200_000}, usage: {...usage, tokens: {...usage.tokens, total: tokens}}});
    assert.equal(result.facts.find(fact => fact.key === 'contextTokens')?.text, `${text}/200k`);
    const total = result.facts.find(fact => fact.key === 'cost');
    assert.ok(total?.title.includes(tokens.toLocaleString('en-US')));
  }
});
test('cache hit share uses prompt tokens only and includes cache writes', () => {
  const result = usageFacts({...primary, usage: {cost: 0, tokens: {input: 10, output: 9000, cacheRead: 30, cacheWrite: 20, total: 9060}}});
  assert.equal(result.facts.find(fact => fact.key === 'cacheHitShare')?.text, '50% hit');
  const empty = usageFacts({...primary, usage: {cost: 0, tokens: {input: 0, output: 2, cacheRead: 0, cacheWrite: 0, total: 2}}});
  assert.equal(empty.facts.some(fact => fact.key === 'cacheHitShare'), false);
  assert.equal(empty.facts.find(fact => fact.key === 'cost')?.text, '$0.00');
});
function entry(id: string, values: {input: number; cacheRead: number; cacheWrite: number}, role = 'assistant', state: 'partial' | 'final' = 'final'): EntryView {
  return {id, kind: 'message', messages: [{id, role, state, parts: [], usage: values, coverage: {complete: true, truncated: false, omitted: 0}}]};
}
test('loaded assistant cache share excludes tool and compaction usage and never claims complete-session scope', () => {
  const rows = [entry('hit', {input: 10, cacheRead: 30, cacheWrite: 20}), entry('tool', {input: 1000, cacheRead: 9000, cacheWrite: 0}, 'toolResult'),
    {id: 'compaction', kind: 'compaction', data: {value: {usage: {input: 10000, cacheRead: 20000, cacheWrite: 0}}, truncated: false}}, entry('uncached', {input: 60, cacheRead: 0, cacheWrite: 0})];
  const facts = usageFacts({...primary, usage}, rows).facts;
  const share = facts.find(fact => fact.key === 'cacheHitShare'); assert.equal(share?.text, '25% hit');
  assert.match(share?.title ?? '', /Loaded assistant window only.*2 finalized/); assert.match(share?.title ?? '', /not a complete-session/);
  const marker = facts.find(fact => fact.key === 'cacheTurnHit'); assert.equal(marker?.text, '●'); assert.match(marker?.title ?? '', /hit.*input 10, cache read 30, cache write 20/);
  assert.equal(facts.some(fact => fact.key === 'cacheTurnWrite'), false);
});
test('last cache-active final message distinguishes read and write-only without a guessed zero', () => {
  const read = entry('read', {input: 2, cacheRead: 3, cacheWrite: 4}); const write = entry('write', {input: 5, cacheRead: 0, cacheWrite: 7});
  const partial = entry('partial', {input: 100, cacheRead: 200, cacheWrite: 0}, 'assistant', 'partial');
  const unknown: EntryView = {id: 'unknown', kind: 'message', messages: [{id: 'unknown', role: 'assistant', state: 'final', parts: [], coverage: {complete: true, truncated: false, omitted: 0}}]};
  const result = usageFacts(primary, [read, write, partial, unknown]);
  assert.equal(result.facts.find(fact => fact.key === 'cacheTurnWrite')?.text, '●');
  assert.match(result.facts.find(fact => fact.key === 'cacheTurnWrite')?.title ?? '', /write.*input 5, cache read 0, cache write 7/);
  assert.equal(result.facts.some(fact => fact.key === 'cacheTurnHit'), false);
  for (const rows of [[], [partial], [unknown], [entry('empty', {input: 0, cacheRead: 0, cacheWrite: 0})]]) assert.deepEqual(usageFacts(primary, rows).facts, []);
});
test('stable entry references reuse the scan and replacement windows do not retain evicted turns', () => {
  const row = entry('first', {input: 10, cacheRead: 30, cacheWrite: 20}); const message = row.messages?.[0] as MessageView;
  const supplied = message.usage; let reads = 0; Object.defineProperty(message, 'usage', {get: () => {reads++; return supplied;}});
  const rows = [row]; const first = usageFacts(primary, rows); const afterFirst = reads;
  assert.deepEqual(usageFacts(primary, rows), first); assert.ok(reads <= afterFirst + 1, 'Cached facts read only the last supplied usage, not the full window');
  const replacement = usageFacts(primary, [entry('replacement', {input: 10, cacheRead: 0, cacheWrite: 20})]);
  assert.equal(replacement.facts.find(fact => fact.key === 'cacheHitShare')?.text, '0% hit');
  assert.equal(replacement.facts.find(fact => fact.key === 'cacheTurnWrite')?.text, '●');
});
test('duplicate retained message identity contributes usage once', () => {
  const row = entry('duplicate', {input: 1, cacheRead: 1, cacheWrite: 0});
  const result = usageFacts(primary, [row, row]); assert.match(result.facts.find(fact => fact.key === 'cacheHitShare')?.title ?? '', /1 finalized/);
});
test('context bar fraction is bounded without rewriting the reported percentage', () => {
  const result = usageFacts({...primary, contextUsage: {tokens: null, percent: 120, contextWindow: 1000}});
  assert.equal(result.contextFraction, 1); assert.equal(result.facts[0]?.text, '120%');
  assert.equal(usageFacts({...primary, contextUsage: {tokens: 50, percent: null, contextWindow: 0}}).contextFraction, null);
  assert.equal(usageSummary({...primary, contextUsage: {tokens: 50, percent: null, contextWindow: 0}}), '? │ 50');
});
