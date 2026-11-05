import { readAgentPreferences, renderPreferenceStatus } from "./agent-preferences.ts";
import { isInputKind } from "./input-entry.ts";
import type { ExtensionContext, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	type KeybindingsManager,
	visibleWidth,
	matchesKey,
	type Component,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	type Action,
	ActionBar,
	type Choice,
	type Destination,
	Form,
	HitMap,
	NavigationFrame,
	type Notice,
	type OperatorView,
	plainLine,
	TextField,
	type ViewHost,
	type ViewTarget,
	ReaderView,
	wrap,
} from "../../operator-ui/index.ts";
import { DashboardResize } from "./dashboard-resize.ts";
import { mergeAgentCoverage, type AgentConversationPage, type AgentConversationSummary, type AgentConversationSnapshot } from "./dashboard-types.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import { AgentConsole } from "./agent-console.ts";
import { AgentTasksView } from "./agent-tasks.ts";
import { clamp, MAX_ROSTER_COLUMNS, MIN_COMPOSER_ROWS, MIN_ROSTER_COLUMNS, dashboardGeometry, dashboardRule, fitLine } from "./dashboard-layout.ts";
import { dashboardRecords, rosterLines, sessionAppearance, titleOf, needsAttention } from "./dashboard-roster.ts";
import { agentState, dashboardSessionState, updateDraft, notifyAgentState, type DashboardState, type DashboardLayout } from "./dashboard-state.ts";
import { agentDisplayName } from "./action-outcome.ts";
import type { TaskLabel, ConversationFrame } from "./live-frames.ts";
import { firstTaskEntry, cleanDashboardText } from "./dashboard-conversation.ts";
import { ConversationHistory } from "./conversation-view.ts";
import { ThreadsView } from "./threads-view.ts";
import { createThreadsState, type Collaborate } from "./thread-data.ts";
import type { EffortAwareness } from "./effort-awareness.ts";
import { EffortView } from "./effort-view.ts";
import { AgentBranchCache, type AgentBranchReader } from "./agent-git.ts";
import type { AgentModelInfo, DelegatedFigures } from "./agent-footer.ts";
import { DashboardRelations, relationIdentity, type ReadRelationLineage } from "./dashboard-relations.ts";
import { actionView, type ActionResult, type AgentFormHost } from "./agent-forms.ts";

export interface DashboardResult {
	text: string;
	receipt?: string;
	sessionId?: string;
}

/** What the New conversation form asks for. An empty purpose creates an idle conversation. */
export interface NewAgentInput {
	prompt?: string;
	preset?: string;
	cwd?: string;
	onCreated: (row: AgentConversationSummary) => void;
}

/** The defaults the New conversation form shows before anything starts. */
export interface NewAgentDefaults {
	readonly cwd: string;
	/** Configured presets with their resolved model and reasoning, the default first. */
	readonly presets: readonly Choice[];
	readonly preset?: string;
	/** Where the answer to the first message goes, in plain words. */
	readonly ownership: string;
}

export interface DashboardOperations {
	toolDisplay?: (name: string) => ToolRenderers | undefined;
	saveLayout?(layout: DashboardLayout): void;
	efforts?(): Promise<EffortAwareness>;
	messageEffort?(id: string, text: string): Promise<DashboardResult>;
	observeEffort?(id: string): Promise<string>;
	sessionFigures?(page: AgentConversationPage): Promise<string>;
	modelInfo?(provider: string, modelId: string): AgentModelInfo | undefined;
	branch?: AgentBranchReader;
	collaborate?: Collaborate;
	/** Exact targets retained by this session's successful task admissions. */
	taskTargets?(): readonly string[];
	readLineage?: ReadRelationLineage;
	submit(input: { id: string; text: string; mode: "steer" | "followUp" }): Promise<DashboardResult>;
	submissionFailure?(input: { id: string; text: string; mode: "steer" | "followUp" }, error: unknown): string;
	newAgent?(input: NewAgentInput): Promise<DashboardResult>;
	newDefaults?(): NewAgentDefaults;
	/** Why New is unavailable on this host, when it is. */
	readonly newUnavailable?: string;
	/** The forms host for one captured target. */
	forms(target: AgentConversationSummary): AgentFormHost;
	/** Owner views the target's live host advertises, bound to that target. */
	panels?(target: AgentConversationSummary): Promise<readonly Destination[]>;
	/** The selected conversation or its observed state changed; a host may read per-target display data. Reading never starts a host. */
	observed?(row: AgentConversationSummary | undefined): void;
	/** Composer text the host handles itself, such as the attached terminal's /agent routes. Returns true when handled. */
	command?(text: string): boolean | Promise<boolean>;
	/** Host-specific secondary actions for the selected conversation. */
	extraActions?(target: AgentConversationSummary): readonly Action[];
	/** The way out of this view: "Close" in ordinary Pi, "Detach" in the attached terminal. */
	readonly exitLabel?: string;
}

export type Region = "list" | "conversation" | "composer" | "controls" | "inspector" | "heading";
export type Surface = "work" | "threads" | "efforts";

const HELP = [
	"Agents",
	"The list starts with Related: this session's work. Related and All switch between it and every loaded agent.",
	"Relations use exact creation ancestry, task targets and shared thread membership, never directory proximity.",
	"Selecting an agent reads its conversation without starting its host. Sending a message starts a stopped host.",
	"",
	"Moving around",
	"Tab and Shift+Tab move between the list, the conversation, the message field, the agent's controls, the inspector and the heading's controls.",
	"Escape leaves the inspector, then the message field, then the view. It never stops work.",
	"Type over the list to find agents. Up and Down select. Enter writes to the selected agent.",
	"",
	"Messages",
	"Enter sends. Ctrl+J adds a new line. A working agent gets Steer at next step unless you choose Follow-up after answer:",
	"click the effect on the message field, or choose More › Send as follow-up.",
	"All letters, slash text and bang text are literal messages. Commands belong to the agent's controls.",
	"",
	"Reading",
	"PageUp and PageDown read the conversation; PageUp at the top reads earlier entries. End returns to live output.",
	"Ctrl+O expands tools. Ctrl+T shows or hides thinking. Click a card or a time to change it.",
	"",
	"Controls",
	"Stop, Configure and More act on the agent shown in the header. Forms open in the inspector beside the conversation.",
	"Every form binds to the agent it opened for; selecting another agent closes it without sending anything.",
	"Drag the list divider or the message field's grip to resize; double-click a handle to reset it.",
	"",
	"Threads and Related efforts",
	"Agents, Threads and Efforts are the tabs at the top left. Esc in Threads or Efforts returns to where you came from.",
	"Threads lists every thread, open ones first and newest first. Select one to read its exchange; the message field posts to it.",
	"Click a name in the exchange to reply to that message. Members ticks who your next post wakes and opens their conversations; Details shows the frame.",
	"A post wakes nobody unless you tick members. A closed thread takes no posts.",
	"Related efforts shows declared intent and contact declarations, not agreement. Enter opens a contact thread; o reads observation; m sends an operator message.",
	"A time shows the last recorded change, not an activity timer. Click a time to switch between age and date.",
	"",
	"Context tokens come from the latest assistant usage; compaction makes them unknown.",
];

/** Conversation rows kept on screen however far the message field grows. */
const CONVERSATION_ROWS = 4;

/** Roster fields that change when an agent's host starts, works, finishes, or stops. */
function rosterMark(row: AgentConversationSummary): string {
	return `${row.id}|${row.modifiedAt}|${row.state}|${row.cost}|${row.owner}|${JSON.stringify(row.awaiting)}`;
}

const projectOf = (row: AgentConversationSummary) => row.cwd.split("/").filter(Boolean).at(-1) ?? row.cwd;

/** The receipt for an admitted input when the owner names none. */
function admittedText(row: AgentConversationSummary, mode: "steer" | "followUp"): string {
	if (row.state !== "working") return `Admitted for ${agentDisplayName(row)}`;
	return mode === "steer" ? `Steer admitted for ${agentDisplayName(row)}` : `Follow-up admitted for ${agentDisplayName(row)}`;
}

/** An open inspector: forms, details or owner views for one captured target. */
interface Inspector {
	readonly frame: NavigationFrame;
	readonly target: string;
}

