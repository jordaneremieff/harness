// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import { type Extracted, type Kind, type LineInfo, type LineKind, lineOf, type Unit } from "./extract.mts";
import type { CompiledRule, Rule, Severity } from "./rules.mts";
import { countWords, splitSentences } from "./textstats.mts";

export interface Options {
	spelling: "au" | "off";
	times: "12h" | "off";
	strictSemicolons: boolean;
}

export const DEFAULT_OPTIONS: Options = { spelling: "au", times: "off", strictSemicolons: false };

export interface Hit {
	rule: Rule;
	severity: Severity;
	start: number;
	end: number;
	text: string;
}

export interface Doc {
	ex: Extracted;
	words: number;
	wordStarts: number[];
	sentenceLengths: number[];
	sentenceCount: number;
}

const MAX_HITS_PER_RULE = 5000;
const FRAGMENT_EXEMPT = new Set(["yes", "no", "done", "ok", "okay", "thanks", "correct", "agreed", "confirmed"]);
const TRIAD_STOP = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"not",
	"for",
	"with",
	"from",
	"this",
	"that",
	"these",
	"those",
	"his",
	"her",
	"its",
	"our",
	"your",
	"their",
]);
const TRIAD = /(?<![\p{L}\p{N}_-])([\p{L}][\p{L}'’-]*),[ \t]+([\p{L}][\p{L}'’-]*),[ \t]+(?:and|or)[ \t]+([\p{L}][\p{L}'’-]*)(?![\p{L}\p{N}_-])/gu;
const BULLET = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)/;
const LABEL_MD = /^(\*\*|__)(?!\s)([^\n]{1,80}?)\1(:|[ \t]+[-\u2013\u2014][ \t]+)?/;
const LABEL_HTML = /<li[^>]*>[ \t]*<(b|strong)>([^<]{1,80})<\/\1>[ \t]*([:\-\u2013\u2014])?/i;
const SEE_ALSO = /^(?:[ \t]{0,3}#{1,6}[ \t]+|[ \t]*<h[1-6][^>]*>[ \t]*)See[ \t]+Also\b/i;
const SKIPPED_LINES: ReadonlySet<LineKind> = new Set<LineKind>(["code", "meta", "blank", "rule"]);
const BOLD_SPAN = /\*\*[^*\n]+\*\*|__[^_\n]+__/g;

function numberParam(rule: Rule, key: string, fallback: number): number {
	const value = rule.params?.[key];
	return typeof value === "number" ? value : fallback;
}

export function buildDoc(ex: Extracted): Doc {
	const wordStarts: number[] = [];
	let words = 0;
	const sentenceLengths: number[] = [];
	for (const unit of ex.units) {
		for (const match of unit.text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)) {
			wordStarts.push(unit.start + match.index);
			words += 1;
		}
		if (unit.kind === "heading") continue;
		for (const span of splitSentences(unit.text)) sentenceLengths.push(countWords(unit.text.slice(span.start, span.end)));
	}
	return { ex, words, wordStarts, sentenceLengths, sentenceCount: sentenceLengths.length };
}

function touchesLines(ex: Extracted, start: number, end: number, keep: ReadonlySet<number>): boolean {
	const last = lineOf(ex.lineStarts, Math.max(start, end - 1));
	for (let line = lineOf(ex.lineStarts, start); line <= last; line++) if (keep.has(line)) return true;
	return false;
}

/** Restrict an extraction to the given 1-based source lines. */
export function restrictToLines(ex: Extracted, keep: ReadonlySet<number>): Extracted {
	return {
		...ex,
		units: ex.units.filter((unit) => touchesLines(ex, unit.start, unit.end, keep)),
		links: ex.links.filter((link) => keep.has(lineOf(ex.lineStarts, link.start))),
		lines: ex.lines.map((line, index) => (keep.has(index + 1) ? line : { ...line, kind: "meta" as const })),
	};
}

/** Smallest region around a hit that exemptions may read: its unit, or its line when it lies outside every unit. */
function regionAround(ex: Extracted, start: number, end: number): { lo: number; hi: number } {
	let low = 0;
	let high = ex.units.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const unit = ex.units[mid];
		if (unit === undefined) break;
		if (end <= unit.start) high = mid - 1;
		else if (start >= unit.end) low = mid + 1;
		else return { lo: unit.start, hi: unit.end };
	}
	const line = lineOf(ex.lineStarts, start);
	const nextStart = ex.lineStarts[line];
	return { lo: ex.lineStarts[line - 1] ?? 0, hi: nextStart === undefined ? ex.text.length : nextStart - 1 };
}

