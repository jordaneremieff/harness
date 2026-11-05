/**
 * The read-only Pillars browser in the shared browsing frame. The inventory lists every
 * catalogued source with its quoted title, type and index statement; selecting a source reads
 * it page by page, and each continuation carries the exact resource and reference digest of the
 * first page. No judgment action or corpus change starts from here.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Action, Browser, type OperatorView, type ViewHost } from "../../operator-ui/index.ts";
import type { AccessError, AccessPage, AccessRequest } from "./access.ts";
import type { BrowserEntry } from "./inventory.ts";

export interface PillarsOperations {
	inventory(signal: AbortSignal): Promise<BrowserEntry[]>;
	read(request: AccessRequest, signal: AbortSignal): Promise<AccessPage | AccessError>;
}

/** Browsing position that survives leaving and reopening the view. */
export interface PillarsViewState {
	query: string;
	selected?: string;
}

export function createPillarsViewState(): PillarsViewState {
	return { query: "" };
}

/** One source as read so far: its pages in order, or the refusal that stopped the read. */
interface SourceRead {
	text: string;
	last?: AccessPage;
	pending: boolean;
	error?: string;
}

/** Control characters, bidi controls and lone surrogates become a visible placeholder. */
const safe = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|\p{Cs}/gu, "\ufffd");
const message = (error: unknown) => safe(error instanceof Error ? error.message : String(error));

/** Append one page, or record the refusal; a refused continuation never mixes source revisions. */
function receive(source: SourceRead, page: AccessPage | AccessError): void {
	if (page.schema === "pillars-source-error") {
		source.error = `${page.code}: ${safe(page.message ?? "Read again restarts from the first page.")}`;
		return;
	}
	source.text += page.text;
	source.last = page;
}

class PillarsView {
	readonly browser: Browser<BrowserEntry>;
	private readonly host: ViewHost;
	private readonly ops: PillarsOperations;
	private readonly state: PillarsViewState;
	private entries: BrowserEntry[] = [];
	private inventory: "pending" | "ready" | { error: string } = "pending";
	private readonly sources = new Map<string, SourceRead>();
	private reading?: AbortController;

	constructor(host: ViewHost, ops: PillarsOperations, state: PillarsViewState) {
		this.host = host;
		this.ops = ops;
		this.state = state;
		this.browser = new Browser<BrowserEntry>({
			title: "Pillars",
			host,
			key: (entry) => entry.resource,
			line: (entry, _width, theme) => this.line(entry, theme),
			detail: (entry) => this.detail(entry),
			detailKey: (entry) => entry.resource,
			actions: (entry) => this.actions(entry),
			search: { value: state.query, placeholder: "filter titles, types and statements", change: (query) => this.filter(query) },
			status: () => this.status(),
			empty: () => this.empty(),
			onSelect: (entry) => this.selected(entry),
		});
		host.signal.addEventListener("abort", () => this.reading?.abort());
		void this.load();
	}

	private line(entry: BrowserEntry, theme: Theme): string {
		return `${safe(entry.title)} ${theme.fg("dim", `· ${safe(entry.type)}`)}`;
	}

	private shown(): BrowserEntry[] {
		const terms = this.state.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
		if (!terms.length) return this.entries;
		return this.entries.filter((entry) => {
			const text = `${entry.resource} ${entry.title} ${entry.type} ${entry.index}`.toLocaleLowerCase();
			return terms.every((term) => text.includes(term));
		});
	}

	private async load(): Promise<void> {
		try {
			this.entries = await this.ops.inventory(this.host.signal);
			if (this.host.signal.aborted) return;
			this.inventory = "ready";
		} catch (error) {
			if (this.host.signal.aborted) return;
			this.inventory = { error: message(error) };
		}
		this.browser.setItems(this.shown(), this.state.selected);
		this.host.requestRender();
	}

	private filter(query: string): void {
		this.state.query = query;
		this.browser.setItems(this.shown(), this.state.selected);
		this.host.requestRender();
	}

