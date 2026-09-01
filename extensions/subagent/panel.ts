/**
 * Interactive /subagent console.
 *
 * A list of workers, and — for the one you open — a live console over its
 * conversation that reads and feels like pi's primary session: user messages as
 * full-width bands, tool calls as status-coloured boxes, assistant prose, and,
 * for a worker this session still owns, an input line you type into to steer.
 *
 * It is a VIEW only. It reads worker records and the worker's own session
 * messages, and it acts through the same steer/cancel paths the tools use. The
 * transcript rendering itself lives in console.ts and follows pi's real
 * interactive styling (theme tokens, status backgrounds, no ad-hoc glyphs).
 */

import { execFile } from "node:child_process";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { decodeKittyPrintable, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type ConsoleAssistantMessage,
	type ConsoleMessage,
	type ConsolePart,
	type ConsoleTextPart,
	type ConsoleToolResultMessage,
	renderConversation,
	stripTerminalSequences,
} from "./console.ts";
import type { WorkerRecord } from "./index.ts";

export interface SubagentPanelDeps {
	/** All store records, live first. */
	readWorkers(): WorkerRecord[];
	readWorker(id: string): WorkerRecord | null;
	/** Request cancellation through the existing kill path. */
	kill(id: string): Promise<string>;
	/** Fork a terminal session into a new linked background worker. */
	continueWorker(id: string, message: string): Promise<{ id: string | null; text: string }>;
	/** Compact terminal report preview, separate from the transcript. */
	report(id: string): { label: string; text: string } | null;
	/** Protocol-v1 transcript items for a worker (the live runtime's snapshot
	 * when owned here, else its session file put through the same conversion),
	 * or null when nothing is available. Never raw Pi messages: runtime.ts owns
	 * protocol conversion. */
	conversation(id: string): TranscriptItem[] | null;
	/** Whether this session still owns the worker as a live run. */
	isLive(id: string): boolean;
	/** Subscribe to a live worker's updates. Returns unsubscribe, or null. */
	subscribeLive(id: string, onEvent: () => void): (() => void) | null;
	/** Whether the worker's agent run is currently active (thinking/streaming/tool). */
	isActive(id: string): boolean;
	/** Interrupt the current run without ending the worker. */
	interrupt(id: string): Promise<string>;
	/** Steer while active, prompt when idle (resumes an interrupted worker). */
	sendLive(id: string, text: string): Promise<string>;
	/** The current session's id, or null when unavailable. */
	currentSessionId(): string | null;
	/** Optional clipboard adapter for controlled tests or platform integration. */
	copyText?(text: string, done: (error?: string) => void): void;
}

const STATUS_GLYPH: Record<string, string> = {
	running: "●",
	done: "✓",
	failed: "✗",
	cancelled: "×",
	no_result_submitted: "◌",
	owner_lost: "?",
};
function statusGlyph(state: string): string {
	return STATUS_GLYPH[state] ?? "·";
}
function statusColor(state: string): ThemeColor {
	if (state === "done") return "success";
	if (state === "failed") return "error";
	if (state === "cancelled" || state === "owner_lost" || state === "no_result_submitted") {
		return "warning";
	}
	return "accent";
}

function displayState(worker: WorkerRecord): string {
	if (worker.state === "running" && worker.interruptedAt) return "interrupted";
	if (worker.state === "no_result_submitted") return "no result";
	if (worker.state === "owner_lost") return "owner lost";
	return worker.state;
}

function modelShort(model: string): string {
	return model.split("/").at(-1) ?? model;
}