const SENTENCE_BREAK = /[.!?]["')\]]*\s+/g;

/** The hit's own sentence, clipped to its region and to a fixed number of characters either side. */
function exemptionWindow(view: string, region: { lo: number; hi: number }, start: number, end: number): { text: string; from: number } {
	let from = Math.max(region.lo, start - 80);
	let to = Math.min(region.hi, end + 80, view.length);
	let breakEnd = from;
	for (const match of view.slice(from, start).matchAll(SENTENCE_BREAK)) breakEnd = from + match.index + match[0].length;
	from = breakEnd;
	const tail = /[.!?](?=\s|$)/.exec(view.slice(end, to));
	if (tail !== null) to = end + tail.index + 1;
	return { text: view.slice(from, to), from };
}

function twinned(c: CompiledRule, ex: Extracted, view: string, start: number, end: number): boolean {
	if (c.twins.length === 0 && c.contexts.length === 0) return false;
	const { text, from } = exemptionWindow(view, regionAround(ex, start, end), start, end);
	const s = start - from;
	const e = end - from;
	for (const context of c.contexts) if (text.search(context) !== -1) return true;
	for (const twin of c.twins) {
		for (const match of text.matchAll(twin)) {
			const ms = match.index;
			const me = ms + match[0].length;
			if (me !== ms && ms < e && me > s) return true;
		}
	}
	return false;
}

function activeFor(rule: Rule, kind: Kind, options: Options): boolean {
	if (rule.kinds !== undefined && !rule.kinds.includes(kind)) return false;
	if (rule.option === "spelling" && options.spelling !== "au") return false;
	if (rule.option === "times" && options.times !== "12h") return false;
	return true;
}

type Range = { start: number; end: number };

function htmlLabel(ex: Extracted, line: LineInfo): Range | null {
	const html = LABEL_HTML.exec(ex.raw.slice(line.start, line.end));
	if (html === null) return null;
	const labelled = (html[2] ?? "").trimEnd().endsWith(":") || html[3] !== undefined;
	return labelled ? { start: line.start + html.index, end: line.start + html.index + html[0].length } : null;
}

function markdownLabel(ex: Extracted, line: LineInfo): Range | null {
	const text = ex.raw.slice(line.start, line.end);
	const bullet = BULLET.exec(text);
	const label = bullet === null ? null : LABEL_MD.exec(text.slice(bullet[0].length));
	if (bullet === null || label === null) return null;
	const labelled = (label[2] ?? "").trimEnd().endsWith(":") || label[3] !== undefined;
	if (!labelled) return null;
	const start = line.start + bullet[0].length;
	return { start, end: start + label[0].length };
}

function boldLabelHits(ex: Extracted): Range[] {
	const out: Range[] = [];
	for (const line of ex.lines) {
		if (SKIPPED_LINES.has(line.kind)) continue;
		const hit = htmlLabel(ex, line) ?? markdownLabel(ex, line);
		if (hit !== null) out.push(hit);
	}
	return out;
}

function seeAlsoHits(ex: Extracted): Range[] {
	const out: Range[] = [];
	const limit = Math.max(3, Math.ceil(ex.lines.length * 0.25));
	ex.lines.forEach((line, index) => {
		if (index >= limit || line.kind === "code" || line.kind === "meta") return;
		const match = SEE_ALSO.exec(ex.raw.slice(line.start, line.end));
		if (match !== null) out.push({ start: line.start, end: line.end });
	});
	return out;
}

function triadHits(ex: Extracted): Range[] {
	const out: Range[] = [];
	for (const unit of ex.units) {
		for (const match of unit.text.matchAll(TRIAD)) {
			const items = [match[1], match[2], match[3]].map((item) => item ?? "");
			if (items.some((item) => item.length < 3 || TRIAD_STOP.has(item.toLowerCase()))) continue;
			const firstUpper = /^\p{Lu}/u.test(items[0] ?? "");
			if (firstUpper && match.index !== 0) continue;
			if (items.slice(1).some((item) => /^\p{Lu}/u.test(item))) continue;
			out.push({ start: unit.start + match.index, end: unit.start + match.index + match[0].length });
		}
	}
	return out;
}

const PUNCH_TAG =
	/^(?:that|this|which|it)\s+(?:is|was|['\u2019]s)\s+(?:the\s+)?(?:whole\s+|entire\s+)?(?:point|idea|trick|catch|difference|problem|reason|thing)[.!]["')\]]*$/i;

