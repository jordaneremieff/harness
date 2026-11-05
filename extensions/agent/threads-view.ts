import { randomUUID } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type KeybindingsManager,
	matchesKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { HitMap, TextField } from "../../operator-ui/index.ts";
import { AgentComposer } from "./agent-composer.ts";
import type { CollaborationEvent, CollaborationPage, CollaborationSummary } from "./collaboration.ts";
import { fitLine, readingGeometry } from "./dashboard-layout.ts";
import { dashboardTime } from "./dashboard-time.ts";
import {
	type Collaborate,
	memberDeclarationLines,
	plainThreadText,
	receiptSequence,
	type ThreadDiscovery,
	type ThreadDraft,
	type ThreadsState,
	threadDiscovery,
	threadPage,
} from "./thread-data.ts";

export interface ThreadsViewOptions {
	tui: TUI;
	theme: Theme;
	keys: KeybindingsManager;
	state: ThreadsState;
	collaborate: Collaborate;
	/** A display name for a participant identity; the identity itself when no name is known. */
	nameFor(id: string): string;
	exactTime(): boolean;
	toggleTime(): void;
	/** Show a participant's conversation. */
	openParticipant?(id: string): void;
	redraw(): void;
	/** Escape from the list: leave the Threads view. */
	onExit(): void;
}

type Region = "list" | "exchange" | "controls" | "composer";
type Panel = "exchange" | "members" | "details";

/** One thread's loaded exchange: the newest page and every earlier page read since. */
interface ThreadRead {
	page: CollaborationPage;
	events: CollaborationEvent[];
	nextBefore: number | null;
}

/** Discovery pages read per refresh, and scoped storages followed after them. Both bound one refresh. */
const MAX_PAGES = 64;
const MAX_SOURCES = 16;
const MAX_SOURCE_PAGES = 8;
/** A roster notice rereads the selected thread at once; the whole discovery at most this often. */
const DISCOVERY_INTERVAL_MS = 10_000;

const KIND_LABEL: Record<string, string> = {
	"carried-authority": "carried an operator direction",
};

/** Structural events read as one muted line; their payload belongs to Details or Members. */
const STRUCTURAL_EVENTS: Record<string, string> = {
	create: "created the thread",
	revise: "revised the frame",
	join: "joined",
	leave: "left",
	close: "closed the thread",
};

const oneLine = (text: string) => plainThreadText(text).replace(/\s+/g, " ").trim();
/** Clip with one ellipsis character; the generic line fit must never add its own three dots. */
const clip = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…");
const reason = (error: unknown) => oneLine(String(error instanceof Error ? error.message : error));
const bySequence = (a: CollaborationEvent, b: CollaborationEvent) => a.sequence - b.sequence;

/** The newest page merged with events already read; earlier pages stay reachable. */
function mergeNewest(previous: ThreadRead | undefined, page: CollaborationPage): ThreadRead {
	const events = new Map<number, CollaborationEvent>();
	for (const event of previous?.events ?? []) events.set(event.sequence, event);
	for (const event of page.events) events.set(event.sequence, event);
	const last = previous?.events.at(-1)?.sequence ?? 0;
	const joined = Boolean(previous) && page.events.some((event) => event.sequence <= last);
	return { page, events: [...events.values()].sort(bySequence), nextBefore: joined && previous ? previous.nextBefore : page.nextBefore };
}

/**
 * Threads as a two-pane view: every thread on the left, newest first with open threads leading,
 * and the selected thread's exchange on the right with a composer for posting. Discovery reads
 * every page on its own; the operator never pages through storages. Reading is passive; only the
 * labelled Send posts, and a closed thread refuses posting.
 */
export class ThreadsView {
	private readonly options: ThreadsViewOptions;
	private readonly hits = new HitMap();
	private readonly find = new TextField("Find");
	private readonly composer: AgentComposer;
	private readonly threads = new Map<string, CollaborationSummary>();
	private readonly reads = new Map<string, ThreadRead>();
	private region: Region = "list";
	private panel: Panel = "exchange";
	/** In a narrow window the list and the thread take turns. */
	private narrowThread = false;
	private loading = false;
	private loadedOnce = false;
	private again = false;
	private discoveredAt = 0;
	private generation = 0;
	private readGeneration = 0;
	private listError?: string;
	private notice?: { text: string; kind: "info" | "success" | "warning" | "error" };
	/** A post or send result, shown as the composer receipt. */
	private receipt?: { text: string; kind: "info" | "success" | "warning" | "error" };
	private listScroll = 0;
	private listReveal = true;
	/** The closed-thread disclosure is view-local: expanded and keyboard-focused. */
	private closedExpanded = false;
	private closedFocused = false;
	/** Derived lines, keyed by content signature, width and display state (spec 4.5). */
	private listCache?: { key: string; value: { lines: string[]; blocks: Array<{ id: string; start: number; size: number }>; disclosure?: number } };
	private exchangeCache?: { key: string; lines: Map<number, string[]> };
	/** Lines scrolled up from the newest exchange line; zero follows new posts. */
	private exchangeBack = 0;
	private exchangeMax = 0;
	private detailsOffset = 0;
	/** The focused header control (Members or Details) and the selected member row. */
	private controlIndex = 0;
	private memberIndex = 0;
	/** A thread opened from elsewhere (a related effort's contact thread) returns there on Escape. */
	private direct = false;
	private disposed = false;

	constructor(options: ThreadsViewOptions) {
		this.options = options;
		this.composer = new AgentComposer({
			tui: options.tui,
			theme: options.theme,
			keys: options.keys,
			onSubmit: (text) => void this.post(text),
			onEscape: () => {
				this.region = "list";
				this.options.redraw();
			},
			onChange: (text) => {
				const draft = this.draft();
				if (draft && draft.text !== text) {
					draft.text = text;
					draft.revision++;
				}
			},
		});
	}

