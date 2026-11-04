/**
 * Read-only Pillars reader for the TUI browse route.
 *
 * The inventory lists every catalogued source with its canonical title, type,
 * and index statement, quoted from the inventory source rather than generated.
 * Opening a source reads it page by page through the access owner, keeping the
 * exact resource and reference digest with each continuation. No judgment
 * action or corpus mutation can start from here.
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { AccessError, AccessPage, AccessRequest } from "./access.ts";
import type { Catalog } from "./catalog.ts";

export type SourceReader = (request: AccessRequest, signal?: AbortSignal) => Promise<AccessPage | AccessError>;
export interface BrowserEntry {
	resource: string;
	title: string;
	type: string;
	index: string;
}

/** Inventory rows quote the source index statements rather than generate summaries. */
export async function browserEntries(catalog: Catalog, read: SourceReader, signal?: AbortSignal): Promise<BrowserEntry[]> {
	let page = await read({ resource: "inventory" }, signal);
	if (page.schema !== "pillars-source") throw new Error(page.code);
	let text = page.text;
	while (page.nextOffset !== undefined) {
		page = await read({ resource: "inventory", offset: page.nextOffset, referenceBodyDigest: page.referenceBodyDigest }, signal);
		if (page.schema !== "pillars-source") throw new Error(page.code);
		text += page.text;
	}
	const rows = new Map<string, { title: string; index: string }>();
	for (const match of text.matchAll(/^\|\s*\[([^\]]+)\]\(([a-z0-9-]+)\.md\)\s*\|\s*(.*?)\s*\|\s*$/gm)) {
		rows.set(match[2], { title: match[1], index: match[3] });
	}
	return catalog.resources.map(({ resourceId: resource, resourceClass }) => ({
		resource,
		title: rows.get(resource)?.title ?? defaultTitle(resource, resourceClass),
		type: resourceClass === "entry" ? resource.split("-")[0] : resourceClass,
		index: rows.get(resource)?.index ?? "",
	}));
}

function defaultTitle(resource: string, resourceClass: string): string {
	if (resourceClass === "inventory") return "Pillars";
	if (resourceClass === "governance") return "Pillars Governance";
	return resource;
}

interface BrowserOptions {
	entries: BrowserEntry[];
	read: SourceReader;
	size: () => { columns: number; rows: number };
	requestRender: () => void;
	close: () => void;
	signal?: AbortSignal;
}

type Action = "select" | "open" | "back" | "more" | "close";
interface Hit {
	x: number;
	y: number;
	width: number;
	action: Action;
	resource?: string;
}

const MIN_WIDTH = 24;
const MIN_HEIGHT = 8;
const STATEMENT_ROWS = 3;

/** Control characters, bidi controls, and lone surrogates become a visible placeholder. */
const safe = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|\p{Cs}/gu, "\ufffd");

/**
 * Two views, inventory and body, with pointer controls. Hit geometry and the
 * scroll region are rebuilt on every render and ignored for events whose
 * width or terminal height differs from the rendered ones.
 */
export class PillarsBrowser implements Component {
	private selected = 0;
	private listTop = 0;
	private bodyTop = 0;
	private view: "inventory" | "body" = "inventory";
	private page?: AccessPage;
	private body = "";
	private message = "";
	private loading = false;
	private generation = 0;
	private pending?: AbortController;
	private disposed = false;
	private hits: Hit[] = [];
	private geometry?: { width: number; height: number; top: number; bottom: number };
	private layout?: { width: number; body: string; lines: string[] };
	private readonly options: BrowserOptions;

	constructor(options: BrowserOptions) {
		this.options = options;
	}

	invalidate(): void {
		this.hits = [];
		this.geometry = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.generation++;
		this.pending?.abort();
		this.invalidate();
	}

	private changed(): void {
		this.invalidate();
		this.options.requestRender();
	}

	private back(): void {
		this.generation++;
		this.pending?.abort();
		this.loading = false;
		this.view = "inventory";
		this.message = "";
		this.changed();
	}

	private close(): void {
		this.dispose();
		this.options.close();
	}

