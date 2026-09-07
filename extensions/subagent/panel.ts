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
import type { WorkerRecord } from "./index.ts";
import type { TranscriptItem } from "./runtime.ts";

export interface SubagentPanelDeps {
	readWorkers(): WorkerRecord[];
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
function footerWithEscape(width: number, actions: string[], escapeLabel: string, notice?: string): string {
	const escapeHint = visibleWidth(escapeLabel) <= width ? escapeLabel : "esc".slice(0, width);
	if (notice) {
		const budget = width - visibleWidth(escapeHint) - 3;
		if (budget <= 0) return plainLine(escapeHint, width);
		let tail = "";
		for (const char of [...cleanLine(notice)].reverse()) {
			if (visibleWidth(`…${char}${tail}`) > budget) break;
			tail = char + tail;
		}
		return plainLine(
			`${visibleWidth(cleanLine(notice)) > budget ? `…${tail}` : cleanLine(notice)} · ${escapeHint}`,
			width,
		);
	}
	const kept = [...actions];
	while (kept.length && visibleWidth([...kept, escapeHint].join(" · ")) > width) kept.pop();
	return plainLine([...kept, escapeHint].join(" · "), width);
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
		if (initialFilter) this.search.setValue(cleanLine(initialFilter));
		void this.refresh(false);
	}
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}
	private syncFocus(): void {
		this.search.focused = this._focused && this.view === "search";
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
		void this.refresh(false);
		this.bump();
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
		return this.snapshot?.events.find((event) => event.id === this.selectedEvent);
	}
	private participant(id = this.selectedParticipant): CollaborationParticipant | undefined {
		return this.snapshot?.participants.find((participant) => participant.id === id);
	}
	/** Abbreviations are presentation only; actions always use exact identities. */
	private displayId(id: string): string {
		const participant = this.participant(id);
		if (participant && !participant.workerId) return participant.label;
		if (id.length <= 14) return id;
		const ids = this.snapshot?.participants.map((item) => item.id) ?? [];
		let length = 6;
		while (length < id.length && ids.some((other) => other !== id && other.endsWith(id.slice(-length)))) length++;
		return `…${id.slice(-length)}`;
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
			if (matchesKey(data, Key.escape)) {
				this.search.setValue("");
				this.view = "dashboard";
			} else if (matchesKey(data, Key.enter)) this.view = "dashboard";
			else this.inputData(this.search, data);
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
			this.participantFilter = this.participantFilter ? null : this.selectedParticipant;
			this.eventStart = 0;
			this.returnLive();
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
		const cap =
			PANEL_MAX_ROWS_OVERRIDE > 0 ? PANEL_MAX_ROWS_OVERRIDE : Math.max(44, Math.floor(this.tui.terminal.rows * 0.85));
		return Math.max(1, Math.min(this.tui.terminal.rows - 2, cap));
	}
	private windowHeight(): number {
		return Math.max(1, this.panelHeight() - (this.view === "console" ? 3 : 4));
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
			const lines = this.view === "console" ? this.renderConsole(width) : this.renderDashboard(width);
			const height = this.panelHeight();
			return lines.length <= height ? lines : [...lines.slice(0, height - 1), lines.at(-1) ?? ""];
		} catch (error) {
			return [plainLine(`subagent: render error: ${cleanLine(errText(error))}`, width)];
		}
	}
	private renderDashboard(width: number): string[] {
		const retained = this.familyId ? this.retained.get(this.familyId) : null;
		const status = retained ? `Snapshot ${new Date(retained.refreshedAt).toLocaleTimeString()}` : "Snapshot pending";
		const familyLabel =
			this.snapshot?.families.find((family) => family.id === this.familyId)?.label ?? "Current family";
		const label = `SUBAGENTS · ${this.followEvents ? "FOLLOW TAIL" : `BROWSE · ${this.newEvents} new · l follow`} · ${this.page} · ${familyLabel}`;
		const lines = [plainLine(this.theme.fg("accent", this.theme.bold(cleanLine(label))), width)];
		lines.push(
			plainLine(
				this.theme.fg(this.historyError || this.allNotices().length ? "warning" : "accent", this.historyStatus()),
				width,
			),
		);
		const height = this.windowHeight();
		if (this.view === "report" || this.view === "help") {
			const info = this.infoLines(width);
			this.infoLength = info.length;
			this.infoScroll = Math.min(this.infoScroll, Math.max(0, info.length - height));
			for (let i = 0; i < height; i++) lines.push(info[this.infoScroll + i] ?? plainLine("", width));
		} else if (this.view === "families") {
			const families = this.snapshot?.families ?? [];
			const start = Math.max(0, this.familyIndex - height + 2);
			lines.push(plainLine("Families · Enter loads selected history", width));
			for (let i = 0; i < height - 1; i++) {
				const family = families[start + i];
				lines.push(
					plainLine(
						family
							? `${start + i === this.familyIndex ? "›" : " "} ${cleanLine(family.label)} · ${cleanLine(family.id)}`
							: "",
						width,
					),
				);
			}
		} else if (this.page === "details") {
			const details = this.details(width);
			this.detailLength = details.length;
			this.detailScroll = Math.min(this.detailScroll, Math.max(0, details.length - height));
			for (let i = 0; i < height; i++) lines.push(details[this.detailScroll + i] ?? plainLine("", width));
		} else if (width >= 100) {
			const treeWidth = Math.min(52, Math.floor(width * 0.36)),
				timelineWidth = width - treeWidth - 3;
			const tree = this.renderTree(treeWidth, height),
				timeline = this.renderTimeline(timelineWidth, height);
			for (let i = 0; i < height; i++) lines.push(`${tree[i]} ${this.theme.fg("borderMuted", "│")} ${timeline[i]}`);
		} else lines.push(...(this.page === "tree" ? this.renderTree(width, height) : this.renderTimeline(width, height)));
		lines.push(
			this.view === "search"
				? this.search.render(width)[0]
				: plainLine(
						this.theme.fg(
							"muted",
							cleanLine(
								`${status}${this.requestPending ? " · refresh pending" : ""}${this.participantFilter ? ` · filter ${this.displayId(this.participantFilter)}` : ""}${this.search.getValue() ? ` · /${this.search.getValue()}` : ""}${this.view === "report" || this.view === "help" ? ` · lines ${this.infoScroll + 1}-${Math.min(this.infoLength, this.infoScroll + height)}/${this.infoLength}` : ""}`,
							),
						),
						width,
					),
		);
		const actions =
			this.view === "report" || this.view === "help"
				? ["↑↓ scroll", "b/space page", ...(this.view === "report" ? ["h refresh"] : [])]
				: this.view === "families"
					? ["↑↓ family", "enter load"]
					: this.page === "details"
						? ["? help", "↑↓ scroll", "[ parent", "] reply", "v transcript", "tab focus", "h history", "n report"]
						: [
								"? help",
								"h history",
								"n report",
								"tab focus",
								"enter details",
								"v transcript",
								"f filter",
								"/ search",
								"F families",
								"l live",
								"i interrupt",
								"k cancel",
							];
		lines.push(
			this.theme.fg(
				this.currentNotice() ? "warning" : "dim",
				footerWithEscape(
					width,
					actions,
					this.view === "search"
						? "esc clear"
						: this.page === "details" || this.view === "families" || this.view === "report" || this.view === "help"
							? "esc back"
							: "esc close",
					this.currentNotice(),
				),
			),
		);
		return lines;
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
			: `LIVE MEMORY · ${notices} notices · h history · n report`;
	}
	private infoLines(width: number): string[] {
		const history = this.familyId ? this.retained.get(this.familyId)?.history : null;
		const fields =
			this.view === "help"
				? [
						"DASHBOARD HELP",
						"Tab / Shift+Tab: select timeline, workers, or details.",
						"Arrows: select an event or worker. Enter: read its details.",
						"h: load or refresh known history for this family. The top row reports the result, even when nothing changes.",
						"n: read history results and all source notices. Escape: return without changing selection.",
						"F: choose a known dispatch family. Enter loads its history.",
						"l / timeline End: follow the tail. BROWSE pauses only scrolling, never workers or live refresh.",
						"f: filter exchanges to the selected worker. Selection alone marks related exchanges with *; other events stay visible.",
						"/: search text and full identities. Enter keeps the filter. Escape clears it while search is open.",
						"v: open the selected worker transcript. i / Ctrl+C: interrupt. k: cancel. Only the owner controls a live worker.",
						"[ / ] in event details: follow parent message / first reply.",
						"Arrows / Page Up / Page Down: scroll details. b / Space also page this help and the source report.",
						"Worker labels abbreviate long IDs. Details retain exact IDs, models, tasks, source entries, and receipt evidence.",
						"History is bounded source evidence, not a complete archive. Recorded messages and local receipts do not prove understanding or action.",
						"Console: Enter sends; failed sends keep the draft. Ctrl+K cancels. For terminal workers, c copies a reopen command and r drafts continuation.",
						"Escape returns from details or console, cancels an unsent continuation draft, or closes the dashboard. A submitted continuation remains active.",
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
			wrapTextWithAnsi(cleanText(field), Math.max(1, width)).map((line) =>
				plainLine(this.theme.fg("text", line), width),
			),
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
		return fields.flatMap((text) =>
			wrapTextWithAnsi(cleanText(text), Math.max(1, width)).map((line) => plainLine(line, width)),
		);
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
		const actions = this.continuing
			? this.continuationPending
				? ["↑↓ scroll", "request pending"]
				: ["↑↓ scroll", "enter start"]
			: live
				? ["↑↓ scroll", active ? "enter steer" : "enter run", "ctrl+c interrupt", "ctrl+k cancel"]
				: record?.sessionFile && record.state !== "running"
					? ["↑↓ scroll", "c copy", "r continue"]
					: ["↑↓ scroll"];
		lines.push(
			this.theme.fg(
				this.currentNotice() ? "warning" : "dim",
				footerWithEscape(
					width,
					actions,
					this.continuing && !this.continuationPending ? "esc cancel draft" : "esc back",
					this.currentNotice(),
				),
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