	/** Show the view: read every thread, and open one thread when asked. */
	open(threadId?: string): void {
		if (threadId) this.select(threadId, true);
		else if (this.options.state.selected) this.select(this.options.state.selected, false);
		this.direct = Boolean(threadId);
		this.region = threadId ? "exchange" : "list";
		void this.discover(true);
	}

	/** Reread the selected thread now and the thread list when the last read is old enough. */
	async refresh(): Promise<void> {
		const selected = this.options.state.selected;
		if (selected) void this.readThread(selected);
		await this.discover(false);
	}

	// --- data -----------------------------------------------------------------

	private sorted(): CollaborationSummary[] {
		const terms = oneLine(this.find.value).toLocaleLowerCase().split(" ").filter(Boolean);
		return [...this.threads.values()]
			.filter((thread) => {
				if (!terms.length) return true;
				const text = `${thread.title} ${thread.purpose}`.toLocaleLowerCase();
				return terms.every((term) => text.includes(term));
			})
			.sort((a, b) => Number(a.closed) - Number(b.closed) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
	}

	private async call(input: Record<string, unknown>): Promise<unknown> {
		return this.options.collaborate(input);
	}

	/** Read every discovery page, then the storages that reported omitted threads. */
	private async discover(force: boolean): Promise<void> {
		if (this.disposed || (!force && Date.now() - this.discoveredAt < DISCOVERY_INTERVAL_MS)) return;
		if (this.loading) {
			this.again = true;
			return;
		}
		this.loading = true;
		const generation = ++this.generation;
		try {
			const found = await this.collect(generation);
			if (!found || !this.current(generation)) return;
			this.threads.clear();
			for (const [id, thread] of found) this.threads.set(id, thread);
			this.listError = undefined;
			this.discoveredAt = Date.now();
		} catch (error) {
			if (this.current(generation)) this.listError = `Threads could not be read: ${reason(error)}`;
		} finally {
			this.discovered();
		}
	}

	private async collect(generation: number): Promise<Map<string, CollaborationSummary> | undefined> {
		const found = new Map<string, CollaborationSummary>();
		const sources = new Map<string, number>();
		await this.pages(generation, undefined, MAX_PAGES, found, sources);
		for (const sessionId of [...sources.keys()].slice(0, MAX_SOURCES)) {
			if (!this.current(generation)) return undefined;
			await this.pages(generation, sessionId, MAX_SOURCE_PAGES, found, sources);
		}
		return found;
	}

	private discovered(): void {
		this.loading = false;
		this.loadedOnce = true;
		if (this.disposed) return;
		// The newest thread is shown at once; reading it is passive.
		const first = this.sorted()[0];
		if (!this.options.state.selected && first) this.select(first.id, false);
		this.listReveal = true;
		this.options.redraw();
		if (!this.again) return;
		this.again = false;
		void this.discover(true);
	}

	private async pages(generation: number, sessionId: string | undefined, limit: number, found: Map<string, CollaborationSummary>, sources: Map<string, number>): Promise<void> {
		let cursor: string | undefined;
		for (let page = 0; page < limit; page++) {
			const result = await this.call({ action: "list", ...(sessionId ? { sessionId } : {}), ...(cursor ? { cursor } : {}) });
			if (!this.current(generation)) return;
			if (!threadDiscovery(result)) throw new Error("the host returned an invalid thread list");
			this.absorb(result, sessionId === undefined, found, sources);
			if (!result.nextCursor || result.nextCursor === cursor) return;
			cursor = result.nextCursor;
		}
	}

	private absorb(discovery: ThreadDiscovery, root: boolean, found: Map<string, CollaborationSummary>, sources: Map<string, number>): void {
		for (const item of discovery.items) found.set(item.id, item);
		if (root) for (const source of discovery.sources ?? []) if (source.omitted > 0 && !source.unavailable) sources.set(source.sessionId, source.omitted);
		// The first discovery shows each page as it arrives, so a long read never looks empty.
		if (this.loadedOnce) return;
		for (const [id, thread] of found) this.threads.set(id, thread);
		this.options.redraw();
	}

	private current(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}

	private select(threadId: string, openThread: boolean): void {
		if (this.options.state.selected !== threadId) {
			if (this.options.state.selected) this.direct = false;
			this.options.state.selected = threadId;
			this.exchangeBack = 0;
			this.detailsOffset = 0;
			this.panel = "exchange";
			this.notice = undefined;
			this.receipt = undefined;
		}
		// Opening a closed thread reveals the closed group; it stays expanded until collapsed.
		if (this.threads.get(threadId)?.closed) this.closedExpanded = true;
		this.closedFocused = false;
		if (openThread) this.narrowThread = true;
		this.listReveal = true;
		void this.readThread(threadId);
	}

	/** Read the newest page of a thread, keeping earlier pages already read. */
	private async readThread(threadId: string): Promise<void> {
		const generation = ++this.readGeneration;
		const current = () => !this.disposed && generation === this.readGeneration && this.options.state.selected === threadId;
		try {
			const result = await this.call({ action: "read", threadId });
			if (!current()) return;
			if (!threadPage(result) || result.thread.id !== threadId) throw new Error("the host returned an invalid thread page");
			this.reads.set(threadId, mergeNewest(this.reads.get(threadId), result));
			this.notice = undefined;
			const summary = this.threads.get(threadId);
			if (summary) this.threads.set(threadId, { ...summary, updatedAt: result.thread.updatedAt, closed: result.thread.closed, members: result.thread.members.length });
		} catch (error) {
			if (current()) this.notice = { text: `The thread could not be read: ${reason(error)}`, kind: "error" };
		} finally {
			if (!this.disposed) this.options.redraw();
		}
	}

	/** Read the page before the earliest loaded event. */
	private async earlier(): Promise<void> {
		const threadId = this.options.state.selected;
		const read = threadId ? this.reads.get(threadId) : undefined;
		if (!threadId || !read?.nextBefore) return;
		const before = read.nextBefore;
		try {
			const result = await this.call({ action: "read", threadId, before });
			const current = this.reads.get(threadId);
			if (this.disposed || this.options.state.selected !== threadId || current?.nextBefore !== before) return;
			if (!threadPage(result) || result.thread.id !== threadId) throw new Error("the host returned an invalid thread page");
			const known = new Set(current.events.map((event) => event.sequence));
			current.events = [...result.events.filter((event) => !known.has(event.sequence)), ...current.events].sort(bySequence);
			current.nextBefore = result.nextBefore;
			this.notice = undefined;
		} catch (error) {
			if (!this.disposed) this.notice = { text: `Earlier messages could not be read: ${reason(error)}`, kind: "error" };
		} finally {
			if (!this.disposed) this.options.redraw();
		}
	}

	private draft(): ThreadDraft | undefined {
		const id = this.options.state.selected;
		if (!id) return undefined;
		let draft = this.options.state.drafts.get(id);
		if (!draft) {
			draft = { text: "", revision: 0, notify: [], pending: false };
			this.options.state.drafts.set(id, draft);
		}
		return draft;
	}

	private selectedRead(): ThreadRead | undefined {
		const id = this.options.state.selected;
		return id ? this.reads.get(id) : undefined;
	}

	private canPost(): boolean {
		const read = this.selectedRead();
		return Boolean(read && !read.page.thread.closed);
	}

	/** Post the draft. An uncertain retry of the same content reuses its request ID. */
	private async post(message: string): Promise<void> {
		const draft = this.draft();
		const threadId = this.options.state.selected;
		if (!draft || !threadId || draft.pending || !message.trim()) return;
		if (!this.canPost()) {
			this.receipt = { text: "This thread is closed; posting is off.", kind: "warning" };
			this.options.redraw();
			return;
		}
		const revision = draft.revision;
		const content = JSON.stringify([revision, message, draft.notify, draft.replyTo ?? null]);
		if (draft.request?.content !== content) draft.request = { id: randomUUID(), content };
		draft.pending = true;
		this.receipt = { text: "Posting…", kind: "info" };
		this.options.redraw();
		try {
			const result = await this.call({
				action: "post",
				threadId,
				message,
				notify: [...draft.notify],
				...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
				origin: "operator",
				requestId: draft.request.id,
			});
			receiptSequence(result, threadId);
			this.posted(draft, revision, threadId);
		} catch (error) {
			if (!this.disposed) this.receipt = { text: `The post was not confirmed: ${reason(error)}. Your draft stays; Send retries it once.`, kind: "error" };
		} finally {
			draft.pending = false;
			if (!this.disposed) this.options.redraw();
		}
	}

	/** A retained post clears the draft it carried; a newer draft revision stays untouched. */
	private posted(draft: ThreadDraft, revision: number, threadId: string): void {
		draft.request = undefined;
		if (draft.revision === revision) {
			draft.text = "";
			draft.notify = [];
			draft.replyTo = undefined;
			draft.revision++;
		}
		if (this.disposed || this.options.state.selected !== threadId) return;
		this.composer.setText(draft.text);
		this.exchangeBack = 0;
		this.receipt = { text: "Posted.", kind: "success" };
		void this.readThread(threadId);
	}

	private replyTo(event: CollaborationEvent): void {
		const draft = this.draft();
		if (!draft || !this.canPost()) return;
		draft.replyTo = draft.replyTo === event.sequence ? undefined : event.sequence;
		draft.revision++;
		this.region = "composer";
	}

	private toggleNotify(identity: string): void {
		const draft = this.draft();
		if (!draft) return;
		if (draft.notify.includes(identity)) draft.notify = draft.notify.filter((item) => item !== identity);
		else if (draft.notify.length < 16) draft.notify.push(identity);
		else return;
		draft.revision++;
	}

	private name(id: string): string {
		const name = oneLine(this.options.nameFor(id));
		return name && name !== id ? name : `Session ${id.slice(0, 8)}`;
	}

	// --- input ----------------------------------------------------------------

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.traverse(matchesKey(data, "shift+tab"));
		else if (this.region === "composer") this.composerInput(data);
		else if (this.region === "controls") this.controlsInput(data);
		else if (this.region === "exchange") {
			if (this.panel !== "members" || matchesKey(data, "escape") || !this.membersInput(data)) this.exchangeInput(data);
		} else this.listInput(data);
		this.options.redraw();
	}

