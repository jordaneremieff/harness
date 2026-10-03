import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { AgentConversationPage, AgentConversationSummary, AgentConversationSnapshot } from "./dashboard-types.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import { AgentConsole } from "./agent-console.ts";
import { AgentComposer } from "./agent-composer.ts";
import { AgentTasksView } from "./agent-tasks.ts";
import { dashboardActions } from "./dashboard-actions.ts";
import { dashboardGeometry, fitHints, fitLine } from "./dashboard-layout.ts";
import {
	dashboardRecords,
	rosterLines,
	coverageText,
	rosterTotals,
	rosterAge,
	attentionReason,
} from "./dashboard-roster.ts";
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
import { firstTaskEntry } from "./dashboard-conversation.ts";
import { ConversationHistory } from "./conversation-view.ts";
import type { NativeSurface } from "./action-dialogs.ts";
import { CollaborationView, createCollaborationViewState, type Collaborate } from "./collaboration-view.ts";

export interface DashboardResult {
	text: string;
	sessionId?: string;
}
export interface DashboardOperations {
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
	"a opens actions. / finds loaded agents. t opens Threads. ? opens help.",
	"Threads shows the frame, peers, and exchange. p posts without a model wake.",
	"n chooses peers to notify. Tab returns to the message. Enter posts.",
	"i switches Threads event times between local time and exact UTC timestamps.",
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
	"Live means a current host observation. Retained means stored or stale data.",
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
	private actionIndex = 0;
	private helpOffset = 0;
	private result = "";
	private notice?: string;
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
	private readonly age: ReturnType<typeof setInterval>;
	private rosterTimer?: ReturnType<typeof setTimeout>;
	private streamTimer?: ReturnType<typeof setTimeout>;
	private lastStreamPaint = 0;
	private lastAgeText = "";
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
	constructor(
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		done: () => void,
		state: DashboardState,
		source: AgentObservationSource,
		operations: DashboardOperations,
		surface: NativeSurface,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.state = state;
		this.source = source;
		this.operations = operations;
		this.surface = surface;
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
			}),
		);
		this.reconciliation = setInterval(() => {
			if (!this.hidden) void this.refreshRoster();
		}, 2000);
		this.age = setInterval(() => {
			if (!this.hidden && !this.closed) {
				const text = this.rows.map((row) => rosterAge(row.modifiedAt, Date.now())).join(",");
				if (text !== this.lastAgeText) {
					this.lastAgeText = text;
					this.redraw();
				}
			}
		}, 1000);
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
			this.reconcile();
			this.redraw();
		} catch (error) {
			this.notice = `Roster unavailable: ${error instanceof Error ? error.message : String(error)}`;
			if (cursor) {
				this.loadedPages = 1;
				this.rosterAgain = true;
				this.notice = "Catalog changed. Refreshing the roster.";
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
			console.status =
				row.state === "starting" ? "STARTING" : snapshot.partial ? "RETAINED · partial history" : "RETAINED";
			if (snapshot.nextBefore) console.status += " · Earlier messages available";
			this.redraw();
		} catch (error) {
			if (
				generation === this.sourceGeneration &&
				!this.closed &&
				this.console &&
				this.source.availability(row.id)?.state !== "live"
			) {
				this.console.status = `Conversation unavailable: ${String(error)}`;
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
			console.status =
				availability?.state === "unavailable"
					? `RETAINED · Last seen ${availability.at}`
					: `LIVE${frame.nextBefore ? " · Earlier messages available" : ""}`;
			this.updateObservedRow(console, frame);
			if (console.row.state === "starting") console.status = "STARTING";
		}
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
			console.status = this.history.newer()
				? "RETAINED · Newer range available"
				: this.snapshot.nextBefore
					? "Earlier messages available"
					: "Start of history";
		} catch (error) {
			if (generation === this.sourceGeneration) console.status = `Messages unavailable: ${String(error)}`;
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
		const size = Math.max(1, Math.floor(this.bodyHeight / 2));
		const changes: Record<string, number> = { up: -1, down: 1, pageUp: -size, pageDown: size };
		for (const [key, delta] of Object.entries(changes))
			if (matchesKey(data, key as "up")) this.actionIndex = Math.max(0, Math.min(11, this.actionIndex + delta));
		if (matchesKey(data, "home")) this.actionIndex = 0;
		if (matchesKey(data, "end")) this.actionIndex = 11;
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
			this.notice = "Loading more agents…";
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
	private openThreads(): void {
		if (!this.operations.collaborate) {
			this.notice = "Threads unavailable. Restart this Pi window with the current agent extension.";
			return;
		}
		this.saveConsole();
		this.navigation.enter("threads");
		this.state.threads ??= createCollaborationViewState();
		this.threads ??= new CollaborationView({
			tui: this.tui,
			theme: this.theme,
			keys: this.keys,
			state: this.state.threads,
			collaborate: this.operations.collaborate,
			nameFor: (id) => this.page?.rows.find((row) => row.id === id)?.name || id,
			selectedAgent: () => this.state.selected,
			redraw: () => this.redraw(),
			onBack: () => this.back(),
		});
		this.threads.open();
	}
	private rosterInput(data: string): void {
		this.notice = undefined;
		if (!matchesKey(data, "up") && !matchesKey(data, "down")) this.rosterOrderLocked = false;
		const actions: Record<string, () => void> = {
			n: () => this.navigation.enter("new"),
			t: () => this.openThreads(),
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
	handleInput(data: string): void {
		if (this.closed) return;
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
		return `Agents · ${this.page?.rows.length ?? 0} ${this.page?.coverage.complete ? "agents" : "loaded agents"} · ${rosterTotals(this.page ? { sessions: this.page.rows, observedAt: Date.parse(this.page.observedAt), coverage: this.page.coverage } : undefined)}`;
	}
	private actionLines(): string[] {
		if (!this.console) return [];
		const choices = dashboardActions(this.console.row);
		const capacity = Math.max(1, Math.floor((this.bodyHeight - 2) / 2));
		const start = Math.max(0, Math.min(choices.length - capacity, this.actionIndex - Math.floor(capacity / 2)));
		const visible = choices.slice(start, start + capacity);
		const lines = visible.flatMap((choice, index) => [
			`${start + index === this.actionIndex ? "›" : " "} ${choice.label}${choice.disabled ? ` · ${choice.disabled}` : ""}`,
			`  ${choice.description}`,
		]);
		if (visible.length < choices.length)
			lines.push(`${this.actionIndex + 1}/${choices.length} actions · +${choices.length - visible.length} more`);
		return lines;
	}
	private readerLines(width: number): string[] {
		const source = this.navigation.screen === "help" ? HELP : this.result.split("\n");
		const content = source.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
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
		const hints =
			screen === "help" || screen === "result"
				? ["↑↓ scroll", "PgUp/PgDn read"]
				: ["↑↓ select", "Enter choose", "PgUp/PgDn read"];
		return [
			this.title(),
			...Array.from({ length: this.bodyHeight }, (_, index) => body[index] ?? ""),
			(screen === "actions" ? this.console?.state.receipt : undefined) ?? this.notice ?? "",
			fitHints(hints, "Esc back", width),
		];
	}
	private messageLabel(width: number, focused: boolean): string {
		if (this.navigation.screen === "new") return `New agent · Enter starts · ${this.creating ? "Starting…" : "Task"}`;
		if (this.navigation.screen === "find") return "Find loaded agents · Enter keeps filter · Esc cancels";
		return (
			this.console?.messageLabel(focused, width) ??
			(this.emptyStore() ? "Enter or n starts a new agent" : "No selected agent · n starts a new agent")
		);
	}
	private statusText(): string {
		if (this.console) {
			const reason = attentionReason(this.console.row);
			return reason ? `${reason} · ${this.console.status}` : this.console.status;
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
			console: [["Enter send", "Tab steer/follow-up", "PgUp/PgDn read"], "Esc dashboard"],
			message: [["Enter send", "Tab steer/follow-up", "Ctrl+J newline", "PgUp/PgDn read"], "Esc roster"],
			new: [["Enter start", "Ctrl+J newline"], "Esc roster"],
			find: [["↑↓ select", "Enter keep filter"], "Esc cancel find"],
		};
		const normal: [string[], string] = this.rows.length
			? [
					["↑↓ select", "Enter open", "Tab message", "t threads", "n new", "a actions", "/ find", "? help"],
					this.state.filter ? "Esc clear find" : "Esc close",
				]
			: this.emptyStore()
				? [["Enter new agent", "n new", "t threads", "/ find", "? help"], "Esc close"]
				: [["n new", "t threads", "/ find", "? help"], this.state.filter ? "Esc clear find" : "Esc close"];
		const [items, back] = hints[screen] ?? normal;
		return fitHints(items, back, width);
	}
	private rosterViewport(width: number, height: number, compact: boolean): string[] {
		const lines = rosterLines(
			this.rows,
			this.loadMore ? undefined : this.state.selected,
			width,
			height,
			Date.now(),
			this.theme,
			compact,
		);
		if (!this.rows.length && this.page?.rows.length)
			lines[lines.length - 1] = `0 matches of ${this.page.rows.length} loaded`;
		return lines;
	}
	private dashboardBody(
		width: number,
		geometry: ReturnType<typeof dashboardGeometry>,
		conversation: string[],
	): string[] {
		if (geometry.wide) {
			const roster = this.rosterViewport(38, geometry.bodyHeight, false);
			if (this.page?.coverage.nextCursor && roster.length < geometry.bodyHeight)
				roster.push(this.loadMore ? "› Load more agents · Enter" : "  Load more agents");
			return conversation.map(
				(line, index) => `${fitLine(roster[index] ?? "", 38)}│${fitLine(line, geometry.conversationWidth)}`,
			);
		}
		if (this.navigation.screen === "console") return conversation;
		const roster = this.rosterViewport(width, 4, true);
		return [
			...roster,
			this.page?.coverage.nextCursor
				? this.loadMore
					? "› Load more agents · Enter"
					: "  Load more agents"
				: coverageText(this.page?.coverage),
			...conversation,
		];
	}
	private renderDashboard(width: number, height: number): string[] {
		const screen = this.navigation.screen;
		const focused = screen === "message" || screen === "console";
		const editor =
			screen === "new" ? this.newComposer.render(width) : (this.console?.composer.render(width) ?? ["", "", ""]);
		const geometry = dashboardGeometry(width, height, editor.length, screen === "console", screen === "find" ? 1 : 0);
		this.bodyHeight = geometry.bodyHeight;
		const status = this.statusText();
		const conversation =
			this.console?.conversation.render(geometry.conversationWidth, geometry.bodyHeight) ??
			Array.from({ length: geometry.bodyHeight }, (_, index) =>
				index === Math.floor(geometry.bodyHeight / 2) ? status : "",
			);
		const body = this.dashboardBody(width, geometry, conversation);
		if (screen === "find") body.unshift(this.find.render(width)[0] ?? "");
		return [
			this.title(),
			this.console ? status : "",
			...body,
			this.messageLabel(width, focused),
			...editor,
			this.console?.footer(width) ?? "",
			this.notice ?? this.console?.state.receipt ?? "",
			this.hintLine(width),
		];
	}
	render(width: number): string[] {
		const height = this.tui.terminal.rows;
		if (width < 60 || height < 20)
			return Array.from({ length: height }, (_, index) =>
				fitLine(index === 0 ? "Resize to use Agents. Esc back." : "", width),
			);
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
		this.console?.conversation.invalidate();
		this.console?.composer.invalidate();
		this.newComposer.invalidate();
		this.find.invalidate();
		this.threads?.invalidate();
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
		clearInterval(this.reconciliation);
		clearInterval(this.age);
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
