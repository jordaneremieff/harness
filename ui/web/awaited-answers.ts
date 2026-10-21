import type { JsonDisplay, PartView } from '../shared/api.ts';
import type { JoinedTool } from './transcript-tools.ts';
import { plainPreviewWords } from './format.ts';

/** One awaited result: who answered, how it ended, and the answer text when there is one. */
export type AwaitedResult = {identity?: string; status: 'done' | 'unanswered' | 'unavailable'; answer: string};
export type AwaitedAnswers = {results: AwaitedResult[]; unresolved: number};
export type AnswerNamer = (identity: string) => string | undefined;

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

type AwaitedState = {label: string; status: string};
function awaitedDecisionState(decision: unknown, answered: number, unresolved: number, outcomes: number): AwaitedState | undefined {
  if (decision === 'awaiting') return {label: `Waiting · ${unresolved} results`, status: 'working'};
  if (decision === 'failed') return {label: 'Failed', status: 'error'};
  if (decision === 'released') return {label: `Released · ${answered} answered, ${unresolved} unresolved`, status: 'available'};
  if (decision === 'settled') {
    const unanswered = outcomes - answered;
    return {label: `${answered} answered${unanswered ? `, ${unanswered} unanswered` : ''}`, status: 'available'};
  }
  return undefined;
}
function awaitedResultState(display: JsonDisplay): AwaitedState | undefined {
  const value = own(display, 'value'); if (!plain(value) || display.truncated) return undefined;
  const decision = own(value, 'decision'), results = own(value, 'results'), unresolved = own(value, 'unresolved');
  if (!Array.isArray(results) || !Array.isArray(unresolved) || results.length > MAX_RESULTS || unresolved.length > MAX_RESULTS) return undefined;
  const answered = results.filter(item => plain(item) && own(item, 'status') === 'done').length;
  return awaitedDecisionState(decision, answered, unresolved.length, results.length);
}
function awaitedPartState(parts: readonly PartView[]): AwaitedState | undefined {
  for (const part of parts) {
    if (part.type === 'toolResult') { const nested = awaitedPartState(part.parts); if (nested) return nested; }
    if (part.type !== 'text' || part.redacted || !part.structured) continue;
    const state = awaitedResultState(part.structured); if (state) return state;
  }
  return undefined;
}
function awaitedRequestCount(args: JsonDisplay | undefined): number | undefined {
  if (!args || args.truncated || !plain(args.value)) return undefined;
  const references = own(args.value, 'results');
  return Array.isArray(references) && references.length > 0 && references.length <= 16 ? references.length : undefined;
}
/** The public await result owns release counts; only an exact running call establishes an unfinished wait. */
export function awaitedToolState(source: Pick<JoinedTool, 'status' | 'result' | 'args'>): AwaitedState | undefined {
  if (source.status === 'error') return undefined;
  const result = awaitedPartState(source.result ?? []); if (result) return result;
  if (source.status === 'working') {
    const count = awaitedRequestCount(source.args);
    return {label: count === undefined ? 'Waiting' : `Waiting · ${count} results`, status: 'working'};
  }
  if (source.status === 'ended' && source.result === undefined) return {label: 'No result recorded', status: 'missing'};
  if (source.status === 'missing') return {label: '', status: 'unknown'};
  return undefined;
}

export function responderName(result: AwaitedResult, resolve?: AnswerNamer): string {
  return (result.identity ? resolve?.(result.identity) : undefined) || 'Another conversation';
}
/** What a result without answer text says in place of the answer. */
export function missingAnswerNote(result: AwaitedResult): string | undefined {
  if (result.status === 'unanswered') return 'no answer yet';
  if (result.status === 'unavailable' || !result.answer.trim()) return 'answer unavailable';
  return undefined;
}
function firstLine(answer: string): string {
  const line = answer.split(/\r\n|\r|\n/).map(plainPreviewWords).find(Boolean) ?? '';
  return line;
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
