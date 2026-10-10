import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AgentManager } from "./manager.ts";
import { connectPrimaryChannel, readPrimaryEndpointDescriptor } from "./primary-channel.ts";

test("primary close awaits its endpoint removal and leaves a replacement registration intact", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-shutdown-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
	const id = randomUUID(), first = new AbortController(), second = new AbortController();
	await manager.registerPrimary(id, { signal: first.signal, cwd: root, send() {} });
	const peerId = randomUUID();
	await manager.registerPrimary(peerId, { signal: first.signal, cwd: root, send() {} });
	first.abort();
	await Promise.all([manager.closePrimary(id, first.signal), manager.closePrimary(peerId, first.signal)]);
	assert.equal(readPrimaryEndpointDescriptor(root, id).state, "absent");
	assert.equal(readPrimaryEndpointDescriptor(root, peerId).state, "absent", "a shared abort signal closes each owned endpoint");
	await manager.registerPrimary(id, { signal: second.signal, cwd: root, send() {} });
	await manager.closePrimary(id, first.signal);
	const connection = await connectPrimaryChannel({ id, sessionsRoot: root });
	await connection.close();
	second.abort();
	await manager.closePrimary(id, second.signal);
	assert.equal(readPrimaryEndpointDescriptor(root, id).state, "absent");
});

test("ordinary shutdown awaits close even when the status callback throws", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-shutdown-handler-")));
	const saved = new Map(["PI_AGENT_SESSIONS_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_HARNESS_FILE"].map((key) => [key, process.env[key]]));
	process.env.PI_AGENT_SESSIONS_DIR = root;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_AGENT_DIR = root;
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	writeFileSync(process.env.PI_HARNESS_FILE, '{"version":1}');
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[Symbol.for("pi.extension.agent.owners")];
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const closeStarted = new Promise<void>((resolve) => { started = resolve; });
	let closes = 0;
	const manager = new AgentManager({ root, agentDir: root, packageDir: root, createPrimary: async (options) => ({
		id: options.id, socketPath: "unused", info: () => ({ id: options.id, cwd: root, hostname: "fixture", pid: process.pid, socketPath: "unused", startedAt: new Date().toISOString() }),
		update() {}, publishIntent() {}, touch() {}, setObservedPurpose() {}, close: async () => { closes++; started(); await gate; },
	}) });
	owners.managers.set(root, manager);
	t.after(() => {
		release(); manager.close(); owners.managers.delete(root);
		for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	});
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	register({ events: { emit() {}, on: () => () => {} }, on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => { events.set(name, handler); return () => {}; },
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	let throwStatus = false;
	const ctx = { cwd: root, sessionManager: SessionManager.inMemory(root),
		ui: { setStatus: () => { if (throwStatus) throw new Error("UI unavailable"); } }, modelRegistry: { getAll: () => [], find: () => undefined },
	} as unknown as ExtensionContext;
	await events.get("session_start")?.({ reason: "startup" }, ctx);
	throwStatus = true;
	let finished = false;
	const shutdown = events.get("session_shutdown")?.({ reason: "quit" }, ctx).then(() => { finished = true; });
	await closeStarted;
	assert.equal(finished, false, "shutdown remains open while endpoint teardown is pending");
	release(); await shutdown;
	assert.equal(closes, 1);
	await events.get("session_shutdown")?.({ reason: "quit" }, ctx);
	assert.equal(closes, 1, "repeated shutdown does not own a second channel");
	const status = await manager.status();
	assert.match(JSON.stringify(status), /UI unavailable/u);
	assert.doesNotMatch(JSON.stringify(status), /"sessionId":/u);
	Object.defineProperty(manager, "managerProtocol", { value: "manager/2.0.0" });
	await assert.rejects(events.get("session_start")?.({ reason: "reload" }, ctx) ?? Promise.resolve(), /retained agent manager.*Restart Pi/u);
	assert.equal(closes, 1, "an old retained manager refuses before registration");
});

test("primary close reports endpoint cleanup rejection",  async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-shutdown-failure-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root, createPrimary: async (options) => ({
		id: options.id, socketPath: "unused", info: () => ({ id: options.id, cwd: root, hostname: "fixture", pid: process.pid, socketPath: "unused", startedAt: new Date().toISOString() }),
		update() {}, publishIntent() {}, touch() {}, setObservedPurpose() {}, close: async () => { throw new Error("Endpoint cleanup failed"); },
	}) });
	t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
	const abort = new AbortController(), id = randomUUID();
	await manager.registerPrimary(id, { signal: abort.signal, cwd: root, send() {} });
	abort.abort();
	await assert.rejects(manager.closePrimary(id, abort.signal), /Endpoint cleanup failed/u);
	assert.match(JSON.stringify(await manager.status()), /Endpoint cleanup failed/u);
});

