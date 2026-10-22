// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import { type BlockOpts, type BlockResult, type RawUnit, runBlocks } from "./blocks.mts";
import { cleanSourceComments, sourceComments } from "./source-comments.mts";
import { blankAll, blankText, makeViews, trimUrl, type Views } from "./views.mts";

export type Kind = "md" | "html" | "text" | "ts" | "js" | "commit";
export type LineKind = "blank" | "code" | "meta" | "heading" | "list" | "table" | "quote" | "para" | "rule";
export type UnitKind = "para" | "list" | "heading" | "table" | "quote" | "html";

export interface LineInfo {
	kind: LineKind;
	start: number;
	end: number;
}

export interface Unit {
	start: number;
	end: number;
	kind: UnitKind;
	/** Prose view of the unit with line breaks folded to spaces; offsets match the source. */
	text: string;
	/** Same range, with inline code content kept. */
	literal: string;
}

export interface LinkHit {
	kind: "bare" | "autolink" | "url-anchor";
	start: number;
	end: number;
	text: string;
}

export interface Extracted {
	kind: Kind;
	text: string;
	lineStarts: number[];
	lines: LineInfo[];
	/** Prose only: code, URLs, link targets, tags, comments, front matter and markers are blank. */
	prose: string;
	/** Like prose, with inline code content kept. */
	literal: string;
	/** Source with only code, front matter, comments, link syntax and URLs blank. */
	raw: string;
	units: Unit[];
	links: LinkHit[];
	fenceCount: number;
	inlineCodeCount: number;
}

const MARKDOWN: BlockOpts = {
	fences: true,
	indented: true,
	front: true,
	comments: true,
	links: true,
	tags: true,
	headings: true,
	lists: true,
	tables: true,
	quotes: true,
	emphasis: true,
};
const PLAIN: BlockOpts = {
	fences: false,
	indented: false,
	front: false,
	comments: false,
	links: false,
	tags: false,
	headings: false,
	lists: true,
	tables: false,
	quotes: false,
	emphasis: false,
};
const SOURCE_COMMENT: BlockOpts = {
	fences: true,
	indented: false,
	front: false,
	comments: false,
	links: true,
	tags: false,
	headings: false,
	lists: true,
	tables: false,
	quotes: false,
	emphasis: true,
};

export function normalizeText(input: string): string {
	return (input.startsWith("\uFEFF") ? input.slice(1) : input).replace(/\r\n?/g, "\n");
}

function computeLineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	return starts;
}

export function lineOf(lineStarts: number[], offset: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if ((lineStarts[mid] ?? 0) <= offset) low = mid;
		else high = mid - 1;
	}
	return low + 1;
}

export function columnOf(lineStarts: number[], offset: number): number {
	return offset - (lineStarts[lineOf(lineStarts, offset) - 1] ?? 0) + 1;
}

function finishUnits(raw: RawUnit[], v: Views): Unit[] {
	const units: Unit[] = [];
	for (const entry of raw) {
		let start = entry.start;
		let end = entry.end;
		while (start < end && /\s/.test(v.P[start] ?? " ")) start += 1;
		while (end > start && /\s/.test(v.P[end - 1] ?? " ")) end -= 1;
		if (end <= start) continue;
		units.push({
			start,
			end,
			kind: entry.kind,
			text: v.P.slice(start, end).join("").replace(/\n/g, " "),
			literal: v.L.slice(start, end).join("").replace(/\n/g, " "),
		});
	}
	return units;
}

const BLOCK_TAGS =
	/^<\/?(?:p|div|li|ul|ol|h[1-6]|tr|td|th|br|blockquote|section|article|table|thead|tbody|header|footer|hr|dt|dd|dl|pre|nav|aside|main|figure|figcaption|form|details|summary)(?=[\s/>])/i;

interface HtmlState {
	text: string;
	v: Views;
	links: LinkHit[];
	breaks: number[];
	protectedRanges: Array<[number, number]>;
	fenceCount: number;
	inlineCode: number;
}

function blankProtectedBlocks(h: HtmlState): void {
	const lowered = h.text.toLowerCase();
	const blocks: Array<[string, string, boolean]> = [
		["<!--", "-->", false],
		["<script", "</script>", false],
		["<style", "</style>", false],
		["<pre", "</pre>", true],
	];
	for (const [open, close, isCode] of blocks) {
		let from = 0;
		for (;;) {
			const a = lowered.indexOf(open, from);
			if (a === -1) break;
			const b = lowered.indexOf(close, a + open.length);
			const end = b === -1 ? h.text.length : b + close.length;
			blankAll(h.v, a, end);
			h.protectedRanges.push([a, end]);
			if (isCode) h.fenceCount += 1;
			h.breaks.push(a, end);
			from = end;
		}
	}
}

