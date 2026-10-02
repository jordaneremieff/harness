import { basename } from "node:path";
import type { ExtensionContext, KeybindingsManager, SessionEntry, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Keybinding, type TUI } from "@earendil-works/pi-tui";
import type { AgentSessionSummary } from "./command.ts";
import type { DetachedRunView } from "./detached.ts";
import type { SessionDigest } from "./dashboard-data.ts";
import { AgentConversation, cleanDashboardText, type ConversationDocument } from "./dashboard-conversation.ts";
import { AgentMessageEditor } from "./dashboard-composer.ts";

export interface AgentObservationSources {
	sessions(): Promise<AgentSessionSummary[]>;
	runs(): Promise<DetachedRunView[]>;
	board(): Promise<SessionDigest[]>;
	conversation(sessionId: string): Promise<{ entries: SessionEntry[]; partial: boolean; revision: string }>;
}
export type DashboardTarget = { kind: "session"; session: AgentSessionSummary } | { kind: "run"; run: DetachedRunView };
export interface AgentDashboardSnapshot { observedAt: number; sessions: SessionDigest[]; error?: string }
interface ConversationView {
	follow: boolean;
	scroll: number;
	anchor?: { id: string; offset: number };
	messageLimit: number;
	expanded: boolean;
	showThinking: boolean;
}
export interface DashboardState {
	snapshot?: AgentDashboardSnapshot;
	selected?: string;
	filter: string;
	focus?: "sessions" | "conversation";
	views: Map<string, ConversationView>;
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
/** Recovery detail for a live local worker; an absent report is not a health verdict. */
function recoveryLines(row: SessionDigest, skipRetry = false): Array<{ color: ThemeColor; text: string }> {
	const health = row.health;
	if (!health) return [];
	const lines: Array<{ color: ThemeColor; text: string }> = [];
	if (health.lastError) lines.push({ color: "error", text: `Last worker error: ${oneLine(health.lastError)}` });
	if (health.compactionFailure) {
		const failure = health.compactionFailure;
		lines.push({ color: "warning", text: `Last compaction failure (${failure.reason}) at ${failure.at}: ${oneLine(failure.errorMessage ?? "no error text")}` });
	}
	if (!skipRetry && health.autoRetry) lines.push({ color: "warning", text: `provider retry ${health.autoRetry.attempt}/${health.autoRetry.maxAttempts} after ${elapsed(health.autoRetry.delayMs)}: ${oneLine(health.autoRetry.errorMessage)}` });
	return lines;
}
function healthMark(row: SessionDigest, theme: Theme): string {
	const health = row.health;
	if (!health) return "";
	if (health.lastError) return theme.fg("error", "!");
	if (health.compactionFailure) return theme.fg("warning", "!");
	if (health.autoRetry) return theme.fg("accent", "↻");
	return "";
}
function stateLabel(row: SessionDigest): string {
	return `${sessionAppearance[row.state].label}${row.owner === "window" ? " · other window" : row.owner === "detached" ? " · detached" : row.owner === "here" ? " · here" : ""}`;
}
function sectionOf(row: SessionDigest, now: number): string {
	if (row.state === "working") return "Working";
	if (row.state === "unavailable") return "Attention";
	if (row.health?.lastError || row.health?.compactionFailure) return "Attention";
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
		...recoveryLines(row).map((line) => `  ${oneLine(line.text)}`),
		...(row.latestReply ? [`  ${oneLine(row.latestReply).slice(0, 300)}`] : []),
	]), "Use /agent help for actions."].join("\n");
}