test("primary shutdown waits for a channel that finishes creation after abort", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-startup-shutdown-")));
	let releaseCreate!: () => void, releaseClose!: () => void, creating!: () => void, closing!: () => void;
	const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
	const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
	const createStarted = new Promise<void>((resolve) => { creating = resolve; });
	const closeStarted = new Promise<void>((resolve) => { closing = resolve; });
	const manager = new AgentManager({ root, agentDir: root, packageDir: root, createPrimary: async (options) => {
		creating(); await createGate;
		return { id: options.id, socketPath: "unused", info: () => ({ id: options.id, cwd: root, hostname: "fixture", pid: process.pid, socketPath: "unused", startedAt: new Date().toISOString() }),
			update() {}, publishIntent() {}, touch() {}, setObservedPurpose() {}, close: async () => { closing(); await closeGate; } };
	} });
	t.after(() => { releaseCreate(); releaseClose(); manager.close(); rmSync(root, { recursive: true, force: true }); });
	const id = randomUUID(), abort = new AbortController();
	const registering = manager.registerPrimary(id, { signal: abort.signal, cwd: root, send() {} });
	await createStarted; abort.abort();
	let finished = false;
	const shutdown = manager.closePrimary(id, abort.signal).then(() => { finished = true; });
	await Promise.resolve();
	assert.equal(finished, false, "pending channel creation remains part of shutdown");
	releaseCreate(); await closeStarted;
	assert.equal(finished, false, "shutdown also awaits the late channel close");
	releaseClose(); await Promise.all([registering, shutdown]);
});

test("failed primary replacement removes the closed registration and rejects its deliveries", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-replacement-failure-")));
	let calls = 0, delivered = 0, closed = 0;
	let deliver: ((message: { sourceId: string; text: string }) => void) | undefined;
	const manager = new AgentManager({ root, agentDir: root, packageDir: root, createPrimary: async (options) => {
		if (++calls === 2) throw new Error("Replacement unavailable");
		deliver = options.deliver;
		return { id: options.id, socketPath: "unused", info: () => ({ id: options.id, cwd: root, hostname: "fixture", pid: process.pid, socketPath: "unused", startedAt: new Date().toISOString() }),
			update() {}, publishIntent() {}, touch() {}, setObservedPurpose() {}, close: async () => { closed++; } };
	} });
	t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
	const id = randomUUID();
	await manager.registerPrimary(id, { signal: new AbortController().signal, cwd: root, send: () => { delivered++; } });
	await assert.rejects(manager.registerPrimary(id, { signal: new AbortController().signal, cwd: root, send() {} }), /Replacement unavailable/u);
	assert.equal(closed, 1);
	assert.doesNotMatch(JSON.stringify(await manager.status()), new RegExp(id, "u"));
	assert.throws(() => deliver?.({ sourceId: "late", text: "Late delivery" }), /closed/u);
	assert.equal(delivered, 0);
});

test("manager close contains a status exception and closes every owned endpoint", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "manager-close-status-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
	const first = randomUUID(), second = randomUUID();
	const firstSignal = new AbortController().signal, secondSignal = new AbortController().signal;
	let fail = false;
	await manager.registerPrimary(first, { signal: firstSignal, cwd: root, send() {}, status: () => { if (fail) throw new Error("UI unavailable"); } });
	await manager.registerPrimary(second, { signal: secondSignal, cwd: root, send() {} });
	fail = true;
	assert.doesNotThrow(() => manager.close());
	await Promise.all([manager.closePrimary(first, firstSignal), manager.closePrimary(second, secondSignal)]);
	assert.equal(readPrimaryEndpointDescriptor(root, first).state, "absent");
	assert.equal(readPrimaryEndpointDescriptor(root, second).state, "absent");
});
