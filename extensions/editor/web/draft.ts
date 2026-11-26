import type { DocRecord } from "./types.ts";

export interface Splice {
	start: number;
	end: number;
	text: string;
}

export interface Draft extends DocRecord {
	base: string;
	change: number;
	timer: number;
	composing: boolean;
	flight: Promise<void> | null;
	blocked: { kind: "conflict" | "patch"; message: string } | null;
	start: number;
	end: number;
	direction: HTMLTextAreaElement["selectionDirection"];
	top: number;
	left: number;
}

export type RefreshStamp = Pick<Draft, "change" | "rev" | "doc">;

type Patch = { text: string; input: Splice & { op: "patch"; doc: string; rev: number } };

export function spliceBetween(before: string, after: string): Splice | null {
	let start = 0;
	const shared = Math.min(before.length, after.length);
	while (start < shared && before.charCodeAt(start) === after.charCodeAt(start)) start++;
	if (start === before.length && start === after.length) return null;
	let end = before.length;
	let nextEnd = after.length;
	while (end > start && nextEnd > start && before.charCodeAt(end - 1) === after.charCodeAt(nextEnd - 1)) {
		end--;
		nextEnd--;
	}
	// A UTF-16 splice must not split a surrogate pair in either revision.
	const splitsPair = (text: string, offset: number) =>
		/[\uDC00-\uDFFF]/u.test(text[offset] ?? "") && /[\uD800-\uDBFF]/u.test(text[offset - 1] ?? "");
	if (splitsPair(before, start) || splitsPair(after, start)) start--;
	if (splitsPair(before, end) || splitsPair(after, nextEnd)) {
		end++;
		nextEnd++;
	}
	return { start, end, text: after.slice(start, nextEnd) };
}

export function mapOffset(offset: number, splice: Splice | null): number {
	if (!splice || offset <= splice.start) return offset;
	if (offset >= splice.end) return offset + splice.text.length - (splice.end - splice.start);
	return splice.start + Math.min(offset - splice.start, splice.text.length);
}

export function makeDraft(record: DocRecord): Draft {
	return {
		...record,
		base: record.text,
		change: 0,
		timer: 0,
		composing: false,
		flight: null,
		blocked: null,
		start: 0,
		end: 0,
		direction: "none",
		top: 0,
		left: 0,
	};
}

export function capturePatch(draft: Draft): Patch | null {
	const text = draft.text;
	const splice = spliceBetween(draft.base, text);
	return splice ? { text, input: { op: "patch", doc: draft.doc, rev: draft.rev, ...splice } } : null;
}

export function acceptPatch(draft: Draft, patch: Patch, result: Pick<DocRecord, "rev" | "dirty">): void {
	draft.base = patch.text;
	draft.rev = result.rev;
	draft.dirty = result.dirty;
}

export function refreshStamp(draft: Draft): RefreshStamp {
	return { change: draft.change, rev: draft.rev, doc: draft.doc };
}

export function acceptRefresh(draft: Draft, stamp: RefreshStamp, record: DocRecord): boolean {
	if (
		stamp.doc !== draft.doc ||
		stamp.change !== draft.change ||
		stamp.rev !== draft.rev ||
		draft.text !== draft.base ||
		draft.flight ||
		draft.blocked ||
		draft.composing ||
		record.doc !== stamp.doc ||
		record.rev < draft.rev
	)
		return false;
	const splice = spliceBetween(draft.base, record.text);
	draft.start = mapOffset(draft.start, splice);
	draft.end = mapOffset(draft.end, splice);
	Object.assign(draft, record, { base: record.text });
	return true;
}

export function anchorStillExact(anchor: Pick<Draft, "doc" | "change" | "text">, draft: Draft): boolean {
	return (
		anchor.doc === draft.doc &&
		anchor.change === draft.change &&
		anchor.text === draft.text &&
		!draft.blocked &&
		!draft.composing
	);
}

export function lineOffsets(text: string): number[] {
	const offsets = [0];
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) offsets.push(at + 1);
	return offsets;
}

export function lineIndex(offsets: readonly number[], at: number): number {
	let lo = 0;
	let hi = offsets.length;
	while (lo + 1 < hi) {
		const mid = (lo + hi) >>> 1;
		if (offsets[mid] <= at) lo = mid;
		else hi = mid;
	}
	return lo;
}