	private pageHeight(): number {
		return Math.max(1, (this.geometry?.bottom ?? 10) - (this.geometry?.top ?? 1));
	}

	/** The request for the selected source, or its next page; undefined when nothing can be read. */
	private nextRequest(continuation: boolean): AccessRequest | undefined {
		const entry = this.options.entries[this.selected];
		if (this.disposed || this.loading || !entry) return undefined;
		if (!continuation) return { resource: entry.resource };
		const previous = this.page;
		if (!previous || previous.nextOffset === undefined) return undefined;
		return { resource: entry.resource, offset: previous.nextOffset, referenceBodyDigest: previous.referenceBodyDigest };
	}

	/** Read the selected source, or its next page when `continuation` is set and one exists. */
	async open(continuation = false): Promise<void> {
		const request = this.nextRequest(continuation);
		if (!request) return;
		const { signal, generation } = this.beginRead(continuation);
		try {
			const page = await this.options.read(request, signal);
			if (this.current(generation, signal)) this.receive(page);
		} catch (error) {
			if (this.current(generation, signal)) this.message = error instanceof Error ? error.message : "Source unavailable.";
		} finally {
			this.settle(generation);
		}
	}

	private settle(generation: number): void {
		if (this.disposed || generation !== this.generation) return;
		this.loading = false;
		this.changed();
	}

	/** Fence the read by generation and abort signal; a stale or aborted read changes nothing. */
	private current(generation: number, signal: AbortSignal): boolean {
		return !this.disposed && generation === this.generation && !signal.aborted;
	}

	private beginRead(continuation: boolean): { signal: AbortSignal; generation: number } {
		this.pending?.abort();
		this.pending = new AbortController();
		const signal = AbortSignal.any([this.pending.signal, ...(this.options.signal ? [this.options.signal] : [])]);
		const generation = ++this.generation;
		if (!continuation) {
			this.page = undefined;
			this.body = "";
			this.bodyTop = 0;
		}
		this.view = "body";
		this.loading = true;
		this.message = "";
		this.changed();
		return { signal, generation };
	}

