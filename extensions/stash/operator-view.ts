/**
 * The stash browser in the shared browsing frame. Ordinary Pi binds its operations to the store;
 * the attached terminal binds them to the `stash` command route of the selected agent. The view
 * owns no store: selection reads one artifact, and every lifecycle change is its own labelled
 * action with a staged form. Pick up is the only action that starts conversation work.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Action, Browser, Form, type OperatorView, plainLine, ReaderView, type ViewHost } from "../../operator-ui/index.ts";
import type { BrowserView } from "./browser-views.ts";
import { resumeCommand, stateLabel } from "./format.ts";
import type { StashEntry } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

/** Reads and effects the view needs; every effect answers its receipt text. */
export interface StashOperations {
	recent(signal: AbortSignal): Promise<BrowserView>;
	/** One archive page. A rejected cursor or a store change answers the prior view marked stale. */
	archive(query: string, cursor: string | undefined, prior: BrowserView | undefined, signal: AbortSignal): Promise<BrowserView>;
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
	if (entry.meta.invalidState !== undefined) return `State "${flat(entry.meta.invalidState)}" is not a recognised lifecycle state`;
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
	"Enter picks up the selected stash: it activates the stash and delivers its handover to the bound conversation. On a closed stash, Enter reopens it. a picks up with a note that goes ahead of the handover. o closes an active stash with an outcome. c copies the resume command. r reads the list again. x lists every other action (release and rotate). / filters the newest stashes or, in Search archive, searches full bodies.",
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
	return rendered.flatMap((value) => wrapTextWithAnsi(value.trimEnd(), Math.max(1, width)));
}

/** Fields the Recent filter matches, as the old panel did: identity, title, dates, place, tags, state, outcome and any read body. */
function filterText(entry: StashEntry): string {
	const meta = entry.meta;
	return [meta.id, meta.title, meta.created, meta.project ?? "", meta.branch ?? "", meta.tags.join(" "), stateLabel(meta, entry.previewError !== undefined), meta.outcome ?? "", entry.preview ?? ""]
		.join("\n")
		.toLocaleLowerCase();
}

class StashView {
	readonly browser: Browser<StashEntry>;
	private readonly host: ViewHost;
	private readonly ops: StashOperations;
	private readonly state: StashViewState;
	private recent: Read<BrowserView> = { state: "pending" };
	private searching?: AbortController;
	private archiveNotice?: string;
	/** Records read on selection, by id; a read replaces the listed row's facts. */
	private readonly loaded = new Map<string, Read<StashEntry>>();
	private previewing?: AbortController;
	private busy?: string;
	private rendered?: { key: string; width: number; lines: readonly string[] };

	constructor(host: ViewHost, ops: StashOperations, state: StashViewState) {
		this.host = host;
		this.ops = ops;
		this.state = state;
		this.browser = new Browser<StashEntry>({
			title: "Stashes",
			host,
			key: (entry) => entry.meta.id,
			line: (entry, _width, theme) => this.line(entry, theme),
			detail: (entry) => this.detail(entry),
			detailKey: (entry) => `${entry.meta.id}:${this.loaded.get(entry.meta.id)?.state ?? "listed"}`,
			actions: (entry) => this.actions(entry),
			scopes: [
				{ id: "recent", label: "Recent" },
				{ id: "archive", label: "Search archive" },
			],
			scope: () => this.state.scope,
			onScope: (scope) => this.switchScope(scope === "archive" ? "archive" : "recent"),
			search: {
				value: state.scope === "archive" ? state.query : state.filter,
				placeholder: () => (this.state.scope === "archive" ? "text to find in full bodies, then Enter" : "filter the newest stashes"),
				submitLabel: () => (this.state.scope === "archive" ? "search" : undefined),
				change: (text) => this.textChanged(text),
				submit: (text) => {
					if (this.state.scope === "archive" && text.trim()) void this.search(undefined);
				},
			},
			status: () => this.status(),
			empty: () => this.empty(),
			onSelect: (entry) => this.selected(entry),
		});
		host.signal.addEventListener("abort", () => {
			this.searching?.abort();
			this.previewing?.abort();
		});
		void this.loadRecent();
		if (state.scope === "archive") this.refreshItems();
	}

	/** The listed row, or the record as read on selection. */
	private current(entry: StashEntry): StashEntry {
		const read = this.loaded.get(entry.meta.id);
		return read?.state === "ready" ? read.value : entry;
	}

