import type { Draft } from "./draft.ts";

export interface DocHeader {
	doc: string;
	title: string;
	rev: number;
	dirty: boolean;
}
export interface DocRecord extends DocHeader {
	text: string;
	diskChanged?: boolean;
}
export interface DraftBuffer extends Draft {
	tab: HTMLDivElement;
	open: HTMLButtonElement;
	name: HTMLSpanElement;
	dot: HTMLSpanElement;
	close: HTMLButtonElement;
	checking?: Promise<void> | null;
	closing?: boolean;
	recovering?: boolean;
	saving?: boolean;
	saveInFlight?: boolean;
}

export type TargetKind = "file" | "folder" | "tab" | "pane" | "setting" | "view";
export interface Target {
	kind: TargetKind;
	key: string;
}
export interface Selection {
	doc: string;
	rev: number;
	text: string;
	change: number;
	start: number;
	end: number;
	line: number;
	column: number;
	last: number;
	title: string;
	target?: never;
}
export type Anchor = Selection | { target: Target; doc?: never };
export interface ThreadAnchor {
	id: string;
	doc: string;
	start: number;
	end: number;
	quote: string;
	rev: number;
	target?: Target;
}
export interface ThreadHeader extends ThreadAnchor {
	preview: string;
	messageCount: number;
}
export interface ThreadDetail extends ThreadAnchor {
	messages: Array<{ author: string; text: string }>;
}
export interface ViewHeader {
	id: string;
	title: string;
	rev: number;
}
export interface Member {
	id: string;
	label: string;
	kind: "ordinary" | "durable";
}
export interface Directory {
	entries: Array<{ path: string; name: string; dir: boolean }>;
	next: number | null;
	limited?: boolean;
	error?: string;
}
export interface GitInfo {
	branch: string;
	files: Array<{ path: string; status: string }>;
	diff?: string;
	limited: boolean;
	repo?: boolean;
}
export type SearchKind = "paths" | "text";

export interface ApiOps {
	state: [
		{ since?: number },
		(
			| { seq: number; unchanged: true }
			| {
					root: string;
					seq: number;
					docs: DocHeader[];
					docsLimited?: boolean;
					threads: ThreadHeader[];
					threadsLimited?: boolean;
					views?: ViewHeader[];
					unchanged?: false;
			  }
		),
	];
	read: [
		{ doc: string; ifRev?: number },
		(
			| (DocRecord & { unchanged?: false })
			| { doc: string; rev: number; dirty: boolean; unchanged: true; diskChanged?: boolean }
		),
	];
	patch: [
		{ doc: string; rev: number; start: number; end: number; text: string },
		Pick<DocRecord, "doc" | "rev" | "dirty">,
	];
	save: [{ doc: string; rev: number; path?: string }, DocRecord];
	new: [{ path?: string }, DocRecord];
	tree: [{ path: string; offset?: number }, Directory];
	search: [
		{ query: string; kind: SearchKind },
		{ hits: Array<{ path: string; line?: number; preview?: string }>; limited: boolean },
	];
	git: [{ doc?: string }, GitInfo];
	members: [object, { members: Member[] }];
	note: [
		({ doc: string; rev: number; start: number; end: number } | { target: Target }) & { text: string },
		{ id: string },
	];
	send: [{ id: string; to: string; message: string }, { accepted: true; warning?: string }];
	reply: [{ id: string; text: string }, { id: string }];
	thread: [{ id: string }, ThreadDetail];
	view: [{ id: string }, Parameters<typeof import("./view.ts").renderView>[1]];
}
