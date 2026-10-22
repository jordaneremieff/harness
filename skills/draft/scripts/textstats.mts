// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;
const ABBREVIATIONS = new Set([
	"mr",
	"mrs",
	"ms",
	"dr",
	"prof",
	"sr",
	"jr",
	"vs",
	"etc",
	"e.g",
	"i.e",
	"approx",
	"no",
	"fig",
	"st",
	"cf",
	"al",
	"inc",
	"ltd",
]);

export interface Span {
	start: number;
	end: number;
}

export function wordSpans(text: string): Span[] {
	const spans: Span[] = [];
	for (const match of text.matchAll(WORD)) spans.push({ start: match.index, end: match.index + match[0].length });
	return spans;
}

export function countWords(text: string): number {
	let count = 0;
	for (const _ of text.matchAll(WORD)) count += 1;
	return count;
}

const SENTENCE_END = /[.!?]+["')\]]*(?=\s+["'([]*[\p{Lu}\p{N}])/gu;

/** Split one prose unit into sentence spans. A unit without terminal punctuation is one sentence. */
export function splitSentences(text: string): Span[] {
	const spans: Span[] = [];
	let from = 0;
	for (const match of text.matchAll(SENTENCE_END)) {
		const end = match.index + match[0].length;
		const before = text.slice(from, match.index).match(/[\p{L}.]+$/u);
		if (before !== null && ABBREVIATIONS.has(before[0].toLowerCase().replace(/\.$/, ""))) continue;
		pushSpan(spans, text, from, end);
		from = end;
	}
	pushSpan(spans, text, from, text.length);
	return spans;
}

function pushSpan(spans: Span[], text: string, from: number, to: number): void {
	let start = from;
	let end = to;
	while (start < end && /\s/.test(text[start] ?? "")) start += 1;
	while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
	if (end > start && countWords(text.slice(start, end)) > 0) spans.push({ start, end });
}
