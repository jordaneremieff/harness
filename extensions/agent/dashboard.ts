import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	visibleWidth,
	truncateToWidth,
	matchesKey,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { DashboardMouse, mouseHints } from "./dashboard-mouse.ts";
import type { AgentConversationPage, AgentConversationSummary, AgentConversationSnapshot } from "./dashboard-types.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import { AgentConsole } from "./agent-console.ts";
import { AgentComposer } from "./agent-composer.ts";
import { AgentTasksView } from "./agent-tasks.ts";
import { dashboardActions } from "./dashboard-actions.ts";
import { dashboardGeometry, dashboardHeading, dashboardRule, dashboardSelection, fitLine } from "./dashboard-layout.ts";
import { dashboardRecords, rosterLines, activityOf, sessionAppearance, titleOf, attentionReason, needsAttention } from "./dashboard-roster.ts";
import {
	agentState,
	dashboardSessionState,
	DashboardNavigation,
	updateDraft,
	notifyAgentState,
	type DashboardState,
} from "./dashboard-state.ts";
import { agentDisplayName } from "./action-outcome.ts";
import type { TaskLabel, ConversationFrame } from "./live-frames.ts";
import { firstTaskEntry, cleanDashboardText } from "./dashboard-conversation.ts";
import { ConversationHistory } from "./conversation-view.ts";
import type { NativeSurface } from "./action-dialogs.ts";
import { CollaborationView, createCollaborationViewState, type Collaborate } from "./collaboration-view.ts";
import type { EffortAwareness } from "./effort-awareness.ts";
import { EffortView } from "./effort-view.ts";