	private selected(entry: BrowserEntry | undefined): void {
		this.state.selected = entry?.resource;
		if (entry && !this.sources.has(entry.resource)) void this.read(entry.resource, false);
	}

	/** Read the first page, or the next page with the digest of the pages already shown. */
	private async read(resource: string, continuation: boolean): Promise<void> {
		const known = this.sources.get(resource);
		const last = continuation ? known?.last : undefined;
		if (continuation && last?.nextOffset === undefined) return;
		this.reading?.abort();
		const controller = new AbortController();
		this.reading = controller;
		const signal = AbortSignal.any([controller.signal, this.host.signal]);
		const source: SourceRead = continuation && known ? { ...known, pending: true, error: undefined } : { text: "", pending: true };
		this.sources.set(resource, source);
		this.host.requestRender();
		const request: AccessRequest = last ? { resource, offset: last.nextOffset, referenceBodyDigest: last.referenceBodyDigest } : { resource };
		try {
			const page = await this.ops.read(request, signal);
			if (signal.aborted) return;
			receive(source, page);
		} catch (error) {
			if (signal.aborted) return this.withdrawn(resource, source, continuation);
			source.error = message(error);
		}
		source.pending = false;
		this.host.requestRender();
	}

	/** A withdrawn first read leaves nothing to keep; a withdrawn continuation keeps the pages read. */
	private withdrawn(resource: string, source: SourceRead, continuation: boolean): void {
		if (continuation) source.pending = false;
		else this.sources.delete(resource);
	}

	private detail(entry: BrowserEntry | undefined): string {
		if (!entry) return "Select a source to read it. Reading starts no agent turn.";
		const source = this.sources.get(entry.resource);
		const head = [`${safe(entry.title)} · ${safe(entry.type)}`, entry.index ? safe(entry.index) : ""].filter(Boolean);
		if (!source || (source.pending && !source.text)) return [...head, "", "Reading the source…"].join("\n");
		const digest = source.last ? `Source: ${safe(source.last.resource)} · SHA-256: ${source.last.referenceBodyDigest}` : "";
		const tail: string[] = [];
		if (source.pending) tail.push("Reading the next page…");
		else if (source.error) tail.push(`The read stopped: ${source.error}`);
		else if (source.last?.nextOffset !== undefined) tail.push(`[Read more continues at byte ${source.last.nextOffset} of ${source.last.bodyBytes}]`);
		return [...head, digest, "", safe(source.text), ...(tail.length ? ["", ...tail] : [])].join("\n");
	}

	private actions(entry: BrowserEntry | undefined): Action[] {
		if (!entry) return [];
		const source = this.sources.get(entry.resource);
		const more = source?.last?.nextOffset !== undefined && !source.error;
		return [
			{ id: "more", label: "Read more", key: "m", short: "read more", primary: true, disabled: source?.pending ? "A read is running" : more ? undefined : "The whole source is shown", description: "Read the next page of the same source revision", run: () => void this.read(entry.resource, true) },
			{ id: "again", label: "Read again", key: "r", short: "read again", primary: true, disabled: source?.pending ? "A read is running" : undefined, description: "Read the source from its first page", run: () => void this.read(entry.resource, false) },
		];
	}

	private status(): string {
		if (this.inventory === "pending") return "Reading the inventory…";
		if (typeof this.inventory === "object") return `The inventory could not be read: ${this.inventory.error}`;
		const shown = this.shown().length;
		return this.state.query.trim() ? `${shown} of ${this.entries.length} sources match · read-only` : `${this.entries.length} sources · read-only`;
	}

	private empty(): string {
		if (this.inventory === "pending") return "Reading…";
		if (typeof this.inventory === "object") return "Unavailable: the inventory could not be read.";
		return this.state.query.trim() ? "No source matches the filter." : "The corpus lists no sources.";
	}
}

/** Open the Pillars browser inside a frame. */
export function pillarsView(host: ViewHost, ops: PillarsOperations, state: PillarsViewState = createPillarsViewState()): OperatorView {
	return new PillarsView(host, ops, state).browser;
}
