import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Schema } from "@earendil-works/pi-schema";
import { registerRex } from "./index.ts";
import { toolDisplay } from "./display.ts";
import { RexCore, resultByteLimit, type RexResult } from "./core.ts";
import { createTabLabelProjector, type TabLabelProjector } from "./tab-label.ts";
import type { CliCall, CliResult, RexTransport } from "./transport.ts";

test("ordinary shutdown drains owned calls before reload replaces live-call state", async () => {
	const tools = new Map<string, ToolDefinition<Schema>>();
	const handlers = new Map<string, () => unknown>();
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool),
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	let signal: AbortSignal | undefined;
	let disposed = 0;
	let live: ((ownerId: string, callId: string) => boolean) | undefined;
	let activeAtAbort = false;
	let started!: () => void;
	const active = new Promise<void>((resolve) => { started = resolve; });
	let releaseDrain!: () => void;
	const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
	registerRex(pi, { createCore: (options) => ({
		dispose: () => { disposed++; },
		execute: async (_request, context) => new Promise<RexResult>((resolve) => {
			signal = context.signal;
			live = options.isCallActive;
			assert.equal(live?.(context.ownerId, context.callId), true);
			context.signal?.addEventListener("abort", () => {
				activeAtAbort = live?.(context.ownerId, context.callId) ?? false;
				void drain.then(() => resolve({ ok: false, outcome: "cancelled", error: "Observer cancelled.", effects: { state: "none" }, coverage: { bounded: true, note: "The terminal remains available." } }));
			}, { once: true });
			started();
		}),
	}) });
	assert.deepEqual([...tools.keys()], ["rex_environment", "rex_terminal", "rex_wait", "rex_native", "rex_owned", "rex_status"]);
	assert.ok([...tools.values()].every((tool) => tool.outputSchema));
	const ctx = { cwd: "/test", isIdle: () => false, sessionManager: { getSessionId: () => "ordinary-session", getEntries: () => [], getSessionFile: () => undefined } } as unknown as ExtensionToolContext;
	const tool = tools.get("rex_environment");
	assert.ok(tool);
	const pending = tool.execute("call", { op: "environment" }, undefined, undefined, ctx);
	await active;
	assert.equal(signal?.aborted, false);
	let shutdownSettled = false;
	const shutdown = Promise.resolve(handlers.get("session_shutdown")?.()).then(() => { shutdownSettled = true; });
	await Promise.resolve();
	assert.equal(shutdownSettled, false, "the awaited host shutdown hook must not finish before the old call drains");
	assert.equal(live?.("ordinary:ordinary-session", "call"), true);
	releaseDrain();
	await shutdown;
	const result = await pending;
	assert.equal(signal?.aborted, true);
	assert.equal(activeAtAbort, true, "abort does not remove a still-draining invocation");
	assert.equal(live?.("ordinary:ordinary-session", "call"), false, "finally releases live invocation identity");
	assert.equal(result.isError, true);
	assert.equal((result.structuredContent as unknown as RexResult).outcome, "cancelled");
	assert.deepEqual(result.details, { outcome: "cancelled", effects: "none" });
	assert.match(JSON.stringify(result.content), /terminal remains available/);
	assert.ok(disposed >= 1);
});

