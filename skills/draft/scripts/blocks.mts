// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import type { LineInfo, LineKind, LinkHit, UnitKind } from "./extract.mts";
import { type InlineOpts, type InlineOut, inlinePass } from "./inline.mts";
import { blankAll, blankText, indentOf, type Views } from "./views.mts";

export interface BlockOpts extends InlineOpts {
	fences: boolean;
	indented: boolean;
	front: boolean;
	comments: boolean;
	headings: boolean;
	lists: boolean;
	tables: boolean;
	quotes: boolean;
}

export interface RawUnit {
	start: number;
	end: number;
	kind: UnitKind;
}

export interface BlockResult {
	lines: LineInfo[];
	units: RawUnit[];
	fenceCount: number;
	links: LinkHit[];
	inlineCode: number;
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})([^\n]*)$/;
const THEMATIC = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_MARKER = /^(\s*)([-*+]|\d{1,9}[.)])(?=\s|$)[ \t]*(?:\[[ xX]\][ \t]+)?/;
const QUOTE_PREFIX = /^(?:[ \t]*>[ \t]?)+/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const REF_DEF = /^\s{0,3}\[[^\]\n]+\]:\s*\S+/;

interface Scanner {
	text: string;
	lineStarts: number[];
	opts: BlockOpts;
	v: Views;
	lines: LineInfo[];
	units: RawUnit[];
	cur: RawUnit | null;
	inlineOut: InlineOut;
	fenceCount: number;
	fence: { ch: string; len: number } | null;
	inComment: boolean;
	listOpen: boolean;
	prevKind: LineKind;
}

interface Line {
	n: number;
	start: number;
	end: number;
}

interface Classified {
	kind: "heading" | "list" | "table" | "para" | "rule";
	contentStart: number;
	quoted: boolean;
}

function lineEnd(s: Scanner, n: number): number {
	return n + 1 < s.lineStarts.length ? (s.lineStarts[n + 1] ?? s.text.length) - 1 : s.text.length;
}

function closeUnit(s: Scanner): void {
	if (s.cur !== null) s.units.push(s.cur);
	s.cur = null;
}

function record(s: Scanner, line: Line, kind: LineKind): void {
	s.lines.push({ kind, start: line.start, end: line.end });
	s.prevKind = kind;
}

/** Record a line that opens no content unit and close the open unit. */
function finishLine(s: Scanner, line: Line, kind: LineKind): void {
	closeUnit(s);
	record(s, line, kind);
}

function continueFence(s: Scanner, line: Line): boolean {
	if (s.fence === null) return false;
	blankAll(s.v, line.start, line.end);
	const marker = s.fence.ch === "`" ? "`" : "~";
	if (new RegExp(`^\\s*${marker}{${s.fence.len},}\\s*$`).test(s.text.slice(line.start, line.end))) s.fence = null;
	finishLine(s, line, "code");
	return true;
}

function frontMatterEnd(s: Scanner, line: Line): number {
	if (line.n !== 0 || !s.opts.front || s.text.slice(line.start, line.end).trim() !== "---") return -1;
	for (let m = 1; m < s.lineStarts.length; m++) {
		const t = s.text.slice(s.lineStarts[m] ?? 0, lineEnd(s, m)).trim();
		if (t === "---" || t === "...") return m;
	}
	return -1;
}

function skipFrontMatter(s: Scanner, closeLine: number): void {
	blankAll(s.v, 0, lineEnd(s, closeLine));
	for (let m = 0; m <= closeLine; m++) s.lines.push({ kind: "meta", start: s.lineStarts[m] ?? 0, end: lineEnd(s, m) });
	s.prevKind = "meta";
}

function blankInsideComment(s: Scanner, line: Line, pos: number): number {
	const at = s.text.indexOf("-->", pos);
	const within = at !== -1 && at < line.end;
	const stop = within ? at + 3 : line.end;
	blankAll(s.v, pos, stop);
	s.inComment = !within;
	return stop;
}

/** Blank the next comment opener on the line. Returns the new position, or -1 when none starts here. */
function blankCommentOpener(s: Scanner, line: Line, pos: number): number {
	const at = s.text.indexOf("<!--", pos);
	if (at === -1 || at >= line.end) return -1;
	blankAll(s.v, at, at + 4);
	s.inComment = true;
	return at + 4;
}

/** Blank HTML comments on a line. Returns true when nothing visible remains. */
function stripComments(s: Scanner, line: Line): boolean {
	if (!s.opts.comments) return false;
	let pos = line.start;
	let sawComment = false;
	while (pos < line.end) {
		const next = s.inComment ? blankInsideComment(s, line, pos) : blankCommentOpener(s, line, pos);
		if (next === -1) break;
		pos = next;
		sawComment = true;
	}
	return sawComment && s.v.P.slice(line.start, line.end).join("").trim() === "";
}

function openFence(s: Scanner, line: Line, visible: string): boolean {
	const open = s.opts.fences ? FENCE_OPEN.exec(visible) : null;
	if (open === null || (indentOf(open[1] ?? "") >= 4 && !s.listOpen)) return false;
	const marker = open[2] ?? "```";
	if (marker[0] === "`" && (open[3] ?? "").includes("`")) return false;
	s.fence = { ch: marker[0] ?? "`", len: marker.length };
	s.fenceCount += 1;
	blankAll(s.v, line.start, line.end);
	finishLine(s, line, "code");
	return true;
}

function indentedCode(s: Scanner, line: Line, visible: string): boolean {
	if (!s.opts.indented || indentOf(visible) < 4) return false;
	if (!(s.prevKind === "code" || (s.prevKind === "blank" && !s.listOpen))) return false;
	blankAll(s.v, line.start, line.end);
	finishLine(s, line, "code");
	return true;
}

