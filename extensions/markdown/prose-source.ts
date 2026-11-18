export type ProseLine = { line: number; raw: string; text: string };
export type ProseBlock = { lines: ProseLine[]; kind: "paragraph" | "heading" | "list" | "table"; codeSpans: { line: number; text: string }[] };
const listItem = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/u;
const heading = /^ {0,3}#{1,6}(?:[ \t]+|$)/u;
const fenceStart = /^ {0,3}(`{3,}(?!`)(?=[^`]*$)|~{3,})/u;
const fenceEnd = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const divider = /^ {0,3}(?:=+|-+)[ \t]*$/u;
const tableDivider = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/u;
const reference = /^ {0,3}\[(?!\^)[^[\]\n]+\]:[ \t]*(?:\S|$)/u;
const thematicBreak = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;

type Segment = { line: number; raw: string; prefix: number };
function nextRun(text: string): Map<number, number> {
	const runs = [...text.matchAll(/`+/gu)];
	const next = new Map<number, number>(), last = new Map<number, number>();
	for (let i = runs.length - 1; i >= 0; i--) {
		const { 0: run, index } = runs[i];
		const close = last.get(run.length);
		if (close !== undefined) next.set(index, close);
		last.set(run.length, index);
	}
	return next;
}
function balancedParens(text: string): Map<number, number> {
	const stack: number[] = [], ends = new Map<number, number>();
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\\") { i++; continue; }
		if (text[i] === "(") stack.push(i);
		else if (text[i] === ")") { const start = stack.pop(); if (start !== undefined) ends.set(start, i + 1); }
	}
	return ends;
}
const inlineToken = /\\[!"#$%&'()*+,./:;<=>?@[\]\\^_`{|}~-]|<!--|`+|\[|\]|<(?:(?:[a-z][a-z\d+.-]{1,31}:)[^<>\s]*|[^<>@\s]+@[^<>@\s]+)>/giu;
const referenceSuffix = /\[[^[\]\n]{0,999}\]/yu;
const angleDestination = /\([ \t\n]*<(?:\\[<>]|[^<>\n])*>[ \t\n]*\)/yu;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One left-to-right cursor resolves overlapping inline exclusions.
function project(segments: Segment[], kind: ProseBlock["kind"], openComment: boolean): ProseBlock & { openComment: boolean } {
	const text = segments.map(({ raw, prefix }) => " ".repeat(prefix) + raw.slice(prefix)).join("\n");
	const starts: number[] = [];
	let offset = 0;
	for (const { raw } of segments) { starts.push(offset); offset += raw.length + 1; }
	const codeSpans: ProseBlock["codeSpans"] = [];
	const ranges: { from: number; to: number }[] = [];
	const hide = (from: number, to: number) => { ranges.push({ from, to }); };
	const runs = text.includes("`") ? nextRun(text) : undefined;
	const parens = text.includes("](") ? balancedParens(text) : undefined;
	let lineIndex = 0, labels = 0, start = 0;
	if (openComment) {
		const close = text.indexOf("-->");
		start = close < 0 ? text.length : close + 3;
		hide(0, start);
		openComment = close < 0;
	}
	inlineToken.lastIndex = start;
	for (let match = inlineToken.exec(text); match; match = inlineToken.exec(text)) {
		const { 0: token, index } = match;
		if (token === "<!--") {
			const close = text.indexOf("-->", index + 4);
			inlineToken.lastIndex = close < 0 ? text.length : close + 3;
			hide(index, inlineToken.lastIndex);
			openComment = close < 0;
		} else if (token.startsWith("`")) {
			const close = runs?.get(index);
			if (close === undefined) continue;
			const end = close + token.length;
			while (lineIndex + 1 < starts.length && starts[lineIndex + 1] <= index) lineIndex++;
			codeSpans.push({ line: segments[lineIndex].line, text: text.slice(index, Math.min(end, index + 240)) });
			hide(index, end); inlineToken.lastIndex = end;
		} else if (token === "[") labels++;
		else if (token === "]" && labels) {
			labels--;
			const after = index + 1;
			let end = parens?.get(after);
			if (text[after] === "(") {
				angleDestination.lastIndex = after;
				if (angleDestination.test(text)) end = angleDestination.lastIndex;
			} else if (text[after] === "[") {
				referenceSuffix.lastIndex = after;
				if (referenceSuffix.test(text)) end = referenceSuffix.lastIndex;
			}
			if (end !== undefined) { hide(index, end); inlineToken.lastIndex = end; }
		} else if (token.startsWith("<")) hide(index, inlineToken.lastIndex);
	}
	let range = 0;
	const lines = segments.map(({ line, raw, prefix }, i) => {
		const at = starts[i], end = at + raw.length;
		let cursor = at + prefix, visible = " ".repeat(prefix);
		while (range < ranges.length && ranges[range].from < end) {
			const { from, to } = ranges[range];
			if (to > cursor) {
				const next = Math.min(end, to);
				visible += text.slice(cursor, Math.max(cursor, from)) + " ".repeat(next - Math.max(cursor, from));
				cursor = next;
			}
			if (to > end) break;
			range++;
		}
		return { line, raw, text: visible + text.slice(cursor, end) };
	});
	return { lines, codeSpans, kind, openComment };
}

/** Recognises common source forms for the prose heuristics without altering the Markdown or requiring the reader app. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The ordered block transitions own fence, quote and comment precedence.
export function* proseBlocks(source: string): Iterable<ProseBlock> {
	const lines = source.replace(/^\uFEFF/u, "").split(/\r\n?|\n/u);
	let start = 0;
	if (lines[0]?.trimEnd() === "---") {
		const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/u.test(line));
		if (end > 0) start = end + 1;
	}
	let segments: Segment[] = [], kind: ProseBlock["kind"] = "paragraph";
	let fence: string | undefined, quote = false, comment = false, listIndent = 0;
	function* flush(): Iterable<ProseBlock> {
		if (!segments.length) return;
		const block = project(segments, kind, comment);
		comment = block.openComment;
		yield block;
		segments = [];
		kind = "paragraph";
	}
	for (let i = start; i < lines.length; i++) {
		const raw = lines[i];
		const container = listIndent && raw.startsWith(" ".repeat(listIndent)) ? listIndent : 0;
		const view = raw.slice(container);
		if (fence) {
			const close = fenceEnd.exec(view)?.[1];
			if (close?.startsWith(fence[0]) && close.length >= fence.length) fence = undefined;
			continue;
		}
		if (comment) {
			segments.push({ line: i + 1, raw, prefix: 0 });
			yield* flush();
			continue;
		}
		if (!raw.trim()) { quote = false; yield* flush(); continue; }
		if (/^ {0,3}>/u.test(view)) { yield* flush(); quote = true; continue; }
		const item = listItem.exec(view)?.[0];
		const mark = heading.exec(view)?.[0];
		const opener = fenceStart.exec(item ? view.slice(item.length) : view)?.[1];
		if (quote && !item && !mark && !opener && !thematicBreak.test(view)) continue;
		quote = false;
		if (opener) { yield* flush(); fence = opener; continue; }
		if (segments.length && kind === "paragraph" && divider.test(view)) { kind = "heading"; yield* flush(); continue; }
		if (thematicBreak.test(view) || reference.test(view)) { yield* flush(); continue; }
		if (mark) {
			yield* flush(); kind = "heading"; segments.push({ line: i + 1, raw, prefix: container + mark.length }); yield* flush(); continue;
		}
		if (!segments.length && /^(?: {4}| {0,3}\t)/u.test(view)) continue;
		if (item) {
			yield* flush(); kind = "list"; listIndent = Math.min(container + item.length, 12);
			const prefix = container + item.length;
			if (!/^ {4}/u.test(view.slice(prefix - container))) segments.push({ line: i + 1, raw, prefix });
			continue;
		}
		if (!container && kind !== "list") listIndent = 0;
		if (kind === "table" && !view.includes("|")) yield* flush();
		if (view.includes("|") && tableDivider.test(lines[i + 1] ?? "")) {
			yield* flush(); kind = "table"; segments.push({ line: i + 1, raw, prefix: container }); i++; continue;
		}
		segments.push({ line: i + 1, raw, prefix: container });
	}
	yield* flush();
}
