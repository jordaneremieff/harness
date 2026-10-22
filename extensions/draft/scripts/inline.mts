// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import type { LinkHit } from "./extract.mts";
import { blank, blankAll, blankText, trimUrl, type Views } from "./views.mts";

export interface InlineOpts {
	links: boolean;
	tags: boolean;
	emphasis: boolean;
}

export interface InlineOut {
	links: LinkHit[];
	inlineCode: number;
}

interface Scan {
	text: string;
	to: number;
	opts: InlineOpts;
	v: Views;
	out: InlineOut;
	/** Index of a `]` mapped to the end of the link syntax that follows it. */
	closers: Map<number, number>;
	i: number;
}

const AUTOLINK = /^<(?:https?:\/\/|mailto:)[^\s<>]*>/i;
const HTML_TAG = /^<\/?[A-Za-z][^<>\n]*>/;
const ENTITY = /^&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9a-fA-F]+);/;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>"'`]+/y;

function findCodeClose(text: string, from: number, run: number, limit: number): number {
	let j = from;
	while (j < limit) {
		if (text[j] !== "`") {
			j += 1;
			continue;
		}
		let n = 0;
		while (text[j + n] === "`") n += 1;
		if (n === run) return j;
		j += n;
	}
	return -1;
}

function skipCodeSpan(text: string, at: number, limit: number): number {
	let n = 0;
	while (text[at + n] === "`") n += 1;
	const close = findCodeClose(text, at + n, n, limit);
	return close === -1 ? at + n : close + n;
}

function findBracketClose(text: string, open: number, limit: number): number {
	let depth = 1;
	let i = open + 1;
	while (i < limit) {
		const ch = text[i];
		if (ch === "\\") i += 2;
		else if (ch === "`") i = skipCodeSpan(text, i, limit);
		else {
			if (ch === "[") depth += 1;
			if (ch === "]") depth -= 1;
			if (depth === 0) return i;
			i += 1;
		}
	}
	return -1;
}

function findDestEnd(text: string, from: number, limit: number): number {
	let depth = 0;
	let j = from;
	while (j < limit) {
		const ch = text[j];
		if (ch === "\\") {
			j += 2;
			continue;
		}
		if (ch === ")" && depth === 0) return j;
		if (ch === "(") depth += 1;
		if (ch === ")") depth -= 1;
		j += 1;
	}
	return -1;
}

/** End offset (exclusive) of the link syntax after a closing bracket, or -1 when there is none. */
function linkSyntaxEnd(text: string, close: number, to: number): number {
	if (text[close + 1] === "(") {
		const paren = findDestEnd(text, close + 2, to);
		return paren === -1 ? -1 : paren + 1;
	}
	if (text[close + 1] === "[") {
		const ref = text.indexOf("]", close + 2);
		return ref !== -1 && ref < to ? ref + 1 : -1;
	}
	return -1;
}

function stepCode(s: Scan): boolean {
	if (s.text[s.i] !== "`") return false;
	let run = 0;
	while (s.text[s.i + run] === "`") run += 1;
	const close = findCodeClose(s.text, s.i + run, run, s.to);
	if (close === -1) {
		s.i += run;
		return true;
	}
	blank(s.v.P, s.i, close + run);
	blank(s.v.R, s.i, close + run);
	blank(s.v.L, s.i, s.i + run);
	blank(s.v.L, close, close + run);
	s.out.inlineCode += 1;
	s.i = close + run;
	return true;
}

function stepLink(s: Scan): boolean {
	const ch = s.text[s.i];
	if (!s.opts.links || (ch !== "[" && !(ch === "!" && s.text[s.i + 1] === "["))) return false;
	const open = ch === "!" ? s.i + 1 : s.i;
	if (s.text[open + 1] === "^") return false;
	const close = findBracketClose(s.text, open, s.to);
	if (close === -1) return false;
	const end = linkSyntaxEnd(s.text, close, s.to);
	if (end === -1) return false;
	const anchor = s.text.slice(open + 1, close);
	blankAll(s.v, s.i, open + 1);
	s.closers.set(close, end);
	if (/^\s*(?:https?:\/\/|www\.)/i.test(anchor)) {
		s.out.links.push({ kind: "url-anchor", start: open + 1, end: close, text: anchor.trim() });
		blankAll(s.v, open + 1, close);
		s.i = close;
	} else {
		s.i = open + 1;
	}
	return true;
}

