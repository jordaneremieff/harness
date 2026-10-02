import { initTheme, type KeybindingsManager as AppKeys, type Theme } from "@earendil-works/pi-coding-agent";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import type { AgentConversationSummary, AgentConversationPage } from "./dashboard-types.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import { AgentDashboard, type DashboardOperations } from "./dashboard.ts";
import { createDashboardState } from "./dashboard-state.ts";
initTheme("dark");
export const keys = new KeybindingsManager(TUI_KEYBINDINGS) as AppKeys;
setKeybindings(keys);
export const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;
export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
export function row(id = "storage:1", patch: Partial<AgentConversationSummary> = {}): AgentConversationSummary {
	return {
		id,
		storageId: "storage",
		name: id,
		cwd: "/work",
		modifiedAt: 0,
		owner: "here",
		state: "working",
		cost: 0.42,
		partial: false,
		model: { provider: "test", modelId: "model", thinkingLevel: "high" },
		...patch,
	};
}
export function page(rows: readonly AgentConversationSummary[]): AgentConversationPage {
	return {
		rows,
		coverage: { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null },
		observedAt: new Date(0).toISOString(),
	};
}
export function source(rows: readonly AgentConversationSummary[] = [row()]): AgentObservationSource {
	return {
		list: async () => page(rows),
		select() {},
		refresh() {},
		snapshot: async () => ({
			entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: "Check the task", timestamp: 0 }] }],
			partial: false,
			revision: "1",
			nextBefore: null,
		}),
		frame: () => undefined,
		earlier: async () => ({
			entries: [],
			partial: false,
			revision: "0",
			nextBefore: null,
			coverage: {
				complete: true,
				entries: 0,
				bytes: 0,
				hiddenExcluded: 0,
				entryLimitReached: false,
				byteLimitReached: false,
			},
		}),
		tasks: async () => ({
			scope: "tasks",
			storageId: "storage",
			revision: 1,
			observedAt: new Date(0).toISOString(),
			tasks: [],
			labels: [],
			coverage: { complete: true, live: true },
		}),
		releaseTasks() {},
		availability: () => undefined,
		subscribe: () => () => {},
		subscribeRoster: () => () => {},
	};
}
export function fixture(width = 80, height = 24, observed = source(), operations?: Partial<DashboardOperations>) {
	let renders = 0;
	let closes = 0;
	const tui = {
		terminal: { rows: height, columns: width },
		requestRender() {
			renders++;
		},
	} as unknown as TUI;
	const state = createDashboardState();
	const ui = new AgentDashboard(
		tui,
		theme,
		keys,
		() => {
			closes++;
		},
		state,
		observed,
		{
			submit: async () => ({ text: "admitted" }),
			newAgent: async () => ({ text: "created" }),
			chooseConversation: async () => undefined,
			action: async () => undefined,
			...operations,
		},
		{ hide() {}, show() {} },
	);
	return { ui, tui, state, counts: () => ({ renders, closes }) };
}