function blankPipes(s: Scanner, from: number, to: number): void {
	for (let i = from; i < to; i++) {
		if (s.text[i] === "|") {
			s.v.P[i] = " ";
			s.v.L[i] = " ";
		}
	}
}

function headingInfo(s: Scanner, rest: string, contentStart: number, quoted: boolean): Classified | null {
	const heading = s.opts.headings ? HEADING.exec(rest) : null;
	if (heading === null) return null;
	blankText(s.v, contentStart, contentStart + heading[0].length);
	const closing = /[ \t]+#+[ \t]*$/.exec(rest);
	if (closing !== null) blankText(s.v, contentStart + closing.index, contentStart + rest.length);
	s.listOpen = false;
	return { kind: "heading", contentStart: contentStart + heading[0].length, quoted };
}

function listInfo(s: Scanner, rest: string, contentStart: number, quoted: boolean): Classified | null {
	const marker = s.opts.lists ? LIST_MARKER.exec(rest) : null;
	if (marker === null) return null;
	blankText(s.v, contentStart, contentStart + marker[0].length);
	s.listOpen = true;
	return { kind: "list", contentStart: contentStart + marker[0].length, quoted };
}

function tableInfo(s: Scanner, line: Line, rest: string, contentStart: number, quoted: boolean): Classified | null {
	const row = rest.trimStart().startsWith("|") || (rest.match(/\|/g)?.length ?? 0) >= 2;
	if (!s.opts.tables || !row) return null;
	blankPipes(s, contentStart, line.end);
	return { kind: "table", contentStart, quoted };
}

function classifyRest(s: Scanner, line: Line, rest: string, contentStart: number, quoted: boolean): Classified {
	const isRule = (s.opts.tables && rest.includes("|") && TABLE_SEP.test(rest)) || THEMATIC.test(rest);
	if (isRule || (s.opts.links && REF_DEF.test(rest))) return { kind: "rule", contentStart, quoted };
	const found =
		headingInfo(s, rest, contentStart, quoted) ??
		listInfo(s, rest, contentStart, quoted) ??
		tableInfo(s, line, rest, contentStart, quoted);
	if (found !== null) return found;
	if (indentOf(rest) === 0 && !quoted) s.listOpen = false;
	return { kind: "para", contentStart, quoted };
}

function classify(s: Scanner, line: Line, visible: string): Classified {
	const q = s.opts.quotes ? QUOTE_PREFIX.exec(visible) : null;
	if (q === null) return classifyRest(s, line, visible, line.start, false);
	blankText(s.v, line.start, line.start + q[0].length);
	return classifyRest(s, line, visible.slice(q[0].length), line.start + q[0].length, true);
}

function addContent(s: Scanner, line: Line, info: Classified): void {
	const visibleAfter = s.v.P.slice(info.contentStart, line.end).join("");
	const first = visibleAfter.search(/\S/);
	const unitStart = first === -1 ? info.contentStart : info.contentStart + first;
	if (info.kind === "heading" || info.kind === "table") {
		closeUnit(s);
		s.units.push({ start: unitStart, end: line.end, kind: info.kind });
		record(s, line, info.kind);
	} else if (info.kind === "list") {
		closeUnit(s);
		s.cur = { start: unitStart, end: line.end, kind: "list" };
		record(s, line, "list");
	} else {
		const continues = s.cur !== null && ["para", "list", "quote"].includes(s.prevKind);
		if (continues && s.cur !== null) {
			s.cur.end = line.end;
		} else {
			closeUnit(s);
			s.cur = { start: unitStart, end: line.end, kind: info.quoted ? "quote" : "para" };
		}
		record(s, line, info.quoted ? "quote" : "para");
	}
}

function processLine(s: Scanner, line: Line): void {
	if (continueFence(s, line)) return;
	if (stripComments(s, line)) {
		finishLine(s, line, "meta");
		return;
	}
	const visible = s.v.P.slice(line.start, line.end).join("");
	if (visible.trim() === "") {
		finishLine(s, line, "blank");
		return;
	}
	if (openFence(s, line, visible) || indentedCode(s, line, visible)) return;
	const info = classify(s, line, visible);
	if (info.kind === "rule") {
		blankAll(s.v, line.start, line.end);
		finishLine(s, line, "rule");
		return;
	}
	inlinePass(s.text, info.contentStart, line.end, s.opts, s.v, s.inlineOut);
	addContent(s, line, info);
}

export function runBlocks(text: string, lineStarts: number[], opts: BlockOpts, v: Views): BlockResult {
	const links: LinkHit[] = [];
	const s: Scanner = {
		text,
		lineStarts,
		opts,
		v,
		lines: [],
		units: [],
		cur: null,
		inlineOut: { links, inlineCode: 0 },
		fenceCount: 0,
		fence: null,
		inComment: false,
		listOpen: false,
		prevKind: "blank",
	};
	for (let n = 0; n < lineStarts.length; n++) {
		const line: Line = { n, start: lineStarts[n] ?? 0, end: lineEnd(s, n) };
		const closeLine = s.fence === null ? frontMatterEnd(s, line) : -1;
		if (closeLine === -1) {
			processLine(s, line);
		} else {
			skipFrontMatter(s, closeLine);
			n = closeLine;
		}
	}
	closeUnit(s);
	return { lines: s.lines, units: s.units, fenceCount: s.fenceCount, links, inlineCode: s.inlineOut.inlineCode };
}
