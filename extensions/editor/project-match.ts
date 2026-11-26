import { parentPort, workerData } from "node:worker_threads";

export const MATCH_WORKER = "editor-project-match";

export type Pattern = { source: string; flags: string };
export type MatchJob = { text: string; maximum: number; replacement?: string; expand?: boolean; maxSize?: number };
type Span = { offset: number; length: number };
export type MatchResult = { spans: Span[]; more: boolean } | { count: number; text?: string };

function substitution(match: RegExpMatchArray, token: string, key: string): string {
	if (key === "$") return "$";
	if (key === "&") return match[0];
	if (key.startsWith("<")) return match.groups ? (match.groups[key.slice(1, -1)] ?? "") : token;
	const index = Number(key);
	if (index > 0 && index < match.length) return match[index] ?? "";
	const first = Number(key[0]);
	return key.length === 2 && first > 0 && first < match.length ? (match[first] ?? "") + key[1] : token;
}

function findSpans(matches: Iterable<RegExpExecArray>, maximum: number): MatchResult {
	const spans: Span[] = [];
	for (const match of matches) {
		if (spans.length === maximum) return { spans, more: true };
		spans.push({ offset: match.index, length: match[0].length });
	}
	return { spans, more: false };
}

function replaceSpans(matches: Iterable<RegExpExecArray>, replacement: string, job: MatchJob): MatchResult {
	const maxSize = job.maxSize ?? 0;
	const template = job.expand ? [...replacement.matchAll(/\$([$&]|[0-9][0-9]?|<[^>]*>)/gu)] : [];
	const parts: string[] = [];
	let end = 0;
	let size = 0;
	let count = 0;
	const add = (text: string) => {
		size += text.length;
		if (size > maxSize) return false;
		if (text) parts.push(text);
		return true;
	};
	const insert = (match: RegExpExecArray) => {
		let at = 0;
		for (const item of template) {
			if (!add(replacement.slice(at, item.index)) || !add(substitution(match, item[0], item[1]))) return false;
			at = item.index + item[0].length;
		}
		return add(replacement.slice(at));
	};
	for (const match of matches) {
		if (++count > job.maximum || !add(job.text.slice(end, match.index)) || !insert(match)) return { count };
		end = match.index + match[0].length;
	}
	return add(job.text.slice(end)) ? { count, text: parts.join("") } : { count };
}

export function matchText(pattern: RegExp, job: MatchJob): MatchResult {
	const matches = job.text.matchAll(pattern);
	return job.replacement === undefined ? findSpans(matches, job.maximum) : replaceSpans(matches, job.replacement, job);
}

// JavaScript regex evaluation is not interruptible in the host thread.
const port = workerData === MATCH_WORKER ? parentPort : null;
port?.on("message", ({ source, flags, job }: Pattern & { job: MatchJob }) => {
	port.postMessage(matchText(new RegExp(source, flags), job));
});