/** View state spans native action dialogs; only the selected transcript stays loaded. */
export class AgentDashboard implements Component {
	readonly state: DashboardState;
	private readonly input = new Input({ prompt: "Find › " });
	private editor: AgentMessageEditor;
	private hostFocused = false;
	private inputMode?: "filter" | "message" | "new";
	private filterBefore = "";
	private selectionBefore?: string;
	private focusBefore: "sessions" | "conversation" = "sessions";
	private composerId?: string;
	private editingHidden = false;
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
	private viewport = 1;
	private history?: { id: string; entries: SessionEntry[]; partial: boolean; revision: string };
	private historyError?: string;
	private historyGeneration = 0;
	private conversation?: AgentConversation;
	private document?: ConversationDocument;
	private conversationWidth?: number;
	private conversationStart = 0;
	private anchorPending = true;
	get focused(): boolean { return this.hostFocused; }
	set focused(value: boolean) {
		this.hostFocused = value;
		this.input.focused = value && !this.editingHidden && this.inputMode === "filter";
		this.editor.focused = value && !this.editingHidden && (this.inputMode === "message" || this.inputMode === "new");
	}
	private readonly sources: AgentObservationSources;
	private readonly tui: Pick<TUI, "requestRender" | "terminal">;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (request?: ActionRequest) => void;
	private readonly actions?: DashboardActions;
	constructor(sources: AgentObservationSources, tui: Pick<TUI, "requestRender" | "terminal">, theme: Theme, keys: KeybindingsManager, done: (request?: ActionRequest) => void, state?: DashboardState, actions?: DashboardActions) {
		this.sources = sources; this.tui = tui; this.theme = theme; this.keys = keys; this.done = done; this.actions = actions;
		this.state = state ?? { filter: "", views: new Map(), drafts: new Map() };
		this.state.focus ??= "sessions";
		this.editor = new AgentMessageEditor(tui as TUI, theme, (text) => { void this.submit(text); });
		this.input.onSubmit = () => this.finishInput();
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
	private selected(): SessionDigest | undefined { return this.state.snapshot?.sessions.find((row) => row.sessionId === this.state.selected); }
	private view(): ConversationView | undefined {
		const id = this.state.selected; if (!id) return undefined;
		let view = this.state.views.get(id);
		if (!view) { view = { follow: true, scroll: 0, messageLimit: 80, expanded: false, showThinking: false }; this.state.views.set(id, view); }
		return view;
	}
	private select(id: string | undefined): boolean {
		if (id === this.state.selected) return false;
		this.rememberAnchor();
		this.state.selected = id;
		this.historyGeneration++;
		this.history = undefined; this.historyError = undefined; this.conversation = undefined; this.document = undefined; this.conversationWidth = undefined;
		this.anchorPending = true;
		return true;
	}
	private selectValid(): boolean {
		if (this.submitting || this.inputMode === "message" || this.inputMode === "new") return false;
		const rows = this.rows();
		return !rows.some((row) => row.sessionId === this.state.selected) && this.select(rows[0]?.sessionId);
	}
	async refresh(): Promise<void> {
		if (this.closed || this.refreshPaused || this.refreshing) return;
		this.refreshing = true;
		try {
			const snapshot = await readAgentDashboard(this.sources);
			if (this.closed || this.refreshPaused) return;
			this.state.snapshot = snapshot;
			this.selectValid();
			await this.readConversation();
		} finally { this.refreshing = false; this.redraw(); }
	}
	private rememberAnchor(): void {
		const view = this.view();
		if (!view || this.anchorPending || this.history?.id !== this.state.selected || !this.document) return;
		if (view.follow) { view.anchor = undefined; return; }
		const anchor = this.document.anchors.findLast((item) => item.line <= view.scroll);
		if (anchor) view.anchor = { id: anchor.id, offset: view.scroll - anchor.line };
	}
	private async readConversation(): Promise<void> {
		const id = this.state.selected;
		if (!id || this.refreshPaused) return;
		const generation = ++this.historyGeneration;
		try {
			const data = await this.sources.conversation(id);
			if (this.closed || this.refreshPaused || generation !== this.historyGeneration || id !== this.state.selected) return;
			this.historyError = undefined;
			if (this.history?.id === id && this.history.revision === data.revision) return;
			this.rememberAnchor(); this.anchorPending = true;
			this.history = { id, ...data }; this.conversation = undefined;
		} catch (error) { if (!this.closed && !this.refreshPaused && generation === this.historyGeneration && id === this.state.selected) this.historyError = errorText(error); }
		this.redraw();
	}
	private move(delta: number): void {
		if (this.submitting) return;
		const rows = this.rows(); const index = rows.findIndex((row) => row.sessionId === this.state.selected);
		const next = Math.max(0, Math.min(rows.length - 1, index + delta));
		if (this.select(rows[next]?.sessionId)) void this.readConversation();
	}
	private compose(create = false): void {
		if (!this.actions?.compose || this.submitting) return;
		const row = this.selected(); if (!create && !row) return;
		const refusal = !create && row ? this.refusal(row) : undefined;
		if (refusal) { this.state.notice = refusal; this.redraw(); return; }
		if (!create) this.state.focus = "conversation";
		this.inputMode = create ? "new" : "message"; this.composerId = create ? undefined : row?.sessionId;
		this.editor = new AgentMessageEditor(this.tui as TUI, this.theme, (text) => { void this.submit(text); });
		this.editor.setText(this.state.drafts.get(this.composerId ?? "new") ?? ""); this.focused = this.hostFocused;
	}
	private refusal(row: SessionDigest): string | undefined {
		if (row.owner === "window") return `Open in ${oneLine(row.ownerLabel || "another Pi window")} · ${basename(row.cwd)}`;
		if (row.state === "unavailable" || row.owner === "unknown") return `${sessionAppearance[row.state].label}: ${oneLine(row.error || row.ownerLabel || "session control is unavailable")}`;
		return undefined;
	}
	private saveDraft(): void {
		if (!this.submitting && (this.inputMode === "message" || this.inputMode === "new")) this.state.drafts.set(this.composerId ?? "new", this.editor.getText());
	}
	private finishInput(): void { this.inputMode = undefined; this.focused = this.hostFocused; this.redraw(); }
	private async submissionMode(create: boolean, id?: string): Promise<"new" | "send" | "steer"> {
		if (create) return "new";
		const row = (await this.sources.board()).find((item) => item.sessionId === id);
		if (!row) throw new Error("Session is no longer available");
		const refusal = this.refusal(row); if (refusal) throw new Error(refusal);
		return row.state === "working" ? "steer" : "send";
	}
	private async submit(text: string): Promise<void> {
		if (this.submitting || !this.actions?.compose) return;
		const create = this.inputMode === "new"; const id = this.composerId;
		if (!text.trim()) { this.editor.setText(this.state.drafts.get(id ?? "new") ?? ""); return; }
		// Native Editor clears before its callback. Keep the submitted value, not that cleared state.
		this.state.drafts.set(id ?? "new", text); this.editor.setText(text);
		this.submitting = true; this.state.notice = "Send in progress…"; this.redraw();
		try {
			const mode = await this.submissionMode(create, id);
			if (this.closed) return;
			const receipt = await this.actions.compose(mode, id, text);
			if (this.closed) return;
			this.state.drafts.delete(id ?? "new"); this.editor.setText(""); this.finishInput();
			this.state.notice = receipt || "Action returned no receipt";
			await this.refresh();
		} catch (error) {
			if (!this.closed) { this.editor.setText(text); this.state.notice = `Refused: ${errorText(error)}`; }
		} finally { this.submitting = false; this.redraw(); }
	}
	private editInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.inputMode === "filter") {
				this.state.filter = this.filterBefore;
				this.state.focus = this.focusBefore;
				this.select(this.selectionBefore); this.selectValid(); void this.readConversation();
			} else this.saveDraft();
			this.finishInput(); return;
		}
		if (this.submitting || this.editingHidden) return;
		if (this.inputMode === "filter") {
			this.input.handleInput(data);
			this.state.filter = this.input.getValue();
			if (this.selectValid()) void this.readConversation();
		} else { this.editor.handleInput(data); this.saveDraft(); }
	}
	private back(): void {
		if (this.help) this.help = false;
		else if (this.state.actionResult !== undefined) this.state.actionResult = undefined;
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
	private focusInput(data: string): boolean {
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.state.focus = this.state.focus === "sessions" ? "conversation" : "sessions"; return true;
		}
		if (this.state.focus === "sessions" && this.keys.matches(data, "tui.select.confirm")) {
			if (this.selected()) this.state.focus = "conversation";
			return true;
		}
		if (this.state.focus === "conversation" && matchesKey(data, "enter")) { this.compose(); return true; }
		return false;
	}
	private commonInput(data: string): boolean {
		if (this.focusInput(data)) return true;
		switch (data) {
			case "[": this.move(-1); return true;
			case "]": this.move(1); return true;
			case "?": this.help = true; this.helpScroll = 0; return true;
			case "m": this.compose(); return true;
			case "n": this.compose(true); return true;
			case "r": void this.refresh(); return true;
			case "/":
				if (!this.submitting) { this.filterBefore = this.state.filter; this.selectionBefore = this.state.selected; this.focusBefore = this.state.focus ?? "sessions"; this.state.focus = "sessions"; this.inputMode = "filter"; this.input.setValue(this.state.filter); this.focused = this.hostFocused; }
				return true;
			case "a": {
				if (!this.actions || this.submitting) return true;
				const row = this.selected(); this.dispose(); this.done({ target: row ? { kind: "session", session: row } : undefined }); return true;
			}
			default: return false;
		}
	}
	private sessionInput(data: string): void {
		const rows = this.rows();
		const index = rows.findIndex((row) => row.sessionId === this.state.selected);
		if (matchesKey(data, "home")) this.move(-index);
		else if (matchesKey(data, "end")) this.move(rows.length - 1 - index);
		else this.move(this.delta(data, this.viewport));
	}
	private conversationInput(data: string): void {
		const view = this.view(); if (!view) return;
		if (this.keys.matches(data, "app.tools.expand") || data === "x") { this.rememberAnchor(); this.anchorPending = true; view.expanded = !view.expanded; this.conversation = undefined; }
		else if (this.keys.matches(data, "app.thinking.toggle")) { this.rememberAnchor(); this.anchorPending = true; view.showThinking = !view.showThinking; this.conversation = undefined; }
		else if (data === "o") { this.rememberAnchor(); this.anchorPending = true; view.messageLimit += 80; this.conversation = undefined; }
		else if (matchesKey(data, "end")) { view.follow = true; view.anchor = undefined; this.anchorPending = false; }
		else if (this.delta(data, this.viewport) || matchesKey(data, "home")) {
			view.follow = false; this.anchorPending = false;
			const last = Math.max(0, (this.document?.lines.length ?? 0) - 1);
			view.scroll = matchesKey(data, "home") ? 0 : Math.max(0, Math.min(last, view.scroll + this.delta(data, this.viewport)));
			this.rememberAnchor();
		}
	}
	handleInput(data: string): void {
		if (this.closed) return;
		this.renderRequestedAt = undefined; this.resumeRefresh();
		if (this.inputMode) this.editInput(data);
		else if (matchesKey(data, "escape")) this.back();
		else if (this.help) this.helpScroll = Math.max(0, this.helpScroll + this.delta(data, this.viewport));
		else if (this.state.actionResult !== undefined) this.resultScroll = this.scrollTo(data, this.resultScroll, this.resultLength);
		else if (!this.commonInput(data)) {
			if (this.state.focus === "sessions") this.sessionInput(data);
			else this.conversationInput(data);
		}
		this.redraw();
	}
	private hints(width: number): string[] {
		const row = this.selected();
		let hints = [`Tab ${this.state.focus === "sessions" ? "conversation" : "sessions"}`, "/ find", "a actions", ...(row && !this.refusal(row) ? ["m message"] : []), "n new", "? help", "Esc close"];
		if (this.inputMode === "filter") hints = ["Enter keep filter", "Esc cancel"];
		else if (this.inputMode) hints = [`${this.keys.getKeys("tui.input.submit").join("/") || "Enter"} send`, `${this.keys.getKeys("tui.input.newLine").join("/") || "Ctrl+J"} newline`, "Esc keep draft"];
		else if (this.help || this.state.actionResult !== undefined) hints = ["↑↓ scroll", "PgUp/PgDn page", "Esc back"];
		const lines: string[] = [];
		for (const hint of hints) {
			const last = lines.length - 1;
			if (last >= 0 && visibleWidth(`${lines[last]} · ${hint}`) <= width) lines[last] += ` · ${hint}`;
			else lines.push(truncateToWidth(hint, width));
		}
		return lines.map((line) => this.theme.fg("muted", line));
	}
	private navigationHeading(): string {
		if (this.help) return "Controls and observation boundaries";
		if (this.state.actionResult !== undefined) return "Action result · Esc returns to the board";
		if (this.inputMode === "filter") return "Find sessions · type a name, task, place or ID";
		if (this.inputMode) return "Message draft";
		return this.state.focus === "sessions" ? this.sessionNavigation() : "Conversation · ↑↓ scroll";
	}
	private sessionNavigation(): string {
		const label = (action: Keybinding) => this.keys.getKeys(action).slice(0, 1).map((key) => key === "up" ? "↑" : key === "down" ? "↓" : key === "enter" ? "Enter" : key).join("/");
		const navigation = [label("tui.select.up"), label("tui.select.down")].filter(Boolean);
		const select = navigation.length ? navigation.join(navigation.join("") === "↑↓" ? "" : "/") : "j/k";
		const confirm = label("tui.select.confirm");
		return `Sessions · ${select} select${confirm ? ` · ${confirm} read` : ""}`;
	}
	private content(width: number, height: number): string[] {
		if (this.help) return this.renderHelp(width, height);
		if (this.state.actionResult !== undefined) return this.renderResult(width, height);
		return this.renderWorkspace(width, height);
	}
	private inputLines(width: number): string[] {
		const lines: string[] = [];
		if (this.state.notice) lines.push(this.theme.fg("warning", truncateToWidth(oneLine(this.state.notice), width)));
		if (this.inputMode === "filter") lines.push(...this.input.render(width));
		else if (this.inputMode) lines.push(this.theme.fg("accent", truncateToWidth(this.composerHeading(width), width)), ...this.editor.render(width));
		return lines;
	}
	private composerHeading(width: number): string {
		if (this.inputMode === "new") return "New agent · task";
		const row = this.state.snapshot?.sessions.find((item) => item.sessionId === this.composerId);
		const prefix = row?.state === "working" ? "Steer" : "Send to";
		const title = row ? this.rosterTitles(this.rows(), Math.max(1, width - prefix.length - 1)).get(row.sessionId) ?? titleOf(row) : this.composerId ?? "session";
		return `${prefix} ${title}`;
	}
	render(width: number): string[] {
		this.renderRequestedAt = undefined; this.resumeRefresh();
		width = Math.max(1, width);
		const height = Math.max(1, this.tui.terminal.rows - 2);
		this.editingHidden = false; this.focused = this.hostFocused;
		const small = () => {
			this.editingHidden = true; this.focused = this.hostFocused;
			return [truncateToWidth(this.inputMode ? "Resize to edit · Esc keeps draft" : `Agents · ${this.rows().length} sessions · Esc close`, width)];
		};
		if (height < 6 || width < 24) return small();
		const inner = width - 4;
		const hints = this.hints(inner);
		const extras = this.inputLines(inner);
		const available = height - 4 - hints.length;
		if (available < 1 || (this.inputMode && extras.length >= available)) return small();
		const shownExtras = extras.slice(0, Math.max(0, available - 1));
		const contentHeight = available - shownExtras.length;
		this.viewport = contentHeight;
		const heading = this.state.actionResult !== undefined ? "Action result" : `Agents  ${totals(this.state.snapshot)}`;
		const rendered = this.content(inner, contentHeight);
		const content = Array.from({ length: contentHeight }, (_, index) => rendered[index] ?? "");
		const border = (left: string, right: string) => this.theme.fg("borderMuted", left + "─".repeat(width - 2) + right);
		const frame = (line: string) => `${this.theme.fg("borderMuted", "│")} ${pad(line, inner)} ${this.theme.fg("borderMuted", "│")}`;
		return [border("╭", "╮"), frame(this.theme.bold(heading)), frame(this.theme.fg("accent", this.navigationHeading())), ...content.map(frame), ...shownExtras.map(frame), ...hints.map(frame), border("╰", "╯")];
	}
	private renderWorkspace(width: number, height: number): string[] {
		const rows = this.rows(); const selected = this.selected();
		if (this.state.snapshot?.error) return [this.theme.fg("error", "Store unavailable"), ...wrapTextWithAnsi(cleanDashboardText(this.state.snapshot.error), width), "r retries"];
		if (!rows.length || !selected) return [this.state.snapshot ? this.state.filter ? `No sessions match “${oneLine(this.state.filter)}”` : "No agent sessions yet. Press n to start one." : "Read in progress…"];
		const split = width >= 116;
		if (!split) {
			if (this.state.focus === "sessions" && this.inputMode !== "message" && this.inputMode !== "new") return this.renderRoster(rows, width, height);
			return [this.selector(rows, selected, width), ...this.renderConversation(width, Math.max(1, height - 1), false)];
		}
		const railWidth = 32;
		const roster = this.renderRoster(rows, railWidth, height);
		const conversation = this.renderConversation(width - railWidth - 3, height, true);
		if (this.state.focus === "sessions") this.viewport = Math.max(1, height - 1);
		return Array.from({ length: height }, (_, index) => `${pad(roster[index] ?? "", railWidth)} ${this.theme.fg("borderMuted", "│")} ${conversation[index] ?? ""}`);
	}
	private rosterTitles(rows: SessionDigest[], width: number): Map<string, string> {
		const groups = new Map<string, SessionDigest[]>();
		for (const row of this.state.snapshot?.sessions ?? rows) {
			const key = truncateToWidth(titleOf(row), width);
			const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
		}
		const titles = new Map<string, string>();
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			for (const row of group) {
				let length = Math.min(6, row.sessionId.length);
				while (length < row.sessionId.length && group.some((other) => other.sessionId !== row.sessionId && other.sessionId.slice(-length) === row.sessionId.slice(-length))) length++;
				const suffix = row.sessionId.slice(-length);
				const title = truncateToWidth(titleOf(row), Math.max(0, width - 1 - visibleWidth(suffix)));
				titles.set(row.sessionId, `${title} ${suffix}`.trimStart());
			}
		}
		return titles;
	}
	private selector(rows: SessionDigest[], row: SessionDigest, width: number): string {
		const position = `${rows.findIndex((item) => item.sessionId === row.sessionId) + 1}/${rows.length}${this.state.filter ? ` of ${this.state.snapshot?.sessions.length ?? 0}` : ""}`;
		const titleWidth = Math.max(1, width - visibleWidth(position) - 4);
		const title = this.rosterTitles(rows, titleWidth).get(row.sessionId) ?? titleOf(row);
		return `${this.theme.fg(sessionAppearance[row.state].color, sessionAppearance[row.state].glyph)} ${pad(title, titleWidth)}  ${position}`;
	}
	private rosterEntries(rows: SessionDigest[]): Array<{ row?: SessionDigest; text?: string }> {
		const entries: Array<{ row?: SessionDigest; text?: string }> = [];
		let section = "";
		for (const row of rows) {
			const next = sectionOf(row, this.state.snapshot?.observedAt ?? Date.now());
			if (next !== section) { section = next; entries.push({ text: next }); }
			entries.push({ row });
		}
		return entries;
	}
	private rosterRow(row: SessionDigest, width: number, title: string): string {
		const selected = row.sessionId === this.state.selected; const appearance = sessionAppearance[row.state];
		const mark = healthMark(row, this.theme);
		const line = `${selected ? "›" : " "}${this.theme.fg(appearance.color, appearance.glyph)} ${pad(title, Math.max(0, width - 3 - visibleWidth(mark)))}${mark}`;
		return selected ? this.theme.bg("selectedBg", line) : line;
	}
	private renderRoster(rows: SessionDigest[], width: number, height: number): string[] {
		const entries = this.rosterEntries(rows);
		const selectedIndex = entries.findIndex((entry) => entry.row?.sessionId === this.state.selected);
		const headerHeight = height >= 4 ? 1 : 0;
		const pageSize = Math.max(1, height - headerHeight);
		const start = Math.min(Math.max(0, entries.length - pageSize), Math.max(0, selectedIndex - Math.floor(pageSize / 2)));
		const filter = this.state.filter ? `${rows.length} of ${this.state.snapshot?.sessions.length ?? 0} · ${oneLine(this.state.filter)}` : `${rows.length} sessions`;
		const lines = headerHeight ? [this.theme.fg("dim", truncateToWidth(`${filter}${start > 0 ? " · ↑" : ""}${start + pageSize < entries.length ? " · ↓" : ""}`, width))] : [];
		const titles = this.rosterTitles(rows, width - 4);
		for (const entry of entries.slice(start, start + pageSize)) {
			if (!entry.row) { lines.push(this.theme.fg("accent", ` ${entry.text}`)); continue; }
			lines.push(this.rosterRow(entry.row, width, titles.get(entry.row.sessionId) ?? titleOf(entry.row)));
		}
		return lines;
	}
	/** The title yields width first so the follow marker, state and cost stay visible. */
	private conversationHeading(width: number, withTitle: boolean): string {
		const row = this.selected(); const view = this.view();
		const marker = view?.follow ? "TAIL" : "BROWSE";
		const detail = row ? ` · ${stateLabel(row)} · ${costOf(row)}` : "";
		const title = withTitle ? `${this.theme.bold(truncateToWidth(row ? titleOf(row) : "Conversation", Math.max(1, width - 2 - visibleWidth(marker) - visibleWidth(detail))))}  ` : "";
		return `${title}${this.theme.fg("muted", marker)}${detail}`;
	}
	private conversationHeader(width: number, height: number, withTitle: boolean): string[] {
		const row = this.selected();
		const header = [this.conversationHeading(width, withTitle)];
		if (row && this.refusal(row)) header.push(this.theme.fg("warning", truncateToWidth(`Read-only: ${this.refusal(row)}`, width)));
		if (row && height >= 10) header.push(this.theme.fg("muted", truncateToWidth(oneLine(`${basename(row.cwd)} · ${row.model ? `${row.model.modelId} ${row.model.thinkingLevel ?? "off"}` : "model unknown"}`), width)));
		if (row && height >= 18) header.push(this.theme.fg("dim", truncateToWidth(activityOf(row, this.state.snapshot?.observedAt ?? Date.now()), width)));
		if (row) header.push(...this.conversationStatusLines(row, width));
		return header;
	}
	/** The state slot carries current work or an in-progress retry; recovery lines follow separately. */
	private conversationStatusLines(row: SessionDigest, width: number): string[] {
		const lines: string[] = [];
		const retry = row.health?.autoRetry;
		if (row.state === "working") {
			const text = retry ? `provider retry ${retry.attempt}/${retry.maxAttempts} after ${elapsed(retry.delayMs)}: ${oneLine(retry.errorMessage)}` : row.currentTool ? `› ${oneLine(row.currentTool.name)} ${oneLine(row.currentTool.argument)}` : "› Thinking";
			lines.push(this.theme.fg(retry ? "warning" : "accent", truncateToWidth(text, width)));
		} else if (row.error) {
			lines.push(this.theme.fg("error", truncateToWidth(oneLine(row.error), width)));
		}
		for (const line of recoveryLines(row, row.state === "working")) lines.push(this.theme.fg(line.color, truncateToWidth(line.text, width)));
		return lines;
	}
	private conversationDocument(meaningful: SessionEntry[], view: ConversationView, width: number): { document: ConversationDocument; start: number } {
		let start = Math.max(0, meaningful.length - view.messageLimit);
		if (!view.follow && view.anchor) {
			const anchored = meaningful.findIndex((entry) => entry.id === view.anchor?.id || view.anchor?.id.startsWith(`${entry.id}:`));
			if (anchored >= 0) start = Math.min(start, anchored);
		}
		const measure = Math.min(112, width);
		if (this.conversationWidth !== undefined && this.conversationWidth !== measure) { this.rememberAnchor(); this.anchorPending = true; }
		if (!this.conversation) {
			this.conversation = new AgentConversation(meaningful.slice(start), this.selected()?.cwd ?? ".", this.tui as TUI, view.expanded, view.showThinking);
			this.conversationStart = start;
		}
		this.conversationWidth = measure;
		this.document = this.conversation.render(measure);
		return { document: this.document, start: this.conversationStart };
	}
	private renderConversation(width: number, height: number, withTitle: boolean): string[] {
		const header = this.conversationHeader(width, height, withTitle); const view = this.view();
		if (this.historyError) return [...header, this.theme.fg("error", "Conversation unavailable"), ...wrapTextWithAnsi(cleanDashboardText(this.historyError), width), "r retries"];
		if (!this.history || !view) return [...header, "Read in progress…"];
		const meaningful = this.history.entries.filter((entry) => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type));
		const { document, start } = this.conversationDocument(meaningful, view, width);
		this.viewport = Math.max(1, height - header.length - 1);
		if (this.anchorPending && !view.follow && view.anchor) {
			const anchor = document.anchors.find((item) => item.id === view.anchor?.id);
			if (anchor) view.scroll = anchor.line + view.anchor.offset;
		}
		this.anchorPending = false;
		view.scroll = view.follow ? Math.max(0, document.lines.length - this.viewport) : Math.max(0, Math.min(view.scroll, document.lines.length - 1));
		this.rememberAnchor();
		const top = `${start ? `${start} earlier messages · o loads more` : "Start of conversation"}${this.history.partial ? " · partial file capture" : ""}`;
		const gutter = " ".repeat(Math.min(3, Math.floor((width - Math.min(112, width)) / 2)));
		const content = document.lines.slice(view.scroll, view.scroll + this.viewport).map((line) => gutter + line);
		return [...header, this.theme.fg("dim", `${top} · ${view.scroll + (document.lines.length ? 1 : 0)}–${Math.min(document.lines.length, view.scroll + this.viewport)} / ${document.lines.length}`), ...(content.length ? content : ["No conversation messages yet."])];
	}
	private renderResult(width: number, height: number): string[] {
		const lines = wrapTextWithAnsi(cleanDashboardText(this.state.actionResult ?? ""), width);
		this.resultLength = lines.length;
		this.resultScroll = Math.min(this.resultScroll, Math.max(0, lines.length - height));
		return lines.slice(this.resultScroll, this.resultScroll + height);
	}
	private renderHelp(width: number, height: number): string[] {
		const lines = ["Agent conversations", "", this.sessionNavigation(), "Sessions is selected when the board opens. The selection keys above or j/k select a session. The configured confirmation key reads it; Tab also switches between Sessions and Conversation. A wide terminal previews the selected conversation beside the list. A narrow terminal shows the focused area.", "In Conversation, ↑↓ or j/k scrolls. Page Up/Down or b/Space pages the focused area. Home/End selects the first/last session or starts/follows the conversation. o loads earlier messages in Conversation. [ and ] selects sessions from either area.", "/ searches name, task, place, model, state or ID and focuses Sessions. Enter keeps the filter and shows the matches; Escape restores the previous filter, selection and focus.", "m opens the selected session's draft from either area. Enter opens a draft only in Conversation. The native editor submits with its configured submit key and inserts newlines with its configured newline key. Escape hides the editor and retains the draft. n drafts a task for a new agent.", "The recipient stays fixed while the editor is open or a submission is in progress. A fresh ownership check selects send for an idle agent or steer for active work. A refused submission retains the draft.", "a opens all native actions. Actions retain their trust and ownership checks. Escape returns from help or a result; otherwise it closes the dashboard.", `${this.keys.getKeys("app.tools.expand").join("/") || "x"} or x expands tools and summaries. ${this.keys.getKeys("app.thinking.toggle").join("/") || "configured thinking key"} shows thinking.`, "", "Sessions this Pi window runs also show the worker's last error, its last failed compaction, and an in-progress provider retry. A later successful compaction clears the failure, the retry's end clears the retry, and the next operation start clears the last error. Stored sessions, sessions owned by another window or a detached run, and primaries do not gain these fields; no warning on those rows is not a health check. The transcript error stays separate from these worker fields.", "", "Each visited session keeps its reading position, follow mode, loaded-message limit, expansion, thinking visibility and draft for this open dashboard, including native action dialogs. The board also retains its focused area through dialogs and resize. Closing the dashboard ends that state.", "", "State", ...Object.values(sessionAppearance).map((appearance) => `${appearance.glyph} ${appearance.label}`), "", "A live local writer claim identifies another Pi window. A pending transcript turn with that claim shows Working. PID reuse and remote hosts limit this observation.", "A same-host claim whose process no longer exists leaves the transcript outcome in force; the next control through this window replaces that claim. The dashboard never removes claims or opens sessions for writing. Another window requires control in that window.", "Spend sums retained native usage across branches. ≥ marks partial captures. Long files retain bounded identity metadata and a conversation tail; ancestry gaps remain partial. The conversation shows stored messages, not unsaved streaming tokens. Images appear as labels; each text field has a display bound.", "Attention holds Unavailable sessions regardless of age, a worker's last error or last failed compaction at any transcript age, and Failed, Stopped and Interrupted outcomes from the last 24 hours. Older outcomes retain their state in date groups.", "Refresh runs once per second while this overlay is visible. Only changed files are parsed. Refresh pauses when Pi leaves a render request unperformed for five seconds. A later render or key resumes it."];
		const wrapped = lines.flatMap((line) => wrapTextWithAnsi(line, width));
		this.helpScroll = Math.min(this.helpScroll, Math.max(0, wrapped.length - height));
		return wrapped.slice(this.helpScroll, this.helpScroll + height);
	}
	invalidate(): void { this.rememberAnchor(); this.anchorPending = true; this.input.invalidate(); this.editor.invalidate(); this.conversation?.invalidate(); }
	dispose(): void { this.rememberAnchor(); this.saveDraft(); this.closed = true; this.pauseRefresh(); this.historyGeneration++; this.input.focused = false; this.editor.focused = false; }
}

export async function showAgentDashboard(sources: AgentObservationSources, ctx: ExtensionContext, actions?: DashboardActions): Promise<void> {
	if (ctx.mode !== "tui") {
		const text = dashboardText(await readAgentDashboard(sources));
		if (ctx.hasUI) ctx.ui.notify(text, "info"); else process.stderr.write(`${text}\n`);
		return;
	}
	const state: DashboardState = { filter: "", views: new Map(), drafts: new Map() };
	for (;;) {
		const request = await ctx.ui.custom<ActionRequest | undefined>((tui, theme, keys, done) => new AgentDashboard(sources, tui, theme, keys, done, state, actions), {
			overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } },
		});
		if (!request || !actions) return;
		try { const result = await actions.run(request.target); if (result !== undefined) state.actionResult = result; }
		catch (error) { state.actionResult = `Refused: ${errorText(error)}`; }
	}
}
