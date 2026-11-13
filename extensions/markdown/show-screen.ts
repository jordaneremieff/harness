import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getMarkdownTheme, initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, decodeKittyPrintable, isKeyRelease, Markdown, matchesKey, ProcessTerminal, ScrollView, truncateToWidth, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { openStored } from "./reveal.ts";
import { frameAppStatus } from "./frame-client.ts";
import { readSettings } from "./settings.ts";
import { MarkdownStore, type StoredDocument } from "./store.ts";

/** Lines wider than this make prose hard to follow; wider terminals centre the column. */
export const READING_COLUMNS = 100;
export const SHOW_KEYS = "↑↓ j k scroll · space b page · g G start, end · o Markdown Reader · r reload · q close";
const dim = (text: string) => `\u001b[2m${text}\u001b[22m`;
const bold = (text: string) => `\u001b[1m${text}\u001b[22m`;

/**
 * Control characters in a document never reach the terminal as controls: a document cannot change the
 * title, clipboard, links or program status of the terminal that shows it. C0 controls other than tab
 * and line feed become their visible Control Pictures; DEL and C1 controls become U+FFFD. A CRLF line
 * ending is one line ending.
 */
export function displaySource(source: string): string {
	return source.replace(/\r\n/gu, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, (character) => {
		const code = character.charCodeAt(0);
		return code < 0x20 ? String.fromCharCode(0x2400 + code) : "\ufffd";
	});
}
function plain(text: string): string {
	return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
}
export function documentHeading(stored: StoredDocument): { title: string; detail: string } {
	const { document, revision } = stored;
	const size = revision.bytes < 1024 ? `${revision.bytes} bytes` : `${(revision.bytes / 1024).toFixed(1)} KB`;
	const partial = revision.completeness.state === "partial" ? ` · partial${revision.completeness.reason ? ` (${revision.completeness.reason})` : ""}` : "";
	const kind = document.kind === "published" ? "published" : document.kind === "response" ? "response snapshot" : "file snapshot";
	return { title: plain(revision.title), detail: `${document.id.slice(0, 11)} · revision ${revision.revision} · ${kind} · ${size}${partial}` };
}

/** Renders its child at most `columns` wide and centres it in a wider terminal. */
export class ReadingColumn implements Component {
	private readonly child: Component;
	private readonly columns: number;
	constructor(child: Component, columns = READING_COLUMNS) {
		this.child = child;
		this.columns = columns;
	}
	render(width: number): string[] {
		const inner = Math.max(1, Math.min(width, this.columns));
		const margin = " ".repeat(Math.floor((width - inner) / 2));
		return this.child.render(inner).map((line) => margin + line);
	}
	invalidate(): void {
		this.child.invalidate?.();
	}
}

class Lines implements Component {
	lines: string[] = [];
	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, width));
	}
	invalidate(): void {}
}

type KeyAction = "down" | "up" | "page-down" | "page-up" | "start" | "end" | "open" | "reload" | "close";
/** Maps one key press to a view action. */
export function keyAction(data: string): KeyAction | undefined {
	if (isKeyRelease(data)) return undefined;
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return "close";
	if (matchesKey(data, "down")) return "down";
	if (matchesKey(data, "up")) return "up";
	if (matchesKey(data, "space") || matchesKey(data, "pageDown")) return "page-down";
	if (matchesKey(data, "pageUp")) return "page-up";
	if (matchesKey(data, "home")) return "start";
	if (matchesKey(data, "end")) return "end";
	const character = decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined);
	return character === undefined ? undefined : ({ j: "down", k: "up", f: "page-down", b: "page-up", g: "start", G: "end", o: "open", r: "reload", q: "close" } as const)[character];
}

function storeRoot(store: string | undefined): string {
	return store ?? readSettings({ agentDir: getAgentDir() }).values.dir;
}
function piTheme(): string | undefined {
	try {
		return SettingsManager.create(process.cwd(), getAgentDir()).getTheme();
	} catch {
		return undefined;
	}
}
function errorText(error: unknown): string {
	return plain(error instanceof Error ? error.message : String(error)).slice(0, 300);
}
/**
 * Calls `changed` when the document pointer may have moved. A published document lives in `documents/`;
 * response and file snapshots live in `snapshots/`. Returns no watcher when the platform cannot watch.
 */
export function watchDocument(root: string, stored: StoredDocument, changed: () => void): FSWatcher | undefined {
	const directory = join(root, stored.document.kind === "published" ? "documents" : "snapshots", stored.document.id);
	try {
		const watcher = watch(directory, (_event, name) => {
			if (name === null || name === "document.json") changed();
		});
		watcher.on("error", () => watcher.close());
		return watcher;
	} catch {
		return undefined;
	}
}

