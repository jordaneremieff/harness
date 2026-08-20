import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerPivot from "./index.ts";
import { PIVOT_CUSTOM_TYPE } from "./gates.ts";

function registry() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const calls: Array<{ kind: string; args: unknown[] }> = [];
	const pi: any = {
		on: (name: string, handler: (event: any, ctx: any) => any) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut: (name: string, shortcut: any) => calls.push({ kind: "shortcut", args: [name, shortcut] }),
		appendEntry: (...args: unknown[]) => calls.push({ kind: "appendEntry", args }),
		sendMessage: (...args: unknown[]) => calls.push({ kind: "sendMessage", args }),
	};
	registerPivot(pi);
	return { commands, handlers, calls, emit: (name: string, event: any, ctx: any) => {
		const list = handlers.get(name) ?? [];
		let result: any;
		for (const handler of list) result = handler(event, ctx);
		return result;
	} };
}

function sessionCtx(overrides: Record<string, unknown> = {}, ui?: Record<string, unknown>) {
	return {
		hasUI: true,
		ui: { setStatus: () => {}, notify: () => {}, ...ui },
		sessionManager: {
			getHeader: () => ({ parentSession: "/parent.jsonl" }),
			getEntries: () => [
				{ id: "u1", parentId: null, type: "message", message: { role: "user" } },
				{ id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } },
			],
			getLeafId: () => "a1",
			getSessionId: () => "s1",
			getSessionFile: () => "/sessions/s1.jsonl",
		},
		...overrides,
	};
}

describe("pivot entrypoint", () => {
	it("registers only the /pivot command and no shortcut", () => {
		const { commands, calls } = registry();
		assert.deepEqual([...commands.keys()], ["pivot"]);
		assert.equal(calls.filter((call) => call.kind === "shortcut").length, 0);
	});

	it("arms and records the fork point on a fresh fork start", () => {
		const { emit, calls } = registry();
		const statuses: string[] = [];
		const ctx = sessionCtx({}, { setStatus: (_key: string, value?: string) => statuses.push(value ?? "<clear>") });
		emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		assert.deepEqual(calls.filter((call) => call.kind === "appendEntry").map((call) => call.args), [
			[PIVOT_CUSTOM_TYPE, { sessionId: "s1", forkPointLeafId: "a1" }],
		]);
		assert.ok(statuses.includes("fork boundary armed — next message will be framed"));
	});

	it("does not arm a session without a parent", () => {
		const { emit, calls } = registry();
		const ctx = sessionCtx({
			sessionManager: {
				getHeader: () => ({}),
				getEntries: () => [],
				getLeafId: () => null,
				getSessionId: () => "s2",
				getSessionFile: () => "/sessions/s2.jsonl",
			},
		});
		emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		assert.equal(calls.filter((call) => call.kind === "appendEntry").length, 0);
	});

	it("queues the boundary on the first interactive input and disarms", () => {
		const { emit, calls } = registry();
		const ctx = sessionCtx();
		emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		emit("input", { type: "input", text: "my request", source: "interactive" }, ctx);
		const sends = calls.filter((call) => call.kind === "sendMessage");
		assert.equal(sends.length, 1);
		const [message, options] = sends[0].args as [Record<string, unknown>, Record<string, unknown>];
		assert.equal(message.customType, PIVOT_CUSTOM_TYPE);
		assert.equal(message.display, false);
		assert.match(String(message.content), /fork task boundary/);
		assert.deepEqual(options, { deliverAs: "nextTurn" });
		// Disarmed: a second input queues nothing.
		emit("input", { type: "input", text: "again", source: "interactive" }, ctx);
		assert.equal(calls.filter((call) => call.kind === "sendMessage").length, 1);
	});

	it("ignores rpc and extension sources", () => {
		const { emit, calls } = registry();
		const ctx = sessionCtx();
		emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		emit("input", { type: "input", text: "rpc message", source: "rpc" }, ctx);
		emit("input", { type: "input", text: "extension message", source: "extension" }, ctx);
		assert.equal(calls.filter((call) => call.kind === "sendMessage").length, 0);
	});

	it("ignores empty input but consumes images-only input", () => {
		const { emit, calls } = registry();
		const ctx = sessionCtx();
		emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		emit("input", { type: "input", text: "  ", source: "interactive" }, ctx);
		assert.equal(calls.filter((call) => call.kind === "sendMessage").length, 0);
		emit("input", { type: "input", text: "", images: [{ type: "image", data: "abc", mimeType: "image/png" }], source: "interactive" }, ctx);
		assert.equal(calls.filter((call) => call.kind === "sendMessage").length, 1);
	});

	it("clears the status on session shutdown", () => {
		const { emit, calls } = registry();
		const statuses: string[] = [];
		const ctx = sessionCtx({}, { setStatus: (_key: string, value?: string) => statuses.push(value ?? "<clear>") });
		emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		assert.ok(statuses.includes("<clear>"));
		assert.equal(calls.filter((call) => call.kind === "sendMessage").length, 0);
	});

	it("copies a shell-safe fork command via /pivot", async () => {
		const { commands } = registry();
		const notifications: string[] = [];
		const command = commands.get("pivot");
		assert.ok(command);
		// The handler writes to the real clipboard on this machine; the
		// assembly itself is covered by command.test.mts. Verify the guard
		// paths here instead.
		const busy = sessionCtx({ isIdle: () => false }, { notify: (message: string) => notifications.push(message) });
		await command.handler("", busy);
		assert.ok(notifications.some((message) => /Wait for the agent/.test(message)));
		const ephemeral = sessionCtx(
			{
				sessionManager: {
					getHeader: () => ({}),
					getEntries: () => [],
					getLeafId: () => null,
					getSessionId: () => "s3",
					getSessionFile: () => undefined,
				},
				isIdle: () => true,
			},
			{ notify: (message: string) => notifications.push(message) },
		);
		await command.handler("", ephemeral);
		assert.ok(notifications.some((message) => /ephemeral/.test(message)));
		assert.equal(notifications.filter((message) => /Fork command copied/.test(message)).length, 0);
	});
});