	private receive(page: AccessPage | AccessError): void {
		if (page.schema === "pillars-source-error") {
			this.message = `${page.code}: ${page.message ?? "Return to the inventory and open the source again."}`;
			return;
		}
		this.page = page;
		this.body += page.text;
		this.layout = undefined;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, "escape")) {
			if (this.view === "body") this.back();
			else this.close();
			return;
		}
		if (data === "q") {
			this.close();
			return;
		}
		if (this.view === "inventory") this.handleInventoryInput(data);
		else this.handleBodyInput(data);
	}

	private handleInventoryInput(data: string): void {
		if (matchesKey(data, "enter")) {
			void this.open();
			return;
		}
		const step = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0;
		if (step === 0) return;
		this.selected = Math.max(0, Math.min(this.options.entries.length - 1, this.selected + step));
		const height = this.pageHeight();
		if (this.selected < this.listTop) this.listTop = this.selected;
		if (this.selected >= this.listTop + height) this.listTop = this.selected - height + 1;
		this.changed();
	}

	private handleBodyInput(data: string): void {
		if (data === "m") {
			void this.open(true);
			return;
		}
		if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.pageHeight());
		else if (matchesKey(data, "pageDown")) this.scroll(this.pageHeight());
	}

	private scroll(delta: number): void {
		if (this.view === "inventory") {
			this.listTop = Math.max(0, Math.min(Math.max(0, this.options.entries.length - 1), this.listTop + delta));
		} else {
			this.bodyTop = Math.max(0, Math.min(Math.max(0, (this.layout?.lines.length ?? 1) - 1), this.bodyTop + delta));
		}
		this.changed();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const geometry = this.geometry;
		if (this.disposed || !geometry || event.width !== geometry.width || this.options.size().rows !== geometry.height) {
			this.invalidate();
			return undefined;
		}
		if (event.type === "wheel" && event.y >= geometry.top && event.y < geometry.bottom) {
			this.scroll(event.wheelDelta ?? 0);
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const hit = this.hits.find((candidate) => candidate.y === event.y && event.x >= candidate.x && event.x < candidate.x + candidate.width);
		if (!hit) return undefined;
		this.act(hit);
		return { handled: true };
	}

	private act(hit: Hit): void {
		switch (hit.action) {
			case "select": {
				const index = this.options.entries.findIndex((entry) => entry.resource === hit.resource);
				if (index >= 0) this.selected = index;
				this.changed();
				return;
			}
			case "open":
				void this.open();
				return;
			case "more":
				void this.open(true);
				return;
			case "back":
				this.back();
				return;
			default:
				this.close();
		}
	}

	render(width: number): string[] {
		this.invalidate();
		if (this.disposed) return [];
		const height = Math.max(3, this.options.size().rows - 2);
		const entry = this.options.entries[this.selected];
		const rows: string[] = [];
		const title = this.view === "inventory" ? "Pillars · read-only inventory" : `${entry?.title ?? "Pillars"} · ${entry?.type ?? "source"}`;
		rows.push(truncateToWidth(title, width));
		if (width < MIN_WIDTH || height < MIN_HEIGHT) rows.push(truncateToWidth("Resize to read the corpus.", width));
		else if (this.view === "inventory") this.renderInventory(rows, width, height, entry);
		else this.renderBody(rows, width, height);
		this.renderControls(rows, width);
		return rows;
	}

	private renderInventory(rows: string[], width: number, height: number, entry: BrowserEntry | undefined): void {
		const wrap = (text: string) => wrapTextWithAnsi(safe(text), Math.max(1, width));
		const statement = wrap(entry?.index || "Select a source. Open reads it without an agent turn.");
		const slots = Math.max(1, height - Math.min(statement.length, STATEMENT_ROWS) - 3);
		for (let index = this.listTop; index < Math.min(this.options.entries.length, this.listTop + slots); index++) {
			const item = this.options.entries[index];
			this.hits.push({ x: 0, y: rows.length, width, action: "select", resource: item.resource });
			rows.push(truncateToWidth(`${index === this.selected ? "\u203a" : " "} ${item.title} · ${item.type}`, width));
		}
		const bottom = rows.length;
		rows.push("", ...statement.slice(0, STATEMENT_ROWS));
		this.geometry = { width, height: this.options.size().rows, top: 1, bottom };
	}

	private renderBody(rows: string[], width: number, height: number): void {
		const wrap = (text: string) => wrapTextWithAnsi(safe(text), Math.max(1, width));
		const source = this.page;
		if (source) rows.push(...wrap(`Source: ${source.resource} · SHA-256: ${source.referenceBodyDigest}`));
		const top = rows.length;
		if (!this.layout || this.layout.width !== width || this.layout.body !== this.body) {
			this.layout = { width, body: this.body, lines: this.body.split("\n").flatMap(wrap) };
		}
		const slots = Math.max(1, height - rows.length - 2);
		rows.push(...this.layout.lines.slice(this.bodyTop, this.bodyTop + slots));
		this.geometry = { width, height: this.options.size().rows, top, bottom: rows.length };
		if (this.loading || this.message) rows.push(truncateToWidth(safe(this.loading ? "Read in progress\u2026" : this.message), width));
	}

	private controls(): Array<[string, Action]> {
		if (this.view === "inventory") return [["Open", "open"], ["Close", "close"]];
		const more: Array<[string, Action]> = !this.loading && this.page?.nextOffset !== undefined && !this.message ? [["More", "more"]] : [];
		return [["Back", "back"], ...more, ["Close", "close"]];
	}

	private renderControls(rows: string[], width: number): void {
		let footer = "";
		for (const [label, action] of this.controls()) {
			const text = `[${label}]`;
			if (visibleWidth(footer + text) > width && footer) {
				rows.push(footer);
				footer = "";
			}
			this.hits.push({ x: visibleWidth(footer), y: rows.length, width: text.length, action });
			footer += `${text} `;
		}
		rows.push(truncateToWidth(footer, width));
	}
}
