import { age, plainLine, type Action, type View, type ViewHost } from "./frame.ts";
import { Browser } from "./browser.ts";
import type { DocumentRow } from "./panel-protocol.ts";
import type { ResponseRow } from "./responses.ts";

export type MarkdownScope = "recent" | "published";
export type MarkdownRow =
	| { kind: "response"; response: ResponseRow }
	| { kind: "document"; document: DocumentRow; root?: string; storeId?: string };
export interface MarkdownOperations {
	load(scope: MarkdownScope, signal: AbortSignal): Promise<{ rows: MarkdownRow[]; coverage: string }>;
	read(row: MarkdownRow, signal: AbortSignal): Promise<string>;
	latest(signal: AbortSignal): Promise<string>;
	newScratchpad(signal: AbortSignal): Promise<string>;
	edit(row: MarkdownRow, signal: AbortSignal, copy?: boolean): Promise<string>;
}
export interface MarkdownViewState {
	scope: MarkdownScope;
	query: string;
	selected?: string;
}
export const createMarkdownViewState = (): MarkdownViewState => ({ scope: "recent", query: "" });
const identity = (row: MarkdownRow) =>
	row.kind === "response" ? `response:${row.response.entryId}` : `document:${row.document.id}`;
const label = (row: MarkdownRow) => (row.kind === "response" ? row.response.preview : row.document.title);
const errorText = (error: unknown) => plainLine(error instanceof Error ? error.message : String(error)).slice(0, 500);

export function markdownView(host: ViewHost, operations: MarkdownOperations, state = createMarkdownViewState()): View {
	let rows: MarkdownRow[] = [];
	let status = "Read retained text or write in a private scratchpad. These actions start no model turn.";
	let generation = 0;
	let effect: AbortController | undefined;
	let busy = false;
	/** True while a list replaces the rows; a selection that moves because rows arrived is not the operator's change. */
	let listing = false;
	const cancel = () => {
		effect?.abort();
		effect = undefined;
		busy = false;
	};
	host.signal.addEventListener("abort", cancel, { once: true });
	const filter = () => {
		const query = state.query.toLocaleLowerCase();
		listing = true;
		try {
			browser.setItems(
				rows.filter((row) => `${identity(row)} ${label(row)}`.toLocaleLowerCase().includes(query)),
				state.selected,
			);
		} finally {
			listing = false;
		}
		host.requestRender();
	};
	const load = async (scope: MarkdownScope) => {
		cancel();
		state.scope = scope;
		const current = ++generation;
		status = "Reading the list…";
		rows = [];
		filter();
		try {
			const result = await operations.load(scope, host.signal);
			if (host.signal.aborted || current !== generation) return;
			rows = result.rows;
			status = result.coverage;
		} catch (error) {
			if (host.signal.aborted || current !== generation) return;
			status = `List unavailable: ${errorText(error)}`;
		}
		filter();
	};
	const perform = async (operation: (signal: AbortSignal) => Promise<string>) => {
		cancel();
		const controller = new AbortController();
		effect = controller;
		const signal = AbortSignal.any([host.signal, controller.signal]);
		busy = true;
		host.notify("Preparing the document…", "pending");
		host.requestRender();
		try {
			const notice = await operation(signal);
			if (!signal.aborted) host.notify(notice, "info");
		} catch (error) {
			if (!signal.aborted) host.notify(errorText(error), "error");
		} finally {
			if (effect === controller) {
				effect = undefined;
				busy = false;
				host.requestRender();
			}
		}
	};
	const actions = (row: MarkdownRow | undefined): Action[] => {
		const disabled = busy ? "A document action is in progress" : undefined;
		const needsSelection = disabled ?? (row ? undefined : "Select a response or document");
		return [
			{
				id: "read",
				label: "Read",
				key: "enter",
				primary: true,
				disabled: needsSelection,
				run: () => {
					if (row) void perform((signal) => operations.read(row, signal));
				},
			},
			{
				id: "new",
				label: "New scratchpad",
				short: "new",
				key: "w",
				primary: true,
				disabled,
				run: () => void perform((signal) => operations.newScratchpad(signal)),
			},
			{
				id: "edit",
				label: row?.kind === "response" ? "Edit a Copy" : "Edit",
				key: "e",
				primary: true,
				disabled: needsSelection,
				run: () => {
					if (row) void perform((signal) => operations.edit(row, signal));
				},
			},
			...(row?.kind === "document"
				? [
						{
							id: "copy",
							label: "Edit a Copy",
							key: "c",
							disabled,
							run: () => void perform((signal) => operations.edit(row, signal, true)),
						},
					]
				: []),
			{
				id: "latest",
				label: "Read latest",
				key: "l",
				primary: true,
				disabled,
				run: () => void perform((signal) => operations.latest(signal)),
			},
			{
				id: "recent",
				label: "Recent responses",
				short: "recent",
				key: "n",
				primary: true,
				run: () => void load("recent"),
			},
			{
				id: "published",
				label: "Published documents",
				short: "published",
				key: "p",
				primary: true,
				run: () => void load("published"),
			},
			{ id: "refresh", label: "Refresh list", key: "r", run: () => void load(state.scope) },
		];
	};
	const browser = new Browser<MarkdownRow>({
		title: "Markdown",
		host,
		key: identity,
		line: (row, _width, theme) => {
			if (row.kind === "document") {
				// The short stable ID is the argument of /markdown <id>; the detail pane has the size.
				const updated = Date.parse(row.document.updatedAt);
				const changed = Number.isFinite(updated) ? ` · ${age(updated)}` : "";
				return `${theme.fg("dim", `${row.document.id.slice(0, 11)} · r${row.document.revision}${changed}`)}  ${plainLine(label(row))}`;
			}
			const bytes = row.response.bytes;
			const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
			const partial = row.response.completeness.state === "partial" ? " partial" : "";
			const time = row.response.timestamp !== undefined ? ` · ${age(row.response.timestamp)}` : "";
			return `${theme.fg("dim", `${size}${time}${partial}`)}  ${plainLine(label(row))}`;
		},
		detail: (row) => {
			if (!row) return "New scratchpad opens a blank native editor. Select a response or document to read or edit.";
			if (row.kind === "document")
				return `${plainLine(row.document.title)}\n${row.document.id} · revision ${row.document.revision} · ${row.document.bytes} bytes\n\nRead opens the saved document. Edit creates a private editing session; Save appends a revision. Edit a Copy leaves this document unchanged.`;
			const response = row.response;
			return `Response ${response.entryId} · ${response.bytes} bytes\n${response.completeness.state}${response.completeness.reason ? ` (${response.completeness.reason})` : ""} · response state, not task acceptance\n\nPreview only:\n${plainLine(response.preview)}\n\nRead acquires the complete response by entry identity. Edit a Copy preserves this captured response.`;
		},
		actions,
		scopes: [
			{ id: "recent", label: "Recent responses" },
			{ id: "published", label: "Published" },
		],
		scope: () => state.scope,
		onScope: (scope) => void load(scope as MarkdownScope),
		search: {
			value: state.query,
			placeholder: "filter this list",
			change: (query) => {
				cancel();
				state.query = query;
				filter();
			},
		},
		status: () => status,
		empty: () => "No documents or responses in this list.",
		onSelect: (row) => {
			const key = row ? identity(row) : undefined;
			if (!listing && key !== state.selected) cancel();
			state.selected = key;
		},
	});
	void load(state.scope);
	return browser;
}
