/**
 * Peer window over the ordinary Pi screen: one navigation strip and two equal
 * panes, the real primary projected beside one selected Durable agent. The
 * overlay paints the full terminal but is not a constrained layout root, so
 * every pane renders exactly its allocated height and clips its viewport.
 * Escape returns to the unchanged native Pi editor; Close only removes a pane.
 */
import { basename } from "node:path";
import { getSelectListTheme, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import { AgentRoster, type AgentDashboardSnapshot } from "./dashboard.ts";
import { firstTaskEntry, renderableEntries } from "./dashboard-conversation.ts";
import type { AgentConversationEntry, AgentConversationSnapshot, AgentConversationSummary, AgentDashboardCoverage } from "./dashboard-types.ts";
import { agentDescriptor, createPeerWindowState, paneState, peerKey, type PeerAgentActions, type PeerAgentSource, type PeerActionResult, type PeerSlot, type PeerWindowState, type PrimaryObserver, type PeerTranscriptFactory } from "./peer-contract.ts";
import { agentConversationTranscripts, PeerPane } from "./peer-pane.ts";
import type { ConversationFrame } from "./live-frames.ts";
import { PeerTasksView } from "./peer-tasks.ts";
import { classifySubmit, committedEntryChoices, placementForNew, setSlot, slotOf, slotValue, type LocalCommand } from "./peer-actions.ts";

const SPACE = " ";
/** How long a transient strip status stays before it expires. */
const NOTICE_MS = 8000;
/** Strip hints in display order; the focus hints lead and the Esc hint ends the line. */
const STRIP_HINTS = ["F2 primary", "F3 agent", "F4 expand", "F6 All", "F7 new", "F8 tasks", "PgUp/PgDn scroll", "/help", "Esc Pi"];
/** Narrow terminals drop these first; the focus and Esc hints stay longest. */
const STRIP_DROP_ORDER = ["/help", "PgUp/PgDn scroll", "F8 tasks", "F7 new", "F6 All", "F4 expand"];

/** Content-sensitive key for the uncommitted tail, so streamed text rebuilds its view. */
function entrySignature(entry: AgentConversationEntry): string {
	const parts = (entry.model ?? []).map((message) => {
		if (typeof message.content === "string") return message.content.length;
		return message.content.reduce((sum, part) => {
			if (part.type === "text") return sum + part.text.length;
			if (part.type === "thinking") return sum + part.thinking.length;
			if (part.type === "toolCall") return sum + JSON.stringify(part.arguments ?? {}).length;
			return sum;
		}, 0);
	});
	return `${entry.id}:${entry.model?.length ?? 0}:${parts.join(".")}`;
}

function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	const visible = visibleWidth(line);
	if (visible > width) return truncateToWidth(line, width);
	return line + SPACE.repeat(width - visible);
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Agent data source plus the primary bridge and the operations other modules own. */
export interface PeerWindowHost {
	source: PeerAgentSource;
	primary: PrimaryObserver;
	actions: PeerAgentActions;
	/** Optional native action list for the focused agent, owned by the command layer. */
	runActions?: (target: AgentConversationSummary | undefined) => Promise<PeerActionResult | undefined>;
	cwd: string;
	sessionId: string;
	now(): number;
	transcriptFactory?: PeerTranscriptFactory;
	/** Bounded roster refresh; zero or less disables the timer. */
	refreshMs?: number;
}

export interface PeerWindowOptions {
	ctx: ExtensionContext;
	source: PeerAgentSource;
	primary: PrimaryObserver;
	actions: PeerAgentActions;
	runActions?: PeerWindowHost["runActions"];
	state?: PeerWindowState;
	initialAgentId?: string;
	transcriptFactory?: PeerTranscriptFactory;
	refreshMs?: number;
	now?: () => number;
}

/** Per-session window state that survives Close and reopen inside one process. */
export interface PeerWindowStore {
	state(sessionId: string): PeerWindowState;
}

export function createPeerWindowStore(): PeerWindowStore {
	const states = new Map<string, PeerWindowState>();
	return {
		state(sessionId: string): PeerWindowState {
			let state = states.get(sessionId);
			if (!state) {
				state = createPeerWindowState();
				states.set(sessionId, state);
			}
			return state;
		},
	};
}

export const peerWindowStore: PeerWindowStore = createPeerWindowStore();

interface DialogState {
	kind: "all" | "menu" | "prompt" | "help" | "tasks";
	title: string;
	lines?: string[];
	input?: Input;
	list?: SelectList;
	roster?: AgentRoster;
	tasks?: PeerTasksView;
	onPick?: (value: string) => void;
	onAccept?: (value: string) => void;
}

/** One agent's accumulated earlier pages plus the newest reading. */
interface EarlierState {
	/** Older committed pages, oldest first, prepended before the newest page. */
	entries: AgentConversationEntry[];
	/** Continuation bound after the oldest loaded entry; null when the first entry is loaded. */
	nextBefore: number | null;
	loading: boolean;
	startReached: boolean;
	error?: string;
	/** Entry count already applied to the pane, so a prepend can re-anchor once. */
	applied: number;
}

interface AgentCache {
	summary?: AgentConversationSummary;
	snapshot?: AgentConversationSnapshot & { nextBefore?: number | null };
	earlier?: EarlierState;
	error?: string;
}

export class PeerWindow implements Component {
	readonly state: PeerWindowState;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: () => void;
	private readonly host: PeerWindowHost;
	private readonly factory: PeerTranscriptFactory;
	private readonly readyPromise: Promise<void>;
	private readonly panes = new Map<string, PeerPane>();
	private readonly agents = new Map<string, AgentCache>();
	private rows: AgentConversationSummary[] = [];
	private coverage?: AgentDashboardCoverage;
	private rowsError?: string;
	private dialog?: DialogState;
	private closed = false;
	private refreshing = false;
	private actionRunning = false;
	private refreshTimer?: ReturnType<typeof setInterval>;
	private unsubscribe?: () => void;
	private primaryUnsubscribe?: () => void;
	private renderRequestedAt?: number;
	private lastBodyHeight = 12;
	private defaultAgentResolved = false;

	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, done: () => void, state: PeerWindowState, host: PeerWindowHost) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.state = state;
		this.host = host;
		this.factory = host.transcriptFactory ?? agentConversationTranscripts;
		this.readyPromise = this.refresh();
		this.scheduleRefresh();
		this.unsubscribe = host.source.subscribe?.(() => { void this.refresh(); });
		this.primaryUnsubscribe = host.primary.subscribe(() => this.requestRender());
	}

	/** Resolves after the first roster read settles; rendering never waits on it. */
	ready(): Promise<void> {
		return this.readyPromise;
	}

	// ----- lifecycle -----------------------------------------------------------------

	dispose(): void {
		if (this.closed) return;
		for (const pane of this.panes.values()) pane.saveDraft();
		this.dialog?.tasks?.dispose();
		this.closed = true;
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.primaryUnsubscribe?.();
		this.primaryUnsubscribe = undefined;
	}

	private finish(): void {
		this.dispose();
		this.done();
	}

	private pauseRefresh(): void {
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	private scheduleRefresh(): void {
		const ms = this.host.refreshMs ?? 1000;
		if (this.closed || ms <= 0 || this.refreshTimer) return;
		this.refreshTimer = setInterval(() => {
			if (this.renderRequestedAt !== undefined && this.host.now() - this.renderRequestedAt >= 5000) {
				this.pauseRefresh();
				return;
			}
			void this.refresh();
		}, ms);
		this.refreshTimer.unref?.();
	}

	private requestRender(): void {
		if (this.closed) return;
		this.renderRequestedAt = this.host.now();
		this.tui.requestRender();
	}

	/** Transient strip status; a new action replaces it and it expires after a short time. */
	private setNotice(text: string): void {
		this.state.notice = text;
		this.state.noticeAt = this.host.now();
	}

	/** Read the bounded roster and the visible agent transcripts again. */
	async refresh(): Promise<void> {
		if (this.closed || this.refreshing) return;
		this.refreshing = true;
		try {
			const page = await this.host.source.list();
			if (this.closed) return;
			this.rows = [...page.rows];
			this.coverage = page.coverage;
			this.rowsError = undefined;
			this.selectDefaultAgent();
			this.dialog?.roster?.setSnapshot(this.rosterSnapshot());
			await this.refreshSnapshots();
		} catch (error) {
			if (!this.closed) this.rowsError = errorText(error);
		} finally {
			this.refreshing = false;
			this.requestRender();
		}
	}

	/**
	 * On the first successful roster read, pair the primary with the working or
	 * most recent agent unless the operator already chose one. Close within this
	 * window stays closed; a later open resolves the pair again.
	 */
	private selectDefaultAgent(): void {
		if (this.defaultAgentResolved) return;
		this.defaultAgentResolved = true;
		const visible = this.state.left?.kind === "agent" ? this.state.left.id : this.state.right?.kind === "agent" ? this.state.right.id : undefined;
		if (visible) {
			this.state.selectedAgent = visible;
			return;
		}
		if (!this.rows.length) return;
		const remembered = this.state.selectedAgent && this.rows.some((row) => row.id === this.state.selectedAgent) ? this.state.selectedAgent : undefined;
		const chosen = remembered ?? this.rows.find((row) => row.state === "working")?.id ?? this.rows.slice().sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.id;
		if (!chosen) return;
		this.state.selectedAgent = chosen;
		if (!this.state.right) this.state.right = { kind: "agent", id: chosen };
		else if (!this.state.left) this.state.left = { kind: "agent", id: chosen };
	}

	private async refreshSnapshots(): Promise<void> {
		const ids = new Set<string>();
		for (const side of ["left", "right"] as const) {
			const slot = slotValue(this.state, side);
			if (slot?.kind === "agent") ids.add(slot.id);
		}
		await Promise.all([...ids].map(async (id) => {
			const cache = this.agents.get(id) ?? {};
			try {
				const snapshot = await this.host.source.snapshot(id);
				if (this.closed) return;
				cache.snapshot = snapshot;
				cache.error = undefined;
			} catch (error) {
				if (this.closed) return;
				cache.error = errorText(error);
			}
			cache.summary = this.rows.find((row) => row.id === id) ?? cache.summary;
			this.agents.set(id, cache);
		}));
	}

	/** Read the next earlier page for the focused agent pane, when the source pages. */
	private loadEarlierFocused(): void {
		const id = this.focusedAgentId();
		if (id && typeof this.host.source.earlier === "function") void this.loadEarlier(id);
	}

	/** One earlier committed page; a read in flight blocks a second read for the same agent. */
	private async loadEarlier(id: string): Promise<void> {
		const source = this.host.source;
		const read = source.earlier;
		if (typeof read !== "function") return;
		const cache = this.agents.get(id) ?? {};
		this.agents.set(id, cache);
		let earlier = cache.earlier;
		if (earlier === undefined) {
			earlier = { entries: [], nextBefore: null, loading: false, startReached: false, applied: 0 };
			cache.earlier = earlier;
		}
		if (earlier.loading || earlier.startReached) return;
		const frame = source.frame?.(id);
		const bound = earlier.entries.length > 0 ? earlier.nextBefore : (frame ? frame.nextBefore : cache.snapshot?.nextBefore ?? null);
		if (bound === null || bound === undefined) {
			earlier.startReached = true;
			this.requestRender();
			return;
		}
		earlier.loading = true;
		earlier.error = undefined;
		earlier.nextBefore = bound;
		this.requestRender();
		try {
			const page = await read.call(source, id, bound);
			if (this.closed) return;
			earlier.entries = [...page.entries, ...earlier.entries];
			earlier.nextBefore = page.nextBefore;
			earlier.startReached = page.nextBefore === null;
		} catch (error) {
			earlier.error = errorText(error);
		} finally {
			earlier.loading = false;
			this.requestRender();
		}
	}

	// ----- view sync -----------------------------------------------------------------

	private paneFor(slot: Exclude<PeerSlot, undefined>): PeerPane {
		const key = peerKey(slot);
		let pane = this.panes.get(key);
		if (!pane) {
			pane = new PeerPane({
				key,
				kind: slot.kind,
				tui: this.tui,
				theme: this.theme,
				keys: this.keys,
				factory: this.factory,
				state: paneState(this.state, key),
				onSubmit: (text) => this.submit(key, text),
				onEscape: () => { if (this.dialog) this.closeDialog(); else this.finish(); },
			});
			this.panes.set(key, pane);
		}
		return pane;
	}

	private syncPanes(): void {
		this.syncSlot("left");
		this.syncSlot("right");
		this.ensureFocusSide();
		this.applyFocus();
	}

	private syncSlot(side: "left" | "right"): void {
		const slot = slotValue(this.state, side);
		if (!slot) return;
		const pane = this.paneFor(slot);
		if (slot.kind === "primary") this.syncPrimaryPane(pane);
		else this.syncAgentPane(pane, slot.id);
	}

	private syncPrimaryPane(pane: PeerPane): void {
		const snapshot = this.host.primary.snapshot();
		const state = paneState(this.state, peerKey({ kind: "primary" }));
		pane.setDescriptor(snapshot.descriptor);
		pane.nativeDraftSaved = this.state.nativeDraftBefore !== undefined;
		pane.setContent({
			entries: renderableEntries(snapshot.entries),
			revision: snapshot.revision,
			live: renderableEntries(snapshot.live),
			liveRevision: snapshot.liveRevision,
			cwd: snapshot.descriptor.cwd,
			expanded: state.view.expanded,
			showThinking: state.view.showThinking,
		});
	}

	private syncAgentPane(pane: PeerPane, id: string): void {
		const state = paneState(this.state, peerKey({ kind: "agent", id }));
		const cache = this.agents.get(id) ?? {};
		const summary = this.rows.find((row) => row.id === id) ?? cache.summary;
		pane.nativeDraftSaved = false;
		pane.setDescriptor(summary ? agentDescriptor(summary) : { id, kind: "agent", name: id, cwd: this.host.cwd, state: "new" });
		const { frame, snapshot } = this.agentPaneReading(id, cache);
		const earlier = cache.earlier;
		const older = earlier?.entries ?? [];
		const entries = this.agentEntries(older, snapshot);
		const first = this.summaryFirstTask(snapshot, earlier, summary);
		const liveEntries = frame ? renderableEntries(frame.live) : [];
		this.applyEarlier(earlier, older, pane);
		pane.setContent({
			entries: first ? [first, ...entries] : entries,
			revision: `${snapshot?.revision ?? `loading:${id}`}|earlier:${older.length}:${earlier?.startReached ? 1 : 0}`,
			live: liveEntries,
			liveRevision: frame ? `live-${frame.revision}-${liveEntries.map(entrySignature).join(",")}` : "none",
			cwd: summary?.cwd ?? this.host.cwd,
			expanded: state.view.expanded,
			showThinking: state.view.showThinking,
		});
		pane.pagination = this.paginationText(earlier);
		pane.error = frame ? undefined : cache.error;
	}

	/** The summary block fills the gap only until the first real entry is loaded. */
	private summaryFirstTask(snapshot: (AgentConversationSnapshot & { nextBefore?: number | null }) | undefined, earlier: EarlierState | undefined, summary: AgentConversationSummary | undefined): AgentConversationEntry | undefined {
		if (!snapshot?.partial || (earlier?.startReached ?? false)) return undefined;
		return firstTaskEntry(snapshot, summary ?? {});
	}

	/** Re-anchor the viewport once after a prepend, so the reading position stays. */
	private applyEarlier(earlier: EarlierState | undefined, older: readonly AgentConversationEntry[], pane: PeerPane): void {
		if (!earlier || earlier.applied === older.length) return;
		earlier.applied = older.length;
		pane.reanchor();
	}

	/** Prefer the live frame; a cold agent falls back to the last read snapshot. */
	private agentPaneReading(id: string, cache: AgentCache): { frame: ConversationFrame | undefined; snapshot: (AgentConversationSnapshot & { nextBefore?: number | null }) | undefined } {
		const frame = this.host.source.frame?.(id);
		if (frame) return { frame, snapshot: { entries: frame.entries, partial: !frame.coverage.complete, revision: `live:${frame.revision}`, nextBefore: frame.nextBefore } };
		return { frame: undefined, snapshot: cache.snapshot };
	}

	/** Older pages first, then the newest page, with empty blocks removed. */
	private agentEntries(older: readonly AgentConversationEntry[], snapshot: { entries: readonly AgentConversationEntry[] } | undefined): AgentConversationEntry[] {
		return renderableEntries(snapshot ? [...older, ...snapshot.entries] : older);
	}

	/** Earlier-page status: in-flight reads, the reached start, and the exact continuation bound. */
	private paginationText(earlier: EarlierState | undefined): string | undefined {
		if (!earlier) return undefined;
		if (earlier.loading) return "Loading earlier entries…";
		if (earlier.error !== undefined) return `Earlier entries unavailable: ${earlier.error}`;
		if (earlier.startReached) return earlier.entries.length > 0 ? "Start of conversation · 0 earlier entries" : undefined;
		if (earlier.entries.length > 0 && earlier.nextBefore !== null) return `Earlier entries not loaded · continue before #${earlier.nextBefore}`;
		return undefined;
	}

	private ensureFocusSide(): void {
		if (!slotValue(this.state, this.state.focus)) this.state.focus = this.state.left ? "left" : "right";
	}

	private applyFocus(): void {
		for (const side of ["left", "right"] as const) {
			const slot = slotValue(this.state, side);
			if (!slot) continue;
			const pane = this.panes.get(peerKey(slot));
			if (!pane) continue;
			if (side === this.state.focus) pane.focus();
			else pane.blur();
		}
	}

	private focusedPane(): PeerPane | undefined {
		const slot = slotValue(this.state, this.state.focus);
		return slot ? this.panes.get(peerKey(slot)) : undefined;
	}

	private focusedAgentId(): string | undefined {
		const slot = slotValue(this.state, this.state.focus);
		return slot?.kind === "agent" ? slot.id : undefined;
	}

	private setFocus(side: "left" | "right"): void {
		if (this.state.focus === side) return;
		this.focusedPane()?.saveDraft();
		this.focusedPane()?.captureView();
		this.state.focus = side;
		this.requestRender();
	}

	// ----- rendering -----------------------------------------------------------------

	render(width: number): string[] {
		this.renderRequestedAt = undefined;
		this.scheduleRefresh();
		width = Math.max(1, Math.floor(width));
		const rows = Math.max(1, this.tui.terminal.rows);
		this.syncPanes();
		const strip = this.stripLine(width);
		const bodyHeight = Math.max(0, rows - 1);
		this.lastBodyHeight = bodyHeight;
		const body = this.dialog ? this.renderDialog(width, bodyHeight) : this.renderPanes(width, bodyHeight);
		const out = [strip, ...body];
		if (out.length > rows) out.length = rows;
		while (out.length < rows) out.push(SPACE.repeat(width));
		return out.map((line) => fitLine(line, width));
	}

	private stripLine(width: number): string {
		const hints = [...STRIP_HINTS];
		const age = this.host.now() - (this.state.noticeAt ?? this.host.now());
		let notice = age < NOTICE_MS ? this.state.notice : undefined;
		const build = (): string => {
			const parts = [`All ${this.rows.length}`, ...hints];
			if (this.rowsError) parts.push("store unavailable");
			else if (this.coverage && !this.coverage.complete) parts.push("coverage incomplete");
			if (notice) parts.push(notice);
			return `${this.theme.fg("accent", this.theme.bold("PEERS"))}  ${this.theme.fg("muted", parts.join(" · "))}`;
		};
		for (const hint of STRIP_DROP_ORDER) {
			if (visibleWidth(build()) <= width) break;
			const index = hints.indexOf(hint);
			if (index >= 0) hints.splice(index, 1);
		}
		if (notice && visibleWidth(build()) > width) notice = undefined;
		return fitLine(build(), width);
	}

	private renderPanes(width: number, height: number): string[] {
		const left = this.state.left;
		const right = this.state.right;
		if (!left && !right) return [fitLine(this.theme.fg("muted", "No panes open · /all opens the peer list"), width)];
		if (this.state.expanded) {
			const slot = this.state.expanded === "left" ? left : right;
			if (slot) return this.paneFor(slot).render(width, height);
		}
		if (left && right) return this.renderSplit(left, right, width, height);
		const only = left ?? right;
		return only ? this.paneFor(only).render(width, height) : [];
	}

	private renderSplit(left: Exclude<PeerSlot, undefined>, right: Exclude<PeerSlot, undefined>, width: number, height: number): string[] {
		const leftWidth = Math.max(1, Math.floor((width - 1) / 2));
		const rightWidth = Math.max(1, width - 1 - leftWidth);
		const leftLines = this.paneFor(left).render(leftWidth, height);
		const rightLines = this.paneFor(right).render(rightWidth, height);
		const separator = this.theme.fg("borderMuted", "│");
		return Array.from({ length: height }, (_, index) => fitLine(leftLines[index] ?? "", leftWidth) + separator + fitLine(rightLines[index] ?? "", rightWidth));
	}

	private renderDialog(width: number, height: number): string[] {
		const dialog = this.dialog;
		if (!dialog) return [];
		const lines: string[] = [fitLine(this.theme.fg("accent", this.theme.bold(truncateToWidth(dialog.title, width))), width)];
		if (dialog.tasks) {
			const remaining = height - lines.length;
			if (remaining > 0) lines.push(...dialog.tasks.render(width, remaining).map((line) => fitLine(line, width)));
		} else if (dialog.roster) {
			const remaining = height - lines.length;
			if (remaining > 0) lines.push(...dialog.roster.render(width, remaining).map((line) => fitLine(line, width)));
		} else {
			this.renderDialogBody(dialog, width, height, lines);
		}
		while (lines.length < height) lines.push(SPACE.repeat(width));
		return lines.slice(0, height);
	}

	private renderDialogBody(dialog: DialogState, width: number, height: number, lines: string[]): void {
		if (dialog.input) lines.push(...dialog.input.render(width));
		if (dialog.lines) {
			for (const line of dialog.lines.flatMap((line) => wrapTextWithAnsi(line, width))) lines.push(fitLine(this.theme.fg("muted", line), width));
		}
		const left = height - lines.length;
		if (dialog.list && left > 0) lines.push(...dialog.list.render(width).slice(0, left).map((line) => fitLine(line, width)));
	}

	// ----- input ---------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.closed) return;
		this.renderRequestedAt = undefined;
		this.scheduleRefresh();
		if (this.dialog) {
			this.dialogInput(data);
			this.requestRender();
			return;
		}
		this.syncPanes();
		if (this.handleShortcut(data)) return;
		this.focusedPane()?.composer.handleInput(data);
		this.requestRender();
	}

	/** Window-level keys that must stay reachable while a draft is in the editor. */
	private handleShortcut(data: string): boolean {
		if (this.handleFunctionKey(data)) return true;
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			const delta = Math.max(1, this.lastBodyHeight - 3);
			const pane = this.focusedPane();
			if (matchesKey(data, "pageUp")) {
				if (pane?.atTop()) this.loadEarlierFocused();
				else pane?.scrollLines(-delta);
			} else pane?.scrollLines(delta);
			this.requestRender();
			return true;
		}
		return false;
	}

	private handleFunctionKey(data: string): boolean {
		if (matchesKey(data, "f2") || matchesKey(data, "f3")) {
			this.focusCommand(matchesKey(data, "f2") ? "primary" : "agent");
			return true;
		}
		if (matchesKey(data, "f4")) {
			if (this.state.expanded) this.restoreSplit();
			else this.expandFocused();
			return true;
		}
		if (matchesKey(data, "f5")) {
			this.closeFocused();
			return true;
		}
		if (matchesKey(data, "f6")) {
			this.openAll();
			return true;
		}
		if (matchesKey(data, "f7")) {
			this.openPrompt("New agent · task (blank creates an idle agent)", "", (value) => void this.createAgent(value));
			return true;
		}
		if (matchesKey(data, "f8")) {
			this.openTasks();
			return true;
		}
		return false;
	}

	private dialogInput(data: string): void {
		const dialog = this.dialog;
		if (!dialog) return;
		if (dialog.tasks) {
			if (dialog.tasks.handleInput(data)) { this.requestRender(); return; }
			if (matchesKey(data, "escape")) this.closeDialog();
			return;
		}
		if (dialog.roster) {
			dialog.roster.handleInput(data);
			return;
		}
		if (dialog.kind === "help") {
			if (matchesKey(data, "escape")) this.closeDialog();
			return;
		}
		if (dialog.kind === "menu") {
			dialog.list?.handleInput(data);
			return;
		}
		if (dialog.kind === "prompt") {
			dialog.input?.handleInput(data);
			return;
		}
	}

	private closeDialog(): void {
		this.dialog?.tasks?.dispose();
		this.dialog = undefined;
		this.requestRender();
	}

	private openMenu(title: string, items: SelectItem[], onPick: (value: string) => void): void {
		const list = new SelectList(items, 8, getSelectListTheme());
		list.onSelect = (item) => { this.closeDialog(); onPick(String(item.value)); };
		list.onCancel = () => this.closeDialog();
		this.dialog = { kind: "menu", title, list, onPick };
		this.requestRender();
	}

	private openPrompt(title: string, initial: string, onAccept: (value: string) => void): void {
		const input = new Input({ prompt: "› " });
		input.setValue(initial);
		input.focused = true;
		input.onSubmit = (value) => { this.closeDialog(); onAccept(value); };
		input.onEscape = () => this.closeDialog();
		this.dialog = { kind: "prompt", title, input, onAccept };
		this.requestRender();
	}

	private openHelp(): void {
		const lines = [
			"Keys: F2 primary · F3 agent · F4 expand or restore · F5 close · F6 All · F7 new · F8 tasks · PgUp/PgDn scroll · Esc Pi.",
			"Slash forms: /focus primary|agent · /expand · /restore · /close · /all · /new · /view · /tasks · /scroll up|down|top|follow · /mode · /fork · /repair · /pi · /continue · /refresh.",
			"Any other text starting with / keeps its draft and hands off to the native Pi editor: Pi owns completion, expansion, and submission.",
			"Plain text goes to the focused peer. The primary pane shows its delivery mode; an agent pane uses Send or Steer.",
			"Close removes a pane without stopping its work. Abort is a separate agent action. Drafts and reading positions survive focus, Expand, Close, and reopen.",
		];
		this.dialog = { kind: "help", title: "Peer window help · Esc closes", lines };
		this.requestRender();
	}

	// ----- peer placement -------------------------------------------------------------

	/** Bounded roster data for the shared roster view. */
	private rosterSnapshot(): AgentDashboardSnapshot {
		return { observedAt: this.host.now(), sessions: this.rows, coverage: this.coverage, error: this.rowsError };
	}

	private openAll(): void {
		const primary = this.host.primary.snapshot().descriptor;
		const roster = new AgentRoster({
			tui: this.tui,
			theme: this.theme,
			onSelect: (key) => { this.closeDialog(); this.openPeer(key === "primary" ? "primary" : `agent:${key}`); },
			onCancel: () => this.closeDialog(),
			primary: { label: `Primary · ${primary.name}`, detail: [basename(primary.cwd), primary.model ?? "model unknown"].join(" · ") },
		});
		roster.setSnapshot(this.rosterSnapshot());
		roster.focused = true;
		this.dialog = { kind: "all", title: "All peers · ↑↓ select · Enter opens · Esc cancels", roster };
		this.requestRender();
	}

	/** Live task graph for the focused agent's storage; the view owns its subscription. */
	private openTasks(): void {
		const id = this.focusedAgentId();
		const tasks = this.host.source.tasks;
		if (!id) {
			this.setNotice("Focus an agent pane to see its live tasks");
			this.requestRender();
			return;
		}
		if (typeof tasks !== "function") {
			this.setNotice("Live tasks are unavailable for this source");
			this.requestRender();
			return;
		}
		const source = { tasks: (agentId: string) => tasks.call(this.host.source, agentId), subscribe: this.host.source.subscribe?.bind(this.host.source) };
		const view = new PeerTasksView({
			theme: this.theme,
			source,
			id,
			onSelectConversation: (identity) => { this.closeDialog(); this.openPeer(`agent:${identity}`); },
			onNotice: (text) => { this.setNotice(text); this.requestRender(); },
		});
		this.dialog = { kind: "tasks", title: "Tasks · live graph · ↑↓ select · Enter opens · Esc closes", tasks: view };
		this.requestRender();
	}

	private openPeer(key: string): void {
		const value: Exclude<PeerSlot, undefined> = key === "primary" ? { kind: "primary" } : { kind: "agent", id: key.slice("agent:".length) };
		const visible = slotOf(this.state, key);
		if (visible) {
			this.state.expanded = undefined;
			this.setFocus(visible);
			this.requestRender();
			return;
		}
		const side = placementForNew(this.state);
		setSlot(this.state, side, value);
		if (value.kind === "agent") this.state.selectedAgent = value.id;
		if (this.state.expanded && this.state.expanded !== side) this.state.expanded = undefined;
		this.setFocus(side);
		if (value.kind === "agent") void this.refresh();
		this.requestRender();
	}

	private placeNew(value: Exclude<PeerSlot, undefined>, source?: "left" | "right"): void {
		const key = peerKey(value);
		const visible = slotOf(this.state, key);
		if (visible) {
			this.setFocus(visible);
			return;
		}
		const side = source ? (slotValue(this.state, source === "left" ? "right" : "left") ? (source === "left" ? "right" : "left") : source) : placementForNew(this.state);
		setSlot(this.state, side, value);
		if (value.kind === "agent") this.state.selectedAgent = value.id;
		if (this.state.expanded && this.state.expanded !== side) this.state.expanded = undefined;
		this.setFocus(side);
	}

	private closeFocused(): void {
		const side = this.state.focus;
		const slot = slotValue(this.state, side);
		if (!slot) return;
		const pane = this.panes.get(peerKey(slot));
		pane?.saveDraft();
		pane?.captureView();
		if (slot.kind === "agent" && this.state.selectedAgent === slot.id) this.state.selectedAgent = undefined;
		if (pane) {
			pane.blur();
			this.panes.delete(peerKey(slot));
		}
		setSlot(this.state, side, undefined);
		if (this.state.expanded === side) this.state.expanded = undefined;
		if (!this.state.left && !this.state.right) this.openAll();
		else this.state.focus = this.state.left ? "left" : "right";
		this.requestRender();
	}

	private expandFocused(): void {
		if (!slotValue(this.state, this.state.focus)) return;
		this.state.expanded = this.state.focus;
		this.requestRender();
	}

	private restoreSplit(): void {
		this.state.expanded = undefined;
		this.requestRender();
	}

	// ----- submission and local commands ----------------------------------------------

	private submit(key: string, text: string): void {
		const purpose = classifySubmit(text);
		const pane = this.panes.get(key);
		if (purpose.kind === "empty") {
			pane?.composer.setText("");
			return;
		}
		if (purpose.kind === "local") {
			this.runLocal(purpose.command, text);
			return;
		}
		if (key === "primary" && purpose.kind === "handoff") {
			this.continuePrimary(purpose.text);
			return;
		}
		void this.submitText(key, purpose.kind === "handoff" ? purpose.text : purpose.kind === "plain" ? purpose.text : "");
	}

	private async submitText(key: string, text: string): Promise<void> {
		const pane = this.panes.get(key);
		if (!pane || pane.submitting) return;
		if (key === "primary") await this.submitPrimary(pane, text);
		else await this.submitAgent(pane, key, text);
	}

	private async submitPrimary(pane: PeerPane, text: string): Promise<void> {
		const state = paneState(this.state, "primary");
		pane.submitting = true;
		try {
			this.host.primary.sendPlain(text, state.mode === "steer" || state.mode === "followUp" ? state.mode : "auto");
			pane.composer.setText("");
			state.draft = "";
			pane.notice = "Sent to the primary session";
		} catch (error) {
			pane.composer.setText(text);
			state.draft = text;
			pane.notice = `Refused: ${errorText(error)}`;
		} finally {
			pane.submitting = false;
			this.requestRender();
		}
	}

	private async submitAgent(pane: PeerPane, key: string, text: string): Promise<void> {
		const id = key.startsWith("agent:") ? key.slice("agent:".length) : this.focusedAgentId();
		if (!id) return;
		const state = paneState(this.state, key);
		const mode: "send" | "steer" = state.mode === "steer" ? "steer" : "send";
		pane.submitting = true;
		try {
			const result = await this.host.actions.submit({ id, text, mode });
			if (this.closed) return;
			pane.composer.setText("");
			state.draft = "";
			pane.notice = result.text;
			void this.refresh();
		} catch (error) {
			if (!this.closed) {
				pane.composer.setText(text);
				state.draft = text;
				pane.notice = `Refused: ${errorText(error)}`;
			}
		} finally {
			pane.submitting = false;
			this.requestRender();
		}
	}

	private continuePrimary(text: string): void {
		const pane = this.panes.get("primary");
		if (!pane) return;
		const previous = this.host.primary.handoffToNative(text);
		if (previous.trim() !== "") this.state.nativeDraftBefore = previous;
		pane.composer.setText("");
		paneState(this.state, "primary").draft = "";
		this.finish();
	}

	/** Draft text a local command acts on: the retained draft, not the command line itself. */
	private draftForCommand(key: string, command: string, submitted?: string): string {
		const buffer = submitted ?? this.panes.get(key)?.composer.getText() ?? "";
		const retained = paneState(this.state, key).draft;
		return buffer.trim() === `/${command}` ? retained : buffer;
	}

	private restoreNativeDraft(): void {
		const saved = this.state.nativeDraftBefore;
		if (!saved) return;
		const previous = this.host.primary.handoffToNative(saved);
		this.state.nativeDraftBefore = previous.trim() ? previous : undefined;
		this.finish();
	}

	private runLocal(command: LocalCommand, submitted = ""): void {
		if (this.runViewCommand(command)) return;
		this.runInputCommand(command, submitted);
	}

	/** Window and navigation commands that do not read a draft. */
	private runViewCommand(command: LocalCommand): boolean {
		switch (command.name) {
			case "all": this.openAll(); return true;
			case "new": this.openPrompt("New agent · task (blank creates an idle agent)", "", (value) => void this.createAgent(value)); return true;
			case "view": this.openViewMenu(); return true;
			case "focus": this.focusCommand(command.args[0]); return true;
			case "expand": this.expandFocused(); return true;
			case "restore": this.restoreSplit(); return true;
			case "close": this.closeFocused(); return true;
			case "pi": this.finish(); return true;
			case "fork": this.pickEntry("fork"); return true;
			case "repair": this.pickEntry("repair"); return true;
			case "tasks": this.openTasks(); return true;
			case "help": this.openHelp(); return true;
			case "refresh": void this.refresh(); return true;
			default: return false;
		}
	}

	/** Commands that act on the current draft or reading position. */
	private runInputCommand(command: LocalCommand, submitted: string): void {
		switch (command.name) {
			case "continue": this.continueDraft(submitted); return;
			case "scroll": this.scrollCommand(command.args[0]); return;
			case "mode": this.modeCommand(command.args[0]); return;
			case "steer": this.setMode("steer"); return;
			case "send": this.setMode("send"); return;
			case "followup": this.setMode("followUp"); return;
			case "auto": this.setMode("auto"); return;
			default: return;
		}
	}

	private continueDraft(submitted: string): void {
		const pane = this.focusedPane();
		if (!pane) return;
		const draft = this.draftForCommand(pane.key, "continue", submitted);
		if (draft.trim() === "") {
			this.setNotice("Type a draft first");
			this.requestRender();
			return;
		}
		if (pane.key === "primary") this.continuePrimary(draft);
		else void this.submitText(pane.key, draft);
	}

	private scrollCommand(direction = "down"): void {
		const pane = this.focusedPane();
		if (!pane) return;
		const step = Math.max(1, this.lastBodyHeight - 3);
		if (direction === "top") {
			if (pane.atTop()) this.loadEarlierFocused();
			else pane.scrollLines(-Number.MAX_SAFE_INTEGER);
		}
		else if (direction === "bottom" || direction === "follow") pane.followTail();
		else pane.scrollLines(direction === "up" ? -step : step);
		this.requestRender();
	}

	private focusCommand(target: string | undefined): void {
		if (target === undefined) {
			this.toggleFocus();
			return;
		}
		if (target === "left" || target === "right") {
			if (slotValue(this.state, target)) this.setFocus(target);
			return;
		}
		if (target === "primary" || target === "agent") {
			this.focusKind(target);
			return;
		}
		const side = slotOf(this.state, `agent:${target}`);
		if (side) this.setFocus(side);
	}

	private toggleFocus(): void {
		if (this.state.left && this.state.right) this.setFocus(this.state.focus === "left" ? "right" : "left");
	}

	private focusKind(kind: "primary" | "agent"): void {
		if (this.state.left?.kind === kind) this.setFocus("left");
		else if (this.state.right?.kind === kind) this.setFocus("right");
		else if (kind === "primary") this.openPeer("primary");
		else this.openAll();
	}

	private allowedModes(): string[] {
		const slot = slotValue(this.state, this.state.focus);
		return slot?.kind === "primary" ? ["auto", "steer", "followUp"] : ["send", "steer"];
	}

	private setMode(mode: string): void {
		const pane = this.focusedPane();
		if (!pane) return;
		const allowed = this.allowedModes();
		const normalized = mode === "followup" ? "followUp" : mode;
		if (!allowed.includes(normalized)) {
			this.setNotice(`Mode ${mode} does not apply here · use ${allowed.join(", ")}`);
			this.requestRender();
			return;
		}
		paneState(this.state, pane.key).mode = normalized as "auto" | "send" | "steer" | "followUp";
		pane.notice = `Mode ${normalized}`;
		this.requestRender();
	}

	private modeCommand(arg: string | undefined): void {
		if (arg) {
			this.setMode(arg);
			return;
		}
		this.openMenu(`Mode · ${this.focusedPane()?.key ?? "no pane"}`, this.allowedModes().map((mode) => ({ value: mode, label: mode, description: mode === "auto" ? "send now; follow-up when the primary is busy" : mode === "send" ? "admit a task" : "queue a correction" })), (value) => this.setMode(value));
	}

	private openViewMenu(): void {
		const focusSlot = slotValue(this.state, this.state.focus);
		const items: SelectItem[] = [];
		items.push({ value: "focus-primary", label: "Focus primary pane", description: "open it beside the agent when absent" });
		items.push({ value: "focus-agent", label: "Focus agent pane", description: "selected Durable peer, or the All list when none is open" });
		if (focusSlot) items.push({ value: "expand", label: "Expand focused pane", description: "fill the window" });
		if (this.state.expanded) items.push({ value: "restore", label: "Restore split", description: "two equal panes" });
		if (focusSlot) items.push({ value: "close", label: "Close focused pane", description: "view only; work continues" });
		items.push({ value: "continue", label: "Continue primary draft in Pi", description: "hand the draft to the native editor" });
		if (this.state.nativeDraftBefore) items.push({ value: "restore-native", label: "Restore saved native draft", description: "put the previous Pi editor text back" });
		if (this.focusedAgentId()) {
			items.push({ value: "actions", label: "Agent actions…", description: "native action list for the selected agent" });
			items.push({ value: "tasks", label: "Tasks · live graph…", description: "live work for this agent's storage" });
			items.push({ value: "fork", label: "Fork after a committed entry…", description: "creates an idle branch beside the source" });
			items.push({ value: "repair", label: "Repair from a committed entry…", description: "new branch with your correction" });
			items.push({ value: "thinking", label: "Toggle thinking view", description: "focused agent pane" });
			items.push({ value: "tools", label: "Toggle expanded tool output", description: "focused agent pane" });
		}
		items.push({ value: "help", label: "Help", description: "local commands and exit" });
		this.openMenu("View · actions", items, (value) => {
			switch (value) {
				case "focus-primary": this.focusCommand("primary"); return;
				case "focus-agent": this.focusCommand("agent"); return;
				case "expand": this.expandFocused(); return;
				case "restore": this.restoreSplit(); return;
				case "close": this.closeFocused(); return;
				case "continue": {
					const primary = this.panes.get("primary");
					if (primary) this.continuePrimary(this.draftForCommand("primary", "continue"));
					return;
				}
				case "restore-native": this.restoreNativeDraft(); return;
				case "actions": void this.runActions(); return;
				case "tasks": this.openTasks(); return;
				case "fork": this.pickEntry("fork"); return;
				case "repair": this.pickEntry("repair"); return;
				case "thinking": this.toggleView("thinking"); return;
				case "tools": this.toggleView("tools"); return;
				case "help": this.openHelp(); return;
				default: return;
			}
		});
	}

	private toggleView(which: "thinking" | "tools"): void {
		const pane = this.focusedPane();
		if (!pane) return;
		const view = paneState(this.state, pane.key).view;
		if (which === "thinking") view.showThinking = !view.showThinking;
		else view.expanded = !view.expanded;
		this.requestRender();
	}

	// ----- create, fork, repair -------------------------------------------------------

	private async createAgent(prompt: string): Promise<void> {
		if (this.actionRunning) return;
		this.actionRunning = true;
		this.setNotice("Creating agent…");
		this.requestRender();
		try {
			const result = await this.host.actions.newAgent({ prompt: prompt.trim() || undefined });
			if (this.closed) return;
			this.setNotice(result.text);
			if (result.sessionId) this.placeNew({ kind: "agent", id: result.sessionId });
			await this.refresh();
		} catch (error) {
			if (!this.closed) this.setNotice(`Create failed: ${errorText(error)}`);
		} finally {
			this.actionRunning = false;
			this.requestRender();
		}
	}

	private pickEntry(action: "fork" | "repair"): void {
		const id = this.focusedAgentId();
		if (!id) {
			this.setNotice("Focus an agent pane to fork or repair");
			this.requestRender();
			return;
		}
		const snapshot = this.agents.get(id)?.snapshot;
		if (!snapshot) {
			this.setNotice("The agent transcript is not loaded");
			this.requestRender();
			return;
		}
		const choices = committedEntryChoices(renderableEntries(snapshot.entries));
		if (!choices.length) {
			this.setNotice("No committed decision is available to fork or repair");
			this.requestRender();
			return;
		}
		this.openMenu(action === "fork" ? "Fork after entry" : "Repair from entry", choices, (entryId) => {
			if (action === "fork") void this.runFork(id, entryId);
			else this.openPrompt("Correction for the repaired branch", "", (correction) => { void this.runRepair(id, entryId, correction); });
		});
	}

	/** The command layer owns the picker, confirmation, and argument dialogs. */
	private async runActions(): Promise<void> {
		const id = this.focusedAgentId();
		const run = this.host.runActions;
		if (!id || !run || this.actionRunning) return;
		const target = this.rows.find((row) => row.id === id);
		if (!target) return;
		const source = slotOf(this.state, `agent:${id}`) ?? this.state.focus;
		this.actionRunning = true;
		try {
			const result = await run(target);
			if (this.closed || !result) return;
			this.setNotice(result.text);
			if (result.sessionId && result.sessionId !== id) {
				this.placeNew({ kind: "agent", id: result.sessionId }, source);
				await this.refresh();
			}
		} catch (error) {
			if (!this.closed) this.setNotice(`Action failed: ${errorText(error)}`);
		} finally {
			this.actionRunning = false;
			this.requestRender();
		}
	}

	private async runFork(id: string, entryId: string): Promise<void> {
		if (this.actionRunning) return;
		this.actionRunning = true;
		const source = slotOf(this.state, `agent:${id}`) ?? this.state.focus;
		this.setNotice("Forking…");
		this.requestRender();
		try {
			const result = await this.host.actions.fork({ id, entryId });
			if (this.closed) return;
			this.setNotice(result.text);
			if (result.sessionId) this.placeNew({ kind: "agent", id: result.sessionId }, source);
			await this.refresh();
		} catch (error) {
			if (!this.closed) this.setNotice(`Fork failed: ${errorText(error)}`);
		} finally {
			this.actionRunning = false;
			this.requestRender();
		}
	}

	private async runRepair(id: string, entryId: string, correction: string): Promise<void> {
		if (this.actionRunning) return;
		this.actionRunning = true;
		const source = slotOf(this.state, `agent:${id}`) ?? this.state.focus;
		this.setNotice("Repairing…");
		this.requestRender();
		try {
			const result = await this.host.actions.repair({ id, entryId, correction });
			if (this.closed) return;
			this.setNotice(result.text);
			if (result.sessionId) this.placeNew({ kind: "agent", id: result.sessionId }, source);
			await this.refresh();
		} catch (error) {
			if (!this.closed) this.setNotice(`Repair failed: ${errorText(error)}`);
		} finally {
			this.actionRunning = false;
			this.requestRender();
		}
	}

	invalidate(): void {
		for (const pane of this.panes.values()) pane.invalidate();
	}
}

