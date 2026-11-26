/**
 * The stash browser. Ordinary Pi binds its operations to the store; the attached terminal binds
 * them to the `stash` command route of the selected agent. The view owns no store: selection reads
 * one artifact, and every lifecycle change is its own labelled action with a staged form. Pick up
 * is the only action that starts conversation work.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Markdown,
	matchesKey,
	SelectList,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { BrowserView } from "./browser-views.ts";
import { resumeCommand, stateLabel } from "./format.ts";
import { type Action, fitLine, type KeyHint, keyMatches, plainLine, type View, type ViewHost } from "./frame.ts";
import type { StashEntry } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";
import { Form, READER_KEYS, Reader, readerView, wrap } from "./view-parts.ts";

/** Reads and effects the view needs; every effect answers its receipt text. */
export interface StashOperations {
	recent(signal: AbortSignal): Promise<BrowserView>;
	/** One archive page. A rejected cursor or a store change answers the prior view marked stale. */
	archive(
		query: string,
		cursor: string | undefined,
		prior: BrowserView | undefined,
		signal: AbortSignal,
	): Promise<BrowserView>;
	preview(entry: StashEntry, signal: AbortSignal): Promise<StashEntry>;
	/**
	 * Activate the record and deliver its handover. A route that delivers into the conversation
	 * the browser covers calls `leave` to close the browser first. A returned receipt is shown; an
	 * empty one means the owner reported the outcome itself.
	 */
	pickup(id: string, note: string | undefined, leave: (then: () => unknown) => void): Promise<string>;
	close(id: string, outcome: string): Promise<string>;
	release(id: string): Promise<string>;
	reopen(id: string): Promise<string>;
	rotate(id: string): Promise<string>;
	/** A client clipboard write, separate from every store effect. */
	copy(text: string): Promise<void>;
}

/** Browsing position that survives leaving and reopening the view. */
export interface StashViewState {
	scope: "recent" | "archive";
	filter: string;
	query: string;
	selected?: string;
	archive?: BrowserView;
}

export function createStashViewState(): StashViewState {
	return { scope: "recent", filter: "", query: "" };
}

type Read<T> = { state: "pending" } | { state: "ready"; value: T } | { state: "failed"; error: string };
type Region = "search" | "scopes" | "list" | "detail";

/** Below this width the detail is its own view, opened with Right. */
const SPLIT_MIN_WIDTH = 90;
const LABEL_COLUMNS = 8;
const SCOPES = [
	{ id: "recent", label: "Recent" },
	{ id: "archive", label: "Search archive" },
] as const;
const SELECT: KeyHint = { keys: ["up", "down"], label: "select", priority: 0 };
const FOCUS: KeyHint = { keys: ["tab"], label: "focus", priority: 3 };

const safe = (value: string) => sanitizeTerminalText(value).text;
const flat = (value: string) => plainLine(safe(value));
const message = (error: unknown) => flat(error instanceof Error ? error.message : String(error));
const identity = (text: string) => text;

function entryDate(value: string): string {
	const compact = value.match(/^(\d{4})(\d{2})(\d{2})/);
	return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : value.slice(0, 10);
}

function entryMark(entry: StashEntry): string {
	if (entry.previewError !== undefined || entry.meta.invalidState !== undefined) return "◈";
	return { open: "○", active: "◐", closed: "●", unknown: "◈" }[entry.meta.state];
}

/** Why no lifecycle action can apply to this record, or undefined when its state is known. */
function unreadable(entry: StashEntry): string | undefined {
	if (entry.meta.invalidState !== undefined)
		return `State "${flat(entry.meta.invalidState)}" is not a recognised lifecycle state`;
	if (entry.previewError !== undefined) return "Its header could not be read, so its state is unknown";
	return undefined;
}

function headLines(entry: StashEntry): string[] {
	const meta = entry.meta;
	const optional = (label: string, value: string | undefined) => (value ? `${label}: ${flat(value)}` : "");
	return [
		`${stateLabel(meta, entry.previewError !== undefined)} · stashed ${flat(meta.created) || "?"}`,
		`${flat(meta.project ?? "project unknown")}${meta.branch ? ` · ${flat(meta.branch)}` : ""}`,
		`id: ${flat(meta.id)}`,
		optional("session", meta.sessionId),
		`file: ${flat(entry.path)}`,
		optional("activated", meta.activatedAt),
		optional("closed", meta.closedAt),
		optional("outcome", meta.outcome),
		meta.tags.length > 0 ? `tags: ${meta.tags.map(flat).join(", ")}` : "",
	].filter((value) => value !== "");
}

