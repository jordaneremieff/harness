/**
 * The clipboard history view in the shared browsing frame. Ordinary Pi binds its operations to
 * the archive directly; the attached terminal binds them to the `clipboard` command route. The
 * view owns no store: it reads through the operations it is given and never writes except through
 * the labelled Restore action.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Action, age, Browser, type OperatorView, plainLine, type ViewHost } from "../../operator-ui/index.ts";
import { restoredNotice, type RestoreOutcome } from "./browser-operations.ts";
import type { SearchPage } from "./search.ts";
import type { ClipboardEntry } from "./store.ts";
import { safeLine, sanitizeTerminalText } from "./text.ts";

export interface ClipboardOperations {
	recent(signal: AbortSignal): Promise<{ entries: ClipboardEntry[]; hasMore: boolean }>;
	search(query: string, cursor: string | undefined, signal: AbortSignal): Promise<SearchPage>;
	/** The exact record with a bounded content prefix. */
	preview(entry: Pick<ClipboardEntry, "id" | "archiveDate">, signal: AbortSignal): Promise<ClipboardEntry>;
	/** Rereads the exact record in full, writes the clipboard, then appends the archive record. */
	restore(entry: Pick<ClipboardEntry, "id" | "archiveDate">, signal: AbortSignal): Promise<RestoreOutcome>;
}

/** Browsing position that survives leaving and reopening the view in one session. */
export interface ClipboardViewState {
	scope: "recent" | "archive";
	query: string;
	selected?: string;
}

export function createClipboardViewState(): ClipboardViewState {
	return { scope: "recent", query: "" };
}

type Read<T> = { state: "idle" } | { state: "pending" } | { state: "ready"; value: T } | { state: "failed"; error: string };

const identity = (entry: Pick<ClipboardEntry, "id" | "archiveDate">) => `${entry.archiveDate ?? ""}\u0000${entry.id}`;
const message = (error: unknown) => safeLine(error instanceof Error ? error.message : String(error));

function matchEntry(match: SearchPage["matches"][number]): ClipboardEntry {
	return {
		id: match.id,
		archiveDate: match.date,
		timestamp: match.timestamp,
		label: match.label,
		lines: match.lines,
		chars: match.chars,
		preview: match.match.excerpt,
		content: "",
		contentTruncated: true,
	};
}

function coverageText(page: SearchPage): string {
	const detail = `${page.scan.records} records scanned; ${page.scan.malformed} malformed and ${page.scan.oversized} oversized skipped`;
	return page.hasMore ? `Partial scan (${page.stop}) · Continue reads more · ${detail}` : `End of the archive scan · ${detail}`;
}

function localTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "unknown date" : date.toLocaleString();
}

class ClipboardView {
	readonly browser: Browser<ClipboardEntry>;
	private readonly host: ViewHost;
	private readonly ops: ClipboardOperations;
	private readonly state: ClipboardViewState;
	private recent: Read<{ entries: ClipboardEntry[]; hasMore: boolean }> = { state: "idle" };
	private archive: ClipboardEntry[] = [];
	private archiveStatus = "Type text, then press Enter or choose Search archive.";
	private searched = "";
	private cursor?: string;
	private stale = false;
	private searching?: AbortController;
	private previews = new Map<string, Read<ClipboardEntry>>();
	private previewing?: AbortController;
	private restoring = false;