test("the final ordinary adapter bounds status composition into one canonical result", async () => {
	const tools = new Map<string, ToolDefinition<Schema>>();
	const handlers = new Map<string, () => unknown>();
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool), appendEntry: () => {},
	} as unknown as ExtensionAPI;
	const server = { endpoint: "unix:///test-rex", hostId: "host", instanceId: "instance", selection: "test" };
	const resource = { kind: "block" as const, sessionId: "session:00000000-0000-0000-0000-000000000001", blockId: "block:00000000-0000-0000-0000-000000000002" };
	let budget = 0;
	registerRex(pi, { createCore: (options) => ({ dispose: () => {}, execute: async () => {
		budget = resultByteLimit(options.maxOutputBytes ?? 32768);
		const result: RexResult = { ok: true, outcome: "snapshot", target: { server, source: "explicit", sessionId: resource.sessionId, blockId: resource.blockId }, data: { payload: "" }, records: [{ recordId: "record", server, resources: [resource] }], effects: { state: "none", note: "Reported status grants no permission." }, coverage: { bounded: true, note: "Source status qualification." } };
		(result.data as { payload: string }).payload = "x".repeat(budget - Buffer.byteLength(JSON.stringify(result), "utf8") - 64);
		assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= budget);
		return result;
	} }) });
	const ctx = { cwd: "/test", isIdle: () => false, sessionManager: { getSessionId: () => "status-session", getEntries: () => [], getSessionFile: () => undefined } } as unknown as ExtensionToolContext;
	try {
		const tool = tools.get("rex_status");
		assert.ok(tool);
		const result = await tool.execute("status-call", { op: "snapshot", target: { server: server.endpoint, session: resource.sessionId, block: resource.blockId } }, undefined, undefined, ctx);
		const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		const model = JSON.parse(text);
		assert.equal(model.data.omitted, true, "host activity added after core execution reaches the final semantic bound");
		assert.equal(model.coverage.dataOmitted, true);
		assert.match(model.coverage.note, /Source status qualification/);
		assert.match(model.coverage.note, /not permission, ownership or task acceptance/);
		assert.deepEqual(model.records, [{ recordId: "record", server, resources: [resource] }]);
		assert.deepEqual(model.effects, { state: "none", note: "Reported status grants no permission." });
		assert.deepEqual(model, result.structuredContent);
		assert.ok(Buffer.byteLength(text, "utf8") <= budget);
	} finally { await handlers.get("session_shutdown")?.(); }
});

test("ordinary owned observation preserves the shared request and canonical read-only evidence", async () => {
	const tools = new Map<string, ToolDefinition<Schema>>();
	const handlers = new Map<string, () => unknown>();
	let writes = 0;
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool), appendEntry: () => { writes++; },
	} as unknown as ExtensionAPI;
	const request = { op: "observe", recordId: "retained-call", maxBytes: 256 };
	const expected: RexResult = { ok: true, outcome: "observed", effects: { state: "none" }, coverage: { bounded: true }, data: { reports: [{ recordId: "retained-call", phase: "unknown", complete: true, observedAt: "2026-01-01T00:00:00.000Z", observations: [{ presence: "present", childState: "exited", process: { last_exit: { exit_code: 7 } }, capture: { content: "final output", start: 0, end: 12, total: 12 } }] }] } };
	registerRex(pi, { createCore: () => ({ dispose: () => {}, execute: async (received, call) => {
		assert.equal(received, request);
		assert.equal(call.ownerId, "ordinary:observation-session");
		assert.ok(call.budget);
		assert.equal(call.signal, call.budget.signal);
		return expected;
	} }) });
	const ctx = { cwd: "/test", isIdle: () => true, sessionManager: { getSessionId: () => "observation-session", getEntries: () => [], getSessionFile: () => undefined } } as unknown as ExtensionToolContext;
	try {
		const tool = tools.get("rex_owned");
		assert.ok(tool);
		const response = await tool.execute("observe", request, undefined, undefined, ctx);
		assert.equal(response.isError, false);
		const received = response.structuredContent as unknown as RexResult;
		assert.equal(received.coverage.deadline?.effectiveMs, 30000);
		assert.deepEqual({ ...received, coverage: expected.coverage }, expected);
		assert.equal(response.content.filter((part) => part.type === "text").map((part) => part.text).join(""), JSON.stringify(received));
		assert.equal(writes, 0);
	} finally { await handlers.get("session_shutdown")?.(); }
});