const helpText = [
	"What this is",
	"A browser over stashed handovers. Select one on the left and read it on the right. /stash new <hint> creates another.",
	"",
	"What the keys do",
	"Enter picks up the selected stash: it activates the stash and delivers its handover to the bound conversation. On a closed stash, Enter reopens it. Right moves to the detail; at narrow widths it opens the detail as its own view. a picks up with a note that goes ahead of the handover. On an active stash, l opens the release confirmation and o closes with an outcome. c copies the resume command. r reads the list and the selected record again. x lists the remaining actions, including rotate. / filters the newest stashes or, in Search archive, searches full bodies.",
	"",
	"Closing",
	"Escape closes the browser. Closing discards nothing. No lifecycle state changes unless you choose an action, and cancelling a note picks nothing up.",
].join("\n");

function markdownLines(theme: Theme, text: string, width: number): string[] {
	const rendered = new Markdown(safe(text), 0, 0, {
		heading: (value) => theme.bold(value),
		link: identity,
		linkUrl: identity,
		code: identity,
		codeBlock: identity,
		codeBlockBorder: identity,
		quote: identity,
		quoteBorder: identity,
		hr: identity,
		listBullet: identity,
		bold: (value) => theme.bold(value),
		italic: (value) => theme.italic(value),
		strikethrough: (value) => theme.strikethrough(value),
		underline: (value) => theme.underline(value),
	}).render(Math.max(1, width));
	// Wrapping each rendered line keeps every character of a long line reachable.
	return rendered.flatMap((value) => wrap(value.trimEnd(), Math.max(1, width)));
}

/** Fields the Recent filter matches: identity, title, dates, place, tags, state, outcome and any read body. */
function filterText(entry: StashEntry): string {
	const meta = entry.meta;
	return [
		meta.id,
		meta.title,
		meta.created,
		meta.project ?? "",
		meta.branch ?? "",
		meta.tags.join(" "),
		stateLabel(meta, entry.previewError !== undefined),
		meta.outcome ?? "",
		entry.preview ?? "",
	]
		.join("\n")
		.toLocaleLowerCase();
}

/**
 * Search, scopes, the list and the selected record's detail as one view. Selecting a row never runs
 * an effect. `/` focuses the search field, which keeps every printable key as text; Right opens the
 * detail: focus beside the list, or its own view at narrow widths. PageUp and PageDown read the
 * detail beside the list.
 */
class StashView implements View {
	readonly title = "Stashes";
	focused = false;
	private readonly host: ViewHost;
	private readonly ops: StashOperations;
	private readonly state: StashViewState;
	private readonly search = new Input({ prompt: "" });
	private readonly reader = new Reader();
	private region: Region = "list";
	private split = true;
	/** The listed records, in list order. */
	private items: StashEntry[] = [];
	/** The list as last built for these items, size and theme; rebuilt when any of them changes. */
	private list?: {
		readonly select: SelectList;
		readonly width: number;
		readonly height: number;
		readonly items: readonly StashEntry[];
	};
	private listWidth = 0;
	private layout = { top: 2, height: 1 };
	/** Host of the narrow detail view open now; its actions push from it. */
	private detailHost?: ViewHost;
	private recent: Read<BrowserView> = { state: "pending" };
	private searching?: AbortController;
	private archiveNotice?: string;
	/** Records read on selection, by id; a read replaces the listed row's facts. */
	private readonly loaded = new Map<string, Read<StashEntry>>();
	/** The preview read in flight, so a superseded read is discarded with its own cache entry. */
	private previewing?: { id: string; controller: AbortController };
	/** Monotonic list-read generation: a late older list read never replaces a newer one. */
	private listLoad = 0;
	private busy?: string;
	private rendered?: { key: string; width: number; lines: readonly string[] };

	constructor(host: ViewHost, ops: StashOperations, state: StashViewState) {
		this.host = host;
		this.ops = ops;
		this.state = state;
		this.setQuery(state.scope === "archive" ? state.query : state.filter);
		host.signal.addEventListener("abort", () => {
			this.searching?.abort();
			this.previewing?.controller.abort();
		});
		void this.loadRecent();
		if (state.scope === "archive") this.refreshItems();
	}

	/** The listed row, or the record as read on selection. */
	private current(entry: StashEntry): StashEntry {
		const read = this.loaded.get(entry.meta.id);
		return read?.state === "ready" ? read.value : entry;
	}

	private selectedEntry(): StashEntry | undefined {
		return this.items.find((entry) => entry.meta.id === this.state.selected);
	}

	/** The selected listed record. */
	get selected(): StashEntry | undefined {
		return this.selectedEntry();
	}

	private line(listed: StashEntry): string {
		const theme = this.host.theme;
		const entry = this.current(listed);
		const mark = theme.fg(entry.meta.state === "active" ? "accent" : "muted", entryMark(entry));
		return `${mark} ${theme.fg("dim", entryDate(entry.meta.created))} ${flat(entry.meta.title)}`;
	}

