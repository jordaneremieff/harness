import { extname, matchesGlob, normalize } from "node:path";
import {
	type Detector,
	type Entry,
	type Fence,
	type Scope,
	closingFence,
	firstSentence,
	openingFence,
} from "./catalog.ts";

export type ProseKind = "reply" | "document" | "commit";
export const proseKinds = ["reply", "document", "commit"] as const;
export type ScopedLine = { scope: Scope; path?: string; line: number; text: string; commit?: string; part?: number };
export type Input = { kind: ProseKind; text: string; path?: string } | { kind: "file"; text: string; path: string };

const cFamily = new Set(
	"c h cc cpp cxx hpp cs java js jsx mjs cjs ts tsx mts cts go rs swift kt kts scala css scss less dart php vue svelte".split(
		" ",
	),
);
const hashFamily = new Set("py pyi rb sh bash zsh fish yaml yml toml r pl pm ex exs make mk dockerfile".split(" "));
const markupFamily = new Set("html htm xml svg xhtml".split(" "));
const blockOnly = new Set(["css"]);

const hidden = "\u0000";
// Repetitions before a required character stay bounded, so a long line without that character scans in linear time.
const inlineTokens =
	/\\.|(`+)|(!?\[[^\]]{0,1000}\]\()|(?:[a-z][a-z0-9+.-]{0,31}:\/\/|www\.)[^\s<>]+|<[^ <>@]{1,200}@[^ <>@]{1,200}>|<!--/gi;

function endOfSpan(line: string, start: number, size: number): number | undefined {
	const closing = /`+/g;
	closing.lastIndex = start;
	for (let match = closing.exec(line); match; match = closing.exec(line))
		if (match[0].length === size) return closing.lastIndex;
}
function endOfLink(line: string, start: number): number | undefined {
	let depth = 1;
	for (let i = start; i < line.length; i++) {
		const char = line[i];
		if (char === "\\") i++;
		else if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return i;
	}
}

function inlineRange(line: string, token: RegExpExecArray, end: number): [number, number] | undefined {
	const [mark, code, link] = token;
	if (mark.startsWith("\\")) return;
	if (code) {
		const finish = endOfSpan(line, end, code.length);
		return finish === undefined ? undefined : [token.index, finish];
	}
	if (link) {
		const finish = endOfLink(line, end);
		return finish === undefined ? undefined : [end, finish];
	}
	return [token.index, end - (mark.match(/[.,:;!?)]*$/)?.[0].length ?? 0)];
}

class ProseReader {
	private fence?: Fence;
	private comment = false;

	read(line: string): string | undefined {
		if (!this.comment && /^\s*>/.test(line)) return;
		if (this.fence) {
			if (closingFence(line, this.fence)) this.fence = undefined;
			return;
		}
		if (!this.comment) this.fence = openingFence(line);
		if (this.fence) return;
		const masked = this.mask(line);
		if (!masked.includes(hidden) || masked.replaceAll(hidden, "").trim()) return masked;
	}

	private commentEnd(line: string, start: number) {
		const close = line.indexOf("-->", start);
		this.comment = close < 0;
		return this.comment ? line.length : close + 3;
	}
	private mask(line: string) {
		const tokens = new RegExp(inlineTokens);
		let offset = this.comment ? this.commentEnd(line, 0) : 0;
		let output = hidden.repeat(offset);
		tokens.lastIndex = offset;
		for (let token = tokens.exec(line); token; token = tokens.exec(line)) {
			const range =
				token[0] === "<!--"
					? [token.index, this.commentEnd(line, tokens.lastIndex)]
					: inlineRange(line, token, tokens.lastIndex);
			if (!range) continue;
			const [start, end] = range;
			output += line.slice(offset, start) + hidden.repeat(end - start);
			tokens.lastIndex = offset = end;
		}
		return output + line.slice(offset);
	}
}
function frontmatterEnd(lines: string[]) {
	if (!/^---\s*$/.test(lines[0] ?? "")) return -1;
	return lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
}
function proseLines(lines: string[], scope: ProseKind): ScopedLine[] {
	const reader = new ProseReader();
	const start = frontmatterEnd(lines) + 1;
	const result: ScopedLine[] = [];
	for (let index = start; index < lines.length; index++) {
		const text = reader.read(lines[index]);
		if (text !== undefined) result.push({ scope, line: index + 1, text });
	}
	return result;
}

