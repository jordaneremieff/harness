import type { EntryView, MessageView, PrimaryView } from '../shared/api.ts';

export type UsageFact = {key: string; text: string; title: string};
export type UsageFacts = {facts: UsageFact[]; contextFraction: number | null};
const count = (value: number): string => value.toLocaleString('en-US');
const percent = (value: number): string => `${Number(value.toFixed(1))}%`;
function compactTokens(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

type CacheWindow = {input: number; cacheRead: number; cacheWrite: number; turns: number; last?: MessageView};
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
    if (usage.cacheRead > 0 || usage.cacheWrite > 0) result.last = message;
  }
  windows.set(entries, result); return result;
}
function cacheFacts(entries: readonly EntryView[]): UsageFact[] {
  const cache = cacheWindow(entries); const facts: UsageFact[] = [];
  const prompt = cache.input + cache.cacheRead + cache.cacheWrite;
  if (Number.isSafeInteger(prompt) && prompt > 0) facts.push({key: 'cacheHitShare', text: `${percent(cache.cacheRead / prompt * 100)} hit`,
    title: `Loaded assistant window only (${cache.turns} finalized messages with supplied usage): input ${count(cache.input)}, cache read ${count(cache.cacheRead)}, cache write ${count(cache.cacheWrite)}. Earlier, evicted, tool, and compaction usage is not included. This is not a complete-session aggregate.`});
  const last = cache.last; const usage = last?.usage;
  if (last && usage) facts.unshift({key: usage.cacheRead > 0 ? 'cacheTurnHit' : 'cacheTurnWrite', text: '●',
    title: `Latest supplied cache-active finalized assistant in the loaded window (${last.id}): input ${count(usage.input)}, cache read ${count(usage.cacheRead)}, cache write ${count(usage.cacheWrite)}. This marker is not a claim about omitted turns.`});
  return facts;
}

function contextFacts(context: PrimaryView['contextUsage'], facts: UsageFact[]): number | null {
  let contextFraction: number | null = null;
  if (context?.percent !== null && context?.percent !== undefined) {
    facts.push({key: 'context', text: percent(context.percent), title: `Reported context usage: ${percent(context.percent)}. This is not a safe remaining budget.`});
    contextFraction = Math.max(0, Math.min(1, context.percent / 100));
  }
  if (context && context.percent === null) facts.push({key: 'context', text: '?', title: 'The host reports an unknown context percentage.'});
  if (context && context.tokens === null) facts.push({key: 'contextTokens', text: context.contextWindow > 0 ? `?/${compactTokens(context.contextWindow)}` : '?', title: `The host reports unknown context tokens. Model context window: ${count(context.contextWindow)} tokens.`});
  if (context?.tokens !== null && context?.tokens !== undefined) {
    const window = context.contextWindow;
    facts.push({key: 'contextTokens', text: window > 0 ? `${compactTokens(context.tokens)}/${compactTokens(window)}` : compactTokens(context.tokens), title: `Estimated context tokens: ${count(context.tokens)}. Model context window: ${count(window)} tokens.`});
  }
  return contextFraction;
}
function sessionFacts(usage: NonNullable<PrimaryView['usage']>, facts: UsageFact[], includeCache: boolean): void {
    facts.push({key: 'cost', text: `$${usage.cost.toFixed(2)}`, title: `Reported session cost: $${usage.cost.toFixed(6)} USD. RPC session total ${count(usage.tokens.total)}: input ${count(usage.tokens.input)}, output ${count(usage.tokens.output)}, cache read ${count(usage.tokens.cacheRead)}, cache write ${count(usage.tokens.cacheWrite)}. Totals include supplied tool, compaction, and branch-summary usage.`});
    const promptTokens = usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite;
    if (includeCache && promptTokens > 0) facts.push({key: 'cacheHitShare', text: `${percent(usage.tokens.cacheRead / promptTokens * 100)} hit`, title: 'RPC session aggregate, including assistant, tool, compaction, and branch-summary usage: cache read / (input + cache read + cache write). This is not an assistant-only or last-turn statistic.'});
}
/** Context estimates, loaded assistant usage, and session totals describe separate scopes. */
export function usageFacts(primary?: PrimaryView, entries?: readonly EntryView[]): UsageFacts {
  const facts: UsageFact[] = []; const contextFraction = contextFacts(primary?.contextUsage, facts);
  if (primary?.usage) sessionFacts(primary.usage, facts, entries === undefined);
  if (entries) facts.push(...cacheFacts(entries));
  return {facts, contextFraction};
}

export function usageSummary(primary?: PrimaryView, entries?: readonly EntryView[]): string {
  const groups: string[] = [];
  for (const fact of usageFacts(primary, entries).facts) {
    if (fact.key === 'cacheHitShare' && groups.at(-1) === '●') groups[groups.length - 1] += ` ${fact.text}`;
    else groups.push(fact.text);
  }
  return groups.join(' │ ');
}
