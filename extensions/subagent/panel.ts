/** Worker and communication readers, with control through the owning runtime. */
import { execFile } from "node:child_process";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
	CollaborationEvent,
	CollaborationParticipant,
	CollaborationQuery,
	CollaborationSnapshot,
} from "./collaboration-types.ts";
import {
	type ConsoleMessage,
	type ConsolePart,
	type ConsoleTextPart,
	cleanConsoleText,
	renderMarkdownText,
	renderTranscript,
	restoreTranscriptAnchor,
	transcriptAnchor,
	type TranscriptDocument,
} from "./console.ts";
import { conversationThreads } from "./conversations.ts";
import type { WorkerRecord } from "./index.ts";
import type { TranscriptItem } from "./runtime.ts";

export interface SubagentPanelDeps {
	readWorkers(ownerSession?: string): WorkerRecord[];
	readWorker(id: string): WorkerRecord | null;
	/** Live queries read memory; history requires an explicit operator action. */
	collaboration(query: CollaborationQuery): Promise<CollaborationSnapshot>;
	kill(id: string): Promise<string>;
	continueWorker(id: string, message: string): Promise<{ id: string | null; text: string }>;
	report(id: string): { label: string; text: string } | null;
	conversation(id: string): TranscriptItem[] | null;
	isLive(id: string): boolean;
	subscribeLive(id: string, onEvent: () => void): (() => void) | null;
	isActive(id: string): boolean;
	interrupt(id: string): Promise<string>;
	/** A rejected delivery retains the draft, even when the request itself resolves. */
	sendLive(id: string, text: string): Promise<{ ok: boolean; text: string }>;
	currentSessionId(): string | null;
	copyText?(text: string, done: (error?: string) => void): void;
}

export function formatPanelElapsed(seconds: number): string {
	const whole = Math.max(0, Math.round(seconds));
	if (whole >= 86400) return `${Math.floor(whole / 86400)}d${Math.floor((whole % 86400) / 3600)}h`;
	if (whole >= 3600) return `${Math.floor(whole / 3600)}h${Math.floor((whole % 3600) / 60)}m`;
	return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m${whole % 60}s`;
}

export function rosterOutputPreview(worker: WorkerRecord): string {
	const source = worker.resultPreview ?? worker.lastOutput ?? worker.error;
	return source ? cleanLine(source).replace(/\s+/g, " ").trim() || "(no output)" : "(no output yet)";
}

const PANEL_MAX_ROWS_OVERRIDE = Number.parseInt(process.env.PI_SUBAGENT_PANEL_MAX_ROWS ?? "0", 10);

function copyToClipboard(text: string, done: (error?: string) => void): void {
	try {
		const child = execFile("pbcopy", [], { encoding: "utf8", timeout: 3_000 }, (error) => done(error?.message));
		child.stdin?.end(text);
	} catch (error) {
		done(errText(error));
	}
}

export function reopenCommand(sessionFile: string): string {
	return `pi --session '${sessionFile.replace(/'/g, "'\\''")}'`;
}

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function cleanText(text: string): string {
	return cleanConsoleText(text);
}
function cleanLine(text: string): string {
	return cleanText(text).replace(/\n/g, " ");
}
function plainLine(text: string, width: number): string {
	const value = truncateToWidth(text, Math.max(0, width), "");
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/** Longest comfortable prose measure; wide panes keep a gutter instead of running to the edge. */
const READER_MEASURE = 96;
const READER_GUTTER = "  ";
/** Below this pane height the chrome collapses to one header row and one footer row. */
const COMPACT_PANEL_HEIGHT = 12;

export function readerMeasure(paneWidth: number): number {
	return Math.max(1, Math.min(READER_MEASURE, paneWidth - 6));
}

/** Fixed-width clock column so list and card rows align. */
export function clockTime(timestamp: number): string {
	return Number.isFinite(timestamp) ? new Date(timestamp).toTimeString().slice(0, 8) : "--:--:--";
}

export function positionLabel(scroll: number, rows: number, total: number): string {
	if (total <= 0) return "lines 0/0";
	const first = Math.min(scroll + 1, total);
	return `lines ${first}-${Math.min(total, scroll + Math.max(1, rows))}/${total}`;
}

export interface FooterAction {
	key: string;
	label: string;
}
export interface FooterStyles {
	key(text: string): string;
	label(text: string): string;
	rule(text: string): string;
}

function noticeFooter(width: number, escapeHint: string, notice: string): string {
	const hint = visibleWidth(escapeHint) <= width ? escapeHint : "esc".slice(0, width);
	const budget = width - visibleWidth(hint) - 3;
	if (budget <= 0) return plainLine(hint, width);
	const clean = cleanLine(notice);
	if (visibleWidth(clean) <= budget) return plainLine(`${clean} · ${hint}`, width);
	let tail = "";
	for (const char of [...clean].reverse()) {
		if (visibleWidth(`…${char}${tail}`) > budget) break;
		tail = char + tail;
	}
	return plainLine(`…${tail} · ${hint}`, width);
}

/**
 * Grouped key hints: navigation, opening, and destructive keys stay in separate groups, and the
 * escape hint survives every width. Single actions drop from the end when the row does not fit.
 */
export function footerLine(
	width: number,
	groups: FooterAction[][],
	dismiss: FooterAction,
	styles: FooterStyles,
	notice?: string,
): string {
	const plainOf = (action: FooterAction) => (action.key ? `${action.key} ${action.label}` : action.label);
	if (notice) return noticeFooter(width, plainOf(dismiss), notice);
	const kept = groups.filter((group) => group.length).map((group) => [...group]);
	const plain = () =>
		[...kept.filter((group) => group.length).map((group) => group.map(plainOf).join(" · ")), plainOf(dismiss)].join(
			" │ ",
		);
	while (visibleWidth(plain()) > width) {
		let dropped = false;
		for (let index = kept.length - 1; index >= 0; index--) {
			if (kept[index].length) {
				kept[index].pop();
				dropped = true;
				break;
			}
		}
		if (!dropped) break;
	}
	if (visibleWidth(plain()) > width) return plainLine(plainOf(dismiss).slice(0, Math.max(0, width)), width);
	const styled = (action: FooterAction) =>
		action.key ? `${styles.key(action.key)} ${styles.label(action.label)}` : styles.label(action.label);
	return plainLine(
		[
			...kept.filter((group) => group.length).map((group) => group.map(styled).join(styles.rule(" · "))),
			styled(dismiss),
		].join(styles.rule(" │ ")),
		width,
	);
}

/** Identity lists leave most of a wide window to the selected content. */
export function threadPaneWidth(totalWidth: number): number {
	if (totalWidth < 100) return totalWidth;
	return Math.max(36, Math.min(48, Math.round(totalWidth * 0.3)));
}

/** Ellipses mark display clipping; the selected reader retains the source text. */
export function clipText(text: string, width: number): string {
	return width > 0 ? truncateToWidth(text, width, "…") : "";
}

export function headerPair(width: number, left: string, right: string): string {
	if (width <= 0) return "";
	if (!right) return plainLine(clipText(left, width), width);
	const rightText = clipText(right, width);
	const budget = Math.max(0, width - visibleWidth(rightText) - 1);
	const leftText = clipText(left, budget);
	const gap = Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText));
	return plainLine(`${leftText}${" ".repeat(gap)}${rightText}`, width);
}

function printableKey(data: string): string {
	return decodeKittyPrintable(data) ?? data;
}

function toTextParts(content: TranscriptItem["content"]): ConsoleTextPart[] {
	return content.flatMap((part) =>
		part.type === "text"
			? [{ type: "text" as const, text: part.text }]
			: part.type === "image"
				? [{ type: "text" as const, text: "[image]" }]
				: [],
	);
}
function normalizeMessages(raw: TranscriptItem[]): ConsoleMessage[] {
	return raw.map((item): ConsoleMessage => {
		if (item.role === "user") return { id: item.id, role: "user", content: toTextParts(item.content) };
		if (item.role === "custom")
			return { id: item.id, role: "custom", customType: item.customType, content: toTextParts(item.content) };
		if (item.role === "tool")
			return {
				role: "toolResult",
				toolCallId: item.toolCallId,
				toolName: item.toolName,
				content: toTextParts(item.content),
				isError: item.isError,
				status: item.status,
			};
		const content: ConsolePart[] = item.content.map((part) => {
			if (part.type !== "toolCall") return part;
			const input = part.input;
			return {
				type: "toolCall",
				id: part.toolCallId,
				name: part.toolName,
				arguments:
					input && typeof input === "object" && !Array.isArray(input)
						? Object.fromEntries(Object.entries(input))
						: { value: input },
			};
		});
		return { id: item.id, role: "assistant", content, stopReason: item.stopReason, errorMessage: item.errorMessage };
	});
}

const MAX_RETAINED_FAMILIES = 4;
const MAX_RETAINED_EVENTS = 1_000;
const MAX_RETAINED_PARTICIPANTS = 256;
const MAX_RETAINED_TEXT = 2 * 1024 * 1024;

/** Incoming ancestry order supersedes timestamps within each source session. */
function mergeEvents(previous: CollaborationEvent[], incoming: CollaborationEvent[]): CollaborationEvent[] {
	const incomingIds = new Set(incoming.map((event) => event.id));
	const sources = new Map<string, CollaborationEvent[]>();
	for (const event of previous)
		sources.set(event.sourceSessionId, [...(sources.get(event.sourceSessionId) ?? []), event]);
	const before = new Map<string, CollaborationEvent[]>();
	const suffixes = new Map<string, CollaborationEvent[]>();
	for (const [sourceId, events] of sources) {
		let nextAnchor: string | null = null;
		for (let index = events.length - 1; index >= 0; index--) {
			const event = events[index];
			if (incomingIds.has(event.id)) {
				nextAnchor = event.id;
				continue;
			}
			const bucket = nextAnchor ? (before.get(nextAnchor) ?? []) : (suffixes.get(sourceId) ?? []);
			bucket.unshift(event);
			if (nextAnchor) before.set(nextAnchor, bucket);
			else suffixes.set(sourceId, bucket);
		}
	}
	const result: CollaborationEvent[] = [];
	const lastBySource = new Map(incoming.map((event) => [event.sourceSessionId, event.id]));
	for (const event of incoming) {
		result.push(...(before.get(event.id) ?? []), event);
		if (lastBySource.get(event.sourceSessionId) === event.id) {
			result.push(...(suffixes.get(event.sourceSessionId) ?? []));
			suffixes.delete(event.sourceSessionId);
		}
	}
	return [...suffixes.values()].flat().concat(result);
}

type FocusPage = "timeline" | "tree" | "details";
type HistoryReport = {
	at: number;
	total: number;
	added: number;
	removed: number;
	notices: string[];
};
type RetainedSnapshot = {
	snapshot: CollaborationSnapshot;
	history: HistoryReport | null;
	refreshedAt: number;
	observedIds: Set<string>;
};

