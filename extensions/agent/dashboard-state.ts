import type { ThreadsState } from "./thread-data.ts";

export interface AgentReadingState {
	follow: boolean;
	scroll: number;
	anchor?: { id: string; offset: number };
	before?: number;
	expanded: boolean;
	showThinking: boolean;
	toolExpanded: Map<string, boolean>;
}
export interface ScheduleDraft {
	message: string;
	time: string;
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
	/** The agent list is collapsed; the conversation takes the whole width. */
	listHidden?: boolean;
}
export interface DashboardState {
	layout: DashboardLayout;
	hideThinkingBlock?: boolean;
	selected?: string;
	exactTime: boolean;
	filter: string;
	newTask: string;
	agents: Map<string, AgentDraftState>;
	threads?: ThreadsState;
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
			view: { follow: true, scroll: 0, expanded: false, showThinking: !(state.hideThinkingBlock ?? false), toolExpanded: new Map() },
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
/** Active consoles release their state listener when selection changes or the work view closes. */
export function subscribeAgentState(state: AgentDraftState, listener: () => void): () => void {
	let listeners = draftListeners.get(state);
	if (!listeners) {
		listeners = new Set();
		draftListeners.set(state, listeners);
	}
	listeners.add(listener);
	return () => listeners.delete(listener);
}
/** Work view state per ordinary session; retained values contain no source handles. */
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