function blankTagsAndEntities(h: HtmlState): void {
	const inProtected = (offset: number): boolean => h.protectedRanges.some(([a, b]) => offset >= a && offset < b);
	for (const match of h.text.matchAll(/<\/?[A-Za-z][^<>]*>/g)) {
		if (inProtected(match.index)) continue;
		if (/^<code[\s>]/i.test(match[0])) h.inlineCode += 1;
		if (BLOCK_TAGS.test(match[0])) h.breaks.push(match.index, match.index + match[0].length);
		blankText(h.v, match.index, match.index + match[0].length);
	}
	for (const match of h.text.matchAll(/&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9a-fA-F]+);/g)) {
		if (!inProtected(match.index)) blankText(h.v, match.index, match.index + match[0].length);
	}
	for (const match of h.text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`]+/g)) {
		if (inProtected(match.index) || (h.v.P[match.index] ?? " ") === " ") continue;
		const url = trimUrl(match[0]);
		h.links.push({ kind: "bare", start: match.index, end: match.index + url.length, text: url });
		blankAll(h.v, match.index, match.index + url.length);
	}
}

function extractHtml(text: string, lineStarts: number[]): Extracted {
	const h: HtmlState = {
		text,
		v: makeViews(text),
		links: [],
		breaks: [0],
		protectedRanges: [],
		fenceCount: 0,
		inlineCode: 0,
	};
	blankProtectedBlocks(h);
	blankTagsAndEntities(h);
	for (const match of text.matchAll(/\n[ \t]*\n/g)) h.breaks.push(match.index);
	const cuts = [...new Set(h.breaks)].sort((a, b) => a - b);
	const rawUnits: RawUnit[] = [];
	cuts.forEach((a, index) => {
		const b = cuts[index + 1] ?? text.length;
		if (b > a) rawUnits.push({ start: a, end: b, kind: "html" });
	});
	const lines: LineInfo[] = lineStarts.map((start, n) => {
		const end = n + 1 < lineStarts.length ? (lineStarts[n + 1] ?? text.length) - 1 : text.length;
		const visible = h.v.P.slice(start, end).join("").trim();
		return { kind: visible === "" ? "blank" : "para", start, end };
	});
	return {
		kind: "html",
		text,
		lineStarts,
		lines,
		prose: h.v.P.join(""),
		literal: h.v.L.join(""),
		raw: h.v.R.join(""),
		units: finishUnits(rawUnits, h.v),
		links: h.links,
		fenceCount: h.fenceCount,
		inlineCodeCount: h.inlineCode,
	};
}

function fromBlocks(kind: Kind, text: string, lineStarts: number[], blocks: BlockResult, v: Views): Extracted {
	return {
		kind,
		text,
		lineStarts,
		lines: blocks.lines,
		prose: v.P.join(""),
		literal: v.L.join(""),
		raw: v.R.join(""),
		units: finishUnits(blocks.units, v),
		links: blocks.links,
		fenceCount: blocks.fenceCount,
		inlineCodeCount: blocks.inlineCode,
	};
}

export function extract(input: string, kind: Kind): Extracted {
	const original = normalizeText(input);
	const lineStarts = computeLineStarts(original);
	if (kind === "html") return extractHtml(original, lineStarts);
	const isSource = kind === "ts" || kind === "js";
	const text = isSource ? cleanSourceComments(sourceComments(original)) : original;
	const opts = isSource ? SOURCE_COMMENT : kind === "text" ? PLAIN : MARKDOWN;
	const v = makeViews(text);
	return fromBlocks(kind, text, lineStarts, runBlocks(text, lineStarts, opts, v), v);
}

const KIND_BY_EXTENSION: Record<string, Kind> = {
	".md": "md",
	".markdown": "md",
	".mdx": "md",
	".html": "html",
	".htm": "html",
	".txt": "text",
	".ts": "ts",
	".mts": "ts",
	".cts": "ts",
	".tsx": "ts",
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "js",
};

/** Pick an extraction kind from a file path, or null when the file holds no prose the meter reads. */
export function kindForPath(path: string): Kind | null {
	const base = path.split("/").pop() ?? path;
	if (base === "COMMIT_EDITMSG" || base === "MERGE_MSG") return "commit";
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return null;
	return KIND_BY_EXTENSION[base.slice(dot).toLowerCase()] ?? null;
}
