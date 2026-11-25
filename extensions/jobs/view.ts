/**
 * The `/jobs` view: this session runtime's background jobs, newest first, and the last output of the selected job,
 * in the editor slot below the transcript. Reading is the main job; cancelling a running job is the one action.
 */

import { homedir } from "node:os";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { completionTail, displayText } from "./completion.ts";
import type { JobLogs, JobSnapshot } from "./manager.ts";

/** What the view reads and does; the extension binds it to its job manager. */
export interface JobsSource {
	list(): JobSnapshot[];
	logs(id: string, cursor?: number): JobLogs;
	cancel(id: string): void;
	/** Session total, including jobs whose records are no longer available. */
	started(): number;
}

/**
 * The state a row shows. The dot follows the footer's meanings: yellow while a job runs (wait), red when it went
 * wrong (look), grey hollow when nothing is out.
 */
export type RowState = "running" | "stopping" | "succeeded" | "failed" | "timed_out" | "cancelled";
const WORD: Record<RowState, string> = {
	running: "running",
	stopping: "stopping",
	succeeded: "succeeded",
	failed: "failed",
	timed_out: "timed out",
	cancelled: "cancelled",
};
const DOT: Record<RowState, { glyph: string; colour: "warning" | "error" | "muted" }> = {
	running: { glyph: "●", colour: "warning" },
	stopping: { glyph: "●", colour: "warning" },
	failed: { glyph: "●", colour: "error" },
	timed_out: { glyph: "●", colour: "error" },
	succeeded: { glyph: "○", colour: "muted" },
	cancelled: { glyph: "○", colour: "muted" },
};
const WORD_WIDTH = Math.max(...Object.values(WORD).map((word) => word.length));
const ELAPSED_WIDTH = 6;

export function rowState(job: JobSnapshot): RowState {
	if (job.status === "running") return job.cancellationRequested ? "stopping" : "running";
	return job.status;
}

/** Elapsed time in at most two units: `8s`, `2m 05s`, `1h 04m`. */
export function elapsedText(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export interface JobRow {
	readonly id: string;
	readonly state: RowState;
	readonly word: string;
	readonly elapsed: string;
	readonly command: string;
	readonly exitCode?: number | null;
	readonly cwd?: string;
	readonly timeoutSeconds?: number;
}

/** Running jobs first, newest start first; then ended jobs, latest end first. */
function order(a: JobSnapshot, b: JobSnapshot): number {
	const aRuns = a.status === "running";
	const bRuns = b.status === "running";
	if (aRuns !== bRuns) return aRuns ? -1 : 1;
	return aRuns ? b.startedAt - a.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0);
}

/** One row per job: the jobs that run, then the jobs that ended, newest first in each. */
export function jobRows(jobs: readonly JobSnapshot[], now: number): JobRow[] {
	return [...jobs].sort(order).map((job) => {
		const state = rowState(job);
		return {
			id: job.id,
			state,
			word: WORD[state],
			elapsed: elapsedText((job.endedAt ?? now) - job.startedAt),
			command: oneLine(job.commandPreview ?? "") || "(command not recorded)",
			...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
			...(job.cwd === undefined ? {} : { cwd: job.cwd }),
			...(job.timeoutSeconds === undefined ? {} : { timeoutSeconds: job.timeoutSeconds }),
		};
	});
}

/** Counts of the title row: jobs that run now out of every job this session started. */
export function countsText(rows: readonly JobRow[], started: number): string {
	const running = rows.filter((row) => row.state === "running" || row.state === "stopping").length;
	return `${running} running · ${started} started`;
}

/** What the view says when it has no job to show. */
export function emptyText(earlier: number): string {
	return earlier > 0
		? "No background jobs since Pi started. Earlier jobs of this session ended with their Pi process."
		: "No background jobs in this session.";
}

/** The `/jobs` answer outside the interactive terminal: one line per job, in the order of the view. */
export function summaryText(jobs: readonly JobSnapshot[], now: number, started: number): string {
	const rows = jobRows(jobs, now);
	if (rows.length === 0) return emptyText(started);
	const lines = rows.map((row) => `${DOT[row.state].glyph} ${row.word} ${row.elapsed}  ${row.command}`);
	return [`Jobs: ${countsText(rows, started)}`, ...lines].join("\n");
}