/** Elapsed time for compact TUI fields. */
export function formatPanelElapsed(seconds: number): string {
	const whole = Math.max(0, Math.round(seconds));
	if (whole < 60) return `${whole}s`;
	return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** Worker-authored content for the flexible roster field; never the dispatch instruction. */
export function rosterOutputPreview(worker: WorkerRecord): string {
	const source = worker.resultPreview ?? worker.lastOutput ?? worker.error;
	if (!source) return worker.state === "running" ? "(no output yet)" : "(no output)";
	return cleanConsoleInput(source).replace(/\s+/g, " ").trim() || "(no output)";
}

function fixedField(text: string, width: number): string {
	const value = truncateToWidth(text, width, "…");
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

// Panel height cap. Default grows with the terminal (85% of rows, floored at
// 44); PI_SUBAGENT_PANEL_MAX_ROWS pins a fixed cap.
const PANEL_MAX_ROWS_OVERRIDE = Number.parseInt(process.env.PI_SUBAGENT_PANEL_MAX_ROWS ?? "0", 10);

/**
 * Best-effort clipboard write via pbcopy (stdin-fed, no shell, async so the
 * render loop never blocks). Used to copy a finished worker's reopen command.
 */
function copyToClipboard(text: string, done: (error?: string) => void): void {
	try {
		const child = execFile("pbcopy", [], { encoding: "utf8", timeout: 3_000 }, (error) =>
			done(error ? error.message : undefined),
		);
		child.stdin?.end(text);
	} catch (err) {
		done(errText(err));
	}
}

/** A paste-ready shell command, including paths with spaces or apostrophes. */
export function reopenCommand(sessionFile: string): string {
	return `pi --session '${sessionFile.replace(/'/g, "'\\''")}'`;
}

/** Message text from an unknown throw value, for panel notices. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Pad/truncate a plain string to exactly `width` visible columns. */
function plainLine(text: string, width: number): string {
	const t = truncateToWidth(text, width, "");
	return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}

/** Keep the load-bearing tail of long notices (path + closing shell quote). */
function truncateFromLeft(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let tail = "";
	for (let index = [...text].length - 1; index >= 0; index--) {
		const candidate = [...text][index] + tail;
		if (visibleWidth(`…${candidate}`) > width) break;
		tail = candidate;
	}
	return `…${tail}`;
}

/** Compose a footer that sheds optional actions before its sole Escape
 * affordance. Notices keep their useful tail but never replace back/close. */
function footerWithEscape(width: number, leading: string[], escapeLabel: string, notice?: string): string {
	const w = Math.max(1, width);
	const escapeHint = visibleWidth(escapeLabel) <= w ? escapeLabel : w >= 3 ? "esc" : "esc".slice(0, w);
	if (notice) {
		const separator = " · ";
		const budget = w - visibleWidth(escapeHint) - visibleWidth(separator);
		if (budget <= 0) return plainLine(escapeHint, w);
		return plainLine(`${truncateFromLeft(notice, budget)}${separator}${escapeHint}`, w);
	}

	const kept = [...leading];
	const compose = () => [...kept, escapeHint].join(" · ");
	while (kept.length > 1 && visibleWidth(compose()) > w) kept.pop();
	if (visibleWidth(compose()) > w) kept.length = 0;
	return plainLine(compose(), w);
}

/**
 * The text a keypress carries, or an empty string when it carries none.
 *
 * A terminal that negotiated the Kitty keyboard protocol sends CSI-u for EVERY
 * key, printable ones included, so raw single-character comparisons match
 * nothing there and typed text never arrives. pi-tui decodes those events for
 * its own input component; every printable branch must go through the same
 * decoder before it looks at the data.
 */
function printableKey(data: string): string {
	const decoded = decodeKittyPrintable(data);
	if (decoded !== undefined) return decoded;
	return data;
}

/** Convert layout controls to spaces, then remove remaining terminal controls. */
function cleanConsoleInput(data: string): string {
	return stripTerminalSequences(data)
		.replace(/[\t\r\n]+/g, " ")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/**
 * Normalize PROTOCOL-V1 transcript items into the shapes console.ts renders.
 *
 * The input comes from `workerConversation`, which produces protocol items for
 * both live and terminal workers through runtime.ts. This function does not
 * read Pi's internal message shape. Protocol v1 remains the one downstream
 * contract.
 *
 * Field mapping (protocol -> console): a tool call part carries `toolCallId` /
 * `toolName` / `input`, and a tool result is a top-level item with role "tool".
 * Protocol roles without terminal text stay outside this renderer.
 */
function toTextParts(content: TranscriptItem["content"]): ConsoleTextPart[] {
	const out: ConsoleTextPart[] = [];
	for (const part of content) {
		if (part.type === "text") {
			out.push({ type: "text", text: part.text });
		} else if (part.type === "image") {
			out.push({ type: "text", text: "[image]" });
		}
	}
	return out;
}

function toolArguments(input: unknown): Record<string, unknown> {
	return input && typeof input === "object" && !Array.isArray(input)
		? Object.fromEntries(Object.entries(input))
		: { value: input };
}

function toAssistantParts(content: Extract<TranscriptItem, { role: "assistant" }>["content"]): ConsolePart[] {
	const out: ConsolePart[] = [];
	for (const part of content) {
		if (part.type === "text") {
			out.push({ type: "text", text: part.text });
		} else if (part.type === "thinking") {
			out.push({ type: "thinking", thinking: part.thinking });
		} else if (part.type === "toolCall") {
			out.push({
				type: "toolCall",
				id: part.toolCallId,
				name: part.toolName,
				arguments: toolArguments(part.input),
			});
		}
	}
	return out;
}

function normalizeMessages(raw: TranscriptItem[]): ConsoleMessage[] {
	const out: ConsoleMessage[] = [];
	for (const item of raw) {
		if (item.role === "user") {
			out.push({ role: "user", content: toTextParts(item.content) });
		} else if (item.role === "assistant") {
			const message: ConsoleAssistantMessage = {
				role: "assistant",
				content: toAssistantParts(item.content),
			};
			if ("stopReason" in item) message.stopReason = item.stopReason;
			if ("errorMessage" in item && item.errorMessage) {
				message.errorMessage = item.errorMessage;
			}
			out.push(message);
		} else {
			const result: ConsoleToolResultMessage = {
				role: "toolResult",
				toolCallId: item.toolCallId,
				toolName: item.toolName,
				content: toTextParts(item.content),
				isError: item.isError,
				status: item.status,
			};
			out.push(result);
		}
	}
	return out;
}

class SubagentConsole {
	focused = false;
	private view: "list" | "filter" | "console" = "list";
	private scope: "session" | "all" = "session";
	private filter = "";
	private selected = 0;
	/** Stable roster selection; the index is re-derived after live-first reorder. */
	private rosterSelectedId: string | null = null;
	/** Worker opened in the console; never re-derived from a reorderable index. */
	private pinnedId: string | null = null;
	private scroll = 0;
	private followTail = true;
	private continuing = false;
	private continuationPending = false;
	// Input line (live steer/resume, or terminal continuation prompt).
	private input = "";
	private inputCursor = 0;
	// Render-only invalidations (ticks, notices, input) stay separate from
	// transcript content changes.
	private contentVersion = 0;
	private lastWidth = 80;
	private transcriptCache: { key: string; value: string[] } | null = null;
	private unsub: (() => void) | null = null;
	private notice: string | undefined;
	private noticeUntil = 0;
	private disposed = false;
	private readonly deps: SubagentPanelDeps;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly close: () => void;

	constructor(deps: SubagentPanelDeps, tui: TUI, theme: Theme, done: () => void, initialFilter?: string) {
		this.deps = deps;
		this.tui = tui;
		this.theme = theme;
		this.close = done;
		if (initialFilter) {
			this.view = "filter";
			this.filter = initialFilter;
		}
	}

	private get workers(): WorkerRecord[] {
		const all = this.deps.readWorkers();
		const scoped =
			this.scope === "session"
				? (() => {
						const sid = this.deps.currentSessionId();
						return sid ? all.filter((w) => w.ownerSession === sid) : all;
					})()
				: all;
		if (!this.filter) return scoped;
		const needle = this.filter.toLocaleLowerCase();
		return scoped.filter((w) =>
			[w.id, w.state, w.model, w.task, w.thinking]
				.filter(Boolean)
				.some((f) => String(f).toLocaleLowerCase().includes(needle)),
		);
	}

	private reconcileSelection(workers = this.workers): number {
		if (workers.length === 0) {
			this.selected = 0;
			this.rosterSelectedId = null;
			return 0;
		}
		if (this.rosterSelectedId) {
			const found = workers.findIndex((worker) => worker.id === this.rosterSelectedId);
			if (found >= 0) this.selected = found;
		}
		this.selected = Math.max(0, Math.min(workers.length - 1, this.selected));
		this.rosterSelectedId = workers[this.selected]?.id ?? null;
		return this.selected;
	}

	private selectedId(): string | null {
		if (this.view === "console") return this.pinnedId;
		const workers = this.workers;
		return workers[this.reconcileSelection(workers)]?.id ?? null;
	}

	private bumpContent(): void {
		this.contentVersion++;
	}
	private bump(): void {
		this.tui.requestRender();
	}
	private setNotice(text: string): void {
		if (this.disposed) return;
		this.notice = text;
		this.noticeUntil = Date.now() + 4_000;
		this.bump();
	}

	private openConsole(id = this.selectedId()): void {
		if (!id) return;
		this.pinnedId = id;
		this.view = "console";
		this.scroll = 0;
		this.followTail = true;
		this.continuing = false;
		this.continuationPending = false;
		this.input = "";
		this.inputCursor = 0;
		this.bumpContent();
		// Subscribe to live updates so the console streams like the primary session.
		if (this.unsub) {
			this.unsub();
			this.unsub = null;
		}
		const unsub = this.deps.subscribeLive(id, () => {
			this.bumpContent();
			this.tui.requestRender();
		});
		this.unsub = unsub;
	}
	private closeConsole(): void {
		if (this.unsub) {
			this.unsub();
			this.unsub = null;
		}
		// Return to the same worker in the (possibly reordered) list.
		if (this.pinnedId) {
			this.rosterSelectedId = this.pinnedId;
			const index = this.workers.findIndex((w) => w.id === this.pinnedId);
			if (index >= 0) this.selected = index;
		}
		this.pinnedId = null;
		this.continuing = false;
		this.continuationPending = false;
		this.view = "list";
		this.bump();
	}

	private transcriptLines(): string[] {
		const id = this.selectedId();
		const width = this.lastWidth;
		const key = `${this.contentVersion}:${id}:${width}`;
		if (this.transcriptCache?.key === key) return this.transcriptCache.value;
		let lines: string[];
		if (!id) {
			lines = [plainLine("(no worker selected)", width)];
		} else {
			const raw = this.deps.conversation(id);
			const normalized = normalizeMessages(raw ?? []);
			const report = this.deps.report(id);
			if (report) {
				normalized.push({
					role: "assistant",
					content: [
						{
							type: "text",
							text: `──── ${report.label} ────\n\n${report.text}`,
						},
					],
				});
			}
			lines =
				normalized.length === 0
					? [plainLine("(no conversation recorded yet)", width)]
					: renderConversation(normalized, { width, theme: this.theme });
		}
		this.transcriptCache = { key, value: lines };
		return lines;
	}

	handleInput(data: string): void {
		if (this.view === "filter") {
			this.handleFilter(data);
			return;
		}
		if (this.view === "list") {
			this.handleList(data);
			return;
		}
		this.handleConsole(data);
	}

	private handleFilter(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.filter = "";
			this.view = "list";
			this.selected = 0;
			this.rosterSelectedId = null;
			this.bump();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.view = "list";
			this.selected = 0;
			this.rosterSelectedId = null;
			this.bump();
			return;
		}
		const typed = printableKey(data);
		if (matchesKey(data, Key.backspace)) {
			this.filter = this.filter.slice(0, -1);
		} else if (typed.length === 1 && typed.charCodeAt(0) >= 32 && typed.charCodeAt(0) < 127) {
			this.filter += typed;
		}
		this.selected = 0;
		this.rosterSelectedId = null;
		this.bump();
	}

	private handleList(data: string): void {
		const workers = this.workers;
		const key = printableKey(data);
		this.reconcileSelection(workers);
		if (matchesKey(data, Key.escape)) {
			if (this.unsub) this.unsub();
			this.close();
			return;
		}
		if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, workers.length - 1), this.selected + 1);
		else if (matchesKey(data, Key.pageUp)) this.selected = Math.max(0, this.selected - 10);
		else if (matchesKey(data, Key.pageDown))
			this.selected = Math.min(Math.max(0, workers.length - 1), this.selected + 10);
		else if (matchesKey(data, Key.enter)) {
			if (workers[this.selected]) this.openConsole();
		} else if (key === "/") {
			this.view = "filter";
			this.filter = "";
		} else if (key === "a" || key === "A") {
			this.scope = this.scope === "session" ? "all" : "session";
			this.selected = 0;
			this.rosterSelectedId = null;
		} else if (key === "k" || key === "K") {
			const worker = workers[this.selected];
			if (worker && worker.state === "running" && this.deps.isLive(worker.id)) {
				void this.deps
					.kill(worker.id)
					.then((message) => this.setNotice(message))
					.catch((err: unknown) => this.setNotice(`cancel failed: ${errText(err)}`));
			}
		}
		if (key !== "a" && key !== "A") {
			this.rosterSelectedId = workers[this.selected]?.id ?? null;
		}
		this.bump();
	}

	private scrollBy(delta: number): void {
		const max = Math.max(0, this.transcriptLines().length - this.windowHeight());
		this.scroll = Math.max(0, Math.min(max, this.scroll + delta));
		this.followTail = this.scroll >= max;
		this.bump();
	}
	private jumpTail(): void {
		const max = Math.max(0, this.transcriptLines().length - this.windowHeight());
		this.scroll = max;
		this.followTail = true;
		this.bump();
	}

	private handleConsole(data: string): void {
		const consoleKey = printableKey(data);
		const id = this.selectedId();
		const record = id ? this.deps.readWorker(id) : null;
		const live = id ? this.deps.isLive(id) : false;
		const active = live && id ? this.deps.isActive(id) : false;
		const terminal = Boolean(record && record.state !== "running");

		if (matchesKey(data, Key.escape)) {
			if (this.continuing && !this.continuationPending) {
				this.continuing = false;
				this.input = "";
				this.inputCursor = 0;
				this.bump();
			} else {
				this.closeConsole();
			}
			return;
		}
		if (!this.continuing && matchesKey(data, Key.ctrl("c"))) {
			if (active && id) {
				void this.deps
					.interrupt(id)
					.then((message) => this.setNotice(message))
					.catch((err: unknown) => this.setNotice(`interrupt failed: ${errText(err)}`));
			} else if (live && id) {
				void this.deps
					.kill(id)
					.then((message) => this.setNotice(message))
					.catch((err: unknown) => this.setNotice(`cancel failed: ${errText(err)}`));
			}
			return;
		}
		if (!this.continuing && (consoleKey === "c" || consoleKey === "C") && terminal && record?.sessionFile) {
			const command = reopenCommand(record.sessionFile);
			const copyText = this.deps.copyText ?? copyToClipboard;
			copyText(command, (error) => this.setNotice(error ? `copy failed: ${error}` : `copied: ${command}`));
			return;
		}
		if (!this.continuing && (consoleKey === "r" || consoleKey === "R") && terminal && record?.sessionFile) {
			this.continuing = true;
			this.input = "";
			this.inputCursor = 0;
			this.bump();
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(-this.windowHeight());
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(this.windowHeight());
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.scroll = 0;
			this.followTail = false;
			this.bump();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.jumpTail();
			return;
		}

		if (live || this.continuing) {
			const chars = [...this.input];
			if (matchesKey(data, Key.enter)) {
				const text = this.input.trim();
				if (!text || !id || this.continuationPending) return;
				if (this.continuing) {
					const sourceId = id;
					this.continuationPending = true;
					this.bump();
					void this.deps
						.continueWorker(sourceId, text)
						.then((outcome) => {
							if (this.disposed || this.pinnedId !== sourceId) return;
							this.continuationPending = false;
							if (outcome.id) this.openConsole(outcome.id);
							else this.bump();
							this.setNotice(outcome.text);
						})
						.catch((err: unknown) => {
							this.continuationPending = false;
							this.setNotice(`continue failed: ${errText(err)}`);
						});
				} else {
					void this.deps
						.sendLive(id, text)
						.then((message) => this.setNotice(message))
						.catch((err: unknown) => this.setNotice(`send failed: ${errText(err)}`));
					this.input = "";
					this.inputCursor = 0;
				}
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				if (this.inputCursor > 0) {
					chars.splice(this.inputCursor - 1, 1);
					this.input = chars.join("");
					this.inputCursor--;
				}
				this.bump();
				return;
			}
			if (matchesKey(data, Key.delete)) {
				if (this.inputCursor < chars.length) {
					chars.splice(this.inputCursor, 1);
					this.input = chars.join("");
				}
				this.bump();
				return;
			}
			if (matchesKey(data, Key.insert)) return;
			if (matchesKey(data, Key.left)) {
				this.inputCursor = Math.max(0, this.inputCursor - 1);
				this.bump();
				return;
			}
			if (matchesKey(data, Key.right)) {
				this.inputCursor = Math.min(chars.length, this.inputCursor + 1);
				this.bump();
				return;
			}
			const cleaned = cleanConsoleInput(printableKey(data));
			if (cleaned.length > 0) {
				chars.splice(this.inputCursor, 0, ...[...cleaned]);
				this.input = chars.join("");
				this.inputCursor += [...cleaned].length;
				this.bump();
			}
		}
	}

	invalidate(): void {
		// The 1s tick refreshes elapsed/status display only. Do not bump
		// contentVersion: the transcript cache must survive a content-idle tick.
		this.bump();
	}

	dispose(): void {
		this.disposed = true;
		if (this.unsub) {
			this.unsub();
			this.unsub = null;
		}
	}

	private maxPanelHeight(): number {
		// pi-tui reserves one row for the transcript's minimum and one for its
		// own footer, so the editorContainer receives terminal.rows - 2.
		const cap =
			PANEL_MAX_ROWS_OVERRIDE > 0 ? PANEL_MAX_ROWS_OVERRIDE : Math.max(44, Math.floor(this.tui.terminal.rows * 0.85));
		return Math.max(1, Math.min(this.tui.terminal.rows - 2, cap));
	}

	private panelHeight(): number {
		const max = this.maxPanelHeight();
		if (this.view === "list" || this.view === "filter") {
			return Math.min(max, Math.max(3, this.workers.length + 2));
		}
		const record = this.pinnedId ? this.deps.readWorker(this.pinnedId) : null;
		if (record?.state === "running") return max;
		return Math.min(max, Math.max(6, this.transcriptLines().length + 3));
	}

	private windowHeight(): number {
		// Header + input/status row + footer row are reserved inside the panel.
		return Math.max(0, this.panelHeight() - 3);
	}

	render(width: number): string[] {
		try {
			this.lastWidth = width;
			// A pinned worker can disappear under the console: pruning or another
			// session may remove its record. Return to the roster rather than hold a
			// console over a worker that no longer exists.
			if (this.view === "console" && this.pinnedId && !this.deps.readWorker(this.pinnedId)) {
				this.setNotice(`worker ${this.pinnedId} is no longer in the store`);
				this.closeConsole();
			}
			if (this.view === "list" || this.view === "filter") return this.renderList(width);
			return this.renderConsole(width);
		} catch {
			// A malformed current record must not escape Pi's render loop.
			// The panel degrades to a single error line.
			const w = Math.max(1, width);
			const msg = "subagent: render error — a worker record may be malformed";
			return [msg.slice(0, w).padEnd(w, " ")];
		}
	}

	private renderList(width: number): string[] {
		const theme = this.theme;
		const rows = this.panelHeight();
		const workers = this.workers;
		const selected = this.reconcileSelection(workers);
		const lines: string[] = [];
		const liveCount = workers.filter((worker) => worker.state === "running").length;
		const head = `workers · ${workers.length} · ${liveCount} active · ${this.scope}${
			this.filter ? ` · /${this.filter}` : ""
		}`;
		lines.push(plainLine(theme.fg("accent", theme.bold(head)), width));

		const viewport = Math.max(1, rows - 2);
		const start = Math.max(0, Math.min(selected - viewport + 1, workers.length - viewport));
		const visible = workers.slice(start, start + viewport);
		if (visible.length === 0) {
			lines.push(
				plainLine(
					theme.fg(
						"dim",
						this.filter
							? "no workers match the filter — esc to clear"
							: this.scope === "session"
								? "no workers for this session — press a for all sessions"
								: "no workers in the store",
					),
					width,
				),
			);
		}
		for (let index = 0; index < visible.length; index++) {
			const worker = visible[index];
			const absolute = start + index;
			const isSelected = absolute === selected;
			const state = displayState(worker);
			const marker = isSelected ? "›" : " ";
			const elapsed = formatPanelElapsed(((worker.exitedAt ?? Date.now()) - worker.startedAt) / 1000);
			const cost =
				worker.usage && worker.usage.cost > 0
					? `$${worker.usage.cost < 0.01 ? worker.usage.cost.toFixed(4) : worker.usage.cost.toFixed(2)}`
					: "–";
			const tool = worker.state === "running" && worker.currentTool ? `now:${worker.currentTool}` : "";
			const statusText = `${statusGlyph(worker.state)} ${state.padEnd(12)}`;
			const fullMeta = `${fixedField(modelShort(worker.model), 20)}  ${elapsed.padStart(7)}  ${cost.padStart(8)}${tool ? `  ${truncateToWidth(tool, 16, "…")}` : ""}`;
			const compactMeta = `${modelShort(worker.model)} ${elapsed} ${cost}${tool ? ` ${tool}` : ""}`;
			const fullPrefixWidth = visibleWidth(`${marker} ${statusText}  ${fullMeta}`);
			const meta = width - fullPrefixWidth >= 12 ? fullMeta : compactMeta;
			const prefixPlain = `${marker} ${statusText}  ${meta}`;
			const previewWidth = Math.max(0, width - visibleWidth(prefixPlain) - 2);
			const preview = truncateToWidth(rosterOutputPreview(worker), previewWidth, "…");
			const status = theme.fg(statusColor(worker.state), statusText);
			let line = plainLine(
				`${marker} ${status}  ${theme.fg("dim", meta)}${previewWidth > 0 ? `  ${theme.fg("text", preview)}` : ""}`,
				width,
			);
			if (isSelected) line = theme.bg("selectedBg", line);
			lines.push(line);
		}
		while (lines.length < rows - 1) lines.push(plainLine("", width));

		const selectedWorker = workers[selected];
		const canCancel = Boolean(selectedWorker?.state === "running" && this.deps.isLive(selectedWorker.id));
		const noticeUp = Boolean(this.notice && Date.now() < this.noticeUntil);
		if (this.notice && !noticeUp) this.notice = undefined;
		const leading = ["↑↓ select", "enter open", "/ filter", "a scope"];
		if (canCancel) leading.push("k cancel");
		const hint = footerWithEscape(
			width,
			leading,
			this.view === "filter" ? "esc clear" : "esc close",
			noticeUp ? this.notice : undefined,
		);
		lines.push(theme.fg(noticeUp ? "warning" : "dim", hint));
		return lines;
	}

	private renderConsole(width: number): string[] {
		const theme = this.theme;
		const id = this.selectedId();
		const record = id ? this.deps.readWorker(id) : null;
		const live = id ? this.deps.isLive(id) : false;
		const active = live && id ? this.deps.isActive(id) : false;
		const running = record?.state === "running";
		const lines: string[] = [];
		const noticeUp = !!(this.notice && Date.now() < this.noticeUntil);
		if (this.notice && !noticeUp) this.notice = undefined;

		// Compact status header: identity, state, model, elapsed, cost, and the
		// live tool when running. Notices never append here (they would be
		// clipped); they take the footer line instead.
		const elapsed = record ? Math.round(((record.exitedAt ?? Date.now()) - record.startedAt) / 1000) : 0;
		const cost = record?.usage ? `$${record.usage.cost.toFixed(4)}` : "—";
		const state = record ? displayState(record) : "unknown";
		const head = record
			? `${record.id} · ${state} · ${modelShort(record.model)} · ${formatPanelElapsed(elapsed)} · ${cost}${
					running && record.currentTool ? ` · now:${record.currentTool}` : ""
				}${record.continuedFrom ? ` · ↳ from ${record.continuedFrom}` : ""}`
			: "(no worker)";
		lines.push(plainLine(theme.fg("accent", theme.bold(truncateToWidth(head, width, ""))), width));

		// Transcript window (auto-follow when at tail).
		const all = this.transcriptLines();
		const win = this.windowHeight();
		const max = Math.max(0, all.length - win);
		if (this.followTail) this.scroll = max;
		else this.scroll = Math.min(this.scroll, max);
		for (let i = 0; i < win; i++) {
			const ln = all[this.scroll + i];
			lines.push(ln ?? plainLine("", width));
		}

		// Input line (live steer/resume or terminal continuation), code-point
		// based and windowed so the cursor never runs off-screen.
		if (live || this.continuing) {
			if (this.continuationPending) {
				lines.push(plainLine(theme.fg("accent", "continue › starting…"), width));
			} else {
				const chars = [...this.input];
				const cursor = Math.min(this.inputCursor, chars.length);
				const label = this.continuing ? "continue › " : "› ";
				const budget = Math.max(1, width - visibleWidth(label) - 1);
				const beforeChars = chars.slice(0, cursor);
				const beforeShown =
					beforeChars.length > budget ? ["…", ...beforeChars.slice(beforeChars.length - (budget - 1))] : beforeChars;
				const afterCount = Math.max(0, budget - beforeShown.length);
				const at = chars[cursor] ?? " ";
				const after = chars.slice(cursor + 1, cursor + 1 + afterCount).join("");
				const prompt = theme.fg("accent", label) + beforeShown.join("") + theme.inverse(at) + after;
				lines.push(plainLine(prompt, width));
			}
		} else if (running) {
			lines.push(
				plainLine(
					theme.fg("warning", truncateToWidth("running in another session — steer/abort unavailable here", width, "")),
					width,
				),
			);
		} else {
			lines.push(plainLine(theme.fg("dim", state), width));
		}

		// Footer: scroll first, optional actions in the middle, Escape retained.
		let actions: string[];
		let escapeLabel: string;
		if (this.continuing) {
			// A pending dispatch rejects another Enter; do not advertise one.
			actions = this.continuationPending ? ["↑↓ scroll", "starting…"] : ["↑↓ scroll", "enter start"];
			escapeLabel = "esc cancel";
		} else if (running && active) {
			actions = ["↑↓ scroll", "enter steer", "ctrl+c interrupt"];
			escapeLabel = "esc back";
		} else if (running && live) {
			actions = ["↑↓ scroll", "enter run", "ctrl+c cancel"];
			escapeLabel = "esc back";
		} else if (record?.sessionFile && record.state !== "running") {
			// Continuation needs a terminal record; a running foreign worker has a
			// session file but cannot be continued, so it gets no continue hint.
			actions = ["↑↓ scroll", "c copy", "r continue"];
			escapeLabel = "esc back";
		} else {
			actions = ["↑↓ scroll"];
			escapeLabel = "esc back";
		}
		lines.push(
			theme.fg(
				noticeUp ? "warning" : "dim",
				footerWithEscape(width, actions, escapeLabel, noticeUp ? this.notice : undefined),
			),
		);
		return lines;
	}
}

export function openSubagentPanel(
	ctx: ExtensionCommandContext,
	deps: SubagentPanelDeps,
	initialFilter?: string,
): Promise<void> {
	return ctx.ui
		.custom<void>((tui: TUI, theme: Theme, _keybindings, done) => {
			const panel = new SubagentConsole(deps, tui, theme, () => done(undefined), initialFilter);
			const timer = setInterval(() => {
				panel.invalidate();
			}, 1_000);
			return {
				render: (width: number) => panel.render(width),
				handleInput: (data: string) => panel.handleInput(data),
				invalidate: () => panel.invalidate(),
				dispose: () => {
					clearInterval(timer);
					panel.dispose?.();
				},
			};
		})
		.then(() => undefined);
}
