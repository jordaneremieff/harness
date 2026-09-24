import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isManagedChild } from "./host-role.ts";
import registerAgentExtension, { AgentManager } from "./index.ts";

test("managed host queries accept only exact synchronous claims and release response listeners", () => {
	const bus = createEventBus();
	assert.equal(isManagedChild(bus, "native"), false);
	const off = bus.on("harness:session-host:request", () => {
		for (const value of [null, { version: 2, sessionId: "native", role: "managed-child" },
			{ version: 1, sessionId: "other", role: "managed-child" }, { version: 1, sessionId: "native", role: "primary" }]) {
			bus.emit("harness:session-host:role", value);
		}
	});
	assert.equal(isManagedChild(bus, "native"), false);
	off();
	let reads = 0;
	const claim = { version: 1, sessionId: "native", get role() { reads++; return "managed-child"; } };
	bus.on("harness:session-host:request", () => bus.emit("harness:session-host:role", claim));
	assert.equal(isManagedChild(bus, "native"), true);
	assert.equal(reads, 1);
	bus.emit("harness:session-host:role", claim);
	assert.equal(reads, 1, "the request does not retain its response listener");
});

test("primary shutdown follows actual registration rather than a later host claim", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-host-role-"));
	const previousDir = process.env.PI_AGENT_DIR, previousSessions = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_DIR = root;
	process.env.PI_AGENT_SESSIONS_DIR = join(root, "sessions");
	const register = t.mock.method(AgentManager.prototype, "registerPrimary");
	const unregister = t.mock.method(AgentManager.prototype, "unregisterPrimary");
	const bus = createEventBus();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	registerAgentExtension({ events: bus, registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
		},
	} as unknown as ExtensionAPI);
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "native", getEntries: () => [] }, ui: { setStatus() {} } } as unknown as ExtensionContext;
	const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
	const responder = () => bus.on("harness:session-host:request", () => bus.emit("harness:session-host:role", { version: 1, sessionId: "native", role: "managed-child" }));
	try {
		let off = responder();
		await emit("session_start"); off(); await emit("session_shutdown");
		assert.equal(register.mock.callCount(), 0);
		assert.equal(unregister.mock.callCount(), 0, "a released child never unregisters a primary");
		await emit("session_start");
		assert.equal(register.mock.callCount(), 1, "absence preserves independent primary registration");
		off = responder(); await emit("session_shutdown"); off();
		assert.equal(unregister.mock.callCount(), 1, "a new claim does not suppress the primary's actual cleanup");
		await emit("session_shutdown");
		assert.equal(unregister.mock.callCount(), 1);
	} finally {
		await emit("session_shutdown");
		if (previousDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previousDir;
		if (previousSessions === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = previousSessions;
		rmSync(root, { recursive: true, force: true });
	}
});
