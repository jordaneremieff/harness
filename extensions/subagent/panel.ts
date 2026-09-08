/** Collaboration timeline and worker transcripts, with control through the owning runtime. */
import { execFile } from "node:child_process";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
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
	renderConversation,
	stripTerminalSequences,
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
	return stripTerminalSequences(text)
		.replace(/[\t\r\v\f]/g, " ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
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

export interface MarkerStyles {
	bold(text: string): string;
	italic(text: string): string;
	code(text: string): string;
	heading(text: string): string;
	rule(text: string): string;
	bullet(text: string): string;
}

const INLINE_MARKERS = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
const HEADING_MARKER = /^(#{1,6})\s+(.*)$/;
const RULE_MARKER = /^(?:-{3,}|\*{3,}|_{3,})$/;
const LIST_MARKER = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const MAX_LIST_INDENT = 8;

/** Bounded marker mapping, not a Markdown engine: recognized markers become styles and are removed. */
export function styleMarkers(text: string, styles: MarkerStyles): string {
	return text.replace(INLINE_MARKERS, (match, code, strong, strongAlt, emphasis, emphasisAlt) => {
		if (code !== undefined) return styles.code(code);
		if (strong !== undefined) return styles.bold(strong);
		if (strongAlt !== undefined) return styles.bold(strongAlt);
		if (emphasis !== undefined) return styles.italic(emphasis);
		if (emphasisAlt !== undefined) return styles.italic(emphasisAlt);
		return match;
	});
}

/**
 * Wrap recorded prose at a bounded measure. Headings gain a leading blank line, list items gain a
 * hanging indent, and rules span the measure, so a wrapped continuation never reads as a new item.
 */
export function styleMarkdownBlock(source: string, measure: number, styles: MarkerStyles): string[] {
	const width = Math.max(1, measure);
	const out: string[] = [];
	for (const raw of cleanText(source).split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim()) {
			out.push("");
			continue;
		}
		if (RULE_MARKER.test(line.trim())) {
			out.push(styles.rule("─".repeat(width)));
			continue;
		}
		const heading = HEADING_MARKER.exec(line);
		if (heading) {
			if (out.length && out.at(-1) !== "") out.push("");
			for (const wrapped of wrapTextWithAnsi(styleMarkers(heading[2].trim(), styles), width))
				out.push(styles.heading(wrapped));
			continue;
		}
		const item = LIST_MARKER.exec(line);
		const indent = item ? Math.min(MAX_LIST_INDENT, item[1].length) : 0;
		const hanging = item ? indent + 2 : 0;
		const wrapped = wrapTextWithAnsi(styleMarkers(item ? item[2] : line.trim(), styles), Math.max(1, width - hanging));
		const marker = item ? `${" ".repeat(indent)}${styles.bullet("•")} ` : "";
		for (const [index, value] of wrapped.entries())
			out.push(index === 0 ? marker + value : " ".repeat(hanging) + value);
	}
	while (out.length && out.at(-1) === "") out.pop();
	return out;
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
			...kept
				.filter((group) => group.length)
				.map((group) => group.map(styled).join(styles.rule(" · "))),
			styled(dismiss),
		].join(styles.rule(" │ ")),
		width,
	);
}

/** Wide windows keep a conversation list between 28 and 40 columns; narrow windows use the full width. */
export function threadPaneWidth(totalWidth: number): number {
	if (totalWidth < 100) return totalWidth;
	return Math.max(28, Math.min(40, Math.round(totalWidth * 0.28)));
}

/** Truncate to width and show the remaining column count instead of a bare ellipsis. */
export function truncateResidue(text: string, width: number): string {
	const total = visibleWidth(text);
	if (width <= 0) return "";
	if (total <= width) return text;
	let rest = total;
	let suffix = `+${rest}`;
	while (visibleWidth(suffix) >= width && rest > 0) {
		rest = Math.floor(rest / 10);
		suffix = rest ? `+${rest}` : "+";
	}
	const prefix = truncateToWidth(text, Math.max(0, width - visibleWidth(suffix)), "");
	rest = Math.max(0, total - visibleWidth(prefix));
	suffix = rest ? `+${rest}` : "";
	return visibleWidth(prefix) + visibleWidth(suffix) > width
		? truncateToWidth(`${prefix}${suffix}`, width, "")
		: `${prefix}${suffix}`;
}