/** One display line: controls removed, tabs as spaces, whitespace runs kept. */
function oneLine(text: string): string {
	return displayText(text).replace(/\t/gu, "  ").replace(/\n/gu, " ").trimEnd();
}

/** The last lines of a job's retained output as a terminal would leave them: a carriage return rewrites its line. */
export function outputLines(source: Pick<JobsSource, "logs">, id: string): string[] {
	const tail = completionTail((cursor) => source.logs(id, cursor));
	if (tail.text === "") return [];
	return tail.text.split("\n").map((line) => {
		const text = line.replace(/\r+$/u, "");
		return oneLine(text.slice(text.lastIndexOf("\r") + 1));
	});
}

/** The folder with the home directory written as `~`. */
export function folderText(cwd: string, home = homedir()): string {
	return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

/** What the output rule names about the selected job beyond its row. */
export function outcomeText(row: JobRow): string {
	const parts: string[] = [];
	if (row.state === "timed_out" && row.timeoutSeconds !== undefined) parts.push(`limit ${row.timeoutSeconds}s`);
	else if (typeof row.exitCode === "number" && row.state !== "succeeded") parts.push(`exit ${row.exitCode}`);
	if (row.cwd) parts.push(oneLine(folderText(row.cwd)));
	return parts.join(" · ");
}

/** Exactly `width` columns: truncated, then padded. */
function fitLine(text: string, width: number): string {
	const columns = Math.max(0, Math.floor(width));
	if (columns === 0) return "";
	const value = truncateToWidth(text, columns);
	return value + " ".repeat(Math.max(0, columns - visibleWidth(value)));
}

/** Rows the view takes: 60% of the window, with transcript rows kept above it. */
export function viewRows(terminalRows: number): number {
	const rows = Math.max(8, Math.floor(terminalRows));
	return Math.max(8, Math.min(rows - 6, Math.round(rows * 0.6)));
}

interface KeyTarget {
	readonly x: number;
	readonly width: number;
	readonly key: string;
}

export interface JobsViewOptions {
	readonly source: JobsSource;
	readonly theme: Theme;
	readonly rows: () => number;
	readonly requestRender: () => void;
	readonly close: () => void;
	readonly now?: () => number;
	/** Selection that survives closing and reopening the view. */
	readonly selected?: { id?: string };
}

/** The view component: Up and Down select, `c` cancels the selected running job, Escape closes. */
export class JobsView {
	private rows: JobRow[] = [];
	private output: string[] = [];
	private top = 0;
	private size = { width: 0, height: 0 };
	private list = { top: 0, height: 0 };
	private keyRow = { y: -1, targets: [] as KeyTarget[] };
	private readonly selection: { id?: string };
	private readonly options: JobsViewOptions;

	constructor(options: JobsViewOptions) {
		this.options = options;
		this.selection = options.selected ?? {};
		this.refresh();
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/** Reads the jobs and the selected job's output again; the timer and every input call this, not each paint. */
	refresh(): void {
		this.rows = jobRows(this.options.source.list(), this.now());
		if (!this.rows.some((row) => row.id === this.selection.id)) this.selection.id = this.rows[0]?.id;
		const id = this.selection.id;
		try {
			this.output = id === undefined ? [] : outputLines(this.options.source, id);
		} catch {
			this.output = [];
		}
	}

	private selectedIndex(): number {
		return Math.max(
			0,
			this.rows.findIndex((row) => row.id === this.selection.id),
		);
	}

	private selected(): JobRow | undefined {
		return this.rows[this.selectedIndex()];
	}

	private move(delta: number): void {
		if (this.rows.length === 0) return;
		const index = Math.min(this.rows.length - 1, Math.max(0, this.selectedIndex() + delta));
		this.selection.id = this.rows[index]?.id;
		this.refresh();
	}

	private cancelSelected(): void {
		const row = this.selected();
		if (row?.state !== "running") return;
		try {
			this.options.source.cancel(row.id);
		} catch {
			// A job that left the records between refreshes has nothing to cancel; the refresh shows that.
		}
		this.refresh();
	}

	/** The keys that work now; Cancel only while the selected job runs. */
	keys(): Array<{ key: string; text: string; label: string }> {
		const keys: Array<{ key: string; text: string; label: string }> = [];
		if (this.rows.length > 1) keys.push({ key: "up/down", text: "↑↓", label: "select" });
		if (this.selected()?.state === "running") keys.push({ key: "c", text: "c", label: "cancel" });
		keys.push({ key: "escape", text: "esc", label: "close" });
		return keys;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.options.close();
			return;
		}
		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if ((decodeKittyPrintable(data) ?? data) === "c") this.cancelSelected();
		else return;
		this.options.requestRender();
	}

	/** Completed left clicks select a row or run a key-row control; wheel turns move the selection. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.shift || event.alt || event.ctrl) return undefined;
		if (event.width !== this.size.width || event.height !== this.size.height) return undefined;
		if (event.type === "wheel") {
			this.move((event.wheelDelta ?? 0) < 0 ? -1 : 1);
			return { handled: true };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		return this.handleControl(event);
	}

	private handleControl(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y === this.keyRow.y) {
			const target = this.keyRow.targets.find((item) => event.x >= item.x && event.x < item.x + item.width);
			if (!target) return undefined;
			if (event.type === "click") this.clickKey(target);
		} else {
			const row = this.rows[this.top + event.y - this.list.top];
			if (event.y < this.list.top || event.y >= this.list.top + this.list.height || !row) return undefined;
			if (event.type === "click") {
				this.selection.id = row.id;
				this.refresh();
			}
		}
		return { handled: true };
	}

	private clickKey(target: KeyTarget): void {
		if (target.key === "escape") this.options.close();
		else if (target.key === "c") this.cancelSelected();
		else this.move(target.key === "up" ? -1 : 1);
	}

	/** Exactly the view's rows; without jobs it keeps to its title, the empty-state line and the key row. */
	render(width: number): string[] {
		const height = this.rows.length === 0 ? 3 : Math.max(4, Math.floor(this.options.rows()));
		this.size = { width, height };
		const lines = [this.titleRow(width)];
		if (this.rows.length === 0) {
			this.list = { top: 1, height: 0 };
			lines.push(this.options.theme.fg("muted", ` ${emptyText(this.options.source.started())}`));
		} else lines.push(...this.body(width, height - 2));
		lines.push(this.keysRow(width, height - 1));
		return lines.map((line) => fitLine(line, width));
	}

	invalidate(): void {}

	private titleRow(width: number): string {
		const theme = this.options.theme;
		const rule = (text: string) => theme.fg("borderMuted", text);
		const head = `${rule("─")}${theme.bold(theme.fg("accent", " Jobs "))}${rule("─")}`;
		const started = this.options.source.started();
		const counts = ` ${countsText(this.rows, started)} `;
		const tail =
			started > 0 && visibleWidth(head) + counts.length + 4 <= width ? `${theme.fg("muted", counts)}${rule("─")}` : "";
		return `${head}${rule("─".repeat(Math.max(0, width - visibleWidth(head) - visibleWidth(tail))))}${tail}`;
	}

	/** The job list, then a rule with the selected job's outcome, then its last output lines, wrapped to the width. */
	private body(width: number, height: number): string[] {
		const listHeight = Math.min(this.rows.length, Math.max(1, Math.floor(height / 3)));
		const index = this.selectedIndex();
		if (index < this.top) this.top = index;
		if (index >= this.top + listHeight) this.top = index - listHeight + 1;
		this.top = Math.max(0, Math.min(this.top, this.rows.length - listHeight));
		this.list = { top: 1, height: listHeight };
		const lines = this.rows
			.slice(this.top, this.top + listHeight)
			.map((row) => this.jobRow(row, width, row.id === this.selection.id));
		const selected = this.selected();
		if (selected) lines.push(this.outputRule(selected, width));
		const outputHeight = height - lines.length;
		const theme = this.options.theme;
		const output =
			this.output.length > 0
				? this.output
						.slice(-outputHeight)
						.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, Math.max(1, width - 1))))
						.slice(-outputHeight)
						.map((line) => ` ${line}`)
				: [
						theme.fg(
							"muted",
							selected?.state === "running" || selected?.state === "stopping" ? " No output yet." : " No output.",
						),
					];
		lines.push(...output);
		while (lines.length < height) lines.push("");
		return lines;
	}

	private jobRow(row: JobRow, width: number, selected: boolean): string {
		const theme = this.options.theme;
		const dot = DOT[row.state];
		const word = row.word.padEnd(WORD_WIDTH);
		const elapsed = row.elapsed.padStart(ELAPSED_WIDTH);
		const marker = selected ? theme.fg("accent", "›") : " ";
		const text = `${theme.fg(dot.colour, dot.glyph)} ${theme.fg(dot.colour, word)}  ${theme.fg("muted", elapsed)}  ${selected ? theme.bold(row.command) : row.command}`;
		const line = fitLine(`${marker}${text}`, width);
		return selected ? theme.bg("selectedBg", line) : line;
	}

	private outputRule(row: JobRow, width: number): string {
		const theme = this.options.theme;
		const rule = (text: string) => theme.fg("borderMuted", text);
		const head = `${rule("─")}${theme.fg("muted", " Output ")}`;
		const outcome = outcomeText(row);
		const tail =
			outcome && visibleWidth(head) + visibleWidth(outcome) + 6 <= width
				? `${theme.fg("muted", ` ${outcome} `)}${rule("─")}`
				: "";
		return `${head}${rule("─".repeat(Math.max(0, width - visibleWidth(head) - visibleWidth(tail))))}${tail}`;
	}

	private keysRow(width: number, y: number): string {
		const theme = this.options.theme;
		const targets: KeyTarget[] = [];
		let text = "";
		let x = 1;
		for (const key of this.keys()) {
			const control = `${key.text} ${key.label}`;
			if (x + control.length > width) break;
			text += `${theme.fg("accent", key.text)} ${theme.fg("muted", key.label)}  `;
			if (key.key === "up/down") targets.push({ x, width: 1, key: "up" }, { x: x + 1, width: 1, key: "down" });
			else targets.push({ x, width: control.length, key: key.key });
			x += control.length + 2;
		}
		this.keyRow = { y, targets };
		return ` ${text}`;
	}
}