test("ordinary native verified reads leave ownership storage untouched", async () => {
	const tools = new Map<string, ToolDefinition<Schema>>();
	const handlers = new Map<string, () => unknown>();
	let writes = 0;
	const sessionManager = SessionManager.inMemory("/test");
	sessionManager.getSessionId = () => "native-read-session";
	sessionManager.getSessionFile = () => undefined;
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool), appendEntry: (customType: string, data: unknown) => { writes++; sessionManager.appendCustomEntry(customType, data); },
	} as unknown as ExtensionAPI;
	const cliReply = (value: unknown): CliResult => ({ outcome: "exited", exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "", bytes: 0, truncated: false, started: true });
	const padding = "x".repeat(40000);
	const transport: RexTransport = {
		dispose: () => {},
		run: async (args) => {
			if (args.includes("whoami")) return cliReply({ endpoint: "unix:///test-rex", host_id: "host", instance_id: "instance" });
			const index = args.indexOf("call");
			return index >= 0 && args[index + 1] === "block_creator.list" ? cliReply({ creators: [], padding }) : cliReply({});
		},
	};
	registerRex(pi, { createCore: (options) => new RexCore({ ...options, transport }) });
	const ctx = { cwd: "/test", isIdle: () => false, sessionManager } as unknown as ExtensionToolContext;
	try {
		const tool = tools.get("rex_native");
		assert.ok(tool);
		const read = await tool.execute("read-call", { op: "native", kind: "api", method: "block_creator.list", args: {} }, undefined, undefined, ctx);
		assert.equal(read.isError, false);
		const readText = read.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		assert.ok(Buffer.byteLength(readText, "utf8") > 32768, "the ordinary channel keeps a verified read above the previous capture default");
		const readModel = JSON.parse(readText) as RexResult;
		assert.equal(readModel.effects.state, "none");
		assert.equal((readModel.data as { value: { padding: string } }).value.padding.length, 40000);
		assert.deepEqual(read.structuredContent, readModel);
		assert.equal(writes, 0, "a verified read writes no ordinary ownership entry");
		const mutation = await tool.execute("mutate-call", { op: "native", kind: "api", method: "new.capability", args: {} }, undefined, undefined, ctx);
		assert.equal((mutation.structuredContent as unknown as RexResult).effects.state, "confirmed");
		assert.ok(writes > 0, "an unclassified native API call keeps effect admission");
	} finally { await handlers.get("session_shutdown")?.(); }
});

test("ordinary registration publishes only identical display references and cleans up requests on reload", async () => {
	type Publication = { version: number; tools: Array<Pick<ToolDefinition<Schema>, "name" | "renderCall" | "renderResult" | "renderShell">> };
	const tools = new Map<string, ToolDefinition<Schema>>();
	const handlers = new Map<string, () => unknown>();
	const events = createEventBus();
	const publications: Publication[] = [];
	events.on("harness:tool-display:publish", (value) => { publications.push(value as Publication); });
	const pi = { events, on: (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); }, registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool), appendEntry: () => {} } as unknown as ExtensionAPI;
	let executions = 0;
	const options = {
		createCore: () => { executions++; throw new Error("Display requests must not execute tools."); },
		createTabLabelProjector: () => ({ start: () => {}, refresh: () => {}, input: () => {}, idle: async () => {}, shutdown: async () => {} }),
	};
	registerRex(pi, options);
	try {
		assert.equal(publications.length, 1, "the factory publishes before session_start");
		const initial = publications[0];
		assert.ok(initial);
		assert.equal(initial.version, 1);
		assert.equal(initial.tools.length, tools.size);
		for (const display of initial.tools) {
			assert.deepEqual(Object.keys(display).sort(), ["name", "renderCall", "renderResult", "renderShell"]);
			const registered = tools.get(display.name);
			assert.ok(registered);
			assert.equal(typeof display.renderCall, "function");
			assert.equal(typeof display.renderResult, "function");
			assert.equal(display.renderCall, registered.renderCall);
			assert.equal(display.renderResult, registered.renderResult);
			assert.equal(display.renderShell, registered.renderShell);
			assert.equal(display.renderShell, "default");
		}
		for (const request of [undefined, null, [], {}, { version: 2 }, { version: "1" }]) events.emit("harness:tool-display:request", request);
		assert.equal(publications.length, 1);
		await handlers.get("session_start")?.();
		events.emit("harness:tool-display:request", { version: 1 });
		assert.equal(publications.length, 2);
		assert.equal(publications[1]?.tools[0]?.renderCall, initial.tools[0]?.renderCall);
		await handlers.get("session_shutdown")?.();
		events.emit("harness:tool-display:request", { version: 1 });
		assert.equal(publications.length, 2, "shutdown removes the old publication listener");
		tools.clear();
		registerRex(pi, options);
		assert.equal(publications.length, 3);
		events.emit("harness:tool-display:request", { version: 1 });
		assert.equal(publications.length, 4, "reload has one current request listener");
		// The pure display module owns one record set: reload republishes the same renderer references.
		assert.equal(publications[3]?.tools[0]?.renderCall, initial.tools[0]?.renderCall);
		assert.equal(publications[3]?.tools[0]?.renderCall, toolDisplay().tools[0]?.renderCall);
		assert.equal(publications[3]?.tools[0]?.renderCall, tools.values().next().value?.renderCall);
		assert.equal(executions, 0);
	} finally { await handlers.get("session_shutdown")?.(); }
});