/** A short sentence after a long one, or a one-line tag such as "That is the point." after any sentence. */
function isFragment(text: string, previousWords: number, maxWords: number, minPrevious: number): boolean {
	const count = countWords(text);
	if (count < 1 || !/[.!]["')\]]*$/.test(text)) return false;
	if (PUNCH_TAG.test(text.trim())) return true;
	if (count > maxWords || previousWords < minPrevious) return false;
	return !(count === 1 && FRAGMENT_EXEMPT.has(text.replace(/[^\p{L}]/gu, "").toLowerCase()));
}

function fragmentsIn(unit: Unit, maxWords: number, minPrevious: number): Range[] {
	const out: Range[] = [];
	const spans = splitSentences(unit.text);
	for (let i = 1; i < spans.length; i++) {
		const span = spans[i];
		const previous = spans[i - 1];
		if (span === undefined || previous === undefined) continue;
		const text = unit.text.slice(span.start, span.end);
		const previousWords = countWords(unit.text.slice(previous.start, previous.end));
		if (!isFragment(text, previousWords, maxWords, minPrevious)) continue;
		if (unit.literal.slice(span.start, span.end) !== text) continue;
		out.push({ start: unit.start + span.start, end: unit.start + span.end });
	}
	return out;
}

function punchFragmentHits(ex: Extracted, rule: Rule): Range[] {
	const maxWords = numberParam(rule, "maxWords", 3);
	const minPrevious = numberParam(rule, "minPrevious", 10);
	return ex.units
		.filter((unit) => unit.kind !== "heading" && unit.kind !== "table")
		.flatMap((unit) => fragmentsIn(unit, maxWords, minPrevious));
}

function boldDensityHits(doc: Doc, rule: Rule): Range[] {
	const { ex } = doc;
	let count = 0;
	let first: Range | null = null;
	for (const line of ex.lines) {
		if (SKIPPED_LINES.has(line.kind)) continue;
		const text = ex.raw.slice(line.start, line.end);
		for (const match of text.matchAll(BOLD_SPAN)) {
			count += 1;
			first ??= { start: line.start + match.index, end: line.start + match.index + match[0].length };
		}
	}
	const minSpans = numberParam(rule, "minSpans", 4);
	const maxPer100 = numberParam(rule, "maxPer100", 3);
	if (first === null || count < minSpans || doc.words === 0) return [];
	return (count * 100) / doc.words > maxPer100 ? [first] : [];
}

function headingDensityHits(doc: Doc, rule: Rule): Range[] {
	const headings = doc.ex.units.filter((unit) => unit.kind === "heading");
	const first = headings[0];
	if (first === undefined || headings.length < numberParam(rule, "minHeadings", 3) || doc.words === 0) return [];
	return (headings.length * 100) / doc.words > numberParam(rule, "maxPer100", 3) ? [{ start: first.start, end: first.end }] : [];
}

function codeChipSoupHits(ex: Extracted, rule: Rule): Range[] {
	const out: Range[] = [];
	const minChips = numberParam(rule, "minChips", 3);
	for (const line of ex.lines) {
		if (SKIPPED_LINES.has(line.kind)) continue;
		const text = ex.text.slice(line.start, line.end);
		const chips = text.match(/`[^`\n]+`/g)?.length ?? 0;
		const bare = text.replace(/`[^`\n]+`/g, "");
		if (chips >= minChips && bare.includes(":") && text.includes("|")) out.push({ start: line.start, end: line.end });
	}
	return out;
}

function denseBlockHits(ex: Extracted, rule: Rule): Range[] {
	const out: Range[] = [];
	const maxWords = numberParam(rule, "maxWords", 160);
	for (const unit of ex.units) {
		if (unit.kind !== "para" && unit.kind !== "quote" && unit.kind !== "html") continue;
		if (countWords(unit.text) > maxWords) out.push({ start: unit.start, end: Math.min(unit.end, unit.start + 40) });
	}
	return out;
}

function commitSubject(ex: Extracted): Range | null {
	for (const line of ex.lines) {
		if (line.kind === "blank") continue;
		const raw = ex.text.slice(line.start, line.end);
		if (raw.trim() === "") continue;
		return { start: line.start, end: line.start + raw.trimEnd().length };
	}
	return null;
}

const CONVENTIONAL_PREFIX = /^(?:[a-z]+(?:\([^)\n]*\))?!?:\s+)/;
const GENERIC_SUBJECT =
	/^(?:updates?|updated|changes?|changed|fix(?:es|ed)?|misc|wip|stuff|cleanups?|tweaks?|minor(?:\s+(?:changes?|fixes|updates?))?|various(?:\s+(?:fixes|changes|updates?))?|refactor(?:ing)?|improvements?)(?:\s+(?:stuff|things|code|files?|it|changes?|issues?|bugs?|updates?))?\.?$/i;
const NARRATED_SUBJECT = /^(?:I|I've|I'm|I'd|We|We've|We're|Let me|Let's|This (?:commit|change|patch|PR|pull request))\b/;

function commitHits(ex: Extracted, rule: Rule): Range[] {
	const range = commitSubject(ex);
	if (range === null) return [];
	const subject = ex.text.slice(range.start, range.end);
	switch (rule.detector) {
		case "commit-subject-length":
			return [...subject].length > numberParam(rule, "max", 72) ? [range] : [];
		case "commit-subject-period":
			return /[\p{L}\p{N})'"\]`]\.$/u.test(subject) ? [range] : [];
		case "commit-subject-generic":
			return GENERIC_SUBJECT.test(subject.replace(CONVENTIONAL_PREFIX, "")) ? [range] : [];
		case "commit-subject-narrated":
			return NARRATED_SUBJECT.test(subject.replace(CONVENTIONAL_PREFIX, "")) ? [range] : [];
		default:
			return [];
	}
}

function detectorRanges(c: CompiledRule, doc: Doc): Range[] {
	const { ex } = doc;
	switch (c.rule.detector) {
		case "bold-label":
			return boldLabelHits(ex);
		case "see-also-top":
			return seeAlsoHits(ex);
		case "link-bare-url":
			return ex.links.filter((link) => link.kind === "bare");
		case "link-autolink":
			return ex.links.filter((link) => link.kind === "autolink");
		case "link-url-anchor":
			return ex.links.filter((link) => link.kind === "url-anchor");
		case "triad":
			return triadHits(ex);
		case "punch-fragment":
			return punchFragmentHits(ex, c.rule);
		case "bold-density":
			return boldDensityHits(doc, c.rule);
		case "code-chip-soup":
			return codeChipSoupHits(ex, c.rule);
		case "heading-density":
			return headingDensityHits(doc, c.rule);
		case "dense-block":
			return denseBlockHits(ex, c.rule);
		default:
			return commitHits(ex, c.rule);
	}
}

function patternRanges(c: CompiledRule, ex: Extracted): Range[] {
	const regex = c.regex;
	if (regex === undefined) return [];
	const scope = c.rule.scope ?? "prose";
	const out: Range[] = [];
	const run = (text: string, base: number): void => {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null = regex.exec(text);
		while (match !== null && out.length < MAX_HITS_PER_RULE) {
			if (match[0].length === 0) {
				regex.lastIndex += 1;
			} else {
				out.push({ start: base + match.index, end: base + match.index + match[0].length });
			}
			match = regex.exec(text);
		}
	};
	if (scope === "line") {
		for (const line of ex.lines) {
			if (SKIPPED_LINES.has(line.kind)) continue;
			run(ex.raw.slice(line.start, line.end), line.start);
		}
	} else {
		for (const unit of ex.units) run(scope === "literal" ? unit.literal : unit.text, unit.start);
	}
	return out;
}

function viewFor(c: CompiledRule, ex: Extracted): string {
	if (c.rule.detector !== undefined && c.rule.detector !== "triad" && c.rule.detector !== "punch-fragment") return ex.raw;
	const scope = c.rule.scope ?? "prose";
	if (scope === "line") return ex.raw;
	return scope === "literal" ? ex.literal : ex.prose;
}

/** Keep the highest-priority hit where spans overlap, so one phrase counts once within a component. */
export function dedupeScored(hits: Hit[]): Hit[] {
	const priority = [...hits].sort((a, b) => {
		const wa = a.rule.weight ?? 0;
		const wb = b.rule.weight ?? 0;
		if (wa !== wb) return wb - wa;
		const la = a.end - a.start;
		const lb = b.end - b.start;
		if (la !== lb) return lb - la;
		return a.start - b.start;
	});
	const kept: Hit[] = [];
	const overlaps = (hit: Hit): boolean => {
		let low = 0;
		let high = kept.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if ((kept[mid]?.start ?? 0) < hit.start) low = mid + 1;
			else high = mid;
		}
		const before = kept[low - 1];
		const after = kept[low];
		return (before !== undefined && before.end > hit.start) || (after !== undefined && after.start < hit.end);
	};
	for (const hit of priority) {
		if (overlaps(hit)) continue;
		let low = 0;
		let high = kept.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if ((kept[mid]?.start ?? 0) < hit.start) low = mid + 1;
			else high = mid;
		}
		kept.splice(low, 0, hit);
	}
	return kept;
}