/** Refresh interval of an open view: elapsed times, states and output change while jobs run. */
export const REFRESH_MS = 1000;

/**
 * Shows the view in the editor slot below the transcript until Escape or `close` ends it. The editor and its draft
 * return when it closes. Returns a function that closes the view, for session shutdown.
 */
export function openJobsView(
	ui: { custom: ExtensionUIContext["custom"] },
	source: JobsSource,
	selected: { id?: string },
	onClose?: () => void,
): { closed: Promise<void>; close: () => void } {
	let finish: (() => void) | undefined;
	let closedEarly = false;
	const closed = ui
		.custom<void>((tui, theme, _keybindings, done) => {
			let timer: ReturnType<typeof setInterval> | undefined;
			const end = () => {
				if (timer !== undefined) clearInterval(timer);
				timer = undefined;
				done(undefined);
			};
			finish = end;
			const view = new JobsView({
				source,
				theme,
				selected,
				rows: () => viewRows(tui.terminal.rows),
				requestRender: () => tui.requestRender(),
				close: end,
			});
			timer = setInterval(() => {
				view.refresh();
				tui.requestRender();
			}, REFRESH_MS);
			timer.unref?.();
			if (closedEarly) queueMicrotask(end);
			return Object.assign(view, { dispose: () => timer !== undefined && clearInterval(timer) });
		})
		.finally(() => onClose?.());
	return {
		closed,
		close: () => {
			if (finish) finish();
			else closedEarly = true;
		},
	};
}