test("ordinary registration wires tab labels without changing the tool surface", async () => {
	type Handler = (event?: unknown, ctx?: unknown) => unknown;
	const tools = new Map<string, ToolDefinition<Schema>>();
	const handlers = new Map<string, Handler>();
	const events: string[] = [];
	const projector = {
		start: () => { events.push("start"); },
		refresh: () => { events.push("refresh"); },
		input: () => { events.push("input"); },
		idle: async () => {},
		shutdown: async () => { events.push("shutdown"); },
	};
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool),
		appendEntry: () => {},
		getSessionName: () => undefined,
	} as unknown as ExtensionAPI;
	const keeper = {
		start: () => { events.push("keeper start"); },
		floated: (blocks: readonly string[]) => { events.push(`floated ${blocks.join(",")}`); },
		attention: () => { events.push("attention"); },
		idle: async () => {},
		shutdown: async () => { events.push("keeper shutdown"); },
	};
	registerRex(pi, { createTabLabelProjector: () => projector, createConversationKeeper: () => keeper });
	assert.deepEqual([...tools.keys()], ["rex_environment", "rex_terminal", "rex_wait", "rex_native", "rex_owned", "rex_status"]);
	assert.deepEqual([...handlers.keys()].sort(), ["agent_settled", "input", "session_info_changed", "session_shutdown", "session_start", "ui_prompt_start"]);
	const ctx = { mode: "tui" };
	await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	handlers.get("session_info_changed")?.({ type: "session_info_changed", name: "Named" }, ctx);
	handlers.get("input")?.({ type: "input", source: "rpc" }, ctx);
	handlers.get("input")?.({ type: "input", source: "interactive" }, ctx);
	handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);
	handlers.get("ui_prompt_start")?.({ type: "ui_prompt_start" }, ctx);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
	assert.deepEqual(events, ["start", "keeper start", "refresh", "input", "attention", "attention", "shutdown", "keeper shutdown"]);
});

test("a confirmed floating pane that rex_terminal creates is handed to the conversation keeper", async () => {
	type Handler = (event?: unknown, ctx?: unknown) => unknown;
	const tools = new Map<string, ToolDefinition<Schema>>();
	const handlers = new Map<string, Handler>();
	const floated: string[][] = [];
	const keeper = { start: () => {}, floated: (blocks: readonly string[]) => { floated.push([...blocks]); }, attention: () => {}, idle: async () => {}, shutdown: async () => {} };
	const projector = { start: () => {}, refresh: () => {}, input: () => {}, idle: async () => {}, shutdown: async () => {} };
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool),
		appendEntry: () => {},
		getSessionName: () => undefined,
	} as unknown as ExtensionAPI;
	const created = (blockId: string) => ({ ok: true, outcome: "created", data: {}, effects: { state: "confirmed", recordId: "call", resources: [{ kind: "block", sessionId: "session:test", windowId: "window:test", blockId }] }, coverage: { bounded: true } });
	registerRex(pi, {
		createTabLabelProjector: () => projector,
		createConversationKeeper: () => keeper,
		createCore: () => ({ dispose: () => {}, execute: async (request: { kind?: string }) => created(request.kind === "float" ? "block:float" : "block:split") }) as never,
	});
	const ctx = { mode: "tui", cwd: "/tmp", sessionManager: { getSessionId: () => "session", getEntries: () => [], getSessionFile: () => undefined } };
	const terminal = tools.get("rex_terminal");
	await terminal?.execute("call-1", { op: "create", kind: "float", label: "reader", target: { session: "session:test", block: "block:anchor" } } as never, undefined, undefined, ctx as never);
	await terminal?.execute("call-2", { op: "create", kind: "split", label: "split", target: { session: "session:test", block: "block:anchor" } } as never, undefined, undefined, ctx as never);
	assert.deepEqual(floated, [["block:float"], []]);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
});

