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