class SubagentConsole {
	private _focused = false;
	private mode: "overview" | "communication" = "overview";
	private scope: "children" | "all" = "children";
	private roster: WorkerRecord[] = [];
	private rosterId: string | null = null;
	private rosterLimited = false;
	private readonly rosterSearch = new Input({ prompt: "/ " });
	private evidenceMode = false;
	private threadId: string | null = null;
	private threadFocus = false;
	private exchangeScroll = 0;
	private exchangeLength = 0;
	private exchangeRows = 1;
	private exchangeReadId: string | null = null;
	private framed = true;
	private view: "dashboard" | "search" | "families" | "console" | "report" | "help" = "dashboard";
	private page: FocusPage = "timeline";
	private readonly search = new Input({ prompt: "/ " });
	private readonly composer = new Input({ prompt: "› " });
	private readonly retained = new Map<string, RetainedSnapshot>();
	private familyId: string | undefined;
	private snapshot: CollaborationSnapshot | null = null;
	private familyIndex = 0;
	private requestVersion = 0;
	private requestPending = false;
	private historyPending = false;
	private historyError: string | null = null;
	private infoScroll = 0;
	private infoLength = 0;
	private selectedParticipant: string | null = null;
	private participantFilter: string | null = null;
	private selectedEvent: string | null = null;
	private detailParticipant = false;
	private detailScroll = 0;
	private detailLength = 0;
	private eventStart = 0;
	private followEvents = true;
	private newEvents = 0;
	private pinnedId: string | null = null;
	private scroll = 0;
	private followTail = true;
	private continuing = false;
	private sendPending = false;
	private continuationPending = false;
	private readonly pendingRequests = new Map<string, "send" | "continue">();
	private consoleVersion = 0;
	private contentVersion = 0;
	private lastWidth = 80;
	private transcriptCache: { key: string; layout: string; value: TranscriptDocument } | null = null;
	private conversationCache: {
		key: string;
		messages: ConsoleMessage[];
		report: { label: string; text: string } | null;
	} | null = null;
	private consolePage: "chat" | "report" | "details" = "chat";
	private expandedTools = false;
	private showThinking = false;
	private composing = false;
	private readonly sectionExpansion = new Map<string, boolean>();
	private expansionRevision = 0;
	private selectedSectionId: string | null = null;
	private readonly pagePositions = new Map<string, { scroll: number; follow: boolean }>();
	private unsub: (() => void) | null = null;
	private notice: string | undefined;
	private noticeUntil = 0;
	private disposed = false;

	private readonly deps: SubagentPanelDeps;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly close: () => void;
	private readonly keybindings?: Pick<KeybindingsManager, "matches" | "getKeys">;