	private filtered(): StashEntry[] {
		if (this.state.scope === "archive") return this.state.archive?.entries ?? [];
		const loaded = this.recent.state === "ready" ? this.recent.value.entries : [];
		const needle = this.state.filter.trim().toLocaleLowerCase();
		return needle ? loaded.filter((entry) => filterText(this.current(entry)).includes(needle)) : loaded;
	}

	/**
	 * Take the current items, keeping the selection by identity; a vanished selection moves to the
	 * nearest row. The kept or moved selection is read when it has not been read yet.
	 */
	private refreshItems(): void {
		const previous = this.state.selected;
		const index = this.items.findIndex((entry) => entry.meta.id === previous);
		this.items = this.filtered();
		this.list = undefined;
		const kept = this.items.find((entry) => entry.meta.id === previous);
		this.selectEntry(kept ?? this.items[Math.max(0, Math.min(this.items.length - 1, index < 0 ? 0 : index))]);
		this.host.requestRender();
	}

	private async loadRecent(): Promise<void> {
		const load = ++this.listLoad;
		this.recent = { state: "pending" };
		this.host.requestRender();
		try {
			const value = await this.ops.recent(this.host.signal);
			if (this.host.signal.aborted || load !== this.listLoad) return;
			this.recent = { state: "ready", value };
		} catch (error) {
			if (this.host.signal.aborted || load !== this.listLoad) return;
			this.recent = { state: "failed", error: message(error) };
		}
		this.refreshItems();
	}

	/** A first page for the typed query, or the next page of the shown one. */
	private async searchArchive(cursor: string | undefined): Promise<void> {
		const query = cursor === undefined ? this.state.query.trim() : (this.state.archive?.query ?? "");
		if (!query) return;
		this.searching?.abort();
		const controller = new AbortController();
		this.searching = controller;
		const signal = AbortSignal.any([controller.signal, this.host.signal]);
		const load = ++this.listLoad;
		this.archiveNotice = "Searching full bodies…";
		this.host.requestRender();
		try {
			const prior = cursor === undefined ? undefined : this.state.archive;
			const view = await this.ops.archive(query, cursor, prior, signal);
			if (signal.aborted || load !== this.listLoad) return;
			this.state.archive = view;
			this.archiveNotice = undefined;
		} catch (error) {
			if (signal.aborted || load !== this.listLoad) return;
			this.archiveNotice = `Search could not run: ${message(error)}`;
		}
		this.refreshItems();
	}

	/** Read the current view again after an effect, so the list shows the changed record. */
	private async reload(): Promise<void> {
		if (this.state.scope === "recent") return this.loadRecent();
		const view = this.state.archive;
		if (!view) return;
		const load = ++this.listLoad;
		const signal = this.host.signal;
		try {
			const next = await this.ops.archive(view.query, view.cursor, view, signal);
			if (signal.aborted || load !== this.listLoad) return;
			this.state.archive = next;
		} catch (error) {
			if (signal.aborted || load !== this.listLoad) return;
			this.archiveNotice = `Search could not run: ${message(error)}`;
		}
		this.refreshItems();
	}

	private textChanged(text: string): void {
		if (this.state.scope === "archive") {
			this.state.query = text;
			this.searching?.abort();
			this.archiveNotice =
				this.state.archive && text.trim() !== this.state.archive.query
					? "Query changed · press Enter or choose Search"
					: undefined;
		} else this.state.filter = text;
		this.refreshItems();
	}

	private setQuery(text: string): void {
		this.search.setValue("");
		// A bracketed paste is the input's public way to insert text with the cursor after it.
		if (text) this.search.handleInput(`\u001b[200~${text}\u001b[201~`);
	}

	private switchScope(scope: StashViewState["scope"]): void {
		if (scope === this.state.scope) return;
		this.state.scope = scope;
		this.setQuery(scope === "archive" ? this.state.query : this.state.filter);
		this.items = [];
		this.refreshItems();
	}

	/** The selection changed: a passive read of the record starts, never an effect. */
	private selectEntry(entry: StashEntry | undefined): void {
		this.state.selected = entry?.meta.id;
		this.list?.select.setSelectedIndex(entry ? Math.max(0, this.items.indexOf(entry)) : 0);
		if (!entry) {
			this.previewing?.controller.abort();
			this.previewing = undefined;
			return;
		}
		const known = this.loaded.get(entry.meta.id);
		if (known?.state === "ready" || known?.state === "pending") return;
		this.readPreview(entry);
	}

