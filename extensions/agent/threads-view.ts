import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type KeybindingsManager,
	Markdown,
	matchesKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Action, type Control, HitMap, TextField, actionControl, keyInput, keyMatches } from "../../operator-ui/index.ts";
import { AgentComposer } from "./agent-composer.ts";
import type { CollaborationEvent, CollaborationPage, CollaborationSummary } from "./collaboration.ts";
import { LIST_BLOCK_ROWS, fitLine, listBlock, readingGeometry } from "./dashboard-layout.ts";
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

type Region = "list" | "find" | "exchange" | "composer";
type Panel = "exchange" | "members" | "details";
/** The focus whose keys the footer describes. */
type Focus = "list" | "find" | "exchange" | "members" | "details" | "composer";

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
/** A post longer than this many rendered lines opens as a preview of PREVIEW_LINES lines. */
const LONG_POST_LINES = 16;
const PREVIEW_LINES = 10;
/** Purpose rows the thread header shows before Details. */
const PURPOSE_ROWS = 3;

/** One rendered exchange entry: its rows, the row that toggles a long post, and its post header row. */
interface EventRows {
	readonly lines: string[];
	readonly toggle?: number;
	readonly header?: number;
}

/** Where one event sits in the exchange document. */
interface ExchangeSpan {
	readonly start: number;
	readonly end: number;
	readonly header: number | undefined;
	readonly toggle: number | undefined;
	readonly event: CollaborationEvent;
}