	private line(listed: StashEntry, theme: Theme): string {
		const entry = this.current(listed);
		const mark = theme.fg(entry.meta.state === "active" ? "accent" : "muted", entryMark(entry));
		return `${mark} ${theme.fg("dim", entryDate(entry.meta.created))} ${flat(entry.meta.title)}`;
	}

	private items(): StashEntry[] {
		if (this.state.scope === "archive") return this.state.archive?.entries ?? [];
		const loaded = this.recent.state === "ready" ? this.recent.value.entries : [];
		const needle = this.state.filter.trim().toLocaleLowerCase();
		return needle ? loaded.filter((entry) => filterText(this.current(entry)).includes(needle)) : loaded;
	}

	private refreshItems(): void {
		this.browser.setItems(this.items(), this.state.selected);
		this.host.requestRender();
	}

	private async loadRecent(): Promise<void> {
		this.recent = { state: "pending" };
		this.host.requestRender();
		try {
			const value = await this.ops.recent(this.host.signal);
			if (this.host.signal.aborted) return;
			this.recent = { state: "ready", value };
		} catch (error) {
			if (this.host.signal.aborted) return;
			this.recent = { state: "failed", error: message(error) };
		}
		this.refreshItems();
	}

	/** A first page for the typed query, or the next page of the shown one. */
	private async search(cursor: string | undefined): Promise<void> {
		const query = cursor === undefined ? this.state.query.trim() : (this.state.archive?.query ?? "");
		if (!query) return;
		this.searching?.abort();
		const controller = new AbortController();
		this.searching = controller;
		const signal = AbortSignal.any([controller.signal, this.host.signal]);
		this.archiveNotice = "Searching full bodies…";
		this.host.requestRender();
		try {
			const prior = cursor === undefined ? undefined : this.state.archive;
			const view = await this.ops.archive(query, cursor, prior, signal);
			if (signal.aborted) return;
			this.state.archive = view;
			this.archiveNotice = undefined;
		} catch (error) {
			if (signal.aborted) return;
			this.archiveNotice = `Search could not run: ${message(error)}`;
		}
		this.refreshItems();
	}

	/** Read the current view again after an effect, so the list shows the changed record. */
	private async reload(): Promise<void> {
		if (this.state.scope === "recent") return this.loadRecent();
		const view = this.state.archive;
		if (!view) return;
		const signal = this.host.signal;
		try {
			const next = await this.ops.archive(view.query, view.cursor, view, signal);
			if (signal.aborted) return;
			this.state.archive = next;
		} catch (error) {
			if (signal.aborted) return;
			this.archiveNotice = `Search could not run: ${message(error)}`;
		}
		this.refreshItems();
	}

	private textChanged(text: string): void {
		if (this.state.scope === "archive") {
			this.state.query = text;
			this.searching?.abort();
			this.archiveNotice = this.state.archive && text.trim() !== this.state.archive.query ? "Query changed · press Enter or choose Search" : undefined;
		} else this.state.filter = text;
		this.refreshItems();
	}

	private switchScope(scope: StashViewState["scope"]): void {
		if (scope === this.state.scope) return;
		this.state.scope = scope;
		this.browser.setQuery(scope === "archive" ? this.state.query : this.state.filter);
		this.browser.setItems([]);
		this.refreshItems();
	}

	private selected(entry: StashEntry | undefined): void {
		this.state.selected = entry?.meta.id;
		this.previewing?.abort();
		if (!entry) return;
		const known = this.loaded.get(entry.meta.id);
		if (known?.state === "ready" || known?.state === "pending") return;
		const controller = new AbortController();
		this.previewing = controller;
		const signal = AbortSignal.any([controller.signal, this.host.signal]);
		this.loaded.set(entry.meta.id, { state: "pending" });
		this.ops.preview(entry, signal).then(
			(value) => {
				if (signal.aborted) return;
				this.loaded.set(entry.meta.id, { state: "ready", value });
				this.host.requestRender();
			},
			(error: unknown) => {
				if (signal.aborted) {
					this.loaded.delete(entry.meta.id);
					return;
				}
				this.loaded.set(entry.meta.id, { state: "failed", error: message(error) });
				this.host.requestRender();
			},
		);
	}

