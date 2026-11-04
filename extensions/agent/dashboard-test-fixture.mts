import { before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type KeybindingsManager as AppKeys, type Theme } from "@earendil-works/pi-coding-agent";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import type { AgentConversationSummary, AgentDashboardCoverage, AgentPriorityPage } from "./dashboard-types.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import type { ConversationFrame } from "./live-frames.ts";
import { AgentDashboard, type DashboardOperations } from "./dashboard.ts";
import { createDashboardState, type DashboardState } from "./dashboard-state.ts";
import type { ActionResult, AgentFormHost } from "./agent-forms.ts";
const previousPreferences = process.env.PI_HARNESS_FILE;
let preferencesRoot: string | undefined;
before(() => {
	preferencesRoot = mkdtempSync(join(tmpdir(), "dashboard-preferences-"));
	process.env.PI_HARNESS_FILE = join(preferencesRoot, "absent.json");
});
after(() => {
	if (previousPreferences === undefined) delete process.env.PI_HARNESS_FILE;
	else process.env.PI_HARNESS_FILE = previousPreferences;
	if (preferencesRoot) rmSync(preferencesRoot, { recursive: true, force: true });
});
initTheme("dark");
export const keys = new KeybindingsManager(TUI_KEYBINDINGS) as AppKeys;
setKeybindings(keys);
export const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;
export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
export function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
export function conversationFrame(patch: Partial<ConversationFrame> = {}): ConversationFrame {
	return {
		scope: "conversation",
		storageId: "storage",
		conversationId: 1,
		revision: 1,
		observedAt: new Date(0).toISOString(),
		entries: [],
		live: [],
		nextBefore: null,
		coverage: {
			complete: true,
			entries: 0,
			bytes: 0,
			hiddenExcluded: 0,
			entryLimitReached: false,
			byteLimitReached: false,
		},
		status: {
			conversationId: 1 as ConversationFrame["status"]["conversationId"],
			identity: "one",
			busy: true,
			lastText: null,
			live: {},
			inbox: {},
			usage: undefined,
			tasks: [],
			submissions: [],
			agent: { model: { provider: "test", modelId: "model" }, thinkingLevel: "high", extensions: [], tools: [] },
		},
		...patch,
	};
}
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
export function coverage(rows: readonly AgentConversationSummary[] = [], patch: Partial<AgentDashboardCoverage> = {}): AgentDashboardCoverage {
	const storages = new Set(rows.map((row) => row.storageId));
	return { complete: true, storagesVisited: storages.size, skipped: 0, omitted: 0, nextCursor: null,
		inventory: { candidates: storages.size, inspected: storages.size, unreadable: 0, unknownClaims: 0, returned: storages.size, remaining: 0, priorityRemaining: 0,
			remainingRows: 0, priorityRemainingRows: 0, recordByteLimit: 32768, claimByteLimit: 16384, outputLimit: 320 },
		projections: Object.fromEntries([...storages].map((id) => [id, { skipped: 0, omitted: 0 }])), ...patch };
}
export function page(rows: readonly AgentConversationSummary[]): AgentPriorityPage {
	return {
		rows: rows.map((row) => ({ ...row, rosterOrder: row.rosterOrder ?? { priority: false, modifiedAt: row.modifiedAt } })),
		coverage: coverage(rows),
		observedAt: new Date(0).toISOString(),
	};
}
export function source(rows: readonly AgentConversationSummary[] = [row()]): AgentObservationSource {
	return {
		list: async () => page(rows),
		select() {},
		refresh() {},
		refreshTasks() {},
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
/** One recorded owner call from an agent form: the action name, its positional arguments and the captured target. */
export interface FormCall {
	readonly name: string;
	readonly args: readonly string[];
	readonly target: string;
}

/** A forms host that records every owner call and answers with `answer`. Nothing runs natively. */
export function formsHost(
	target: AgentConversationSummary,
	state: DashboardState,
	observed: AgentObservationSource,
	calls: FormCall[] = [],
	patch: Partial<AgentFormHost> = {},
	answer: (call: FormCall) => Promise<ActionResult> = async (call) => `${call.name} done`,
): AgentFormHost {
	const record = (name: string, args: readonly string[] = []) => {
		const call = { name, args: [...args], target: target.id };
		calls.push(call);
		return answer(call);
	};
	return {
		row: target,
		state,
		source: observed,
		run: (name, args) => record(name, args),
		timers: async () => [],
		schedule: async (input) => ({ text: String(await record("schedule", [input.message, input.deliverAt, input.mode])), sessionId: target.id }),
		models: async () => [{ identity: "test/model" }, { identity: "test/other", name: "Other" }],
		configure: (configured) => record("configure", [JSON.stringify(configured)]),
		commands: async () => [{ value: "plan", label: "plan", description: "Plan the work" }],
		profile: async (method, input) => record(method, [JSON.stringify(input)]),
		profileDrafts: new Map(),
		status: async () => ({ identity: target.id }),
		outcome: () => {},
		...patch,
	};
}

export function fixture(
	width = 80,
	height = 24,
	observed = source(),
	operations?: Partial<DashboardOperations>,
	retained?: DashboardState,
	paint: Theme = theme,
	caller?: string,
) {
	const calls: FormCall[] = [];
	let renders = 0;
	let closes = 0;
	const terminal = { rows: height, columns: width };
	const tui = {
		terminal,
		requestRender() {
			renders++;
		},
	} as unknown as TUI;
	const state = retained ?? createDashboardState();
	const ui = new AgentDashboard(
		tui,
		paint,
		keys,
		() => {
			closes++;
		},
		state,
		observed,
		{
			submit: async () => ({ text: "admitted" }),
			newAgent: async () => ({ text: "created" }),
			newDefaults: () => ({ cwd: "/work", presets: [{ value: "worker", label: "worker", description: "test/model \u00b7 high \u00b7 machine default" }], preset: "worker", ownership: "The new conversation owns its answer." }),
			forms: (target) => formsHost(target, state, observed, calls),
			...operations,
		},
		caller,
	);
	return {
		ui,
		tui,
		state,
		/** Owner calls the default forms host recorded. */
		calls,
		counts: () => ({ renders, closes }),
		resize(width: number, height: number) {
			terminal.columns = width;
			terminal.rows = height;
			ui.invalidate();
		},
	};
}