export function headerPair(width: number, left: string, right: string): string {
	if (width <= 0) return "";
	if (!right) return plainLine(truncateResidue(left, width), width);
	const rightText = visibleWidth(right) <= width ? right : truncateResidue(right, width);
	const budget = Math.max(0, width - visibleWidth(rightText) - 1);
	const leftText = truncateResidue(left, budget);
	const gap = Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText));
	return plainLine(`${leftText}${" ".repeat(gap)}${rightText}`, width);
}

function padVisible(text: string, width: number, align: "left" | "right" = "left"): string {
	if (width <= 0) return "";
	const clipped = truncateResidue(text, width);
	const pad = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return align === "right" ? pad + clipped : clipped + pad;
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
		if (item.role === "user") return { role: "user", content: toTextParts(item.content) };
		if (item.role === "custom")
			return { role: "custom", customType: item.customType, content: toTextParts(item.content) };
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
		return { role: "assistant", content, stopReason: item.stopReason, errorMessage: item.errorMessage };
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
	private transcriptCache: { key: string; value: string[] } | null = null;
	private conversationCache: { key: string; messages: ConsoleMessage[] } | null = null;
	private unsub: (() => void) | null = null;
	private notice: string | undefined;
	private noticeUntil = 0;
	private disposed = false;

	private readonly deps: SubagentPanelDeps;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly close: () => void;

	constructor(deps: SubagentPanelDeps, tui: TUI, theme: Theme, close: () => void, initialFilter?: string) {
		this.deps = deps;
		this.tui = tui;
		this.theme = theme;
		this.close = close;
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
	/** Abbreviations are presentation only; actions always use exact identities. */
	private displayId(id: string): string {
		const participant = this.participant(id);
		if (participant && !participant.workerId) return participant.label;
		if (participant?.workerId && participant.label && participant.label !== id) return participant.label;
		if (id.length <= 14) return id;
		const ids = [
			...(this.snapshot?.participants.map((item) => item.id) ?? []),
			...this.roster.flatMap((record) => [record.id, record.ownerSession ?? ""]),
		];
		let length = 6;
		while (length < id.length && ids.some((other) => other !== id && other.endsWith(id.slice(-length)))) length++;
		return `…${id.slice(-length)}`;
	}
	/** Presentation label for a participant; details keep the exact identity. */
	private participantLabel(id: string): string {
		return this.displayId(id);
	}
	/** Overview identity column: a stored label wins, otherwise the abbreviated id. */
	private rosterLabel(record: WorkerRecord): string {
		return record.label && record.label !== record.id ? record.label : this.displayId(record.id);
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
	private markerStyles(): MarkerStyles {
		return {
			bold: (text) => this.theme.bold(text),
			italic: (text) => this.theme.italic(text),
			code: (text) => this.theme.fg("mdCode", text),
			heading: (text) => this.theme.fg("mdHeading", this.theme.bold(text)),
			rule: (text) => this.theme.fg("mdHr", text),
			bullet: (text) => this.theme.fg("mdListBullet", text),
		};
	}
	private footerStyles(): FooterStyles {
		return {
			key: (text) => this.theme.fg("accent", text),
			label: (text) => this.theme.fg("dim", text),
			rule: (text) => this.theme.fg("dim", text),
		};
	}
	private paneCap(): number {
		const cap =
			PANEL_MAX_ROWS_OVERRIDE > 0 ? PANEL_MAX_ROWS_OVERRIDE : Math.max(44, Math.floor(this.tui.terminal.rows * 0.85));
		return Math.max(1, Math.min(this.tui.terminal.rows - 2, cap));
	}
	private compact(): boolean {
		return this.paneCap() < COMPACT_PANEL_HEIGHT;
	}
	private paintSelected(line: string, selected: boolean): string {
		return selected ? this.theme.bg("selectedBg", line) : line;
	}
	private gutterWrap(source: string, paneWidth: number, markdown = false): string[] {
		const measure = readerMeasure(paneWidth);
		const lines = markdown
			? styleMarkdownBlock(source, measure, this.markerStyles())
			: wrapTextWithAnsi(cleanText(source), measure);
		return lines.map((line) => `${READER_GUTTER}${line}`);
	}
	private footer(
		width: number,
		groups: FooterAction[][],
		dismiss: FooterAction,
	): string {
		return footerLine(width, groups, dismiss, this.footerStyles(), this.currentNotice());
	}
	private escapeAction(): FooterAction {
		if (this.view === "search") return { key: "esc", label: "clear" };
		if (
			this.page === "details" ||
			this.view === "families" ||
			this.view === "report" ||
			this.view === "help"
		)
			return { key: "esc", label: "back" };
		return { key: "esc", label: "close" };
	}
	private familySuffix(): string {
		const families = this.snapshot?.families ?? [];
		if (families.length <= 1) return "";
		const label = families.find((family) => family.id === this.familyId)?.label;
		return label ? ` · ${label}` : "";
	}
	private statusMessage(): { text: string; fault: boolean } {
		if (this.mode === "overview") {
			const running = this.roster.filter((record) => record.state === "running" && !record.interruptedAt).length;
			const paused = this.roster.filter((record) => record.state === "running" && record.interruptedAt).length;
			const rows = this.rosterRows();
			const query = this.rosterSearch.getValue();
			return {
				text: `${query ? `${rows.length}/${this.roster.length} workers · /${cleanLine(query)}` : `${this.roster.length} workers`} · ${running} running · ${paused} paused · ${this.roster.length - running - paused} terminal${this.rosterLimited ? " · more records outside view limit" : ""}`,
				fault: false,
			};
		}
		if (this.historyError) return { text: this.historyStatus(), fault: true };
		if (this.historyPending) return { text: this.historyStatus(), fault: false };
		if (this.requestPending) return { text: "Refresh pending", fault: false };
		if (this.search.getValue()) return { text: `Search /${this.search.getValue()}`, fault: false };
		if (this.participantFilter) return { text: `filter ${this.participantLabel(this.participantFilter)}`, fault: false };
		const history = this.familyId ? this.retained.get(this.familyId)?.history : null;
		if (history) return { text: this.historyStatus(), fault: false };
		if (!this.evidenceMode && this.page !== "details") {
			const thread = this.currentThread();
			if (thread) {
				const last = thread.events.at(-1);
				return {
					text: `${thread.events.length} records · last ${last ? clockTime(last.timestamp) : "--:--:--"} · ${last?.exchange?.kind ?? last?.kind ?? "message"}`,
					fault: false,
				};
			}
			return { text: this.snapshot ? "No recorded conversations in this family." : "Loading conversations…", fault: false };
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
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) this.threadFocus = !this.threadFocus;
		else if (matchesKey(data, Key.enter)) {
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
		const key = `${conversationKey}:${this.lastWidth}`;
		if (this.transcriptCache?.key === key) return this.transcriptCache.value;
		if (this.conversationCache?.key !== conversationKey) {
			const messages = normalizeMessages(id ? (this.deps.conversation(id) ?? []) : []);
			const report = id ? this.deps.report(id) : null;
			if (report)
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: `──── ${report.label} ────\n\n${report.text}` }],
				});
			this.conversationCache = { key: conversationKey, messages };
		}
		const messages = this.conversationCache.messages;
		const lines = messages.length
			? renderConversation(messages, { width: this.lastWidth, theme: this.theme })
			: [plainLine("(no conversation recorded yet)", this.lastWidth)];
		this.transcriptCache = { key, value: lines };
		return lines;
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
			} else this.closeConsole();
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
			this.composer.setValue("");
			this.bump();
			return;
		}
		const delta = matchesKey(data, Key.up)
			? -1
			: matchesKey(data, Key.down)
				? 1
				: matchesKey(data, Key.pageUp)
					? -this.windowHeight()
					: matchesKey(data, Key.pageDown)
						? this.windowHeight()
						: 0;
		if (delta || (!live && !this.continuing && (matchesKey(data, Key.home) || matchesKey(data, Key.end)))) {
			const max = Math.max(0, this.transcriptLines().length - this.windowHeight());
			this.scroll = Math.max(
				0,
				Math.min(max, matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? max : this.scroll + delta),
			);
			this.followTail = this.scroll === max;
			this.bump();
			return;
		}
		if (!live && !this.continuing) return;
		if (this.sendPending || this.continuationPending) return;
		if (matchesKey(data, Key.enter)) {
			void this.submitDraft();
			return;
		}
		this.inputData(this.composer, data);
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
				if (outcome.ok) this.composer.setValue("");
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
		const maximum = this.paneCap();
		if (this.mode === "overview" && (this.view === "dashboard" || this.view === "search") && this.page !== "details")
			return Math.min(maximum, Math.max(6, this.rosterRows().length + 6));
		if (this.view === "dashboard" && this.page === "details")
			return Math.min(
				maximum,
				Math.max(
					8,
					this.mode === "overview"
						? this.overviewDetails(this.lastWidth).length + 5
						: this.details(this.lastWidth).length + 4,
				),
			);
		if (this.mode === "communication" && this.view === "dashboard" && !this.evidenceMode) {
			const threads = this.threads();
			const width = this.lastWidth - (this.lastWidth >= 100 ? threadPaneWidth(this.lastWidth) + 3 : 0);
			const messageRows =
				this.currentThread()
					?.events.slice(-3)
					.reduce((total, event) => total + this.conversationCard(event, width, false).length, 0) ?? 0;
			return Math.min(maximum, Math.max(8, threads.length * (this.lastWidth >= 100 ? 1 : 3) + 5, messageRows + 5));
		}
		return maximum;
	}
	private chromeRows(): number {
		if (this.view === "console") return 3;
		if (this.compact()) return this.view === "search" ? 3 : 2;
		if (this.mode === "overview" && this.view !== "help") return 5;
		return 3;
	}
	private windowHeight(): number {
		return Math.max(1, this.panelHeight() - this.chromeRows());
	}
	render(width: number): string[] {
		if (width <= 0) return [];
		this.lastWidth = width;
		try {
			if (this.view === "console" && this.pinnedId && !this.deps.readWorker(this.pinnedId)) {
				const id = this.pinnedId;
				this.closeConsole();
				this.setNotice(`Worker ${id} is no longer in the store.`);
			}
			this.syncFocus();
			const lines =
				this.view === "console"
					? this.renderConsole(width)
					: this.mode === "overview" && this.view !== "help"
						? this.renderOverview(width)
						: this.renderDashboard(width);
			const height = this.panelHeight();
			return lines.length <= height ? lines : [...lines.slice(0, height - 1), lines.at(-1) ?? ""];
		} catch (error) {
			return [plainLine(`subagent: render error: ${cleanLine(errText(error))}`, width)];
		}
	}
	private overviewDetails(width: number): string[] {
		const record = this.roster.find((row) => row.id === this.rosterId);
		const details = record
			? [
					`WORKER ${record.id}`,
					`Model: ${record.model} [${record.thinking}]`,
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
	private renderOverview(width: number): string[] {
		const rows = this.rosterRows();
		const selected = Math.max(
			0,
			rows.findIndex((record) => record.id === this.rosterId),
		);
		const compact = this.compact();
		const status = this.statusMessage();
		const scope = this.scope === "children" && this.deps.currentSessionId() ? "DIRECT CHILDREN" : "ALL SESSIONS";
		const height = this.panelHeight();
		const title = this.theme.fg("accent", this.theme.bold(`SUBAGENTS · OVERVIEW · ${scope}`));
		const lines = compact
			? [
					headerPair(
						width,
						this.theme.fg("accent", this.theme.bold(`SUBAGENTS · OVERVIEW · ${scope} · ${status.text}`)),
						this.theme.fg("muted", this.page === "details" ? "esc back" : "m communications"),
					),
				]
			: [
					headerPair(width, title, this.theme.fg("muted", "m communications")),
					plainLine(this.theme.fg("muted", status.text), width),
				];
		const taskReserve = compact && this.view !== "search" && rows.length ? 1 : 0;
		const footerReserve = (compact && this.view !== "search" ? 1 : 2) + taskReserve;
		const available = Math.max(0, height - lines.length - footerReserve);
		if (this.page === "details") {
			const wrapped = this.overviewDetails(width);
			this.detailLength = wrapped.length;
			this.detailScroll = Math.min(this.detailScroll, Math.max(0, wrapped.length - available));
			lines.push(
				...wrapped.slice(this.detailScroll, this.detailScroll + available).map((line) => plainLine(line, width)),
			);
		} else {
			const wide = width >= 110;
			lines.push(
				plainLine(
					this.theme.fg(
						"muted",
						wide
							? `  WORKER        STATE          MODEL                 ELAPSED    COST     CURRENT TOOL      ${this.scope === "all" ? "OWNER      " : ""}LATEST OUTPUT`
							: "  WORKER · STATE · MODEL · ACTIVITY",
					),
					width,
				),
			);
			const capacity = Math.max(1, height - lines.length - footerReserve);
			const start = Math.max(0, selected - capacity + 1);
			if (!rows.length)
				lines.push(
					plainLine(
						this.rosterSearch.getValue()
							? "No matching workers. Press / then Escape to clear."
							: this.scope === "children"
								? "No direct children in this session. Press a for all sessions."
								: "No known workers in the store.",
						width,
					),
				);
			for (const record of rows.slice(start, start + capacity)) {
				const state =
					record.state === "running" && record.interruptedAt
						? "paused"
						: record.state === "no_result_submitted"
							? "no result"
							: record.state === "owner_lost"
								? "owner lost"
								: record.state;
				const model = cleanLine(record.model.split("/").at(-1) ?? record.model);
				const elapsed = formatPanelElapsed(((record.exitedAt ?? Date.now()) - record.startedAt) / 1000);
				const cost =
					typeof record.usage?.cost === "number" && Number.isFinite(record.usage.cost)
						? `$${record.usage.cost.toFixed(2)}`
						: "?";
				const tool = cleanLine(record.currentTool ?? "");
				const identity = cleanLine(this.rosterLabel(record));
				const owner =
					this.scope === "all"
						? `${plainLine(cleanLine(this.participantLabel(record.ownerSession ?? "unknown")), 10)} `
						: "";
				const current = record.id === this.rosterId;
				const meta = wide
					? `${plainLine(current ? this.theme.fg("accent", identity) : identity, 13)} ${plainLine(state, 14)} ${plainLine(model, 20)} ${plainLine(elapsed, 9)} ${plainLine(cost, 8)} ${plainLine(tool, 17)} ${owner}`
					: `${current ? this.theme.fg("accent", identity) : identity} · ${state} · ${model} · ${tool || elapsed} `;
				const preview = truncateResidue(rosterOutputPreview(record), Math.max(0, width - visibleWidth(meta) - 2));
				lines.push(
					this.paintSelected(
						plainLine(`${current ? "›" : " "} ${meta}${preview}`, width),
						current,
					),
				);
			}
		}
		const selectedRecord = rows[selected];
		if (!compact) {
			while (lines.length < height - 2) lines.push(plainLine("", width));
			lines.push(
				this.view === "search"
					? this.rosterSearch.render(width)[0]
					: plainLine(
							this.theme.fg(
								"muted",
								selectedRecord ? `Task: ${cleanLine(selectedRecord.task)}` : "a scope · m communications",
							),
							width,
						),
			);
		} else if (this.view === "search") {
			while (lines.length < height - 2) lines.push(plainLine("", width));
			lines.push(this.rosterSearch.render(width)[0]);
		} else if (selectedRecord && lines.length < height - 1) {
			lines.push(
				plainLine(
					this.theme.fg("muted", truncateResidue(`Task: ${cleanLine(selectedRecord.task)}`, width)),
					width,
				),
			);
			while (lines.length < height - 1) lines.push(plainLine("", width));
		} else {
			while (lines.length < height - 1) lines.push(plainLine("", width));
		}
		lines.push(
			this.footer(
				width,
				[
					[
						{ key: "a", label: "scope" },
						{ key: "m", label: "comms" },
						{ key: "↑↓", label: "select" },
					],
					[
						{ key: "enter", label: "console" },
						{ key: "d", label: "details" },
						{ key: "?", label: "help" },
					],
					[
						{ key: "i", label: "interrupt" },
						{ key: "k", label: "cancel" },
					],
				],
				this.escapeAction(),
			),
		);
		return lines;
	}
	private dashboardFooterGroups(): FooterAction[][] {
		if (this.view === "report" || this.view === "help")
			return [[{ key: "↑↓", label: "scroll" }, { key: "b/space", label: "page" }], [], []];
		if (this.view === "families")
			return [[{ key: "↑↓", label: "family" }], [{ key: "enter", label: "load" }], []];
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
					{ key: "↑↓", label: "select" },
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
				? `${this.participantLabel(participant.id)} · ${participant.state}`
				: "No participant selected";
		}
		const event = this.event();
		if (!event) return "No event selected";
		return `${this.participantLabel(event.actorId)} → ${this.participantLabel(event.recipientId ?? "unknown recipient")} · ${event.kind} · ${event.kind.startsWith("call ") ? "send attempt" : "recorded"} · ${clockTime(event.timestamp)}`;
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
					? "SUBAGENTS · OVERVIEW HELP"
					: "SUBAGENTS · DASHBOARD HELP"
				: this.view === "report"
					? `SUBAGENTS · SOURCE REPORT${this.familySuffix()}`
					: this.view === "families"
						? `SUBAGENTS · FAMILIES${this.familySuffix()}`
						: compact && detailsReader
							? identity
							: detailsReader
								? `SUBAGENTS · SOURCE DETAILS${this.familySuffix()}`
								: !this.evidenceMode && this.page !== "details"
									? `SUBAGENTS · COMMUNICATIONS · ${this.threads().length} conversations${this.familySuffix()}`
									: `SUBAGENTS · ${this.evidenceMode ? "EVIDENCE" : "SOURCE DETAILS"} · ${this.followEvents ? "FOLLOW TAIL" : `BROWSE · ${this.newEvents} new · l follow`} · ${this.page}${this.familySuffix()}`;
		const lines = [
			headerPair(width, this.theme.fg("accent", this.theme.bold(cleanLine(left))), this.theme.fg("muted", right)),
		];
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
				lines.push(plainLine(this.theme.fg(status.fault ? "warning" : "muted", status.text), width));
			}
		}
		lines.push(...body);
		lines.push(this.footer(width, this.dashboardFooterGroups(), this.escapeAction()));
		return lines;
	}
	/** One readable exchange card: time, direction, and kind in the header; provenance stays muted. */
	private conversationCard(event: CollaborationEvent, width: number, selected: boolean): string[] {
		const conflicting = event.kind === "peer conflicting envelope";
		const dir = this.directionMark(event);
		const dirGlyph = dir === "out" ? "→" : dir === "in" ? "←" : "↔";
		const bar = selected ? this.theme.fg("accent", "▌") : " ";
		const who = `${this.participantLabel(event.actorId)} → ${this.participantLabel(event.recipientId ?? "unknown recipient")}`;
		const header = `${bar}${dirGlyph} ${clockTime(event.timestamp)} ${this.theme.fg(selected ? "accent" : "text", who)} ${event.exchange?.kind ?? event.kind} ${this.theme.fg("muted", event.kind.startsWith("call ") ? "send attempt" : "recorded")}${conflicting ? this.theme.fg("warning", " conflicting envelope") : ""}`;
		const body = styleMarkdownBlock(event.exchange?.text ?? event.text, readerMeasure(width), this.markerStyles());
		const indent = dir === "in" ? "  " : "";
		const rows = [header, ...body.slice(0, 4).map((line) => `${bar}${indent}${READER_GUTTER}${line}`)];
		if (body.length > 4) {
			const prefix = `${bar}${indent}`;
			const hint = this.theme.fg("dim", "Enter opens the full source");
			rows.push(`${prefix}${padVisible(hint, Math.max(0, width - visibleWidth(prefix)), "right")}`);
		}
		return rows.map((value) =>
			this.paintSelected(plainLine(this.theme.fg("text", truncateResidue(value, width)), width), selected),
		);
	}
	private threadRow(
		item: { participants: readonly string[]; events: CollaborationEvent[] },
		isCurrent: boolean,
		width: number,
		wide: boolean,
		collapse = true,
	): string[] {
		const marker = isCurrent && !this.threadFocus ? "›" : " ";
		const label = this.threadLabel(item, collapse);
		const count = String(item.events.length);
		const last = item.events.at(-1);
		const time = last ? clockTime(last.timestamp) : "--:--:--";
		const kind = last?.exchange?.kind ?? last?.kind ?? "";
		const showKind = width >= 36;
		const showLast = width >= 28;
		const paint = (value: string) =>
			this.paintSelected(
				plainLine(isCurrent ? this.theme.fg("accent", truncateResidue(value, width)) : truncateResidue(value, width), width),
				isCurrent,
			);
		if (!wide) {
			const lines = [`${marker} ${label}`, `  ${count}${showLast ? ` ${time}` : ""}`];
			if (showKind) lines.push(`  ${kind}`);
			return lines.map(paint);
		}
		const countW = 4;
		const timeW = 8;
		let used = 2 + countW;
		if (showLast) used += 1 + timeW;
		if (showKind) used += 1 + visibleWidth(kind);
		const labelW = Math.max(1, width - used);
		const labelText = isCurrent ? this.theme.fg("accent", truncateResidue(label, labelW)) : truncateResidue(label, labelW);
		return [
			this.paintSelected(
				plainLine(
					`${marker} ${padVisible(labelText, labelW)}${padVisible(count, countW, "right")}${showLast ? ` ${time}` : ""}${showKind ? ` ${kind}` : ""}`,
					width,
				),
				isCurrent,
			),
		];
	}
	private threadSummary(width: number): string[] {
		const thread = this.currentThread();
		if (!thread) return [];
		const manager = this.managerId();
		const peerId = thread.participants.find((id) => id !== manager) ?? thread.participants[0];
		const peer = this.participant(peerId);
		return [
			plainLine(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width),
			plainLine(this.theme.fg("muted", "SELECTED THREAD"), width),
			plainLine(truncateResidue(`${peer?.state ?? ""} · ${peer?.model ?? ""}`, width), width),
			...this.gutterWrap(peer?.task ?? "", width).map((line) => plainLine(this.theme.fg("muted", line), width)),
		];
	}
	private renderConversations(width: number, height: number): string[] {
		const threads = this.threads();
		const thread = this.currentThread();
		if (!thread) {
			return [
				plainLine(this.snapshot ? "No recorded conversations in this family." : "Loading conversations…", width),
				plainLine("F selects a family; h reads known history; n explains source limits.", width),
				...Array.from({ length: Math.max(0, height - 2) }, () => plainLine("", width)),
			];
		}
		const wide = width >= 100;
		const leftWidth = threadPaneWidth(width);
		const rightWidth = wide ? width - leftWidth - 3 : width;
		const selected = Math.max(
			0,
			threads.findIndex((item) => item.id === thread.id),
		);
		const manager = this.managerId();
		const managerLabel = manager ? this.participantLabel(manager) : undefined;
		const managerCommon =
			threads.length > 0 &&
			manager !== undefined &&
			threads.every((item) => item.participants.includes(manager));
		const left = [
			plainLine(
				`CONVERSATIONS · ${threads.length}${managerCommon && managerLabel ? ` · ${managerLabel} ↔ peers` : ""}`,
				leftWidth,
			),
		];
		const perThread = wide ? 1 : 3;
		const capacity = Math.max(1, wide ? height - 1 : Math.floor((height - 1) / perThread));
		const start = Math.max(0, selected - capacity + 1);
		for (const item of threads.slice(start, start + capacity))
			left.push(...this.threadRow(item, item.id === thread.id, leftWidth, wide, managerCommon));
		if (left.length < height) left.push(...this.threadSummary(leftWidth).slice(0, height - left.length));
		const selectedEvent = thread.events.find((event) => event.id === this.selectedEvent) ?? thread.events.at(-1)!;
		const cards: string[][] = [];
		for (const event of thread.events.slice(0, thread.events.indexOf(selectedEvent) + 1))
			cards.push(this.conversationCard(event, rightWidth, event.id === selectedEvent.id));
		const rule = plainLine(this.theme.fg("borderMuted", "─".repeat(Math.max(0, rightWidth))), rightWidth);
		const available = Math.max(0, height - 1);
		const fitCards = (room: number): { lines: string[]; hidden: number } => {
			const lines: string[] = [];
			for (let index = cards.length - 1; index >= 0; index--) {
				const card = cards[index];
				const extra = lines.length ? 1 : 0;
				if (lines.length === 0 && card.length > room) return { lines: card.slice(0, Math.max(1, room)), hidden: index };
				if (lines.length + card.length + extra > room) return { lines, hidden: index + 1 };
				lines.unshift(...card, ...(extra ? [rule] : []));
			}
			return { lines, hidden: 0 };
		};
		const fit = fitCards(available);
		let kept = fit.lines;
		if (fit.hidden > 0 && available > 1) {
			const reduced = fitCards(available - 1);
			kept = [
				plainLine(
					this.theme.fg(
						"muted",
						truncateResidue(`… ${reduced.hidden} earlier exchange record${reduced.hidden === 1 ? "" : "s"}`, rightWidth),
					),
					rightWidth,
				),
				...reduced.lines,
			];
		}
		const right = [
			plainLine(
				this.threadFocus ? `EXCHANGES · selected · unverified` : `EXCHANGES · unverified · tab focus · enter source`,
				rightWidth,
			),
			...kept,
		];
		while (left.length < height) left.push(plainLine("", leftWidth));
		while (right.length < height) right.push(plainLine("", rightWidth));
		if (!wide) return this.threadFocus ? right.slice(0, height) : left.slice(0, height);
		return Array.from(
			{ length: height },
			(_, index) => `${left[index]} ${this.theme.fg("borderMuted", "│")} ${right[index]}`,
		);
	}
	private allNotices(): string[] {
		const history = this.familyId ? this.retained.get(this.familyId)?.history : null;
		return [...new Set([...(history?.notices ?? []), ...(this.snapshot?.notices ?? [])])];
	}
	private historyStatus(): string {
		if (this.historyPending) return "HISTORY · Loading selected family… · n report";
		if (this.historyError) return "HISTORY FAILED · Retained data stays visible · n report · h retry";
		const history = this.familyId ? this.retained.get(this.familyId)?.history : null;
		const notices = this.allNotices().length;
		return history
			? `HISTORY · ${history.total} events · +${history.added}/-${history.removed} · ${notices} notices · n report`
			: `Live memory · ${notices} notices`;
	}
	private infoLines(width: number): string[] {
		const history = this.familyId ? this.retained.get(this.familyId)?.history : null;
		const fields =
			this.view === "help"
				? this.mode === "overview"
					? [
							"DASHBOARD HELP",
							"The overview lists the direct child workers of this session. a toggles every known session and adds the owner column.",
							"Rows show worker, state, model, elapsed, cost, current tool, and the latest output. Output is worker-authored and unverified.",
							"m switches to communications. The overview never queries collaboration data or history.",
							"Enter or v opens the selected worker console. d opens its details with exact identities.",
							"/ searches workers. Enter keeps the filter. Escape clears it while the search is open. The footer keeps navigation, open, and cancel keys; / stays listed here.",
							"i or Ctrl+C interrupts the selected worker; k cancels it. Only the owning session controls a live worker.",
							"Console: Enter sends; failed sends keep the draft. Ctrl+K cancels. For terminal workers, c copies a reopen command and r drafts continuation.",
							"Worker labels come from a profile name or the task text. Details retain exact identities, models, and tasks.",
							"Arrows / Page Up / Page Down scroll details and this help. b / Space also page.",
							"Escape returns from details or the console, or closes the dashboard.",
						]
					: [
							"DASHBOARD HELP",
							"Communications groups recorded exchanges by participant pair. Management tool calls are not conversations.",
							"Tab switches focus between the conversation list and the message records. Arrows move the focused selection.",
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
							"Worker labels come from a profile name or the task text. Details retain exact identities, models, tasks, source entries, and receipt evidence.",
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
				if (participant.id === this.selectedParticipant) line = this.theme.bg("selectedBg", line);
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
				if (event.id === this.selectedEvent) line = this.theme.bg("selectedBg", line);
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
			if (field === event?.text && event) out.push(...this.gutterWrap(field, width, true).map((line) => plainLine(line, width)));
			else out.push(...this.gutterWrap(field, width).map((line) => plainLine(line, width)));
		}
		return out;
	}
	private renderConsole(width: number): string[] {
		const id = this.pinnedId,
			record = id ? this.deps.readWorker(id) : null;
		const live = Boolean(id && this.deps.isLive(id)),
			active = Boolean(id && live && this.deps.isActive(id));
		const state = record?.interruptedAt && record.state === "running" ? "interrupted" : (record?.state ?? "unknown");
		const elapsed = record ? formatPanelElapsed(((record.exitedAt ?? Date.now()) - record.startedAt) / 1000) : "";
		const head = record
			? `${record.id} · ${record.task} · ${state} · ${record.model} · ${elapsed}${record.continuedFrom ? ` · continued from ${record.continuedFrom}` : ""}`
			: "No worker";
		const lines = [plainLine(this.theme.fg("accent", this.theme.bold(cleanLine(head))), width)];
		const all = this.transcriptLines(),
			height = this.windowHeight(),
			max = Math.max(0, all.length - height);
		this.scroll = this.followTail ? max : Math.min(this.scroll, max);
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
		else if (live || this.continuing) {
			const label = this.continuing ? "continue " : "";
			lines.push(plainLine(label + this.composer.render(Math.max(0, width - visibleWidth(label)))[0], width));
		} else
			lines.push(
				plainLine(
					this.theme.fg("dim", record?.state === "running" ? "Another session owns live control." : state),
					width,
				),
			);
		const groups: FooterAction[][] = this.continuing
			? this.continuationPending
				? [[{ key: "↑↓", label: "scroll" }], [{ key: "", label: "request pending" }], []]
				: [[{ key: "↑↓", label: "scroll" }], [{ key: "enter", label: "start" }], []]
			: live
				? [
						[{ key: "↑↓", label: "scroll" }],
						[{ key: "enter", label: active ? "steer" : "run" }],
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
		lines.push(
			this.footer(
				width,
				groups,
				this.continuing && !this.continuationPending
					? { key: "esc", label: "cancel draft" }
					: { key: "esc", label: "back" },
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
		})
		.then(() => undefined);
}