	private body(entry: StashEntry, width: number): readonly string[] {
		const read = this.loaded.get(entry.meta.id);
		if (!read || read.state === "pending") return ["Reading the stash…"];
		if (read.state === "failed") return [`Preview unavailable: ${read.error}`];
		if (read.value.previewError !== undefined) return [`Preview unavailable: ${flat(read.value.previewError)}`];
		const key = `${entry.meta.id}:${read.value.preview?.length ?? 0}`;
		if (this.rendered?.key !== key || this.rendered.width !== width) this.rendered = { key, width, lines: markdownLines(this.host.theme, read.value.preview ?? "", width) };
		return read.value.previewTruncated ? [...this.rendered.lines, "", "[preview truncated; pickup reads the full artifact]"] : this.rendered.lines;
	}

	private detail(listed: StashEntry | undefined): ((width: number) => readonly string[]) | string {
		if (!listed) return this.state.scope === "archive" ? "Search results appear here." : "Select a stash to read it.";
		const entry = this.current(listed);
		const theme = this.host.theme;
		return (width) => [theme.bold(flat(entry.meta.title)), ...headLines(entry), "", ...this.body(entry, width)];
	}

	/** Why effects on this record are unavailable now, or undefined. */
	private blocked(entry: StashEntry): string | undefined {
		if (this.busy) return `${this.busy} is running`;
		if (this.state.scope === "archive" && this.state.archive?.stale) return "The search results are stale; Refresh first";
		return unreadable(entry);
	}

	private actions(listed: StashEntry | undefined): Action[] {
		const actions: Action[] = listed ? this.recordActions(this.current(listed)) : [];
		actions.push({ id: "help", label: "Help", key: "h", short: "help", primary: true, run: () => this.host.push((next) => new ReaderView("Help", next, () => helpText)) });
		if (this.state.scope === "archive") {
			const view = this.state.archive;
			actions.push({ id: "search", label: "Search", disabled: this.state.query.trim() ? undefined : "Type text to search for", description: "Search full bodies with the bounded stash search", run: () => void this.search(undefined) });
			actions.push({ id: "continue", label: "Continue", disabled: view?.nextCursor && !view.stale ? undefined : "No further page", description: "Read the next bounded page", run: () => void this.search(view?.nextCursor ?? undefined) });
		}
		actions.push({ id: "refresh", label: "Refresh", key: "r", short: "refresh", primary: true, description: this.state.scope === "archive" ? "Run the search again from its first page" : "Read the newest stashes again", run: () => void (this.state.scope === "archive" ? this.search(undefined) : this.loadRecent()) });
		return actions;
	}

	private recordActions(entry: StashEntry): Action[] {
		const blocked = this.blocked(entry);
		const id = entry.meta.id;
		const state = entry.meta.state;
		const actions: Action[] = [];
		if (state === "open" || state === "active") {
			actions.push({ id: "pickup", label: "Pick up", key: "enter", short: "pick up", primary: true, disabled: blocked, description: `Activate it and deliver its handover to ${this.host.target.label}`, run: () => void this.pickup(entry, undefined) });
			actions.push({ id: "note", label: "Pick up with note…", key: "a", short: "note", primary: true, disabled: blocked, description: "Add a note that goes ahead of the handover", run: () => this.host.push((next) => this.noteForm(next, entry)) });
		}
		if (state === "active") {
			actions.push({ id: "close", label: "Close with outcome…", key: "o", short: "close stash", primary: true, disabled: blocked, run: () => this.host.push((next) => this.closeForm(next, entry)) });
			actions.push({ id: "release", label: "Release…", disabled: blocked, description: "Return it to open", run: () => this.host.push((next) => this.confirmForm(next, entry, "release")) });
		}
		if (state === "closed") actions.push({ id: "reopen", label: "Reopen…", key: "enter", short: "reopen", primary: true, disabled: blocked, run: () => this.host.push((next) => this.confirmForm(next, entry, "reopen")) });
		if (state === "open" || state === "closed") actions.push({ id: "rotate", label: "Rotate…", tone: "danger", disabled: blocked, description: "Move it to the store's .trash directory", run: () => this.host.push((next) => this.confirmForm(next, entry, "rotate")) });
		actions.push({ id: "copy", label: "Copy resume command", key: "c", short: "copy", primary: true, description: `Copy ${resumeCommand(id)} for a new session`, run: () => void this.copy(id) });
		return actions;
	}