	/** Start one preview read, discarding any earlier read it supersedes. */
	private readPreview(entry: StashEntry): void {
		const prior = this.previewing;
		prior?.controller.abort();
		if (prior && this.loaded.get(prior.id)?.state === "pending") this.loaded.delete(prior.id);
		const controller = new AbortController();
		this.previewing = { id: entry.meta.id, controller };
		const signal = AbortSignal.any([controller.signal, this.host.signal]);
		this.loaded.set(entry.meta.id, { state: "pending" });
		this.ops.preview(entry, signal).then(
			(value) => {
				if (signal.aborted || this.previewing?.controller !== controller) return;
				this.loaded.set(entry.meta.id, { state: "ready", value });
				this.list = undefined;
				this.host.requestRender();
			},
			(error: unknown) => {
				if (signal.aborted || this.previewing?.controller !== controller) return;
				this.loaded.set(entry.meta.id, { state: "failed", error: message(error) });
				this.host.requestRender();
			},
		);
	}

	/**
	 * Reread the selected record after an effect or an explicit refresh. The selection does not
	 * change when the id is unchanged, so the read starts here, not from a cleared cache alone.
	 */
	private rereadSelected(): void {
		const entry = this.selectedEntry();
		if (entry) this.readPreview(entry);
	}

	private body(entry: StashEntry, width: number): readonly string[] {
		const read = this.loaded.get(entry.meta.id);
		if (!read || read.state === "pending") return ["Reading the stash…"];
		if (read.state === "failed") return [`Preview unavailable: ${read.error}`];
		if (read.value.previewError !== undefined) return [`Preview unavailable: ${flat(read.value.previewError)}`];
		const key = `${entry.meta.id}:${read.value.preview?.length ?? 0}`;
		if (this.rendered?.key !== key || this.rendered.width !== width)
			this.rendered = { key, width, lines: markdownLines(this.host.theme, read.value.preview ?? "", width) };
		return read.value.previewTruncated
			? [...this.rendered.lines, "", "[preview truncated; pickup reads the full artifact]"]
			: this.rendered.lines;
	}

	/** The detail of one record as display lines for a width. */
	detailLines(listed: StashEntry | undefined, width: number): readonly string[] {
		if (!listed)
			return wrap(this.state.scope === "archive" ? "Search results appear here." : "Select a stash to read it.", width);
		const entry = this.current(listed);
		const lines = [this.host.theme.bold(flat(entry.meta.title)), ...headLines(entry), "", ...this.body(entry, width)];
		return lines.flatMap((line) => wrap(line, width));
	}

	detailKey(entry: StashEntry): string {
		return `${entry.meta.id}:${this.loaded.get(entry.meta.id)?.state ?? "listed"}`;
	}

	/** The listed record of one id, or undefined once it is no longer listed. */
	itemOf(id: string): StashEntry | undefined {
		return this.items.find((entry) => entry.meta.id === id);
	}

	/** Why effects on this record are unavailable now, or undefined. */
	private blocked(entry: StashEntry): string | undefined {
		if (this.busy) return `${this.busy} is running`;
		if (this.state.scope === "archive" && this.state.archive?.stale)
			return "The search results are stale; Refresh first";
		return unreadable(entry);
	}

	actions(): readonly Action[] {
		return this.actionsOf(this.selectedEntry());
	}

	actionsOf(listed: StashEntry | undefined): Action[] {
		const actions: Action[] = listed ? this.recordActions(this.current(listed)) : [];
		actions.push({
			id: "help",
			label: "Help",
			key: "h",
			short: "help",
			primary: true,
			run: () => this.push((next) => readerView("Help", next, () => helpText)),
		});
		if (this.state.scope === "archive") {
			const view = this.state.archive;
			actions.push({
				id: "search",
				label: "Search",
				disabled: this.state.query.trim() ? undefined : "Type text to search for",
				description: "Search full bodies with the bounded stash search",
				run: () => void this.searchArchive(undefined),
			});
			actions.push({
				id: "continue",
				label: "Continue",
				disabled: view?.nextCursor && !view.stale ? undefined : "No further page",
				description: "Read the next bounded page",
				run: () => void this.searchArchive(view?.nextCursor ?? undefined),
			});
		}
		actions.push({
			id: "refresh",
			label: "Refresh",
			key: "r",
			short: "refresh",
			primary: true,
			description:
				this.state.scope === "archive"
					? "Run the search again from its first page and reread the selected record"
					: "Read the newest stashes again and reread the selected record",
			run: () => void this.refresh(),
		});
		return actions;
	}

