import type { EntryView, MessageView, PrimaryView } from '../shared/api.ts';

export type UsageFact = {key: string; text: string; title: string; detail: string; summary: boolean};
export type UsageFacts = {facts: UsageFact[]; contextFraction: number | null};
const count = (value: number): string => value.toLocaleString('en-US');
const percent = (value: number): string => `${Number(value.toFixed(1))}%`;
function fact(key: string, text: string, detail: string, summary = true): UsageFact { return {key, text, title: detail, detail, summary}; }
function compactTokens(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

type CacheWindow = {input: number; cacheRead: number; cacheWrite: number; turns: number};
const windows = new WeakMap<readonly EntryView[], CacheWindow>();
function cacheWindow(entries: readonly EntryView[]): CacheWindow {
  const cached = windows.get(entries); if (cached) return cached;
  const result: CacheWindow = {input: 0, cacheRead: 0, cacheWrite: 0, turns: 0};
  const messages = new Map<string, MessageView>();
  for (const entry of entries) for (const message of entry.messages ?? []) messages.set(message.id, message);
  for (const message of messages.values()) {
    const usage = message.usage;
    if (message.role !== 'assistant' || message.state !== 'final' || !usage) continue;
    result.input += usage.input; result.cacheRead += usage.cacheRead; result.cacheWrite += usage.cacheWrite; result.turns++;
  }
  windows.set(entries, result); return result;
}
function cacheFacts(entries: readonly EntryView[]): UsageFact[] {
  const cache = cacheWindow(entries); const prompt = cache.input + cache.cacheRead + cache.cacheWrite;
  const detail = `Loaded assistant window only (${cache.turns} finalized messages with supplied usage): input ${count(cache.input)}, cache read ${count(cache.cacheRead)}, cache write ${count(cache.cacheWrite)}. Earlier, evicted, tool, and compaction usage is not included. This is not a complete-session aggregate.`;
  if (!cache.turns) return [fact('cacheHitShare', 'Cache not reported', 'Cache usage is not reported for this loaded conversation. No ratio is available.', false)];
  if (!Number.isSafeInteger(prompt) || prompt <= 0) return [fact('cacheHitShare', 'Cache ratio not reported', `${detail} No positive prompt-token denominator is available; no cache ratio is reported.`, false)];
  return [fact('cacheHitShare', `Cache ${percent(cache.cacheRead / prompt * 100)}`, detail)];
}
function contextFacts(context: PrimaryView['contextUsage'], facts: UsageFact[]): number | null {
  if (!context) { facts.push(fact('context', 'Context unavailable', 'The selected Primary does not report current context usage. This is not a safe remaining budget.')); return null; }
  const known = context.percent !== null;
  facts.push(fact('context', known ? `Context ${percent(context.percent as number)}` : 'Context unknown',
    known ? `Primary context estimate: ${percent(context.percent as number)}. This is not a safe remaining budget.` : 'The host reports an unknown Primary context percentage. This is not a safe remaining budget.'));
  const window = context.contextWindow;
  const tokens = context.tokens === null ? '?' : compactTokens(context.tokens);
  facts.push(fact('contextTokens', window > 0 ? `${tokens}/${compactTokens(window)}` : tokens,
    context.tokens === null ? `The host reports unknown context tokens. Model context window: ${count(window)} tokens.` : `Estimated current-context tokens: ${count(context.tokens)}. Model context window: ${count(window)} tokens.`, false));
  return known ? Math.max(0, Math.min(1, (context.percent as number) / 100)) : null;
}
function sessionFacts(usage: PrimaryView['usage'], facts: UsageFact[]): void {
  if (!usage) { facts.push(fact('cost', 'Session cost unavailable', 'The selected Primary does not report a session cost. Missing cost is not zero.', false)); return; }
  facts.push(fact('cost', `$${usage.cost.toFixed(2)}`,
    `Reported whole-session cost estimate: $${usage.cost.toFixed(6)} USD. RPC session total ${count(usage.tokens.total)}: input ${count(usage.tokens.input)}, output ${count(usage.tokens.output)}, cache read ${count(usage.tokens.cacheRead)}, cache write ${count(usage.tokens.cacheWrite)}. Totals include supplied tool, compaction, and branch-summary usage. This is not a billing statement.`));
}
/** Context estimates, loaded assistant usage, and session totals describe separate scopes. */
export function usageFacts(primary?: PrimaryView, entries?: readonly EntryView[]): UsageFacts {
  const facts: UsageFact[] = []; const contextFraction = primary ? contextFacts(primary.contextUsage, facts) : null;
  if (primary) sessionFacts(primary.usage, facts);
  if (entries) facts.push(...cacheFacts(entries));
  return {facts, contextFraction};
}
export function usageSummary(primary?: PrimaryView, entries?: readonly EntryView[]): string {
  return usageFacts(primary, entries).facts.filter(item => item.summary).map(item => item.text).join(' │ ');
}
