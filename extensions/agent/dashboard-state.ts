import type { AgentConversationSummary } from "./dashboard-types.ts";

export type DashboardScreen =
	| "roster"
	| "message"
	| "console"
	| "new"
	| "find"
	| "actions"
	| "help"
	| "tasks"
	| "result";
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
	mode: "steer" | "followUp";
	history: string[];
	view: AgentReadingState;
	receipt?: string;
	pending?: { text: string; mode: "steer" | "followUp" };
}
export interface DashboardState {
	selected?: string;
	filter: string;
	newTask: string;
	agents: Map<string, AgentDraftState>;
}
export function createDashboardState(): DashboardState {
	return { filter: "", newTask: "", agents: new Map() };
}
export function agentState(state: DashboardState, id: string): AgentDraftState {
	let value = state.agents.get(id);
	if (!value) {
		value = {
			draft: "",
			mode: "steer",
			history: [],
			view: { follow: true, scroll: 0, expanded: false, showThinking: false },
		};
		state.agents.set(id, value);
	}
	return value;
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
		this.target = target;
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
export function dashboardSessionState(id: string): DashboardState {
	let state = sessions.get(id);
	if (!state) {
		state = createDashboardState();
		sessions.set(id, state);
	}
	return state;
}
