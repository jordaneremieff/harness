import { homedir } from "node:os";
import { join } from "node:path";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { bundledPlaybooks, type Playbook, type PlaybookCatalog } from "./playbook-catalog.ts";
import { ListBrowser } from "./view-list.ts";
import type { Action, KeyHint, View, ViewHost } from "./view-model.ts";
import type { ReaderContent } from "./view-reader.ts";
import { plainLine } from "./view-text.ts";

/** What the bound target uses, as its owner reports it. */
export interface PlaybookTargetState {
	/** The saved choice: a name, null for off, undefined when it cannot be read. */
	readonly saved: string | null | undefined;
	/** Who made the saved choice, in words. */
	readonly origin?: string;
	/** The choice of the run in progress, when it differs from the saved one. */
	readonly running?: string | null;
	/** Why the state is unknown or incomplete. */
	readonly note?: string;
}

/** The owner routes of one bound target: this session or one agent. */
export interface PlaybookBrowserSource {
	/** The target in running text, for example "This session" or "@editor". */
	readonly subject: string;
	/** Reads the catalog when the view opens and when it reloads, never while it draws. */
	catalog(): PlaybookCatalog | undefined;
	read(signal: AbortSignal): PlaybookTargetState | Promise<PlaybookTargetState>;
	/** Saves a name, or "off", for the target and answers with a receipt. */
	apply(name: string, signal: AbortSignal): string | Promise<string>;
	/** Runs with the receipt after the view has closed. */
	applied?(receipt: string): void;
	/** Opens the review of a bundled starter against the installed file, when the catalog is local. */
	compare?(name: string): (host: ViewHost) => View;
}

type Row =
	| { readonly kind: "off"; readonly key: string }
	| { readonly kind: "playbook"; readonly key: string; readonly name: string; readonly entry?: Playbook; readonly starter?: Playbook; readonly installed: boolean }
	| { readonly kind: "problems"; readonly key: string; readonly diagnostics: readonly string[] };

const OFF_SUMMARY = "No playbook. Each task decides how to divide the work.";
const NAME_COLUMN = 14;

/**
 * Joins the hard-wrapped lines of each plain paragraph so the text flows at any width. Blocks
 * with Markdown structure (lists, headings, quotes, tables, code) keep their lines.
 */