	/** Pick up once; the answer is the receipt or the refusal, never a rejection. */
	private async pickup(entry: StashEntry, note: string | undefined): Promise<{ receipt: string } | { error: string }> {
		this.busy = "Pickup";
		this.host.notify(`Picking up ${entry.meta.id}…`, "pending");
		try {
			const receipt = await this.ops.pickup(entry.meta.id, note, (then) => this.host.close(then));
			if (this.host.signal.aborted) return { receipt };
			this.host.notify(receipt || `Picked up ${entry.meta.id}`, "success");
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

	private noteForm(host: ViewHost, entry: StashEntry): OperatorView {
		return new Form({
			title: "Pick up with note",
			heading: `Pick up “${flat(entry.meta.title)}” with a note`,
			intro: "The note goes ahead of the handover. Cancel returns here without pickup; an empty note picks up without one.",
			fields: [{ kind: "area", id: "note", label: "Note", rows: 5 }],
			action: { label: "Pick up" },
			host,
			submit: async (values) => {
				const result = await this.pickup(entry, (values.note ?? "").trim() || undefined);
				if ("error" in result) throw new Error(result.error);
				return { close: true, ...(result.receipt ? { notice: { text: result.receipt, kind: "success" as const } } : {}) };
			},
		});
	}

	private closeForm(host: ViewHost, entry: StashEntry): OperatorView {
		return new Form({
			title: "Close with outcome",
			heading: `Close “${flat(entry.meta.title)}”`,
			intro: "Record the concrete outcome: what completed, failed, or was abandoned. The artifact stays.",
			fields: [{ kind: "area", id: "outcome", label: "Outcome", rows: 5 }],
			action: { label: "Close stash" },
			host,
			validate: (values) => ((values.outcome ?? "").trim() ? undefined : "Write the concrete outcome first."),
			submit: async (values) => this.effect(() => this.ops.close(entry.meta.id, (values.outcome ?? "").trim())),
		});
	}

	private confirmForm(host: ViewHost, entry: StashEntry, effect: "release" | "reopen" | "rotate"): OperatorView {
		const id = flat(entry.meta.id);
		const copy = {
			release: { title: "Release", heading: `Release ${id} back to open`, intro: "The stash returns to open. Its handover stays; a later pickup activates it again.", label: "Release" },
			reopen: { title: "Reopen", heading: `Reopen ${id}`, intro: "This clears the closure outcome and returns the stash to open.", label: "Reopen" },
			rotate: { title: "Rotate", heading: `Rotate ${id} to the archive`, intro: "This moves the file into the stash store's .trash directory. It leaves listings and pickup; the file stays recoverable.", label: "Rotate" },
		}[effect];
		return new Form({
			title: copy.title,
			heading: copy.heading,
			intro: copy.intro,
			fields: [],
			action: { label: copy.label, tone: effect === "rotate" ? "danger" : "accent" },
			host,
			submit: async () => this.effect(() => this.ops[effect](entry.meta.id)),
		});
	}

	/** Run one lifecycle effect, show its receipt, and read the view again. */
	private async effect(run: () => Promise<string>) {
		const text = await run();
		void this.reload();
		return { close: true, notice: { text, kind: "success" as const } };
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
			return view.stale ? `Stale: ${view.coverage ?? "the store changed"} · Refresh restarts the search` : (view.coverage ?? "");
		}
		if (this.recent.state === "pending") return "Reading stashes…";
		if (this.recent.state === "failed") return `The stash store could not be read; Refresh retries: ${this.recent.error}`;
		const total = this.recent.value.entries.length;
		const more = this.recent.value.hasMore ? " (newest 200)" : "";
		return this.state.filter.trim() ? `${this.items().length} of ${total}${more} match` : `${total} stashes${more} · newest first`;
	}

	private empty(): string {
		if (this.state.scope === "archive") {
			if (!this.state.archive) return "Search full stash bodies for remembered text.";
			return this.state.archive.nextCursor ? "No match on this page. Continue reads the next page." : "No match.";
		}
		if (this.recent.state !== "ready") return this.recent.state === "failed" ? "Unavailable: the store could not be read." : "Reading…";
		return this.state.filter.trim() ? "No stash matches the filter." : "No stashes yet. Create one with /stash new <hint>.";
	}
}

/** Open the stash browser inside a frame. */
export function stashView(host: ViewHost, ops: StashOperations, state: StashViewState = createStashViewState()): OperatorView {
	return new StashView(host, ops, state).browser;
}