/** The exchange's place on screen and its first document row. */
interface ExchangeArea {
	readonly x0: number;
	readonly y0: number;
	readonly width: number;
	readonly height: number;
	readonly start: number;
}

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
	private exchangeCache?: { key: string; lines: Map<number, EventRows> };
	/** Long posts the operator opened or closed against the view's default; Ctrl+O flips the default. */
	private readonly postChoices = new Set<string>();
	private postsOpen = false;
	/** Rows of the last exchange document, so opening a post keeps the window's first row in place. */
	private exchangeTotal = 0;
	private keepWindowTop = false;
	/** Lines scrolled up from the newest exchange line; zero follows new posts. */
	private exchangeBack = 0;
	private exchangeMax = 0;
	private detailsOffset = 0;
	/** The selected member row of the Members panel. */
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

	/** A thread's title from discovery or a read page, when this view has seen it. */
	title(id: string): string | undefined {
		return this.threads.get(id)?.title ?? this.reads.get(id)?.page.thread.title;
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

	/** The role the thread's own frame names for a participant. */
	private role(id: string): string {
		const thread = this.selectedRead()?.page.thread;
		return thread && thread.integrator === id ? "integrator" : "";
	}

	/** Whether one long post shows in full: the view default, flipped by the operator's choice for that post. */
	private postOpen(key: string): boolean {
		return this.postsOpen !== this.postChoices.has(key);
	}

	private togglePost(key: string): void {
		if (this.postChoices.has(key)) this.postChoices.delete(key);
		else this.postChoices.add(key);
		this.exchangeCache = undefined;
		this.keepWindowTop = true;
	}

	/** Ctrl+O opens or closes every long post in the view. */
	private toggleAllPosts(): void {
		this.postsOpen = !this.postsOpen;
		this.postChoices.clear();
		this.exchangeCache = undefined;
		this.keepWindowTop = true;
	}

	// --- input ----------------------------------------------------------------

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.region === "find") this.findInput(data);
		else if (this.region === "composer") this.composerKey(data);
		else if (matchesKey(data, "escape")) this.leaveFocus();
		else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.traverse(matchesKey(data, "shift+tab"));
		else if (!this.actionKey(data)) this.focusInput(data);
		this.options.redraw();
	}

	/** The message field takes every key but Tab, which moves focus on, as its footer says. */
	private composerKey(data: string): void {
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.traverse(matchesKey(data, "shift+tab"));
		else this.composerInput(data);
	}

	private focusInput(data: string): void {
		if (this.region === "exchange") {
			if (this.panel === "members") this.membersInput(data);
			else if (this.panel === "details") this.detailsInput(data);
			else this.exchangeInput(data);
		} else this.listInput(data);
	}

	/** The focus whose keys the footer describes. */
	private focus(): Focus {
		if (this.region === "find" || this.region === "composer") return this.region;
		if (this.region === "list") return "list";
		return this.panel;
	}

	/** Every action of this view, re-read at each render and each invocation. */
	private actions(): Action[] {
		const closed = this.canPost() ? undefined : "This thread is closed; posting is off.";
		const expand = this.options.keys.getKeys("app.tools.expand")[0] ?? "ctrl+o";
		return [
			{ id: "members", label: this.panel === "members" ? "Exchange" : "Members", key: "m", run: () => this.showPanel("members") },
			{ id: "details", label: this.panel === "details" ? "Exchange" : "Details", key: "d", run: () => this.showPanel("details") },
			{ id: "posts", label: this.postsOpen ? "Close posts" : "Open posts", key: expand, run: () => this.toggleAllPosts() },
			{ id: "write", label: "Write", key: "enter", disabled: closed, run: () => { this.region = "composer"; } },
			{ id: "wake", label: "Wake on post", key: "space", disabled: closed, run: () => this.toggleSelectedMember() },
		];
	}

	/** The action ids whose key the footer shows in this focus. */
	private shownActions(focus: Focus): string[] {
		if (focus === "list") return ["members", "details", "posts"];
		if (focus === "members") return ["wake", "members"];
		if (focus === "details") return ["details"];
		if (focus === "exchange") return ["write", "members", "details", "posts"];
		return [];
	}

	private actionKey(data: string): boolean {
		const shown = this.shownActions(this.focus());
		const action = this.actions().find((item) => shown.includes(item.id) && item.key !== undefined && keyMatches(data, item.key));
		if (!action) return false;
		this.invoke(action.id);
		return true;
	}

	/** Run one action by identity; a disabled action keeps its control and explains itself. */
	private invoke(id: string): void {
		const action = this.actions().find((item) => item.id === id);
		if (!action) return;
		if (action.disabled) {
			this.notice = { text: action.disabled, kind: "warning" };
			return;
		}
		action.run();
	}

	/** True while a text field has focus: printable keys are text, never action keys. */
	editing(): boolean {
		return this.region === "find" || this.region === "composer";
	}

	/**
	 * The footer for the current focus: navigation keys first, then actions on the selection, then view
	 * keys, and the way out last. `menu` lists entries only the More menu shows.
	 */
	footer(): { controls: Control[]; menu: Control[] } {
		const focus = this.focus();
		const controls = this.focusHints(focus);
		for (const id of this.shownActions(focus)) {
			const item = this.controlFor(id, id === "posts" ? 2 : 1);
			if (item) controls.push(item);
		}
		if (focus === "list" || focus === "exchange" || focus === "composer") controls.push(this.hint("tab", ["tab"], "focus", 3));
		controls.push(this.hint("escape", ["escape"], this.escapeLabel(focus), 0));
		return { controls, menu: [] };
	}

	/** The keys this focus handles itself, in footer order. */
	private focusHints(focus: Focus): Control[] {
		switch (focus) {
			case "list":
				return [this.hint("select", ["up", "down"], "select", 0), this.hint("open", ["enter"], "open", 1), this.hint("find", ["/"], "find", 2)];
			case "find":
				return [this.hint("select", ["up", "down"], "select", 0), this.hint("done", ["enter"], "done", 1)];
			case "exchange":
				return [
					this.hint("scroll", ["up", "down"], "scroll", 0),
					this.hint("page", ["pageUp", "pageDown"], "page", 2),
					this.hint("earlier", ["home"], "earlier", 2),
					this.hint("latest", ["end"], "latest", 2),
				];
			case "members":
				return [this.hint("choose", ["up", "down"], "choose", 0), this.hint("open-member", ["enter"], "open conversation", 1)];
			case "details":
				return [this.hint("scroll", ["up", "down"], "scroll", 0), this.hint("page", ["pageUp", "pageDown"], "page", 2)];
			case "composer":
				return [this.hint("post", ["enter"], "post", 1), { id: "newline", keys: this.newlineKeys(), label: "newline", priority: 2, run: (key) => this.handleInput(keyInput(key) ?? "") }];
		}
	}

	/** One key the view handles itself; a click sends exactly that key. */
	private hint(id: string, keys: string[], label: string, priority: number): Control {
		return { id, keys, label, priority, run: (key) => this.handleInput(keyInput(key) ?? "") };
	}

	private controlFor(id: string, priority: number): Control | undefined {
		const action = this.actions().find((item) => item.id === id);
		return action ? actionControl(action, (chosen) => this.invoke(chosen), priority) : undefined;
	}

	/** The keys the resolved newline binding accepts, as the composer footer shows them. */
	private newlineKeys(): string[] {
		const keys = this.options.keys.getKeys("tui.input.newLine");
		return keys.length ? [...keys] : ["shift+enter", "ctrl+j"];
	}

	/** What Escape does in this focus. */
	private escapeLabel(focus: Focus): string {
		if (focus === "find") return this.find.value ? "clear" : "list";
		if (focus === "list") return this.find.value ? "clear" : "back";
		if (focus === "members" || focus === "details") return "exchange";
		// A thread opened from another surface returns there; otherwise Escape goes back to the list.
		return this.direct ? "back" : "list";
	}

	private regions(): Region[] {
		const order: Region[] = ["list"];
		if (this.options.state.selected) order.push("exchange");
		if (this.canPost() && this.panel === "exchange") order.push("composer");
		return order;
	}

	private showPanel(panel: Panel): void {
		this.panel = this.panel === panel ? "exchange" : panel;
		this.region = "exchange";
		this.detailsOffset = 0;
		this.memberIndex = 0;
	}

	/** Members: Up and Down choose, Enter opens the conversation, Space ticks a wake for the next post. */
	private membersInput(data: string): void {
		const members = this.selectedRead()?.page.thread.members ?? [];
		const member = members[this.memberIndex];
		if (matchesKey(data, "up") || matchesKey(data, "down")) this.memberIndex = Math.max(0, Math.min(members.length - 1, this.memberIndex + (matchesKey(data, "up") ? -1 : 1)));
		else if (matchesKey(data, "home") || matchesKey(data, "end")) this.memberIndex = matchesKey(data, "home") ? 0 : Math.max(0, members.length - 1);
		else if (matchesKey(data, "enter") && member) this.options.openParticipant?.(member.identity);
	}

	private toggleSelectedMember(): void {
		const member = (this.selectedRead()?.page.thread.members ?? [])[this.memberIndex];
		if (member) this.toggleNotify(member.identity);
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

	/** Escape in the list, the exchange or a panel; the footer names the outcome this produces. */
	private leaveFocus(): void {
		if (this.region === "list") this.listEscape();
		else this.exchangeEscape();
	}

	private exchangeInput(data: string): void {
		const page = Math.max(1, this.options.tui.terminal.rows - 10);
		if (matchesKey(data, "up")) this.scroll(1);
		else if (matchesKey(data, "down")) this.scroll(-1);
		else if (matchesKey(data, "pageUp")) this.scroll(page);
		else if (matchesKey(data, "pageDown")) this.scroll(-page);
		else if (matchesKey(data, "home")) {
			this.scroll(Number.MAX_SAFE_INTEGER);
			void this.earlier();
		} else if (matchesKey(data, "end")) this.scroll(-Number.MAX_SAFE_INTEGER);
	}

	private detailsInput(data: string): void {
		const page = Math.max(1, this.options.tui.terminal.rows - 10);
		if (matchesKey(data, "up")) this.scroll(1);
		else if (matchesKey(data, "down")) this.scroll(-1);
		else if (matchesKey(data, "pageUp")) this.scroll(page);
		else if (matchesKey(data, "pageDown")) this.scroll(-page);
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
		if (matchesKey(data, "enter")) this.listEnter();
		else if (keyMatches(data, "/")) this.focusFind();
		else this.listMove(data);
	}
	/** `/` puts the cursor in Find; typing there filters, and Enter keeps the filter and returns to the list. */
	private focusFind(): void {
		this.region = "find";
		this.closedFocused = false;
	}

	private findInput(data: string): void {
		if (matchesKey(data, "escape")) this.findEscape();
		else if (matchesKey(data, "enter")) this.region = "list";
		else if (matchesKey(data, "up") || matchesKey(data, "down")) this.listMove(data);
		else {
			this.find.handleInput(data);
			this.closedFocused = false;
			this.listScroll = 0;
			this.listReveal = true;
		}
	}

	/** Escape clears the filter first; with an empty field it returns to the list. */
	private findEscape(): void {
		if (this.find.value) this.listEscape();
		else this.region = "list";
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
		this.find.focused = this.region === "find";
		const findLine = this.find.render(width, theme, 6, "/ to find threads");
		this.hits.add({ x: x0, y: 0, width, height: 1, click: () => { this.focusFind(); } });
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
			blocks.push({ id: row.id, start: lines.length, size: LIST_BLOCK_ROWS });
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

	/** The shared list block: the title wraps into the gap row before the purpose shortens it. */
	private threadBlock(row: CollaborationSummary, width: number): string[] {
		const exact = this.options.exactTime();
		return listBlock({
			title: oneLine(row.title) || "Untitled thread",
			glyph: row.closed ? "○" : "●",
			glyphColor: row.closed ? "muted" : "success",
			titleColor: row.closed ? "muted" : "text",
			detail: oneLine(row.purpose) || "No purpose stated",
			time: dashboardTime(row.updatedAt, exact),
			timeOnDetail: exact,
			selected: row.id === this.options.state.selected && !this.closedFocused,
		}, width, this.options.theme).lines;
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

	/**
	 * The thread header: the full title, then the state and counts, then the purpose. A title too long
	 * for one row wraps onto a second. Commands belong to the footer.
	 */
	private threadHeader(read: ThreadRead | undefined, summary: CollaborationSummary | undefined, x0: number, width: number, narrow: boolean, closed: boolean): string[] {
		const theme = this.options.theme;
		const back = narrow ? "‹ Threads " : "";
		if (narrow) this.hits.add({ x: x0, y: 0, width: visibleWidth(back), height: 1, click: () => { this.narrowThread = false; this.region = "list"; } });
		const thread = read?.page.thread;
		const title = oneLine(thread?.title ?? summary?.title ?? "Thread");
		const members = thread?.members.length ?? summary?.members ?? 0;
		const lead = `${theme.fg("accent", back)} `;
		const leadWidth = visibleWidth(lead);
		const titleRoom = Math.max(1, width - leadWidth - 1);
		const rows = wrapTextWithAnsi(title, titleRoom);
		const header = [`${lead}${theme.bold(theme.fg("text", rows[0] ?? ""))}`];
		const rest = rows.length > 1 ? clip(rows.slice(1).join(" "), titleRoom) : "";
		if (rest) header.push(`${" ".repeat(leadWidth)}${theme.bold(theme.fg("text", rest))}`);
		const facts = this.notice ? oneLine(this.notice.text) : this.threadFacts(read, closed, members);
		const colour = this.notice?.kind === "error" ? "error" : this.notice?.kind === "warning" ? "warning" : "muted";
		header.push(theme.fg(colour, ` ${facts}`));
		const purpose = oneLine(thread?.purpose ?? summary?.purpose ?? "");
		if (purpose) header.push(...this.purposeRows(purpose, width));
		// One blank row separates the header from the exchange.
		header.push("");
		return header;
	}

	/** State, members and how much of the exchange is loaded, in one short muted line. */
	private threadFacts(read: ThreadRead | undefined, closed: boolean, members: number): string {
		const total = read?.page.thread.sequence;
		const loaded = read?.events.length ?? 0;
		const events = !read ? "" : read.nextBefore && total ? `latest ${loaded} of ${total} events` : `${loaded} event${loaded === 1 ? "" : "s"}`;
		return [closed ? "Closed" : "Open", `${members} member${members === 1 ? "" : "s"}`, events].filter(Boolean).join(" · ");
	}

	/** The purpose in muted rows at the reading width; a longer purpose ends with a pointer to Details. */
	private purposeRows(purpose: string, width: number): string[] {
		const theme = this.options.theme;
		const room = Math.max(1, Math.min(readingGeometry(width).textWidth, width - 2));
		const rows = wrapTextWithAnsi(purpose, room);
		if (rows.length > PURPOSE_ROWS) {
			const more = "… more in Details";
			rows.length = PURPOSE_ROWS;
			rows[PURPOSE_ROWS - 1] = `${truncateToWidth(rows[PURPOSE_ROWS - 1] ?? "", Math.max(1, room - visibleWidth(more) - 1), "")} ${more}`;
		}
		return rows.map((row) => theme.fg("muted", ` ${row}`));
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

	/**
	 * The exchange, newest at the bottom. The first row says how many earlier events are still unread and
	 * reads them on a click or Home. While the view sits above the newest line, the last row says how far
	 * below it is; a window that starts inside a post names that post on its first row.
	 */
	private renderExchange(read: ThreadRead, x0: number, y0: number, width: number, height: number): string[] {
		const { lines, spans } = this.exchangeDocument(read, width);
		// An opened or closed post grows or shrinks below the rows already in view, not above them.
		if (this.keepWindowTop) this.exchangeBack = Math.max(0, this.exchangeBack + lines.length - this.exchangeTotal);
		this.keepWindowTop = false;
		this.exchangeTotal = lines.length;
		this.exchangeMax = Math.max(0, lines.length - height);
		this.exchangeBack = Math.min(this.exchangeBack, this.exchangeMax);
		const start = Math.max(0, lines.length - height - this.exchangeBack);
		const visible = lines.slice(start, start + height);
		if (start === 0 && read.nextBefore) this.hits.add({ x: x0, y: y0, width, height: 1, click: () => void this.earlier() });
		const area = { x0, y0, width, height, start };
		this.postHits(spans, area);
		this.exchangeEdges(visible, spans, lines.length, area);
		this.hits.add({ x: x0, y: y0, width, height, wheel: (delta) => { this.exchangeBack = Math.max(0, Math.min(this.exchangeMax, this.exchangeBack - delta)); if (this.exchangeBack === this.exchangeMax && read.nextBefore && delta < 0) void this.earlier(); } });
		return visible.map((line) => fitLine(line, width));
	}

	/** Every exchange row, oldest first, and where each event's rows, header and long-post control sit. */
	private exchangeDocument(read: ThreadRead, width: number): { lines: string[]; spans: ExchangeSpan[] } {
		const theme = this.options.theme;
		const pad = " ".repeat(readingGeometry(width).margin);
		const earlier = read.nextBefore ? Math.max(0, read.nextBefore - 1) : 0;
		const first = !read.nextBefore ? theme.fg("muted", `${pad}Start of the thread`)
			: theme.fg("accent", `${pad}↑ ${earlier ? `${earlier} earlier event${earlier === 1 ? "" : "s"}` : "Earlier events"} · click or Home reads them`);
		const lines = [first];
		const spans: ExchangeSpan[] = [];
		const events = new Map(read.events.map((event) => [event.sequence, event]));
		const cacheKey = this.exchangeKey(read, width);
		if (this.exchangeCache?.key !== cacheKey) this.exchangeCache = { key: cacheKey, lines: new Map() };
		const cache = this.exchangeCache.lines;
		for (const event of read.events) {
			lines.push("");
			const start = lines.length;
			const rendered = cache.get(event.sequence) ?? this.eventLines(event, events, width);
			cache.set(event.sequence, rendered);
			lines.push(...rendered.lines);
			spans.push({ start, end: lines.length, event, header: rendered.header === undefined ? undefined : start + rendered.header, toggle: rendered.toggle === undefined ? undefined : start + rendered.toggle });
		}
		if (!read.events.length) lines.push("", theme.fg("muted", `${pad}No messages yet.`));
		lines.push("");
		return { lines, spans };
	}

	/** A click on a post's header replies to it; a click on a long post's control opens or closes it. */
	private postHits(spans: readonly ExchangeSpan[], area: ExchangeArea): void {
		const row = (line: number | undefined) => (line === undefined ? -1 : line - area.start);
		for (const span of spans) {
			const header = row(span.header);
			if (header >= 0 && header < area.height) this.hits.add({ x: area.x0, y: area.y0 + header, width: area.width, height: 1, click: () => { this.replyTo(span.event); } });
			const toggle = row(span.toggle);
			if (toggle >= 0 && toggle < area.height) this.hits.add({ x: area.x0, y: area.y0 + toggle, width: area.width, height: 1, click: () => { this.togglePost(`${this.options.state.selected ?? ""}#${span.event.sequence}`); } });
		}
	}

	/**
	 * The window's edges: a first row inside a post names the post it continues and a click shows its
	 * header; a last row above the newest line says how far below it is and a click returns there.
	 */
	private exchangeEdges(visible: string[], spans: readonly ExchangeSpan[], total: number, area: ExchangeArea): void {
		const theme = this.options.theme;
		if (area.height <= 2) return;
		const pad = " ".repeat(readingGeometry(area.width).margin);
		const inside = spans.find((span) => span.header !== undefined && span.header < area.start && span.end > area.start);
		if (inside) {
			visible[0] = theme.fg("muted", `${pad}↑ ${clip(`${this.name(inside.event.sender)} · #${inside.event.sequence}, continued`, Math.max(1, area.width - pad.length - 3))}`);
			const back = area.start - (inside.header ?? area.start);
			this.hits.add({ x: area.x0, y: area.y0, width: area.width, height: 1, click: () => { this.exchangeBack = Math.min(this.exchangeMax, this.exchangeBack + back); } });
		}
		const below = total - (area.start + area.height);
		if (below <= 0) return;
		visible[area.height - 1] = theme.fg("muted", `${pad}↓ ${below} line${below === 1 ? "" : "s"} below · End shows the latest`);
		this.hits.add({ x: area.x0, y: area.y0 + area.height - 1, width: area.width, height: 1, click: () => { this.exchangeBack = 0; } });
	}

	/**
	 * One entry. Contributions and carried authority show their full post; structural events show one
	 * muted line so the frame and member contributions stay out of the exchange.
	 */
	private eventLines(event: CollaborationEvent, events: ReadonlyMap<number, CollaborationEvent>, width: number): EventRows {
		// A close keeps its muted state line and shows why the thread ended as post text.
		if (event.kind === "close") {
			const body = this.postBody(event, width);
			return { lines: [...(this.structuralEventLine(event, width) ?? []), ...body.lines], ...(body.toggle === undefined ? {} : { toggle: body.toggle + 1 }) };
		}
		const structural = this.structuralEventLine(event, width);
		return structural ? { lines: structural } : this.postLines(event, events, width);
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

	/**
	 * A contribution or carried authority. One header row: the bold author, the role the frame names, the
	 * post number, the reply target and, at the right, the time. Then the Markdown body and, last and muted,
	 * who the post notified.
	 */
	private postLines(event: CollaborationEvent, events: ReadonlyMap<number, CollaborationEvent>, width: number): EventRows {
		const theme = this.options.theme;
		const { margin, textWidth } = readingGeometry(width);
		const pad = " ".repeat(margin);
		const time = theme.fg("muted", `  ${dashboardTime(event.at, this.options.exactTime())}`);
		const role = this.role(event.sender);
		const facts = [role, `#${event.sequence}`, event.replyTo ? `↳ ${this.replyTarget(event, events)}` : "", ...this.eventMetadata(event)].filter(Boolean).join(" · ");
		const marked = this.draft()?.replyTo === event.sequence ? theme.fg("accent", " · replying") : "";
		const head = `${theme.bold(theme.fg("text", this.name(event.sender)))}${theme.fg("muted", ` · ${facts}`)}${marked}`;
		const headWidth = Math.max(1, textWidth - visibleWidth(time));
		const lines = [`${pad}${fitLine(clip(head, headWidth), headWidth)}${time}`];
		const body = this.postBody(event, width);
		const toggle = body.toggle === undefined ? undefined : lines.length + body.toggle;
		lines.push(...body.lines);
		if (event.notify.length) lines.push(theme.fg("muted", `${pad}${clip(`notified ${event.notify.map((id) => this.name(id)).join(", ")}`, textWidth)}`));
		return { lines, header: 0, ...(toggle === undefined ? {} : { toggle }) };
	}

	/**
	 * The post as Markdown at the shared reading width. A long post opens as a preview with a row that
	 * shows the rest; the stored message itself is never changed.
	 */
	private postBody(event: CollaborationEvent, width: number): EventRows {
		const theme = this.options.theme;
		const { margin, textWidth } = readingGeometry(width);
		const pad = " ".repeat(margin);
		const text = plainThreadText(event.message).trim();
		if (!text) return { lines: [] };
		const rendered = new Markdown(text, 0, 0, getMarkdownTheme(), { color: (value) => theme.fg("text", value) }).render(textWidth);
		const blank = (line: string) => stripVTControlCharacters(line).trim() === "";
		let first = rendered.findIndex((line) => !blank(line));
		let end = rendered.length;
		while (end > first && blank(rendered[end - 1] ?? "")) end--;
		if (first < 0) first = end;
		const body = rendered.slice(first, end).map((line) => `${pad}${line}`);
		if (body.length <= LONG_POST_LINES) return { lines: body };
		const open = this.postOpen(`${this.options.state.selected ?? ""}#${event.sequence}`);
		const shown = open ? body : body.slice(0, PREVIEW_LINES);
		const control = open ? `▴ Show less` : `▸ ${body.length - PREVIEW_LINES} more lines`;
		return { lines: [...shown, theme.fg("accent", `${pad}${control}`)], toggle: shown.length };
	}

	/** Operator origin and event kind, as muted header facts. */
	private eventMetadata(event: CollaborationEvent): string[] {
		return [event.origin === "operator" ? "operator" : "", event.kind === "contribution" ? "" : (KIND_LABEL[event.kind] ?? oneLine(event.kind))];
	}

	private replyTarget(event: CollaborationEvent, events: ReadonlyMap<number, CollaborationEvent>): string {
		const parent = event.replyTo ? events.get(event.replyTo) : undefined;
		return parent ? `${this.name(parent.sender)} #${event.replyTo}` : `#${event.replyTo}`;
	}

	/** Event identities, width, reply target, names, post disclosure, exact time and the minute. */
	private exchangeKey(read: ThreadRead, width: number): string {
		const names = read.events.map((event) => `${this.name(event.sender)}:${event.notify.map((id) => this.name(id)).join(",")}`).join("|");
		return [read.page.thread.id, width, this.options.exactTime(), this.draft()?.replyTo ?? "", names, this.postsOpen, [...this.postChoices].join(","), Math.floor(Date.now() / 60_000), read.events.map((event) => event.sequence).join(",")].join("#");
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
		return this.composer.render(width, caption, parts.join(" · "), draft?.pending ? "Posting…" : this.receipt?.text ?? "");
	}

	/** The composer takes focus on a click; the footer's `enter post` control posts the draft. */
	private composerHits(x0: number, y0: number, width: number, rows: number): void {
		this.hits.add({
			x: x0,
			y: y0,
			width,
			height: rows,
			click: (event) => {
				this.region = "composer";
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
