import type { DocRecord, ThreadAnchor } from "./types.ts";

export function rangeAt(text: string, start: number, end: number, point?: number) {
	if (point === undefined || (start < end && point >= start && point < end)) return { start, end };
	start = Math.max(0, Math.min(point, text.length));
	if (/[\uDC00-\uDFFF]/u.test(text[start] ?? "") && /[\uD800-\uDBFF]/u.test(text[start - 1] ?? "")) start--;
	end = start;
	const codePoint = text.codePointAt(start);
	if (codePoint !== undefined && codePoint !== 10) end += codePoint > 0xffff ? 2 : 1;
	return { start, end };
}

export function matchesThreadAnchor(thread: ThreadAnchor, draft: DocRecord) {
	return (
		!thread.target &&
		thread.doc === draft.doc &&
		thread.rev === draft.rev &&
		thread.start >= 0 &&
		thread.end >= thread.start &&
		thread.end <= draft.text.length &&
		draft.text.slice(thread.start, thread.end) === thread.quote
	);
}