	private regions(): Region[] {
		const order: Region[] = ["list"];
		if (this.options.state.selected) order.push("exchange", "controls");
		if (this.canPost() && this.panel === "exchange") order.push("composer");
		return order;
	}

	private panelControls(): Array<[Panel, string]> {
		return [
			["members", this.panel === "members" ? "Exchange" : "Members"],
			["details", this.panel === "details" ? "Exchange" : "Details"],
		];
	}

	private showPanel(panel: Panel): void {
		this.panel = this.panel === panel ? "exchange" : panel;
		this.region = "exchange";
		this.detailsOffset = 0;
		this.memberIndex = 0;
	}

	private controlsInput(data: string): void {
		if (matchesKey(data, "left") || matchesKey(data, "right")) this.controlIndex = matchesKey(data, "left") ? 0 : 1;
		else if (matchesKey(data, "enter") || data === " ") this.showPanel(this.panelControls()[this.controlIndex]?.[0] ?? "members");
		else if (matchesKey(data, "escape")) this.region = "exchange";
	}

	/** Members: Up and Down choose, Enter opens the conversation, Space ticks a wake for the next post. */
	private membersInput(data: string): boolean {
		const members = this.selectedRead()?.page.thread.members ?? [];
		const member = members[this.memberIndex];
		if (matchesKey(data, "up") || matchesKey(data, "down")) this.memberIndex = Math.max(0, Math.min(members.length - 1, this.memberIndex + (matchesKey(data, "up") ? -1 : 1)));
		else if (matchesKey(data, "home") || matchesKey(data, "end")) this.memberIndex = matchesKey(data, "home") ? 0 : Math.max(0, members.length - 1);
		else if (matchesKey(data, "enter") && member) this.options.openParticipant?.(member.identity);
		else if (data === " " && member && this.canPost()) this.toggleNotify(member.identity);
		else return false;
		return true;
	}