export interface DashboardResult {
	text: string;
	sessionId?: string;
}
export interface DashboardOperations {
	efforts?(): Promise<EffortAwareness>;
	messageEffort?(id: string, text: string): Promise<DashboardResult>;
	sessionFigures?(page: AgentConversationPage): Promise<string>;
	contextWindow?(provider: string, modelId: string): number | undefined;
	collaborate?: Collaborate;
	submit(input: { id: string; text: string; mode: "steer" | "followUp" }): Promise<DashboardResult>;
	newAgent(input: { prompt: string; onCreated: (row: AgentConversationSummary) => void }): Promise<DashboardResult>;
	chooseConversation(labels: readonly TaskLabel[], surface: NativeSurface): Promise<string | undefined>;
	action(name: string, target: AgentConversationSummary, surface: NativeSurface): Promise<DashboardResult | undefined>;
}
const HELP = [
	"Dashboard",
	"↑↓ selects an agent. Enter opens its full conversation.",
	"Tab or m writes to the selected agent. n starts a new agent.",
	"a opens actions. / finds loaded agents. t opens Threads. b opens Related efforts. ? opens help.",
	"[other] marks an agent created by another session, not its current task requester.",
	"Related efforts shows presence and labeled intent claims. Enter opens a contact thread; m sends an operator message.",
	"Threads shows the frame, peers, and exchange. p posts without a model wake.",
	"n chooses peers to notify. Tab returns to the message. Enter posts.",
	"i switches all times between relative age and local date and time.",
	"This time toggle stays available when it is absent from the hint line.",
	"A time shows the agent's last recorded change, not an activity timer.",
	"In fullscreen mode, click rows to select and visible hints to act.",
	"Click a time to switch its format. Click a message field to write.",
	"Use the wheel over a pane to scroll. Drag text to select it.",
	"Published omissions have storage rows. Enter reads their full thread directory.",
	"",
	"Messages",
	"Enter sends. A working agent starts with Steer at next step.",
	"Tab changes Steer to Follow-up after answer while the agent works.",
	"Ctrl+J adds a newline. Esc keeps your draft.",
	"All letters, slash text, and bang text are literal messages.",
	"Commands belong to Actions > Run agent command.",
	"",
	"Read",
	"PageUp/PageDown reads the conversation. The tail resumes live follow.",
	"Ctrl+O expands tools. Ctrl+T shows or hides thinking.",
	"",
	"Return",
	"Esc leaves the message field or full conversation, then the dashboard.",
	"Esc never stops work. Stop current work is in Actions.",
	"The dashboard never changes the primary editor.",
	"",
	"Context tokens come from the latest assistant usage; compaction makes them unknown.",
	"A message starts a retired host. Reading never starts a host.",
	"Actions > Reconnect addresses a host error.",
];
/** Roster fields that change when an agent's host starts, works, finishes, or stops. */
function rosterMark(row: AgentConversationSummary): string {
	return `${row.id}|${row.modifiedAt}|${row.state}|${row.cost}|${row.owner}`;
}
/** The root owns source handles and async generations. Rendering performs no source reads. */
export class AgentDashboard implements Component, Focusable {
	readonly navigation: DashboardNavigation;
	private page?: AgentConversationPage;
	private rows: AgentConversationSummary[] = [];
	private console?: AgentConsole;
	private snapshot?: AgentConversationSnapshot & { nextBefore?: number | null };
	private readonly find = new Input({ prompt: "Find agents: " });
	private findBefore = { filter: "", selected: undefined as string | undefined };
	private readonly newComposer: AgentComposer;
	private tasks?: AgentTasksView;
	private threads?: CollaborationView;
	private efforts?: EffortView;
	private effortsOpen = false;
	private readonly mouse = new DashboardMouse();
	private mouseScreen?: string;
	private rosterScroll?: number;
	private rosterStart = 0;
	private rosterMaxStart = 0;
	private actionIndex = 0;
	private helpOffset = 0;
	private result = "";
	private notice?: string;
	private rosterNotice?: string;
	private rosterFailures = 0;
	private sessionFigures = "";
	private closed = false;
	private hidden = false;
	private rosterPending = false;
	private rosterAgain = false;
	private sourceGeneration = 0;
	/** Roster fields of the selected row when the conversation was last read; a change while not live triggers a reread. */
	private selectedMark = "";
	private earlierPending = false;
	private history = new ConversationHistory();
	private loadedPages = 1;
	private loadMore = false;
	private rosterCache = new Map<string, { signature: string; row: AgentConversationSummary }>();
	private readonly unsubscribe: Array<() => void> = [];
	private readonly reconciliation: ReturnType<typeof setInterval>;
	private rosterTimer?: ReturnType<typeof setTimeout>;
	private streamTimer?: ReturnType<typeof setTimeout>;
	private lastStreamPaint = 0;
	private bodyHeight = 10;
	private creating = false;
	private rosterOrderLocked = false;
	focused = true;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: () => void;
	readonly state: DashboardState;
	private readonly source: AgentObservationSource;
	private readonly operations: DashboardOperations;
	private readonly surface: NativeSurface;
	private readonly primaryId?: string;
	constructor(
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		done: () => void,
		state: DashboardState,
		source: AgentObservationSource,
		operations: DashboardOperations,
		surface: NativeSurface,
		primaryId?: string,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.state = state;
		this.source = source;
		this.operations = operations;
		this.surface = surface;
		this.primaryId = primaryId;
		this.navigation = new DashboardNavigation(state);
		this.newComposer = new AgentComposer({
			tui,
			theme,
			keys,
			onSubmit: (text) => {
				void this.startAgent(text);
			},
			onChange: (text) => {
				state.newTask = text;
			},
			onEscape: () => this.back(),
		});
		this.newComposer.setText(state.newTask);
		this.find.onSubmit = () => {
			state.filter = this.find.getValue();
			this.navigation.escape();
			this.reconcile();
			this.redraw();
		};
		this.unsubscribe.push(
			source.subscribe(() => this.frameChanged()),
			source.subscribeRoster(() => {
				this.queueRoster();
				if (this.navigation.screen === "threads") void this.threads?.refresh();
				if (this.effortsOpen) void this.efforts?.refresh();
			}),
		);
		this.reconciliation = setInterval(() => {
			if (!this.hidden) void this.refreshRoster();
		}, 2000);
		void this.refreshRoster();
	}
	private redraw(): void {
		if (!this.closed && !this.hidden) this.tui.requestRender();
	}
	private queueRoster(): void {
		if (this.closed || this.rosterTimer) return;
		this.rosterTimer = setTimeout(() => {
			this.rosterTimer = undefined;
			if (!this.hidden) void this.refreshRoster();
		}, 250);
	}
	private async refreshRoster(cursor?: string): Promise<void> {
		if (this.closed) return;
		if (this.rosterPending) {
			this.rosterAgain = true;
			return;
		}
		this.rosterPending = true;
		try {
			const pages = await this.readRosterPages(cursor);
			if (this.closed) return;
			this.page = this.reuseRoster(pages.reduce((previous, page) => this.mergeRoster(previous, page)));
			this.loadMore = false;
			this.rosterFailures = 0;
			this.rosterNotice = undefined;
			this.sessionFigures = await this.operations.sessionFigures?.(this.page) ?? "";
			if (this.closed) return;
			this.reconcile();
			this.redraw();
		} catch (error) {
			this.rosterFailed(error);
			if (cursor) {
				this.loadedPages = 1;
				this.rosterAgain = true;
			}
			this.redraw();
		} finally {
			this.rosterPending = false;
			if (this.rosterAgain && !this.closed) {
				this.rosterAgain = false;
				this.queueRoster();
			}
		}
	}
	private rosterFailed(error: unknown): void {
		this.rosterFailures++;
		const hasRows = Boolean(this.page?.rows.length);
		this.rosterNotice = !hasRows || this.rosterFailures >= 3
			? `Roster refresh unavailable${hasRows ? "; last roster shown" : ""}: ${error instanceof Error ? error.message : String(error)}`
			: undefined;
	}
	private reuseRoster(page: AgentConversationPage): AgentConversationPage {
		const next = new Map<string, { signature: string; row: AgentConversationSummary }>();
		const rows = page.rows.map((row) => {
			const signature = JSON.stringify(row);
			const cached = this.rosterCache.get(row.id);
			const value = cached?.signature === signature ? cached : { signature, row };
			next.set(row.id, value);
			return value.row;
		});
		this.rosterCache = next;
		return { ...page, rows };
	}
	private mergeRoster(previous: AgentConversationPage, page: AgentConversationPage): AgentConversationPage {
		return {
			...page,
			rows: [...new Map([...previous.rows, ...page.rows].map((row) => [row.id, row])).values()],
			coverage: {
				...page.coverage,
				skipped: previous.coverage.skipped + page.coverage.skipped,
				omitted: previous.coverage.omitted + page.coverage.omitted,
				storagesVisited: previous.coverage.storagesVisited + page.coverage.storagesVisited,
			},
		};
	}
	private async readRosterPages(cursor?: string): Promise<AgentConversationPage[]> {
		if (cursor && this.page) {
			const page = await this.source.list({ cursor });
			this.loadedPages++;
			return [this.page, page];
		}
		const pages = [await this.source.list()];
		for (let index = 1; index < this.loadedPages; index++) {
			const next = pages.at(-1)?.coverage.nextCursor;
			if (!next) break;
			pages.push(await this.source.list({ cursor: next }));
		}
		this.loadedPages = pages.length;
		return pages;
	}
	private reconcileOrder(filtered: AgentConversationSummary[]): void {
		if (
			(this.navigation.screen === "roster" && !this.rosterOrderLocked) ||
			!this.rows.length ||
			this.navigation.screen === "find"
		) {
			this.rows = filtered;
			return;
		}
		this.rows = this.rows
			.flatMap((row) => {
				const current = filtered.find((item) => item.id === row.id);
				return current ? [current] : this.navigation.screen === "roster" ? [] : [row];
			})
			.concat(filtered.filter((row) => !this.rows.some((item) => item.id === row.id)));
	}
	private reconcile(): void {
		const previousId = this.navigation.target ?? this.state.selected;
		const frame = previousId ? this.source.frame(previousId) : undefined;
		if (previousId && frame && this.source.availability(previousId)?.state === "live" && this.page)
			this.page = {
				...this.page,
				rows: this.page.rows.map((row) => (row.id === previousId ? this.observedRow(row, frame) : row)),
			};
		const filtered = dashboardRecords(
			this.page
				? { observedAt: Date.parse(this.page.observedAt), sessions: this.page.rows, coverage: this.page.coverage }
				: undefined,
			this.navigation.screen === "find" ? this.find.getValue() : this.state.filter,
		);
		this.reconcileOrder(filtered);
		this.navigation.reconcile(this.rows);
		const id = this.navigation.target ?? this.state.selected;
		const row = this.page?.rows.find((item) => item.id === id);
		if (row && this.console && this.console.row.id === id) {
			this.console.row = row;
			this.rereadIfStale(row);
		} else if (row) this.select(row);
		else if (this.navigation.screen === "roster" || this.navigation.screen === "find") {
			this.saveConsole();
			this.console?.dispose();
			this.console = undefined;
			this.source.select(undefined);
			this.sourceGeneration++;
		}
	}
	/**
	 * A stopped host restarted by another action attaches again when its roster
	 * row changes. A host launch already owned by this manager attaches through
	 * its pending open, without a roster change.
	 */
	private rereadIfStale(row: AgentConversationSummary): void {
		const mark = rosterMark(row);
		if (mark === this.selectedMark) return;
		this.selectedMark = mark;
		if (this.source.availability(row.id)?.state !== "unavailable") return;
		const generation = ++this.sourceGeneration;
		this.source.refresh(row.id);
		void this.readSelected(row, generation);
	}
	private select(row: AgentConversationSummary): void {
		this.selectedMark = rosterMark(row);
		this.saveConsole();
		this.console?.dispose();
		this.history = new ConversationHistory();
		this.console = new AgentConsole(
			row,
			agentState(this.state, row.id),
			this.tui,
			this.theme,
			this.keys,
			(text) => {
				void this.submit(text);
			},
			() => this.back(),
		);
		this.snapshot = undefined;
		this.source.select(undefined);
		const generation = ++this.sourceGeneration;
		queueMicrotask(() => {
			if (this.closed || generation !== this.sourceGeneration) return;
			this.source.select(row.id);
			void this.readSelected(row, generation);
			this.frameChanged();
		});
	}
	private async readSelected(row: AgentConversationSummary, generation: number): Promise<void> {
		try {
			const snapshot = await this.source.snapshot(row.id);
			if (this.closed || generation !== this.sourceGeneration || this.source.availability(row.id)?.state === "live")
				return;
			this.history.tail(snapshot, this.console?.state.view.anchor?.id);
			this.snapshot = {
				...snapshot,
				entries: this.history.entries(this.console?.state.view.anchor?.id),
				nextBefore: this.history.earlier(),
			};
			const console = this.console;
			if (!console) return;
			this.setConversation();
			if (
				console.state.view.before &&
				!this.snapshot.entries.some((entry) => entry.id === console.state.view.anchor?.id)
			)
				void this.readHistory(console.state.view.before);
			console.status = snapshot.partial ? "Partial history" : "";
			console.warning = this.source.availability(row.id)?.state === "unavailable" ? "Conversation unavailable; stored messages shown" : undefined;
			console.observeUsage(snapshot.entries);
			this.redraw();
		} catch (error) {
			if (
				generation === this.sourceGeneration &&
				!this.closed &&
				this.console &&
				this.source.availability(row.id)?.state !== "live"
			) {
				this.console.warning = `Conversation unavailable: ${String(error)}`;
				this.console.status = "";
				this.redraw();
			}
		}
	}
	private observedRow(row: AgentConversationSummary, frame: ConversationFrame): AgentConversationSummary {
		if (row.state === "starting" && !frame.entries.some((entry) => entry.kind === "pi.user")) return row;
		return {
			...row,
			owner: "here",
			name: frame.status.name ?? row.name,
			firstMessage: frame.status.firstMessage ?? row.firstMessage,
			state: frame.status.busy
				? "working"
				: row.state === "starting" || row.state === "new" || row.state === "working" || row.state === "unavailable"
					? "idle"
					: row.state,
			model: frame.status.agent.model
				? { ...frame.status.agent.model, thinkingLevel: frame.status.agent.thinkingLevel }
				: row.model,
		};
	}
	private updateObservedRow(console: AgentConsole, frame: ConversationFrame): void {
		if (this.source.availability(console.row.id)?.state !== "live") return;
		console.row = this.observedRow(console.row, frame);
		if (this.page)
			this.page = { ...this.page, rows: this.page.rows.map((row) => (row.id === console.row.id ? console.row : row)) };
		this.rows = this.rows.map((row) => (row.id === console.row.id ? console.row : row));
	}
	private frameChanged(): void {
		const console = this.console;
		if (!console || this.closed) return;
		const frame = this.source.frame(console.row.id);
		if (frame) {
			console.save();
			this.history.tail(
				{
					entries: frame.entries,
					partial: !frame.coverage.complete,
					revision: `r${frame.revision}`,
					nextBefore: frame.nextBefore,
				},
				console.state.view.anchor?.id,
			);
			this.snapshot = {
				entries: this.history.entries(console.state.view.anchor?.id),
				revision: `r${frame.revision}`,
				partial: !frame.coverage.complete,
				nextBefore: this.history.earlier(),
			};
			this.setConversation(frame.live);
			const availability = this.source.availability(console.row.id);
			console.status = frame.coverage.complete ? "" : "Partial history";
			console.warning = availability?.state === "unavailable" ? "Conversation unavailable; last messages shown" : undefined;
			console.observeUsage(frame.entries, availability?.state === "live" ? frame.status.usage : undefined);
			this.updateObservedRow(console, frame);
		}
		if (!frame && this.source.availability(console.row.id)?.state === "unavailable")
			console.warning = "Conversation unavailable; stored messages shown";
		const wait = Math.max(0, 50 - (Date.now() - this.lastStreamPaint));
		if (!this.streamTimer)
			this.streamTimer = setTimeout(() => {
				this.streamTimer = undefined;
				this.lastStreamPaint = Date.now();
				this.redraw();
			}, wait);
	}
	private back(): void {
		this.rosterOrderLocked = false;
		this.saveConsole();
		this.state.newTask = this.newComposer.getText();
		if (this.navigation.screen === "find") {
			this.state.filter = this.findBefore.filter;
			this.state.selected = this.findBefore.selected;
		}
		if (this.navigation.screen === "tasks") {
			this.tasks?.dispose();
			this.tasks = undefined;
			this.source.releaseTasks();
		}
		if (this.navigation.escape() === "close") {
			this.dispose();
			this.done();
			return;
		}
		this.reconcile();
		this.redraw();
	}
	private move(delta: number): void {
		this.rosterScroll = undefined;
		this.navigation.generation++;
		this.rosterOrderLocked = this.navigation.screen === "roster";
		const index = this.rows.findIndex((row) => row.id === this.state.selected);
		const next = index + delta;
		if (this.loadMore && delta < 0) {
			this.loadMore = false;
			this.redraw();
			return;
		}
		if (next >= this.rows.length && this.page?.coverage.nextCursor) {
			this.loadMore = true;
			this.redraw();
			return;
		}
		this.loadMore = false;
		this.state.selected = this.rows[Math.max(0, Math.min(this.rows.length - 1, next))]?.id;
		this.reconcile();
		this.redraw();
	}
	private async submit(text: string): Promise<void> {
		const console = this.console;
		if (!console || console.state.pending || !text.trim()) return;
		const { row, state } = console;
		const mode = state.mode;
		const revision = state.draftRevision;
		state.pending = { text, mode, revision };
		state.receipt = "Sending…";
		this.redraw();
		try {
			await Promise.resolve().then(() => this.operations.submit({ id: row.id, text, mode }));
			state.history.push(text);
			state.receipt =
				row.state === "working"
					? mode === "steer"
						? `Steer sent to ${agentDisplayName(row)}`
						: `Follow-up queued for ${agentDisplayName(row)}`
					: `Sent to ${agentDisplayName(row)}`;
			if (state.draftRevision === revision && state.draft === text) {
				state.mode = "steer";
				updateDraft(state, "");
			}
			this.queueRoster();
		} catch (error) {
			state.receipt = `Delivery not confirmed. Draft retained; check the conversation before resending. ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			state.pending = undefined;
			notifyAgentState(state);
			this.redraw();
		}
	}
	private async startAgent(text: string): Promise<void> {
		if (this.creating || !text.trim()) return;
		this.creating = true;
		let generation = this.navigation.generation;
		this.notice = "Starting agent…";
		this.redraw();
		try {
			const result = await Promise.resolve().then(() =>
				this.operations.newAgent({
					prompt: text,
					onCreated: (row) => {
						if (this.closed || generation !== this.navigation.generation) return;
						this.state.selected = row.id;
						this.state.filter = "";
						this.navigation.roster();
						generation = this.navigation.generation;
						if (this.page)
							this.page = { ...this.page, rows: [...this.page.rows.filter((item) => item.id !== row.id), row] };
						this.rows = [...this.rows.filter((item) => item.id !== row.id), row];
						this.select(row);
						this.snapshot = { entries: [], partial: false, revision: "starting", nextBefore: null };
						this.setConversation();
						if (this.console) this.console.status = "STARTING";
						this.redraw();
					},
				}),
			);
			if (this.state.newTask === text) {
				this.state.newTask = "";
				this.newComposer.setText("");
			}
			if (!this.closed && generation === this.navigation.generation && result.sessionId) {
				this.state.selected = result.sessionId;
				this.state.filter = "";
				this.navigation.roster();
				this.notice = result.text;
			}
			await this.refreshRoster();
		} catch (error) {
			this.notice = `Agent start failed: ${String(error)}`;
		} finally {
			this.creating = false;
			this.redraw();
		}
	}

	private saveConsole(): void {
		this.console?.save();
		if (this.console) this.console.state.view.before = this.history.upper(this.console.state.view.anchor?.id);
	}
	private setConversation(live: readonly import("./dashboard-types.ts").AgentConversationEntry[] = []): void {
		const console = this.console;
		const snapshot = this.snapshot;
		if (!console || !snapshot) return;
		const first = firstTaskEntry(
			{ ...snapshot, partial: snapshot.partial || console.row.state === "starting" },
			console.row,
		);
		console.setContent(first ? [first, ...snapshot.entries] : snapshot.entries, this.history.newer() ? [] : live);
	}
	private async readHistory(before?: number): Promise<void> {
		const console = this.console;
		if (!console || this.earlierPending) return;
		const generation = this.sourceGeneration;
		console.save();
		this.earlierPending = true;
		console.status = before ? "Loading message range…" : "Loading current messages…";
		this.redraw();
		try {
			const page = before
				? await this.source.earlier(console.row.id, before)
				: await this.source.snapshot(console.row.id);
			if (this.closed || generation !== this.sourceGeneration) return;
			this.history.add(page, before, console.state.view.anchor?.id);
			this.snapshot = {
				...page,
				entries: this.history.entries(console.state.view.anchor?.id),
				nextBefore: this.history.earlier(),
			};
			this.setConversation(this.source.frame(console.row.id)?.live);
			console.conversation.reanchor();
			console.status = page.partial ? "Partial history" : "";
		} catch (error) {
			if (generation === this.sourceGeneration) { console.warning = `Conversation unavailable: ${String(error)}`; console.status = ""; }
		} finally {
			this.earlierPending = false;
			this.redraw();
		}
	}
	private earlier(): void {
		const before = this.history.earlier();
		if (before) void this.readHistory(before);
	}

	private taskRow(id: string, label?: TaskLabel): AgentConversationSummary | undefined {
		const published = this.page?.rows.find((item) => item.id === id);
		if (published) return published;
		const parent = this.console?.row;
		if (!parent) return undefined;
		return {
			...parent,
			id,
			name: label?.name,
			firstMessage: label?.firstMessage,
			model: undefined,
			cost: Number.NaN,
			partial: true,
			state: "unavailable",
			error: undefined,
			health: undefined,
		};
	}
	private openTaskConversation(id: string, label?: TaskLabel): void {
		const row = this.taskRow(id, label);
		if (!row) return;
		this.tasks?.dispose();
		this.tasks = undefined;
		this.source.releaseTasks();
		this.state.selected = id;
		this.navigation.roster();
		this.navigation.enter("console", id);
		this.select(row);
		this.redraw();
	}
	private async chooseTaskConversation(labels: readonly TaskLabel[]): Promise<void> {
		const generation = this.navigation.generation;
		this.hidden = true;
		try {
			const id = await this.operations.chooseConversation(labels, this.surface);
			if (id && !this.closed && generation === this.navigation.generation)
				this.openTaskConversation(
					id,
					labels.find((label) => label.identity === id),
				);
		} finally {
			this.hidden = false;
			this.redraw();
		}
	}
	private openTasks(id: string): void {
		this.navigation.enter("tasks", id);
		this.tasks = new AgentTasksView({
			theme: this.theme,
			source: this.source,
			id,
			onChooseConversations: (labels) => {
				void this.chooseTaskConversation(labels);
			},
			onNotice: (text) => {
				this.notice = text;
				this.redraw();
			},
			onSelectConversation: (identity, label) => this.openTaskConversation(identity, label),
		});
		this.redraw();
	}
	/** A created branch has an identity before a bounded metadata page necessarily includes it. */
	private openBranch(id: string): void {
		const source = this.console?.row;
		if (!source) return;
		const branch: AgentConversationSummary = this.page?.rows.find((row) => row.id === id) ?? {
			id,
			storageId: source.storageId,
			cwd: source.cwd,
			modifiedAt: Date.now(),
			owner: "unknown",
			state: "new",
			cost: Number.NaN,
			partial: true,
		};
		if (!this.rows.some((row) => row.id === id)) this.rows.push(branch);
		this.select(branch);
	}
	private actionResult(result: DashboardResult, name: string, id: string): void {
		if (result.sessionId && result.sessionId !== id) {
			this.state.selected = result.sessionId;
			this.state.filter = "";
			this.navigation.roster();
			if (name === "fork" || name === "rewind") {
				this.navigation.enter("console", result.sessionId);
				this.openBranch(result.sessionId);
			}
			return;
		}
		if (name === "status" || result.text.includes("\n")) {
			this.result = result.text;
			this.helpOffset = 0;
			this.navigation.enter("result", id);
			return;
		}
		this.navigation.roster();
	}
	private async runAction(): Promise<void> {
		const console = this.console;
		if (!console) return;
		const choice = dashboardActions(console.row)[this.actionIndex];
		if (!choice) return;
		if (choice.disabled) {
			this.notice = choice.disabled;
			this.redraw();
			return;
		}
		if (choice.name === "tasks") {
			this.openTasks(console.row.id);
			return;
		}
		const generation = this.navigation.generation;
		this.notice = undefined;
		console.state.receipt = undefined;
		try {
			this.hidden = true;
			const result = await Promise.resolve().then(() => this.operations.action(choice.name, console.row, this.surface));
			if (!result) return;
			console.state.receipt = result.text;
			if (result.sessionId && result.sessionId !== console.row.id && ["fork", "rewind"].includes(choice.name))
				await this.refreshRoster();
			if (!this.closed && generation === this.navigation.generation)
				this.actionResult(result, choice.name, console.row.id);
			this.queueRoster();
		} catch (error) {
			console.state.receipt = `Action failed: ${String(error)}`;
		} finally {
			this.hidden = false;
			this.redraw();
		}
	}
	private readerInput(data: string): void {
		const changes: Record<string, number> = { up: -1, down: 1, pageUp: -this.bodyHeight, pageDown: this.bodyHeight };
		for (const [key, delta] of Object.entries(changes))
			if (matchesKey(data, key as "up")) this.helpOffset = Math.max(0, this.helpOffset + delta);
		if (matchesKey(data, "home")) this.helpOffset = 0;
		if (matchesKey(data, "end")) this.helpOffset = Number.MAX_SAFE_INTEGER;
	}
	private actionsInput(data: string): void {
		const last = this.console ? dashboardActions(this.console.row).length - 1 : 0;
		const size = Math.max(1, Math.floor(this.bodyHeight / 2));
		const changes: Record<string, number> = { up: -1, down: 1, pageUp: -size, pageDown: size };
		for (const [key, delta] of Object.entries(changes))
			if (matchesKey(data, key as "up")) this.actionIndex = Math.max(0, Math.min(last, this.actionIndex + delta));
		if (matchesKey(data, "home")) this.actionIndex = 0;
		if (matchesKey(data, "end")) this.actionIndex = last;
		if (matchesKey(data, "enter")) void this.runAction();
	}
	private findInput(data: string): void {
		if (matchesKey(data, "up") || matchesKey(data, "down")) this.move(matchesKey(data, "up") ? -1 : 1);
		else if (matchesKey(data, "tab")) this.find.onSubmit?.(this.find.getValue());
		else this.find.handleInput(data);
		this.reconcile();
	}
	private transcriptInput(data: string): boolean {
		const console = this.console;
		if (!console) return false;
		if (this.keys.matches(data, "app.tools.expand") || matchesKey(data, "ctrl+o")) {
			console.state.view.expanded = !console.state.view.expanded;
			this.reloadContent();
			return true;
		}
		if (this.keys.matches(data, "app.thinking.toggle") || matchesKey(data, "ctrl+t")) {
			console.state.view.showThinking = !console.state.view.showThinking;
			this.reloadContent();
			return true;
		}
		if (!matchesKey(data, "pageUp") && !matchesKey(data, "pageDown")) return false;
		const up = matchesKey(data, "pageUp");
		if (up && console.conversation.atTop()) this.earlier();
		else if (!up && console.conversation.atBottom() && this.history.newer())
			void this.readHistory(this.history.newer()?.upper);
		else console.conversation.page((up ? -1 : 1) * Math.max(1, this.bodyHeight - 1));
		return true;
	}
	private messageInput(data: string): void {
		const console = this.console;
		if (!console) return;
		if (matchesKey(data, "tab")) {
			if (console.row.state === "working") console.state.mode = console.state.mode === "steer" ? "followUp" : "steer";
			return;
		}
		if (matchesKey(data, "ctrl+v")) {
			this.notice = "This field accepts text, not file or image attachments";
			return;
		}
		console.composer.handleInput(data);
	}
	private emptyStore(): boolean {
		return Boolean(this.page?.coverage.complete && !this.page.rows.length && !this.state.filter);
	}
	private rosterEnter(): void {
		if (this.loadMore) {
			const cursor = this.page?.coverage.nextCursor ?? undefined;
			this.rosterNotice = "Loading more agents…";
			queueMicrotask(() => {
				void this.refreshRoster(cursor);
			});
			return;
		}
		if (this.emptyStore()) {
			this.navigation.enter("new");
			return;
		}
		if (this.console) this.navigation.enter("console", this.console.row.id);
	}
	private openEfforts(): void {
		if (!this.operations.efforts) {
			this.notice = "Related efforts unavailable. Restart this Pi window with the current agent extension.";
			return;
		}
		this.saveConsole();
		this.effortsOpen = true;
		this.efforts ??= new EffortView({
			tui: this.tui, theme: this.theme, keys: this.keys,
			efforts: this.operations.efforts,
			messageEffort: this.operations.messageEffort,
			openContact: (threadId) => this.openThreads(threadId),
			openThreads: () => this.openThreads(),
			onBack: () => { this.effortsOpen = false; this.mouse.reset(); this.redraw(); },
			redraw: () => this.redraw(),
		});
		this.mouse.reset();
		this.efforts.open();
	}
	private openThreads(contactThread?: string): string | undefined {
		if (!this.operations.collaborate) {
			this.notice = "Threads unavailable. Restart this Pi window with the current agent extension.";
			return this.notice;
		}
		this.saveConsole();
		this.effortsOpen = false;
		this.navigation.enter("threads");
		this.state.threads ??= createCollaborationViewState();
		this.threads ??= new CollaborationView({
			tui: this.tui,
			theme: this.theme,
			keys: this.keys,
			state: this.state.threads,
			exactTime: () => this.state.exactTime,
			toggleTime: () => {
				this.state.exactTime = !this.state.exactTime;
				this.redraw();
			},
			collaborate: this.operations.collaborate,
			nameFor: (id) => this.page?.rows.find((row) => row.id === id)?.name || id,
			selectedAgent: () => this.state.selected,
			redraw: () => this.redraw(),
			onBack: () => this.back(),
		});
		if (contactThread) this.threads.openContact(contactThread);
		else this.threads.open();
	}
	private rosterInput(data: string): void {
		this.notice = undefined;
		if (!matchesKey(data, "up") && !matchesKey(data, "down")) this.rosterOrderLocked = false;
		const actions: Record<string, () => void> = {
			n: () => this.navigation.enter("new"),
			t: () => this.openThreads(),
			b: () => this.openEfforts(),
			a: () => {
				if (this.console && !this.loadMore) {
					this.actionIndex = 0;
					this.navigation.enter("actions", this.console.row.id);
				}
			},
			m: () => {
				if (this.console && !this.loadMore) this.navigation.enter("message", this.console.row.id);
			},
			"/": () => {
				this.findBefore = { filter: this.state.filter, selected: this.state.selected };
				this.find.setValue(this.state.filter);
				this.navigation.enter("find");
			},
			"?": () => {
				this.helpOffset = 0;
				this.navigation.enter("help");
			},
		};
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.move(matchesKey(data, "up") ? -1 : 1);
			return;
		}
		if (matchesKey(data, "enter")) {
			this.rosterEnter();
			return;
		}
		if (matchesKey(data, "tab")) {
			if (!this.loadMore) actions.m();
			return;
		}
		if (data === "i") {
			this.state.exactTime = !this.state.exactTime;
			return;
		}
		if (actions[data]) {
			actions[data]();
			return;
		}
		if (data.length === 1)
			this.notice = this.console ? `Tab to write to ${agentDisplayName(this.console.row)}` : "n starts a new agent";
	}
	private routeInput(data: string): void {
		const screen = this.navigation.screen;
		const routes: Partial<Record<typeof screen, () => void>> = {
			help: () => this.readerInput(data),
			result: () => this.readerInput(data),
			actions: () => this.actionsInput(data),
			find: () => this.findInput(data),
			tasks: () => {
				this.tasks?.handleInput(data);
				if (data === "r") void this.tasks?.refresh();
			},
			new: () => this.newComposer.handleInput(data),
		};
		if (routes[screen]) {
			routes[screen]();
			return;
		}
		if (this.transcriptInput(data)) return;
		if (screen === "message" || screen === "console") this.messageInput(data);
		else this.rosterInput(data);
	}
	private effortInput(data: string): void {
		if (matchesKey(data, "escape") || (this.tui.terminal.columns >= 60 && this.tui.terminal.rows >= 20))
			this.efforts?.handleInput(data);
	}
	handleInput(data: string): void {
		if (this.closed) return;
		if (this.effortsOpen) { this.effortInput(data); return; }
		if (this.navigation.screen === "threads") {
			if (matchesKey(data, "escape") || (this.tui.terminal.columns >= 60 && this.tui.terminal.rows >= 20))
				this.threads?.handleInput(data);
			this.redraw();
			return;
		}
		if (matchesKey(data, "escape")) {
			this.back();
			return;
		}
		if (this.tui.terminal.columns < 60 || this.tui.terminal.rows < 20) return;
		const screen = this.navigation.screen;
		if (this.console && !["find", "actions", "result"].includes(screen)) this.console.state.receipt = undefined;
		if (["roster", "actions", "help", "tasks", "result"].includes(screen) && data.includes("\x1b[200~")) {
			this.notice = "Paste into a message field";
			this.redraw();
			return;
		}
		this.routeInput(data);
		this.redraw();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || this.hidden || this.mouseScreen !== this.navigation.screen) return;
		if (this.effortsOpen) return this.efforts?.handleMouse(event);
		if (this.navigation.screen === "threads") return this.threads?.handleMouse(event);
		return this.mouse.handle(event);
	}
	private mouseSelect(id: string): false | undefined {
		if (!this.rows.some((row) => row.id === id)) return false;
		if (this.navigation.screen === "find") this.find.onSubmit?.(this.find.getValue());
		else this.navigation.roster();
		this.state.selected = id;
		this.loadMore = false;
		this.rosterOrderLocked = true;
		this.reconcile();
		this.redraw();
	}
	private wheelConversation(delta: number): void {
		const conversation = this.console?.conversation;
		if (!conversation) return;
		if (delta < 0 && conversation.atTop()) this.earlier();
		else if (delta > 0 && conversation.atBottom() && this.history.newer())
			void this.readHistory(this.history.newer()?.upper);
		else conversation.page(delta);
		this.redraw();
	}
	private reloadContent(): void {
		this.setConversation(this.console ? this.source.frame(this.console.row.id)?.live : []);
		this.redraw();
	}

	private title(): string {
		const screen = this.navigation.screen;
		const names: Partial<Record<typeof screen, string>> = {
			help: "Agents > Help",
			tasks: "Agents > Tasks",
			result: "Agents > Details",
		};
		if (names[screen]) return names[screen];
		if (screen === "console" || screen === "actions")
			return `Agents > ${this.console ? agentDisplayName(this.console.row) : "Agent"}${screen === "actions" ? " > Actions" : ""}`;
		return this.sessionFigures ? this.sessionFigures.replace(/^agents/, "Agents") : "Agents";
	}
	private heading(width: number): string {
		let position = "";
		if (this.navigation.screen === "actions" && this.console)
			position = `${this.actionIndex + 1}/${dashboardActions(this.console.row).length} actions`;
		else if (["roster", "find", "message", "console"].includes(this.navigation.screen)) {
			const index = this.rows.findIndex((row) => row.id === this.state.selected);
			position = `${index + 1}/${this.rows.length}${this.page?.coverage.complete ? "" : "+"}`;
		}
		return dashboardHeading(this.title(), position, width, this.theme);
	}
	private actionLines(): string[] {
		if (!this.console) return [];
		const choices = dashboardActions(this.console.row);
		const capacity = Math.max(1, Math.floor((this.bodyHeight - 2) / 2));
		const start = Math.max(0, Math.min(choices.length - capacity, this.actionIndex - Math.floor(capacity / 2)));
		const visible = choices.slice(start, start + capacity);
		for (let index = 0; index < visible.length; index++)
			this.mouse.add({
				x: 0,
				y: 1 + index * 2,
				width: this.tui.terminal.columns,
				height: 2,
				click: () => {
					this.actionIndex = start + index;
				},
			});
		const lines = visible.flatMap((choice, index) => [
			dashboardSelection(
				`${start + index === this.actionIndex ? "›" : " "} ${choice.label}${choice.disabled ? ` · ${choice.disabled}` : ""}`,
				this.tui.terminal.columns,
				start + index === this.actionIndex,
				this.theme,
			),
			this.theme.fg("muted", `  ${choice.description}`),
		]);
		if (visible.length < choices.length)
			lines.push(`${this.actionIndex + 1}/${choices.length} actions · +${choices.length - visible.length} more`);
		return lines;
	}
	private readerLines(width: number): string[] {
		const source = this.navigation.screen === "help" ? HELP : this.result.split("\n");
		const content = source.flatMap((line) =>
			wrapTextWithAnsi(
				this.navigation.screen === "help" && ["Dashboard", "Messages", "Read", "Return"].includes(line)
					? this.theme.bold(this.theme.fg("accent", line))
					: line,
				Math.max(1, width),
			),
		);
		this.helpOffset = Math.max(0, Math.min(this.helpOffset, Math.max(0, content.length - this.bodyHeight)));
		return content.slice(this.helpOffset, this.helpOffset + this.bodyHeight);
	}
	private renderModal(width: number, height: number): string[] {
		this.bodyHeight = height - 3;
		const screen = this.navigation.screen;
		const body =
			screen === "tasks"
				? (this.tasks?.render(width, this.bodyHeight) ?? ["Reading tasks…"])
				: screen === "actions"
					? this.actionLines()
					: this.readerLines(width);
		this.mouse.add({
			x: 0,
			y: 1,
			width,
			height: this.bodyHeight,
			wheel: (delta) => {
				if (screen === "tasks") this.tasks?.scroll(delta);
				else if (screen === "actions") {
					const last = this.console ? dashboardActions(this.console.row).length - 1 : 0;
					this.actionIndex = Math.max(0, Math.min(last, this.actionIndex + delta));
				} else this.helpOffset = Math.max(0, this.helpOffset + delta);
			},
		});
		if (screen === "tasks")
			this.mouse.add({
				x: 0,
				y: 1,
				width,
				height: this.bodyHeight,
				click: (event) => (this.tasks?.clickRow(event.y) ? undefined : false),
			});
		const hints =
			screen === "help" || screen === "result"
				? ["↑↓ scroll", "PgUp/PgDn read"]
				: ["PgUp/PgDn read", "↑↓ select", "Enter choose"];
		return [
			this.heading(width),
			...Array.from({ length: this.bodyHeight }, (_, index) => body[index] ?? ""),
			(screen === "actions" ? this.console?.state.receipt : undefined) ?? this.notice ?? "",
			mouseHints(this.mouse, height - 1, hints, "Esc back", width, (data) => this.handleInput(data), this.theme),
		];
	}
	private messageLabel(): string {
		if (this.navigation.screen === "new") return `New agent · Enter starts · ${this.creating ? "Starting…" : "Task"}`;
		if (this.navigation.screen === "find") return "Find loaded agents · Enter keeps filter · Esc cancels";
		return (
			this.console?.messageLabel() ??
			(this.emptyStore() ? "Enter or n starts a new agent" : "No selected agent · n starts a new agent")
		);
	}
	private statusText(): string {
		if (this.console) {
			return `${sessionAppearance[this.console.row.state].label} · ${activityOf(this.console.row)}`;
		}
		if (!this.page) return "Loading roster…";
		if (this.state.filter) return `No agents match ${this.state.filter}`;
		return this.page.coverage.complete
			? "No agents yet. Start an agent with a task in your own words."
			: "Roster coverage incomplete";
	}
	private hintLine(width: number): string {
		const screen = this.navigation.screen;
		const hints: Partial<Record<typeof screen, [string[], string]>> = {
			console: [["PgUp/PgDn read", "Enter send", "Tab steer/follow-up", "Ctrl+J newline"], "Esc dashboard"],
			message: [["PgUp/PgDn read", "Enter send", "Tab steer/follow-up", "Ctrl+J newline"], "Esc roster"],
			new: [["Enter start", "Ctrl+J newline"], "Esc roster"],
			find: [["↑↓ select", "Enter keep filter"], "Esc cancel find"],
		};
		const normal: [string[], string] = this.rows.length
			? [
					[
						"↑↓ select",
						"Enter open",
						"b efforts",
						"Tab message",
						"t threads",
						"n new",
						"a actions",
						"/ find",
						"? help",
					],
					this.state.filter ? "Esc clear find" : "Esc close",
				]
			: this.emptyStore()
				? [["b efforts", "Enter new agent", "n new", "t threads", "/ find", "? help"], "Esc close"]
				: [["b efforts", "n new", "t threads", "/ find", "? help"], this.state.filter ? "Esc clear find" : "Esc close"];
		const [items, back] = hints[screen] ?? normal;
		return mouseHints(
			this.mouse,
			this.tui.terminal.rows - 1,
			items,
			back,
			width,
			(data) => this.handleInput(data),
			this.theme,
		);
	}
	private rosterViewport(width: number, height: number, compact: boolean, y: number): string[] {
		const lines = rosterLines(
			this.rows,
			this.loadMore ? undefined : this.state.selected,
			width,
			height,
			Date.now(),
			this.theme,
			compact,
			{
				primaryId: this.primaryId,
				start: this.rosterScroll,
				exactTime: this.state.exactTime,
				range: (start, maxStart) => {
					this.rosterStart = start;
					this.rosterMaxStart = maxStart;
				},
				row: (row, line, count) =>
					this.mouse.add({ x: 0, y: y + line, width, height: count, click: () => this.mouseSelect(row.id) }),
				timestamp: (_row, line, x, timeWidth) =>
					this.mouse.add({
						x,
						y: y + line,
						width: timeWidth,
						height: 1,
						click: () => {
							this.state.exactTime = !this.state.exactTime;
						},
					}),
			},
		);
		this.mouse.add({
			x: 0,
			y,
			width,
			height,
			wheel: (delta) => {
				this.rosterScroll = Math.max(0, Math.min(this.rosterMaxStart, this.rosterStart + delta));
				this.redraw();
			},
		});
		if (!this.rows.length && this.page?.rows.length)
			lines[lines.length - 1] = `0 matches of ${this.page.rows.length} loaded`;
		return lines;
	}
	private loadMoreLine(width: number, y: number): string {
		if (!this.page?.coverage.nextCursor) return "";
		this.mouse.add({
			x: 0,
			y,
			width,
			height: 1,
			click: () => {
				this.loadMore = true;
				this.rosterEnter();
			},
		});
		return this.loadMore ? "› Load more agents" : "Load more agents";
	}
	private rosterFooter(summary: string, width: number, y: number): string {
		const action = this.loadMoreLine(width, y);
		if (this.rosterNotice) return this.theme.fg("muted", fitLine(cleanDashboardText(this.rosterNotice).replace(/\s+/g, " "), width));
		const coverage = this.page?.coverage;
		const facts: string[] = [];
		if (coverage?.skipped) facts.push(`${coverage.skipped} unreadable`);
		if (coverage?.omitted) facts.push(`${coverage.omitted} omitted`);
		if (coverage && !coverage.complete && !coverage.nextCursor && !facts.length) facts.push("Incomplete");
		const loaded = cleanDashboardText(summary);
		let parts = [loaded, ...facts, action].filter(Boolean);
		if (visibleWidth(parts.join(" · ")) > width) {
			parts = [loaded, ...facts, action ? this.loadMore ? "› More" : "More" : ""].filter(Boolean);
		}
		const text = parts.join(" · ");
		return this.theme.fg("muted", fitLine(visibleWidth(text) <= width ? text : parts.join("  "), width));
	}
	private selectedHeader(width: number): string[] {
		if (this.navigation.screen === "new") return [this.theme.bold("New agent"), this.theme.fg("muted", "Primary model and directory")];
		const console = this.console;
		if (!console) return [this.statusText(), this.notice].filter((line): line is string => Boolean(line)).map((line) => this.theme.fg("muted", line));
		const row = console.row;
		const appearance = sessionAppearance[row.state];
		const activity = this.navigation.screen === "console" && row.state === "working" && !needsAttention(row) ? ` · ${activityOf(row)}` : "";
		const state = truncateToWidth(`${appearance.glyph} ${appearance.label}${activity}`, Math.floor(width / 2), "…");
		const name = this.theme.bold(this.theme.fg("text", titleOf(row)));
		const lines = [`${fitLine(name, Math.max(1, width - visibleWidth(state) - 2))}  ${this.theme.fg(appearance.color, state)}`];
		const window = row.model ? this.operations.contextWindow?.(row.model.provider, row.model.modelId) : undefined;
		lines.push(...console.footer(width, window).split("\n"));
		const reason = attentionReason(row);
		if (reason) lines.push(this.theme.fg("error", reason));
		if (console.warning) lines.push(this.theme.fg("warning", console.warning));
		if (this.notice) lines.push(this.theme.fg("warning", this.notice));
		return lines.map((line) => fitLine(line, width));
	}
	private conversationBoundary(width: number): string {
		const console = this.console;
		const position = console?.conversation.position();
		let label = "";
		if (console?.status && console.status !== "Partial history") label = console.status;
		else if (position && !position.end) {
			label = position.first <= 1 && (this.history.earlier() || console?.status === "Partial history")
				? "Partial history · PgUp loads earlier"
				: `↓ ${position.estimated ? "about " : ""}${position.total - position.last} lines below`;
		} else if (this.history.newer()) label = "Newer messages available · PgDn loads more";
		return dashboardRule(label, width, this.theme);
	}
	private transcriptLines(width: number, height: number): string[] {
		const conversation = this.console?.conversation;
		const lines = conversation?.render(Math.max(1, width - 1), height) ?? Array.from({ length: height }, () => "");
		const position = conversation?.position();
		if (!position || position.total <= height) return lines.map((line) => fitLine(line, width));
		const thumb = Math.max(1, Math.round(height * height / position.total));
		const top = Math.round((height - thumb) * (position.first - 1) / Math.max(1, position.total - height));
		return lines.map((line, index) => fitLine(line, width - 1) + this.theme.fg(index >= top && index < top + thumb ? "scrollbarThumb" : "scrollbarTrack", index >= top && index < top + thumb ? "┃" : "│"));
	}
	private renderDashboard(width: number, height: number): string[] {
		const screen = this.navigation.screen;
		const focused = screen === "message" || screen === "console";
		const composer = screen === "new" ? this.newComposer : this.console?.composer;
		const reserved = screen === "find" ? 1 : 0;
		const shape = dashboardGeometry(width, height, 0, screen === "console", reserved);
		const paneWidth = shape.conversationWidth;
		const header = this.selectedHeader(paneWidth - 2).map((line) => ` ${line} `);
		const editor = composer?.render(paneWidth, this.messageLabel(), focused ? this.console?.messageMode() : "", screen === "new" ? this.notice : this.console?.state.receipt) ?? [];
		const geometry = dashboardGeometry(width, height, editor.length, screen === "console", reserved, header.length + 2);
		this.bodyHeight = geometry.bodyHeight;
		const transcript = this.transcriptLines(paneWidth, geometry.bodyHeight);
		const pane = [...header, this.conversationBoundary(paneWidth), ...transcript, "", ...editor];
		const bodyY = 1 + reserved;
		const paneX = geometry.wide ? geometry.rosterWidth + 1 : 0;
		const paneY = bodyY + geometry.rosterHeight;
		this.mouse.add({
			x: paneX, y: paneY + header.length, width: paneWidth, height: geometry.bodyHeight + 1,
			click: () => {
				if (!this.console || screen === "new" || screen === "find") return false;
				if (screen !== "console") this.navigation.enter("console", this.console.row.id);
			},
			wheel: (delta) => this.wheelConversation(delta),
		});
		this.mouse.add({
			x: paneX, y: paneY + header.length + geometry.bodyHeight + 2, width: paneWidth, height: editor.length,
			click: (event) => {
				if (!composer) return false;
				if (screen !== "new" && screen !== "console" && screen !== "message" && this.console)
					this.navigation.enter("message", this.console.row.id);
				composer.focused = true;
				return composer.handleMouse(event);
			},
		});
		let body: string[];
		if (geometry.wide) {
			const roster = this.rosterViewport(geometry.rosterWidth - 1, geometry.paneHeight, false, bodyY);
			const last = Math.max(0, roster.length - 1);
			roster[last] = this.rosterFooter(roster[last] ?? "", geometry.rosterWidth, bodyY + last);
			body = pane.map((line, index) => fitLine(roster[index] ?? "", geometry.rosterWidth) + this.theme.fg("borderMuted", "│") + fitLine(line, paneWidth));
		} else if (screen === "console") body = pane;
		else {
			const roster = this.rosterViewport(width, 4, true, bodyY);
			roster[3] = this.rosterFooter(roster[3] ?? "", width, bodyY + 3);
			body = [...roster, ...pane];
		}
		if (reserved) {
			body.unshift(this.find.render(width)[0] ?? "");
			this.mouse.add({ x: 0, y: 1, width, height: 1, click: (event) => this.find.handleMouse({ ...event, type: "press" }) });
		}
		return [this.heading(width), ...body, this.hintLine(width)];
	}
	render(width: number): string[] {
		const height = this.tui.terminal.rows;
		this.mouse.reset(width, height);
		this.mouseScreen = this.navigation.screen;
		if (width < 60 || height < 20)
			return Array.from({ length: height }, (_, index) =>
				fitLine(index === 0 ? "Resize to use Agents. Esc back." : "", width),
			);
		if (this.effortsOpen) return this.efforts?.render(width, height) ?? [];
		const screen = this.navigation.screen;
		this.newComposer.focused = screen === "new";
		this.find.focused = screen === "find";
		if (this.console) this.console.composer.focused = screen === "message" || screen === "console";
		if (screen === "threads") return this.threads?.render(width, height) ?? [];
		const lines = ["help", "actions", "tasks", "result"].includes(screen)
			? this.renderModal(width, height)
			: this.renderDashboard(width, height);
		return lines.map((line) => fitLine(line, width));
	}
	invalidate(): void {
		this.mouse.reset();
		this.console?.conversation.invalidate();
		this.console?.composer.invalidate();
		this.newComposer.invalidate();
		this.find.invalidate();
		this.threads?.invalidate();
		this.efforts?.invalidate();
	}
	dispose(): void {
		if (this.closed) return;
		this.saveConsole();
		this.closed = true;
		this.console?.dispose();
		this.sourceGeneration++;
		for (const off of this.unsubscribe) off();
		this.source.select(undefined);
		this.source.releaseTasks();
		this.tasks?.dispose();
		this.threads?.dispose();
		this.efforts?.dispose();
		clearInterval(this.reconciliation);
		clearTimeout(this.rosterTimer);
		clearTimeout(this.streamTimer);
	}
}
export async function showAgentDashboard(input: {
	ctx: ExtensionContext;
	source: AgentObservationSource;
	operations: DashboardOperations;
	state?: DashboardState;
}): Promise<void> {
	const { ctx } = input;
	if (ctx.mode !== "tui") {
		const page = await input.source.list();
		ctx.ui.notify(`The dashboard needs the interactive terminal. ${page.rows.length} loaded agents.`, "info");
		return;
	}
	let handle: { setHidden(hidden: boolean): void } | undefined;
	const surface = { hide: () => handle?.setHidden(true), show: () => handle?.setHidden(false) };
	await ctx.ui.custom<void>(
		(tui, theme, keys, done) =>
			new AgentDashboard(
				tui,
				theme,
				keys,
				done,
				input.state ?? dashboardSessionState(ctx.sessionManager.getSessionId()),
				input.source,
				input.operations,
				surface,
				ctx.sessionManager.getSessionId(),
			),
		{
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
			onHandle: (value) => {
				handle = value;
			},
		},
	);
}