	private recordActions(entry: StashEntry): Action[] {
		const blocked = this.blocked(entry);
		const id = entry.meta.id;
		const state = entry.meta.state;
		const actions: Action[] = [];
		if (state === "active")
			actions.push({
				id: "release",
				label: "Release…",
				key: "l",
				short: "release",
				primary: true,
				disabled: blocked,
				description: "Return it to open",
				run: () => this.push((next) => this.confirmForm(next, entry, "release")),
			});
		if (state === "open" || state === "active") {
			actions.push({
				id: "pickup",
				label: "Pick up",
				key: "enter",
				short: "pick up",
				primary: true,
				disabled: blocked,
				description: `Activate it and deliver its handover to ${this.host.target.label}`,
				run: () => void this.pickup(entry, undefined),
			});
			actions.push({
				id: "note",
				label: "Pick up with note…",
				key: "a",
				short: "note",
				primary: true,
				disabled: blocked,
				description: "Add a note that goes ahead of the handover",
				run: () => this.push((next) => this.noteForm(next, entry)),
			});
		}
		if (state === "active")
			actions.push({
				id: "close",
				label: "Close with outcome…",
				key: "o",
				short: "close stash",
				primary: true,
				disabled: blocked,
				run: () => this.push((next) => this.closeForm(next, entry)),
			});
		if (state === "closed")
			actions.push({
				id: "reopen",
				label: "Reopen…",
				key: "enter",
				short: "reopen",
				primary: true,
				disabled: blocked,
				run: () => this.push((next) => this.confirmForm(next, entry, "reopen")),
			});
		if (state === "open" || state === "closed")
			actions.push({
				id: "rotate",
				label: "Rotate…",
				tone: "danger",
				disabled: blocked,
				description: "Move it to the store's .trash directory",
				run: () => this.push((next) => this.confirmForm(next, entry, "rotate")),
			});
		actions.push({
			id: "copy",
			label: "Copy resume command",
			key: "c",
			short: "copy",
			primary: true,
			description: `Copy ${resumeCommand(id)} for a new session`,
			run: () => void this.copy(id),
		});
		return actions;
	}

	/** Open a nested view from where the browser shows now: the narrow detail while it is open, so Cancel returns to it. */
	private push(open: (host: ViewHost) => View): void {
		const host = this.detailHost && !this.detailHost.signal.aborted ? this.detailHost : this.host;
		host.push(open);
	}

	/** An explicit refresh rereads the list, then the selected record, even when its id is unchanged. */
	private async refresh(): Promise<void> {
		if (this.state.scope === "archive") await this.searchArchive(undefined);
		else await this.loadRecent();
		this.rereadSelected();
	}

	/** Pick up once; the answer is the receipt or the refusal, never a rejection. */
	private async pickup(entry: StashEntry, note: string | undefined): Promise<{ receipt: string } | { error: string }> {
		this.busy = "Pickup";
		this.host.notify(`Picking up ${entry.meta.id}…`, "pending");
		try {
			const receipt = await this.ops.pickup(entry.meta.id, note, (then) => this.host.close(then));
			if (this.host.signal.aborted) return { receipt };
			this.host.notify(receipt || `Picked up ${entry.meta.id}`, "success");
			this.rereadSelected();
			void this.reload();
			return { receipt };
		} catch (error) {
			const text = message(error);
			if (!this.host.signal.aborted) this.host.notify(text, "error");
			return { error: text };
		} finally {
			this.busy = undefined;
		}
	}

	private noteForm(host: ViewHost, entry: StashEntry): View {
		return new Form({
			title: "Pick up with note",
			heading: `Pick up “${flat(entry.meta.title)}” with a note`,
			intro:
				"The note goes ahead of the handover. Cancel returns here without pickup; an empty note picks up without one.",
			field: { label: "Note", rows: 5 },
			action: { label: "Pick up" },
			host,
			submit: async (note) => {
				const result = await this.pickup(entry, note.trim() || undefined);
				if ("error" in result) throw new Error(result.error);
				return result.receipt ? { notice: { text: result.receipt, kind: "success" } } : undefined;
			},
		});
	}

	private closeForm(host: ViewHost, entry: StashEntry): View {
		return new Form({
			title: "Close with outcome",
			heading: `Close “${flat(entry.meta.title)}”`,
			intro: "Record the concrete outcome: what completed, failed, or was abandoned. The artifact stays.",
			field: { label: "Outcome", rows: 5 },
			action: { label: "Close stash" },
			host,
			validate: (outcome) => (outcome.trim() ? undefined : "Write the concrete outcome first."),
			submit: async (outcome) => {
				const result = await this.effect(() => this.ops.close(entry.meta.id, outcome.trim()));
				const [summary, ...details] = result.notice.text.split("\n");
				return {
					notice: { ...result.notice, text: summary ?? "" },
					...(details.length
						? { after: () => this.push((next) => readerView("Close receipt", next, () => result.notice.text)) }
						: {}),
				};
			},
		});
	}