	private traverse(backward: boolean): void {
		const order = this.regions();
		const index = Math.max(0, order.indexOf(this.region));
		this.region = order[(index + (backward ? order.length - 1 : 1)) % order.length] ?? "list";
		if (this.region !== "list") this.narrowThread = true;
	}

	private composerInput(data: string): void {
		if (!this.canPost()) {
			this.region = "exchange";
			return;
		}
		this.composer.handleInput(data);
	}

	private exchangeInput(data: string): void {
		const page = Math.max(1, this.options.tui.terminal.rows - 10);
		if (matchesKey(data, "escape")) this.exchangeEscape();
		else if (matchesKey(data, "up")) this.scroll(1);
		else if (matchesKey(data, "down")) this.scroll(-1);
		else if (matchesKey(data, "pageUp")) this.scroll(page);
		else if (matchesKey(data, "pageDown")) this.scroll(-page);
		else if (matchesKey(data, "home")) {
			this.scroll(Number.MAX_SAFE_INTEGER);
			void this.earlier();
		} else if (matchesKey(data, "end")) this.scroll(-Number.MAX_SAFE_INTEGER);
		else if (matchesKey(data, "enter") && this.canPost() && this.panel === "exchange") this.region = "composer";
	}

	private exchangeEscape(): void {
		if (this.panel !== "exchange") this.panel = "exchange";
		else if (this.direct) {
			this.direct = false;
			this.options.onExit();
		} else {
			this.region = "list";
			this.narrowThread = false;
		}
	}

	private scroll(lines: number): void {
		if (this.panel === "details") this.detailsOffset = Math.max(0, this.detailsOffset - lines);
		else this.exchangeBack = Math.max(0, Math.min(this.exchangeMax, this.exchangeBack + lines));
	}

	private listInput(data: string): void {
		if (matchesKey(data, "escape")) this.listEscape();
		else if (matchesKey(data, "enter")) this.listEnter();
		else if (!this.listMove(data)) this.typeFind(data);
	}

	/**
	 * Arrow, page, Home and End keys move through open threads, the closed disclosure and, when it
	 * is expanded, the closed threads. Reading the selected thread is passive.
	 */
	private listMove(data: string): boolean {
		const targets = this.listTargets();
		if (!targets.length) return false;
		const current = this.closedFocused
			? targets.findIndex((target) => target.closed)
			: targets.findIndex((target) => target.id === this.options.state.selected);
		const moves: Array<[Parameters<typeof matchesKey>[1], number]> = [
			["up", -1],
			["down", 1],
			["pageUp", -8],
			["pageDown", 8],
			["home", -Number.MAX_SAFE_INTEGER],
			["end", Number.MAX_SAFE_INTEGER],
		];
		const move = moves.find(([key]) => matchesKey(data, key));
		if (!move) return false;
		const next = targets[Math.max(0, Math.min(targets.length - 1, Math.max(0, current) + move[1]))];
		if (!next) return false;
		if (next.closed) this.closedFocused = true;
		else if (next.id) this.select(next.id, false);
		return true;
	}

	/** The navigable list targets in visual order; Find reveals open and closed matches together. */
	private listTargets(): Array<{ id?: string; closed?: boolean }> {
		const rows = this.sorted();
		if (this.find.value.trim()) return rows.map((row) => ({ id: row.id }));
		const open = rows.filter((row) => !row.closed);
		const closed = rows.filter((row) => row.closed);
		const targets: Array<{ id?: string; closed?: boolean }> = open.map((row) => ({ id: row.id }));
		if (closed.length) targets.push({ closed: true });
		if (this.closedExpanded) for (const row of closed) targets.push({ id: row.id });
		return targets;
	}

	private listEscape(): void {
		if (!this.find.value) {
			this.options.onExit();
			return;
		}
		this.find.value = "";
		this.closedFocused = false;
		this.listScroll = 0;
	}

	private listEnter(): void {
		if (this.closedFocused) {
			this.closedExpanded = !this.closedExpanded;
			this.listReveal = true;
			return;
		}
		const first = this.sorted()[0];
		if (!this.options.state.selected && first) this.select(first.id, true);
		const selected = Boolean(this.options.state.selected);
		this.narrowThread = selected;
		this.region = this.canPost() ? "composer" : selected ? "exchange" : "list";
	}