const MENTION_QUOTES: Readonly<Record<string, string>> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
const MAX_MENTION_CHARS = 80;
const MAX_MENTION_WORDS = 6;
const CLAUSE_HEAD = /^(?:(?:i|we|you|he|she|it|they|this|that|these|those)\s+(?:am|is|are|was|were|have|has|had|do|does|did|can|could|will|would|should|must)\b|(?:i|we|you|he|she|it|they|this|that|these|those)['’](?:s|re|ve|d|ll)\b)/iu;

/** A lexical mention occupies its whole short quote, never just part of a quoted clause. */
function quotedMention(ex: Extracted, range: Range): boolean {
	if (range.end - range.start > MAX_MENTION_CHARS) return false;
	const term = ex.raw.slice(range.start, range.end);
	if (/[\n.!?;:]/u.test(term) || CLAUSE_HEAD.test(term) || countWords(term) > MAX_MENTION_WORDS) return false;
	let start = range.start;
	let end = range.end;
	while (start > 0 && range.start - start < MAX_MENTION_CHARS && /[ \t]/u.test(ex.raw[start - 1] ?? "")) start -= 1;
	while (end < ex.raw.length && end - range.end < MAX_MENTION_CHARS && /[ \t]/u.test(ex.raw[end] ?? "")) end += 1;
	const open = ex.raw[start - 1] ?? "";
	const close = ex.raw[end] ?? "";
	if (MENTION_QUOTES[open] !== close) return false;
	return !/[\p{L}\p{N}_]/u.test(ex.raw[start - 2] ?? "") && !/[\p{L}\p{N}_]/u.test(ex.raw[end + 1] ?? "");
}

function hitsForRule(c: CompiledRule, doc: Doc, options: Options): Hit[] {
	const { ex } = doc;
	const rule = c.rule;
	const severity: Severity =
		options.strictSemicolons && rule.strictSeverity !== undefined ? rule.strictSeverity : rule.severity;
	const ranges = rule.detector !== undefined ? detectorRanges(c, doc) : patternRanges(c, ex);
	const view = viewFor(c, ex);
	const seen = new Set<string>();
	const hits: Hit[] = [];
	for (const range of ranges) {
		if (rule.group === "lexical" && quotedMention(ex, range)) continue;
		if (twinned(c, ex, view, range.start, range.end)) continue;
		const text = ex.text.slice(range.start, range.end);
		const key = text.toLowerCase();
		if (rule.firstOnly === true && seen.has(key)) continue;
		seen.add(key);
		hits.push({ rule, severity, start: range.start, end: range.end, text });
	}
	return hits;
}

function collectHits(doc: Doc, compiled: CompiledRule[], options: Options): { hard: Hit[]; scored: Hit[] } {
	const all = compiled
		.filter((c) => activeFor(c.rule, doc.ex.kind, options))
		.flatMap((c) => hitsForRule(c, doc, options));
	return { hard: all.filter((hit) => hit.severity === "hard"), scored: all.filter((hit) => hit.severity === "scored") };
}

const COMPONENT_ORDER = ["lexical", "geometry", "epistemic", "laundering"];

export function detect(doc: Doc, compiled: CompiledRule[], options: Options): Hit[] {
	const { hard, scored } = collectHits(doc, compiled, options);
	const free = scored.filter((hit) => !hard.some((other) => other.start < hit.end && hit.start < other.end));
	const advisory = free.filter((hit) => hit.rule.component === "none");
	const counted = COMPONENT_ORDER.flatMap((component) =>
		dedupeScored(free.filter((hit) => hit.rule.component === component)),
	);
	return [...hard, ...counted, ...advisory].sort((a, b) => a.start - b.start || a.end - b.end);
}
