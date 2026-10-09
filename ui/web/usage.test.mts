import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrimaryView } from '../shared/api.ts';
import { usageSummary } from './usage.ts';
const primary: PrimaryView = {key: 'p', epoch: 1, cwd: '/project', lifecycle: 'ready', activity: 'idle', pendingOperationIds: [], pendingDialogs: [], capabilities: {}};
test('missing reported usage creates no inferred token or context display', () => {assert.equal(usageSummary(primary), ''); assert.equal(usageSummary(), '');});
test('unknown context after compaction produces no placeholder or zero', () => {assert.equal(usageSummary({...primary, contextUsage: {tokens: null, percent: null, contextWindow: 100_000}}), '');});
test('known context tokens survive an unavailable percentage', () => {
  assert.equal(usageSummary({...primary, contextUsage: {tokens: 1234, percent: null, contextWindow: 100_000}}), '1,234 context tokens');
  assert.equal(usageSummary({...primary, contextUsage: {tokens: 0, percent: null, contextWindow: 100_000}}), '0 context tokens');
});
test('known session tokens survive an unavailable context estimate', () => {
  const usage = {cost: 0, tokens: {input: 9, output: 7, cacheRead: 8, cacheWrite: 0, total: 24}};
  assert.equal(usageSummary({...primary, contextUsage: {tokens: null, percent: null, contextWindow: 100_000}, usage}), '24 tokens');
  assert.equal(usageSummary({...primary, contextUsage: {tokens: 100, percent: null, contextWindow: 100_000}, usage}), '100 context tokens · 24 tokens');
});
test('reported percent and session totals remain separate facts', () => {
  assert.equal(usageSummary({...primary, contextUsage: {tokens: 100, percent: 10.123, contextWindow: 1000}, usage: {cost: 0, tokens: {input: 9, output: 7, cacheRead: 8, cacheWrite: 0, total: 24}}}), '10.1% context · 24 tokens');
});