function stepAngle(s: Scan): boolean {
	if (s.text[s.i] !== "<") return false;
	const rest = s.text.slice(s.i, s.to);
	const auto = AUTOLINK.exec(rest);
	if (auto !== null) {
		s.out.links.push({ kind: "autolink", start: s.i, end: s.i + auto[0].length, text: auto[0] });
		blankAll(s.v, s.i, s.i + auto[0].length);
		s.i += auto[0].length;
		return true;
	}
	const tag = s.opts.tags ? HTML_TAG.exec(rest) : null;
	if (tag === null) return false;
	blankText(s.v, s.i, s.i + tag[0].length);
	s.i += tag[0].length;
	return true;
}

function stepEntity(s: Scan): boolean {
	if (s.text[s.i] !== "&") return false;
	const entity = ENTITY.exec(s.text.slice(s.i, Math.min(s.to, s.i + 12)));
	if (entity === null) return false;
	blankText(s.v, s.i, s.i + entity[0].length);
	s.i += entity[0].length;
	return true;
}

function stepUrl(s: Scan): boolean {
	const ch = s.text[s.i];
	if ((ch !== "h" && ch !== "w") || /[\w@]/.test(s.text[s.i - 1] ?? " ")) return false;
	BARE_URL.lastIndex = s.i;
	const found = BARE_URL.exec(s.text);
	if (found === null || found.index !== s.i) return false;
	const room = s.text.slice(s.i, s.to).match(/^\S*/)?.[0].length ?? 0;
	const url = trimUrl(found[0].slice(0, Math.min(found[0].length, room)));
	if (url.length <= 7) return false;
	s.out.links.push({ kind: "bare", start: s.i, end: s.i + url.length, text: url });
	blankAll(s.v, s.i, s.i + url.length);
	s.i += url.length;
	return true;
}

function starRun(s: Scan): boolean {
	let run = 0;
	while (s.text[s.i + run] === "*") run += 1;
	const before = s.text[s.i - 1] ?? " ";
	const after = s.text[s.i + run] ?? " ";
	if (!/\s/.test(after) || !/\s/.test(before)) blankText(s.v, s.i, s.i + run);
	s.i += run;
	return true;
}

function underscorePair(s: Scan): boolean {
	const before = s.text[s.i - 1] ?? " ";
	const after = s.text[s.i + 2] ?? " ";
	if (!/\w/.test(before) || !/\w/.test(after)) blankText(s.v, s.i, s.i + 2);
	s.i += 2;
	return true;
}

function stepEmphasis(s: Scan): boolean {
	if (!s.opts.emphasis) return false;
	const ch = s.text[s.i];
	if (ch === "*") return starRun(s);
	if (ch === "_" && s.text[s.i + 1] === "_" && s.text[s.i + 2] !== "_") return underscorePair(s);
	return false;
}

const STEPS = [stepCode, stepLink, stepAngle, stepEntity, stepUrl, stepEmphasis];

/** Blank inline markup between two offsets of one line and record links and code spans. */
export function inlinePass(text: string, from: number, to: number, opts: InlineOpts, v: Views, out: InlineOut): void {
	const s: Scan = { text, to, opts, v, out, closers: new Map(), i: from };
	while (s.i < to) {
		const closeEnd = s.closers.get(s.i);
		if (closeEnd !== undefined) {
			blankAll(v, s.i, closeEnd);
			s.i = closeEnd;
		} else if (text[s.i] === "\\") {
			s.i += 2;
		} else if (!STEPS.some((step) => step(s))) {
			s.i += 1;
		}
	}
}
