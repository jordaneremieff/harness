import { age, plainLine, type Action, type View, type ViewHost } from "./frame.ts";
import { Browser } from "./browser.ts";
import type { LivePane } from "./live-protocol.ts";
import type { DocumentRow } from "./panel-protocol.ts";
import { Reader } from "./reader.ts";
import type { ResponseRow } from "./responses.ts";

export type MarkdownScope = "recent" | "published";
type Scope = MarkdownScope | "live";
export type MarkdownRow =
	| { kind: "response"; response: ResponseRow }
	| { kind: "document"; document: DocumentRow; root?: string; storeId?: string };
type BrowserRow = MarkdownRow | { kind: "pane"; pane: LivePane };
export interface MarkdownOperations {
	load(scope: MarkdownScope, signal: AbortSignal): Promise<{ rows: MarkdownRow[]; coverage: string }>;
	listLive?(signal: AbortSignal): Promise<LivePane[]>;
	read(row: MarkdownRow, signal: AbortSignal): Promise<string>;
	latest(signal: AbortSignal): Promise<string>;
	newScratchpad(signal: AbortSignal): Promise<string>;
	edit(row: MarkdownRow, signal: AbortSignal, copy?: boolean): Promise<string>;
}
export interface MarkdownViewState {
	scope: Scope;
	query: string;
	selected?: string;
}
export const createMarkdownViewState = (): MarkdownViewState => ({ scope: "recent", query: "" });
const identity = (row: BrowserRow) => {
	if (row.kind === "pane") return `pane:${row.pane.handle}:${row.pane.launchId}`;
	return row.kind === "response" ? `response:${row.response.entryId}` : `document:${row.document.id}`;
};
const paneKinds = {
	published: "Published document",
	response: "Response",
	file: "File snapshot",
	scratchpad: "Private scratchpad",
	copy: "Private copy",
	"local-file": "Local file",
	loading: "Document not ready",
};
const paneTitle = ({ view }: LivePane) =>
	view.documentId && !view.dirty && !view.conflict ? plainLine(view.title) : paneKinds[view.kind];
const paneState = ({ view }: LivePane) =>
	[view.mode, ...(view.dirty ? ["unsaved changes"] : []), ...(view.conflict ? ["save conflict"] : [])].join(" · ");
const label = (row: BrowserRow) => {
	if (row.kind === "pane") return `${paneTitle(row.pane)} ${paneState(row.pane)}`;
	return row.kind === "response" ? row.response.preview : row.document.title;
};
const errorText = (error: unknown) => plainLine(error instanceof Error ? error.message : String(error)).slice(0, 500);

function describePane(pane: LivePane): string {
	const { view } = pane;
	const revision =
		view.revision === undefined ? "" : ` · ${view.dirty || view.conflict ? "base " : ""}revision ${view.revision}`;
	return [
		paneTitle(pane),
		`${paneKinds[view.kind]} · ${paneState(pane)}`,
		view.documentId ? `${view.documentId}${revision}` : "No saved document in the Markdown store.",
		`${pane.origin === "agent" ? "Agent" : "Operator"} opened · last report: ${age(pane.reportedAt)}`,
		`Pane: ${pane.handle}`,
	].join("\n\n");
}

function inspectPane(host: ViewHost, selected: LivePane, list: NonNullable<MarkdownOperations["listLive"]>): View {
	const reader = new Reader();
	reader.setContent("Checking the selected pane…");
	const refresh = async () => {
		try {
			const panes = await list(host.signal);
			if (host.signal.aborted) return;
			const pane = panes.find(({ handle, launchId }) => handle === selected.handle && launchId === selected.launchId);
			reader.setContent(
				pane
					? describePane(pane)
					: "This pane changed documents or disconnected. Return to Live panes and refresh the list.",
			);
		} catch (error) {
			if (host.signal.aborted) return;
			reader.setContent(`Pane check failed: ${errorText(error)}`);
		}
		host.requestRender();
	};
	void refresh();
	return {
		title: "Live pane details",
		render: (width, height) => reader.render(width, height, host.theme),
		handleInput: (input) => reader.handleInput(input),
		keys: () => [{ keys: ["up", "down", "pageUp", "pageDown"], label: "scroll" }],
	};
}

