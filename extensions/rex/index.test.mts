import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { registerRex } from "./index.ts";
import { resultByteLimit, type RexResult } from "./core.ts";

test("ordinary shutdown drains owned calls before reload replaces live-call state", async () => {
	const tools = new Map<string, ToolDefinition<TSchema>>();
	const handlers = new Map<string, () => unknown>();
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: (tool: ToolDefinition<TSchema>) => tools.set(tool.name, tool),
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
	const tools = new Map<string, ToolDefinition<TSchema>>();
	const handlers = new Map<string, () => unknown>();
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: (tool: ToolDefinition<TSchema>) => tools.set(tool.name, tool), appendEntry: () => {},
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
	const tools = new Map<string, ToolDefinition<TSchema>>();
	const handlers = new Map<string, () => unknown>();
	let writes = 0;
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerTool: (tool: ToolDefinition<TSchema>) => tools.set(tool.name, tool), appendEntry: () => { writes++; },
	} as unknown as ExtensionAPI;
	const request = { op: "observe", recordId: "retained-call", maxBytes: 256 };
	const expected: RexResult = { ok: true, outcome: "observed", effects: { state: "none" }, coverage: { bounded: true }, data: { reports: [{ recordId: "retained-call", phase: "unknown", complete: true, observedAt: "2026-01-01T00:00:00.000Z", observations: [{ presence: "present", childState: "exited", process: { last_exit: { exit_code: 7 } }, capture: { content: "final output", start: 0, end: 12, total: 12 } }] }] } };
	registerRex(pi, { createCore: () => ({ dispose: () => {}, execute: async (received, call) => {
		assert.equal(received, request);
		assert.equal(call.ownerId, "ordinary:observation-session");
		return expected;
	} }) });
	const ctx = { cwd: "/test", isIdle: () => true, sessionManager: { getSessionId: () => "observation-session", getEntries: () => [], getSessionFile: () => undefined } } as unknown as ExtensionToolContext;
	try {
		const tool = tools.get("rex_owned");
		assert.ok(tool);
		const response = await tool.execute("observe", request, undefined, undefined, ctx);
		assert.equal(response.isError, false);
		assert.equal(JSON.stringify(response.structuredContent), JSON.stringify(expected));
		assert.equal(response.content.filter((part) => part.type === "text").map((part) => part.text).join(""), JSON.stringify(expected));
		assert.equal(writes, 0);
	} finally { await handlers.get("session_shutdown")?.(); }
});

test("ordinary registration publishes only identical display references and cleans up requests on reload", async () => {
	type Publication = { version: number; tools: Array<Pick<ToolDefinition<TSchema>, "name" | "renderCall" | "renderResult" | "renderShell">> };
	const tools = new Map<string, ToolDefinition<TSchema>>();
	const handlers = new Map<string, () => unknown>();
	const events = createEventBus();
	const publications: Publication[] = [];
	events.on("harness:tool-display:publish", (value) => { publications.push(value as Publication); });
	const pi = { events, on: (name: string, handler: () => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); }, registerTool: (tool: ToolDefinition<TSchema>) => tools.set(tool.name, tool), appendEntry: () => {} } as unknown as ExtensionAPI;
	let executions = 0;
	const options = { createCore: () => { executions++; throw new Error("Display requests must not execute tools."); } };
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
		assert.notEqual(publications[3]?.tools[0]?.renderCall, initial.tools[0]?.renderCall);
		assert.equal(publications[3]?.tools[0]?.renderCall, tools.values().next().value?.renderCall);
		assert.equal(executions, 0);
	} finally { await handlers.get("session_shutdown")?.(); }
});