	constructor(
		deps: SubagentPanelDeps,
		tui: TUI,
		theme: Theme,
		close: () => void,
		initialFilter?: string,
		keybindings?: Pick<KeybindingsManager, "matches" | "getKeys">,
	) {
		this.deps = deps;
		this.tui = tui;
		this.theme = theme;
		this.close = close;
		this.keybindings = keybindings;
		if (initialFilter) this.rosterSearch.setValue(cleanLine(initialFilter));
		this.refreshRoster();
	}
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}
	private syncFocus(): void {
		this.search.focused = this._focused && this.view === "search" && this.mode === "communication";
		this.rosterSearch.focused = this._focused && this.view === "search" && this.mode === "overview";
		this.composer.focused =
			this._focused &&
			this.view === "console" &&
			this.consolePage === "chat" &&
			(this.composing || this.continuing) &&
			!this.sendPending &&
			!this.continuationPending &&
			(this.continuing || Boolean(this.pinnedId && this.deps.isLive(this.pinnedId)));
	}
	private bump(): void {
		if (!this.disposed) {
			this.syncFocus();
			this.tui.requestRender();
		}
	}
	private setNotice(text: string): void {
		if (this.disposed) return;
		this.notice = cleanLine(text);
		this.noticeUntil = Date.now() + 6_000;
		this.bump();
	}
	private currentNotice(): string | undefined {
		return Date.now() < this.noticeUntil ? this.notice : undefined;
	}

	/** Polling never requests history and never starts work from render(). */
	tick(): void {
		this.refreshRoster();
		if (this.mode === "communication") void this.refresh(false);
		this.bump();
	}
	private refreshRoster(): void {
		const rows = this.deps.readWorkers(
			this.scope === "children" ? (this.deps.currentSessionId() ?? undefined) : undefined,
		);
		this.rosterLimited = rows.length > 512;
		this.roster = rows.slice(0, 512);
		const visible = this.rosterRows();
		if (!visible.some((record) => record.id === this.rosterId)) this.rosterId = visible[0]?.id ?? null;
	}
	private rosterRows(): WorkerRecord[] {
		const query = this.rosterSearch.getValue().toLocaleLowerCase();
		return this.roster.filter(
			(record) =>
				!query ||
				[
					record.id,
					record.label,
					record.task,
					record.model,
					record.state,
					record.thinking,
					rosterOutputPreview(record),
				].some((value) => value?.toLocaleLowerCase().includes(query)),
		);
	}
	private async refresh(history: boolean): Promise<void> {
		if (this.disposed || this.historyPending || (this.requestPending && !history)) return;
		const version = ++this.requestVersion;
		const familyId = this.familyId;
		this.requestPending = true;
		this.historyPending = history;
		if (history) this.historyError = null;
		this.bump();
		try {
			const incoming = await this.deps.collaboration({
				...(familyId ? { familyId } : {}),
				...(history ? { history: true } : {}),
			});
			if (this.disposed || version !== this.requestVersion) return;
			const previous = this.retained.get(incoming.familyId);
			const priorViewIds = new Set(previous?.snapshot.events.map((event) => event.id) ?? []);
			const oldIds = new Set([
				...(previous?.observedIds ?? []),
				...(this.snapshot?.familyId === incoming.familyId ? this.snapshot.events.map((event) => event.id) : []),
			]);
			const merged = history ? incoming.events : mergeEvents(previous?.snapshot.events ?? [], incoming.events);
			const events: CollaborationEvent[] = [];
			let textSize = 0;
			for (const event of [...merged].reverse()) {
				if (events.length >= MAX_RETAINED_EVENTS || textSize + event.text.length > MAX_RETAINED_TEXT) break;
				events.push(event);
				textSize += event.text.length;
			}
			events.reverse();
			const eventIds = new Set(events.map((event) => event.id));
			const participants = new Map<string, CollaborationParticipant>();
			if (!history && previous)
				for (const participant of previous.snapshot.participants) participants.set(participant.id, participant);
			for (const participant of incoming.participants) participants.set(participant.id, participant);
			const omittedEvents = merged.length - events.length;
			const omittedParticipants = Math.max(0, participants.size - MAX_RETAINED_PARTICIPANTS);
			const snapshot = {
				...incoming,
				participants: [...participants.values()].slice(0, MAX_RETAINED_PARTICIPANTS),
				events,
				notices: [
					...incoming.notices,
					...(omittedEvents ? [`View cache omitted ${omittedEvents} older events.`] : []),
					...(omittedParticipants ? [`View cache omitted ${omittedParticipants} participants.`] : []),
				],
			};
			this.retained.delete(incoming.familyId);
			this.retained.set(incoming.familyId, {
				snapshot,
				history: history
					? {
							at: Date.now(),
							total: events.length,
							added: events.filter((event) => !priorViewIds.has(event.id)).length,
							removed: [...priorViewIds].filter((id) => !eventIds.has(id)).length,
							notices: [...snapshot.notices],
						}
					: (previous?.history ?? null),
				refreshedAt: Date.now(),
				observedIds: new Set(incoming.events.map((event) => event.id)),
			});
			while (this.retained.size > MAX_RETAINED_FAMILIES) {
				const oldest = this.retained.keys().next().value;
				if (oldest) this.retained.delete(oldest);
				snapshot.notices.push("The oldest cached family was removed. Select that family to reload history.");
			}
			if (this.selectedEvent && !snapshot.events.some((event) => event.id === this.selectedEvent)) {
				this.selectedEvent = snapshot.events[0]?.id ?? null;
				this.detailScroll = 0;
				this.setNotice("The selected event is outside the refreshed snapshot or view cache limit.");
			}
			this.snapshot = snapshot;
			this.familyId = incoming.familyId;
			if (!this.followEvents && !history)
				this.newEvents += incoming.events.filter((event) => !oldIds.has(event.id)).length;
			if (!this.selectedParticipant)
				this.selectedParticipant =
					snapshot.participants.find((participant) => participant.workerId)?.id ?? snapshot.participants[0]?.id ?? null;
			if (this.followEvents) this.selectedEvent = this.events().at(-1)?.id ?? null;
		} catch (error) {
			if (!this.disposed && version === this.requestVersion) {
				if (history) this.historyError = cleanText(errText(error)).slice(0, 2048);
				else this.setNotice(`Snapshot refresh failed: ${errText(error)}. Retained data stays visible.`);
			}
		} finally {
			if (version === this.requestVersion) {
				this.requestPending = false;
				this.historyPending = false;
				this.bump();
			}
		}
	}
	private events(): CollaborationEvent[] {
		const query = this.search.getValue().toLocaleLowerCase();
		return (this.snapshot?.events ?? []).filter(
			(event) =>
				(!this.participantFilter ||
					event.actorId === this.participantFilter ||
					event.recipientId === this.participantFilter) &&
				(!query ||
					[event.text, event.kind, event.actorId, event.recipientId ?? ""].some((text) =>
						text.toLocaleLowerCase().includes(query),
					)),
		);
	}
	private event(): CollaborationEvent | undefined {
		if (this.mode === "communication" && !this.evidenceMode && this.page !== "details") {
			const thread = this.currentThread();
			return thread?.events.find((event) => event.id === this.selectedEvent) ?? thread?.events.at(-1);
		}
		return this.snapshot?.events.find((event) => event.id === this.selectedEvent);
	}
	private participant(id = this.selectedParticipant): CollaborationParticipant | undefined {
		return this.snapshot?.participants.find((participant) => participant.id === id);
	}
	/** Display identities are neutralized before styling; actions always use exact source identities. */
	private displayId(id: string): string {
		const participant = this.participant(id);
		if (participant && !participant.workerId) return cleanLine(participant.label);
		if (participant?.workerId && participant.label && participant.label !== id) return cleanLine(participant.label);
		if (id.length <= 14) return cleanLine(id);
		const ids = [
			...(this.snapshot?.participants.map((item) => item.id) ?? []),
			...this.roster.flatMap((record) => [record.id, record.ownerSession ?? ""]),
		];
		let length = 6;
		while (length < id.length && ids.some((other) => other !== id && other.endsWith(id.slice(-length)))) length++;
		return cleanLine(`…${id.slice(-length)}`);
	}
	/** Presentation label; exact identities remain in details. */
	private participantLabel(id: string): string {
		return this.displayId(id);
	}
	/** Overview identity column: a stored label wins, otherwise the abbreviated id. */
	private rosterLabel(record: WorkerRecord): string {
		return record.label && record.label !== record.id ? cleanLine(record.label) : this.displayId(record.id);
	}
	private managerId(): string | undefined {
		return this.snapshot?.participants.find((participant) => !participant.workerId)?.id;
	}
	private directionMark(event: CollaborationEvent): "in" | "out" | "peer" {
		const manager = this.managerId();
		if (!manager) return "peer";
		if (event.actorId === manager) return "out";
		if (event.recipientId === manager) return "in";
		return "peer";
	}
	private threadLabel(thread: { participants: readonly string[] }, collapse = true): string {
		const manager = this.managerId();
		const peers = manager ? thread.participants.filter((id) => id !== manager) : [...thread.participants];
		if (collapse && manager && peers.length && thread.participants.includes(manager))
			return peers.map((id) => this.participantLabel(id)).join(" ↔ ");
		return thread.participants.map((id) => this.participantLabel(id)).join(" ↔ ");
	}
	private footerStyles(): FooterStyles {
		return {
			key: (text) => this.theme.fg("accent", text),
			label: (text) => this.theme.fg("text", text),
			rule: (text) => this.theme.fg("dim", text),
		};
	}
	private paneCap(): number {
		const cap =
			PANEL_MAX_ROWS_OVERRIDE > 0 ? PANEL_MAX_ROWS_OVERRIDE : Math.max(44, Math.floor(this.tui.terminal.rows * 0.85));
		return Math.max(1, Math.min(this.tui.terminal.rows - 2, cap));
	}
	private compact(): boolean {
		return this.paneCap() - (this.framed ? 3 : 0) < COMPACT_PANEL_HEIGHT;
	}
	/** Pi styles end with standalone background or full resets; restore the enclosing surface. */
	private background(color: "customMessageBg" | "selectedBg", text: string): string {
		const background = this.theme.getBgAnsi(color);
		return this.theme.bg(
			color,
			text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + background),
		);
	}
	private paintSelected(line: string, selected: boolean): string {
		return selected ? this.background("selectedBg", line) : line;
	}
	private gutterWrap(source: string, paneWidth: number, markdown = false): string[] {
		const measure = readerMeasure(paneWidth);
		const lines = markdown
			? renderMarkdownText(source, measure, this.theme)
			: wrapTextWithAnsi(cleanText(source), measure);
		return lines.map((line) => `${READER_GUTTER}${line}`);
	}
	private footer(width: number, groups: FooterAction[][], dismiss: FooterAction): string {
		return footerLine(width, groups, dismiss, this.footerStyles(), this.currentNotice());
	}
	private escapeAction(): FooterAction {
		if (this.view === "search") return { key: "esc", label: "clear" };
		if (this.page === "details" || this.view === "families" || this.view === "report" || this.view === "help")
			return { key: "esc", label: "back" };
		return { key: "esc", label: "close" };
	}
	private familySuffix(): string {
		const families = this.snapshot?.families ?? [];
		if (families.length <= 1) return "";
		const label = families.find((family) => family.id === this.familyId)?.label;
		return label ? ` · ${cleanLine(label)}` : "";
	}
	private statusMessage(): { text: string; fault: boolean } {
		if (this.mode === "overview") {
			const counts = new Map<string, number>();
			for (const record of this.roster) {
				const state = this.workerState(record);
				counts.set(state, (counts.get(state) ?? 0) + 1);
			}
			const states = [...counts].map(([state, count]) => `${count} ${state}`).join(" · ");
			const rows = this.rosterRows();
			const query = this.rosterSearch.getValue();
			return {
				text: `${query ? `${rows.length}/${this.roster.length} worker${this.roster.length === 1 ? "" : "s"} · /${cleanLine(query)}` : `${this.roster.length} worker${this.roster.length === 1 ? "" : "s"}`}${states ? ` · ${states}` : ""}${this.rosterLimited ? " · more records outside view limit" : ""}`,
				fault: false,
			};
		}
		if (this.historyError) return { text: this.historyStatus(), fault: true };
		if (this.historyPending) return { text: this.historyStatus(), fault: false };
		if (this.requestPending) return { text: "Refresh pending", fault: false };
		if (this.search.getValue()) return { text: `Search /${this.search.getValue()}`, fault: false };
		if (this.participantFilter)
			return { text: `filter ${this.participantLabel(this.participantFilter)}`, fault: false };
		const history = this.familyId ? this.retained.get(this.familyId)?.history : null;
		if (history) return { text: this.historyStatus(), fault: false };
		if (!this.evidenceMode && this.page !== "details") {
			const thread = this.currentThread();
			if (thread) {
				const last = thread.events.at(-1);
				return {
					text: `${thread.events.length} record${thread.events.length === 1 ? "" : "s"} · last ${last ? clockTime(last.timestamp) : "--:--:--"} · ${last?.exchange?.kind ?? last?.kind ?? "message"}`,
					fault: false,
				};
			}
			return {
				text: this.snapshot ? "No recorded conversations in this family." : "Loading conversations…",
				fault: false,
			};
		}
		const event = this.event();
		if (event)
			return {
				text: `${event.kind} · ${clockTime(event.timestamp)} · ${this.participantLabel(event.actorId)}`,
				fault: false,
			};
		return { text: this.historyStatus(), fault: Boolean(this.allNotices().length && this.historyError) };
	}
	private tree(): { participant: CollaborationParticipant; depth: number }[] {
		const participants = this.snapshot?.participants ?? [];
		const ids = new Set(participants.map((participant) => participant.id));
		const children = new Map<string | null, CollaborationParticipant[]>();
		for (const participant of participants) {
			const parent = participant.parentId && ids.has(participant.parentId) ? participant.parentId : null;
			children.set(parent, [...(children.get(parent) ?? []), participant]);
		}
		const out: { participant: CollaborationParticipant; depth: number }[] = [];
		const visited = new Set<string>();
		const stack = [...(children.get(null) ?? [])].reverse().map((participant) => ({ participant, depth: 0 }));
		while (stack.length) {
			const node = stack.pop();
			if (!node || visited.has(node.participant.id)) continue;
			visited.add(node.participant.id);
			out.push(node);
			for (const participant of [...(children.get(node.participant.id) ?? [])].reverse())
				stack.push({ participant, depth: node.depth + 1 });
		}
		for (const participant of participants) if (!visited.has(participant.id)) out.push({ participant, depth: 0 });
		return out;
	}
	private selectedWorker(): string | null {
		if (this.mode === "overview") return this.rosterId;
		if (!this.evidenceMode && this.page !== "details") {
			const event = this.event();
			return event?.workerId ?? (event ? this.participant(event.actorId)?.workerId : null) ?? null;
		}
		if (this.page === "tree" || (this.page === "details" && this.detailParticipant))
			return this.participant()?.workerId ?? null;
		const event = this.event();
		return event?.workerId ?? this.participant(event?.actorId)?.workerId ?? this.participant()?.workerId ?? null;
	}
	private selectEvent(event: CollaborationEvent | undefined): void {
		this.selectedEvent = event?.id ?? null;
		this.followEvents = false;
		this.detailParticipant = false;
		this.detailScroll = 0;
	}
	private returnLive(): void {
		this.followEvents = true;
		this.newEvents = 0;
		this.selectedEvent = this.events().at(-1)?.id ?? null;
		this.detailScroll = 0;
	}
	private selectFamily(id: string): void {
		this.requestVersion++;
		this.requestPending = false;
		this.historyPending = false;
		this.historyError = null;
		this.infoScroll = 0;
		this.familyId = id;
		this.snapshot = this.retained.get(id)?.snapshot ?? null;
		this.selectedParticipant = null;
		this.selectedEvent = null;
		this.participantFilter = null;
		this.search.setValue("");
		this.followEvents = true;
		this.newEvents = 0;
		this.eventStart = 0;
		this.detailScroll = 0;
		this.page = "timeline";
		this.view = "dashboard";
		void this.refresh(true);
	}
	private control(action: "interrupt" | "kill", id: string | null): void {
		if (!id || !this.deps.isLive(id)) {
			this.setNotice("This session does not own live control.");
			return;
		}
		const version = this.consoleVersion;
		void this.deps[action](id)
			.then((text) => {
				if (version === this.consoleVersion) this.setNotice(text);
			})
			.catch((error: unknown) => {
				if (version === this.consoleVersion) this.setNotice(`${action} failed: ${errText(error)}`);
			});
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.view === "console") {
			this.handleConsole(data);
			return;
		}
		if (this.view === "search") {
			const input = this.mode === "overview" ? this.rosterSearch : this.search;
			if (matchesKey(data, Key.escape)) {
				input.setValue("");
				this.view = "dashboard";
			} else if (matchesKey(data, Key.enter)) this.view = "dashboard";
			else this.inputData(input, data);
			if (this.mode === "overview") this.rosterId = this.rosterRows()[0]?.id ?? null;
			this.eventStart = 0;
			this.returnLive();
			this.bump();
			return;
		}
		const key = printableKey(data);
		if (this.view === "report" || this.view === "help") {
			if (matchesKey(data, Key.escape) || key === (this.view === "report" ? "n" : "?")) this.view = "dashboard";
			else if (key === "h" && this.view === "report") void this.refresh(true);
			else {
				const delta = matchesKey(data, Key.up)
					? -1
					: matchesKey(data, Key.down)
						? 1
						: matchesKey(data, Key.pageUp) || key === "b"
							? -this.windowHeight()
							: matchesKey(data, Key.pageDown) || key === " "
								? this.windowHeight()
								: 0;
				this.infoScroll = Math.max(
					0,
					Math.min(
						Math.max(0, this.infoLength - this.windowHeight()),
						matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? this.infoLength : this.infoScroll + delta,
					),
				);
			}
			this.bump();
			return;
		}
		if (key === "m" && this.view === "dashboard") {
			this.mode = this.mode === "overview" ? "communication" : "overview";
			this.page = "timeline";
			if (this.mode === "communication" && !this.snapshot) void this.refresh(false);
			this.bump();
			return;
		}
		if (this.mode === "overview") {
			this.handleOverview(data);
			this.bump();
			return;
		}
		if (this.view === "families") {
			const families = this.snapshot?.families ?? [];
			if (matchesKey(data, Key.escape)) this.view = "dashboard";
			else if (matchesKey(data, Key.up)) this.familyIndex = Math.max(0, this.familyIndex - 1);
			else if (matchesKey(data, Key.down)) this.familyIndex = Math.min(families.length - 1, this.familyIndex + 1);
			else if (matchesKey(data, Key.enter) && families[this.familyIndex])
				this.selectFamily(families[this.familyIndex].id);
			this.bump();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.page === "details") this.page = "timeline";
			else {
				this.dispose();
				this.close();
			}
			this.bump();
			return;
		}
		if (key === "e") {
			this.evidenceMode = !this.evidenceMode;
			this.page = "timeline";
			this.bump();
			return;
		}
		if (
			!this.evidenceMode &&
			this.page !== "details" &&
			(matchesKey(data, Key.tab) ||
				matchesKey(data, Key.shift("tab")) ||
				matchesKey(data, Key.up) ||
				matchesKey(data, Key.down) ||
				matchesKey(data, Key.pageUp) ||
				matchesKey(data, Key.pageDown) ||
				matchesKey(data, Key.home) ||
				matchesKey(data, Key.end) ||
				key === "b" ||
				key === " " ||
				matchesKey(data, Key.enter))
		) {
			this.navigateConversations(data);
			this.bump();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			const pages: FocusPage[] = ["timeline", "tree", "details"];
			const direction = matchesKey(data, Key.shift("tab")) ? -1 : 1;
			this.detailParticipant = this.page === "tree";
			this.page = pages[(pages.indexOf(this.page) + direction + pages.length) % pages.length];
			if (this.page === "details") {
				this.followEvents = false;
				this.detailScroll = 0;
			}
		} else if (key === "/") this.view = "search";
		else if (key === "F") {
			this.view = "families";
			this.familyIndex = Math.max(0, this.snapshot?.families.findIndex((family) => family.id === this.familyId) ?? 0);
		} else if (key === "h") void this.refresh(true);
		else if (key === "n" || key === "?") {
			this.view = key === "n" ? "report" : "help";
			this.infoScroll = 0;
		} else if (key === "l") this.returnLive();
		else if (key === "f") {
			if (!this.evidenceMode) this.setNotice("Filtering applies to raw evidence only. Press e first.");
			else {
				this.participantFilter = this.participantFilter ? null : this.selectedParticipant;
				this.eventStart = 0;
				this.returnLive();
			}
		} else if (key === "v") this.openConsole(this.selectedWorker());
		else if (key === "i" || matchesKey(data, Key.ctrl("c"))) this.control("interrupt", this.selectedWorker());
		else if (key === "k") this.control("kill", this.selectedWorker());
		else if (matchesKey(data, Key.enter)) {
			this.detailParticipant = this.page === "tree";
			this.page = "details";
			this.followEvents = false;
			this.detailScroll = 0;
		} else if (this.page === "details" && (key === "[" || key === "]")) this.followReply(key === "[");
		else this.navigate(data);
		this.bump();
	}
	private handleOverview(data: string): void {
		const key = printableKey(data);
		if (matchesKey(data, Key.escape)) {
			if (this.page === "details") this.page = "timeline";
			else {
				this.dispose();
				this.close();
			}
			return;
		}
		if (key === "?") {
			this.view = "help";
			this.infoScroll = 0;
		} else if (key === "a") {
			this.scope = this.scope === "children" ? "all" : "children";
			this.refreshRoster();
		} else if (key === "/") this.view = "search";
		else if (key === "i" || matchesKey(data, Key.ctrl("c"))) this.control("interrupt", this.rosterId);
		else if (key === "k") this.control("kill", this.rosterId);
		else if (matchesKey(data, Key.enter) || key === "v") this.openConsole(this.rosterId);
		else if (key === "d") {
			this.page = "details";
			this.detailScroll = 0;
		} else if (this.page === "details") this.navigate(data);
		else {
			const rows = this.rosterRows();
			const index = rows.findIndex((record) => record.id === this.rosterId);
			const delta = matchesKey(data, Key.up)
				? -1
				: matchesKey(data, Key.down)
					? 1
					: matchesKey(data, Key.pageUp)
						? -10
						: matchesKey(data, Key.pageDown)
							? 10
							: 0;
			this.rosterId =
				rows[
					Math.max(
						0,
						Math.min(
							rows.length - 1,
							matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? rows.length - 1 : index + delta,
						),
					)
				]?.id ?? null;
		}
	}
	private threads() {
		return conversationThreads(this.events());
	}
	private currentThread() {
		const threads = this.threads();
		return threads.find((thread) => thread.id === this.threadId) ?? threads[0];
	}
	private navigateConversations(data: string): void {
		const threads = this.threads();
		const current = this.currentThread();
		const key = printableKey(data);
		const previousEvent = this.event()?.id;
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.threadFocus = !this.threadFocus;
			this.selectedEvent = this.event()?.id ?? null;
			this.followEvents = false;
		} else if (
			matchesKey(data, Key.pageUp) ||
			matchesKey(data, Key.pageDown) ||
			matchesKey(data, Key.home) ||
			matchesKey(data, Key.end) ||
			key === "b" ||
			key === " "
		) {
			this.threadFocus = true;
			this.selectedEvent = this.event()?.id ?? null;
			this.followEvents = false;
			// Input can arrive again before Pi repaints the new selection or size.
			this.renderConversations(this.lastWidth, this.windowHeight());
			const max = Math.max(0, this.exchangeLength - this.exchangeRows);
			const delta = matchesKey(data, Key.pageUp) || key === "b" ? -this.exchangeRows : this.exchangeRows;
			this.exchangeScroll = Math.max(
				0,
				Math.min(max, matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? max : this.exchangeScroll + delta),
			);
		} else if (matchesKey(data, Key.enter)) {
			this.selectedEvent =
				current?.events.find((event) => event.id === this.selectedEvent)?.id ?? current?.events.at(-1)?.id ?? null;
			this.detailParticipant = false;
			this.page = "details";
			this.detailScroll = 0;
			this.followEvents = false;
		} else if (this.threadFocus) {
			const events = current?.events ?? [];
			const index = Math.max(
				0,
				events.findIndex((event) => event.id === this.event()?.id),
			);
			this.selectedEvent =
				events[Math.max(0, Math.min(events.length - 1, index + (matchesKey(data, Key.up) ? -1 : 1)))]?.id ?? null;
			this.followEvents = false;
		} else {
			const index = Math.max(
				0,
				threads.findIndex((thread) => thread.id === current?.id),
			);
			const thread = threads[Math.max(0, Math.min(threads.length - 1, index + (matchesKey(data, Key.up) ? -1 : 1)))];
			this.threadId = thread?.id ?? null;
			this.selectedEvent = thread?.events.at(-1)?.id ?? null;
			this.followEvents = false;
		}
		if (previousEvent !== this.event()?.id) {
			this.exchangeReadId = null;
			this.exchangeScroll = 0;
		}
	}
	private navigate(data: string): void {
		const delta = matchesKey(data, Key.up)
			? -1
			: matchesKey(data, Key.down)
				? 1
				: matchesKey(data, Key.pageUp)
					? -this.windowHeight()
					: matchesKey(data, Key.pageDown)
						? this.windowHeight()
						: 0;
		const home = matchesKey(data, Key.home),
			end = matchesKey(data, Key.end);
		if (!delta && !home && !end) return;
		if (this.page === "details")
			this.detailScroll = Math.max(
				0,
				Math.min(
					Math.max(0, this.detailLength - this.windowHeight()),
					home ? 0 : end ? this.detailLength : this.detailScroll + delta,
				),
			);
		else if (this.page === "tree") {
			const nodes = this.tree();
			const index = nodes.findIndex((node) => node.participant.id === this.selectedParticipant);
			this.selectedParticipant =
				nodes[Math.max(0, Math.min(nodes.length - 1, home ? 0 : end ? nodes.length - 1 : index + delta))]?.participant
					.id ?? null;
		} else {
			const events = this.events();
			if (end) this.returnLive();
			else
				this.selectEvent(
					events[
						Math.max(
							0,
							Math.min(
								events.length - 1,
								home ? 0 : events.findIndex((event) => event.id === this.selectedEvent) + delta,
							),
						)
					],
				);
		}
	}
	private followReply(parent: boolean): void {
		const event = this.event();
		if (!event) return;
		const target = this.snapshot?.events.find((candidate) =>
			parent
				? Boolean(event.replyTo && (candidate.messageId === event.replyTo || candidate.id === event.replyTo))
				: Boolean(candidate.replyTo && (candidate.replyTo === event.messageId || candidate.replyTo === event.id)),
		);
		if (!target) {
			this.setNotice("The reply link is not in this snapshot. Press h to load history.");
			return;
		}
		this.selectEvent(target);
	}
	private inputData(input: Input, data: string): void {
		input.handleInput(data);
		const value = input.getValue();
		const clean = cleanLine(value);
		if (clean !== value) input.setValue(clean);
	}

	private openConsole(id: string | null): void {
		if (!id || !this.deps.readWorker(id)) {
			this.setNotice("No worker transcript is available for this selection.");
			return;
		}
		this.consoleVersion++;
		this.pinnedId = id;
		this.view = "console";
		this.consolePage = "chat";
		this.composing = false;
		this.selectedSectionId = null;
		this.sectionExpansion.clear();
		this.pagePositions.clear();
		this.transcriptCache = null;
		this.scroll = 0;
		this.followTail = true;
		this.continuationPending = this.pendingRequests.get(id) === "continue";
		this.sendPending = this.pendingRequests.get(id) === "send";
		this.continuing = this.continuationPending;
		this.composer.setValue("");
		this.contentVersion++;
		this.unsub?.();
		this.unsub = this.deps.subscribeLive(id, () => {
			this.contentVersion++;
			this.bump();
		});
		this.bump();
	}
	private closeConsole(): void {
		if (this.mode === "overview") {
			this.rosterId = this.pinnedId;
			this.refreshRoster();
		}
		this.consoleVersion++;
		this.unsub?.();
		this.unsub = null;
		this.pinnedId = null;
		this.continuing = false;
		this.continuationPending = false;
		this.sendPending = false;
		this.view = "dashboard";
		this.bump();
	}
	private transcriptLines(): string[] {
		const id = this.pinnedId;
		const record = id ? this.deps.readWorker(id) : null;
		// Terminal settlement can outlive the last runtime watcher notification.
		const revision = `${record?.state}:${record?.exitedAt}:${record?.resultBytes}:${record?.stopReason}`;
		const conversationKey = `${this.contentVersion}:${id}:${revision}`;
		const layout = `${this.lastWidth}:${this.consolePage}:${this.expandedTools}:${this.showThinking}:${this.expansionRevision}`;
		const key = `${conversationKey}:${layout}:${this.selectedSectionId}`;
		if (this.transcriptCache?.key === key) return this.transcriptCache.value.lines;
		const anchor =
			!this.followTail && this.transcriptCache ? transcriptAnchor(this.transcriptCache.value, this.scroll) : null;
		if (this.conversationCache?.key !== conversationKey) {
			this.conversationCache = {
				key: conversationKey,
				messages: normalizeMessages(id ? (this.deps.conversation(id) ?? []) : []),
				report: id ? this.deps.report(id) : null,
			};
		}
		const { messages, report } = this.conversationCache;
		let document: TranscriptDocument;
		if (this.consolePage === "chat") {
			document = renderTranscript(messages, {
				width: this.lastWidth,
				theme: this.theme,
				expandedTools: this.expandedTools,
				showThinking: this.showThinking,
				sectionExpansion: this.sectionExpansion,
				selectedSectionId: this.selectedSectionId,
				toolHint: this.bindingText("app.tools.expand", "ctrl+o"),
				thinkingHint: this.bindingText("app.thinking.toggle", "ctrl+t"),
			});
			if (!document.lines.length) document.lines.push(plainLine(" No conversation recorded yet.", this.lastWidth));
		} else {
			const lines =
				this.consolePage === "report"
					? report
						? [
								...this.gutterWrap(report.label, this.lastWidth),
								"",
								...this.gutterWrap(report.text, this.lastWidth, true),
							]
						: [" No submitted report is available. Chat retains the recorded work."]
					: this.workerDetails(record, this.lastWidth);
			document = { lines: lines.map((line) => plainLine(line, this.lastWidth)), sections: [] };
		}
		if (anchor) {
			if (this.transcriptCache?.layout === layout) {
				const oldSection = this.transcriptCache.value.sections.find((section) => section.id === anchor.id);
				const newSection = document.sections.find((section) => section.id === anchor.id);
				if (oldSection && newSection)
					this.scroll =
						newSection.start + Math.min(this.scroll - oldSection.start, newSection.end - newSection.start - 1);
			} else this.scroll = restoreTranscriptAnchor(document, anchor) ?? this.scroll;
		}
		this.transcriptCache = { key, layout, value: document };
		return document.lines;
	}
	private bindingText(action: "app.tools.expand" | "app.thinking.toggle", fallback: string): string {
		return this.keybindings ? this.keybindings.getKeys(action).join("/") || "unbound" : fallback;
	}
	private switchConsolePage(direction: number): void {
		this.pagePositions.set(this.consolePage, { scroll: this.scroll, follow: this.followTail });
		const pages = ["chat", "report", "details"] as const;
		this.consolePage = pages[(pages.indexOf(this.consolePage) + direction + pages.length) % pages.length];
		const position = this.pagePositions.get(this.consolePage);
		this.scroll = position?.scroll ?? 0;
		this.followTail = position?.follow ?? false;
		this.transcriptCache = null;
		this.bump();
	}
	private currentSection() {
		const sections = this.transcriptCache?.value.sections ?? [];
		return (
			sections.find((section) => section.id === this.selectedSectionId) ??
			sections.find((section) => section.start <= this.scroll && section.end > this.scroll) ??
			sections.find((section) => section.start >= this.scroll)
		);
	}
	private handleConsole(data: string): void {
		const id = this.pinnedId;
		const record = id ? this.deps.readWorker(id) : null;
		const live = Boolean(id && this.deps.isLive(id));
		const terminal = Boolean(record && record.state !== "running");
		const key = printableKey(data);
		if (matchesKey(data, Key.escape)) {
			if (this.continuationPending) {
				this.closeConsole();
				this.setNotice("Continuation remains active. Escape closed only the view.");
			} else if (this.continuing) {
				this.continuing = false;
				this.composer.setValue("");
				this.bump();
			} else if (this.composing) {
				this.composing = false;
				this.bump();
			} else this.closeConsole();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.switchConsolePage(matchesKey(data, Key.tab) ? 1 : -1);
			return;
		}
		if (
			this.consolePage === "chat" &&
			(this.keybindings ? this.keybindings.matches(data, "app.tools.expand") : matchesKey(data, Key.ctrl("o")))
		) {
			this.expandedTools = !this.expandedTools;
			for (const section of this.transcriptCache?.value.sections ?? [])
				if (section.kind === "tool") this.sectionExpansion.delete(section.id);
			this.bump();
			return;
		}
		if (
			this.consolePage === "chat" &&
			(this.keybindings ? this.keybindings.matches(data, "app.thinking.toggle") : matchesKey(data, Key.ctrl("t")))
		) {
			this.showThinking = !this.showThinking;
			for (const section of this.transcriptCache?.value.sections ?? [])
				if (section.kind === "reasoning") this.sectionExpansion.delete(section.id);
			this.bump();
			return;
		}
		if (key === "x" && !this.composing && !this.continuing && this.consolePage === "chat") {
			this.transcriptLines();
			const section = this.currentSection();
			if (section?.expanded !== undefined) {
				this.selectedSectionId = section.id;
				this.scroll = section.start;
				this.sectionExpansion.set(section.id, !section.expanded);
				this.expansionRevision++;
				this.followTail = false;
			} else this.setNotice("Use alt+up/down to reach a tool or reasoning block, then x to expand it.");
			this.bump();
			return;
		}
		if (matchesKey(data, Key.alt("up")) || matchesKey(data, Key.alt("down"))) {
			this.transcriptLines();
			const sections = this.transcriptCache?.value.sections ?? [];
			const current = this.currentSection();
			const at = Math.max(
				0,
				sections.findIndex((section) => section.id === current?.id),
			);
			const section =
				sections[Math.max(0, Math.min(sections.length - 1, at + (matchesKey(data, Key.alt("up")) ? -1 : 1)))];
			if (section) {
				this.selectedSectionId = section.id;
				this.scroll = section.start;
				this.followTail = false;
			}
			this.bump();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.control("interrupt", id);
			return;
		}
		if (matchesKey(data, Key.ctrl("k"))) {
			this.control("kill", id);
			return;
		}
		if (!this.continuing && terminal && record?.sessionFile && key.toLowerCase() === "c") {
			const version = this.consoleVersion,
				command = reopenCommand(record.sessionFile);
			(this.deps.copyText ?? copyToClipboard)(command, (error) => {
				if (version === this.consoleVersion) this.setNotice(error ? `copy failed: ${error}` : `copied: ${command}`);
			});
			return;
		}
		if (!this.continuing && terminal && record?.sessionFile && key.toLowerCase() === "r") {
			this.continuing = true;
			this.consolePage = "chat";
			this.transcriptCache = null;
			this.composer.setValue("");
			this.bump();
			return;
		}
		if (
			this.consolePage === "chat" &&
			(this.composing || this.continuing) &&
			!matchesKey(data, Key.pageUp) &&
			!matchesKey(data, Key.pageDown)
		) {
			if (this.sendPending || this.continuationPending) return;
			if (matchesKey(data, Key.enter)) void this.submitDraft();
			else this.inputData(this.composer, data);
			this.bump();
			return;
		}
		const delta = matchesKey(data, Key.up)
			? -1
			: matchesKey(data, Key.down)
				? 1
				: matchesKey(data, Key.pageUp) || (!this.composing && !this.continuing && key === "b")
					? -this.windowHeight()
					: matchesKey(data, Key.pageDown) || (!this.composing && !this.continuing && key === " ")
						? this.windowHeight()
						: 0;
		if (delta || matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
			this.selectedSectionId = null;
			const max = Math.max(0, this.transcriptLines().length - this.windowHeight());
			this.scroll = Math.max(
				0,
				Math.min(max, matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? max : this.scroll + delta),
			);
			this.followTail = matchesKey(data, Key.end) || (delta > 0 && this.scroll === max);
			this.bump();
			return;
		}
		if (this.consolePage !== "chat" || (!live && !this.continuing)) return;
		if (this.sendPending || this.continuationPending) return;
		if (matchesKey(data, Key.enter)) {
			this.composing = true;
			this.bump();
			return;
		}
		if (!data.startsWith("\x1b") || data.startsWith("\x1b[200~") || decodeKittyPrintable(data)) this.composing = true;
		if (this.composing) this.inputData(this.composer, data);
		this.bump();
	}
	private async submitDraft(): Promise<void> {
		const id = this.pinnedId,
			text = this.composer.getValue().trim();
		if (!id || !text || this.sendPending || this.continuationPending || this.pendingRequests.has(id)) return;
		const version = this.consoleVersion;
		this.pendingRequests.set(id, this.continuing ? "continue" : "send");
		if (this.continuing) this.continuationPending = true;
		else this.sendPending = true;
		this.bump();
		try {
			if (this.continuing) {
				const outcome = await this.deps.continueWorker(id, text);
				if (this.disposed || version !== this.consoleVersion) return;
				if (outcome.id) this.openConsole(outcome.id);
				this.setNotice(outcome.text);
			} else {
				const outcome = await this.deps.sendLive(id, text);
				if (this.disposed || version !== this.consoleVersion) return;
				if (outcome.ok) {
					this.composer.setValue("");
					this.composing = false;
				}
				this.setNotice(outcome.text);
			}
		} catch (error) {
			if (version === this.consoleVersion) this.setNotice(`Request failed: ${errText(error)}`);
		} finally {
			this.pendingRequests.delete(id);
			if (this.pinnedId === id) {
				this.sendPending = false;
				this.continuationPending = false;
				this.bump();
			}
		}
	}

	invalidate(): void {
		this.transcriptCache = null;
		this.search.invalidate();
		this.rosterSearch.invalidate();
		this.composer.invalidate();
	}
	dispose(): void {
		this.disposed = true;
		this.requestVersion++;
		this.consoleVersion++;
		this.unsub?.();
		this.unsub = null;
	}
	private panelHeight(): number {
		const maximum = Math.max(1, this.paneCap() - (this.framed ? 3 : 0));
		if (this.mode === "overview" && (this.view === "dashboard" || this.view === "search") && this.page !== "details") {
			const rows = this.rosterRows();
			if (!rows.length) return Math.min(maximum, 5);
			if (this.lastWidth < 100) return Math.min(maximum, rows.length * 2 + 8);
			const record = rows.find((item) => item.id === this.rosterId) ?? rows[0];
			const listWidth = threadPaneWidth(this.lastWidth);
			const preview = this.workerSummary(record, this.lastWidth - listWidth - 3, Math.max(1, maximum - 3));
			return Math.min(
				maximum,
				Math.max(12, rows.length * 2 + 3, preview.length + 3) + (this.view === "search" ? 1 : 0),
			);
		}
		if (this.view === "dashboard" && this.page === "details")
			return Math.min(
				maximum,
				Math.max(
					8,
					this.mode === "overview"
						? this.overviewDetails(this.lastWidth).length + 3
						: this.details(this.lastWidth).length + 4,
				),
			);
		if (this.mode === "communication" && this.view === "dashboard" && !this.evidenceMode) {
			return maximum;
		}
		return maximum;
	}
	private chromeRows(): number {
		if (this.view === "console") return this.compact() ? 3 : 4;
		if (
			this.mode === "communication" &&
			this.view === "dashboard" &&
			!this.evidenceMode &&
			this.page !== "details" &&
			this.panelHeight() < 6
		)
			return 1;
		if (this.compact()) return this.view === "search" ? 3 : 2;
		if (this.mode === "overview" && this.view !== "help") return 3;
		return 3;
	}
	private windowHeight(): number {
		return Math.max(1, this.panelHeight() - this.chromeRows());
	}
	render(width: number): string[] {
		if (width <= 0) return [];
		this.framed = width >= 12 && this.paneCap() >= 10;
		this.lastWidth = this.framed ? width - 4 : width;
		const contentWidth = this.lastWidth;
		try {
			if (this.view === "console" && this.pinnedId && !this.deps.readWorker(this.pinnedId)) {
				const id = this.pinnedId;
				this.closeConsole();
				this.setNotice(`Worker ${id} is no longer in the store.`);
			}
			this.syncFocus();
			if (this.panelHeight() < 4 || contentWidth < 8) {
				const input = this.search.focused
					? this.search
					: this.rosterSearch.focused
						? this.rosterSearch
						: this.composer.focused
							? this.composer
							: null;
				const height = this.panelHeight();
				const footer = this.footer(
					contentWidth,
					[],
					this.view === "console" ? { key: "esc", label: "back" } : this.escapeAction(),
				);
				if (input && height === 1) {
					const hint = contentWidth >= 8 ? " esc" : "";
					return this.frame(
						[plainLine(`${input.render(Math.max(1, contentWidth - hint.length))[0] ?? ""}${hint}`, contentWidth)],
						width,
					);
				}
				return this.frame(
					[
						...(height > 1
							? [
									input
										? plainLine(input.render(contentWidth)[0] ?? "", contentWidth)
										: plainLine("Subagents · enlarge terminal to read", contentWidth),
								]
							: []),
						footer,
					],
					width,
				);
			}
			const lines =
				this.view === "console"
					? this.renderConsole(contentWidth)
					: this.mode === "overview" && this.view !== "help"
						? this.renderOverview(contentWidth)
						: this.renderDashboard(contentWidth);
			const height = this.panelHeight();
			const bounded = lines.length <= height ? lines : [...lines.slice(0, height - 1), lines.at(-1) ?? ""];
			return this.frame(bounded, width);
		} catch (error) {
			return this.frame(
				[
					plainLine(`subagent: render error: ${cleanLine(errText(error))}`, contentWidth),
					plainLine("esc close", contentWidth),
				],
				width,
			).slice(0, this.paneCap());
		}
	}
	private frame(lines: string[], width: number): string[] {
		const paint = (line: string) => this.background("customMessageBg", this.theme.fg("text", plainLine(line, width)));
		if (!this.framed) return lines.map(paint);
		const border = (text: string) => this.theme.fg("borderMuted", text);
		const title = clipText(" Subagents ", width - 4);
		const row = (line: string) => paint(`${border("│ ")}${plainLine(line, width - 4)}${border(" │")}`);
		return [
			paint(
				`${border("┌─")}${this.theme.bold(this.theme.fg("accent", title))}${border(`${"─".repeat(Math.max(0, width - visibleWidth(title) - 3))}┐`)}`,
			),
			...lines.slice(0, -1).map(row),
			paint(border(`├${"─".repeat(width - 2)}┤`)),
			row(lines.at(-1) ?? ""),
			paint(border(`└${"─".repeat(width - 2)}┘`)),
		];
	}
	private overviewDetails(width: number): string[] {
		return this.workerDetails(this.roster.find((row) => row.id === this.rosterId) ?? null, width);
	}
	private workerDetails(record: WorkerRecord | null, width: number): string[] {
		const details = record
			? [
					`WORKER ${record.id}`,
					`Label: ${record.label || "not recorded"}`,
					`Model: ${record.model} [${record.thinking}]`,
					`Elapsed: ${this.workerElapsed(record)} · Cost: ${this.workerCost(record)}`,
					`State: ${record.state}${record.interruptedAt ? " (paused)" : ""}`,
					`Owner: ${record.ownerSession ?? "not recorded"}`,
					`Current tool: ${record.currentTool ?? "none"}`,
					`Session: ${record.sessionFile ?? "unavailable"}`,
					"",
					"TASK",
					record.task,
					"",
					"LATEST OUTPUT (worker-authored, unverified)",
					rosterOutputPreview(record),
				]
			: ["No worker selected."];
		return details.flatMap((line) => this.gutterWrap(line, width));
	}
	private workerElapsed(record: WorkerRecord): string {
		return formatPanelElapsed(((record.exitedAt ?? Date.now()) - record.startedAt) / 1000);
	}
	private workerCost(record: WorkerRecord): string {
		return typeof record.usage?.cost === "number" && Number.isFinite(record.usage.cost)
			? `$${record.usage.cost.toFixed(2)}`
			: "n/a";
	}
	private workerState(record: WorkerRecord): string {
		if (record.state === "running") {
			if (record.interruptedAt) return "paused";
			return record.idleSince != null ? "idle" : "active";
		}
		return record.state === "no_result_submitted"
			? "no result"
			: record.state === "owner_lost"
				? "owner lost"
				: record.state;
	}
	private stateText(record: WorkerRecord): string {
		const state = this.workerState(record);
		return this.theme.fg(
			state === "failed"
				? "error"
				: state === "paused" || state === "owner lost" || state === "no result"
					? "warning"
					: state === "active"
						? "accent"
						: "text",
			state,
		);
	}
	private workerSummary(record: WorkerRecord, width: number, height: number): string[] {
		const lines: string[] = [];
		const add = (text: string, maxRows: number, style: "text" | "muted" | "accent" = "text") => {
			const wrapped = wrapTextWithAnsi(cleanText(text), Math.max(1, width - 2));
			for (const [index, line] of wrapped.slice(0, maxRows).entries())
				lines.push(
					plainLine(
						` ${this.theme.fg(style, index === maxRows - 1 && wrapped.length > maxRows ? clipText(`${line} …`, width - 2) : line)}`,
						width,
					),
				);
		};
		add(this.rosterLabel(record), Math.min(2, Math.max(1, height - 4)), "accent");
		add(
			`${this.workerState(record)} · ${record.model} · ${record.thinking || "off"} · ${this.workerElapsed(record)} · ${this.workerCost(record)}`,
			Math.min(2, Math.max(0, height - lines.length - 3)),
			"text",
		);
		if (this.scope === "all" && height - lines.length >= 4)
			add(`Owner: ${record.ownerSession ?? "unknown"}`, 1, "muted");
		if (record.currentTool && height - lines.length >= 4) add(`Tool: ${record.currentTool}`, 1, "muted");
		add(`Task: ${record.task}`, Math.min(3, Math.max(0, height - lines.length - 2)));
		if (lines.length < height - 1) {
			lines.push(plainLine(this.theme.fg("muted", " Latest output · unverified"), width));
			const output =
				record.error && record.state === "failed"
					? record.error
					: (record.resultPreview ?? record.lastOutput ?? "No output yet.");
			const body = renderMarkdownText(output, Math.max(1, Math.min(96, width - 2)), this.theme);
			const available = Math.max(0, height - lines.length);
			const room = body.length <= available || available <= 1 ? available : available - 1;
			lines.push(
				...body
					.slice(0, room)
					.map((line, index) =>
						plainLine(
							` ${available === 1 && index === 0 && body.length > 1 ? clipText(`${line} …`, width - 1) : line}`,
							width,
						),
					),
			);
			if (body.length > room && available > 1)
				lines.push(plainLine(this.theme.fg("muted", " Enter opens the worker view"), width));
		}
		return lines.slice(0, height);
	}
	private renderOverview(width: number): string[] {
		const rows = this.rosterRows();
		const selected = Math.max(
			0,
			rows.findIndex((record) => record.id === this.rosterId),
		);
		const record = rows[selected];
		const compact = this.compact();
		const height = this.panelHeight();
		const scope = this.scope === "children" && this.deps.currentSessionId() ? "DIRECT CHILDREN" : "ALL SESSIONS";
		const position = rows.length ? `${selected + 1}/${rows.length}` : "";
		const lines = [headerPair(width, this.theme.bold(`OVERVIEW · ${scope}`), this.theme.fg("text", position))];
		if (!compact) lines.push(plainLine(this.theme.fg("muted", cleanLine(this.statusMessage().text)), width));
		const available = Math.max(0, height - lines.length - 1 - (this.view === "search" ? 1 : 0));
		if (this.page === "details") {
			const body = this.overviewDetails(width);
			this.detailLength = body.length;
			this.detailScroll = Math.min(this.detailScroll, Math.max(0, body.length - available));
			lines.push(...body.slice(this.detailScroll, this.detailScroll + available).map((line) => plainLine(line, width)));
		} else if (!record) {
			const empty = this.rosterSearch.getValue()
				? "No matching workers. Press / then Escape to clear."
				: this.scope === "children"
					? "No direct children in this session. Press a for all sessions."
					: "No known workers in the store.";
			lines.push(
				...wrapTextWithAnsi(empty, Math.max(1, width))
					.slice(0, available)
					.map((line) => plainLine(line, width)),
			);
		} else {
			const split = width >= 100;
			const listWidth = threadPaneWidth(width);
			const previewRows = split ? 0 : Math.min(compact ? 2 : 4, Math.max(0, available - 2));
			const rowHeight = compact ? 1 : 2;
			const listHeight = available - previewRows;
			const capacity = Math.max(1, Math.floor(listHeight / rowHeight));
			const start = Math.max(0, Math.min(selected - Math.floor(capacity / 2), rows.length - capacity));
			const left: string[] = [];
			for (const item of rows.slice(start, start + capacity)) {
				const current = item.id === this.rosterId;
				const identity = cleanLine(this.rosterLabel(item));
				const name = current ? this.theme.bold(identity) : identity;
				const model = cleanLine(item.model.split("/").at(-1) ?? item.model);
				const row = compact
					? headerPair(listWidth, `${current ? "›" : " "} ${name}`, this.stateText(item))
					: clipText(`${current ? "›" : " "} ${name}`, listWidth);
				left.push(this.paintSelected(plainLine(row, listWidth), current));
				if (rowHeight === 2)
					left.push(
						plainLine(
							this.theme.fg(
								current ? "text" : "muted",
								clipText(
									`  ${this.workerState(item)} · ${model} · ${this.workerElapsed(item)} · ${this.workerCost(item)}`,
									listWidth,
								),
							),
							listWidth,
						),
					);
			}
			while (left.length < listHeight) left.push(plainLine("", listWidth));
			if (split) {
				const rightWidth = width - listWidth - 3;
				const right = this.workerSummary(record, rightWidth, available);
				for (let index = 0; index < available; index++)
					lines.push(
						`${left[index] ?? plainLine("", listWidth)} ${this.theme.fg("borderMuted", "│")} ${right[index] ?? plainLine("", rightWidth)}`,
					);
			} else {
				lines.push(...left.slice(0, listHeight));
				const summary = [
					...(this.scope === "all" && previewRows >= 3
						? [clipText(`Owner: ${cleanLine(record.ownerSession ?? "unknown")}`, width)]
						: []),
					...wrapTextWithAnsi(`Task: ${cleanLine(record.task)}`, Math.max(1, width)).slice(
						0,
						Math.max(1, previewRows - 1 - (this.scope === "all" && previewRows >= 3 ? 1 : 0)),
					),
					clipText(
						`Latest · unverified: ${renderMarkdownText(record.resultPreview ?? record.lastOutput ?? record.error ?? "No output yet.", Math.max(1, width - 21), this.theme).find((line) => line.trim()) ?? "No output yet."}`,
						width,
					),
				];
				lines.push(...summary.slice(0, previewRows).map((line) => plainLine(line, width)));
			}
		}
		while (lines.length < height - 1 - (this.view === "search" ? 1 : 0)) lines.push(plainLine("", width));
		if (this.view === "search") lines.push(plainLine(this.rosterSearch.render(width)[0] ?? "", width));
		lines.push(
			this.footer(
				width,
				this.view === "search"
					? [[{ key: "enter", label: "keep filter" }]]
					: this.page === "details"
						? [
								[
									{ key: "↑↓", label: "scroll" },
									{ key: "pgup/pgdn", label: "page" },
								],
								[
									{ key: "enter", label: "open" },
									{ key: "?", label: "help" },
								],
							]
						: [
								[
									{ key: "↑↓", label: "select" },
									{ key: "enter", label: "open" },
									{ key: "/", label: "search" },
								],
								[
									{ key: "a", label: "scope" },
									{ key: "m", label: "comms" },
									{ key: "d", label: "details" },
									{ key: "?", label: "help" },
								],
								...(record && this.deps.isLive(record.id)
									? [
											[
												{ key: "i", label: "interrupt" },
												{ key: "k", label: "cancel" },
											],
										]
									: []),
							],
				this.escapeAction(),
			),
		);
		return lines;
	}
	private dashboardFooterGroups(): FooterAction[][] {
		if (this.view === "search") return [[{ key: "enter", label: "keep filter" }]];
		if (this.view === "report" || this.view === "help")
			return [
				[
					{ key: "↑↓", label: "scroll" },
					{ key: "b/space", label: "page" },
				],
				[],
				[],
			];
		if (this.view === "families") return [[{ key: "↑↓", label: "family" }], [{ key: "enter", label: "load" }], []];
		if (this.page === "details")
			return [
				[
					{ key: "↑↓", label: "scroll" },
					{ key: "[", label: "parent" },
					{ key: "]", label: "reply" },
				],
				[{ key: "?", label: "help" }],
				[],
			];
		if (!this.evidenceMode)
			return [
				[
					{ key: "tab", label: "focus" },
					{ key: "↑↓", label: this.threadFocus ? "message" : "thread" },
					{ key: "b/space", label: "page" },
				],
				[
					{ key: "enter", label: "source" },
					{ key: "?", label: "help" },
					{ key: "m", label: "overview" },
				],
				[
					{ key: "i", label: "interrupt" },
					{ key: "k", label: "cancel" },
				],
			];
		return [
			[
				{ key: "tab", label: "focus" },
				{ key: "l", label: "follow" },
			],
			[
				{ key: "enter", label: "details" },
				{ key: "?", label: "help" },
				{ key: "e", label: "conversations" },
				{ key: "f", label: "filter" },
				{ key: "m", label: "overview" },
			],
			[
				{ key: "i", label: "interrupt" },
				{ key: "k", label: "cancel" },
			],
		];
	}
	private readerIdentity(): string {
		if (this.detailParticipant) {
			const participant = this.participant();
			return participant
				? cleanLine(`${this.participantLabel(participant.id)} · ${participant.state}`)
				: "No participant selected";
		}
		const event = this.event();
		if (!event) return "No event selected";
		return cleanLine(
			`${this.participantLabel(event.actorId)} → ${this.participantLabel(event.recipientId ?? "unknown recipient")} · ${event.kind} · ${event.kind.startsWith("call ") ? "send attempt" : "recorded"} · ${clockTime(event.timestamp)}`,
		);
	}
	private renderDashboard(width: number): string[] {
		const compact = this.compact();
		const overviewHelp = this.mode === "overview";
		const detailsReader = this.mode === "communication" && this.page === "details" && this.view === "dashboard";
		const height = this.windowHeight();
		const body: string[] = [];
		if (this.view === "report" || this.view === "help") {
			const info = this.infoLines(width);
			this.infoLength = info.length;
			this.infoScroll = Math.min(this.infoScroll, Math.max(0, info.length - height));
			for (let i = 0; i < height; i++) body.push(info[this.infoScroll + i] ?? plainLine("", width));
		} else if (this.view === "families") {
			const families = this.snapshot?.families ?? [];
			const start = Math.max(0, this.familyIndex - height + 2);
			body.push(plainLine("Families · Enter loads selected history", width));
			for (let i = 0; i < height - 1; i++) {
				const family = families[start + i];
				body.push(
					plainLine(
						family
							? `${start + i === this.familyIndex ? "›" : " "} ${cleanLine(family.label)} · ${cleanLine(family.id)}`
							: "",
						width,
					),
				);
			}
		} else if (this.page === "details") {
			const details = this.mode === "overview" ? this.overviewDetails(width) : this.details(width);
			this.detailLength = details.length;
			this.detailScroll = Math.min(this.detailScroll, Math.max(0, details.length - height));
			for (let i = 0; i < height; i++) body.push(details[this.detailScroll + i] ?? plainLine("", width));
		} else if (!this.evidenceMode) {
			body.push(...this.renderConversations(width, height));
		} else if (width >= 100) {
			const treeWidth = Math.min(52, Math.floor(width * 0.36)),
				timelineWidth = width - treeWidth - 3;
			const tree = this.renderTree(treeWidth, height),
				timeline = this.renderTimeline(timelineWidth, height);
			for (let i = 0; i < height; i++) body.push(`${tree[i]} ${this.theme.fg("borderMuted", "│")} ${timeline[i]}`);
		} else body.push(...(this.page === "tree" ? this.renderTree(width, height) : this.renderTimeline(width, height)));
		const identity = detailsReader ? this.readerIdentity() : "";
		const position =
			detailsReader || this.view === "report" || this.view === "help"
				? positionLabel(
						detailsReader ? this.detailScroll : this.infoScroll,
						height,
						detailsReader ? this.detailLength : this.infoLength,
					)
				: "";
		const right = detailsReader
			? `${position}  esc back`
			: this.view === "report" || this.view === "help"
				? `${position}  esc back`
				: overviewHelp
					? ""
					: "m overview";
		const left =
			this.view === "help"
				? overviewHelp
					? "OVERVIEW HELP"
					: "COMMUNICATIONS HELP"
				: this.view === "report"
					? `SOURCE REPORT${this.familySuffix()}`
					: this.view === "families"
						? `FAMILIES${this.familySuffix()}`
						: compact && detailsReader
							? identity
							: detailsReader
								? `SOURCE DETAILS${this.familySuffix()}`
								: !this.evidenceMode && this.page !== "details"
									? `COMMUNICATIONS${this.familySuffix()}`
									: `${this.evidenceMode ? "EVIDENCE" : "SOURCE DETAILS"} · ${this.followEvents ? "FOLLOW TAIL" : `BROWSE · ${this.newEvents} new · l follow`} · ${this.page}${this.familySuffix()}`;
		const lines =
			this.chromeRows() === 1
				? []
				: [headerPair(width, this.theme.fg("accent", this.theme.bold(cleanLine(left))), this.theme.fg("muted", right))];
		if (this.view === "search") lines.push(this.search.render(width)[0]);
		else if (!compact) {
			if (detailsReader) lines.push(plainLine(this.theme.fg("text", identity), width));
			else if (overviewHelp)
				lines.push(
					plainLine(
						this.theme.fg(
							"muted",
							`${this.roster.length} worker records · ${this.scope === "children" ? "direct children · a shows all sessions" : "all sessions · a returns to direct children"}`,
						),
						width,
					),
				);
			else {
				const status = this.statusMessage();
				lines.push(plainLine(this.theme.fg(status.fault ? "warning" : "muted", cleanLine(status.text)), width));
			}
		}
		lines.push(...body);
		lines.push(this.footer(width, this.dashboardFooterGroups(), this.escapeAction()));
		return lines;
	}
	private renderConversations(width: number, height: number): string[] {
		const threads = this.threads();
		const thread = this.currentThread();
		if (!thread)
			return [
				plainLine(this.snapshot ? "No recorded conversations in this family." : "Loading conversations…", width),
				plainLine("F selects a family; h reads known history; n explains source limits.", width),
				...Array.from({ length: Math.max(0, height - 2) }, () => plainLine("", width)),
			].slice(0, height);
		const wide = width >= 100;
		const leftWidth = threadPaneWidth(width);
		const rightWidth = wide ? width - leftWidth - 3 : width;
		const selected = Math.max(
			0,
			threads.findIndex((item) => item.id === thread.id),
		);
		const manager = this.managerId();
		const commonManager = manager !== undefined && threads.every((item) => item.participants.includes(manager));
		const left = [plainLine(this.theme.bold(`CONVERSATIONS · ${threads.length}`), leftWidth)];
		const capacity = Math.max(1, Math.floor((height - 1) / 2));
		const start = Math.max(0, selected - capacity + 1);
		for (const item of threads.slice(start, start + capacity)) {
			const current = item.id === thread.id;
			const name = clipText(`${current ? "›" : " "} ${cleanLine(this.threadLabel(item, commonManager))}`, leftWidth);
			const last = item.events.at(-1)!;
			left.push(
				this.paintSelected(
					plainLine(current ? this.theme.bold(this.theme.fg("accent", name)) : name, leftWidth),
					current,
				),
			);
			left.push(
				plainLine(
					this.theme.fg(
						"muted",
						clipText(
							`  ${item.events.length} record${item.events.length === 1 ? "" : "s"} · ${clockTime(last.timestamp)}`,
							leftWidth,
						),
					),
					leftWidth,
				),
			);
		}
		const event = thread.events.find((item) => item.id === this.selectedEvent) ?? thread.events.at(-1)!;
		if (this.exchangeReadId !== event.id) {
			this.exchangeReadId = event.id;
			this.exchangeScroll = 0;
		}
		const direction = this.directionMark(event);
		const glyph = direction === "in" ? "←" : direction === "out" ? "→" : "↔";
		const who = cleanLine(
			`${this.participantLabel(event.actorId)} → ${this.participantLabel(event.recipientId ?? "unknown recipient")}`,
		);
		const count = `${thread.events.indexOf(event) + 1}/${thread.events.length}`;
		const attempt = event.kind.startsWith("call ") ? "send attempt" : "recorded";
		const conflict = event.kind === "peer conflicting envelope";
		const provenance = cleanLine(
			`unverified · ${attempt}${conflict ? " · Conflicting envelope evidence" : ""} · ${clockTime(event.timestamp)} · ${event.exchange?.kind ?? event.kind}`,
		);
		if (height < 4) {
			const body = this.gutterWrap(event.exchange?.text ?? event.text, rightWidth, true);
			this.exchangeLength = body.length;
			this.exchangeRows = 1;
			this.exchangeScroll = Math.min(this.exchangeScroll, Math.max(0, body.length - 1));
			const compact = [
				headerPair(width, who, `${count} · ${positionLabel(this.exchangeScroll, 1, body.length)}`),
				plainLine(clipText(provenance, width), width),
				plainLine(body[this.exchangeScroll] ?? "", width),
			];
			return compact.slice(0, height);
		}
		const titleRows = height >= 8 ? 1 : 0;
		const headerRows = Math.max(1, Math.min(3, height - titleRows - 3));
		const header = wrapTextWithAnsi(who, Math.max(1, rightWidth - 3));
		const right = titleRows
			? [plainLine(this.theme.bold(`EXCHANGES${this.threadFocus ? " · selected" : ""} · ${count}`), rightWidth)]
			: [];
		for (const [index, line] of header.slice(0, headerRows).entries()) {
			const text =
				index === headerRows - 1 && header.length > headerRows ? clipText(`${line} …`, rightWidth - 3) : line;
			right.push(
				this.paintSelected(
					plainLine(this.theme.fg("accent", `${index === 0 ? glyph : " "} ${text}`), rightWidth),
					this.threadFocus,
				),
			);
		}
		right.push(plainLine(this.theme.fg(conflict ? "warning" : "muted", clipText(provenance, rightWidth)), rightWidth));
		const body = this.gutterWrap(event.exchange?.text ?? event.text, rightWidth, true);
		this.exchangeLength = body.length;
		this.exchangeRows = Math.max(1, height - right.length - 1);
		this.exchangeScroll = Math.min(this.exchangeScroll, Math.max(0, body.length - this.exchangeRows));
		right.push(
			...body
				.slice(this.exchangeScroll, this.exchangeScroll + this.exchangeRows)
				.map((line) => plainLine(line, rightWidth)),
		);
		while (right.length < height - 1) right.push(plainLine("", rightWidth));
		right.push(
			plainLine(
				this.theme.fg(
					"muted",
					clipText(`${count} · ${positionLabel(this.exchangeScroll, this.exchangeRows, body.length)}`, rightWidth),
				),
				rightWidth,
			),
		);
		while (left.length < height) left.push(plainLine("", leftWidth));
		if (!wide) return (this.threadFocus ? right : left).slice(0, height);
		return Array.from(
			{ length: height },
			(_, index) =>
				`${left[index] ?? plainLine("", leftWidth)} ${this.theme.fg("borderMuted", "│")} ${right[index] ?? plainLine("", rightWidth)}`,
		);
	}
	private allNotices(): string[] {
		const history = this.familyId ? this.retained.get(this.familyId)?.history : null;
		return [...new Set([...(history?.notices ?? []), ...(this.snapshot?.notices ?? [])])];
	}
	private obligationRows(obligations: CollaborationSnapshot["obligations"]): string[] {
		return obligations.map((obligation, index) => {
			const disposition = obligation.outcome
				? ` — ${obligation.outcome}${obligation.reason ? `: ${obligation.reason}` : ""}`
				: obligation.required
					? " — required, open"
					: " — open";
			return `${index + 1}. ${obligation.requester} → ${obligation.reviewer ?? "any"}: ${obligation.artifact}@${obligation.revision} [${obligation.obligationId}]${disposition}`;
		});
	}
	private historyStatus(): string {
		if (this.historyPending) return "HISTORY · Loading selected family… · n report";
		if (this.historyError) return "HISTORY FAILED · Retained data stays visible · n report · h retry";
		const history = this.familyId ? this.retained.get(this.familyId)?.history : null;
		const notices = this.allNotices().length;
		const outstanding = this.snapshot?.outstandingRequired?.length ?? 0;
		const base = history
			? `HISTORY · ${history.total} events · +${history.added}/-${history.removed} · ${notices} notices · n report`
			: `Live memory · ${notices} notices`;
		return outstanding > 0 ? `${base} · ${outstanding} outstanding required` : base;
	}
	private infoLines(width: number): string[] {
		const history = this.familyId ? this.retained.get(this.familyId)?.history : null;
		const fields =
			this.view === "help"
				? this.mode === "overview"
					? [
							"DASHBOARD HELP",
							"The overview lists the direct child workers of this session. a toggles every known session; the preview shows the selected worker's owner.",
							"The list gives worker names the most space. The selected preview shows the task, model, current tool, and latest output. Output is worker-authored and unverified.",
							"m switches to communications. The overview never queries collaboration data or history.",
							"Enter or v opens the selected worker console. d opens its details with exact identities.",
							"/ searches workers and labels. Enter keeps the filter. Escape clears it while the search is open. The footer prioritizes selection, opening, and search; unavailable worker controls stay hidden.",
							"i or Ctrl+C interrupts the selected worker; k cancels it. Only the owning session controls a live worker.",
							"Worker view: Tab selects Chat, Report, or Details. Chat starts in read focus. Enter or typing opens the composer; Escape returns to reading without sending. A failed send keeps the draft.",
							"In Chat, alt+up/down selects message headers and x expands one tool or reasoning block. Ctrl+O toggles all tools; Ctrl+T toggles reasoning. These two keys follow your Pi settings.",
							"Ctrl+K cancels. For terminal workers, c copies a reopen command and r drafts continuation. Home/End scroll the reader; in the composer they move the caret. Composer arrows use native input controls, not transcript scrolling. Page Up/Down still page the transcript.",
							"Worker labels come from a profile name or task text; unlabeled records use abbreviated identities. Details retain exact identities, models, and tasks.",
							"Arrows / Page Up / Page Down scroll details and this help. b / Space also page this help.",
							"Escape returns from details or the console, or closes the dashboard.",
						]
					: [
							"DASHBOARD HELP",
							"Communications groups recorded exchanges by participant pair. Management tool calls are not conversations.",
							"Tab switches focus between the conversation list and the selected message. Arrows select a thread or message. Page Up/Down or b/Space page through the message; Home/End reach its start/end.",
							"Enter reads the selected record's exact source text, identities, and receipt evidence.",
							"Exchange text is worker-authored and unverified. A conflicting-envelope flag marks peer identities the source observed with differing envelope evidence; both observations are shown.",
							"m switches back to the worker overview. The overview never queries collaboration data or history.",
							"e switches to raw source evidence; e returns. F selects a known dispatch family and loads its history.",
							"h loads or refreshes known history for this family. n reports the result and all source notices. The top row reports the outcome, even when nothing changes.",
							"/ searches text and full identities. Enter keeps the filter. Escape clears it while search is open.",
							"v opens the selected exchange worker's transcript. i / Ctrl+C interrupts; k cancels. Only the owner controls a live worker. The footer keeps navigation, open, and cancel keys; e, h, n, v, /, and F stay listed here.",
							"In raw evidence only: Tab selects timeline, workers, or details; f filters exchanges to the selected worker; l or timeline End follows the tail.",
							"[ / ] in event details: follow parent message / first reply.",
							"Arrows / Page Up / Page Down scroll details. b / Space also page this help and the source report.",
							"Worker labels come from a profile name or task text; unlabeled records use abbreviated identities. Details retain exact identities, models, tasks, source entries, and receipt evidence.",
							"History is bounded source evidence, not a complete archive. Recorded messages and local receipts do not prove understanding or action.",
							"Escape returns from details or the console, cancels an unsent continuation draft, or closes the dashboard. A submitted continuation remains active.",
						]
				: [
						"HISTORY / SOURCE REPORT",
						`Family: ${this.familyId ?? "not selected"}`,
						this.historyPending
							? "History read is pending. Existing evidence remains visible."
							: this.historyError
								? `History read failed: ${this.historyError}`
								: history
									? "History read finished."
									: "History has not been requested. Press h to load it.",
						...(history
							? [
									`Last history snapshot: ${new Date(history.at).toLocaleString()}`,
									`Returned view: ${history.total} events; ${history.added} added; ${history.removed} removed relative to the prior view.`,
									...(history.added === 0 && history.removed === 0
										? ["No event identities changed. Source or receipt details can still change."]
										: []),
								]
							: []),
						"A history request replaces the family snapshot. Live refresh retains loaded evidence. Counts do not establish complete history.",
						"Only known worker files and available manager handles supply evidence. Missing files, read bounds, and source limits leave omissions.",
						"",
						`OUTSTANDING REQUIRED (${this.snapshot?.outstandingRequired?.length ?? 0})`,
						...this.obligationRows(this.snapshot?.outstandingRequired ?? []),
						...(this.snapshot?.outstandingRequired?.length
							? []
							: ["No required obligations are unresolved."]),
						"",
						`NOT ACCEPTED (${this.snapshot?.unaccepted?.length ?? 0})`,
						...this.obligationRows(this.snapshot?.unaccepted ?? []),
						...(this.snapshot?.unaccepted?.length
							? []
							: ["No dispositions are recorded as non-accepted."]),
						"",
						`SOURCE NOTICES (${this.allNotices().length})`,
						...this.allNotices().map((notice, index) => `${index + 1}. ${notice}`),
						...(this.allNotices().length
							? []
							: ["No source notices in the retained history or current live snapshot."]),
						"",
						"History notices remain here until the next successful history refresh. Live notices describe the latest memory query.",
					];
		return fields.flatMap((field) =>
			this.gutterWrap(field, width).map((line) => plainLine(this.theme.fg("text", line), width)),
		);
	}
	private renderTree(width: number, height: number): string[] {
		const nodes = this.tree(),
			selected = nodes.findIndex((node) => node.participant.id === this.selectedParticipant);
		const capacity = Math.max(0, Math.floor((height - 1) / 2));
		const start = Math.max(0, selected - capacity + 1);
		const lines = [
			plainLine(
				this.theme.fg(
					this.page === "tree" ? "accent" : "muted",
					`WORKERS · ${nodes.filter((node) => node.participant.workerId).length} · tab focus`,
				),
				width,
			),
		];
		for (const { participant, depth } of nodes.slice(start, start + capacity)) {
			const prefix = `${participant.id === this.selectedParticipant ? "›" : " "} ${"  ".repeat(Math.min(depth, 8))}${depth ? "└ " : ""}`;
			const state = cleanLine(participant.state);
			const identity = cleanLine(
				`${this.displayId(participant.id)}${participant.model ? ` · ${participant.model.split("/").at(-1)}` : ""}`,
			);
			const stateWidth = Math.min(visibleWidth(state) + 3, Math.floor(width / 2));
			const header = `${plainLine(truncateToWidth(prefix + identity, Math.max(0, width - stateWidth), "…"), Math.max(0, width - stateWidth))}${this.theme.fg(state === "running" || state === "live" ? "success" : state === "paused" ? "warning" : "muted", truncateToWidth(` · ${state}`, stateWidth, "…"))}`;
			for (const value of [
				header,
				this.theme.fg("text", truncateToWidth(`  ${cleanLine(participant.task || participant.label)}`, width, "…")),
			]) {
				let line = plainLine(value, width);
				if (participant.id === this.selectedParticipant) line = this.paintSelected(line, true);
				lines.push(line);
			}
		}
		while (lines.length < height) lines.push(plainLine("", width));
		return lines;
	}
	private renderTimeline(width: number, height: number): string[] {
		const events = this.events();
		const selected = events.findIndex((event) => event.id === this.selectedEvent);
		const capacity = Math.max(0, Math.floor((height - 1) / 2));
		if (this.followEvents) this.eventStart = Math.max(0, events.length - capacity);
		else if (selected >= 0) {
			if (selected < this.eventStart) this.eventStart = selected;
			else if (selected >= this.eventStart + capacity) this.eventStart = Math.max(0, selected - capacity + 1);
		}
		const lines = [
			plainLine(
				this.theme.fg(
					this.page === "timeline" ? "accent" : "muted",
					`TIMELINE · ${events.length} events${this.participantFilter ? " · filtered" : " · family"} · ${events.length ? this.eventStart + 1 : 0}-${Math.min(events.length, this.eventStart + capacity)}`,
				),
				width,
			),
		];
		for (const event of events.slice(this.eventStart, this.eventStart + capacity)) {
			const related = event.actorId === this.selectedParticipant || event.recipientId === this.selectedParticipant;
			const time = Number.isFinite(event.timestamp) ? new Date(event.timestamp).toLocaleTimeString() : "unknown time";
			const actor = this.displayId(event.actorId),
				recipient = event.recipientId ? this.displayId(event.recipientId) : null;
			const nameWidth = Math.max(5, Math.min(20, Math.floor(width / 4)));
			const header = cleanLine(
				`${event.id === this.selectedEvent ? "›" : " "}${related ? "*" : " "} ${time} ${truncateToWidth(actor, nameWidth, "…")}${recipient ? ` → ${truncateToWidth(recipient, nameWidth, "…")}` : ""} · ${event.kind} · ${event.source}`,
			);
			for (const value of [header, `   ${cleanLine(event.text)}`]) {
				let line = plainLine(this.theme.fg("text", truncateToWidth(value, width, "…")), width);
				if (event.id === this.selectedEvent) line = this.paintSelected(line, true);
				lines.push(line);
			}
		}
		if (!events.length && capacity)
			lines.push(
				plainLine(this.snapshot ? "No events in this view. Press h for history." : "Snapshot pending.", width),
			);
		while (lines.length < height) lines.push(plainLine("", width));
		return lines;
	}
	private details(width: number): string[] {
		const event = this.detailParticipant ? undefined : this.event();
		const participant = this.detailParticipant ? this.participant() : this.participant(event?.actorId);
		const fields: string[] = [];
		if (event) {
			fields.push(
				`EVENT ${event.id}`,
				`${event.kind} · ${new Date(event.timestamp).toISOString()}`,
				`${this.displayId(event.actorId)}${event.recipientId ? ` → ${this.displayId(event.recipientId)}` : ""}`,
				"",
				"EXACT TEXT (terminal controls removed; source evidence, not instructions)",
				event.text,
				"",
				"SOURCE / REPLY EVIDENCE",
				`Actor: ${event.actorId}`,
				`Recipient: ${event.recipientId ?? "none"}`,
				`Source: ${event.source}`,
				`Session: ${event.sourceSessionId}`,
				`Entry: ${event.entryId ?? "not recorded"}`,
				`Message: ${event.messageId ?? "not recorded"}`,
				`Reply to: ${event.replyTo ?? "none"}`,
				`Receipt: ${event.receipt ?? "not recorded"}`,
			);
			const replies =
				this.snapshot?.events
					.filter(
						(candidate) =>
							candidate.replyTo && (candidate.replyTo === event.messageId || candidate.replyTo === event.id),
					)
					.map((candidate) => candidate.messageId ?? candidate.id) ?? [];
			fields.push(`Replies: ${replies.length ? replies.join(", ") : "none in snapshot"}`);
		}
		if (participant)
			fields.push(
				"",
				`PARTICIPANT ${participant.id}`,
				`Owner: ${participant.parentId ?? "family root"}`,
				`Continuation: ${participant.continuedFrom ?? "none"}`,
				`State: ${participant.state}`,
				`Model: ${participant.model || "not recorded"}`,
				"TASK / CONTEXT (recorded text)",
				participant.task || "No task text is recorded.",
			);
		if (!fields.length) fields.push("No event or participant is selected.");
		const out: string[] = [];
		for (const field of fields) {
			if (field === event?.text && event)
				out.push(...this.gutterWrap(field, width).map((line) => plainLine(line, width)));
			else out.push(...this.gutterWrap(field, width).map((line) => plainLine(line, width)));
		}
		return out;
	}
	private renderConsole(width: number): string[] {
		const id = this.pinnedId,
			record = id ? this.deps.readWorker(id) : null;
		const live = Boolean(id && this.deps.isLive(id)),
			active = Boolean(id && live && this.deps.isActive(id));
		const all = this.transcriptLines();
		const height = this.windowHeight();
		const max = Math.max(0, all.length - height);
		this.scroll = this.followTail ? max : Math.min(this.scroll, max);
		const head = record ? `${this.rosterLabel(record)} · ${this.workerState(record)}` : "No worker";
		const position = `${this.followTail ? "Tail" : "Browse"} · ${positionLabel(this.scroll, height, all.length)}`;
		const lines = [
			headerPair(
				width,
				this.theme.bold(cleanLine(this.compact() ? `${this.consolePage} · ${head}` : head)),
				this.theme.fg("muted", position),
			),
		];
		if (!this.compact()) {
			const tabs = (["chat", "report", "details"] as const)
				.map((page) => {
					const label = page[0].toUpperCase() + page.slice(1);
					return page === this.consolePage
						? this.theme.fg("accent", this.theme.bold(`[${label}]`))
						: this.theme.fg("muted", label);
				})
				.join("  ");
			lines.push(
				headerPair(
					width,
					tabs,
					record
						? this.theme.fg(
								"muted",
								cleanLine(`${record.model} · ${this.workerElapsed(record)} · ${this.workerCost(record)}`),
							)
						: "",
				),
			);
		}
		for (let i = 0; i < height; i++) lines.push(all[this.scroll + i] ?? plainLine("", width));
		if (this.continuationPending || this.sendPending)
			lines.push(
				plainLine(
					this.continuationPending
						? "Continuation request pending. Escape closes only the view."
						: "Send request pending. Draft retained.",
					width,
				),
			);
		else if (this.consolePage === "chat" && ((live && this.composing) || this.continuing)) {
			const label = this.continuing ? "Continue " : active ? "Steer " : "Resume ";
			lines.push(plainLine(label + this.composer.render(Math.max(0, width - visibleWidth(label)))[0], width));
		} else
			lines.push(
				plainLine(
					this.theme.fg(
						"muted",
						record?.state === "running" && !live
							? "Another session owns live control."
							: `${this.consolePage === "chat" ? `${this.currentSection()?.label ?? "Chat"} · unverified${live ? " · enter or type to message" : ""}` : this.consolePage === "report" ? "Retained report · unverified" : "Worker record"} · b/space page`,
					),
					width,
				),
			);
		const inputFocus = this.consolePage === "chat" && (this.composing || this.continuing);
		const navigation = inputFocus ? { key: "pgup/pgdn", label: "page" } : { key: "↑↓", label: "scroll" };
		const groups: FooterAction[][] = this.continuing
			? this.continuationPending
				? [[navigation], [{ key: "", label: "request pending" }], []]
				: [[navigation], [{ key: "enter", label: "start" }], []]
			: live
				? [
						[navigation],
						[{ key: "enter", label: this.composing ? (active ? "steer" : "run") : "message" }],
						[
							{ key: "ctrl+c", label: "interrupt" },
							{ key: "ctrl+k", label: "cancel" },
						],
					]
				: record?.sessionFile && record.state !== "running"
					? [
							[{ key: "↑↓", label: "scroll" }],
							[
								{ key: "c", label: "copy" },
								{ key: "r", label: "continue" },
							],
							[],
						]
					: [[{ key: "↑↓", label: "scroll" }], [], []];
		groups[0].push({ key: "tab", label: "view" });
		if (this.consolePage === "chat" && !inputFocus)
			groups[0].push({ key: "alt+↑↓", label: "block" }, { key: "x", label: "expand" });
		if (this.consolePage === "chat")
			groups[1].push({
				key: this.bindingText("app.tools.expand", "ctrl+o"),
				label: this.expandedTools ? "fold tools" : "expand tools",
			});
		if (this.consolePage === "chat")
			groups[1].push({ key: this.bindingText("app.thinking.toggle", "ctrl+t"), label: "reasoning" });
		else groups[1] = groups[1].filter((action) => action.key !== "enter");
		lines.push(
			this.footer(
				width,
				groups,
				this.continuing && !this.continuationPending
					? { key: "esc", label: "cancel draft" }
					: { key: "esc", label: this.composing ? "read" : "back" },
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
		.custom<void>(
			(tui: TUI, theme: Theme, keybindings, done) => {
				const panel = new SubagentConsole(deps, tui, theme, () => done(undefined), initialFilter, keybindings);
				const timer = setInterval(() => panel.tick(), 1_000);
				return {
					get focused() {
						return panel.focused;
					},
					set focused(value: boolean) {
						panel.focused = value;
					},
					render: (width: number) => panel.render(width),
					handleInput: (data: string) => panel.handleInput(data),
					invalidate: () => panel.invalidate(),
					dispose: () => {
						clearInterval(timer);
						panel.dispose();
					},
				};
			},
			{ overlay: true, overlayOptions: { width: "90%", minWidth: 100, maxHeight: "100%", margin: 1 } },
		)
		.then(() => undefined);
}
