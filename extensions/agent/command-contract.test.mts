import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AgentManager } from "./manager.ts";
import { PlaceBook } from "./places.ts";
import { source, row, page, theme, keys, deferred } from "./dashboard-test-fixture.mts";
import type { AgentDashboard } from "./dashboard.ts";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

it("the production observation adapter forwards cancellation and releases late attachments", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-adapter-contract-"));
	const previous = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_SESSIONS_DIR = root;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
		else process.env.PI_AGENT_SESSIONS_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	const started = [deferred(), deferred()];
	const signals: AbortSignal[] = [];
	const released: string[] = [];
	t.mock.method(AgentManager.prototype, "dashboardPage", async () =>
		page([
			row("one", { storageId: "one", creatingOwnerId: "production-adapter-primary" }),
			row("two", { storageId: "two", creatingOwnerId: "production-adapter-primary" }),
		]),
	);
	t.mock.method(AgentManager.prototype, "collaborate", async () => ({
		items: [],
		nextCursor: null,
		coverage: { complete: true, visited: 0, omitted: 0 },
	}));
	t.mock.method(AgentManager.prototype, "subscribeRoster", () => () => {});
	t.mock.method(AgentManager.prototype, "snapshot", source().snapshot);
	t.mock.method(
		AgentManager.prototype,
		"observeLive",
		async (id: string, _scope: unknown, _listener: unknown, signal?: AbortSignal) => {
			assert.ok(signal);
			const index = signals.length;
			signals.push(signal);
			started[index]?.resolve();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return () => {
				released.push(id);
			};
		},
	);
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerFlag() {},
		registerTool() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		getThinkingLevel: () => "off",
		getSettings: () => ({}),
		registerCommand: (name: string, value: typeof command) => {
			if (name === "agent") command = value;
		},
	} as unknown as ExtensionAPI);
	let ui: AgentDashboard | undefined;
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getSessionId: () => "production-adapter-primary" },
		ui: {
			custom: async (
				factory: (tui: TUI, currentTheme: typeof theme, currentKeys: typeof keys, done: () => void) => AgentDashboard,
			) =>
				new Promise<void>((resolve) => {
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
	assert.ok(command);
	const opened = command.handler("", ctx);
	await started[0].promise;
	assert.ok(ui);
	ui.handleInput("\x1b[B");
	await started[1].promise;
	assert.equal(signals[0]?.aborted, true);
	ui.handleInput("\x1b");
	await opened;
	assert.equal(signals[1]?.aborted, true);
	assert.deepEqual(released, ["one", "two"]);
});
it("the registered /agent opens native reports locally and preserves read and command data in RPC", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-result-contract-"));
	const previous = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_SESSIONS_DIR = root;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
		else process.env.PI_AGENT_SESSIONS_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	const sessionId = "storage-123456789:conversation-456789";
	const text = `first line\n${"界".repeat(180)}EXACT_COMMAND_END\nlast line`;
	const status = { sessionId, state: "idle" };
	t.mock.method(AgentManager.prototype, "control", async (method: string) => {
		if (method === "timer-cancel") return { timerId: 7, outcome: "terminal", status: "fired" };
		if (method === "configure") return { outcome: "failed", error: "Model unavailable" };
		if (method === "attach") throw new Error("Host is busy");
		return { text };
	});
	t.mock.method(AgentManager.prototype, "status", async () => status);
	t.mock.method(AgentManager.prototype, "dashboardPage", async () => page([row(sessionId)]));
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerFlag() {},
		registerTool() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		sendMessage: () => assert.fail("a local command result does not enter chat"),
		getThinkingLevel: () => "off",
		getSettings: () => ({}),
		registerCommand: (name: string, value: typeof command) => {
			if (name === "agent") command = value;
		},
	} as unknown as ExtensionAPI);
	const notices: Array<[string, string]> = [];
	const ctx = {
		mode: "rpc",
		hasUI: true,
		cwd: root,
		sessionManager: { getSessionId: () => "command-result-primary", getSessionName: () => "Command source" },
		ui: { notify: (value: string, level: string) => notices.push([value, level]) },
	} as unknown as ExtensionCommandContext;
	assert.ok(command);
	await command.handler(`command ${sessionId} inspect`, ctx);
	assert.deepEqual(notices.pop(), [`Ran command inspect on “${sessionId}”: ${text}`, "info"]);
	await command.handler(`status ${sessionId}`, ctx);
	assert.deepEqual(notices.pop(), [JSON.stringify(status, null, 2), "info"]);
	await command.handler("", ctx);
	assert.deepEqual(notices.pop(), [
		"The agent dashboard requires an interactive terminal (1 agent loaded).",
		"warning",
	]);
	await command.handler(`configure ${sessionId} name Updated`, ctx);
	assert.deepEqual(notices.pop(), [`Configuration for “${sessionId}” did not apply: Model unavailable`, "error"]);
	await command.handler(`attach ${sessionId} fixture/model`, ctx);
	assert.deepEqual(notices.pop(), [`Configuration for “${sessionId}” did not apply: Host is busy`, "error"]);
	await command.handler(`timer-cancel ${sessionId} 7`, ctx);
	assert.deepEqual(notices.pop(), [
		`Timer #7 for “${sessionId}” already fired; no cancellation took effect.`,
		"warning",
	]);
	assert.deepEqual(notices, []);

	const mounted = deferred<Component>();
	const tuiContext = {
		...ctx,
		mode: "tui",
		ui: {
			...ctx.ui,
			custom: async (
				factory: (tui: TUI, currentTheme: typeof theme, currentKeys: typeof keys, done: () => void) => Component,
			) =>
				new Promise<void>((resolve) =>
					mounted.resolve(
						factory(
							{ terminal: { rows: 16, columns: 36 }, requestRender() {} } as unknown as TUI,
							theme,
							keys,
							resolve,
						),
					),
				),
		},
	} as unknown as ExtensionCommandContext;
	const opened = command.handler(`command ${sessionId} inspect`, tuiContext);
	const report = await mounted.promise;
	const top = report.render(36);
	assert.match(top.join("\n"), /\/agent command/u);
	assert.doesNotMatch(top.join("\n"), /EXACT_COMMAND_END/u);
	report.handleInput?.("\x1b[F");
	const end = report.render(36);
	assert.match(end.join("\n"), /EXACT_COMMAND_END/u);
	assert.match(end.join("\n"), /last line/u);
	assert.ok([...top, ...end].every((line) => visibleWidth(line) <= 36));
	report.handleInput?.("\x1b");
	await opened;
	assert.deepEqual(notices, []);
});
it("preserves optional command inputs and resolves directory commands at the primary cwd", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-command-contract-"));
	const beforeRoot = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_SESSIONS_DIR = root;
	const methods = {
		control: AgentManager.prototype.control,
		place: AgentManager.prototype.place,
		unbind: PlaceBook.prototype.unbind,
	};
	t.after(() => {
		Object.assign(AgentManager.prototype, { control: methods.control, place: methods.place });
		PlaceBook.prototype.unbind = methods.unbind;
		if (beforeRoot === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
		else process.env.PI_AGENT_SESSIONS_DIR = beforeRoot;
		rmSync(root, { recursive: true, force: true });
	});
	const calls: Array<{ method: string; input: unknown }> = [];
	AgentManager.prototype.control = async (method, input) => {
		calls.push({ method, input });
		if (method === "attach") return { recovery: "retained work resumes" };
		if (method === "fork") return { identity: "branch:1" };
		return {};
	};
	AgentManager.prototype.place = async (input) => {
		calls.push({ method: "place", input });
		return { sessionId: "placed:1", status: { name: "Placed" } };
	};
	PlaceBook.prototype.unbind = (area) => {
		calls.push({ method: "unbind", input: area });
		return undefined;
	};
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerFlag() {},
		registerTool() {},
		registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
			commands.set(name, command),
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		getThinkingLevel: () => "off",
		getSettings: () => ({}),
	} as unknown as ExtensionAPI);
	const notices: string[] = [];
	const ctx = {
		cwd: join(root, "work"),
		sessionManager: { getSessionId: () => "primary", getSessionName: () => "Primary" },
		ui: { notify: (text: string) => notices.push(text) },
	} as unknown as ExtensionCommandContext;
	const command = commands.get("agent");
	assert.ok(command);
	for (const input of [
		"compact target preserve exact source links",
		"attach target fixture/model",
		"fork target 7",
		"place ../project next task",
		"unbind ./bound",
	])
		await command.handler(input, ctx);
	assert.deepEqual(calls, [
		{ method: "compact", input: { sessionId: "target", instructions: "preserve exact source links" } },
		{ method: "attach", input: { sessionId: "target", model: "fixture/model" } },
		{ method: "fork", input: { sessionId: "target", entryId: "7" } },
		{ method: "place", input: { area: resolve(ctx.cwd, "../project"), prompt: "next task", origin: "operator" } },
		{ method: "unbind", input: resolve(ctx.cwd, "./bound") },
	]);
	assert.equal(notices.length, 5);
});