const LABEL_CHECKS = ["whoami", "com.superlogical.terminal.process", "session.view"];

class LabelTransport implements RexTransport {
	readonly methods: string[] = [];
	label = "Window 00000000";
	private readonly pid: number;

	constructor(pid: number) { this.pid = pid; }

	async run(args: readonly string[], _call: CliCall): Promise<CliResult> {
		const method = args.includes("whoami") ? "whoami" : args.at(-2) ?? "";
		this.methods.push(method);
		if (method === "whoami") return reply({ host_id: "host", instance_id: "instance" });
		if (method === "com.superlogical.terminal.process") return reply({ foreground: { pid: this.pid }, last_exit: null });
		if (method === "session.view") return reply({ revision: 1, session_id: "session:test", windows: [{ window_id: "window:00000000", label: this.label, layers: [{ blocks: [{ block_id: "block:test" }] }] }] });
		if (method === "session.set_window_label") {
			const input = JSON.parse(args.at(-1) ?? "{}") as { label: string };
			this.label = input.label;
			return reply({ revision: 2 });
		}
		throw new Error(`Unexpected Rex method: ${method}`);
	}

	dispose(): void {}
}

function reply(value: unknown): CliResult {
	return { outcome: "exited", exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "", bytes: 0, truncated: false, started: true };
}

test("ordinary tab label wiring runs no process for an unchanged name event and one pass per input", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "rex-index-label-"));
	const transport = new LabelTransport(process.pid);
	const state = { name: undefined as string | undefined };
	const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
	let projector: TabLabelProjector | undefined;
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: (event?: unknown, ctx?: unknown) => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: () => {},
		appendEntry: () => {},
		getSessionName: () => state.name,
	} as unknown as ExtensionAPI;
	registerRex(pi, {
		createTabLabelProjector: (options) => {
			const created = createTabLabelProjector({ ...options, agentDir, env: { REX_SESSION: "session:test", REX_BLOCK: "block:test" }, createTransport: () => transport });
			projector = created;
			return created;
		},
	});
	const ctx = { mode: "tui", cwd: "/work/fixture", ui: { notify: () => {} } } as unknown as ExtensionContext;
	try {
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		await projector?.idle();
		assert.deepEqual(transport.methods, [...LABEL_CHECKS, ...LABEL_CHECKS, "session.set_window_label"]);
		assert.equal(transport.label, "fixture");

		const settled = transport.methods.length;
		handlers.get("session_info_changed")?.({ type: "session_info_changed", name: undefined }, ctx);
		await projector?.idle();
		assert.equal(transport.methods.length, settled);

		state.name = "Named";
		handlers.get("session_info_changed")?.({ type: "session_info_changed", name: "Named" }, ctx);
		await projector?.idle();
		assert.deepEqual(transport.methods.slice(settled), [...LABEL_CHECKS, ...LABEL_CHECKS, "session.set_window_label"]);
		assert.equal(transport.label, "Named");

		const named = transport.methods.length;
		handlers.get("input")?.({ type: "input", source: "rpc" }, ctx);
		await projector?.idle();
		assert.equal(transport.methods.length, named);

		handlers.get("input")?.({ type: "input", source: "interactive" }, ctx);
		await projector?.idle();
		assert.deepEqual(transport.methods.slice(named), LABEL_CHECKS);
	} finally {
		await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
		await rm(agentDir, { recursive: true, force: true });
	}
});