/** Plain-text fallback for non-TUI modes; the peer window itself needs the terminal. */
export function peerWindowSummary(snapshot: { rows: readonly AgentConversationSummary[]; coverage?: AgentDashboardCoverage; error?: string }): string {
	const working = snapshot.rows.filter((row) => row.state === "working").length;
	return [`Peer window needs the interactive TUI.`, `${snapshot.rows.length} agent sessions · ${working} working`, ...(snapshot.coverage?.nextCursor ? ["more inventory to inspect"] : [])].join("\n");
}

/** Open the full-window peer view. Untouched native Pi stays beneath the overlay. */
export async function showPeerWindow(options: PeerWindowOptions): Promise<void> {	const { ctx } = options;
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		try {
			const page = await options.source.list();
			ctx.ui.notify(peerWindowSummary({ rows: page.rows, coverage: page.coverage }), "info");
		} catch (error) {
			ctx.ui.notify(`Peer window unavailable: ${errorText(error)}`, "error");
		}
		return;
	}
	const state = options.state ?? peerWindowStore.state(ctx.sessionManager.getSessionId());
	if (options.initialAgentId) {
		if (state.left?.kind === "agent" && state.left.id === options.initialAgentId) state.focus = "left";
		else state.right = { kind: "agent", id: options.initialAgentId };
	}
	const host: PeerWindowHost = {
		source: options.source,
		primary: options.primary,
		actions: options.actions,
		runActions: options.runActions,
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		now: options.now ?? (() => Date.now()),
		transcriptFactory: options.transcriptFactory,
		refreshMs: options.refreshMs,
	};
	await ctx.ui.custom<void>((tui, theme, keys, done) => new PeerWindow(tui, theme, keys, done, state, host), {
		overlay: true,
		overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
	});
}