/** One terminal screen for one document: heading, scrolling body and key line. */
class DocumentScreen {
	readonly header = new Lines();
	readonly footer = new Lines();
	readonly closing = new AbortController();
	private readonly root: string;
	private readonly store: MarkdownStore;
	private readonly markdown: Markdown;
	readonly scroll: ScrollView;
	private stored: StoredDocument;
	private status = "";
	private readonly fallback: string;
	private reloading = false;
	private pending = false;
	private render: () => void = () => {};
	private readonly actions: Partial<Record<KeyAction, () => void>>;
	constructor(root: string, store: MarkdownStore, stored: StoredDocument, fallback: string) {
		this.fallback = fallback;
		this.root = root;
		this.store = store;
		this.stored = stored;
		this.markdown = new Markdown(displaySource(stored.source), 1, 1, getMarkdownTheme());
		this.scroll = new ScrollView(new ReadingColumn(this.markdown), { primary: true, follow: "none", scrollbar: "auto", overscroll: "contain" });
		const page = () => Math.max(1, this.scroll.viewportHeight - 2);
		this.actions = {
			down: () => this.scroll.scrollBy(1),
			up: () => this.scroll.scrollBy(-1),
			"page-down": () => this.scroll.scrollBy(page()),
			"page-up": () => this.scroll.scrollBy(-page()),
			start: () => this.scroll.scrollToStart(),
			end: () => this.scroll.scrollToEnd(),
			reload: () => void this.reload(true),
			open: () => void this.openReader(),
			close: () => this.closing.abort(),
		};
		this.paint();
	}
	get title(): string {
		return documentHeading(this.stored).title;
	}
	attach(render: () => void): void {
		this.render = render;
	}
	notify(status: string): void {
		this.status = status;
		this.paint();
	}
	readonly keys: Component = {
		render: (width) => this.footer.render(width),
		invalidate: () => {},
		handleInput: (data) => {
			const action = keyAction(data);
			if (!action) return;
			this.status = "";
			this.actions[action]?.();
			this.paint();
		},
	};
	private paint(): void {
		if (this.closing.signal.aborted) return;
		const heading = documentHeading(this.stored);
		this.header.lines = [bold(heading.title), dim(heading.detail)];
		this.footer.lines = [dim(this.status || `${this.fallback} ${SHOW_KEYS}`)];
		this.render();
	}
	/** Loads the current revision; changes that arrive during a load run one more load. */
	async reload(announce: boolean): Promise<void> {
		if (this.reloading) {
			this.pending = true;
			return;
		}
		this.reloading = true;
		try {
			do {
				this.pending = false;
				this.status = await this.loadCurrent(announce);
				this.paint();
			} while (this.pending);
		} finally {
			this.reloading = false;
		}
	}
	private async loadCurrent(announce: boolean): Promise<string> {
		try {
			const next = await this.store.get(this.stored.document.id);
			if (next.revision.revision === this.stored.revision.revision && next.revision.digest === this.stored.revision.digest)
				return announce ? `Revision ${next.revision.revision} is the current revision.` : this.status;
			this.stored = next;
			this.markdown.setText(displaySource(next.source));
			return `Showing revision ${next.revision.revision}.`;
		} catch (error) {
			return `Reload failed: ${errorText(error)}`;
		}
	}
	private async openReader(): Promise<void> {
		const shown = this.stored;
		this.notify("Opening in Markdown Reader…");
		try {
			this.notify(await openStored(this.root, shown.document.id, this.closing.signal, { gui: true, pin: { revision: shown.revision.revision, digest: shown.revision.digest } }));
		} catch (error) {
			this.notify(`Markdown Reader did not open: ${errorText(error)}`);
		}
	}
}

export async function runShow(options: { store?: string; document: string }): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The document view requires an interactive terminal.");
	const root = storeRoot(options.store);
	const store = new MarkdownStore(root);
	let stored = await store.get(await store.resolve(options.document));
	initTheme(piTheme());
	const app = readSettings({ agentDir: getAgentDir() }).values.app;
	let fallback = await frameAppStatus(app);
	if (!fallback) {
		const { probeGraphics, runGraphics } = await import("./show-graphics.ts");
		const probe = await probeGraphics();
		if (probe.closed) return;
		fallback = probe.reason;
		if (!fallback && probe.cell) {
			fallback = await runGraphics(root, store, stored, app, probe.cell, probe.colors);
			if (!fallback) return;
			stored = await store.get(stored.document.id);
		}
	}
	const screen = new DocumentScreen(root, store, stored, fallback ?? "Text view: terminal graphics are unavailable.");
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	screen.attach(() => tui.requestRender());
	const closed = new Promise<void>((done) => screen.closing.signal.addEventListener("abort", () => done(), { once: true }));
	const close = () => screen.closing.abort();
	const watcher = watchDocument(root, stored, () => void screen.reload(false));
	if (!watcher) screen.notify("New revisions do not load automatically here; press r to reload.");
	tui.setLayoutRoot(new VStack([{ component: screen.header }, { component: screen.scroll, grow: 1, shrink: 1, basis: 0 }, { component: screen.keys }]));
	tui.setFocus(screen.keys);
	process.once("SIGTERM", close);
	process.once("SIGHUP", close);
	try {
		terminal.setTitle(`${screen.title} · Markdown`);
		tui.start();
		await closed;
	} finally {
		process.off("SIGTERM", close);
		process.off("SIGHUP", close);
		watcher?.close();
		tui.stop();
	}
}