/** The agent work view. The root owns source handles and async generations; rendering performs no source reads. */
export class AgentDashboard implements Component, Focusable {
	private machinePreferences = renderPreferenceStatus(readAgentPreferences()).map(cleanDashboardText);
	private page?: AgentConversationPage;
	private rows: AgentConversationSummary[] = [];
	private console?: AgentConsole;
	private snapshot?: AgentConversationSnapshot & { nextBefore?: number | null };
	private readonly find: TextField;
	private threads?: ThreadsView;
	private efforts?: EffortView;
	private readonly hits = new HitMap();
	private readonly controls: ActionBar;
	/** The heading's own controls: New conversation, Threads, Efforts and Help. */
	private readonly headingBar: ActionBar;
	private readonly resize: DashboardResize;
	private inspector?: Inspector;
	private surface: Surface = "work";
	/** The surface Threads returns to: Related efforts when a contact thread opened from there. */
	private threadsFrom: Surface = "work";
	/** Leaving the work view returns here when a thread participant opened it. */
	private returnSurface?: Surface;
	private region: Region = "list";
	private notice?: Notice;
	private rosterScroll?: number;
	private rosterStart = 0;
	private rosterMaxStart = 0;
	private rosterNotice?: string;
	private rosterFailures = 0;
	private sessionFigures = "";
	private closed = false;
	private rosterPending = false;
	private rosterAgain = false;
	private sourceGeneration = 0;
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
	private expanded = false;
	/** An identity chosen explicitly (remembered, created or named by a command); a refresh never replaces it. */
	private pinned?: string;
	/** An action a command asked for, opened once its target is selected. */
	private pendingAction?: string;
	private readonly relations: DashboardRelations;
	private relationMark = "";
	private relationsDirty = true;
	private allAgents: boolean;
	/** The operator chose Related or All; the list no longer switches scope on its own. */
	private scopeChosen = false;
	private geometry = { listX: 0, listWidth: 0, listY: 0, listHeight: 0, paneX: 0, paneWidth: 0, conversationY: 0, conversationHeight: 0, conversationWidth: 0, composerY: 0, composerHeight: 0 };
	focused = true;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: () => void;
	readonly state: DashboardState;
	private readonly source: AgentObservationSource;
	private readonly operations: DashboardOperations;
	private readonly primaryId?: string;
	private readonly branches: AgentBranchCache;
	private branchChanges = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		done: () => void,
		state: DashboardState,
		source: AgentObservationSource,
		operations: DashboardOperations,
		primaryId?: string,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.state = state;
		this.source = source;
		this.operations = operations;
		this.primaryId = primaryId;
		this.allAgents = !primaryId;
		this.resize = new DashboardResize(state.layout, () => {
			try {
				this.operations.saveLayout?.({ ...this.state.layout });
			} catch {
				this.notice = { text: "Layout kept here; restart persistence failed", kind: "warning" };
			}
		});
		this.branches = new AgentBranchCache(operations.branch, () => this.redraw());
		this.relations = new DashboardRelations(operations.collaborate, () => {
			if (this.closed) return;
			this.reconcile();
			this.redraw();
		}, operations.readLineage);
		this.find = new TextField("Find", state.filter, (value) => this.setFilter(value));
		this.controls = new ActionBar((reason) => this.show(reason, "warning"));
		this.headingBar = new ActionBar((reason) => this.show(reason, "warning"));
		this.unsubscribe.push(
			source.subscribe(() => this.frameChanged()),
			source.subscribeRoster(() => {
				this.relations.invalidate();
				this.relationsDirty = true;
				this.queueRoster();
				if (this.surface === "threads") void this.threads?.refresh();
				if (this.surface === "efforts") void this.efforts?.refresh();
			}),
		);
		this.reconciliation = setInterval(() => void this.refreshRoster(), 2000);
		// The roster refresh never holds a process open on its own; the terminal or Pi does.
		this.reconciliation.unref?.();
		void this.refreshRoster();
	}

	private redraw(): void {
		if (!this.closed) this.tui.requestRender();
	}

	private show(text: string, kind: Notice["kind"] = "info"): void {
		this.notice = { text: plainLine(text), kind };
		this.redraw();
	}

	// --- roster ---------------------------------------------------------

	private queueRoster(): void {
		if (this.closed || this.rosterTimer) return;
		this.rosterTimer = setTimeout(() => {
			this.rosterTimer = undefined;
			void this.refreshRoster();
		}, 250);
	}

	private async refreshRoster(cursor?: string): Promise<void> {
		this.machinePreferences = renderPreferenceStatus(readAgentPreferences()).map(cleanDashboardText);
		if (this.closed) return;
		if (this.rosterPending) {
			this.rosterAgain = true;
			return;
		}
		this.rosterPending = true;
		try {
			const pages = await this.readRosterPages(cursor);
			if (this.closed) return;
			const previousRows = this.page?.rows;
			this.page = this.reuseRoster(pages.reduce((previous, page) => this.mergeRoster(previous, page)));
			const rows = this.page.rows;
			if (!previousRows || rows.length !== previousRows.length || rows.some((row, index) => row !== previousRows[index])) this.console?.conversation.refreshCards();
			this.loadMore = false;
			this.rosterFailures = 0;
			this.rosterNotice = undefined;
			this.refreshRelations();
			this.sessionFigures = (await this.operations.sessionFigures?.(this.page)) ?? "";
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

	private refreshRelations(): void {
		if (!this.primaryId || !this.page) return;
		const targets = this.operations.taskTargets?.() ?? [];
		this.relations.set(this.page.rows, this.primaryId, targets);
		const mark = JSON.stringify([this.page.rows.map((row) => [row.id, row.creatingOwnerId, row.awaiting?.results]), targets]);
		if (this.relationsDirty || mark !== this.relationMark) {
			this.relationsDirty = false;
			this.relationMark = mark;
			void this.relations.refresh();
		}
	}

	private rosterFailed(error: unknown): void {
		this.rosterFailures++;
		const hasRows = Boolean(this.page?.rows.length);
		const reason = error instanceof Error ? error.message : String(error);
		// The state leads, so a narrow list still shows it; the reason follows.
		this.rosterNotice = !hasRows ? `Agents unavailable: ${reason}` : this.rosterFailures >= 3 ? "List kept; refresh failed" : undefined;
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
			coverage: mergeAgentCoverage(previous.coverage, page.coverage),
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

	/** Keep the visible order stable while the operator works; a refresh only updates rows in place. */
	private reconcileOrder(filtered: AgentConversationSummary[]): void {
		if (!this.rows.length || this.state.filter) {
			this.rows = filtered;
			return;
		}
		this.rows = this.rows
			.flatMap((row) => {
				const current = filtered.find((item) => item.id === row.id);
				return current ? [current] : row.id === this.state.selected ? [row] : [];
			})
			.concat(filtered.filter((row) => !this.rows.some((item) => item.id === row.id)));
	}

	/** A live selection's observed state replaces its published row. */
	private observeSelectedRow(): void {
		const previousId = this.state.selected;
		const frame = previousId ? this.source.frame(previousId) : undefined;
		if (previousId && frame && this.source.availability(previousId)?.state === "live" && this.page)
			this.page = { ...this.page, rows: this.page.rows.map((row) => (row.id === previousId ? this.observedRow(row, frame) : row)) };
	}

	/**
	 * A pinned identity wins; otherwise a missing selection takes the first listed agent. While Find
	 * has text, the selection follows it to the first match.
	 */
	private chooseSelection(): void {
		if (this.pinned) this.state.selected = this.pinned;
		else if (!this.state.selected || (!this.rows.some((row) => row.id === this.state.selected) && (!this.console || this.state.filter)))
			this.state.selected = this.rows[0]?.id;
	}

	/** Find text is the operator's choice: it unpins the selection and lists matches in their own order. */
	private setFilter(value: string): void {
		this.state.filter = value;
		this.rosterScroll = undefined;
		this.pinned = undefined;
		this.rows = [];
		this.reconcile();
	}

	private reconcile(): void {
		this.observeSelectedRow();
		const filtered = dashboardRecords(
			this.page ? { observedAt: Date.parse(this.page.observedAt), sessions: this.page.rows, coverage: this.page.coverage } : undefined,
			this.state.filter,
		);
		const related = this.relations.view();
		const identities = related.identities;
		// Related work leads when there is some; with none, the list shows every agent instead of an empty pane.
		if (!this.allAgents && !this.scopeChosen && this.page && !related.pending && !filtered.some((row) => identities.has(relationIdentity(row.id)))) this.allAgents = true;
		this.reconcileOrder(this.allAgents ? filtered : filtered.filter((row) => identities.has(relationIdentity(row.id))));
		this.chooseSelection();
		const id = this.state.selected;
		const console = this.console;
		const row = this.page?.rows.find((item) => item.id === id) ?? (id !== undefined && console?.row.id === id ? console.row : undefined) ?? this.pinnedRow(id);
		if (row && console?.row.id === row.id) {
			if (console.row.cwd !== row.cwd) this.branches.refresh(row.cwd, `cwd:${++this.branchChanges}`);
			console.row = row;
			this.operations.observed?.(row);
			this.rereadIfStale(row);
		} else if (row) this.select(row);
		else if (!id && this.console) this.clearSelection();
	}

	private clearSelection(): void {
		this.saveConsole();
		this.console?.dispose();
		this.console = undefined;
		this.closeInspector();
		this.source.select(undefined);
		this.sourceGeneration++;
		this.operations.observed?.(undefined);
	}

	/** A stopped host restarted by another action attaches again when its row changes. */
	private rereadIfStale(row: AgentConversationSummary): void {
		const mark = rosterMark(row);
		if (mark === this.selectedMark) return;
		this.selectedMark = mark;
		if (this.source.availability(row.id)?.state !== "unavailable") return;
		const generation = ++this.sourceGeneration;
		this.source.refresh(row.id);
		void this.readSelected(row, generation);
	}

	/** Selection reads passively: it never starts a host and never moves a draft between agents. */
	private select(row: AgentConversationSummary): void {
		if (this.inspector && this.inspector.target !== row.id && this.inspector.target !== "new") this.closeInspector();
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
			(text) => void this.submit(text),
			() => this.escapeComposer(),
			() => this.page?.rows ?? [],
		);
		this.console.conversation.setToolDisplay(this.operations.toolDisplay);
		this.snapshot = undefined;
		this.source.select(undefined);
		const generation = ++this.sourceGeneration;
		this.branches.refresh(row.cwd, `selection:${row.id}:${generation}`);
		this.operations.observed?.(row);
		const pending = this.pendingAction;
		if (pending) {
			this.pendingAction = undefined;
			queueMicrotask(() => {
				if (!this.closed && this.console?.row.id === row.id) this.openNamedAction(pending);
			});
		}
		queueMicrotask(() => {
			if (this.closed || generation !== this.sourceGeneration) return;
			this.source.select(row.id);
			void this.readSelected(row, generation);
			this.frameChanged();
		});
	}

	/** Replace the renderer lookup, for example when the attached host's owner cards loaded. */
	setToolDisplay(lookup: ((name: string) => ToolRenderers | undefined) | undefined): void {
		this.operations.toolDisplay = lookup;
		this.console?.conversation.setToolDisplay(lookup);
		this.redraw();
	}

	/** Select one conversation by identity, for example a remembered or newly created target. */
	selectIdentity(id: string, row?: AgentConversationSummary): void {
		this.pinned = id;
		this.state.selected = id;
		const known = this.page?.rows.find((item) => item.id === id) ?? row ?? this.pinnedRow(id);
		if (known && !this.rows.some((item) => item.id === id)) this.rows = [...this.rows, known];
		if (known) this.select(known);
		// The message field never keeps another agent as its recipient.
		else if (this.console && this.console.row.id !== id) this.clearSelection();
		this.region = this.console ? "composer" : "list";
		this.redraw();
	}

	/** A pinned identity outside the loaded list stays addressable with what is known about it. */
	private pinnedRow(id: string | undefined): AgentConversationSummary | undefined {
		if (!id || id !== this.pinned || !this.page) return undefined;
		return { id, storageId: id.split(":")[0] ?? id, cwd: "", modifiedAt: Date.now(), owner: "unknown", state: "unavailable", cost: Number.NaN, partial: true };
	}

	/**
	 * Open a named action, Tasks or owner views for the selected agent once it is selected. New,
	 * Help, Threads and Efforts need no selection.
	 */
	openNamedAction(name: string): void {
		if (name === "new") this.openNew();
		else if (name === "help") this.openHelp();
		else if (name === "threads") this.openThreads();
		else if (name === "efforts") this.openEfforts();
		else if (!this.console) this.pendingAction = name;
		else if (name === "tasks") this.openTasks();
		else if (name === "browse") void this.openBrowsers();
		else this.openAction(name);
	}

	/** Open one host-specific view in the inspector, bound to the selected agent. */
	openViewAction(title: string, open: (host: ViewHost) => OperatorView): void {
		if (this.console) this.openInspector([{ key: title, label: title, open }]);
		else this.show("Select an agent first", "warning");
	}

	/** The selected conversation as last observed. */
	get selectedRow(): AgentConversationSummary | undefined {
		return this.console?.row;
	}

	/** Where keys go now, the full-surface view shown, and the title of the open inspector view. */
	get focus(): { readonly region: Region; readonly surface: Surface; readonly inspector?: string } {
		const inspector = this.inspector?.frame.viewTitle;
		return { region: this.region, surface: this.surface, ...(inspector === undefined ? {} : { inspector }) };
	}

	/** Show a one-line notice in the target header. */
	notify(text: string, kind: Notice["kind"] = "info"): void {
		this.show(text, kind);
	}

	private async readSelected(row: AgentConversationSummary, generation: number): Promise<void> {
		try {
			const snapshot = await this.source.snapshot(row.id);
			if (this.closed || generation !== this.sourceGeneration || this.source.availability(row.id)?.state === "live") return;
			this.history.tail(snapshot, this.console?.state.view.anchor?.id);
			this.snapshot = { ...snapshot, entries: this.history.entries(this.console?.state.view.anchor?.id), nextBefore: this.history.earlier() };
			const console = this.console;
			if (!console) return;
			this.setConversation();
			if (console.state.view.before && !this.snapshot.entries.some((entry) => entry.id === console.state.view.anchor?.id)) void this.readHistory(console.state.view.before);
			console.status = snapshot.partial ? "Partial history" : "";
			console.warning = this.source.availability(row.id)?.state === "unavailable" ? "Not connected; stored messages shown" : undefined;
			console.observeUsage(snapshot.entries);
			this.branches.refresh(console.row.cwd, `${console.row.id}:${snapshot.entries.at(-1)?.id ?? "empty"}`);
			this.redraw();
		} catch (error) {
			if (generation === this.sourceGeneration && !this.closed && this.console && this.source.availability(row.id)?.state !== "live") {
				this.console.warning = `Conversation unavailable: ${String(error)}`;
				this.console.status = "";
				this.redraw();
			}
		}
	}

	private observedRow(row: AgentConversationSummary, frame: ConversationFrame): AgentConversationSummary {
		if (row.state === "starting" && !frame.entries.some((entry) => isInputKind(entry.kind))) return row;
		return {
			...row,
			owner: "here",
			awaiting: frame.status.awaiting,
			name: frame.status.name ?? row.name,
			firstMessage: frame.status.firstMessage ?? row.firstMessage,
			state: frame.status.busy
				? "working"
				: row.state === "starting" || row.state === "new" || row.state === "working" || row.state === "unavailable"
					? "idle"
					: row.state,
			model: frame.status.agent.model ? { ...frame.status.agent.model, thinkingLevel: frame.status.agent.thinkingLevel } : row.model,
		};
	}

	private updateObservedRow(console: AgentConsole, frame: ConversationFrame): void {
		if (this.source.availability(console.row.id)?.state !== "live") return;
		console.row = this.observedRow(console.row, frame);
		if (this.page) this.page = { ...this.page, rows: this.page.rows.map((row) => (row.id === console.row.id ? console.row : row)) };
		this.rows = this.rows.map((row) => (row.id === console.row.id ? console.row : row));
		this.operations.observed?.(console.row);
	}

	private frameChanged(): void {
		const console = this.console;
		if (!console || this.closed) return;
		const frame = this.source.frame(console.row.id);
		if (frame) {
			console.save();
			this.history.tail({ entries: frame.entries, partial: !frame.coverage.complete, revision: `r${frame.revision}`, nextBefore: frame.nextBefore }, console.state.view.anchor?.id);
			this.snapshot = { entries: this.history.entries(console.state.view.anchor?.id), revision: `r${frame.revision}`, partial: !frame.coverage.complete, nextBefore: this.history.earlier() };
			this.updateObservedRow(console, frame);
			this.setConversation(frame.live);
			const availability = this.source.availability(console.row.id);
			console.status = frame.coverage.complete ? "" : "Partial history";
			console.warning = availability?.state === "unavailable" ? "Connection lost; last observed messages shown. Reconnect starts the host." : undefined;
			console.observeUsage(frame.entries, availability?.state === "live" ? frame.status.usage : undefined);
			this.branches.refresh(console.row.cwd, `${console.row.id}:${frame.entries.at(-1)?.id ?? "empty"}`);
		}
		if (!frame && this.source.availability(console.row.id)?.state === "unavailable") console.warning = "Not connected; stored messages shown";
		const wait = Math.max(0, 50 - (Date.now() - this.lastStreamPaint));
		if (!this.streamTimer)
			this.streamTimer = setTimeout(() => {
				this.streamTimer = undefined;
				this.lastStreamPaint = Date.now();
				this.redraw();
			}, wait);
	}

	private saveConsole(): void {
		this.console?.save();
		if (this.console) this.console.state.view.before = this.history.upper(this.console.state.view.anchor?.id);
	}

	private setConversation(live: readonly import("./dashboard-types.ts").AgentConversationEntry[] = []): void {
		const console = this.console;
		const snapshot = this.snapshot;
		if (!console || !snapshot) return;
		const first = firstTaskEntry({ ...snapshot, partial: snapshot.partial || console.row.state === "starting" }, console.row);
		console.setContent(first ? [first, ...snapshot.entries] : snapshot.entries, this.history.newer() ? [] : live);
	}

	private async readHistory(before?: number): Promise<void> {
		const console = this.console;
		if (!console || this.earlierPending) return;
		const generation = this.sourceGeneration;
		console.save();
		this.earlierPending = true;
		console.status = before ? "Loading earlier messages…" : "Loading current messages…";
		this.redraw();
		try {
			const page = before ? await this.source.earlier(console.row.id, before) : await this.source.snapshot(console.row.id);
			if (this.closed || generation !== this.sourceGeneration) return;
			this.history.add(page, before, console.state.view.anchor?.id);
			this.snapshot = { ...page, entries: this.history.entries(console.state.view.anchor?.id), nextBefore: this.history.earlier() };
			this.setConversation(this.source.frame(console.row.id)?.live);
			console.conversation.reanchor();
			console.status = page.partial ? "Partial history" : "";
		} catch (error) {
			if (generation === this.sourceGeneration) {
				console.warning = `Conversation unavailable: ${String(error)}`;
				console.status = "";
			}
		} finally {
			this.earlierPending = false;
			this.redraw();
		}
	}

	private earlier(): void {
		const before = this.history.earlier();
		if (before) void this.readHistory(before);
	}

	// --- effects ----------------------------------------------------------

	/** Admit the draft to the captured target. A late answer never clears newer text. */
	private async submit(text: string): Promise<void> {
		const console = this.console;
		if (!console || console.state.pending || !text.trim()) return;
		if (await this.handledCommand(console, text)) return;
		const { row, state } = console;
		const mode = row.state === "working" ? state.mode : "followUp";
		const revision = state.draftRevision;
		state.pending = { text, mode, revision };
		state.receipt = "Sending…";
		this.redraw();
		try {
			const result = await Promise.resolve().then(() => this.operations.submit({ id: row.id, text, mode }));
			state.history.push(text);
			state.receipt = result.receipt ?? admittedText(row, mode);
			// A late answer clears only the draft revision it sent; newer text stays.
			if (state.draftRevision === revision && state.draft === text) {
				if (state.mode === mode) state.mode = "steer";
				updateDraft(state, "");
			}
			this.queueRoster();
		} catch (error) {
			state.receipt =
				this.operations.submissionFailure?.({ id: row.id, text, mode }, error) ??
				`Delivery not confirmed. Your draft is kept; check the conversation before resending. ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			state.pending = undefined;
			notifyAgentState(state);
			this.redraw();
		}
	}

	/** Composer text the host routes itself, such as the attached terminal's /agent commands. */
	private async handledCommand(console: AgentConsole, text: string): Promise<boolean> {
		if (!this.operations.command || !(await this.operations.command(text))) return false;
		if (console.state.draft === text) updateDraft(console.state, "");
		this.redraw();
		return true;
	}

	private toggleMode(): void {
		const console = this.console;
		if (console?.row.state !== "working") return;
		console.state.mode = console.state.mode === "steer" ? "followUp" : "steer";
		notifyAgentState(console.state);
		this.redraw();
	}

	// --- inspector --------------------------------------------------------

	private targetLabel(row: AgentConversationSummary): string {
		return `${plainLine(agentDisplayName(row))} · ${plainLine(projectOf(row))}`;
	}

	/** Open an inspector for the selected agent. Its views keep the target captured now. */
	private openInspector(destinations: readonly Destination[], initial?: string, target?: ViewTarget): void {
		const row = target ? undefined : this.console?.row;
		this.closeInspector();
		const frame = new NavigationFrame({
			theme: this.theme,
			target: target ?? (row ? { id: row.id, label: this.targetLabel(row) } : { id: "agents", label: "Agents" }),
			destinations: () => destinations,
			initial,
			rows: () => this.inspectorRows,
			requestRender: () => this.redraw(),
			close: (then) => {
				if (this.inspector?.frame === frame) this.inspector = undefined;
				// A late close, such as a finished request, leaves focus where the operator moved it.
				if (this.region === "inspector") this.region = this.console ? "composer" : "list";
				this.redraw();
				then?.();
			},
			closeLabel: target ? "Back" : "Back to conversation",
		});
		this.inspector = { frame, target: target?.id ?? row?.id ?? "" };
		this.region = "inspector";
		this.redraw();
	}

	private inspectorRows = 10;
	/** Column widths of the list and the conversation pane at the last paint, for resize feedback. */
	private resizeColumns = { list: 0, pane: 0 };
	private headerCache?: {
		row: AgentConversationSummary;
		name: string;
		project: string;
		identityWidth: number;
		room: number;
		status: string;
		left: string;
		stateLine: string;
	};

	private closeInspector(): void {
		const inspector = this.inspector;
		if (!inspector) return;
		this.inspector = undefined;
		inspector.frame.dispose();
		if (this.region === "inspector") this.region = this.console ? "composer" : "list";
	}

	private openAction(name: string): void {
		const row = this.console?.row;
		if (!row) {
			this.show("Select an agent first", "warning");
			return;
		}
		let frame: NavigationFrame | undefined;
		const host = this.formsFor(row, () => frame !== undefined && this.inspector?.frame === frame);
		this.openInspector([{ key: name, label: this.actionLabel(name), open: (view) => actionView(name, host, view) }]);
		frame = this.inspector?.frame;
	}

	/** The forms host for one captured target; `open` says whether the form that acts is still shown. */
	private formsFor(row: AgentConversationSummary, open: () => boolean): AgentFormHost {
		const host = this.operations.forms(row);
		const outcome = (result: ActionResult, name: string) => {
			host.outcome(result, name);
			this.actionOutcome(result, name, row.id, open());
		};
		return { ...host, outcome };
	}

	/**
	 * Record an action's result on its target. A created branch opens only while its form is still
	 * shown; after the operator leaves the form, the branch appears in the list and nothing moves.
	 */
	private actionOutcome(result: ActionResult, name: string, id: string, open: boolean): void {
		const value = typeof result === "object" ? result : undefined;
		const text = typeof result === "string" ? result : value?.text;
		if (text) {
			const state = agentState(this.state, id);
			state.receipt = plainLine(text);
			notifyAgentState(state);
		}
		const created = value?.sessionId;
		if (open && created && created !== id && (name === "fork" || name === "rewind")) {
			void this.refreshRoster().then(() => {
				if (!this.closed && this.state.selected === id) this.selectIdentity(created);
			});
		}
		this.queueRoster();
	}

	private actionLabel(name: string): string {
		const labels: Record<string, string> = {
			configure: "Configure", fork: "Fork", rewind: "Rewind", reset: "Reset context", compact: "Compact", command: "Run command",
			schedule: "Schedule message", timers: "Scheduled messages", profile: "Profile", status: "Details", abort: "Stop",
			release: "Release", attach: "Reconnect", "await-release": "Release await",
		};
		return labels[name] ?? name;
	}

	private openTasks(): void {
		const row = this.console?.row;
		if (!row) return;
		this.openInspector([{ key: "tasks", label: "Tasks", open: (view) => this.tasksView(row, view) }]);
	}

	private tasksView(row: AgentConversationSummary, view: ViewHost): OperatorView {
		const tasks = new AgentTasksView({
			theme: this.theme,
			source: this.source,
			id: row.id,
			onChooseConversations: (labels) => view.push((next) => this.chooseConversation(labels, next)),
			onNotice: (text) => view.notify(text, "info"),
			onSelectConversation: (identity, label) => this.openTaskConversation(identity, label),
		});
		const hits = new HitMap();
		return {
			title: "Tasks",
			render: (width, height) => {
				hits.begin(width, height);
				hits.add({ x: 0, y: 0, width, height, click: (event) => (tasks.clickRow(event.y) ? undefined : false), wheel: (delta) => tasks.scroll(delta) });
				return tasks.render(width, height);
			},
			handleInput: (data) => tasks.handleInput(data),
			handleMouse: (event) => hits.handle(event),
			actions: () => [
				{ id: "open", label: "Open conversation", primary: true, run: () => tasks.open() },
				{ id: "refresh", label: "Refresh", primary: true, run: () => void tasks.refresh() },
			],
			dispose: () => {
				tasks.dispose();
				this.source.releaseTasks();
			},
		};
	}

	private chooseConversation(labels: readonly TaskLabel[], view: ViewHost): OperatorView {
		return new Form({
			title: "Conversations",
			heading: "Choose the conversation to open",
			fields: [{ kind: "choice", id: "id", label: "Conversation", rows: 8, choices: labels.map((label) => ({ value: label.identity, label: plainLine(label.name || label.firstMessage || "Conversation"), description: label.identity })) }],
			action: { label: "Open" },
			host: view,
			submit: async (values) => {
				const label = labels.find((item) => item.identity === values.id);
				if (label) this.openTaskConversation(label.identity, label);
				return undefined;
			},
		});
	}

	private openTaskConversation(id: string, label?: TaskLabel): void {
		const published = this.page?.rows.find((item) => item.id === id);
		const parent = this.console?.row;
		const row: AgentConversationSummary | undefined =
			published ??
			(parent ? { ...parent, id, name: label?.name, firstMessage: label?.firstMessage, model: undefined, cost: Number.NaN, partial: true, state: "unavailable", error: undefined, health: undefined } : undefined);
		if (!row) return;
		this.closeInspector();
		this.selectIdentity(id, row);
	}

	private openHelp(): void {
		const view = (host: ViewHost) =>
			new ReaderView("Help", host, () => ["Machine execution preferences", ...this.machinePreferences, "", ...HELP].join("\n"));
		this.openInspector([{ key: "help", label: "Help", open: view }]);
	}

	private async openBrowsers(): Promise<void> {
		const row = this.console?.row;
		const panels = this.operations.panels;
		if (!row || !panels) return this.show("Owner views are unavailable here", "warning");
		this.show(`Reading the owner views of ${agentDisplayName(row)}…`, "pending");
		try {
			const destinations = await panels(row);
			if (this.closed || this.console?.row.id !== row.id) return;
			if (!destinations.length) return this.show("This agent's host advertises no owner views. A stored or stopped host shows none.", "warning");
			this.notice = undefined;
			this.openInspector(destinations);
		} catch (error) {
			this.show(`Owner views could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	private newDefaults(): NewAgentDefaults | undefined {
		try {
			return this.operations.newDefaults?.();
		} catch (error) {
			this.show(`New conversation defaults could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
	}

	private openNew(): void {
		const newAgent = this.operations.newAgent;
		if (!newAgent) {
			this.show(this.operations.newUnavailable ?? "New conversation is unavailable here", "warning");
			return;
		}
		const defaults = this.newDefaults();
		if (!defaults) return;
		this.closeInspector();
		const open = (view: ViewHost) =>
			new Form({
				title: "New conversation",
				heading: "Start a new conversation",
				intro: `${defaults.ownership} Closing this view later does not stop it.`,
				fields: [
					{ kind: "area", id: "prompt", label: "Purpose", value: this.state.newTask, rows: 5, hint: "The first message. Leave it empty to create an idle conversation." },
					...(defaults.presets.length ? [{ kind: "choice" as const, id: "preset", label: "Preset", value: defaults.preset, choices: defaults.presets, rows: Math.min(7, defaults.presets.length) }] : []),
					{ kind: "text", id: "cwd", label: "Directory", value: defaults.cwd },
				],
				action: { label: "Start" },
				host: view,
				change: (values) => {
					this.state.newTask = values.prompt ?? "";
				},
				submit: (values) => this.startAgent(newAgent, values),
			});
		this.openInspector([{ key: "new", label: "New conversation", open }], undefined, { id: "new", label: "New conversation" });
	}

	private async startAgent(newAgent: NonNullable<DashboardOperations["newAgent"]>, values: Readonly<Record<string, string>>) {
		const prompt = (values.prompt ?? "").trim() ? values.prompt : undefined;
		let created: string | undefined;
		const before = this.state.selected;
		const result = await newAgent({
			prompt,
			preset: values.preset || undefined,
			cwd: values.cwd || undefined,
			onCreated: (row) => {
				if (this.closed) return;
				created = row.id;
				this.allAgents = true;
				if (this.page) this.page = { ...this.page, rows: [...this.page.rows.filter((item) => item.id !== row.id), row] };
				this.rows = [...this.rows.filter((item) => item.id !== row.id), row];
				this.state.selected = row.id;
				this.select(row);
				this.snapshot = { entries: [], partial: false, revision: "starting", nextBefore: null };
				this.setConversation();
				if (this.console) this.console.status = "Starting…";
				this.redraw();
			},
		});
		this.state.newTask = "";
		const id = result.sessionId ?? created;
		if (!this.closed && id) {
			// The new conversation keeps the selection only while the operator has not chosen another.
			if (this.state.selected === (created ?? before)) this.state.selected = id;
			const state = agentState(this.state, id);
			state.receipt = plainLine(result.text);
			notifyAgentState(state);
			void this.refreshRoster();
		}
		return { close: true, notice: { text: result.text, kind: "success" as const } };
	}

	// --- full-surface views --------------------------------------------------

	private openEfforts(): void {
		if (!this.operations.efforts) {
			this.show("Related efforts need the ordinary Pi window.", "warning");
			return;
		}
		this.saveConsole();
		this.surface = "efforts";
		this.efforts ??= new EffortView({
			tui: this.tui,
			theme: this.theme,
			keys: this.keys,
			efforts: this.operations.efforts,
			messageEffort: this.operations.messageEffort,
			observeEffort: this.operations.observeEffort,
			collaborate: this.operations.collaborate,
			openContact: (threadId) => this.openThreads(threadId),
			openThreads: () => this.openThreads(),
			onBack: () => this.backToWork(),
			redraw: () => this.redraw(),
		});
		this.efforts.open();
		this.redraw();
	}

	private openThreads(contactThread?: string): string | undefined {
		if (!this.operations.collaborate) {
			this.show("Threads are unavailable here.", "warning");
			return "Threads are unavailable here.";
		}
		this.saveConsole();
		this.threadsFrom = this.surface === "efforts" ? "efforts" : "work";
		this.surface = "threads";
		this.state.threads ??= createThreadsState();
		this.threads ??= new ThreadsView({
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
			nameFor: (id) => {
				const row = this.page?.rows.find((item) => relationIdentity(item.id) === relationIdentity(id));
				return row ? agentDisplayName(row) : id;
			},
			openParticipant: (id) => this.openParticipant(id),
			redraw: () => this.redraw(),
			onExit: () => this.leaveThreads(),
		});
		this.threads.open(contactThread);
		this.redraw();
		return undefined;
	}

	private openParticipant(id: string): void {
		const row = this.page?.rows.find((item) => relationIdentity(item.id) === relationIdentity(id)) ?? {
			id, storageId: id.split(":")[0], name: id, cwd: "", modifiedAt: 0, owner: "unknown" as const, state: "unavailable" as const, cost: Number.NaN, partial: true,
		};
		this.returnSurface = "threads";
		this.surface = "work";
		this.selectIdentity(row.id, row);
	}

	/** Threads returns where it opened from: Related efforts keeps its selection and draft. */
	private leaveThreads(): void {
		const from = this.threadsFrom;
		this.threadsFrom = "work";
		if (from === "efforts" && this.efforts) {
			this.surface = "efforts";
			this.hits.clear();
			this.redraw();
		} else this.backToWork();
	}

	private backToWork(): void {
		this.returnSurface = undefined;
		this.surface = "work";
		this.hits.clear();
		this.reconcile();
		this.redraw();
	}

	// --- actions ------------------------------------------------------------

	/** The selected agent's controls. Stop and configuration stay visible while they apply. */
	private targetActions(): Action[] {
		const row = this.console?.row;
		if (!row) return [];
		const working = row.state === "working";
		const actions: Action[] = [];
		if (working) actions.push({ id: "abort", label: "Stop", primary: true, tone: "danger", description: "Stop current work; history stays", run: () => this.openAction("abort") });
		if (working) {
			const steer = this.console?.state.mode !== "followUp";
			actions.push({ id: "mode", label: steer ? "Send as follow-up" : "Send as steer", description: steer ? "The next message waits for the current answer" : "The next message applies at the next step", run: () => this.toggleMode() });
		}
		if (row.awaiting !== undefined) actions.push({ id: "await-release", label: "Release await", primary: true, description: "Return partial results; producers continue", run: () => this.openAction("await-release") });
		// Reconnect shows directly for an agent that needs attention, and stays in More while its observation is lost.
		const attention = needsAttention(row);
		if (attention || this.source.availability(row.id)?.state === "unavailable")
			actions.push({ id: "attach", label: "Reconnect", primary: attention, description: "Start the host; unfinished work resumes", run: () => this.openAction("attach") });
		actions.push({ id: "configure", label: "Configure", primary: true, disabled: working ? "Stop current work first; the owner configures idle agents only" : undefined, description: "Name, model and reasoning", run: () => this.openAction("configure") });
		actions.push({ id: "tasks", label: "Tasks", primary: true, description: "The live tasks in this agent's storage", run: () => this.openTasks() });
		if (this.operations.panels) actions.push({ id: "browsers", label: "Owner views", description: "Stashes, clipboard, policy and pillars bound to this agent", run: () => void this.openBrowsers() });
		const secondary: Array<[string, string, string]> = [
			["fork", "Fork", "An idle branch from a committed message"],
			["rewind", "Rewind", "A corrected branch before a mistake; files stay current"],
			["compact", "Compact", "Summarise at the next boundary while work continues"],
			["reset", "Reset context", "A new context; history and timers stay"],
			["schedule", "Schedule message", "Admit a message at a deadline"],
			["timers", "Scheduled messages", "Read or cancel scheduled messages"],
			["command", "Run command", "A native command with this agent's authority"],
			["profile", "Profile", "Identity, role, request routes and saved expertise"],
			["status", "Details", "Full identity, path, model and host state"],
			["release", "Stop and release host", "Stop this conversation and retire its host"],
		];
		for (const [id, label, description] of secondary) actions.push({ id, label, description, run: () => this.openAction(id) });
		actions.push(...(this.operations.extraActions?.(row) ?? []));
		return actions;
	}

	/** Actions available without a selection, in the heading. */
	private viewActions(): Action[] {
		const actions: Action[] = [
			{ id: "new", label: "New conversation", primary: true, disabled: this.operations.newAgent ? undefined : (this.operations.newUnavailable ?? "Unavailable here"), run: () => this.openNew() },
		];
		actions.push({ id: "help", label: "Help", primary: true, run: () => this.openHelp() });
		return actions;
	}

	// --- input ----------------------------------------------------------------

	private escapeComposer(): void {
		if (this.inspector) this.closeInspector();
		else this.region = "list";
		this.redraw();
	}

	private regions(): Region[] {
		const order: Region[] = [];
		if (!this.state.layout.listHidden || !this.console) order.push("list");
		if (this.console) order.push("conversation", "composer", "controls");
		if (this.inspector) order.push("inspector");
		order.push("heading");
		return order;
	}

	private traverse(backward: boolean): void {
		// The inspector takes Tab through its own fields and controls before focus moves on.
		if (this.region === "inspector" && this.inspector?.frame.focusNext(backward)) return;
		const order = this.regions();
		const index = order.indexOf(this.region);
		const next = order[(index + (backward ? order.length - 1 : 1)) % order.length] ?? "list";
		this.region = next;
		if (next === "controls") this.controls.focusEdge(backward);
		else if (next === "heading") this.headingBar.focusEdge(backward);
		else if (next === "inspector") this.inspector?.frame.focusEdge(backward);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		this.resize.beginInputGeometry(this.tui.terminal.columns, this.tui.terminal.rows, this.resizeKey());
		if (this.resize.input(data)) {
			// The resize handle consumed the key.
		} else if (this.surface === "threads") this.threads?.handleInput(data);
		else if (this.surface === "efforts") this.efforts?.handleInput(data);
		else {
			this.notice = this.notice?.kind === "pending" ? this.notice : undefined;
			const menu = this.openMenu();
			if (menu) menu.bar.handleInput(data, menu.actions);
			else this.routeKey(data);
		}
		this.redraw();
	}

	private currentActions(): Action[] {
		return this.console ? this.targetActions() : this.viewActions();
	}

	/** The open More menu of the heading or the target controls, with the actions it lists. */
	private openMenu(): { readonly bar: ActionBar; readonly actions: Action[] } | undefined {
		if (this.headingBar.menuShown) return { bar: this.headingBar, actions: this.viewActions() };
		if (this.controls.menuShown) return { bar: this.controls, actions: this.currentActions() };
		return undefined;
	}

	private routeKey(data: string): void {
		const tab = matchesKey(data, "tab") || matchesKey(data, "shift+tab");
		const completing = this.region === "composer" && (this.console?.composer.autocompleteRows ?? 0) > 0;
		if (tab && completing) this.console?.composer.handleInput(data);
		else if (tab) this.traverse(matchesKey(data, "shift+tab"));
		else if (this.region === "inspector" && this.inspector) this.inspector.frame.handleInput(data);
		else if (this.transcriptKeys(data)) {
			// Expansion, thinking and paging keys apply to the conversation from any region.
		} else if (this.region === "composer" && this.console) this.composerKey(data);
		else if (this.region === "controls") this.controlsKey(data);
		else if (this.region === "heading") this.headingKey(data);
		else if (this.region === "conversation") this.conversationKey(data);
		else this.listKey(data);
	}

	private headingKey(data: string): void {
		if (matchesKey(data, "escape")) this.region = this.console ? "composer" : "list";
		else this.headingBar.handleInput(data, this.viewActions());
	}

	private composerKey(data: string): void {
		if (matchesKey(data, "ctrl+v")) this.show("This field accepts text, not file or image attachments", "warning");
		else this.console?.composer.handleInput(data);
	}

	private controlsKey(data: string): void {
		if (matchesKey(data, "escape")) {
			this.region = this.console ? "composer" : "list";
			return;
		}
		this.controls.handleInput(data, this.currentActions());
	}

	private conversationKey(data: string): void {
		const conversation = this.console?.conversation;
		if (!conversation) return;
		if (matchesKey(data, "escape")) {
			this.region = "list";
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "down")) this.wheelConversation(matchesKey(data, "up") ? -1 : 1);
		else if (matchesKey(data, "end")) {
			const state = this.console?.state;
			if (state) {
				state.view.follow = true;
				state.view.anchor = undefined;
				conversation.invalidate();
			}
		} else if (matchesKey(data, "enter")) this.region = "composer";
	}

	private listKey(data: string): void {
		if (matchesKey(data, "escape")) this.listEscape();
		else if (matchesKey(data, "up") || matchesKey(data, "down")) this.move(matchesKey(data, "up") ? -1 : 1);
		else if (matchesKey(data, "enter")) this.listEnter();
		// Typing over the list writes into its visible Find field.
		else if (data.length >= 1 && !data.startsWith("\u001b")) this.find.handleInput(data);
	}

	/** Escape over the list clears an active search first, then returns to Threads or leaves the view. */
	private listEscape(): void {
		const back = this.returnSurface;
		if (!this.state.filter && back) {
			this.returnSurface = undefined;
			this.saveConsole();
			this.surface = back;
			this.hits.clear();
			return;
		}
		if (!this.state.filter) {
			this.exit();
			return;
		}
		this.find.value = "";
		this.setFilter("");
	}

	private listEnter(): void {
		if (this.loadMore) this.loadMoreAgents();
		else if (this.console) this.region = "composer";
		else if (this.emptyStore()) this.openNew();
	}

	private exit(): void {
		if (this.operations.exitLabel === "Detach") {
			this.show("Detach closes this terminal; it is the control at the top right.", "info");
			return;
		}
		this.dispose();
		this.done();
	}

	private transcriptKeys(data: string): boolean {
		const console = this.console;
		if (!console || this.region === "inspector") return false;
		if (this.keys.matches(data, "app.tools.expand") || matchesKey(data, "ctrl+o")) {
			console.state.view.expanded = !console.state.view.expanded;
			console.state.view.toolExpanded.clear();
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
		else if (!up && console.conversation.atBottom() && this.history.newer()) void this.readHistory(this.history.newer()?.upper);
		else console.conversation.page((up ? -1 : 1) * Math.max(1, this.bodyHeight - 1));
		return true;
	}

	private move(delta: number): void {
		this.rosterScroll = undefined;
		const index = this.rows.findIndex((row) => row.id === this.state.selected);
		const next = index + delta;
		if (this.loadMore && delta < 0) {
			this.loadMore = false;
			return;
		}
		if (next >= this.rows.length && this.page?.coverage.nextCursor) {
			this.loadMore = true;
			return;
		}
		this.loadMore = false;
		this.pinned = undefined;
		this.state.selected = this.rows[Math.max(0, Math.min(this.rows.length - 1, next))]?.id;
		this.reconcile();
	}

	private loadMoreAgents(): void {
		const cursor = this.page?.coverage.nextCursor ?? undefined;
		this.rosterNotice = "Loading more agents…";
		queueMicrotask(() => void this.refreshRoster(cursor));
	}

	private emptyStore(): boolean {
		return Boolean(this.page?.coverage.complete && !this.page.rows.length && !this.state.filter);
	}

	private wheelConversation(delta: number): void {
		const conversation = this.console?.conversation;
		if (!conversation) return;
		if (delta < 0 && conversation.atTop()) this.earlier();
		else if (delta > 0 && conversation.atBottom() && this.history.newer()) void this.readHistory(this.history.newer()?.upper);
		else conversation.page(delta);
		this.redraw();
	}

	private reloadContent(): void {
		this.setConversation(this.console ? this.source.frame(this.console.row.id)?.live : []);
		this.redraw();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		if (this.surface !== "work" && event.y === 0) {
			const result = this.hits.handle(event);
			if (result) this.redraw();
			return result;
		}
		if (this.surface === "threads") return this.threads?.handleMouse({ ...event, y: event.y - 1, height: event.height - 1 });
		if (this.surface === "efforts") return this.efforts?.handleMouse(event);
		// A pointer event drawn for another size acts on nothing and ends a resize at its committed layout.
		if (event.width !== this.tui.terminal.columns || event.height !== this.tui.terminal.rows) return this.resize.cancel() ? { handled: true, render: true } : undefined;
		this.resize.beginInputGeometry(this.tui.terminal.columns, this.tui.terminal.rows, this.resizeKey());
		return this.resize.handle(event) ?? this.hits.handle(event) ?? this.paneMouse(event);
	}

	/** Pointer events for the conversation and the composer, in their own coordinates. */
	private paneMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const g = this.geometry;
		const console = this.console;
		if (!console || event.x < g.paneX || event.x >= g.paneX + g.paneWidth) return undefined;
		if (event.y >= g.conversationY && event.y < g.conversationY + g.conversationHeight && event.x < g.paneX + g.conversationWidth) {
			if (event.type === "wheel") return undefined;
			const result = console.conversation.handleMouse({ ...event, x: event.x - g.paneX, y: event.y - g.conversationY, width: Math.max(1, g.conversationWidth - 1), height: g.conversationHeight });
			if (result) this.region = "conversation";
			return result;
		}
		if (event.y >= g.composerY && event.y < g.composerY + g.composerHeight) {
			const result = console.composer.handleMouse({ ...event, x: event.x - g.paneX, y: event.y - g.composerY, width: g.paneWidth, height: g.composerHeight });
			if (result) this.region = "composer";
			return result;
		}
		return undefined;
	}

	// --- render -------------------------------------------------------------

	private resizeKey(): string {
		return `${this.surface}:${this.inspector ? "inspector" : "work"}`;
	}

	render(width: number): string[] {
		const height = this.tui.terminal.rows;
		this.resize.begin(width, height, this.resizeKey());
		this.hits.begin(width, height);
		if (width < 60 || height < 16) return Array.from({ length: height }, (_, row) => fitLine(row === 0 ? "Make the window larger to use Agents (60×16). Esc leaves." : "", width));
		// Threads and Efforts sit under the same tabs as the agents; each owns the rows below them.
		if (this.surface === "efforts" && this.efforts) {
			const shape = dashboardGeometry(width, height, 0, false, 0, 4, this.state.layout);
			const lines = this.efforts.render(width, height, shape.rosterWidth);
			return [this.renderHeading(width), ...lines.slice(1)].map((line) => fitLine(line, width));
		}
		if (this.surface === "threads" && this.threads) {
			const shape = dashboardGeometry(width, height, 0, false, 0, 4, this.state.layout);
			return [this.renderHeading(width), ...this.threads.render(width, height - 1, shape.rosterWidth)].map((line) => fitLine(line, width));
		}
		const body = this.renderWork(width, height);
		this.resize.end();
		return body.map((line) => fitLine(line, width));
	}

	/** Agents, Threads and Efforts as tabs; the agents' own scope and list controls follow on their tab. */
	private renderTabs(): { line: string; x: number } {
		const theme = this.theme;
		const tabs: Array<{ surface: Surface; label: string; open(): void }> = [{ surface: "work", label: "Agents", open: () => this.backToWork() }];
		if (this.operations.collaborate) tabs.push({ surface: "threads", label: "Threads", open: () => void this.openThreads() });
		if (this.operations.efforts) tabs.push({ surface: "efforts", label: "Efforts", open: () => this.openEfforts() });
		let x = 0;
		let line = "";
		for (const tab of tabs) {
			const text = ` ${tab.label} `;
			const active = this.surface === tab.surface;
			line += active ? theme.bg("selectedBg", theme.bold(theme.fg("accent", text))) : theme.fg("muted", text);
			if (!active) this.hits.add({ x, y: 0, width: visibleWidth(text), height: 1, click: () => tab.open() });
			x += visibleWidth(text);
		}
		return { line: `${line}  `, x: x + 2 };
	}

	private renderHeading(width: number): string {
		const theme = this.theme;
		const tabs = this.renderTabs();
		let x = tabs.x;
		let line = tabs.line;
		if (this.surface !== "work") {
			const exit = ` ${this.operations.exitLabel ?? "Close"} `;
			this.hits.add({ x: width - visibleWidth(exit), y: 0, width: visibleWidth(exit), height: 1, click: () => this.exitControl() });
			return `${fitLine(line, Math.max(0, width - visibleWidth(exit)))}${theme.fg("accent", exit)}`;
		}
		if (this.state.layout.listHidden) {
			const show = " Show list ";
			line += theme.fg("muted", show);
			this.hits.add({ x, y: 0, width: visibleWidth(show), height: 1, click: () => this.toggleList() });
			x += visibleWidth(show);
		}
		// The tabs lead on the left; the session figures, the view's actions and the way out sit at the right.
		const actions = this.viewActions();
		const exit = ` ${this.operations.exitLabel ?? "Close"} `;
		const figures = width >= 100 && this.sessionFigures ? theme.fg("muted", ` ${plainLine(this.sessionFigures)} `) : "";
		const barRoom = Math.max(0, Math.min(ActionBar.measure(actions), width - x - visibleWidth(figures) - visibleWidth(exit) - 2));
		const barX = width - visibleWidth(exit) - barRoom - 1;
		const barHits = new HitMap();
		barHits.begin(width, 1);
		this.headingBar.focused = this.focused && this.region === "heading";
		const bar = this.headingBar.render(actions, barRoom, theme, barHits, 0);
		this.hits.include(barHits, barX, 0);
		const gap = Math.max(1, barX - x - visibleWidth(figures));
		this.hits.add({ x: width - visibleWidth(exit), y: 0, width: visibleWidth(exit), height: 1, click: () => this.exitControl() });
		return `${line}${" ".repeat(gap)}${figures}${fitLine(bar, barRoom)} ${theme.fg("accent", exit)}`;
	}

	/** Related and All, and the control that hides the list, ending at `xEnd` on the Find row. */
	private listScope(xEnd: number, y: number, room: number): { text: string; width: number } {
		const theme = this.theme;
		const parts: Array<{ text: string; active?: boolean; run(): void }> = [];
		if (this.primaryId)
			for (const [all, label] of [[false, "Related"], [true, "All"]] as const)
				parts.push({ text: ` ${label} `, active: this.allAgents === all, run: () => { this.allAgents = all; this.scopeChosen = true; this.rosterScroll = undefined; this.rows = []; this.reconcile(); } });
		if (this.console) parts.push({ text: " ‹ ", run: () => this.toggleList() });
		const total = parts.reduce((sum, part) => sum + visibleWidth(part.text), 0);
		if (total > room) return { text: "", width: 0 };
		let x = xEnd - total;
		let text = "";
		for (const part of parts) {
			const w = visibleWidth(part.text);
			this.hits.add({ x, y, width: w, height: 1, click: () => part.run() });
			text += part.active ? theme.bg("selectedBg", theme.bold(part.text)) : theme.fg("muted", part.text);
			x += w;
		}
		return { text, width: total };
	}

	private exitControl(): void {
		if (this.operations.exitLabel === "Detach") {
			this.dispose();
			this.done();
			return;
		}
		this.exit();
	}

	private toggleList(): void {
		this.state.layout.listHidden = !this.state.layout.listHidden;
		if (this.state.layout.listHidden && this.region === "list" && this.console) this.region = "composer";
		try {
			this.operations.saveLayout?.({ ...this.state.layout });
		} catch {
			// The choice still applies to this view.
		}
		this.redraw();
	}

	private renderWork(width: number, height: number): string[] {
		const heading = this.renderHeading(width);
		const bodyHeight = height - 1;
		const wide = width >= 100;
		const showList = !this.state.layout.listHidden || !this.console;
		const shape = dashboardGeometry(width, height, 0, false, 0, 4, this.state.layout);
		const listWidth = showList && wide ? shape.rosterWidth : 0;
		this.resizeColumns = { list: listWidth, pane: width - listWidth - 1 };
		let body: string[];
		if (listWidth) body = this.renderSplit(width, bodyHeight, listWidth);
		else if (showList && bodyHeight >= 19 && !this.inspector) {
			// Two agents fit at 80x24; shorter narrow windows keep one before yielding the strip.
			const strip = this.renderList(width, bodyHeight >= 23 ? 8 : 5, 0, 1, true);
			body = [...strip, ...this.renderPane(0, 1 + strip.length, width, bodyHeight - strip.length)];
		} else body = this.renderPane(0, 1, width, bodyHeight);
		return [heading, ...body.slice(0, bodyHeight)];
	}

	/** The list beside the pane, with the divider that resizes them. */
	private renderSplit(width: number, bodyHeight: number, listWidth: number): string[] {
		const list = this.renderList(listWidth - 1, bodyHeight, 0, 1);
		const pane = this.renderPane(listWidth + 1, 1, width - listWidth - 1, bodyHeight);
		this.resize.add({ kind: "roster", x: listWidth - 1, y: 1, width: 2, height: bodyHeight, value: listWidth, min: MIN_ROSTER_COLUMNS, max: Math.min(MAX_ROSTER_COLUMNS, width - 1 - 60) });
		const active = this.resize.active("roster");
		const lit = active || this.resize.hover === "roster" || this.region === "list";
		const divider = this.theme.fg(lit ? "accent" : "borderMuted", active ? "┃" : "│");
		return pane.map((line, row) => fitLine(list[row] ?? "", listWidth) + divider + fitLine(line, width - listWidth - 1));
	}

	private renderList(width: number, height: number, x0: number, y0: number, compact = false): string[] {
		const theme = this.theme;
		this.find.focused = this.focused && this.region === "list";
		// A compact strip keeps its facts beside Find, so each other row lists an agent.
		const facts = compact ? this.listFacts() : undefined;
		const factsWidth = facts ? Math.min(Math.floor(width / 2), visibleWidth([facts.text, facts.more].filter(Boolean).join(" "))) : 0;
		const findArea = factsWidth ? width - factsWidth - 1 : width;
		const scope = this.listScope(x0 + findArea, y0, Math.max(0, findArea - 12));
		const findWidth = findArea - scope.width;
		const findLine = fitLine(this.find.render(findWidth, theme, 6, "type to find agents"), findWidth) + scope.text;
		this.hits.add({ x: x0, y: y0, width: findWidth, height: 1, click: (event) => ({ ...this.find.handleMouse(event, 6), ...this.focusRegion("list") }) });
		const rosterHeight = Math.max(1, height - (compact ? 1 : 2));
		const lines = rosterLines(this.rows, this.loadMore ? undefined : this.state.selected, width, rosterHeight, Date.now(), theme, compact, {
			primaryId: this.primaryId,
			start: this.rosterScroll,
			exactTime: this.state.exactTime,
			footer: this.rosterFailures >= 3 && this.rosterNotice ? { text: this.rosterNotice, color: "warning" } : undefined,
			range: (start, maxStart) => {
				this.rosterStart = start;
				this.rosterMaxStart = maxStart;
			},
			row: (row, line, count) => this.hits.add({ x: x0, y: y0 + 1 + line, width, height: count, click: () => this.pick(row.id) }),
			timestamp: (_row, line, x, timeWidth) => this.hits.add({ x: x0 + x, y: y0 + 1 + line, width: timeWidth, height: 1, click: () => { this.state.exactTime = !this.state.exactTime; } }),
		});
		this.hits.add({ x: x0, y: y0 + 1, width, height: rosterHeight, wheel: (delta) => { this.rosterScroll = Math.max(0, Math.min(this.rosterMaxStart, this.rosterStart + delta)); } });
		const empty = this.listEmpty();
		// An empty list explains itself in full, however narrow the list is.
		if (empty) lines.splice(0, lines.length, ...wrap(empty, width).slice(0, rosterHeight).map((line) => theme.fg("muted", line)));
		const body = Array.from({ length: rosterHeight }, (_, row) => lines[row] ?? "");
		if (compact) {
			const top = factsWidth ? `${fitLine(findLine, findWidth)} ${this.listFooter(factsWidth, x0 + findWidth + 1, y0)}` : findLine;
			return [top, ...body].map((line) => fitLine(line, width));
		}
		return [findLine, ...body, this.listFooter(width, x0, y0 + height - 1)].map((line) => fitLine(line, width));
	}

	private focusRegion(region: Region): TuiMouseEventResult {
		this.region = region;
		return { handled: true, focus: true };
	}

	private pick(id: string): undefined | false {
		if (!this.rows.some((row) => row.id === id)) return false;
		this.pinned = undefined;
		this.region = "list";
		this.state.selected = id;
		this.loadMore = false;
		this.reconcile();
		return undefined;
	}

	private listEmpty(): string | undefined {
		if (this.rows.length) return undefined;
		if (!this.page) return "Reading agents…";
		if (this.state.filter) return `No agent matches “${plainLine(this.state.filter)}”.`;
		if (!this.allAgents) return this.relations.view().pending ? "Reading related work…" : "No related agents yet. All shows every loaded agent.";
		return this.page.coverage.complete ? "No agents yet. New conversation starts one." : "The agent list is incomplete.";
	}

	/** The list's coverage facts and, when more agents exist, the Load more control. */
	private listFacts(): { readonly text: string; readonly tone: "warning" | "muted"; readonly more?: string } {
		if (this.rosterNotice && (!this.rows.length || this.rosterNotice.startsWith("Loading"))) return { text: plainLine(this.rosterNotice), tone: "warning" };
		const coverage = this.page?.coverage;
		// Storage coverage counts stay in Details; the list says only what the operator can act on.
		const text = !this.allAgents && this.relations.view().pending ? "reading related work…" : "";
		if (coverage?.nextCursor) return { text, tone: "muted", more: this.loadMore ? "› Load more" : "Load more" };
		return { text, tone: "muted" };
	}

	private listFooter(width: number, x0: number, y: number): string {
		const { text, tone, more } = this.listFacts();
		if (!more) return this.theme.fg(tone, text);
		const label = visibleWidth(more);
		this.hits.add({ x: x0 + Math.max(0, width - label), y, width: label, height: 1, click: () => { this.loadMore = true; this.loadMoreAgents(); } });
		return `${fitLine(this.theme.fg(tone, text), Math.max(0, width - label))}${this.theme.fg("accent", more)}`;
	}

	/** The target header, controls, conversation or inspector, and composer of the selected agent. */
	private renderPane(x0: number, y0: number, width: number, height: number): string[] {
		const console = this.console;
		if (!console) return this.renderNoSelection(x0, y0, width, height);
		// Header, a spacing row, the conversation, the message field, and under it the agent's status lines in
		// the main session's footer layout. A fact line with nothing known takes no row.
		const header = [...this.renderTargetHeader(console, x0, y0, width), ""];
		const status = console
			.statusLines(width - 1, this.modelInfo(console), this.branches.get(console.row.cwd), this.delegatedFigures())
			.filter((line) => visibleWidth(line) > 0)
			.map((line) => fitLine(` ${line}`, width));
		const composer = this.renderComposer(console, width, Math.max(3, height - header.length - status.length - 4));
		const middleHeight = Math.max(1, height - header.length - composer.length - status.length);
		const middleY = y0 + header.length;
		const middle = this.renderMiddle(console, x0, middleY, width, middleHeight);
		const composerY = middleY + middle.length;
		this.geometry = { ...this.geometry, paneX: x0, paneWidth: width, composerY, composerHeight: composer.length };
		this.composerHits(console, x0, composerY, width, composer.length);
		return [...header, ...middle, ...composer, ...status];
	}

	private modelInfo(console: AgentConsole): AgentModelInfo | undefined {
		const model = console.row.model;
		return model ? this.operations.modelInfo?.(model.provider, model.modelId) : undefined;
	}

	private renderNoSelection(x0: number, y0: number, width: number, height: number): string[] {
		const theme = this.theme;
		const lines = [
			theme.bold("No conversation selected"),
			"",
			this.rows.length ? "Select an agent in the list to read its conversation." : "No agent is shown yet.",
			this.operations.newAgent ? "New conversation starts one here." : (this.operations.newUnavailable ?? ""),
		];
		this.geometry = { ...this.geometry, paneX: x0, paneWidth: width, conversationY: y0, conversationHeight: 0, composerY: y0 + height, composerHeight: 0 };
		const menu = this.openMenu();
		if (menu) return this.renderMenu(menu, x0, y0, width, height);
		if (this.inspector) return this.renderInspector(x0, y0, width, height);
		return Array.from({ length: height }, (_, row) => fitLine(lines[row] ? ` ${lines[row]}` : "", width));
	}

	private renderTargetHeader(console: AgentConsole, x0: number, y0: number, width: number): string[] {
		const theme = this.theme;
		const row = console.row;
		const status = plainLine([
			this.resizeFeedback(),
			this.notice?.text,
			console.status,
			console.warning,
			needsAttention(row) ? "Details has the stored error" : "",
		].find((text) => Boolean(text)) ?? "");
		const previous = this.headerCache?.row === row ? this.headerCache : undefined;
		const name = previous?.name ?? theme.bold(theme.fg("text", plainLine(titleOf(row))));
		const project = previous?.project ?? theme.fg("muted", `  ${plainLine(projectOf(row))}`);
		const identityWidth = previous?.identityWidth ?? visibleWidth(` ${name}${project}`);
		const actions = this.targetActions();
		// Name and project keep their width first; controls that do not fit move into More, and the first
		// control with More always stays visible.
		const first = actions.find((action) => action.primary);
		const least = first ? ActionBar.measure([first, { ...first, id: "more", primary: false }]) : 0;
		const barWidth = Math.min(ActionBar.measure(actions), Math.max(least, width - identityWidth - 1));
		const room = Math.max(1, width - barWidth - 1);
		let left: string;
		let stateLine: string;
		if (previous?.room === room && previous.status === status) {
			left = previous.left;
			stateLine = previous.stateLine;
		} else {
			left = this.targetTitle(name, project, "", room);
			const appearance = sessionAppearance[row.state];
			const state = theme.fg(appearance.color, ` ${appearance.glyph} ${appearance.label}`);
			stateLine = fitLine(`${state}${status ? theme.fg("muted", `  ${status}`) : ""}`, width);
		}
		this.headerCache = { row, name, project, identityWidth, room, status, left, stateLine };
		this.controls.focused = this.focused && this.region === "controls";
		const barHits = new HitMap();
		barHits.begin(this.tui.terminal.columns, this.tui.terminal.rows);
		const bar = this.controls.render(actions, barWidth, theme, barHits, 0);
		this.hits.include(barHits, x0 + width - barWidth, y0);
		return [`${left} ${bar}`, stateLine];
	}

	/** Name, project and state in `room` columns: the project goes first, then the name shortens; the state stays. */
	private targetTitle(name: string, project: string, state: string, room: number): string {
		const full = ` ${name}${project}${state}`;
		if (visibleWidth(full) <= room) return fitLine(full, room);
		const short = ` ${name}${state}`;
		const stateWidth = visibleWidth(state);
		if (visibleWidth(short) <= room || room <= stateWidth + 4) return fitLine(short, room);
		return fitLine(` ${fitLine(name, room - stateWidth - 1)}${state}`, room);
	}

	/** Conversation, or the inspector beside or instead of it. */
	private renderMiddle(console: AgentConsole, x0: number, y0: number, width: number, height: number): string[] {
		const menu = this.openMenu();
		if (menu) return this.renderMenu(menu, x0, y0, width, height);
		const beside = this.inspector && width >= 120;
		const conversationWidth = this.inspector ? (beside ? Math.floor(width * 0.52) : 0) : width;
		if (!conversationWidth && this.inspector) {
			this.geometry = { ...this.geometry, conversationY: y0, conversationHeight: 0, conversationWidth: 0 };
			return this.renderInspector(x0, y0, width, height);
		}
		const conversation = this.renderConversation(console, x0, y0, conversationWidth, height);
		if (!beside) return conversation;
		const inspectorWidth = width - conversationWidth - 1;
		const inspector = this.renderInspector(x0 + conversationWidth + 1, y0, inspectorWidth, height);
		const divider = this.theme.fg(this.region === "inspector" ? "accent" : "borderMuted", "│");
		return conversation.map((line, row) => `${fitLine(line, conversationWidth)}${divider}${fitLine(inspector[row] ?? "", inspectorWidth)}`);
	}

	private renderMenu(menu: { readonly bar: ActionBar; readonly actions: Action[] }, x0: number, y0: number, width: number, height: number): string[] {
		const menuHits = new HitMap();
		menuHits.begin(this.tui.terminal.columns, this.tui.terminal.rows);
		const lines = menu.bar.renderMenu(menu.actions, width, height, this.theme, menuHits, 0);
		this.hits.include(menuHits, x0, y0);
		this.geometry = { ...this.geometry, conversationY: y0, conversationHeight: 0, conversationWidth: 0 };
		return Array.from({ length: height }, (_, row) => fitLine(lines[row] ?? "", width));
	}

	private renderInspector(x0: number, y0: number, width: number, height: number): string[] {
		const inspector = this.inspector;
		if (!inspector) return [];
		this.inspectorRows = height;
		inspector.frame.focused = this.focused && this.region === "inspector";
		const lines = inspector.frame.render(width);
		this.hits.add({
			x: x0,
			y: y0,
			width,
			height,
			click: (event) => {
				const result = inspector.frame.handleMouse({ ...event, x: event.x, y: event.y, width, height });
				this.region = "inspector";
				return result ?? { handled: true, focus: true };
			},
			wheel: (delta) => {
				inspector.frame.handleMouse({ type: "wheel", button: "none", x: 0, y: Math.floor(height / 2), screenX: x0, screenY: y0, width, height, shift: false, alt: false, ctrl: false, wheelDelta: delta });
			},
		});
		return lines;
	}

	private renderConversation(console: AgentConsole, x0: number, y0: number, width: number, height: number): string[] {
		const boundary = this.conversationBoundary(console, width);
		const boundaryRows = boundary ? 1 : 0;
		if (height <= boundaryRows) {
			this.geometry = { ...this.geometry, conversationY: y0 + boundaryRows, conversationHeight: 0, conversationWidth: width };
			return boundary ? [boundary] : [];
		}
		const bodyHeight = Math.max(1, height - boundaryRows);
		this.bodyHeight = bodyHeight;
		const lines = console.conversation.render(Math.max(1, width - 1), bodyHeight);
		const position = console.conversation.position();
		this.geometry = { ...this.geometry, conversationY: y0 + boundaryRows, conversationHeight: bodyHeight, conversationWidth: width };
		this.hits.add({ x: x0, y: y0 + boundaryRows, width, height: bodyHeight, wheel: (delta) => this.wheelConversation(delta) });
		if (boundaryRows) this.hits.add({ x: x0, y: y0, width, height: 1, click: () => { if (this.history.earlier()) this.earlier(); return undefined; } });
		const scrolled = position && position.total > bodyHeight;
		const thumb = scrolled ? Math.max(1, Math.round((bodyHeight * bodyHeight) / position.total)) : 0;
		const thumbTop = scrolled ? Math.round(((bodyHeight - thumb) * (position.first - 1)) / Math.max(1, position.total - bodyHeight)) : 0;
		const body = lines.map((line, row) => {
			if (!scrolled) return fitLine(line, width);
			const inThumb = row >= thumbTop && row < thumbTop + thumb;
			return fitLine(line, width - 1) + this.theme.fg(inThumb ? "scrollbarThumb" : "scrollbarTrack", inThumb ? "┃" : "│");
		});
		return boundary ? [boundary, ...body] : body;
	}

	private conversationBoundary(console: AgentConsole, width: number): string {
		const position = console.conversation.position();
		let label = "";
		if (position && !position.end) {
			label = position.first <= 1 && (this.history.earlier() || console.status === "Partial history") ? "Earlier history · PageUp or click to read" : `↓ ${position.estimated ? "about " : ""}${position.total - position.last} lines below · End follows live output`;
		} else if (this.history.newer()) label = "Newer messages available · PageDown reads them";
		return label ? dashboardRule(label, width, this.theme) : "";
	}

	/** A compact composer that grows with the draft, unless the operator resized or expanded it. */
	/**
	 * A compact message field that grows with the draft. A resized or expanded field grows only into
	 * the rows the conversation can spare, and a window too short for that shows no resize grip.
	 */
	private sizeComposer(console: AgentConsole, room: number): void {
		const composer = console.composer;
		const grow = room - (CONVERSATION_ROWS - 1);
		const requested = this.state.layout.composerRows;
		composer.limitRows(room);
		if (this.expanded) composer.setViewportRows(clamp(Math.floor(grow * 0.7), MIN_COMPOSER_ROWS, Math.max(MIN_COMPOSER_ROWS, room)));
		else if (requested !== undefined && grow >= MIN_COMPOSER_ROWS) composer.setViewportRows(clamp(requested, MIN_COMPOSER_ROWS, grow));
		else composer.setViewportRows();
		const grip = this.resize.active("composer") ? "active" : this.resize.hover === "composer" ? "hover" : "normal";
		composer.grip = grow >= MIN_COMPOSER_ROWS ? grip : undefined;
	}

	private renderComposer(console: AgentConsole, width: number, maxRows: number): string[] {
		const composer = console.composer;
		composer.focused = this.focused && this.region === "composer";
		this.sizeComposer(console, maxRows);
		const working = console.row.state === "working";
		// The delivery effect shows only while it is a choice; an idle agent just receives the message.
		const mode = working ? (console.state.mode === "steer" ? "Steer at next step ⇄" : "Follow-up after answer ⇄") : "";
		const receipt = console.state.pending ? "Sending…" : (console.state.receipt ?? "");
		const caption = `To ${plainLine(agentDisplayName(console.row))}`;
		const lines = composer.render(width, caption, mode, receipt, ["Send", this.expanded ? "Shrink" : "Expand"]);
		return lines.length > maxRows + 2 ? lines.slice(0, maxRows + 2) : lines;
	}

	private composerHits(console: AgentConsole, x0: number, y0: number, width: number, rows: number): void {
		if (!rows) return;
		const spans = console.composer.spans;
		const bottom = y0 + rows - 1;
		if (spans.mode && console.row.state === "working") this.hits.add({ x: x0 + spans.mode.x, y: y0, width: spans.mode.width, height: 1, click: () => this.toggleMode() });
		const [send, expand] = spans.controls;
		if (send) this.hits.add({ x: x0 + send.x, y: bottom, width: send.width, height: 1, click: () => void this.submit(console.composer.getText()) });
		if (expand) this.hits.add({ x: x0 + expand.x, y: bottom, width: expand.width, height: 1, click: () => { this.expanded = !this.expanded; } });
		if (console.composer.grip === undefined) return;
		const requested = this.state.layout.composerRows;
		const value = requested ?? Math.max(MIN_COMPOSER_ROWS, rows - 2);
		this.resize.add({ kind: "composer", x: x0 + width - 4, y: y0, width: 3, height: 1, value, min: MIN_COMPOSER_ROWS, max: Math.max(MIN_COMPOSER_ROWS, this.tui.terminal.rows - 12) });
	}

	/** The sizes a resize drag sets, shown while it lasts. */
	private resizeFeedback(): string | undefined {
		const selected = this.resize.selected;
		if (selected === "roster") return `List ${this.resizeColumns.list} · conversation ${this.resizeColumns.pane} columns · release to keep · esc restores`;
		if (selected === "composer") return `Message field ${this.state.layout.composerRows ?? "auto"} rows · release to keep · esc restores`;
		return undefined;
	}

	private delegatedFigures(): DelegatedFigures | undefined {
		const parent = this.console?.row.id;
		if (!parent || !this.page) return undefined;
		const children = this.page.rows.filter((row) => row.creatingOwnerId === parent);
		if (!children.length) return undefined;
		const incomplete = !this.page.coverage.complete || this.page.coverage.skipped > 0 || this.page.coverage.omitted > 0 || this.page.coverage.nextCursor !== null;
		return {
			active: children.filter((row) => row.state === "working" || row.state === "starting").length,
			total: children.length,
			incomplete,
			cost: children.every((row) => !row.partial && Number.isFinite(row.cost)) ? children.reduce((sum, row) => sum + row.cost, 0) : undefined,
		};
	}

	invalidate(): void {
		this.hits.clear();
		this.console?.conversation.invalidate();
		this.console?.composer.invalidate();
		this.find.input.invalidate();
		this.threads?.invalidate();
		this.efforts?.invalidate();
		this.inspector?.frame.invalidate();
	}

	dispose(): void {
		if (this.closed) return;
		this.resize.clear();
		this.saveConsole();
		this.closed = true;
		this.closeInspector();
		this.branches.dispose();
		this.relations.dispose();
		this.console?.dispose();
		this.sourceGeneration++;
		for (const off of this.unsubscribe) off();
		this.source.select(undefined);
		this.source.releaseTasks();
		this.threads?.dispose();
		this.efforts?.dispose();
		clearInterval(this.reconciliation);
		clearTimeout(this.rosterTimer);
		clearTimeout(this.streamTimer);
	}
}

/** Open the work view over the ordinary session. It is a temporary surface; closing returns to the session. */
export async function showAgentDashboard(input: {
	ctx: ExtensionContext;
	source: AgentObservationSource;
	operations: DashboardOperations;
	state?: DashboardState;
	select?: string;
	action?: string;
}): Promise<void> {
	const { ctx } = input;
	if (ctx.mode !== "tui") {
		const page = await input.source.list();
		ctx.ui.notify(`Agents need the interactive terminal. ${page.rows.length} loaded agents.`, "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, keys, done) => {
			const view = new AgentDashboard(tui, theme, keys, done, input.state ?? dashboardSessionState(ctx.sessionManager.getSessionId()), input.source, input.operations, ctx.sessionManager.getSessionId());
			if (input.select) view.selectIdentity(input.select);
			if (input.action) view.openNamedAction(input.action);
			return view;
		},
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } },
	);
}
