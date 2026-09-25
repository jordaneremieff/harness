import { basename } from "node:path";
import type { ExtensionContext, KeybindingsManager, SessionEntry, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentSessionSummary } from "./command.ts";
import type { DetachedRunView } from "./detached.ts";
import type { SessionDigest } from "./dashboard-data.ts";
import { AgentConversation, cleanDashboardText, type ConversationDocument } from "./dashboard-conversation.ts";

export interface AgentObservationSources {
	sessions(): Promise<AgentSessionSummary[]>;
	runs(): Promise<DetachedRunView[]>;
	board(): Promise<SessionDigest[]>;
	conversation(sessionId: string): Promise<{ entries: SessionEntry[]; partial: boolean; revision: string }>;
}
export type DashboardTarget = { kind: "session"; session: AgentSessionSummary } | { kind: "run"; run: DetachedRunView };
export interface AgentDashboardSnapshot { observedAt: number; sessions: SessionDigest[]; error?: string }
export interface DashboardState {
	snapshot?: AgentDashboardSnapshot;
	selected?: string;
	filter: string;
	conversation?: string;
	drafts: Map<string, string>;
	notice?: string;
	actionResult?: string;
}
export interface DashboardActions {
	run(target: DashboardTarget | undefined): Promise<string | undefined>;
	compose?(mode: "send" | "steer" | "new", sessionId: string | undefined, text: string): Promise<string | undefined>;
}
interface ActionRequest { target?: DashboardTarget }
type StateAppearance = { label: string; glyph: string; color: ThemeColor };
export const sessionAppearance: Record<SessionDigest["state"], StateAppearance> = {
	working: { label: "Working", glyph: "●", color: "accent" },
	idle: { label: "Idle", glyph: "○", color: "muted" },
	done: { label: "Done", glyph: "✓", color: "success" },
	failed: { label: "Failed", glyph: "!", color: "error" },
	stopped: { label: "Stopped", glyph: "■", color: "warning" },
	interrupted: { label: "Interrupted", glyph: "↯", color: "warning" },
	new: { label: "New", glyph: "·", color: "dim" },
	orphaned: { label: "Orphaned", glyph: "⊗", color: "error" },
	unavailable: { label: "Unavailable", glyph: "?", color: "error" },
};
const oneLine = (text: string) => cleanDashboardText(text).replace(/\s+/g, " ").trim();
const titleOf = (row: SessionDigest) => oneLine(row.name || row.firstMessage || basename(row.cwd) || row.sessionId);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const pad = (text: string, width: number) => { const clipped = truncateToWidth(text, Math.max(0, width)); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))); };
export function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m` : `${Math.floor(seconds / 86400)}d`;
}
function costOf(row: SessionDigest): string { return `${row.partial ? "≥" : ""}$${row.cost.toFixed(2)}`; }
function activityOf(row: SessionDigest, now: number): string {
	const parts = [`${row.toolCalls} tool calls`, `active ${elapsed(now - row.modifiedAt)} ago`];
	if (row.durationMs !== undefined) parts.unshift(`${elapsed(row.durationMs)} duration`);
	return parts.join(" · ");
}
function stateLabel(row: SessionDigest): string {
	return `${sessionAppearance[row.state].label}${row.owner === "window" ? " · other window" : row.owner === "detached" ? " · detached" : row.owner === "here" ? " · here" : ""}`;
}
function sectionOf(row: SessionDigest, now: number): string {
	if (row.state === "working") return "Working";
	if (row.state === "orphaned" || row.state === "unavailable") return "Attention";
	if (now - row.modifiedAt <= 24 * 60 * 60 * 1000 && ["failed", "stopped", "interrupted"].includes(row.state)) return "Attention";
	const today = new Date(now); today.setHours(0, 0, 0, 0);
	const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
	return row.modifiedAt >= today.getTime() ? "Today" : row.modifiedAt >= yesterday.getTime() ? "Yesterday" : "Earlier";
}
export function dashboardRecords(snapshot: AgentDashboardSnapshot | undefined, filter: string): SessionDigest[] {
	const terms = oneLine(filter).toLocaleLowerCase().split(" ").filter(Boolean);
	const sections = ["Working", "Attention", "Today", "Yesterday", "Earlier"];
	return (snapshot?.sessions ?? []).filter((row) => {
		const text = `${titleOf(row)} ${row.firstMessage ?? ""} ${row.cwd} ${row.sessionId} ${stateLabel(row)} ${row.model?.provider ?? ""} ${row.model?.modelId ?? ""} ${row.model?.thinkingLevel ?? ""}`.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	}).sort((a, b) => sections.indexOf(sectionOf(a, snapshot?.observedAt ?? Date.now())) - sections.indexOf(sectionOf(b, snapshot?.observedAt ?? Date.now())) || b.modifiedAt - a.modifiedAt || a.sessionId.localeCompare(b.sessionId));
}
export async function readAgentDashboard(sources: Pick<AgentObservationSources, "board">): Promise<AgentDashboardSnapshot> {
	try { return { observedAt: Date.now(), sessions: await sources.board() }; }
	catch (error) { return { observedAt: Date.now(), sessions: [], error: errorText(error) }; }
}
function totals(snapshot: AgentDashboardSnapshot | undefined): string {
	const rows = snapshot?.sessions ?? [];
	const working = rows.filter((row) => row.state === "working").length;
	const attention = rows.filter((row) => sectionOf(row, snapshot?.observedAt ?? Date.now()) === "Attention").length;
	return `${working} working${attention ? ` · ${attention} need attention` : ""} · ${rows.some((row) => row.partial) ? "≥" : ""}$${rows.reduce((sum, row) => sum + row.cost, 0).toFixed(2)} spent`;
}
export function dashboardText(snapshot: AgentDashboardSnapshot): string {
	return ["Agent dashboard", totals(snapshot), ...(snapshot.error ? [`Store unavailable: ${snapshot.error}`] : []), ...dashboardRecords(snapshot, "").flatMap((row) => [
		oneLine(`${sessionAppearance[row.state].glyph} ${stateLabel(row)} · ${titleOf(row)} · ${basename(row.cwd)} · ${row.model?.modelId ?? "unknown model"} · ${costOf(row)}`),
		`  ${oneLine(row.sessionId)} · ${oneLine(row.cwd)}`,
		...(row.latestReply ? [`  ${oneLine(row.latestReply).slice(0, 300)}`] : []),
	]), "Use /agent help for actions."].join("\n");
}

/** One overlay owns its refresh clock, selected conversation, native input and render caches. */
export class AgentDashboard implements Component {
	readonly state: DashboardState;
	private readonly input = new Input({ prompt: "› " });
	private hostFocused = false;
	private inputMode?: "filter" | "message" | "new";
	private filterBefore = "";
	private composerId?: string;
	private closed = false;
	private refreshing = false;
	private submitting = false;
	private timer?: ReturnType<typeof setInterval>;
	private refreshPaused = false;
	private renderRequestedAt?: number;
	private help = false;
	private helpScroll = 0;
	private resultScroll = 0;
	private resultLength = 0;
	private pageSize = 1;
	private viewport = 1;
	private scroll = 0;
	private follow = true;
	private expanded = false;
	private showThinking = false;
	private messageLimit = 80;
	private history?: { id: string; entries: SessionEntry[]; partial: boolean; revision: string };
	private historyError?: string;
	private historyGeneration = 0;
	private conversation?: AgentConversation;
	private document?: ConversationDocument;
	private conversationWidth?: number;
	private pendingAnchor?: { id: string; offset: number };
	private preview?: { text: string; component: Markdown };
	get focused(): boolean { return this.hostFocused; }
	set focused(value: boolean) { this.hostFocused = value; this.input.focused = value && this.inputMode !== undefined; }
	private readonly sources: AgentObservationSources;
	private readonly tui: Pick<TUI, "requestRender" | "terminal">;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (request?: ActionRequest) => void;
	private readonly actions?: DashboardActions;
	constructor(sources: AgentObservationSources, tui: Pick<TUI, "requestRender" | "terminal">, theme: Theme, keys: KeybindingsManager, done: (request?: ActionRequest) => void, state?: DashboardState, actions?: DashboardActions) {
		this.sources = sources; this.tui = tui; this.theme = theme; this.keys = keys; this.done = done; this.actions = actions;
		this.state = state ?? { filter: "", drafts: new Map() };
		this.input.onSubmit = () => { if (this.inputMode === "filter") this.finishInput(); else void this.submit(); };
		this.resumeRefresh();
		void this.refresh();
	}
	private resumeRefresh(): void {
		if (this.closed) return;
		this.refreshPaused = false;
		if (this.timer) return;
		this.timer = setInterval(() => {
			// A render request that Pi does not perform bounds work for hidden overlays.
			if (this.renderRequestedAt !== undefined && Date.now() - this.renderRequestedAt >= 5000) { this.pauseRefresh(); return; }
			this.redraw();
			void this.refresh();
		}, 1000);
		this.timer.unref?.();
	}
	private pauseRefresh(): void {
		this.refreshPaused = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
	private redraw(): void {
		if (this.closed || this.refreshPaused) return;
		this.renderRequestedAt ??= Date.now();
		this.tui.requestRender();
	}
	private rows(): SessionDigest[] { return dashboardRecords(this.state.snapshot, this.state.filter); }
	private selected(): SessionDigest | undefined { return this.rows().find((row) => row.sessionId === this.state.selected); }
	private selectValid(): void {
		const rows = this.rows();
		if (!rows.some((row) => row.sessionId === this.state.selected)) this.state.selected = rows[0]?.sessionId;
	}
	async refresh(): Promise<void> {
		if (this.closed || this.refreshPaused || this.refreshing) return;
		this.refreshing = true;
		try {
			const snapshot = await readAgentDashboard(this.sources);
			if (this.closed || this.refreshPaused) return;
			this.state.snapshot = snapshot;
			this.selectValid();
			if (this.state.conversation) await this.readConversation();
		} finally { this.refreshing = false; this.redraw(); }
	}
	private rememberAnchor(): void {
		if (this.follow || !this.document) return;
		const anchor = this.document.anchors.findLast((item) => item.line <= this.scroll);
		if (anchor) this.pendingAnchor = { id: anchor.id, offset: this.scroll - anchor.line };
	}
	private async readConversation(): Promise<void> {
		const id = this.state.conversation;
		if (!id || this.refreshPaused) return;
		const generation = ++this.historyGeneration;
		try {
			const data = await this.sources.conversation(id);
			if (this.closed || this.refreshPaused || generation !== this.historyGeneration || id !== this.state.conversation) return;
			this.historyError = undefined;
			if (this.history?.id === id && this.history.revision === data.revision) return;
			this.rememberAnchor(); this.history = { id, ...data }; this.conversation = undefined;
		} catch (error) { if (!this.closed && !this.refreshPaused && generation === this.historyGeneration) this.historyError = errorText(error); }
		this.redraw();
	}
	private openConversation(): void {
		const row = this.selected(); if (!row) return;
		this.state.conversation = row.sessionId; this.follow = true; this.scroll = 0; this.messageLimit = 80;
		this.history = undefined; this.conversation = undefined; this.document = undefined; this.historyError = undefined;
		void this.readConversation(); this.redraw();
	}
	private move(delta: number, edge?: "first" | "last"): void {
		const rows = this.rows(); const index = rows.findIndex((row) => row.sessionId === this.state.selected);
		const next = edge === "first" ? 0 : edge === "last" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + delta));
		this.state.selected = rows[next]?.sessionId; this.redraw();
	}
	private compose(create = false): void {
		if (!this.actions?.compose || this.submitting) return;
		const row = this.selected(); if (!create && !row) return;
		const refusal = !create && row ? this.refusal(row) : undefined;
		if (refusal) { this.state.notice = refusal; this.redraw(); return; }
		this.inputMode = create ? "new" : "message"; this.composerId = create ? undefined : row?.sessionId;
		this.input.setValue(this.state.drafts.get(this.composerId ?? "new") ?? ""); this.focused = this.hostFocused; this.redraw();
	}
	private refusal(row: SessionDigest): string | undefined {
		if (row.owner === "window") return `Open in ${oneLine(row.ownerLabel || "another Pi window")} · ${basename(row.cwd)}`;
		if (["orphaned", "unavailable"].includes(row.state) || row.owner === "unknown") return `${sessionAppearance[row.state].label}: ${oneLine(row.error || row.ownerLabel || "session control is unavailable")}`;
		return undefined;
	}
	private finishInput(): void { this.inputMode = undefined; this.focused = this.hostFocused; this.redraw(); }
	private async submissionMode(create: boolean, id?: string): Promise<"new" | "send" | "steer"> {
		if (create) return "new";
		const row = (await this.sources.board()).find((item) => item.sessionId === id);
		if (!row) throw new Error("Session is no longer available");
		const refusal = this.refusal(row); if (refusal) throw new Error(refusal);
		return row.state === "working" ? "steer" : "send";
	}
	private async submit(): Promise<void> {
		if (this.submitting || !this.actions?.compose) return;
		const text = this.input.getValue().trim(); if (!text) return;
		const create = this.inputMode === "new"; const id = this.composerId;
		this.submitting = true; this.state.notice = "Send in progress…"; this.redraw();
		try {
			const mode = await this.submissionMode(create, id);
			if (this.closed) return;
			const receipt = await this.actions.compose(mode, id, text);
			if (this.closed) return;
			this.state.drafts.delete(id ?? "new"); this.input.setValue(""); this.finishInput();
			this.state.notice = receipt || "Action returned no receipt";
			await this.refresh();
		} catch (error) { if (!this.closed) this.state.notice = `Refused: ${errorText(error)}`; }
		finally { this.submitting = false; this.redraw(); }
	}
	private editInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.inputMode === "filter") { this.state.filter = this.filterBefore; this.selectValid(); }
			this.finishInput(); return;
		}
		if (this.submitting) return;
		this.input.handleInput(data);
		if (this.inputMode === "filter") { this.state.filter = this.input.getValue(); this.selectValid(); }
		else if (this.inputMode) this.state.drafts.set(this.composerId ?? "new", this.input.getValue());
	}
	private back(): void {
		if (this.help) this.help = false;
		else if (this.state.actionResult !== undefined) this.state.actionResult = undefined;
		else if (this.state.conversation) { this.state.conversation = undefined; this.historyGeneration++; this.history = undefined; this.conversation = undefined; this.document = undefined; }
		else { this.dispose(); this.done(); }
	}
	private delta(data: string, page: number): number {
		if (data === "k" || this.keys.matches(data, "tui.select.up")) return -1;
		if (data === "j" || this.keys.matches(data, "tui.select.down")) return 1;
		if (matchesKey(data, "pageUp") || data === "b") return -page;
		if (matchesKey(data, "pageDown") || data === " ") return page;
		return 0;
	}
	private scrollTo(data: string, current: number, length: number): number {
		const next = matchesKey(data, "home") ? 0 : matchesKey(data, "end") ? length : current + this.delta(data, this.viewport);
		return Math.max(0, Math.min(Math.max(0, length - this.viewport), next));
	}
	private commonInput(data: string): boolean {
		switch (data) {
			case "?": this.help = true; this.helpScroll = 0; return true;
			case "m": this.compose(); return true;
			case "n": this.compose(true); return true;
			case "r": void this.refresh(); return true;
			case "a": {
				if (!this.actions || this.submitting) return true;
				const row = this.selected(); this.dispose(); this.done({ target: row ? { kind: "session", session: row } : undefined }); return true;
			}
			default: return false;
		}
	}
	private conversationInput(data: string): void {
		if (this.keys.matches(data, "app.tools.expand") || data === "x") { this.rememberAnchor(); this.expanded = !this.expanded; this.conversation = undefined; }
		else if (this.keys.matches(data, "app.thinking.toggle")) { this.rememberAnchor(); this.showThinking = !this.showThinking; this.conversation = undefined; }
		else if (data === "o") { this.rememberAnchor(); this.messageLimit += 80; this.conversation = undefined; }
		else if (matchesKey(data, "end")) this.follow = true;
		else if (this.delta(data, this.viewport) || matchesKey(data, "home")) {
			this.follow = false; this.pendingAnchor = undefined;
			this.scroll = this.scrollTo(data, this.scroll, this.document?.lines.length ?? 0);
		}
	}
	private boardInput(data: string): void {
		if (data === "/") { this.filterBefore = this.state.filter; this.inputMode = "filter"; this.input.setValue(this.state.filter); this.focused = this.hostFocused; }
		else if (matchesKey(data, "enter")) this.openConversation();
		else if (matchesKey(data, "home")) this.move(0, "first");
		else if (matchesKey(data, "end")) this.move(0, "last");
		else if (this.delta(data, this.pageSize)) this.move(this.delta(data, this.pageSize));
	}
	handleInput(data: string): void {
		if (this.closed) return;
		this.renderRequestedAt = undefined; this.resumeRefresh();
		if (this.inputMode) this.editInput(data);
		else if (matchesKey(data, "escape")) this.back();
		else if (this.help) this.helpScroll = Math.max(0, this.helpScroll + this.delta(data, this.viewport));
		else if (this.state.actionResult !== undefined) this.resultScroll = this.scrollTo(data, this.resultScroll, this.resultLength);
		else if (!this.commonInput(data)) {
			if (this.state.conversation) this.conversationInput(data); else this.boardInput(data);
		}
		this.redraw();
	}
	private hint(width: number): string {
		const back = this.inputMode ? "Esc cancel" : this.help || this.state.actionResult !== undefined || this.state.conversation ? "Esc back" : "Esc close";
		const hints = this.inputMode ? ["Enter send"] : this.help || this.state.actionResult !== undefined ? ["↑↓ scroll", "PgUp/PgDn page"] : this.state.conversation ? ["↑↓ scroll", "End tail", "m message", "x tools", "o earlier", "a actions", "? help"] : ["↑↓ select", "Enter chat", "/ find", "m message", "a actions", "? help"];
		if (this.inputMode === "filter") hints[0] = "Enter keep filter";
		while (hints.length && visibleWidth([...hints, back].join(" · ")) > width) hints.pop();
		return this.theme.fg("muted", truncateToWidth([...hints, back].join(" · "), width));
	}
	private heading(): string {
		if (this.state.actionResult !== undefined) return this.theme.bold("Action result");
		if (this.state.conversation) return this.conversationHeading();
		return `${this.theme.bold("Agents")}  ${totals(this.state.snapshot)}`;
	}
	private content(width: number, height: number): string[] {
		if (this.help) return this.renderHelp(width, height);
		if (this.state.actionResult !== undefined) return this.renderResult(width, height);
		if (this.state.conversation) return this.renderConversation(width, height);
		return this.renderBoard(width, height);
	}
	private inputLines(width: number): string[] {
		const lines: string[] = [];
		if (this.state.notice) lines.push(this.theme.fg("warning", truncateToWidth(oneLine(this.state.notice), width)));
		if (!this.inputMode) return lines;
		if (this.inputMode !== "filter") lines.push(this.theme.fg("accent", truncateToWidth(this.composerHeading(), width)));
		lines.push(...this.input.render(width).slice(0, 1));
		return lines;
	}
	private composerHeading(): string {
		if (this.inputMode === "new") return "New agent · task";
		const row = this.state.snapshot?.sessions.find((item) => item.sessionId === this.composerId);
		return `${row?.state === "working" ? "Steer" : "Send to"} ${row ? titleOf(row) : "session"}`;
	}
	render(width: number): string[] {
		this.renderRequestedAt = undefined; this.resumeRefresh();
		width = Math.max(1, width);
		const height = Math.max(1, this.tui.terminal.rows - 2);
		if (height < 6 || width < 24) return [truncateToWidth(`Agents · ${this.rows().length} sessions · Esc close`, width)];
		const inner = width - 4;
		const footer = this.hint(inner);
		const extraHeight = Math.max(0, height - 6);
		const extras = extraHeight ? this.inputLines(inner).slice(-extraHeight) : [];
		const contentHeight = Math.max(1, height - 5 - extras.length);
		this.viewport = contentHeight;
		const summary = this.heading();
		const rendered = this.content(inner, contentHeight);
		const content = Array.from({ length: contentHeight }, (_, index) => rendered[index] ?? "");
		const border = (left: string, right: string) => this.theme.fg("borderMuted", left + "─".repeat(width - 2) + right);
		const frame = (line: string) => `${this.theme.fg("borderMuted", "│")} ${pad(line, inner)} ${this.theme.fg("borderMuted", "│")}`;
		return [border("╭", "╮"), frame(summary), frame(""), ...content.map(frame), ...extras.map(frame), frame(footer), border("╰", "╯")];
	}
	private renderBoard(width: number, height: number): string[] {
		const rows = this.rows(); const selected = this.selected();
		if (this.state.snapshot?.error) return [this.theme.fg("error", "Store unavailable"), ...wrapTextWithAnsi(cleanDashboardText(this.state.snapshot.error), width), "r retries"];
		if (!rows.length) return [this.state.snapshot ? this.state.filter ? `No sessions match “${oneLine(this.state.filter)}”` : "No agent sessions yet. Press n to start one." : "Read in progress…"];
		const split = width >= 136;
		const leftWidth = split ? Math.min(108, Math.floor(width * 0.54)) : width;
		const listHeight = split ? height : Math.min(height, Math.max(3, height - Math.max(4, Math.floor(height * 0.43)) - 1));
		const previewHeight = split ? height : Math.max(0, height - listHeight - 1);
		const roster = this.renderRoster(rows, leftWidth, listHeight);
		if (!previewHeight) return roster;
		const preview = selected ? this.renderPreview(selected, split ? width - leftWidth - 3 : width, previewHeight) : [];
		if (split) return Array.from({ length: height }, (_, index) => `${pad(roster[index] ?? "", leftWidth)} ${this.theme.fg("borderMuted", "│")} ${preview[index] ?? ""}`);
		return [...roster, this.theme.fg("borderMuted", "─".repeat(width)), ...preview];
	}
	private columns(width: number): { title: number; place: number; model: number; cost: number; age: number } {
		const place = width >= 64 ? 12 : 0; const model = width >= 72 ? 19 : width >= 56 ? 15 : 0;
		const cost = 9; const age = width >= 48 ? 7 : 0;
		return { title: Math.max(8, width - 3 - place - model - cost - age), place, model, cost, age };
	}
	private rosterTitles(rows: SessionDigest[], width: number): Map<string, string> {
		const cols = this.columns(width);
		const groups = new Map<string, SessionDigest[]>();
		for (const row of this.state.snapshot?.sessions ?? rows) {
			const key = JSON.stringify([truncateToWidth(titleOf(row), cols.title - 1), cols.place ? truncateToWidth(oneLine(basename(row.cwd)), cols.place - 1) : ""]);
			const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
		}
		const titles = new Map<string, string>();
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			for (const row of group) {
				let length = Math.min(6, row.sessionId.length);
				while (length < row.sessionId.length && group.some((other) => other.sessionId !== row.sessionId && other.sessionId.slice(-length) === row.sessionId.slice(-length))) length++;
				const suffix = row.sessionId.slice(-length);
				const title = truncateToWidth(titleOf(row), Math.max(0, cols.title - 2 - visibleWidth(suffix)));
				titles.set(row.sessionId, `${title} ${suffix}`.trimStart());
			}
		}
		return titles;
	}
	private rosterRow(row: SessionDigest, width: number, title: string): string {
		const cols = this.columns(width);
		const cell = (text: string, size: number) => size ? `${pad(oneLine(text), size - 1)} ` : "";
		const selected = row.sessionId === this.state.selected;
		const appearance = sessionAppearance[row.state];
		const level = row.model?.thinkingLevel ?? "off";
		const short = ({ xhigh: "xh", high: "hi", medium: "med", low: "lo", minimal: "min" } as Record<string, string>)[level] ?? level;
		const model = row.model ? `${row.model.modelId}${level !== "off" ? ` ${short}` : ""}` : "—";
		const line = `${selected ? "›" : " "}${this.theme.fg(appearance.color, appearance.glyph)} ${cell(title, cols.title)}${this.theme.fg("muted", cell(basename(row.cwd), cols.place))}${this.theme.fg("muted", cell(model, cols.model))}${cell(costOf(row), cols.cost)}${this.theme.fg("dim", cell(elapsed((this.state.snapshot?.observedAt ?? Date.now()) - row.modifiedAt), cols.age))}`;
		return selected ? this.theme.bg("selectedBg", pad(line, width)) : line;
	}
	private renderRoster(rows: SessionDigest[], width: number, height: number): string[] {
		const cols = this.columns(width);
		const cell = (text: string, size: number) => size ? `${pad(text, size - 1)} ` : "";
		const header = `   ${cell("SESSION", cols.title)}${cell("PLACE", cols.place)}${cell("MODEL", cols.model)}${cell("COST", cols.cost)}${cell("AGE", cols.age)}`;
		const entries: Array<{ row?: SessionDigest; text?: string }> = [];
		let section = "";
		for (const row of rows) {
			const next = sectionOf(row, this.state.snapshot?.observedAt ?? Date.now());
			if (next !== section) { section = next; entries.push({ text: next }); }
			entries.push({ row });
		}
		const selectedIndex = entries.findIndex((entry) => entry.row?.sessionId === this.state.selected);
		const headerHeight = height >= 6 ? 2 : height >= 4 ? 1 : 0;
		this.pageSize = Math.max(1, height - headerHeight);
		const start = Math.min(Math.max(0, entries.length - this.pageSize), Math.max(0, selectedIndex - Math.floor(this.pageSize / 2)));
		const filter = this.state.filter ? `“${oneLine(this.state.filter)}” · ${rows.length} of ${this.state.snapshot?.sessions.length ?? 0}` : `${rows.length} sessions`;
		const lines = [this.theme.fg("dim", `${filter}${start > 0 ? " · ↑ more" : ""}${start + this.pageSize < entries.length ? " · ↓ more" : ""}`), this.theme.fg("muted", header)].slice(0, headerHeight);
		const titles = this.rosterTitles(rows, width);
		for (const entry of entries.slice(start, start + this.pageSize)) {
			if (!entry.row) { lines.push(this.theme.fg("accent", ` ${entry.text}`)); continue; }
			lines.push(this.rosterRow(entry.row, width, titles.get(entry.row.sessionId) ?? titleOf(entry.row)));
		}
		return Array.from({ length: height }, (_, index) => lines[index] ?? "");
	}
	private renderPreview(row: SessionDigest, width: number, height: number): string[] {
		const appearance = sessionAppearance[row.state];
		const status = `${stateLabel(row)} · ${basename(row.cwd)} · ${row.model ? `${row.model.modelId} ${row.model.thinkingLevel}` : "model unknown"} · ${costOf(row)}`;
		const header = [...(height > 4 ? [this.theme.bold(truncateToWidth(titleOf(row), width))] : []), this.theme.fg(appearance.color, truncateToWidth(oneLine(status), width))];
		if (height > 13) header.push(this.theme.fg("dim", activityOf(row, this.state.snapshot?.observedAt ?? Date.now())));
		if (row.state === "working") header.push(this.theme.fg("accent", truncateToWidth(row.currentTool ? `› ${oneLine(row.currentTool.name)} ${oneLine(row.currentTool.argument)}` : "› Thinking", width)));
		else if (row.error) header.push(this.theme.fg("error", truncateToWidth(oneLine(row.error), width)));
		if (height > 4) header.push("");
		const text = row.latestReply || (row.state === "new" ? "No reply yet. Press m to give this agent a task." : "No assistant reply in the available history.");
		if (this.preview?.text !== text) this.preview = { text, component: new Markdown(cleanDashboardText(text), 0, 0, getMarkdownTheme()) };
		const reply = this.preview.component.render(Math.max(1, Math.min(100, width)));
		const detail = height > 18 ? ["", this.theme.fg("dim", "TASK"), ...wrapTextWithAnsi(oneLine(row.firstMessage || "No task recorded"), width).slice(0, 2).map((line) => this.theme.fg("muted", line)), "", this.theme.fg("dim", truncateToWidth(oneLine(row.cwd), width)), this.theme.fg("dim", oneLine(row.sessionId))] : [];
		const budget = Math.max(1, height - header.length - detail.length);
		const body = reply.slice(0, budget);
		if (reply.length > budget) body[budget - 1] = this.theme.fg("dim", "… Enter reads the conversation");
		return [...header, ...Array.from({ length: budget }, (_, index) => body[index] ?? ""), ...detail].slice(0, height);
	}
	private conversationHeading(): string {
		const row = this.state.snapshot?.sessions.find((item) => item.sessionId === this.state.conversation);
		return `${this.theme.bold(row ? titleOf(row) : "Conversation")}  ${this.theme.fg("muted", this.follow ? "TAIL" : "BROWSE")}${row ? ` · ${stateLabel(row)} · ${costOf(row)}` : ""}`;
	}
	private renderConversation(width: number, height: number): string[] {
		if (this.historyError) return [this.theme.fg("error", "Conversation unavailable"), ...wrapTextWithAnsi(cleanDashboardText(this.historyError), width), "r retries"];
		if (!this.history) return ["Read in progress…"];
		const meaningful = this.history.entries.filter((entry) => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type));
		const start = Math.max(0, meaningful.length - this.messageLimit);
		const row = this.state.snapshot?.sessions.find((item) => item.sessionId === this.history?.id);
		const measure = Math.min(112, width);
		if (!this.conversation) this.conversation = new AgentConversation(meaningful.slice(start), row?.cwd ?? ".", this.tui as TUI, this.expanded, this.showThinking);
		if (this.conversationWidth !== undefined && this.conversationWidth !== measure && !this.pendingAnchor) this.rememberAnchor();
		this.conversationWidth = measure;
		this.document = this.conversation.render(measure);
		const top = `${start ? `${start} earlier messages · o loads more` : "Start of conversation"}${this.history.partial ? " · partial file capture" : ""}`;
		this.viewport = Math.max(1, height - 1);
		if (this.pendingAnchor && !this.follow) {
			const anchor = this.document.anchors.find((item) => item.id === this.pendingAnchor?.id);
			if (anchor) this.scroll = anchor.line + this.pendingAnchor.offset;
			this.pendingAnchor = undefined;
		}
		this.scroll = this.follow ? Math.max(0, this.document.lines.length - this.viewport) : Math.max(0, Math.min(this.scroll, this.document.lines.length - this.viewport));
		const gutter = " ".repeat(Math.min(3, Math.floor((width - measure) / 2)));
		const content = this.document.lines.slice(this.scroll, this.scroll + this.viewport).map((line) => gutter + line);
		return [this.theme.fg("dim", `${top} · ${this.scroll + (this.document.lines.length ? 1 : 0)}–${Math.min(this.document.lines.length, this.scroll + this.viewport)} / ${this.document.lines.length}`), ...(content.length ? content : ["No conversation messages yet."])];
	}
	private renderResult(width: number, height: number): string[] {
		const lines = wrapTextWithAnsi(cleanDashboardText(this.state.actionResult ?? ""), width);
		this.resultLength = lines.length;
		this.resultScroll = Math.min(this.resultScroll, Math.max(0, lines.length - height));
		return lines.slice(this.resultScroll, this.resultScroll + height);
	}
	private renderHelp(width: number, height: number): string[] {
		const lines = ["Agent board", "", "↑↓ or j/k selects a session. Page Up/Down moves a page. Home/End reaches either end.", "Enter opens the conversation. / searches name, task, place, model, state or ID. Enter keeps a filter; Escape cancels its edit.", "m opens a message. Enter sends to an idle agent or steers active work. Escape keeps the draft. n starts a new agent.", "a opens all native actions. Actions retain their trust and ownership checks.", "", "Conversation", "↑↓ scrolls. Page Up/Down or b/Space pages. Home starts; End follows new output. o loads earlier messages.", `${this.keys.getKeys("app.tools.expand").join("/") || "x"} or x expands tools and summaries. ${this.keys.getKeys("app.thinking.toggle").join("/") || "configured thinking key"} shows thinking.`, "", "State", ...Object.values(sessionAppearance).map((appearance) => `${appearance.glyph} ${appearance.label}`), "", "A live local writer claim identifies another Pi window. A pending transcript turn with that claim shows Working. PID reuse and remote hosts limit this observation.", "A dead writer claim shows Orphaned. The board never removes claims or opens sessions for writing. Another window requires control in that window.", "Spend sums retained native usage across branches. ≥ marks partial captures. Long files retain bounded identity metadata and a conversation tail; ancestry gaps remain partial. The conversation shows stored messages, not unsaved streaming tokens. Images appear as labels; each text field has a display bound.", "Attention holds unresolved Orphaned and Unavailable sessions regardless of age, plus Failed, Stopped and Interrupted outcomes from the last 24 hours. Older outcomes retain their state in date groups.", "Refresh runs once per second while this overlay is visible. Only changed files are parsed. Refresh pauses when Pi leaves a render request unperformed for five seconds. A later render or key resumes it. Escape returns or closes."];
		const wrapped = lines.flatMap((line) => wrapTextWithAnsi(line, width));
		this.helpScroll = Math.min(this.helpScroll, Math.max(0, wrapped.length - height));
		return wrapped.slice(this.helpScroll, this.helpScroll + height);
	}
	invalidate(): void { this.rememberAnchor(); this.input.invalidate(); this.preview?.component.invalidate(); this.conversation?.invalidate(); }
	dispose(): void { this.closed = true; this.pauseRefresh(); this.historyGeneration++; this.input.focused = false; }
}

export async function showAgentDashboard(sources: AgentObservationSources, ctx: ExtensionContext, actions?: DashboardActions): Promise<void> {
	if (ctx.mode !== "tui") {
		const text = dashboardText(await readAgentDashboard(sources));
		if (ctx.hasUI) ctx.ui.notify(text, "info"); else process.stderr.write(`${text}\n`);
		return;
	}
	const state: DashboardState = { filter: "", drafts: new Map() };
	for (;;) {
		const request = await ctx.ui.custom<ActionRequest | undefined>((tui, theme, keys, done) => new AgentDashboard(sources, tui, theme, keys, done, state, actions), {
			overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } },
		});
		if (!request || !actions) return;
		try { const result = await actions.run(request.target); if (result !== undefined) state.actionResult = result; }
		catch (error) { state.actionResult = `Refused: ${errorText(error)}`; }
	}
}