type Family = "hash" | "c" | "markup";
class CodeReader {
	private block = false;
	private quote = "";
	private readonly tokens: RegExp;
	private readonly blockStart: string;
	private readonly blockEnd: string;
	private readonly family: Family;
	private readonly ext: string;
	constructor(family: Family, ext: string) {
		this.family = family;
		this.ext = ext;
		this.tokens = family === "c" ? /\/\/|\/\*|["'`]/g : family === "hash" ? /["'`#]/g : /<!--|["']/g;
		this.blockStart = family === "markup" ? "<!--" : "/*";
		this.blockEnd = family === "markup" ? "-->" : "*/";
	}
	private unquote(line: string, offset: number): number {
		for (let i = offset; i < line.length; i++) {
			if (line[i] === "\\") {
				i++;
				continue;
			}
			if (!line.startsWith(this.quote, i)) continue;
			const end = i + this.quote.length;
			this.quote = "";
			return end;
		}
		return line.length;
	}
	private openQuote(line: string, start: number, quote: string): number {
		const end = start + quote.length;
		if (this.family === "markup" && line.lastIndexOf("<", start) <= line.lastIndexOf(">", start)) return end;
		if ((this.ext === "py" || this.ext === "pyi") && line.startsWith(quote.repeat(2), end)) {
			this.quote = quote.repeat(3);
			return end + 2;
		}
		this.quote = quote;
		return end;
	}
	private readBlock(line: string, start: number, push: (scope: "comment", text: string) => void): number {
		const close = line.indexOf(this.blockEnd, start);
		this.block = close < 0;
		const content = line.slice(start, this.block ? line.length : close);
		push("comment", start === 0 && this.family === "c" ? content.replace(/^(\s*)\*(?!\*) ?/, "$1") : content);
		return this.block ? line.length : close + this.blockEnd.length;
	}
	private lineComment(mark: string) {
		return mark === "#" || (mark === "//" && !blockOnly.has(this.ext));
	}
	private startBlock(line: string, end: number) {
		this.block = true;
		return this.family === "c" && line[end] === "*" && line[end + 1] !== "/" ? end + 1 : end;
	}
	private endQuote(line: string) {
		if (this.quote.length === 1 && this.quote !== "`" && this.family !== "markup" && !line.endsWith("\\"))
			this.quote = "";
	}
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: quote and comment transitions share one cursor.
	read(line: string, number: number): ScopedLine[] {
		const result: ScopedLine[] = [];
		const push = (scope: "code" | "comment", text: string) => {
			if (text.trim()) result.push({ scope, line: number, text });
		};
		if (number === 1 && line.startsWith("#!")) {
			push("code", line);
			return result;
		}
		let i = 0;
		let codeStart = 0;
		while (i < line.length) {
			if (this.block) {
				i = codeStart = this.readBlock(line, i, push);
				continue;
			}
			if (this.quote) {
				i = this.unquote(line, i);
				continue;
			}
			this.tokens.lastIndex = i;
			const match = this.tokens.exec(line);
			if (!match) break;
			i = this.tokens.lastIndex;
			const mark = match[0];
			if (this.family !== "hash" && mark === this.blockStart) {
				push("code", line.slice(codeStart, match.index));
				i = this.startBlock(line, i);
				codeStart = line.length;
			} else if (this.lineComment(mark)) {
				push("code", line.slice(codeStart, match.index));
				push("comment", line.slice(i));
				codeStart = line.length;
				break;
			} else if (mark !== "//") i = this.openQuote(line, match.index, mark);
		}
		push("code", line.slice(codeStart));
		this.endQuote(line);
		return result;
	}
}
function codeLines(lines: string[], family: Family, ext: string): ScopedLine[] {
	const reader = new CodeReader(family, ext);
	return lines.flatMap((line, index) => reader.read(line, index + 1));
}

const documentExtensions = new Set(["md", "markdown", "mdx", "txt"]);
function extension(path: string) {
	return (extname(path).slice(1) || path.split("/").at(-1) || "").toLowerCase();
}
export function fileKind(path: string): Family | "document" | undefined {
	const ext = extension(path);
	if (documentExtensions.has(ext)) return "document";
	if (cFamily.has(ext)) return "c";
	if (hashFamily.has(ext)) return "hash";
	if (markupFamily.has(ext)) return "markup";
}

export function segment(input: Input): ScopedLine[] {
	const lines = input.text.split(/\r?\n/);
	if (input.kind !== "file") return proseLines(lines, input.kind).map((line) => ({ ...line, path: input.path }));
	const kind = fileKind(input.path);
	if (!kind) return [];
	const scoped = kind === "document" ? proseLines(lines, kind) : codeLines(lines, kind, extension(input.path));
	return scoped.map((line) => ({ ...line, path: input.path }));
}

export type Location = { commit?: string; path?: string; line: number; match: string; excerpt: string };
export type Finding = {
	id: string;
	title: string;
	detector: string;
	count: number;
	allowance: number;
	locations: Location[];
	repair: string;
};
const words = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;
const wholeWord = "[\\p{L}\\p{M}\\p{N}\\p{Pc}]";
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const short = (text: string, size: number) => (text.length <= size ? text : `${text.slice(0, size - 1)}…`);

