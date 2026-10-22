import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryView, MessageView, PrimaryView } from '../shared/api.ts';
import { usageFacts, usageSummary } from './usage.ts';
const primary: PrimaryView = {key: 'p', epoch: 1, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingOperationIds: [], pendingDialogs: [], capabilities: {}};
const usage = {cost: 0.01234, tokens: {input: 9, output: 7, cacheRead: 8, cacheWrite: 0, total: 24}};

test('absent usage preserves Primary unavailable explanations without invented zero or agent metadata', () => {
  assert.deepEqual(usageFacts(), {facts: [], contextFraction: null}); assert.equal(usageSummary(), '');
  const result = usageFacts(primary);
  assert.equal(result.contextFraction, null); assert.equal(usageSummary(primary), 'Context unavailable');
  assert.equal(result.facts.find(fact => fact.key === 'cost')?.summary, false);
  assert.match(result.facts.find(fact => fact.key === 'cost')?.detail ?? '', /Missing cost is not zero/);
  assert.doesNotMatch(result.facts.map(fact => fact.text).join(' '), /\$0|elapsed|branch/);
});
test('context tokens and window survive an unavailable percentage as detail-only facts', () => {
  const result = usageFacts({...primary, contextUsage: {tokens: 1234, percent: null, contextWindow: 100_000}});
  assert.deepEqual(result.facts.filter(fact => fact.summary).map(({key, text}) => ({key, text})), [{key: 'context', text: 'Context unknown'}]);
  assert.equal(result.facts.find(fact => fact.key === 'contextTokens')?.text, '1.2k/100k'); assert.equal(result.facts.find(fact => fact.key === 'contextTokens')?.summary, false);
  assert.equal(result.contextFraction, null); assert.match(result.facts[1]?.detail ?? '', /1,234.*100,000/);
  assert.equal(usageSummary({...primary, contextUsage: {tokens: 0, percent: null, contextWindow: 100_000}}), 'Context unknown');
});
test('reported percentage, current window tokens, and session totals stay separate', () => {
  const result = usageFacts({...primary, contextUsage: {tokens: 100, percent: 10.123, contextWindow: 1000}, usage});
  assert.deepEqual(result.facts.map(fact => [fact.key, fact.text]), [['context', 'Context 10.1%'], ['contextTokens', '100/1.0k'], ['cost', '$0.01']]);
  assert.equal(result.contextFraction, 0.10122999999999999);
  assert.match(result.facts.find(fact => fact.key === 'cost')?.detail ?? '', /0.012340 USD/);
  assert.match(result.facts.find(fact => fact.key === 'cost')?.detail ?? '', /input 9, output 7, cache read 8, cache write 0/);
  assert.match(result.facts.find(fact => fact.key === 'context')?.detail ?? '', /not a safe remaining budget/);
  for (const fact of result.facts) { assert.equal(fact.title, fact.detail); assert.equal(typeof fact.summary, 'boolean'); }
});
test('unknown context displays question marks while the bar stays absent', () => {
  const result = usageFacts({...primary, contextUsage: {tokens: null, percent: null, contextWindow: 200_000}});
  assert.equal(result.contextFraction, null);
  assert.deepEqual(result.facts.filter(fact => fact.summary).map(fact => fact.text), ['Context unknown']);
  assert.equal(result.facts[1]?.text, '?/200k'); assert.match(result.facts[1]?.detail ?? '', /200,000/);
});
test('compact token units match the TUI and titles preserve exact totals', () => {
  for (const [tokens, text] of [[999, '999'], [9500, '9.5k'], [42_000, '42k'], [1_200_000, '1.2M'], [12_000_000, '12M']] as const) {
    const result = usageFacts({...primary, contextUsage: {tokens, percent: 20, contextWindow: 200_000}, usage: {...usage, tokens: {...usage.tokens, total: tokens}}});
    assert.equal(result.facts.find(fact => fact.key === 'contextTokens')?.text, `${text}/200k`);
    assert.ok(result.facts.find(fact => fact.key === 'cost')?.detail.includes(tokens.toLocaleString('en-US')));
  }
});
function entry(id: string, values: {input: number; cacheRead: number; cacheWrite: number}, role = 'assistant', state: 'partial' | 'final' = 'final'): EntryView {
  return {id, kind: 'message', messages: [{id, role, state, parts: [], usage: values, coverage: {complete: true, truncated: false, omitted: 0}}]};
}
test('cache share uses loaded prompt tokens including writes, never RPC session totals', () => {
  const supplied = {...primary, usage: {cost: 0, tokens: {input: 10, output: 9000, cacheRead: 30, cacheWrite: 20, total: 9060}}};
  assert.equal(usageFacts(supplied).facts.some(fact => fact.key === 'cacheHitShare'), false);
  const result = usageFacts(supplied, [entry('loaded', {input: 10, cacheRead: 30, cacheWrite: 20})]);
  assert.equal(result.facts.find(fact => fact.key === 'cacheHitShare')?.text, 'Cache 50%');
  const empty = usageFacts(supplied, [entry('zero', {input: 0, cacheRead: 0, cacheWrite: 0})]);
  assert.equal(empty.facts.find(fact => fact.key === 'cacheHitShare')?.summary, false);
  assert.match(empty.facts.find(fact => fact.key === 'cacheHitShare')?.detail ?? '', /input 0, cache read 0, cache write 0.*No positive prompt-token denominator/);
  assert.equal(empty.facts.find(fact => fact.key === 'cost')?.text, '$0.00');
});
test('loaded assistant cache share excludes tool and compaction usage and never claims complete-session scope', () => {
  const rows = [entry('hit', {input: 10, cacheRead: 30, cacheWrite: 20}), entry('tool', {input: 1000, cacheRead: 9000, cacheWrite: 0}, 'toolResult'),
    {id: 'compaction', kind: 'compaction', data: {value: {usage: {input: 10000, cacheRead: 20000, cacheWrite: 0}}, truncated: false}}, entry('uncached', {input: 60, cacheRead: 0, cacheWrite: 0})];
  const facts = usageFacts({...primary, usage}, rows).facts; const share = facts.find(fact => fact.key === 'cacheHitShare');
  assert.equal(share?.text, 'Cache 25%'); assert.match(share?.detail ?? '', /Loaded assistant window only.*2 finalized/);
  assert.match(share?.detail ?? '', /not a complete-session/); assert.equal(facts.some(fact => fact.text === '●'), false);
});
test('missing and zero denominator cache stay detail-only while supplied zero share stays visible', () => {
  const partial = entry('partial', {input: 100, cacheRead: 200, cacheWrite: 0}, 'assistant', 'partial');
  const unknown: EntryView = {id: 'unknown', kind: 'message', messages: [{id: 'unknown', role: 'assistant', state: 'final', parts: [], coverage: {complete: true, truncated: false, omitted: 0}}]};
  for (const rows of [[], [partial], [unknown], [entry('empty', {input: 0, cacheRead: 0, cacheWrite: 0})]]) {
    const result = usageFacts(undefined, rows); assert.equal(result.facts.length, 1); assert.equal(result.facts[0]?.summary, false);
    assert.match(result.facts[0]?.detail ?? '', /not reported|no cache ratio is reported/); assert.equal(usageSummary(undefined, rows), '');
  }
  const zero = usageFacts(undefined, [entry('uncached', {input: 10, cacheRead: 0, cacheWrite: 20})]);
  assert.equal(zero.facts[0]?.summary, true); assert.equal(zero.facts[0]?.text, 'Cache 0%');
});
test('stable entry references reuse the scan and replacement windows do not retain evicted turns', () => {
  const row = entry('first', {input: 10, cacheRead: 30, cacheWrite: 20}); const message = row.messages?.[0] as MessageView;
  const supplied = message.usage; let reads = 0; Object.defineProperty(message, 'usage', {get: () => {reads++; return supplied;}});
  const rows = [row]; const first = usageFacts(primary, rows); const afterFirst = reads;
  assert.deepEqual(usageFacts(primary, rows), first); assert.equal(reads, afterFirst, 'Cached facts do not rescan supplied usage');
  const replacement = usageFacts(primary, [entry('replacement', {input: 10, cacheRead: 0, cacheWrite: 20})]);
  assert.equal(replacement.facts.find(fact => fact.key === 'cacheHitShare')?.text, 'Cache 0%');
  assert.equal(replacement.facts.some(fact => fact.text === '●'), false);
});
test('duplicate retained message identity contributes usage once', () => {
  const row = entry('duplicate', {input: 1, cacheRead: 1, cacheWrite: 0});
  assert.match(usageFacts(primary, [row, row]).facts.find(fact => fact.key === 'cacheHitShare')?.detail ?? '', /1 finalized/);
});
test('context bar fraction is bounded without rewriting the reported percentage', () => {
  const result = usageFacts({...primary, contextUsage: {tokens: null, percent: 120, contextWindow: 1000}});
  assert.equal(result.contextFraction, 1); assert.equal(result.facts[0]?.text, 'Context 120%');
  assert.equal(usageFacts({...primary, contextUsage: {tokens: 50, percent: null, contextWindow: 0}}).contextFraction, null);
  assert.equal(usageSummary({...primary, contextUsage: {tokens: 50, percent: null, contextWindow: 0}}), 'Context unknown');
});
test('recipient changes do not transfer Primary context or cost into agent facts', () => {
  const rows = [entry('agent', {input: 1, cacheRead: 3, cacheWrite: 0})];
  const current = usageFacts({...primary, usage, contextUsage: {tokens: 0, percent: 0, contextWindow: 1000}}, rows);
  assert.equal(current.contextFraction, 0); assert.equal(current.facts[0]?.text, 'Context 0%');
  const agent = usageFacts(undefined, rows); assert.equal(agent.contextFraction, null);
  assert.deepEqual(agent.facts.map(fact => fact.key), ['cacheHitShare']); assert.equal(agent.facts[0]?.text, 'Cache 75%');
  assert.deepEqual(usageFacts(undefined, []).facts.filter(fact => fact.summary), []);
  assert.deepEqual(usageFacts({...primary, usage, contextUsage: {tokens: 0, percent: 0, contextWindow: 1000}}, rows), current);
});