export function markdownView(host: ViewHost, operations: MarkdownOperations, state = createMarkdownViewState()): View {
	const listLive = operations.listLive;
	let rows: BrowserRow[] = [];
	let status = "Read retained text or write in a private scratchpad. These actions start no model turn.";
	let generation = 0;
	let effect: AbortController | undefined;
	let busy = false;
	/** True while a list replaces the rows; a selection that moves because rows arrived is not the operator's change. */
	let listing = false;
	const cancel = (announce = true) => {
		if (!effect) return;
		effect.abort();
		effect = undefined;
		busy = false;
		if (announce && !host.signal.aborted) host.notify("Document action cancelled.");
	};
	host.signal.addEventListener("abort", () => cancel(false), { once: true });
	const filter = (prefer = state.selected) => {
		const query = state.query.toLocaleLowerCase();
		listing = true;
		try {
			browser.setItems(
				rows.filter((row) => `${identity(row)} ${label(row)}`.toLocaleLowerCase().includes(query)),
				prefer,
			);
		} finally {
			listing = false;
		}
		host.requestRender();
	};
	const readList = async (scope: Scope): Promise<{ rows: BrowserRow[]; coverage: string }> => {
		if (scope !== "live") return operations.load(scope, host.signal);
		const panes = (await listLive?.(host.signal)) ?? [];
		return {
			rows: panes.map((pane) => ({ kind: "pane", pane })),
			coverage: `${panes.length} connected ${panes.length === 1 ? "pane" : "panes"} · last reported state`,
		};
	};
	const load = async (scope: Scope) => {
		cancel();
		const prefer = scope === state.scope ? state.selected : undefined;
		state.scope = scope;
		const current = ++generation;
		const active = () => !host.signal.aborted && current === generation;
		status = "Reading the list…";
		rows = [];
		filter();
		try {
			const result = await readList(scope);
			if (!active()) return;
			rows = result.rows;
			status = result.coverage;
		} catch (error) {
			if (!active()) return;
			status = `List unavailable: ${errorText(error)}`;
		}
		filter(prefer);
	};
	const perform = async (operation: (signal: AbortSignal) => Promise<string>) => {
		cancel(false);
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
	const paneAction = (
		row: BrowserRow | undefined,
		list: NonNullable<MarkdownOperations["listLive"]>,
		disabled?: string,
	): Action => ({
		id: "inspect",
		label: "Inspect pane",
		key: "enter",
		primary: true,
		disabled: disabled ?? (row?.kind === "pane" ? undefined : "Select a connected pane"),
		run: () => {
			if (row?.kind === "pane") host.push((child) => inspectPane(child, row.pane, list));
		},
	});
	const documentActions = (row: MarkdownRow | undefined, disabled?: string): [Action, ...Action[]] => {
		const needsSelection = disabled ?? (row ? undefined : "Select a response or document");
		const run = (mode: "read" | "edit" | "copy") => {
			if (!row) return;
			if (mode === "read") void perform((signal) => operations.read(row, signal));
			else void perform((signal) => operations.edit(row, signal, mode === "copy"));
		};
		const read: Action = {
			id: "read",
			label: "Read",
			key: "enter",
			primary: true,
			disabled: needsSelection,
			run: () => run("read"),
		};
		const edit: Action = {
			id: "edit",
			label: row?.kind === "response" ? "Edit a Copy" : "Edit",
			key: "e",
			primary: true,
			disabled: needsSelection,
			run: () => run("edit"),
		};
		if (row?.kind !== "document") return [read, edit];
		return [read, edit, { id: "copy", label: "Edit a Copy", key: "c", disabled, run: () => run("copy") }];
	};
	const selectionActions = (row: BrowserRow | undefined, disabled?: string): [Action, ...Action[]] => {
		if (state.scope === "live" && listLive) return [paneAction(row, listLive, disabled)];
		return documentActions(row?.kind === "pane" ? undefined : row, disabled);
	};
	const actions = (row: BrowserRow | undefined): Action[] => {
		const disabled = busy ? "A document action is in progress" : undefined;
		const [read, ...edits] = selectionActions(row, disabled);
		const latest: Action = {
			id: "latest",
			label: "Read latest",
			short: listLive ? "latest" : undefined,
			key: "l",
			primary: true,
			disabled,
			run: () => void perform((signal) => operations.latest(signal)),
		};
		return [
			...(listLive ? [latest] : []),
			read,
			{
				id: "new",
				label: "New scratchpad",
				short: "new",
				key: "w",
				primary: true,
				disabled,
				run: () => void perform((signal) => operations.newScratchpad(signal)),
			},
			...edits,
			...(!listLive ? [latest] : []),
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
			...(listLive ? [{ id: "live", label: "Live panes", key: "v", primary: true, run: () => void load("live") }] : []),
			{ id: "refresh", label: "Refresh list", key: "r", run: () => void load(state.scope) },
		];
	};
	const browser = new Browser<BrowserRow>({
		title: "Markdown",
		host,
		key: identity,
		line: (row, _width, theme) => {
			if (row.kind === "pane") return `${plainLine(paneTitle(row.pane))}  ${theme.fg("dim", paneState(row.pane))}`;
			if (row.kind === "document") {
				const updated = Date.parse(row.document.updatedAt);
				const changed = Number.isFinite(updated) ? ` · ${age(updated)}` : "";
				return `${theme.fg("dim", `${row.document.id} · r${row.document.revision}${changed}`)}  ${plainLine(label(row))}`;
			}
			const bytes = row.response.bytes;
			const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
			const partial = row.response.completeness.state === "partial" ? " partial" : "";
			const time = row.response.timestamp !== undefined ? ` · ${age(row.response.timestamp)}` : "";
			return `${theme.fg("dim", `${size}${time}${partial}`)}  ${plainLine(label(row))}`;
		},
		detail: (row) => {
			if (!row)
				return state.scope === "live"
					? "Live panes lists readers connected to this conversation only."
					: "New scratchpad opens a blank native editor. Select a response or document to read or edit.";
			if (row.kind === "pane")
				return `${describePane(row.pane)}\n\nInspect pane checks this exact view again without opening a copy.`;
			if (row.kind === "document")
				return `${plainLine(row.document.title)}\n${row.document.id} · revision ${row.document.revision} · ${row.document.bytes} bytes\n\nRead opens the saved document. Edit creates a private editing session; Save appends a revision. Edit a Copy leaves this document unchanged.`;
			const response = row.response;
			return `Response ${response.entryId} · ${response.bytes} bytes\n${response.completeness.state}${response.completeness.reason ? ` (${response.completeness.reason})` : ""} · response state, not task acceptance\n\nPreview only:\n${plainLine(response.preview)}\n\nRead acquires the complete response by entry identity. Edit a Copy preserves this captured response.`;
		},
		actions,
		scopes: [
			{ id: "recent", label: listLive ? "Recent" : "Recent responses" },
			{ id: "published", label: "Published" },
			...(listLive ? [{ id: "live", label: "Live panes" }] : []),
		],
		scope: () => state.scope,
		onScope: (scope) => void load(scope as Scope),
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
		empty: () => (state.scope === "live" ? "No matching connected panes." : "No documents or responses in this list."),
		onSelect: (row) => {
			const key = row ? identity(row) : undefined;
			if (!listing && key !== state.selected) cancel();
			state.selected = key;
		},
	});
	void load(state.scope);
	return browser;
}
