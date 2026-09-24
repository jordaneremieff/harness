import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, Editor, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { chooseDashboardAction, createAgentCommand, executeAgentAction, type AgentCommandAction, type AgentSessionSummary } from "./command.ts";
import type { DashboardTarget } from "./dashboard.ts";
import registerAgentExtension from "./index.ts";
import { defined } from "./test-assertions.mts";

function registration() {
	let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
	registerAgentExtension({ registerTool() {}, registerMessageRenderer() {}, on() {}, getThinkingLevel: () => "off", registerCommand(name: string, options: typeof command) {
		assert.equal(name, "agent"); command = options;
	} } as unknown as ExtensionAPI);
	return command;
}
function context() {
	const notices: Array<{ text: string; type: string }> = [];
	return { notices, ctx: { mode: "print", hasUI: false, ui: { notify: (text: string, type: string) => notices.push({ text, type }) } } as unknown as ExtensionCommandContext };
}
const signal = new AbortController().signal;
function provider(command: ReturnType<typeof registration>) { return new CombinedAutocompleteProvider([{ name: "agent", ...command }], process.cwd()); }
async function suggest(native: CombinedAutocompleteProvider, line: string, col = line.length) {
	return native.getSuggestions([line], 0, col, { signal });
}

const rows: AgentSessionSummary[] = [
	{ sessionId: "stored-1", cwd: "/work/library", modifiedAt: 1, live: false },
	{ sessionId: "open-2", name: "Review parser", cwd: "/work/parser", modifiedAt: 2, live: true, operation: null },
	{ sessionId: "detached-3", name: "Audit", cwd: "/work/audit", modifiedAt: 3, live: false, detachedRunId: "run-3" },
];
function completionFixture(sessions: () => Promise<AgentSessionSummary[]> = async () => rows) {
	return createAgentCommand([
		{ name: "send", description: "Give a session its next task", args: [{ name: "session", complete: "session" }, { name: "message", rest: true }], run: async () => undefined },
		{ name: "runs", description: "Read detached results", args: [{ name: "run", optional: true, complete: "run" }], run: async () => undefined },
		{ name: "steer", description: "Redirect work", args: [{ name: "session", complete: "session-control" }, { name: "message", rest: true }], run: async () => undefined },
		{ name: "abort", description: "Stop work", args: [{ name: "session", complete: "session-control" }], run: async () => undefined },
		{ name: "status", description: "Read owner status", args: [{ name: "session", complete: "session-control" }], run: async () => undefined },
	], { sessions, inspect: async () => { throw new Error("not requested"); }, runs: async () => [{ runId: "run-3", sessionId: "detached-3", prompt: "Audit dependencies", cwd: "/work/audit", state: "finished", startedAt: "2026-01-01", sessionsRoot: "/sessions", agentDir: "/agent", logFile: "/log", pid: 1, launchState: "started" }] });
}

