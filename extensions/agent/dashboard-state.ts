import type { AgentConversationSummary } from "./dashboard-types.ts";
import type { CollaborationViewState } from "./collaboration-view.ts";

export type DashboardScreen =
	| "roster"
	| "message"
	| "console"
	| "new"
	| "find"
	| "actions"
	| "help"
	| "tasks"
	| "result"
	| "threads";
export interface AgentReadingState {
	follow: boolean;
	scroll: number;
	anchor?: { id: string; offset: number };
	before?: number;
	expanded: boolean;
	showThinking: boolean;
}
export interface ScheduleDraft {
	message: string;
	time: string;
	deadline?: string;
	mode: "steer" | "followUp";
}
export interface AgentDraftState {
	schedule?: ScheduleDraft;
	draft: string;
	draftRevision: number;
	mode: "steer" | "followUp";
	history: string[];
	view: AgentReadingState;
	receipt?: string;
	pending?: { text: string; mode: "steer" | "followUp"; revision: number };
}
export interface DashboardLayout {
	rosterRatio?: number;
	composerRows?: number;
}
export interface DashboardState {
	layout: DashboardLayout;
	selected?: string;
	exactTime: boolean;
	filter: string;
	newTask: string;
	agents: Map<string, AgentDraftState>;
	threads?: CollaborationViewState;
}
export function createDashboardState(): DashboardState {
	return { filter: "", newTask: "", agents: new Map(), exactTime: false, layout: {} };
}
export function agentState(state: DashboardState, id: string): AgentDraftState {
	let value = state.agents.get(id);
	if (!value) {
		value = {
			draft: "",
			draftRevision: 0,
			mode: "steer",
			history: [],
			view: { follow: true, scroll: 0, expanded: false, showThinking: false },
		};
		state.agents.set(id, value);
	}
	return value;
}
const draftListeners = new WeakMap<AgentDraftState, Set<() => void>>();
export function notifyAgentState(state: AgentDraftState): void {
	for (const listener of draftListeners.get(state) ?? []) listener();
}
export function updateDraft(state: AgentDraftState, text: string): void {
	if (state.draft === text) return;
	state.draft = text;
	state.draftRevision++;
	notifyAgentState(state);
}
/** Active consoles release their state listener when selection changes or the overlay closes. */
export function subscribeAgentState(state: AgentDraftState, listener: () => void): () => void {
	let listeners = draftListeners.get(state);
	if (!listeners) {
		listeners = new Set();
		draftListeners.set(state, listeners);
	}
	listeners.add(listener);
	return () => listeners.delete(listener);
}
/** Interaction state is local to the overlay; retained values contain no source handles. */
export class DashboardNavigation {
	screen: DashboardScreen = "roster";
	target?: string;
	generation = 0;
	private readonly back: Array<{ screen: DashboardScreen; target?: string }> = [];
	readonly state: DashboardState;
	constructor(state: DashboardState) {
		this.state = state;
	}
	enter(screen: DashboardScreen, target = this.state.selected): void {
		this.back.push({ screen: this.screen, target: this.target });
		this.screen = screen;
		this.target = screen === "find" ? undefined : target;
		this.generation++;
	}
	escape(): "close" | "back" {
		this.generation++;
		const previous = this.back.pop();
		if (previous) {
			this.screen = previous.screen;
			this.target = previous.target;
			return "back";
		}
		if (this.state.filter) {
			this.state.filter = "";
			return "back";
		}
		return "close";
	}
	roster(): void {
		this.back.length = 0;
		this.screen = "roster";
		this.target = undefined;
		this.generation++;
	}
	reconcile(rows: readonly AgentConversationSummary[]): void {
		if (rows.some((row) => row.id === this.state.selected)) return;
		this.state.selected = rows[0]?.id;
	}
}
const sessions = new Map<string, DashboardState>();
export function dashboardSessionState(id: string, load?: () => DashboardLayout): DashboardState {
	let state = sessions.get(id);
	if (!state) {
		state = createDashboardState();
		state.layout = { ...load?.() };
		sessions.set(id, state);
	}
	return state;
}