function matchPath(detector: Detector, example: boolean) {
	const globs = detector.paths;
	const cache = new Map<string, boolean>();
	return (path: string | undefined) => {
		if (!globs || example) return true;
		if (path === undefined) return false;
		const cached = cache.get(path);
		if (cached !== undefined) return cached;
		const name = normalize(path);
		const matches = globs.some((glob) => matchesGlob(name, glob));
		cache.set(path, matches);
		return matches;
	};
}

function candidateRegex(detector: Detector) {
	const phrases = detector.phrases
		?.toSorted((a, b) => b.length - a.length)
		.map((phrase) => phrase.trim().split(/\s+/).map(escapeRegex).join("\\s+"))
		.join("|");
	return new RegExp(
		detector.pattern ?? `(?<!${wholeWord})(?:${phrases})(?!${wholeWord})`,
		detector.caseSensitive ? "gu" : "giu",
	);
}
function locationFor(line: ScopedLine, match: RegExpExecArray): Location {
	const start = Math.max(0, match.index - 36);
	const excerpt = line.text
		.slice(start, start + 140)
		.replaceAll(hidden, " ")
		.trim();
	return {
		...(line.commit === undefined ? {} : { commit: line.commit }),
		...(line.path === undefined ? {} : { path: line.path }),
		line: line.line,
		match: short(match[0], 100),
		excerpt: `${start ? "…" : ""}${excerpt}${start + 140 < line.text.length ? "…" : ""}`,
	};
}
function acceptedMatch(
	detector: Detector,
	allow: Set<string>,
	lexicon: Set<string>,
	seen: Set<string>,
	raw: string,
): boolean {
	if (raw.includes(hidden)) return false;
	const key = raw.toLowerCase();
	if (allow.has(key) || (detector.lexicon && lexicon.has(key))) return false;
	if (!detector.distinct) return true;
	if (seen.has(key)) return false;
	seen.add(key);
	return true;
}

function detectorMatches(detector: Detector, lines: ScopedLine[], lexicon: Set<string>, example = false) {
	const allow = new Set(detector.allow?.map((text) => text.toLowerCase()));
	const matchesPath = matchPath(detector, example);
	const regex = candidateRegex(detector);
	const seen = new Set<string>();
	const locations: Location[] = [];
	let count = 0;
	let wordCount = 0;
	for (const line of lines) {
		if (!detector.in.includes(line.scope) || !matchesPath(line.path)) continue;
		if (detector.per) wordCount += countWords(line.text);
		for (const match of line.text.matchAll(regex)) {
			if (!acceptedMatch(detector, allow, lexicon, seen, match[0])) continue;
			count++;
			if (locations.length < 20) locations.push(locationFor(line, match));
		}
	}
	const limit = detector.limit ?? 0;
	const allowance = allowanceFor(limit, detector.per, wordCount);
	return { locations, count, allowance };
}
function allowanceFor(limit: number, per: number | undefined, words: number) {
	return per ? Math.max(limit, Math.floor((limit * words) / per)) : limit;
}
function countWords(text: string) {
	let count = 0;
	for (const _ of text.matchAll(words)) count++;
	return count;
}

export function checkLines(entries: Entry[], lines: ScopedLine[], lexicon: Set<string>): Finding[] {
	return entries.flatMap((entry) =>
		entry.detectors.flatMap((detector) => {
			const result = detectorMatches(detector, lines, lexicon);
			return result.count > result.allowance
				? [{ id: entry.id, title: entry.title, detector: detector.id, repair: firstSentence(entry.repair), ...result }]
				: [];
		}),
	);
}

export function testExamples(entry: Entry, lexicon = new Set<string>()) {
	const untested = new Set(entry.detectors.map(({ id }) => id));
	const failures: string[] = [];
	const unmatched: string[] = [];
	for (const [i, { kind, text, verdict }] of entry.examples.entries()) {
		const prose = proseKinds.find((scope) => scope === kind);
		const lines = segment(prose ? { kind: prose, text } : { kind: "file", path: `example.${kind}`, text });
		const matched = entry.detectors
			.filter((detector) => detectorMatches(detector, lines, lexicon, true).count > 0)
			.map((detector) => detector.id);
		const label = `Example ${i + 1} (${verdict}, ${kind})`;
		if (verdict === "slop") {
			for (const id of matched) untested.delete(id);
			if (!matched.length) unmatched.push(label);
		} else if (matched.length) failures.push(`${label}: matched ${matched.join(", ")}.`);
	}
	for (const id of untested) failures.push(`Detector ${id}: no matching Slop example.`);
	return { failures, unmatched };
}