describe("agent command discovery and help", () => {
	it("uses a short slash description and lists real actions with outcome descriptions", async () => {
		const native = provider(registration());
		const slash = await suggest(native, "/agent");
		assert.equal(slash?.items.length, 1);
		assert.equal(slash.items[0].description, "Manage durable sessions; add a space to choose an action");
		assert.equal(native.applyCompletion(["/agent"], 0, 6, slash.items[0], slash.prefix).lines[0], "/agent ");
		const actions = await suggest(native, "/agent ");
		assert.ok(actions);
		assert.ok(actions.items.length > 0);
		assert.deepEqual(actions.items.map((item) => item.label), ["new", "status", "send", "steer", "abort", "compact", "command", "list", "runs", "attach", "fork", "rewind", "detach", "place", "places", "unbind", "help"]);
		assert.ok(actions.items.every((item) => item.description && !item.description.includes(" | ")));
		assert.equal(actions.items.filter((item) => item.label === "list").length, 1);
		assert.ok(!actions.items.some((item) => item.label === "ls"));
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
			["/agent stop", "abort", "/agent abort "],
			["/agent help rew", "rewind", "/agent help rewind"],
			["/agent stop current", "abort", "/agent abort "],
			["/agent separate work", "new", "/agent new "],
			["/agent help stop current", "abort", "/agent help abort"],
		]) {
			const result = defined(await suggest(native, input));
			const selected = result.items.find((item) => item.label === choice);
			assert.ok(selected, input);
			assert.equal(native.applyCompletion([input], 0, input.length, selected, result.prefix).lines[0], expected);
		}
	});

	it("answers help and incomplete or invalid input without a manager or model runtime", async (t) => {
		const runtime = t.mock.method(ModelRuntime, "create", async () => { throw new Error("runtime must stay unopened"); });
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
			["detach abc", /Missing prompt/],
			["rewind abc entry", /Missing correction/],
			["unbind", /Missing dir/],
			["status one two", /Too many arguments/],
			["list unwanted", /Too many arguments/],
			["new --help", /\/agent new \[prompt\]/],
			["rewind -h", /Use an entry ID from agent_inspect/],
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
		for (const text of ["new ", "new check errors", "place ", "unbind "])  {
			assert.equal(await complete(text), null, text);
		}
	});

	it("searches multiword descriptions without metadata reads or action execution", async () => {
		const forbidden = async (): Promise<never> => { throw new Error("must not execute"); };
		const command = createAgentCommand([{ name: "send", description: "Give a session its next task", args: [{ name: "message", rest: true }], run: forbidden }], { sessions: forbidden, runs: forbidden, inspect: forbidden });
		const complete = defined(command.getArgumentCompletions);
		assert.equal(defined(await complete("next task"))[0].value, "send ");
		assert.equal(await complete("send next task"), null);
		assert.deepEqual(await complete("zzzzzz unknown"), []);
	});

	it("preserves text that contains help words and reports invocation errors", async () => {
		const calls: string[][] = [];
		const command = createAgentCommand([{ name: "new", description: "Start work", args: [{ name: "prompt", optional: true, rest: true }], run: async (args) => { calls.push(args); throw new Error("trust denied"); } }], { sessions: async () => [], runs: async () => [], inspect: async () => { throw new Error("not requested"); } });
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
		assert.equal(native.applyCompletion([line], 0, col, result.items[0], result.prefix).lines[0], "/agent send open-2  keep this task");
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
			["/agent runs Audit dep", "/agent runs run-3"],
		]) {
			const result = defined(await suggest(native, input));
			assert.equal(native.applyCompletion([input], 0, input.length, result.items[0], result.prefix).lines[0], expected);
		}
		for (const input of ["/agent send open-2 ", "/agent send open-2 Review parser", "/agent status open-2 ", "/agent runs run-3 "]) {
			assert.equal(await suggest(native, input), null, input);
		}
	});

	it("offers detached sessions for owner controls, but not new tasks", async () => {
		const command = completionFixture();
		const complete = defined(command.getArgumentCompletions);
		assert.ok(!defined(await complete("send ")).some((item) => item.value.includes("detached-3")));
		for (const action of ["steer", "abort", "status"]) {
			const controls = defined(await complete(`${action} Audit`));
			assert.equal(controls[0].value, `${action} detached-3${action === "steer" ? " " : ""}`);
			assert.match(defined(controls[0].description), /Detached run; owner control/);
		}
		const run = defined(await complete("runs dependencies"));
		assert.equal(run[0].value, "runs run-3");
		assert.match(run[0].label, /Audit dependencies/);
		assert.match(defined(run[0].description), /finished/);
	});

	it("keeps duplicate and unnamed choices distinct and removes terminal controls from metadata", async () => {
		const command = completionFixture(async () => [
			{ ...rows[0], name: "\x1b[31mReview\nparser\x1b[0m", sessionId: "sameprefix-one" },
			{ ...rows[0], name: "Review parser", sessionId: "sameprefix-two" },
			{ ...rows[0], sessionId: "unnamed" },
		]);
		const result = defined(await defined(command.getArgumentCompletions)("status "));
		assert.equal(new Set(result.map((item) => item.label)).size, 3);
		assert.ok(result.some((item) => item.label.includes("sameprefix-one")));
		assert.ok(result.every((item) => !/[\x1b\n]/.test(item.label + item.description)));
	});

	it("returns no invented session choices for empty or unavailable metadata", async () => {
		assert.deepEqual(await defined(completionFixture(async () => []).getArgumentCompletions)("send "), []);
		assert.equal(await defined(completionFixture(async () => { throw new Error("store unavailable"); }).getArgumentCompletions)("send "), null);
	});
});