	constructor(host: ViewHost, ops: ClipboardOperations, state: ClipboardViewState) {
		this.host = host;
		this.ops = ops;
		this.state = state;
		this.browser = new Browser<ClipboardEntry>({
			title: "Clipboard",
			host,
			key: identity,
			line: (entry, width, theme) => this.line(entry, width, theme),
			detail: (entry) => this.detail(entry),
			detailKey: (entry) => `${identity(entry)}:${this.previews.get(identity(entry))?.state ?? "idle"}`,
			actions: (entry) => this.actions(entry),
			scopes: [
				{ id: "recent", label: "Recent" },
				{ id: "archive", label: "Archive" },
			],
			scope: () => this.state.scope,
			onScope: (scope) => this.switchScope(scope === "archive" ? "archive" : "recent"),
			search: {
				value: state.query,
				placeholder: () => (this.state.scope === "archive" ? "text to find in the archive" : "filter recent entries"),
				submitLabel: () => (this.state.scope === "archive" ? "search" : undefined),
				change: (query) => this.queryChanged(query),
				submit: (query) => {
					if (this.state.scope === "archive" && query.trim()) void this.search(false);
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
	}

	private line(entry: ClipboardEntry, _width: number, theme: Theme): string {
		const when = theme.fg("dim", age(Date.parse(entry.timestamp)).padStart(4));
		const size = theme.fg("dim", `${entry.lines}L`.padStart(5));
		const label = entry.label ? theme.fg("accent", `${safeLine(entry.label).slice(0, 40)} `) : "";
		return `${when} ${size}  ${label}${safeLine(entry.preview)}`;
	}

	private items(): ClipboardEntry[] {
		if (this.state.scope === "archive") return this.archive;
		const loaded = this.recent.state === "ready" ? this.recent.value.entries : [];
		const query = this.state.query.toLocaleLowerCase();
		return query ? loaded.filter((entry) => `${entry.id}\n${entry.label ?? ""}\n${entry.preview}`.toLocaleLowerCase().includes(query)) : loaded;
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

	private async search(continuation: boolean): Promise<void> {
		const query = this.state.query;
		if (!query.trim() || (continuation && (!this.cursor || this.stale || query !== this.searched))) return;
		this.searching?.abort();
		const controller = new AbortController();
		this.searching = controller;
		const signal = AbortSignal.any([controller.signal, this.host.signal]);
		this.archiveStatus = "Searching the archive…";
		this.host.requestRender();
		try {
			const page = await this.ops.search(query, continuation ? this.cursor : undefined, signal);
			if (signal.aborted) return;
			const existing = continuation ? this.archive : [];
			const seen = new Set(existing.map(identity));
			this.archive = [...existing, ...page.matches.map(matchEntry).filter((entry) => !seen.has(identity(entry)))];
			this.cursor = page.nextCursor ?? undefined;
			this.searched = query;
			this.stale = false;
			this.archiveStatus = coverageText(page);
		} catch (error) {
			if (signal.aborted) return;
			this.stale = true;
			this.archiveStatus = `Archive read failed; Refresh retries: ${message(error)}`;
		}
		this.refreshItems();
	}

	private queryChanged(query: string): void {
		this.state.query = query;
		if (this.state.scope === "archive") {
			this.searching?.abort();
			if (query !== this.searched) {
				this.stale = this.archive.length > 0;
				this.cursor = undefined;
				this.archiveStatus = query.trim() ? "Query changed · press Enter or choose Search archive" : "Type text, then press Enter or choose Search archive.";
			}
		}
		this.refreshItems();
	}

	private switchScope(scope: ClipboardViewState["scope"]): void {
		if (scope === this.state.scope) return;
		this.state.scope = scope;
		this.browser.setItems([]);
		this.refreshItems();
	}

	private selected(entry: ClipboardEntry | undefined): void {
		this.state.selected = entry ? identity(entry) : undefined;
		this.previewing?.abort();
		if (!entry) return;
		const key = identity(entry);
		const known = this.previews.get(key);
		if (known?.state === "ready" || known?.state === "pending") return;
		const controller = new AbortController();
		this.previewing = controller;
		const signal = AbortSignal.any([controller.signal, this.host.signal]);
		this.previews.set(key, { state: "pending" });
		this.ops.preview(entry, signal).then(
			(value) => {
				if (signal.aborted) return;
				this.previews.set(key, { state: "ready", value });
				this.host.requestRender();
			},
			(error: unknown) => {
				if (signal.aborted) {
					this.previews.delete(key);
					return;
				}
				this.previews.set(key, { state: "failed", error: message(error) });
				this.host.requestRender();
			},
		);
	}

	private detail(entry: ClipboardEntry | undefined): string {
		if (!entry) return this.state.scope === "archive" ? "Search results appear here." : "Select an entry to read it.";
		const head = [
			`${localTime(entry.timestamp)} · ${entry.lines} lines · ${entry.chars} characters`,
			entry.label ? `Label: ${safeLine(entry.label)}` : "",
			`Entry ${plainLine(entry.id)}${entry.archiveDate ? ` · archive ${entry.archiveDate}` : ""}`,
			"",
		].filter((line, index) => line || index === 3);
		const preview = this.previews.get(identity(entry));
		if (!preview || preview.state === "pending" || preview.state === "idle") return [...head, "Reading the exact record…"].join("\n");
		if (preview.state === "failed") return [...head, `The record could not be read: ${preview.error}`, "Restore stays unavailable until it reads."].join("\n");
		const body = sanitizeTerminalText(preview.value.content).text;
		const more = preview.value.contentTruncated ? `\n\n… preview shows the first part; Restore writes the complete record.` : "";
		return `${head.join("\n")}${body}${more}`;
	}

	private restoreBlocker(entry: ClipboardEntry | undefined): string | undefined {
		if (!entry) return "Select an entry first";
		if (this.restoring) return "A restore is running";
		if (this.state.scope === "archive" && this.stale) return "The archive results are stale; search again first";
		const preview = this.previews.get(identity(entry));
		if (preview?.state !== "ready") return "The exact record has not been read yet";
		return undefined;
	}

	private actions(entry: ClipboardEntry | undefined): Action[] {
		const actions: Action[] = [
			{
				id: "restore",
				label: this.restoring ? "Restoring…" : "Restore",
				key: "enter",
				short: "restore",
				primary: true,
				disabled: this.restoreBlocker(entry),
				description: "Write the complete record to the clipboard",
				run: () => {
					if (entry) void this.restore(entry);
				},
			},
		];
		if (this.state.scope === "archive") {
			actions.push({ id: "search", label: "Search archive", disabled: this.state.query.trim() ? undefined : "Type text to search for", run: () => void this.search(false) });
			actions.push({ id: "continue", label: "Continue", disabled: this.cursor && !this.stale ? undefined : "The scan has no further page", run: () => void this.search(true) });
		}
		actions.push({ id: "refresh", label: "Refresh", key: "r", short: "refresh", primary: true, description: this.state.scope === "archive" ? "Run the search again" : "Read recent entries again", run: () => void (this.state.scope === "archive" ? this.search(false) : this.loadRecent()) });
		return actions;
	}

	private async restore(entry: ClipboardEntry): Promise<void> {
		this.restoring = true;
		this.host.notify(`Restoring ${entry.lines}L/${entry.chars}c…`, "pending");
		let outcome: RestoreOutcome;
		try {
			outcome = await this.ops.restore(entry, this.host.signal);
		} catch (error) {
			outcome = { ok: false, error: message(error) };
		}
		this.restoring = false;
		if (this.host.signal.aborted) return;
		if (!outcome.ok) {
			this.host.notify(`Restore failed: ${safeLine(outcome.error)}`, "error");
			return;
		}
		const notice = restoredNotice(entry, outcome.warning);
		this.host.notify(notice.text, notice.type === "warning" ? "warning" : "success");
		if (this.state.scope === "recent") void this.loadRecent();
	}

	private status(): string {
		if (this.state.scope === "archive") return this.archiveStatus;
		if (this.recent.state === "pending" || this.recent.state === "idle") return "Reading recent entries…";
		if (this.recent.state === "failed") return `Recent entries could not be read; Refresh retries: ${this.recent.error}`;
		const shown = this.items().length;
		const total = this.recent.value.entries.length;
		const more = this.recent.value.hasMore ? "+" : "";
		return this.state.query ? `${shown} of ${total}${more} recent entries match` : `${total}${more} recent entries · newest first`;
	}

	private empty(): string {
		if (this.state.scope === "archive") return this.searched ? "No archive record matches." : "Search the archive for text you copied earlier.";
		if (this.recent.state !== "ready") return this.recent.state === "failed" ? "Unavailable: the history could not be read." : "Reading…";
		return this.state.query ? "No recent entry matches the filter." : "Clipboard history is empty.";
	}
}

/** Open the clipboard view inside a frame. */
export function clipboardView(host: ViewHost, ops: ClipboardOperations, state: ClipboardViewState = createClipboardViewState()): OperatorView {
	return new ClipboardView(host, ops, state).browser;
}
