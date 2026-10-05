import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type RegisteredCommand,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, Editor, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { createAgentCommand, executeAgentAction } from "./command.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import registerAgentExtension from "./index.ts";
import { defined } from "./test-assertions.mts";
import { source, row, page as rosterPage, theme, keys, turn } from "./dashboard-test-fixture.mts";
import type { AgentDashboard } from "./dashboard.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import type { ActionDialogExtras } from "./action-dialogs.ts";
const noSource = {
	select() {},
	refresh() {},
	frame: () => undefined,
	earlier: async () => {
		throw new Error("not requested");
	},
	tasks: async () => {
		throw new Error("not requested");
	},
	releaseTasks() {},
	availability: () => undefined,
	subscribe: () => () => {},
	subscribeRoster: () => () => {},
} satisfies Omit<AgentObservationSource, "list" | "snapshot">;
const extras: ActionDialogExtras = { timers: async () => [], schedule: async () => ({ text: "scheduled" }) };
function registration() {
	let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
	registerAgentExtension({
		events: { emit() {}, on: () => () => {} },
		registerShortcut() {},
		registerTool() {},
		registerMessageRenderer() {}, registerToolRenderer() {},
		on() {},
		getThinkingLevel: () => "off",
		registerCommand(name: string, options: typeof command) {
			if (name === "agent") command = options;
			else assert.equal(name, "restart");
		},
	} as unknown as ExtensionAPI);
	return command;
}
function context() {
	const notices: Array<{ text: string; type: string }> = [];
	return {
		notices,
		ctx: {
			mode: "print",
			hasUI: false,
			ui: { notify: (text: string, type: string) => notices.push({ text, type }) },
		} as unknown as ExtensionCommandContext,
	};
}
const signal = new AbortController().signal;
function provider(command: ReturnType<typeof registration>) {
	return new CombinedAutocompleteProvider([{ name: "agent", ...command }], process.cwd());
}
async function suggest(native: CombinedAutocompleteProvider, line: string, col = line.length) {
	return native.getSuggestions([line], 0, col, { signal });
}

it("the dashboard gets its context window and session figures from the current primary context", async () => {
	const published = rosterPage([row("one")]);
	const observed = source(published.rows);
	let reads = 0;
	observed.list = async () => { reads++; return published; };
	observed.snapshot = async () => ({ entries: [{ id: "1", kind: "pi.assistant", model: [{ role: "assistant", api: "openai-responses", provider: "test", model: "model", content: [], timestamp: 0, stopReason: "stop", usage: { input: 160000, output: 3300, cacheRead: 0, cacheWrite: 0, totalTokens: 163300, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] }], partial: false, revision: "1" });
	const lookups: Array<[string, string]> = [];
	let dashboard: AgentDashboard | undefined;
	let finish = () => {};
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getSessionId: () => "current-primary" },
		modelRegistry: { find: (provider: string, id: string) => { lookups.push([provider, id]); return { name: "Example model", reasoning: true, contextWindow: 1000000 }; } },
		ui: { custom: async (factory: (tui: TUI, currentTheme: typeof theme, currentKeys: typeof keys, done: () => void) => AgentDashboard) => new Promise<void>((resolve) => {
			finish = resolve;
			dashboard = factory({ terminal: { rows: 45, columns: 160 }, requestRender() {} } as unknown as TUI, theme, keys, resolve);
		}), notify() {} },
	} as unknown as ExtensionCommandContext;
	const command = createAgentCommand([], observed, extras, undefined, async (primary, roster) => {
		assert.equal(primary, ctx);
		assert.deepEqual(roster, published);
		assert.equal(roster.coverage, published.coverage);
		assert.equal(primary.sessionManager.getSessionId(), "current-primary");
		return "agents: 1/1 active · ~$0.42";
	});
	const opened = command.openDashboard(ctx);
	try {
		await turn();
		assert.ok(dashboard);
		const text = stripVTControlCharacters(dashboard.render(160).join("\n"));
		assert.deepEqual(lookups, [["test", "model"]]);
		assert.equal(reads, 1);
		assert.match(text, /Example model \[high\].*16%.*163k\/1.0M/);
		assert.match(text, /Agents: 1\/1 active · ~\$0.42/);
	} finally { dashboard?.dispose(); finish(); await opened; }
});
it("the dashboard collaboration adapter carries its primary context and structured read", async () => {
	const calls: Array<{ input: Record<string, unknown>; ctx: unknown }> = [];
	const command = createAgentCommand([], source(), extras, async (input, ctx) => {
		calls.push({ input, ctx });
		return { items: [], sources: [], nextCursor: null, coverage: { complete: true, visited: 0, omitted: 0 } };
	});
	let dashboard: AgentDashboard | undefined;
	let finish = () => {};
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getSessionId: () => "thread-adapter" },
		ui: {
			custom: async (
				factory: (tui: TUI, currentTheme: typeof theme, currentKeys: typeof keys, done: () => void) => AgentDashboard,
			) =>
				new Promise<void>((resolve) => {
					finish = resolve;
					dashboard = factory(
						{ terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI,
						theme,
						keys,
						resolve,
					);
				}),
			notify() {},
		},
	} as unknown as ExtensionCommandContext;
	const opened = command.openDashboard(ctx);
	try {
		await turn();
		assert.ok(dashboard);
		dashboard.handleInput("t");
		await turn();
		assert.deepEqual(calls, [{ input: { action: "list" }, ctx }]);
		assert.match(stripVTControlCharacters(dashboard.render(80).join("\n")), /Agents > Threads/);
	} finally {
		dashboard?.dispose();
		finish();
		await opened;
	}
});