describe("dashboard action dispatch", () => {
	const target: DashboardTarget = { kind: "session", session: rows[1] };
	function dialogs(choice: string | undefined, values: Array<string | undefined> = [], confirmed = true) {
		const prompts: string[] = []; const confirmations: string[] = [];
		const ctx = { ui: { select: async () => choice, input: async (title: string) => { prompts.push(title); return values.shift(); }, confirm: async (_title: string, text: string) => { confirmations.push(text); return confirmed; } } } as unknown as ExtensionCommandContext;
		return { ctx, prompts, confirmations };
	}
	it("uses the same validation for commands and dialogs and preserves free text", async () => {
		const calls: string[][] = [];
		const action: AgentCommandAction = { name: "send", description: "Send task", args: [{ name: "session", complete: "session" }, { name: "message", rest: true }], run: async (args) => { calls.push(args); return "queued, not delivered"; } };
		const d = dialogs("send: Send task", ["help with --help output"]);
		assert.equal(await chooseDashboardAction([action], target, d.ctx), "queued, not delivered");
		assert.deepEqual(calls, [["open-2", "help", "with", "--help", "output"]]);
		assert.equal(d.prompts.length, 1);
		assert.match(defined(await executeAgentAction(action, ["open-2"], d.ctx)), /Missing message/);
		assert.equal(calls.length, 1);
	});
	it("prefills only correctly typed session or run IDs and never a directory or task", async () => {
		const runTarget: DashboardTarget = { kind: "run", run: { runId: "native-run", sessionId: "old-session", currentSessionId: "native-session", prompt: "task", cwd: "/work", sessionsRoot: "/sessions", agentDir: "/agent", logFile: "/log", pid: 1, startedAt: "date", launchState: "started", state: "running" } };
		for (const [argument, selected, values, expected] of [
			[{ name: "session", complete: "session-control" }, runTarget, [], "native-session"],
			[{ name: "run", complete: "run" }, runTarget, [], "native-run"],
			[{ name: "run", complete: "run" }, target, ["typed-run"], "typed-run"],
			[{ name: "dir" }, target, ["typed-directory"], "typed-directory"],
			[{ name: "prompt", rest: true }, target, ["typed task"], "typed task"],
		] as const) {
			let received: string[] | undefined;
			const action: AgentCommandAction = { name: "action", description: "Do work", args: [argument], run: async (args) => { received = args; return "ok"; } };
			await chooseDashboardAction([action], selected, dialogs("action: Do work", [...values]).ctx);
			assert.equal(received?.join(" "), expected);
		}
	});
	it("keeps cancel and interrupt confirmation outside execution and propagates exact refusal", async () => {
		let calls = 0;
		const action: AgentCommandAction = { name: "abort", description: "Stop work", args: [{ name: "session", complete: "session-control" }], confirm: "Stop current work", run: async () => { calls++; throw new Error("exact owner refusal"); } };
		assert.equal(await chooseDashboardAction([action], target, dialogs(undefined).ctx), undefined);
		assert.equal(await chooseDashboardAction([action], undefined, dialogs("abort: Stop work", [undefined]).ctx), undefined);
		const cancelled = dialogs("abort: Stop work", [], false);
		assert.equal(await chooseDashboardAction([action], target, cancelled.ctx), undefined);
		assert.match(cancelled.confirmations[0], /open-2/); assert.equal(calls, 0);
		await assert.rejects(chooseDashboardAction([action], target, dialogs("abort: Stop work").ctx), /exact owner refusal/);
		assert.equal(calls, 1);
	});
	it("rejects blank required input and extra positional words before any dispatch", async () => {
		let calls = 0;
		const action: AgentCommandAction = { name: "place", description: "Use directory", args: [{ name: "dir" }], run: async () => { calls++; return "bad"; } };
		for (const value of ["", "two words"]) assert.match(defined(await chooseDashboardAction([action], target, dialogs("place: Use directory", [value]).ctx)), /requires one word/);
		assert.equal(calls, 0);
	});
});

describe("native agent command editor", () => {
	it("shows action descriptions at normal and narrow widths and uses Tab without dispatch", async () => {
		const identity = (text: string) => text;
		const editor = new Editor({ requestRender() {}, terminal: { rows: 24 }, getShowHardwareCursor: () => false } as unknown as TUI, {
			borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
		});
		let submitted = false;
		editor.onSubmit = () => { submitted = true; };
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
			assert.match(screen, width === 48 ? /Start separa/ : /Start separate work/);
		}
		editor.handleInput("\t");
		assert.equal(editor.getText(), "/agent new ");
		assert.equal(submitted, false);
		editor.handleInput("\x1b");
	});
});
