import type { JsonDisplay, PartView } from '../shared/api.ts';

/** One awaited result: who answered, how it ended, and the answer text when there is one. */
export type AwaitedResult = {identity?: string; status: 'done' | 'unanswered' | 'unavailable'; answer: string};
export type AwaitedAnswers = {results: AwaitedResult[]; unresolved: number};
export type AnswerNamer = (identity: string) => string | undefined;

const LINE_CHARS = 80;
const MAX_RESULTS = 64;
const plain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function statusOf(status: unknown, answer: string): AwaitedResult['status'] {
  if (status === 'unanswered') return 'unanswered';
  if (status === 'unavailable') return 'unavailable';
  return answer ? 'done' : 'unavailable';
}

function resultOf(item: Record<string, unknown>): AwaitedResult {
  const reference = own(item, 'result'), identity = plain(reference) ? own(reference, 'sessionId') : undefined;
  const answer = own(item, 'answer'), text = typeof answer === 'string' ? answer : '';
  return {...(typeof identity === 'string' && identity ? {identity} : {}), status: statusOf(own(item, 'status'), text), answer: text};
}

/** Reads a structured value whose `results` is a non-empty array of objects, or an empty one beside a non-empty `unresolved` array; any other shape is not an awaited-answers value. */
export function awaitedAnswers(display: JsonDisplay | undefined): AwaitedAnswers | undefined {
  if (!plain(display)) return undefined;
  const value = own(display, 'value'); if (!plain(value)) return undefined;
  const list = own(value, 'results');
  const unresolved = own(value, 'unresolved'), pending = Array.isArray(unresolved) ? unresolved.length : 0;
  if (!Array.isArray(list) || list.length > MAX_RESULTS || !list.length && !pending) return undefined;
  const results: AwaitedResult[] = [];
  for (let index = 0; index < list.length; index++) {
    const item = own(list, String(index)); if (!plain(item)) return undefined;
    results.push(resultOf(item));
  }
  return {results, unresolved: pending};
}

/** The first structured value among a tool result's text parts, nested results included. */
export function awaitedFromParts(parts: readonly PartView[]): AwaitedAnswers | undefined {
  for (const part of parts) {
    if (part.type === 'toolResult') { const nested = awaitedFromParts(part.parts); if (nested) return nested; continue; }
    if (part.type !== 'text' || part.redacted || !part.structured) continue;
    const found = awaitedAnswers(part.structured); if (found) return found;
  }
  return undefined;
}

export function responderName(result: AwaitedResult, resolve?: AnswerNamer): string {
  return (result.identity ? resolve?.(result.identity) : undefined) || 'An agent';
}
/** What a result without answer text says in place of the answer. */
export function missingAnswerNote(result: AwaitedResult): string | undefined {
  if (result.status === 'unanswered') return 'no answer yet';
  if (result.status === 'unavailable' || !result.answer.trim()) return 'answer unavailable';
  return undefined;
}
function firstLine(answer: string): string {
  const line = answer.split(/\r\n|\r|\n/).map(text => text.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS).trimEnd()}…` : line;
}

/** What a wait with no answers yet says: how many results are still awaited. */
export function stillWaitingSentence(awaited: AwaitedAnswers): string {
  return `Still waiting for ${awaited.unresolved} ${awaited.unresolved === 1 ? 'answer' : 'answers'}`;
}

/** One collapsed line: the first responder and the first line of its answer, then how many more answers and how many results are still awaited. */
export function awaitedLine(awaited: AwaitedAnswers, resolve?: AnswerNamer): string {
  const [first] = awaited.results; if (!first) return stillWaitingSentence(awaited);
  const name = responderName(first, resolve), note = missingAnswerNote(first);
  const head = note ? `${name}: ${note}` : `${name}: “${firstLine(first.answer)}”`;
  const more = awaited.results.length - 1;
  return [head, more ? `${more} more ${more === 1 ? 'answer' : 'answers'}` : '', awaited.unresolved ? `${awaited.unresolved} still waiting` : ''].filter(Boolean).join(' · ');
}

/** The fields the card keeps one level down: the structured value without its answer text. */
export function awaitedFieldsText(display: JsonDisplay | undefined): string | undefined {
  if (!awaitedAnswers(display) || !plain(display)) return undefined;
  const value = own(display, 'value');
  try { return JSON.stringify(value, (key, child) => key === 'answer' && typeof child === 'string' ? undefined : child, 2); } catch { return undefined; }
}
/** The fields text of the first awaited-answers value among a tool result's parts. */
export function awaitedFieldsFromParts(parts: readonly PartView[]): string | undefined {
  for (const part of parts) {
    if (part.type === 'toolResult') { const nested = awaitedFieldsFromParts(part.parts); if (nested) return nested; continue; }
    if (part.type !== 'text' || part.redacted || !part.structured) continue;
    const found = awaitedFieldsText(part.structured); if (found) return found;
  }
  return undefined;
}