	private confirmForm(host: ViewHost, entry: StashEntry, effect: "release" | "reopen" | "rotate"): View {
		const id = flat(entry.meta.id);
		const copy = {
			release: {
				title: "Release",
				heading: `Release ${id} back to open`,
				intro: "The stash returns to open. Its handover stays; a later pickup activates it again.",
				label: "Release",
			},
			reopen: {
				title: "Reopen",
				heading: `Reopen ${id}`,
				intro: "This clears the closure outcome and returns the stash to open.",
				label: "Reopen",
			},
			rotate: {
				title: "Rotate",
				heading: `Rotate ${id} to the archive`,
				intro:
					"This moves the file into the stash store's .trash directory. It leaves listings and pickup; the file stays recoverable.",
				label: "Rotate",
			},
		}[effect];
		return new Form({
			title: copy.title,
			heading: copy.heading,
			intro: copy.intro,
			action: { label: copy.label, tone: effect === "rotate" ? "danger" : "accent" },
			host,
			submit: async () => this.effect(() => this.ops[effect](entry.meta.id)),
		});
	}

	/** Run one lifecycle effect, show its receipt, and read the list and the selected record again. */
	private async effect(run: () => Promise<string>): Promise<{ notice: { text: string; kind: "success" } }> {
		const text = await run();
		this.rereadSelected();
		void this.reload();
		return { notice: { text, kind: "success" } };
	}

	private async copy(id: string): Promise<void> {
		try {
			await this.ops.copy(resumeCommand(id));
			if (!this.host.signal.aborted) this.host.notify(`Copied ${resumeCommand(id)}`, "success");
		} catch (error) {
			if (!this.host.signal.aborted) this.host.notify(`Clipboard copy failed: ${message(error)}`, "error");
		}
	}

	private status(): string {
		if (this.state.scope === "archive") {
			const view = this.state.archive;
			if (this.archiveNotice) return this.archiveNotice;
			if (!view) return "Type text, then press Enter or choose Search.";
			return view.stale
				? `Stale: ${view.coverage ?? "the store changed"} · Refresh restarts the search`
				: (view.coverage ?? "");
		}
		if (this.recent.state === "pending") return "Reading stashes…";
		if (this.recent.state === "failed")
			return `The stash store could not be read; Refresh retries: ${this.recent.error}`;
		const total = this.recent.value.entries.length;
		const more = this.recent.value.hasMore ? " (newest 200)" : "";
		return this.state.filter.trim()
			? `${this.items.length} of ${total}${more} match`
			: `${total} stashes${more} · newest first`;
	}

	private empty(): string {
		if (this.state.scope === "archive") {
			if (!this.state.archive) return "Search full stash bodies for remembered text.";
			return this.state.archive.nextCursor ? "No match on this page. Continue reads the next page." : "No match.";
		}
		if (this.recent.state !== "ready")
			return this.recent.state === "failed" ? "Unavailable: the store could not be read." : "Reading…";
		return this.state.filter.trim()
			? "No stash matches the filter."
			: "No stashes yet. Create one with /stash new <hint>.";
	}

	editing(): boolean {
		return this.region === "search";
	}

	private regions(): Region[] {
		return this.split ? ["search", "scopes", "list", "detail"] : ["search", "scopes", "list"];
	}

	focusNext(backward: boolean): boolean {
		const order = this.regions();
		const next = order.indexOf(this.region) + (backward ? -1 : 1);
		if (next < 0 || next >= order.length) return false;
		this.region = order[next] ?? this.region;
		return true;
	}

	focusEdge(backward: boolean): void {
		this.region = backward ? (this.regions().at(-1) ?? "list") : "list";
	}

	/** Escape clears a search edit, then leaves the search field, the scope row or the detail for the list. */
	escape(): boolean {
		if (this.region === "search" && this.search.getValue()) {
			this.setQuery("");
			this.textChanged("");
			return true;
		}
		if (this.region === "list") return false;
		this.region = "list";
		return true;
	}

	/** The keys of the focused region; the record's actions follow them on the key row. */
	keys(): readonly KeyHint[] {
		if (this.region === "search") {
			const enter = this.state.scope === "archive" ? "search" : "done";
			return [
				SELECT,
				{ keys: ["enter"], label: enter },
				FOCUS,
				{ keys: ["escape"], label: this.search.getValue() ? "clear" : "list" },
			];
		}
		if (this.region === "scopes")
			return [
				{ keys: ["left", "right"], label: "switch" },
				{ keys: ["enter"], label: "list" },
				FOCUS,
				{ keys: ["escape"], label: "list" },
			];
		if (this.region === "detail") return [...READER_KEYS, FOCUS, { keys: ["escape"], label: "list" }];
		// When the row is short, Tab leaves first, then the detail and paging keys; search stays with the actions.
		const hints: KeyHint[] = [
			SELECT,
			{ keys: ["pageUp", "pageDown"], label: this.split ? "read" : "page" },
			{ keys: ["/"], label: "search", priority: 1 },
		];
		if (this.selectedEntry()) {
			const enterTaken = this.actions().some((action) => action.key === "enter");
			hints.push({ keys: [enterTaken ? "right" : "enter"], label: this.split ? "detail" : "open" });
		}
		hints.push(FOCUS);
		return hints;
	}