const rows: AgentConversationSummary[] = [
	{
		id: "stored-1",
		storageId: "storage",
		cwd: "/work/library",
		modifiedAt: 1,
		owner: "unknown",
		state: "new",
		cost: 0,
		partial: false,
	},
	{
		id: "open-2",
		storageId: "storage",
		name: "Review parser",
		cwd: "/work/parser",
		modifiedAt: 2,
		owner: "here",
		state: "idle",
		cost: 0,
		partial: false,
	},
	{
		id: "claimed-3",
		storageId: "storage",
		name: "Audit",
		cwd: "/work/audit",
		modifiedAt: 3,
		owner: "unavailable",
		ownerLabel: "another window",
		state: "unavailable",
		cost: 0,
		partial: false,
	},
];
it("dashboard New-agent task text is literal even when it is a help flag", async () => {
	for (const text of ["--help", "-h"]) {
		const admitted: string[][] = [];
		const rows = [row("one")];
		const command = createAgentCommand(
			[
				{
					name: "new",
					description: "Start",
					args: [{ name: "task", rest: true, optional: true }],
					run: async (args, _ctx, onCreated) => {
						admitted.push(args);
						const created = row("created", { firstMessage: args[0], state: "starting" });
						rows.push(created);
						onCreated?.(created);
						return { text: "Started", sessionId: "created" };
					},
				},
			],
			source(rows),
			extras,
		);
		let ui: AgentDashboard | undefined;
		let finish = () => {};
		const ctx = {
			mode: "tui",
			hasUI: true,
			sessionManager: { getSessionId: () => `literal-task-${text}` },
			ui: {
				custom: async (
					factory: (tui: TUI, currentTheme: typeof theme, currentKeys: typeof keys, done: () => void) => AgentDashboard,
				) =>
					new Promise<void>((resolve) => {
						finish = resolve;
						ui = factory(
							{ terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI,
							theme,
							keys,
							resolve,
						);
					}),
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const opened = command.openDashboard(ctx);
		await turn();
		assert.ok(ui);
		try {
			ui.handleInput("n");
			ui.handleInput(text);
			ui.handleInput("\r");
			await turn();
			assert.deepEqual(admitted, [[text]]);
			assert.equal(ui.state.newTask, "");
		} finally {
			ui.dispose();
			finish();
			await opened;
		}
	}
});
it("passes the dashboard creation callback through the native new action", async () => {
	const created: string[] = [];
	const result = await executeAgentAction(
		{
			name: "new",
			description: "New agent",
			args: [{ name: "task", rest: true }],
			run: async (args, _ctx, onCreated) => {
				assert.deepEqual(args, ["task"]);
				onCreated?.(rows[0]);
				return { text: "Started", sessionId: rows[0].id };
			},
		},
		["task"],
		context().ctx,
		(row) => created.push(row.id),
	);
	assert.deepEqual(created, [rows[0].id]);
	assert.deepEqual(result, { text: "Started", sessionId: rows[0].id });
});

const page = (items: readonly AgentConversationSummary[]) => ({
	rows: items,
	coverage: { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null },
	observedAt: new Date().toISOString(),
});
function completionFixture(sessions: () => Promise<readonly AgentConversationSummary[]> = async () => rows) {
	return createAgentCommand(
		[
			{
				name: "send",
				description: "Give a session its next task",
				args: [
					{ name: "session", complete: "session" },
					{ name: "message", rest: true },
				],
				run: async () => undefined,
			},
			{
				name: "steer",
				description: "Redirect work",
				args: [
					{ name: "session", complete: "session-control" },
					{ name: "message", rest: true },
				],
				run: async () => undefined,
			},
			{
				name: "abort",
				description: "Stop work",
				args: [{ name: "session", complete: "session-control" }],
				run: async () => undefined,
			},
			{
				name: "status",
				description: "Read owner status",
				args: [{ name: "session", complete: "session-control" }],
				run: async () => undefined,
			},
		],
		{
			...noSource,
			list: async () => page(await sessions()),
			snapshot: async () => {
				throw new Error("not requested");
			},
		},
		extras,
	);
}

describe("agent command discovery and help", () => {
	it("registers restart only as a top-level command without an exit listener at load", () => {
		const commands = new Map<string, unknown>();
		const listeners = process.listenerCount("exit");
		registerAgentExtension({
			events: { emit() {}, on: () => () => {} },
			registerShortcut() {},
			registerTool() {},
			registerMessageRenderer() {}, registerToolRenderer() {},
			on: () => () => {},
			registerCommand(name: string, command: unknown) {
				assert.equal(commands.has(name), false);
				commands.set(name, command);
			},
		} as unknown as ExtensionAPI);
		assert.deepEqual([...commands.keys()], ["agent", "restart"]);
		assert.equal(process.listenerCount("exit"), listeners);
	});
	it("uses a short slash description and lists real actions with outcome descriptions", async () => {
		const native = provider(registration());
		const slash = await suggest(native, "/agent");
		assert.equal(slash?.items.length, 1);
		assert.equal(slash.items[0].description, "Open the agent dashboard; add a space for a control action");
		assert.equal(native.applyCompletion(["/agent"], 0, 6, slash.items[0], slash.prefix).lines[0], "/agent ");
		const actions = await suggest(native, "/agent ");
		assert.ok(actions);
		assert.ok(actions.items.length > 0);
		assert.deepEqual(
			actions.items.map((item) => item.label),
			[
				"new",
				"list",
				"status",
				"send",
				"steer",
				"await-release",
				"abort",
				"attach",
				"fork",
				"compact",
				"inspect",
				"rewind",
				"configure",
				"profile",
				"command",
				"place",
				"places",
				"unbind",
				"reset",
				"schedule",
				"timers",
				"timer-cancel",
				"help",
			],
		);
		assert.ok(actions.items.every((item) => item.description && !item.description.includes(" | ")));
		assert.equal(actions.items.filter((item) => item.label === "list").length, 1);
		assert.ok(!actions.items.some((item) => item.label === "runs" || item.label === "detach"));
		const { ctx, notices } = context();
		for (const item of actions.items) {
			await registration().handler(`help ${item.label}`, ctx);
			const notice = defined(notices.at(-1));
			assert.ok(notice.text.startsWith(`/agent ${item.label}`));
			assert.ok(notice.text.includes(defined(item.description)));
		}
	});

	it("completes partial action names, intent words and help topics", async () => {
		const native = provider(registration());
		for (const [input, choice, expected] of [
			["/agent ne", "new", "/agent new "],
			["/agent abo", "abort", "/agent abort "],
			["/agent help rew", "rewind", "/agent help rewind"],
			["/agent mistaken", "rewind", "/agent rewind "],
			["/agent correction", "steer", "/agent steer "],
			["/agent help retained evidence", "inspect", "/agent help inspect"],
		]) {
			const result = defined(await suggest(native, input));
			const selected = result.items.find((item) => item.label === choice);
			assert.ok(selected, input);
			assert.equal(native.applyCompletion([input], 0, input.length, selected, result.prefix).lines[0], expected);
		}
	});

	it("answers help and incomplete or invalid input without a manager or model runtime", async (t) => {
		const runtime = t.mock.method(ModelRuntime, "create", async () => {
			throw new Error("runtime must stay unopened");
		});
		const command = registration();
		const { ctx, notices } = context();
		for (const input of ["help", "--help", "-h"]) {
			await command.handler(input, ctx);
			const notice = defined(notices.at(-1));
			assert.match(notice.text, /\/agent manages durable sessions/);
			assert.doesNotMatch(notice.text, /\|/);
		}
		for (const [input, expected] of [
			["send", /Missing session\.\n\/agent send <session> <message>/],
			["send abc", /Missing message/],
			["attach", /Missing session/],
			["fork", /Missing session/],
			["abort", /Missing session/],
			["rewind abc entry", /Missing correction/],
			["unbind", /Missing area/],
			["status one two", /Too many arguments/],
			["list unwanted", /Too many arguments/],
			["new --help", /\/agent new \[task\]/],
			["rewind -h", /Redo work from a mistaken entry/],
			["console", /Unknown action "console"/],
			["ls", /Unknown action "ls"/],
			["help console", /Unknown action "console"/],
			["help ls", /Unknown action "ls"/],
			["help missing", /Unknown action "missing"/],
			["missing", /Unknown action "missing"/],
		] as const) {
			await command.handler(input, ctx);
			assert.match(defined(notices.at(-1)).text, expected, input);
		}
		assert.equal(runtime.mock.callCount(), 0);
		assert.ok(notices.every((notice) => notice.type === "info"));
	});

	it("leaves prompts, messages, directory arguments and entry IDs as text, not invented choices", async () => {
		const complete = defined(registration().getArgumentCompletions);
		for (const text of ["new ", "new check errors", "place ", "place . check errors", "unbind "]) {
			assert.equal(await complete(text), null, text);
		}
	});

	it("searches multiword descriptions without metadata reads or action execution", async () => {
		const forbidden = async (): Promise<never> => {
			throw new Error("must not execute");
		};
		const command = createAgentCommand(
			[
				{
					name: "send",
					description: "Give a session its next task",
					args: [{ name: "message", rest: true }],
					run: forbidden,
				},
			],
			{ ...noSource, list: forbidden, snapshot: forbidden },
			extras,
		);
		const complete = defined(command.getArgumentCompletions);
		assert.equal(defined(await complete("next task"))[0].value, "send ");
		assert.equal(await complete("send next task"), null);
		assert.deepEqual(await complete("zzzzzz unknown"), []);
	});

	it("preserves text that contains help words and reports invocation errors", async () => {
		const calls: string[][] = [];
		const command = createAgentCommand(
			[
				{
					name: "new",
					description: "Start work",
					args: [{ name: "prompt", optional: true, rest: true }],
					run: async (args) => {
						calls.push(args);
						throw new Error("trust denied");
					},
				},
			],
			{
				...noSource,
				list: async () => page([]),
				snapshot: async () => {
					throw new Error("not requested");
				},
			},
			extras,
		);
		const { ctx, notices } = context();
		await command.handler("new help with --help output", ctx);
		assert.deepEqual(calls, [["help", "with", "--help", "output"]]);
		assert.deepEqual(notices, [{ text: "trust denied", type: "error" }]);
	});
});

describe("agent metadata completion", () => {
	it("searches names and directories but inserts the complete ID and preserves text after the cursor", async () => {
		const native = provider(completionFixture());
		const line = "/agent send parser keep this task";
		const col = "/agent send parser".length;
		const result = defined(await suggest(native, line, col));
		assert.equal(result.items[0].label, "Review parser");
		assert.match(defined(result.items[0].description), /Open session/);
		assert.equal(
			native.applyCompletion([line], 0, col, result.items[0], result.prefix).lines[0],
			"/agent send open-2  keep this task",
		);
		const stored = defined(await suggest(native, "/agent status library"));
		assert.match(stored.items[0].label, /Session in library/);
		assert.match(defined(stored.items[0].description), /Stored session/);
		assert.equal(stored.items[0].value, "status stored-1");
		assert.equal(defined(await suggest(native, "/agent send open-2")).items[0].value, "send open-2 ");
	});

	it("completes multiword names and tasks until an exact ID starts the free-text argument", async () => {
		const native = provider(completionFixture());
		for (const [input, expected] of [
			["/agent status Review par", "/agent status open-2"],
			["/agent send Review par", "/agent send open-2 "],
		]) {
			const result = defined(await suggest(native, input));
			assert.equal(native.applyCompletion([input], 0, input.length, result.items[0], result.prefix).lines[0], expected);
		}
		for (const input of ["/agent send open-2 ", "/agent send open-2 Review parser", "/agent status open-2 "]) {
			assert.equal(await suggest(native, input), null, input);
		}
	});

	it("labels claimed and discovery-only storages without claiming active work", async () => {
		const command = completionFixture();
		const complete = defined(command.getArgumentCompletions);
		const claimed = defined(await complete("status Audit"));
		assert.equal(claimed[0].value, "status claimed-3");
		assert.match(defined(claimed[0].description), /Unavailable; stored metadata/);
		assert.match(defined(claimed[0].description), /another window/);
		assert.doesNotMatch(defined(claimed[0].description), /Active work|Open session/);
		const stored = defined(await complete("status library"));
		assert.match(defined(stored[0].description), /Stored session/);
		assert.doesNotMatch(defined(stored[0].description), /Active work|Open session/);
	});

	it("keeps duplicate and unnamed choices distinct", async () => {
		const command = completionFixture(async () => [
			{ ...rows[0], name: "\x1b[31mReview\nparser\x1b[0m", id: "sameprefix-one" },
			{ ...rows[0], name: "Review parser", id: "sameprefix-two" },
			{ ...rows[0], id: "unnamed" },
		]);
		const result = defined(await defined(command.getArgumentCompletions)("status "));
		assert.equal(new Set(result.map((item) => item.label)).size, 3);
		assert.ok(result.some((item) => item.label.includes("sameprefix-one")));
		assert.ok(result.every((item) => !/[\x1b\n]/.test(item.label + item.description)));
	});

	it("completes handles and canonical identities and searches retained roles", async () => {
		const expert = { ...rows[0], name: "History", profile: { identity: rows[0].id, handle: "@history", role: "Review operator decisions", revision: "one", hasExpertise: true, updatedAt: 1 } };
		const command = completionFixture(async () => [expert]);
		const complete = defined(command.getArgumentCompletions);
		const choices = defined(await complete("status operator decisions"));
		assert.deepEqual(choices.map((item) => item.value).sort(), [`status ${expert.id}`, "status @history"].sort());
		assert.ok(choices.every((item) => item.label.includes("@history") && item.description?.includes(expert.profile.role)));
		assert.equal(await complete("send @history new question"), null);
	});

	it("returns no invented session choices for empty or unavailable metadata", async () => {
		assert.deepEqual(await defined(completionFixture(async () => []).getArgumentCompletions)("send "), []);
		assert.equal(
			await defined(
				completionFixture(async () => {
					throw new Error("store unavailable");
				}).getArgumentCompletions,
			)("send "),
			null,
		);
	});
});

describe("native agent command editor", () => {
	it("shows action descriptions at normal and narrow widths and uses Tab without dispatch", async () => {
		const identity = (text: string) => text;
		const editor = new Editor(
			{ requestRender() {}, terminal: { rows: 24 }, getShowHardwareCursor: () => false } as unknown as TUI,
			{
				borderColor: identity,
				selectList: {
					selectedPrefix: identity,
					selectedText: identity,
					description: identity,
					scrollInfo: identity,
					noMatch: identity,
				},
			},
		);
		let submitted = false;
		editor.onSubmit = () => {
			submitted = true;
		};
		editor.setAutocompleteProvider(provider(registration()));
		editor.handleInput("/");
		await new Promise<void>((resolve) => setImmediate(resolve));
		editor.handleInput("agent");
		await new Promise<void>((resolve) => setImmediate(resolve));
		editor.handleInput(" ");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(editor.isShowingAutocomplete(), true);
		for (const width of [48, 100]) {
			const lines = editor.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const screen = lines.map(stripVTControlCharacters).join("\n");
			assert.doesNotMatch(screen, /console/);
			assert.match(screen, /new/);
			assert.match(screen, width === 48 ? /Start a new/ : /Start a new Durable agent/);
		}
		editor.handleInput("\t");
		assert.equal(editor.getText(), "/agent new ");
		assert.equal(submitted, false);
		editor.handleInput("\x1b");
	});
});