export function reflowParagraphs(text: string): string {
	const blocks = text.replace(/\r\n/gu, "\n").split(/\n[ \t]*\n/u);
	if (/^\s*(```|~~~)/mu.test(text)) return text;
	return blocks
		.map((block) => (/^\s*([-*+>#|]|\d+[.)]\s)/mu.test(block) ? block : block.split("\n").map((line) => line.trim()).join(" ")))
		.join("\n\n");
}

function sameText(a: Playbook, b: Playbook): boolean {
	return a.summary === b.summary && a.body.trim() === b.body.trim();
}

function homeRelative(path: string): string {
	const home = homedir();
	return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

function errorText(error: unknown): string {
	return plainLine(error instanceof Error ? error.message : String(error)).slice(0, 240);
}

/**
 * The playbooks of one target as a list with the selected playbook's full text beside it.
 * Enter saves the selected row for the target; selection alone changes nothing.
 */
export class PlaybookBrowser implements View {
	readonly title = "Playbooks";
	private readonly host: ViewHost;
	private readonly source: PlaybookBrowserSource;
	private readonly browser: ListBrowser<Row>;
	private catalog?: PlaybookCatalog;
	private starters: readonly Playbook[] = [];
	private state?: PlaybookTargetState;
	private reading?: AbortController;
	private readError?: string;
	private saving = false;
	private placed = false;
	private layout?: { key: string; width: number; lines: readonly string[] };

	constructor(host: ViewHost, source: PlaybookBrowserSource) {
		this.host = host;
		this.source = source;
		this.browser = new ListBrowser<Row>({
			title: "Playbooks",
			heading: () => this.heading(),
			host,
			key: (row) => row.key,
			line: (row, _width, theme) => this.line(row, theme),
			detail: (row) => (row === undefined ? "" : this.detail(row)),
			actions: (row) => this.rowActions(row),
			status: () => this.statusText(),
			empty: () => "No playbooks are listed.",
		});
		this.reload();
	}

	get focused(): boolean {
		return this.browser.focused;
	}

	set focused(value: boolean) {
		this.browser.focused = value;
	}

	/** Reads the catalog and the target's choice again. */
	private reload(): void {
		try {
			this.catalog = this.source.catalog();
			this.starters = bundledPlaybooks();
		} catch (error) {
			this.catalog = undefined;
			this.readError = `The catalog could not be read: ${errorText(error)}`;
		}
		this.setRows();
		void this.readState();
	}

	private async readState(): Promise<void> {
		this.reading?.abort();
		const controller = new AbortController();
		this.reading = controller;
		const signal = AbortSignal.any([this.host.signal, controller.signal]);
		try {
			const state = await this.source.read(signal);
			if (signal.aborted) return;
			this.state = state;
		} catch (error) {
			if (signal.aborted) return;
			this.state = { saved: undefined, note: `The choice could not be read: ${errorText(error)}` };
		} finally {
			if (this.reading === controller) this.reading = undefined;
		}
		this.setRows();
		this.host.requestRender();
	}

	private setRows(): void {
		const catalog = this.catalog;
		const installed = catalog?.state === "missing" ? [] : (catalog?.entries ?? []);
		const listed: Playbook[] = catalog?.state === "missing" ? [...this.starters] : [...installed];
		const rows: Row[] = [{ kind: "off", key: "off" }];
		for (const entry of listed) {
			const starter = this.starters.find((item) => item.name === entry.name);
			rows.push({ kind: "playbook", key: `playbook:${entry.name}`, name: entry.name, entry, starter, installed: catalog?.state !== "missing" });
		}
		const saved = this.state?.saved;
		for (const name of [saved, this.state?.running]) {
			if (typeof name === "string" && !rows.some((row) => row.kind === "playbook" && row.name === name)) {
				rows.push({ kind: "playbook", key: `playbook:${name}`, name, installed: false, starter: this.starters.find((item) => item.name === name) });
			}
		}
		const diagnostics = [...(this.readError ? [this.readError] : []), ...(catalog?.diagnostics ?? [])];
		if (diagnostics.length) rows.push({ kind: "problems", key: "problems", diagnostics });
		this.browser.setItems(rows);
		// The list opens on the saved choice once it is known.
		if (!this.placed && this.state !== undefined) {
			this.placed = true;
			const current = rows.find((row) => this.isSaved(row));
			if (current) this.browser.selectKey(current.key);
		}
	}

	private isSaved(row: Row): boolean {
		const saved = this.state?.saved;
		if (saved === undefined) return false;
		return row.kind === "off" ? saved === null : row.kind === "playbook" && row.name === saved;
	}

	private isRunning(row: Row): boolean {
		const running = this.state?.running;
		if (running === undefined) return false;
		return row.kind === "off" ? running === null : row.kind === "playbook" && row.name === running;
	}

	private applies(name: string): boolean {
		return this.catalog?.state === "ready" && this.catalog.entries.some((entry) => entry.name === name);
	}

	private heading(): string {
		const subject = this.source.subject;
		if (this.state === undefined) return `${subject}: reading the current choice…`;
		const { saved, origin } = this.state;
		if (saved === undefined) return `${subject}: choice unknown`;
		return `${subject} uses ${saved === null ? "no playbook" : saved}${saved !== null && origin ? ` (${origin})` : ""}`;
	}

	/** Changes waiting for the next run, problems, or what a playbook is. */
	private statusText(): string {
		const parts: string[] = [];
		const state = this.state;
		if (state?.running !== undefined && state.saved !== undefined) parts.push(`From the next run; the run in progress keeps ${state.running ?? "no playbook"}`);
		if (typeof state?.saved === "string" && this.catalog && !this.applies(state.saved)) parts.push("Its file supplies no instructions now");
		if (state?.note) parts.push(state.note);
		if (this.catalog?.state === "missing") parts.push("The catalog is not installed yet; these are the bundled starters");
		else if (this.catalog && this.catalog.state !== "ready") parts.push(`The catalog is ${this.catalog.state}; no playbook applies until it is repaired`);
		return parts.length ? parts.join(" · ") : "Sets how work is divided with agents. A task's own instructions come first.";
	}

	private line(row: Row, theme: Theme): string {
		const mark = this.isSaved(row) ? theme.fg("accent", "●") : this.isRunning(row) ? theme.fg("muted", "○") : " ";
		if (row.kind === "problems") return `${mark} ${theme.fg("warning", `${row.diagnostics.length} catalog ${row.diagnostics.length === 1 ? "problem" : "problems"}`)}`;
		const name = row.kind === "off" ? "off" : row.name;
		const summary = row.kind === "off" ? OFF_SUMMARY : (row.entry?.summary ?? "No readable file");
		const tone = row.kind === "playbook" && !row.entry ? "warning" : "muted";
		const label = this.isSaved(row) ? theme.bold(name) : name;
		return `${mark} ${label}${" ".repeat(Math.max(1, NAME_COLUMN - name.length))}${theme.fg(tone, summary)}`;
	}

	/** Where the row stands for the target, in words. */
	private standing(row: Row): { text: string; tone: "success" | "muted" | "warning" } | undefined {
		const saved = this.isSaved(row);
		const running = this.isRunning(row);
		if (saved && this.state?.running !== undefined) return { text: "Chosen · applies from the next run", tone: "success" };
		if (saved) return { text: `In use${this.state?.origin ? ` · ${this.state.origin}` : ""}`, tone: "success" };
		if (running) return { text: "The run in progress uses it", tone: "muted" };
		return undefined;
	}

	private detail(row: Row): ReaderContent {
		const theme = this.host.theme;
		return (width: number) => {
			const key = `${row.key}:${this.isSaved(row)}:${this.isRunning(row)}:${this.catalog?.state}`;
			if (this.layout?.key === key && this.layout.width === width) return this.layout.lines;
			const lines = this.detailLines(row, width, theme);
			this.layout = { key, width, lines };
			return lines;
		};
	}

	private detailLines(row: Row, width: number, theme: Theme): string[] {
		if (row.kind === "problems") {
			return [theme.bold("Catalog problems"), "", ...row.diagnostics.map((text) => `• ${plainLine(text)}`), "", theme.fg("muted", `Directory: ${homeRelative(plainLine(this.catalog?.dir ?? "unknown"))}`)];
		}
		const standing = this.standing(row);
		const heading = `${theme.bold(row.kind === "off" ? "off" : row.name)}${standing ? `   ${theme.fg(standing.tone, standing.text)}` : ""}`;
		if (row.kind === "off") return [heading, "", OFF_SUMMARY, "", theme.fg("muted", "The session or agent follows each task's instructions and its own judgement.")];
		const lines = [heading, ""];
		if (row.entry) {
			lines.push(theme.italic(row.entry.summary), "");
			const markdown = new Markdown(reflowParagraphs(row.entry.body), 0, 0, getMarkdownTheme(), { color: (value) => theme.fg("text", value) });
			lines.push(...markdown.render(Math.max(1, width)), "");
		} else {
			lines.push(theme.fg("warning", "No readable file supplies this playbook now, so it gives no instructions. Repair or add the file, or choose another playbook."), "");
		}
		if (row.installed && this.catalog) lines.push(theme.fg("muted", `File: ${homeRelative(plainLine(join(this.catalog.dir, `${row.name}.md`)))}`));
		const origin = this.originNote(row);
		if (origin) lines.push(theme.fg("muted", origin));
		return lines;
	}

	/** How the listed text relates to the bundled starter of the same name. */
	private originNote(row: Extract<Row, { kind: "playbook" }>): string | undefined {
		if (!row.entry) return undefined;
		if (!row.installed) return "Bundled starter, not installed yet. Using it installs the bundled starters.";
		if (!row.starter) return "Your own playbook; no bundled starter has this name.";
		if (sameText(row.entry, row.starter)) return "Same as the bundled starter.";
		return `Changed from the bundled starter.${this.source.compare ? " c compares them." : ""}`;
	}

	private rowActions(row: Row | undefined): readonly Action[] {
		if (row === undefined || row.kind === "problems") return [];
		const name = row.kind === "off" ? "off" : row.name;
		const subject = this.source.subject === "This session" ? "this session" : this.source.subject;
		const actions: Action[] = [];
		// The saved choice offers no Use, so Enter reads its text instead.
		if (!this.isSaved(row)) {
			actions.push({
				id: "use",
				label: row.kind === "off" ? `Turn off for ${subject}` : `Use for ${subject}`,
				short: row.kind === "off" ? "turn off" : "use",
				key: "enter",
				primary: true,
				tone: "accent",
				disabled: this.saving ? "Saving the choice" : undefined,
				run: () => void this.use(name),
			});
		}
		const compare = this.source.compare;
		if (compare && row.kind === "playbook" && row.starter) {
			actions.push({ id: "compare", label: "Compare with the bundled starter", short: "compare", key: "c", primary: true, run: () => this.openCompare(compare, row.name) });
		}
		actions.push({ id: "reload", label: "Read the catalog again", short: "reload", key: "r", run: () => { this.reload(); this.host.requestRender(); } });
		return actions;
	}

	private openCompare(compare: (name: string) => (host: ViewHost) => View, name: string): void {
		let open: (host: ViewHost) => View;
		try {
			open = compare(name);
		} catch (error) {
			this.host.notify(errorText(error), "error");
			return;
		}
		this.browser.push((child) => {
			// An import changes the catalog; read it again when the review is left.
			child.signal.addEventListener("abort", () => { if (!this.host.signal.aborted) this.reload(); }, { once: true });
			return open(child);
		});
	}

	private async use(name: string): Promise<void> {
		if (this.saving || this.host.signal.aborted) return;
		this.saving = true;
		this.host.notify(`Saving ${name === "off" ? "off" : name} for ${this.source.subject === "This session" ? "this session" : this.source.subject}…`, "pending");
		try {
			const receipt = await this.source.apply(name, this.host.signal);
			if (this.host.signal.aborted) return;
			this.host.close(() => this.source.applied?.(receipt));
		} catch (error) {
			if (this.host.signal.aborted) return;
			this.saving = false;
			this.host.notify(errorText(error), "error");
		}
	}

	render(width: number, height: number): string[] {
		return this.browser.render(width, height);
	}

	handleInput(data: string): boolean {
		return this.browser.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.browser.handleMouse(event);
	}

	actions(): readonly Action[] {
		return this.browser.actions();
	}

	keys(): readonly KeyHint[] {
		return this.browser.keys();
	}

	escape(): boolean {
		return this.browser.escape();
	}

	focusNext(backward: boolean): boolean {
		return this.browser.focusNext(backward);
	}

	focusEdge(backward: boolean): void {
		this.browser.focusEdge(backward);
	}

	invalidate(): void {
		this.layout = undefined;
		this.browser.invalidate();
	}

	dispose(): void {
		this.reading?.abort();
	}
}