	private open(): void {
		const entry = this.selectedEntry();
		if (!entry) return;
		if (this.split) {
			this.region = "detail";
			return;
		}
		const id = entry.meta.id;
		this.host.push((child) => {
			this.detailHost = child;
			return detailView(this, id, flat(entry.meta.title).slice(0, 48) || "Detail", child);
		});
	}

	handleInput(data: string): boolean {
		if (this.region === "search") return this.searchInput(data);
		if (this.region === "scopes") return this.scopeInput(data);
		if (this.region === "detail") return this.reader.handleInput(data);
		return this.listInput(data);
	}

	private listInput(data: string): boolean {
		if (keyMatches(data, "/")) this.region = "search";
		else if (matchesKey(data, "right") || matchesKey(data, "enter")) this.open();
		// Beside the list, PageUp and PageDown read the detail; the selection stays.
		else if (this.split && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) this.reader.handleInput(data);
		else if (matchesKey(data, "home") || matchesKey(data, "end"))
			this.selectEntry(matchesKey(data, "home") ? this.items[0] : this.items.at(-1));
		else if (
			matchesKey(data, "up") ||
			matchesKey(data, "down") ||
			matchesKey(data, "pageUp") ||
			matchesKey(data, "pageDown")
		)
			this.list?.select.handleInput(data);
		else return false;
		return true;
	}