	/** Typing over the list writes into its Find field. */
	private typeFind(data: string): void {
		if (data.startsWith("\u001b") && !matchesKey(data, "backspace")) return;
		this.find.handleInput(data);
		this.closedFocused = false;
		this.listScroll = 0;
		this.listReveal = true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed) return undefined;
		const result = this.hits.handle(event);
		if (result) this.options.redraw();
		return result;
	}

	// --- render ---------------------------------------------------------------

	/** The view below the dashboard heading: the list and the selected thread. */
	render(width: number, height: number, listWidth: number): string[] {
		this.hits.begin(width, height);
		const bodyHeight = Math.max(1, height);
		const wide = width >= 100 && listWidth > 0;
		let body: string[];
		if (wide) {
			// The same split as the Agents tab: the divider sits at column `listWidth` in every tab.
			const list = this.renderList(0, listWidth - 1, bodyHeight);
			const pane = this.renderThread(listWidth + 1, width - listWidth - 1, bodyHeight);
			const divider = this.options.theme.fg(this.region === "list" ? "accent" : "borderMuted", "│");
			body = Array.from({ length: bodyHeight }, (_, row) => fitLine(list[row] ?? "", listWidth) + divider + fitLine(pane[row] ?? "", width - listWidth - 1));
		} else if (this.narrowThread && this.options.state.selected) body = this.renderThread(0, width, bodyHeight, true);
		else body = this.renderList(0, width, bodyHeight);
		return body.map((line) => fitLine(line, width));
	}

	private renderList(x0: number, width: number, height: number): string[] {
		const theme = this.options.theme;
		this.find.focused = this.region === "list";
		const findLine = this.find.render(width, theme, 6, "type to find threads");
		this.hits.add({ x: x0, y: 0, width, height: 1, click: () => { this.region = "list"; } });
		const rows = this.sorted();
		const room = Math.max(1, height - 2);
		const { lines, blocks, disclosure } = this.listLines(rows, width);
		this.revealSelection(blocks, room, disclosure);
		this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, lines.length - room)));
		for (const block of blocks) {
			const top = block.start - this.listScroll;
			if (top + block.size <= 0 || top >= room) continue;
			this.hits.add({ x: x0, y: 1 + Math.max(0, top), width, height: Math.min(block.size, room - Math.max(0, top)), click: () => { this.select(block.id, true); this.region = "list"; } });
		}
		if (disclosure !== undefined) {
			const top = disclosure - this.listScroll;
			if (top >= 0 && top < room) this.hits.add({ x: x0, y: 1 + top, width, height: 1, click: () => { this.closedExpanded = !this.closedExpanded; this.closedFocused = false; this.listReveal = true; } });
		}
		this.hits.add({ x: x0, y: 1, width, height: room, wheel: (delta) => { this.listScroll = Math.max(0, this.listScroll + delta); } });
		const visible = lines.slice(this.listScroll, this.listScroll + room);
		return [findLine, ...Array.from({ length: room }, (_, row) => visible[row] ?? ""), this.listFooter(rows.length, width)].map((line) => fitLine(line, width));
	}

	/** Open threads first, then the closed disclosure and its expanded group. Find reveals every match. */
	private listLines(rows: readonly CollaborationSummary[], width: number): { lines: string[]; blocks: Array<{ id: string; start: number; size: number }>; disclosure?: number } {
		const key = this.listKey(rows, width);
		if (this.listCache?.key === key) return this.listCache.value;
		const lines: string[] = [];
		const blocks: Array<{ id: string; start: number; size: number }> = [];
		const searching = Boolean(this.find.value.trim());
		const open = rows.filter((row) => !row.closed);
		const closed = rows.filter((row) => row.closed);
		const visible = searching ? rows : [...open, ...(this.closedExpanded ? closed : [])];
		let disclosure: number | undefined;
		for (const row of visible) {
			blocks.push({ id: row.id, start: lines.length, size: 3 });
			lines.push(...this.threadBlock(row, width));
			if (!searching && closed.length && row === open.at(-1)) {
				disclosure = lines.length;
				lines.push(this.closedDisclosure(closed.length, width), "");
			}
		}
		if (!searching && !open.length && closed.length) {
			disclosure = lines.length;
			lines.push(this.closedDisclosure(closed.length, width), "");
		}
		const value = { lines, blocks, disclosure };
		this.listCache = { key, value };
		return value;
	}

	/** Content, width, selection, disclosure, Find, exact time and the relative-time minute. */
	private listKey(rows: readonly CollaborationSummary[], width: number): string {
		const contents = rows.map((row) => `${row.id}:${row.updatedAt}:${row.closed}:${row.members}:${row.title}:${row.purpose}`).join("|");
		return [contents, width, this.options.state.selected, this.closedExpanded, this.closedFocused, this.find.value, this.options.exactTime(), Math.floor(Date.now() / 60_000)].join("#");
	}

	/** One muted disclosure row for the closed group; accent while it owns keyboard focus. */
	private closedDisclosure(count: number, width: number): string {
		const theme = this.options.theme;
		const text = ` ${this.closedExpanded ? "▾" : "▸"} Closed · ${count}`;
		if (!this.closedFocused) return theme.fg("muted", text);
		return theme.bg("selectedBg", fitLine(theme.fg("accent", text), width));
	}

	/** After a selection change the list scrolls just enough to show the selected thread or the disclosure. */
	private revealSelection(blocks: ReadonlyArray<{ id: string; start: number; size: number }>, room: number, disclosure?: number): void {
		if (!this.listReveal) return;
		const selected = this.closedFocused && disclosure !== undefined ? { start: disclosure, size: 1 } : blocks.find((block) => block.id === this.options.state.selected);
		if (!selected) return;
		if (selected.start < this.listScroll) this.listScroll = Math.max(0, selected.start - 1);
		else if (selected.start + selected.size > this.listScroll + room) this.listScroll = selected.start + selected.size - room;
		this.listReveal = false;
	}

	private listFooter(count: number, width: number): string {
		const theme = this.options.theme;
		if (this.listError) return theme.fg("warning", clip(this.listError, width));
		if (count) return theme.fg("muted", clip(`${count} thread${count === 1 ? "" : "s"}${this.loading ? " · reading…" : ""}`, width));
		if (this.loading || !this.loadedOnce) return theme.fg("muted", "Reading threads…");
		return theme.fg("muted", clip(this.find.value ? `No thread matches “${oneLine(this.find.value)}”.` : "No threads yet.", width));
	}

	private threadBlock(row: CollaborationSummary, width: number): string[] {
		const theme = this.options.theme;
		const chosen = row.id === this.options.state.selected && !this.closedFocused;
		const rail = chosen ? theme.fg("accent", "▌ ") : "  ";
		const glyph = row.closed ? theme.fg("muted", "○ ") : theme.fg("success", "● ");
		const time = dashboardTime(row.updatedAt, this.options.exactTime());
		const titleRoom = Math.max(1, width - 6 - visibleWidth(time));
		const title = truncateToWidth(oneLine(row.title) || "Untitled thread", titleRoom, "…");
		const first = `${rail}${glyph}${theme.bold(theme.fg(row.closed ? "muted" : "text", title))}`;
		const lines = [
			`${fitLine(first, width - visibleWidth(time) - 1)}${theme.fg("muted", time)} `,
			`${rail}  ${theme.fg("muted", truncateToWidth(oneLine(row.purpose) || "No purpose stated", Math.max(1, width - 4), "…"))}`,
		];
		// Two quiet lines and a spacing line; the selected background covers only the content lines.
		return [...(chosen ? lines.map((line) => theme.bg("selectedBg", fitLine(line, width))) : lines), ""];
	}

	private renderThread(x0: number, width: number, height: number, narrow = false): string[] {
		const id = this.options.state.selected;
		if (!id) return this.emptyThread(width, height);
		const read = this.reads.get(id);
		const summary = this.threads.get(id);
		const closed = read?.page.thread.closed ?? summary?.closed ?? false;
		const header = this.threadHeader(read, summary, x0, width, narrow, closed);
		const composer = this.panel === "exchange" ? this.renderComposer(width, height, closed) : [];
		const middleHeight = Math.max(1, height - header.length - composer.length);
		const middle = this.threadMiddle(read, x0, header.length, width, middleHeight);
		if (composer.length && !closed) this.composerHits(x0, header.length + middleHeight, width, composer.length);
		return [...header, ...Array.from({ length: middleHeight }, (_, row) => middle[row] ?? ""), ...composer].slice(0, height);
	}

	/** Two header lines: title and controls, then state, counts and one purpose preview. */
	private threadHeader(read: ThreadRead | undefined, summary: CollaborationSummary | undefined, x0: number, width: number, narrow: boolean, closed: boolean): string[] {
		const theme = this.options.theme;
		const back = narrow ? "‹ Threads " : "";
		if (narrow) this.hits.add({ x: x0, y: 0, width: visibleWidth(back), height: 1, click: () => { this.narrowThread = false; this.region = "list"; } });
		const title = oneLine(read?.page.thread.title ?? summary?.title ?? "Thread");
		const members = read?.page.thread.members.length ?? summary?.members ?? 0;
		const controls = this.panelControls();
		const controlText = controls.map(([, label]) => ` ${label} `);
		const controlWidth = controlText.reduce((sum, text) => sum + visibleWidth(text), 0);
		const leftRoom = Math.max(1, width - controlWidth);
		const titleRoom = Math.max(1, leftRoom - visibleWidth(back) - 1);
		const left = `${theme.fg("accent", back)} ${theme.bold(theme.fg("text", clip(title, titleRoom)))}`;
		let x = x0 + Math.max(0, width - controlWidth);
		controls.forEach(([panel], index) => {
			const w = visibleWidth(controlText[index] ?? "");
			this.hits.add({ x, y: 0, width: w, height: 1, click: () => this.showPanel(panel) });
			x += w;
		});
		const paint = (text: string, index: number) => (this.region === "controls" && index === this.controlIndex ? theme.bg("selectedBg", theme.bold(theme.fg("accent", text))) : theme.fg("accent", text));
		const header = [`${fitLine(left, Math.max(1, width - controlWidth))}${controlText.map(paint).join("")}`];
		const posts = read ? `${read.events.length} ${read.nextBefore ? "loaded " : ""}post${read.events.length === 1 ? "" : "s"}` : "";
		const counts = [closed ? "Closed" : "Open", `${members} member${members === 1 ? "" : "s"}`, posts].filter(Boolean).join(" · ");
		const purpose = oneLine(read?.page.thread.purpose ?? summary?.purpose ?? "");
		const detail = this.notice ? oneLine(this.notice.text) : purpose;
		const line = ` ${counts}${detail ? ` · ${detail}` : ""}`;
		header.push(theme.fg(this.notice ? "error" : "muted", truncateToWidth(line, Math.max(1, width - 1), "…")));
		// One blank row separates the header from the exchange.
		header.push("");
		return header;
	}

	private threadMiddle(read: ThreadRead | undefined, x0: number, y0: number, width: number, height: number): string[] {
		if (!read) return [this.options.theme.fg("muted", " Reading the thread…")];
		if (this.panel === "members") return this.renderMembers(read, x0, y0, width, height);
		if (this.panel === "details") return this.renderDetails(read, x0, y0, width, height);
		return this.renderExchange(read, x0, y0, width, height);
	}

	private emptyThread(width: number, height: number): string[] {
		const theme = this.options.theme;
		const lines = [
			` ${theme.bold(clip("No thread selected", width - 1))}`,
			"",
			theme.fg("muted", ` ${clip(this.threads.size ? "Select a thread in the list to read it." : this.loadedOnce ? "No threads yet. Agents create threads when they collaborate." : "Reading threads…", width - 1)}`),
		];
		return Array.from({ length: height }, (_, row) => lines[row] ?? "");
	}

	/** The exchange, newest at the bottom. Scrolling to the top offers earlier messages. */
	private renderExchange(read: ThreadRead, x0: number, y0: number, width: number, height: number): string[] {
		const theme = this.options.theme;
		const pad = " ".repeat(readingGeometry(width).margin);
		const lines: string[] = [read.nextBefore ? theme.fg("accent", `${pad}↑ Earlier messages`) : theme.fg("muted", `${pad}Start of the thread`)];
		const targets: Array<{ line: number; event: CollaborationEvent }> = [];
		const events = new Map(read.events.map((event) => [event.sequence, event]));
		const cacheKey = this.exchangeKey(read, width);
		if (this.exchangeCache?.key !== cacheKey) this.exchangeCache = { key: cacheKey, lines: new Map() };
		for (const event of read.events) {
			lines.push("");
			targets.push({ line: lines.length, event });
			const cached = this.exchangeCache.lines.get(event.sequence);
			if (cached) lines.push(...cached);
			else {
				const rendered = this.eventLines(event, events, width);
				this.exchangeCache.lines.set(event.sequence, rendered);
				lines.push(...rendered);
			}
		}
		if (!read.events.length) lines.push("", theme.fg("muted", `${pad}No messages yet.`));
		lines.push("");
		this.exchangeMax = Math.max(0, lines.length - height);
		this.exchangeBack = Math.min(this.exchangeBack, this.exchangeMax);
		const start = Math.max(0, lines.length - height - this.exchangeBack);
		if (start === 0 && read.nextBefore) this.hits.add({ x: x0, y: y0, width, height: 1, click: () => void this.earlier() });
		for (const target of targets) {
			const y = target.line - start;
			if (y >= 0 && y < height) this.hits.add({ x: x0, y: y0 + y, width, height: 1, click: () => { this.replyTo(target.event); } });
		}
		this.hits.add({ x: x0, y: y0, width, height, wheel: (delta) => { this.exchangeBack = Math.max(0, Math.min(this.exchangeMax, this.exchangeBack - delta)); if (this.exchangeBack === this.exchangeMax && read.nextBefore && delta < 0) void this.earlier(); } });
		return lines.slice(start, start + height).map((line) => fitLine(line, width));
	}

	/**
	 * One entry. Contributions and carried authority show their full post; structural events show one
	 * muted line so the frame and member contributions stay out of the exchange.
	 */
	private eventLines(event: CollaborationEvent, events: ReadonlyMap<number, CollaborationEvent>, width: number): string[] {
		// A close keeps its muted state line and shows why the thread ended as post text.
		if (event.kind === "close") return [...(this.structuralEventLine(event, width) ?? []), ...this.postBody(event, width)];
		const structural = this.structuralEventLine(event, width);
		return structural ?? this.postLines(event, events, width);
	}

	/** A create, revise, join, leave or close event as one muted line. */
	private structuralEventLine(event: CollaborationEvent, width: number): string[] | undefined {
		const label = STRUCTURAL_EVENTS[event.kind];
		if (!label) return undefined;
		const { margin, textWidth } = readingGeometry(width);
		const time = dashboardTime(event.at, this.options.exactTime());
		const text = `${this.name(event.sender)} ${label} · ${time}`;
		return [this.options.theme.fg("muted", `${" ".repeat(margin)}${clip(text, textWidth)}`)];
	}

	/** A contribution or carried authority: bold sender, muted metadata, then the wrapped post. */
	private postLines(event: CollaborationEvent, events: ReadonlyMap<number, CollaborationEvent>, width: number): string[] {
		const theme = this.options.theme;
		const { margin, textWidth } = readingGeometry(width);
		const pad = " ".repeat(margin);
		const time = dashboardTime(event.at, this.options.exactTime());
		const marked = this.draft()?.replyTo === event.sequence ? theme.fg("accent", " · replying") : "";
		const head = `${theme.bold(theme.fg("text", this.name(event.sender)))}${this.eventMetadata(event)}${marked}`;
		const timeText = theme.fg("muted", `  ${time}`);
		const headWidth = Math.max(1, textWidth - visibleWidth(timeText));
		const lines = [`${pad}${fitLine(clip(head, headWidth), headWidth)}${timeText}`];
		if (event.replyTo) lines.push(theme.fg("muted", `${pad}${clip(`↳ ${this.replyTarget(event, events)}`, textWidth)}`));
		lines.push(...this.postBody(event, width));
		if (event.notify.length) lines.push(theme.fg("muted", `${pad}${clip(`notified ${event.notify.map((id) => this.name(id)).join(", ")}`, textWidth)}`));
		return lines;
	}

	/** Post text at the shared reading width, with blank rows inside the post preserved. */
	private postBody(event: CollaborationEvent, width: number): string[] {
		const { margin, textWidth } = readingGeometry(width);
		const pad = " ".repeat(margin);
		const text = plainThreadText(event.message).trim();
		const lines: string[] = [];
		for (const source of text ? text.split("\n") : []) {
			if (!source.trim()) {
				lines.push("");
				continue;
			}
			lines.push(...wrapTextWithAnsi(source, textWidth).map((part) => `${pad}${part}`));
		}
		return lines;
	}

	/** Operator origin and event kind, all muted. */
	private eventMetadata(event: CollaborationEvent): string {
		const theme = this.options.theme;
		const kind = event.kind === "contribution" ? "" : theme.fg("muted", ` · ${KIND_LABEL[event.kind] ?? oneLine(event.kind)}`);
		const origin = event.origin === "operator" ? theme.fg("muted", " · operator") : "";
		return `${origin}${kind}`;
	}

	private replyTarget(event: CollaborationEvent, events: ReadonlyMap<number, CollaborationEvent>): string {
		const parent = event.replyTo ? events.get(event.replyTo) : undefined;
		return parent ? this.name(parent.sender) : `#${event.replyTo}`;
	}

	/** Event identities, width, reply target, names, exact time and the minute. */
	private exchangeKey(read: ThreadRead, width: number): string {
		const names = read.events.map((event) => `${this.name(event.sender)}:${event.notify.map((id) => this.name(id)).join(",")}`).join("|");
		return [read.page.thread.id, width, this.options.exactTime(), this.draft()?.replyTo ?? "", names, Math.floor(Date.now() / 60_000), read.events.map((event) => event.sequence).join(",")].join("#");
	}

	private renderMembers(read: ThreadRead, x0: number, y0: number, width: number, height: number): string[] {
		const theme = this.options.theme;
		const draft = this.draft();
		const lines = [theme.fg("muted", " Click a name to open its conversation."), ...(this.canPost() ? [theme.fg("muted", " Ticked members wake on your next post.")] : [])];
		this.memberIndex = Math.max(0, Math.min(read.page.thread.members.length - 1, this.memberIndex));
		read.page.thread.members.forEach((member, index) => {
			const ticked = draft?.notify.includes(member.identity) ? "[x]" : "[ ]";
			const y = lines.length;
			const box = this.canPost() ? `${ticked} ` : "";
			const marker = this.region === "exchange" && index === this.memberIndex ? theme.fg("accent", "›") : " ";
			lines.push(`${marker}${theme.fg("accent", box)}${theme.bold(clip(this.name(member.identity), width - 3 - visibleWidth(box)))}`);
			lines.push(theme.fg("muted", `     ${truncateToWidth(oneLine(member.contribution) || "No contribution declared", Math.max(1, width - 6), "…")}`));
			if (y < height) {
				if (box) this.hits.add({ x: x0 + 1, y: y0 + y, width: 4, height: 1, click: () => this.toggleNotify(member.identity) });
				this.hits.add({ x: x0 + 1 + visibleWidth(box), y: y0 + y, width: Math.max(1, width - 1 - visibleWidth(box)), height: 1, click: () => this.options.openParticipant?.(member.identity) });
			}
		});
		return lines.slice(0, height).map((line) => fitLine(line, width));
	}

	private renderDetails(read: ThreadRead, x0: number, y0: number, width: number, height: number): string[] {
		const theme = this.options.theme;
		const thread = read.page.thread;
		const field = (label: string, value: string) => [theme.fg("muted", ` ${label}`), ...wrapTextWithAnsi(plainThreadText(value).trim() || "Not stated", Math.max(1, width - 3)).map((line) => `   ${line}`), ""];
		const lines = [
			...field("Purpose", thread.purpose),
			...field("Operator direction (as carried)", thread.authority),
			...field("Source", thread.source),
			...field("Restrictions", thread.restrictions),
			...field("Acceptance", thread.acceptance),
			...field("Integrator", this.name(thread.integrator)),
			...field("Created by", `${this.name(thread.creator)} · ${dashboardTime(thread.createdAt, this.options.exactTime())}`),
			...memberDeclarationLines(thread, (id) => this.name(id)).map((line, index) => (index === 0 ? theme.fg("muted", ` ${line}`) : `   ${line}`)),
		].flatMap((line) => (visibleWidth(line) > width ? wrapTextWithAnsi(line, width) : [line]));
		this.detailsOffset = Math.max(0, Math.min(this.detailsOffset, Math.max(0, lines.length - height)));
		this.hits.add({ x: x0, y: y0, width, height, wheel: (delta) => { this.detailsOffset = Math.max(0, this.detailsOffset + delta); } });
		return lines.slice(this.detailsOffset, this.detailsOffset + height).map((line) => fitLine(line, width));
	}

	private renderComposer(width: number, height: number, closed: boolean): string[] {
		const theme = this.options.theme;
		if (closed) return [theme.fg("muted", " This thread is closed; posting is off.")];
		const draft = this.draft();
		if (draft && this.composer.getText() !== draft.text) this.composer.setText(draft.text);
		this.composer.focused = this.region === "composer";
		this.composer.limitRows(Math.max(5, Math.floor(height / 3)));
		const title = oneLine(this.selectedRead()?.page.thread.title ?? "thread");
		const parts: string[] = [];
		if (draft?.replyTo) parts.push(`reply to #${draft.replyTo}`);
		if (draft?.notify.length) parts.push(`wakes ${draft.notify.length}`);
		const caption = `Post to ${title}`;
		return this.composer.render(width, caption, parts.join(" · "), draft?.pending ? "Posting…" : this.receipt?.text ?? "", ["Send"]);
	}

	private composerHits(x0: number, y0: number, width: number, rows: number): void {
		const send = this.composer.spans.controls[0];
		const bottom = this.composer.renderedBottom;
		this.hits.add({
			x: x0,
			y: y0,
			width,
			height: rows,
			click: (event) => {
				this.region = "composer";
				if (send && event.y === bottom && event.x >= send.x && event.x < send.x + send.width) {
					const text = this.composer.getText();
					if (text.trim()) void this.post(text);
					return undefined;
				}
				return this.composer.handleMouse({ ...event, width, height: rows }) ?? { handled: true, focus: true };
			},
		});
	}

	invalidate(): void {
		this.hits.clear();
		this.listCache = undefined;
		this.exchangeCache = undefined;
		this.composer.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.generation++;
		this.readGeneration++;
		this.listCache = undefined;
		this.exchangeCache = undefined;
	}
}