	private searchInput(data: string): boolean {
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.list?.select.handleInput(data);
			return true;
		}
		if (matchesKey(data, "enter")) {
			if (this.state.scope === "archive" && this.search.getValue().trim()) void this.searchArchive(undefined);
			this.region = "list";
			return true;
		}
		const before = this.search.getValue();
		this.search.handleInput(data);
		const after = this.search.getValue();
		if (after !== before) this.textChanged(after);
		return true;
	}

	private scopeInput(data: string): boolean {
		if (matchesKey(data, "left") || matchesKey(data, "right"))
			this.switchScope(matchesKey(data, "left") ? "recent" : "archive");
		else if (matchesKey(data, "down") || matchesKey(data, "enter")) this.region = "list";
		else return false;
		return true;
	}

	/** Rows: the search field with the scopes, the status line, then the list and the detail. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y === 0) return this.headerClick(event);
		const { top, height } = this.layout;
		if (event.y < top || event.y >= top + height) return undefined;
		if (this.split && event.x > this.listWidth) return this.detailPointer(event);
		if (this.split && event.x === this.listWidth) return undefined;
		return this.listPointer({ ...event, y: event.y - top, height });
	}

	/** The wheel reads the detail beside the list; a click moves focus there. */
	private detailPointer(event: TuiMouseEvent): TuiMouseEventResult {
		if (event.type === "wheel") this.reader.scroll(Math.trunc(event.wheelDelta ?? 0));
		else this.region = "detail";
		return { handled: true };
	}

	/** Pi's list takes clicks and the wheel; a click focuses the list and a double click opens the detail. */
	private listPointer(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = this.list?.select.handleMouse(event);
		if (event.type !== "click") return result;
		this.region = "list";
		if ((event.clickCount ?? 1) >= 2) this.open();
		return result ?? { handled: true };
	}

	private scopeSpans(width: number): Array<{ id: StashViewState["scope"]; x: number; width: number; label: string }> {
		const labels = SCOPES.map((scope) => ({ id: scope.id, label: ` ${scope.label} ` }));
		let x = width - labels.reduce((total, scope) => total + visibleWidth(scope.label) + 1, 0) + 1;
		return labels.map((scope) => {
			const span = { ...scope, x, width: visibleWidth(scope.label) };
			x += span.width + 1;
			return span;
		});
	}

	private headerClick(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click") return undefined;
		const scope = this.scopeSpans(event.width).find((span) => event.x >= span.x && event.x < span.x + span.width);
		if (scope) {
			this.switchScope(scope.id);
			return { handled: true };
		}
		this.region = "search";
		if (event.x >= LABEL_COLUMNS) this.search.handleMouse({ ...event, x: event.x - LABEL_COLUMNS });
		return { handled: true, focus: true };
	}

	render(width: number, height: number): string[] {
		const theme = this.host.theme;
		this.split = width >= SPLIT_MIN_WIDTH;
		if (!this.split && this.region === "detail") this.region = "list";
		const lines = [this.searchRow(width, theme), fitLine(theme.fg("muted", plainLine(this.status())), width)];
		const bodyHeight = Math.max(1, height - lines.length);
		this.layout = { top: lines.length, height: bodyHeight };
		this.listWidth = this.split ? Math.max(30, Math.min(64, Math.floor(width * 0.42))) : width;
		const list = this.renderList(this.listWidth, bodyHeight, theme);
		if (!this.split) return [...lines, ...list];
		const detailWidth = Math.max(1, width - this.listWidth - 1);
		const entry = this.selectedEntry();
		this.reader.show(entry ? this.detailKey(entry) : undefined);
		const detail = this.reader.render(
			this.detailLines(entry, Math.max(1, detailWidth - 1)),
			detailWidth,
			bodyHeight,
			theme,
		);
		const divider = theme.fg(this.focused && this.region === "detail" ? "accent" : "borderMuted", "│");
		for (let row = 0; row < bodyHeight; row++)
			lines.push(`${fitLine(list[row] ?? "", this.listWidth)}${divider}${detail[row] ?? ""}`);
		return lines;
	}

	private searchRow(width: number, theme: Theme): string {
		const spans = this.scopeSpans(width);
		const room = Math.max(LABEL_COLUMNS + 1, (spans[0]?.x ?? width) - 1);
		const focused = this.focused && this.region === "search";
		this.search.focused = focused;
		const label = fitLine(theme.fg(focused ? "accent" : "muted", "Search"), LABEL_COLUMNS);
		const placeholder =
			this.state.scope === "archive" ? "text to find in full bodies, then Enter" : "filter the newest stashes";
		const field =
			!focused && !this.search.getValue()
				? theme.fg("dim", `/ ${placeholder}`)
				: (this.search.render(room - LABEL_COLUMNS)[0] ?? "");
		const scopes = spans.map((span) => {
			const active = span.id === this.state.scope;
			const styled = active ? theme.bold(theme.fg("accent", span.label)) : theme.fg("muted", span.label);
			return this.focused && this.region === "scopes" && active ? theme.bg("selectedBg", styled) : styled;
		});
		return fitLine(`${label}${fitLine(field, room - LABEL_COLUMNS)} ${scopes.join(" ")}`, width);
	}

	private renderList(width: number, height: number, theme: Theme): string[] {
		if (this.items.length === 0) return [fitLine(theme.fg("muted", plainLine(this.empty())), width)];
		if (!this.list || this.list.width !== width || this.list.height !== height || this.list.items !== this.items) {
			const rowWidth = width;
			const select = new SelectList(
				this.items.map((entry) => ({ value: entry.meta.id, label: this.line(entry) })),
				this.items.length > height ? Math.max(1, height - 1) : height,
				{
					selectedPrefix: identity,
					selectedText: (text) => theme.bg("selectedBg", fitLine(text, rowWidth)),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("dim", text),
				},
				{ minPrimaryColumnWidth: width, maxPrimaryColumnWidth: width },
			);
			select.setSelectedIndex(
				Math.max(
					0,
					this.items.findIndex((entry) => entry.meta.id === this.state.selected),
				),
			);
			select.onSelectionChange = (item) => this.selectEntry(this.itemOf(item.value));
			this.list = { select, width, height, items: this.items };
		}
		return this.list.select.render(width);
	}

	invalidate(): void {
		this.list = undefined;
		this.rendered = undefined;
	}
}

/** The detail of one record as its own view at narrow widths. The record is re-resolved by id on every use. */
function detailView(browser: StashView, id: string, title: string, host: ViewHost): View {
	const reader = new Reader();
	return {
		title,
		render: (width, height) => {
			const entry = browser.itemOf(id);
			if (!entry) return [host.theme.fg("muted", "This record is no longer listed.")];
			reader.show(browser.detailKey(entry));
			return reader.render(browser.detailLines(entry, Math.max(1, width - 1)), width, height, host.theme);
		},
		handleInput: (data) => (browser.itemOf(id) ? reader.handleInput(data) : true),
		handleMouse: (event) => {
			if (event.type !== "wheel" || !event.wheelDelta) return undefined;
			reader.scroll(Math.trunc(event.wheelDelta));
			return { handled: true };
		},
		actions: () => {
			const entry = browser.itemOf(id);
			return entry ? browser.actionsOf(entry) : [];
		},
		keys: () => (browser.itemOf(id) ? READER_KEYS : []),
	};
}

/** The stash browser as a view for a frame. */
export function stashView(host: ViewHost, ops: StashOperations, state: StashViewState = createStashViewState()): View {
	return new StashView(host, ops, state);
}
