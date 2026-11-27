import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AgentManager } from "./manager.ts";
import {
	connectPrimaryChannel,
	createPrimaryChannel,
	primaryEndpointPath,
	readPrimaryEndpointDescriptor,
} from "./primary-channel.ts";

test("primary close awaits its endpoint removal and leaves a replacement registration intact", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-shutdown-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const id = randomUUID(),
		first = new AbortController(),
		second = new AbortController();
	await manager.registerPrimary(id, { signal: first.signal, cwd: root, send() {} });
	const peerId = randomUUID();
	await manager.registerPrimary(peerId, { signal: first.signal, cwd: root, send() {} });
	first.abort();
	await Promise.all([manager.closePrimary(id, first.signal), manager.closePrimary(peerId, first.signal)]);
	assert.equal(readPrimaryEndpointDescriptor(root, id).state, "absent");
	assert.equal(
		readPrimaryEndpointDescriptor(root, peerId).state,
		"absent",
		"a shared abort signal closes each owned endpoint",
	);
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
	const saved = new Map(
		["PI_AGENT_SESSIONS_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_HARNESS_FILE"].map((key) => [
			key,
			process.env[key],
		]),
	);
	process.env.PI_AGENT_SESSIONS_DIR = root;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_AGENT_DIR = root;
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	writeFileSync(process.env.PI_HARNESS_FILE, '{"version":1}');
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[
		Symbol.for("pi.extension.agent.owners")
	];
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const closeStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	let closes = 0;
	const manager = new AgentManager({
		root,
		agentDir: root,
		packageDir: root,
		createPrimary: async (options) => ({
			id: options.id,
			socketPath: "unused",
			info: () => ({
				id: options.id,
				cwd: root,
				hostname: "fixture",
				pid: process.pid,
				socketPath: "unused",
				startedAt: new Date().toISOString(),
			}),
			update() {},
			publishIntent() {},
			touch() {},
			setObservedPurpose() {},
			setWorkRefs() {},
			close: async () => {
				closes++;
				started();
				await gate;
			},
		}),
	});
	owners.managers.set(root, manager);
	t.after(async () => {
		release();
		await manager.close();
		owners.managers.delete(root);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
			events.set(name, handler);
			return () => {};
		},
		registerFlag() {},
		getFlag: () => undefined,
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	let throwStatus = false;
	const ctx = {
		cwd: root,
		sessionManager: SessionManager.inMemory(root),
		ui: {
			setStatus: () => {
				if (throwStatus) throw new Error("UI unavailable");
			},
		},
		modelRegistry: { getAll: () => [], find: () => undefined },
	} as unknown as ExtensionContext;
	await events.get("session_start")?.({ reason: "startup" }, ctx);
	throwStatus = true;
	let finished = false;
	const shutdown = events
		.get("session_shutdown")?.({ reason: "quit" }, ctx)
		.then(() => {
			finished = true;
		});
	await closeStarted;
	assert.equal(finished, false, "shutdown remains open while endpoint teardown is pending");
	release();
	await shutdown;
	assert.equal(closes, 1);
	await events.get("session_shutdown")?.({ reason: "quit" }, ctx);
	assert.equal(closes, 1, "repeated shutdown does not own a second channel");
	const status = await manager.status();
	assert.match(JSON.stringify(status), /UI unavailable/u);
	assert.doesNotMatch(JSON.stringify(status), /"sessionId":/u);
	Object.defineProperty(manager, "managerProtocol", { value: "manager/2.0.0" });
	const notices: string[] = [];
	(ctx.ui as unknown as { notify: (text: string) => void }).notify = (text) => notices.push(text);
	await events.get("session_start")?.({ reason: "reload" }, ctx);
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /retained agent manager uses manager\/2\.0\.0.*Quit Pi and resume this session/u);
	assert.equal(closes, 1, "an old retained manager refuses before registration");
});

test("primary close reports endpoint cleanup rejection", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-shutdown-failure-")));
	const manager = new AgentManager({
		root,
		agentDir: root,
		packageDir: root,
		createPrimary: async (options) => ({
			id: options.id,
			socketPath: "unused",
			info: () => ({
				id: options.id,
				cwd: root,
				hostname: "fixture",
				pid: process.pid,
				socketPath: "unused",
				startedAt: new Date().toISOString(),
			}),
			update() {},
			publishIntent() {},
			touch() {},
			setObservedPurpose() {},
			setWorkRefs() {},
			close: async () => {
				throw new Error("Endpoint cleanup failed");
			},
		}),
	});
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const abort = new AbortController(),
		id = randomUUID();
	await manager.registerPrimary(id, { signal: abort.signal, cwd: root, send() {} });
	abort.abort();
	await assert.rejects(manager.closePrimary(id, abort.signal), /Endpoint cleanup failed/u);
	assert.match(JSON.stringify(await manager.status()), /Endpoint cleanup failed/u);
});

test("primary shutdown waits for a channel that finishes creation after abort", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-startup-shutdown-")));
	let releaseCreate!: () => void, releaseClose!: () => void, creating!: () => void, closing!: () => void;
	const createGate = new Promise<void>((resolve) => {
		releaseCreate = resolve;
	});
	const closeGate = new Promise<void>((resolve) => {
		releaseClose = resolve;
	});
	const createStarted = new Promise<void>((resolve) => {
		creating = resolve;
	});
	const closeStarted = new Promise<void>((resolve) => {
		closing = resolve;
	});
	const manager = new AgentManager({
		root,
		agentDir: root,
		packageDir: root,
		createPrimary: async (options) => {
			creating();
			await createGate;
			return {
				id: options.id,
				socketPath: "unused",
				info: () => ({
					id: options.id,
					cwd: root,
					hostname: "fixture",
					pid: process.pid,
					socketPath: "unused",
					startedAt: new Date().toISOString(),
				}),
				update() {},
				publishIntent() {},
				touch() {},
				setObservedPurpose() {},
				setWorkRefs() {},
				close: async () => {
					closing();
					await closeGate;
				},
			};
		},
	});
	t.after(async () => {
		releaseCreate();
		releaseClose();
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const id = randomUUID(),
		abort = new AbortController();
	const registering = manager.registerPrimary(id, { signal: abort.signal, cwd: root, send() {} });
	await createStarted;
	abort.abort();
	let finished = false;
	const shutdown = manager.closePrimary(id, abort.signal).then(() => {
		finished = true;
	});
	await Promise.resolve();
	assert.equal(finished, false, "pending channel creation remains part of shutdown");
	releaseCreate();
	await closeStarted;
	assert.equal(finished, false, "shutdown also awaits the late channel close");
	releaseClose();
	await Promise.all([registering, shutdown]);
});

test("failed primary replacement removes the closed registration and rejects its deliveries", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-replacement-failure-")));
	let calls = 0,
		delivered = 0,
		closed = 0;
	let deliver: ((message: { sourceId: string; text: string }) => void) | undefined;
	const manager = new AgentManager({
		root,
		agentDir: root,
		packageDir: root,
		createPrimary: async (options) => {
			if (++calls === 2) throw new Error("Replacement unavailable");
			deliver = options.deliver;
			return {
				id: options.id,
				socketPath: "unused",
				info: () => ({
					id: options.id,
					cwd: root,
					hostname: "fixture",
					pid: process.pid,
					socketPath: "unused",
					startedAt: new Date().toISOString(),
				}),
				update() {},
				publishIntent() {},
				touch() {},
				setObservedPurpose() {},
				setWorkRefs() {},
				close: async () => {
					closed++;
				},
			};
		},
	});
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const id = randomUUID();
	await manager.registerPrimary(id, {
		signal: new AbortController().signal,
		cwd: root,
		send: () => {
			delivered++;
		},
	});
	await assert.rejects(
		manager.registerPrimary(id, { signal: new AbortController().signal, cwd: root, send() {} }),
		/Replacement unavailable/u,
	);
	assert.equal(closed, 1);
	assert.doesNotMatch(JSON.stringify(await manager.status()), new RegExp(id, "u"));
	assert.throws(() => deliver?.({ sourceId: "late", text: "Late delivery" }), /closed/u);
	assert.equal(delivered, 0);
});

test("manager close contains a status exception and closes every owned endpoint", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "manager-close-status-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const first = randomUUID(),
		second = randomUUID();
	const firstSignal = new AbortController().signal,
		secondSignal = new AbortController().signal;
	let fail = false;
	await manager.registerPrimary(first, {
		signal: firstSignal,
		cwd: root,
		send() {},
		status: () => {
			if (fail) throw new Error("UI unavailable");
		},
	});
	await manager.registerPrimary(second, { signal: secondSignal, cwd: root, send() {} });
	fail = true;
	assert.doesNotThrow(() => manager.close());
	await Promise.all([manager.closePrimary(first, firstSignal), manager.closePrimary(second, secondSignal)]);
	assert.equal(readPrimaryEndpointDescriptor(root, first).state, "absent");
	assert.equal(readPrimaryEndpointDescriptor(root, second).state, "absent");
});

test("a reloading session keeps its endpoint published until it registers again", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-reload-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const id = randomUUID();
	const first = new AbortController();
	const delivered: string[] = [];
	await manager.registerPrimary(id, { signal: first.signal, cwd: root, send: () => delivered.push("first") });
	const before = readPrimaryEndpointDescriptor(root, id).info?.socketPath;
	assert.equal(manager.suspendPrimary(id, first), true);
	assert.equal(manager.suspendPrimary(id, first), false, "one suspension per registration");
	assert.equal(readPrimaryEndpointDescriptor(root, id).state, "live", "the session does not read as ended");
	const connection = await connectPrimaryChannel({ id, sessionsRoot: root });
	await assert.rejects(
		connection.deliver({ sourceId: "s1", text: "Hi", requireRetained: false }),
		/reloading; the delivery stays unacknowledged/u,
	);
	await connection.close();
	const second = new AbortController();
	await manager.registerPrimary(id, { signal: second.signal, cwd: root, send: () => delivered.push("second") });
	const after = readPrimaryEndpointDescriptor(root, id);
	assert.equal(after.state, "live");
	assert.notEqual(after.info?.socketPath, before, "the new registration replaced the record");
	const again = await connectPrimaryChannel({ id, sessionsRoot: root });
	await again.deliver({ sourceId: "s2", text: "Hi", requireRetained: false });
	await again.close();
	assert.deepEqual(delivered, ["second"]);

	// Without a new registration within the grace period, the suspended registration ends.
	const third = new AbortController();
	const other = randomUUID();
	await manager.registerPrimary(other, { signal: third.signal, cwd: root, send() {} });
	assert.equal(manager.suspendPrimary(other, third, 10), true);
	await new Promise<void>((done) => third.signal.addEventListener("abort", () => done(), { once: true }));
	await manager.closePrimary(other, third.signal);
	assert.equal(readPrimaryEndpointDescriptor(root, other).state, "absent");
});

test("a reloading session refuses deliveries until its new registration replaces the old one", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-reload-window-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const id = randomUUID();
	const first = new AbortController();
	const delivered: string[] = [];
	await manager.registerPrimary(id, { signal: first.signal, cwd: root, send: () => delivered.push("first") });
	assert.equal(manager.suspendPrimary(id, first), true);
	const locations = (manager as unknown as { locations: { resolve(cwd: string): Promise<unknown> } }).locations;
	const resolve = locations.resolve.bind(locations);
	let entered!: () => void;
	let release!: () => void;
	const inside = new Promise<void>((done) => (entered = done));
	const gate = new Promise<void>((done) => (release = done));
	locations.resolve = async (cwd: string) => {
		entered();
		await gate;
		return resolve(cwd);
	};
	const second = new AbortController();
	const registering = manager.registerPrimary(id, {
		signal: second.signal,
		cwd: root,
		send: () => delivered.push("second"),
	});
	await inside;
	const connection = await connectPrimaryChannel({ id, sessionsRoot: root });
	await assert.rejects(connection.deliver({ sourceId: "s1", text: "Hi", requireRetained: false }), /reloading/u);
	await connection.close();
	locations.resolve = resolve;
	release();
	await registering;
	assert.deepEqual(delivered, [], "the unloaded registration never receives a delivery");
});

test("an ordinary registration that its extension shut down for a reload refuses deliveries", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-reload-callback-")));
	const saved = new Map(
		["PI_AGENT_SESSIONS_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_HARNESS_FILE"].map((key) => [
			key,
			process.env[key],
		]),
	);
	process.env.PI_AGENT_SESSIONS_DIR = root;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_AGENT_DIR = root;
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	writeFileSync(process.env.PI_HARNESS_FILE, '{"version":1}');
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[
		Symbol.for("pi.extension.agent.owners")
	];
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	const clients: Array<Parameters<AgentManager["registerPrimary"]>[1]> = [];
	const registerPrimary = manager.registerPrimary.bind(manager);
	manager.registerPrimary = (id, client) => {
		clients.push(client);
		return registerPrimary(id, client);
	};
	owners.managers.set(root, manager);
	t.after(async () => {
		await manager.close();
		owners.managers.delete(root);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
			events.set(name, handler);
			return () => {};
		},
		registerFlag() {},
		getFlag: () => undefined,
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		appendEntry() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: root,
		hasUI: false,
		isIdle: () => true,
		sessionManager: SessionManager.inMemory(root),
		ui: { setStatus() {}, notify() {} },
		modelRegistry: { getAll: () => [], find: () => undefined },
	} as unknown as ExtensionContext;
	await events.get("session_start")?.({ reason: "startup" }, ctx);
	assert.equal(clients.length, 1);
	await events.get("session_shutdown")?.({ reason: "reload" }, ctx);
	assert.throws(() => clients[0].send("Hi", {}, "source-1", false), /Primary session is reloading/u);
	assert.throws(() => clients[0].send("Result", {}, "source-2", true), /Primary session is reloading/u);
});

test("a message to a reloading ordinary primary arrives once the session registers again", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-reload-message-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const sender = randomUUID();
	const target = randomUUID();
	await manager.registerPrimary(sender, { signal: new AbortController().signal, cwd: root, send() {} });
	const first = new AbortController();
	await manager.registerPrimary(target, { signal: first.signal, cwd: root, send() {} });
	assert.equal(manager.suspendPrimary(target, first), true);
	const delivered: string[] = [];
	const registered = new Promise<void>((done) => {
		setTimeout(() => {
			void manager
				.registerPrimary(target, {
					signal: new AbortController().signal,
					cwd: root,
					send: (text) => delivered.push(text),
				})
				.then(done);
		}, 300);
	});
	const receipt = (await manager.control(
		"submit",
		{ sessionId: target, message: "sent during the reload", origin: "model" },
		{ id: sender, cwd: root },
	)) as { admitted?: boolean };
	await registered;
	assert.equal(receipt.admitted, true);
	assert.equal(delivered.length, 1);
	assert.match(delivered[0] ?? "", /sent during the reload/u);
});

test("a message to an ordinary primary that quits during its reload fails at once as not delivered", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-reload-quit-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const sender = randomUUID();
	const target = randomUUID();
	await manager.registerPrimary(sender, { signal: new AbortController().signal, cwd: root, send() {} });
	const first = new AbortController();
	const delivered: string[] = [];
	await manager.registerPrimary(target, { signal: first.signal, cwd: root, send: (text) => delivered.push(text) });
	assert.equal(manager.suspendPrimary(target, first), true);
	const quit = new Promise<void>((done) => {
		setTimeout(() => void manager.closePrimary(target, first.signal).finally(done), 300);
	});
	const started = Date.now();
	await assert.rejects(
		manager.control(
			"submit",
			{ sessionId: target, message: "sent before the quit", origin: "model" },
			{ id: sender, cwd: root },
		),
		/ended during its reload; the message was not delivered/u,
	);
	await quit;
	assert.ok(Date.now() - started < 5000, "the sender stops before the reload wait ends");
	assert.deepEqual(delivered, []);
});

test("a message withdrawn while its ordinary primary reloads is not delivered after the reload", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-reload-abort-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const sender = randomUUID();
	const target = randomUUID();
	await manager.registerPrimary(sender, { signal: new AbortController().signal, cwd: root, send() {} });
	const first = new AbortController();
	await manager.registerPrimary(target, { signal: first.signal, cwd: root, send() {} });
	assert.equal(manager.suspendPrimary(target, first), true);
	const withdrawn = new AbortController();
	const call = manager.control(
		"submit",
		{ sessionId: target, message: "withdrawn during the reload", origin: "model" },
		{ id: sender, cwd: root },
		{ signal: withdrawn.signal },
	);
	setTimeout(() => withdrawn.abort(), 300);
	await assert.rejects(call, { name: "AbortError" });
	const delivered: string[] = [];
	await manager.registerPrimary(target, {
		signal: new AbortController().signal,
		cwd: root,
		send: (text) => delivered.push(text),
	});
	// The retry interval is 200 ms; three intervals give a retry that survived the abort time to arrive.
	await new Promise((done) => setTimeout(done, 600));
	assert.deepEqual(delivered, []);
});

test("a message whose link a reload closes in flight arrives once through the next registration", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-reload-link-")));
	const target = randomUUID();
	const sender = randomUUID();
	const delivered: string[] = [];
	const first = new AbortController();
	let replacement: Promise<void> | undefined;
	let markClosed!: () => void;
	const firstClosed = new Promise<void>((done) => {
		markClosed = done;
	});
	let channels = 0;
	const manager: AgentManager = new AgentManager({
		root,
		agentDir: root,
		packageDir: root,
		createPrimary: async (options) => {
			const own = options.id === target ? ++channels : 0;
			if (own !== 1) return createPrimaryChannel(options);
			// The first channel of the target starts the reload while a message is in flight on it, and its close ends
			// that link before the request answers.
			const channel = await createPrimaryChannel({
				...options,
				deliver: async () => {
					replacement ??= (async () => {
						assert.equal(manager.suspendPrimary(target, first), true);
						await manager.registerPrimary(target, {
							signal: new AbortController().signal,
							cwd: root,
							send: (text) => delivered.push(text),
						});
					})();
					await firstClosed;
					throw new Error("the replaced channel answered");
				},
			});
			const close = channel.close;
			channel.close = () => {
				const closing = close();
				markClosed();
				return closing;
			};
			return channel;
		},
	});
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	await manager.registerPrimary(sender, { signal: new AbortController().signal, cwd: root, send() {} });
	await manager.registerPrimary(target, { signal: first.signal, cwd: root, send() {} });
	const receipt = (await manager.control(
		"submit",
		{ sessionId: target, message: "in flight during the reload", origin: "model" },
		{ id: sender, cwd: root },
	)) as { admitted?: boolean };
	await replacement;
	assert.equal(channels, 2, "the reload published a second channel");
	assert.equal(receipt.admitted, true);
	assert.equal(delivered.length, 1);
	assert.match(delivered[0] ?? "", /in flight during the reload/u);
});

test("a message whose first connection meets a channel that the reload closed arrives through the next registration", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-reload-connect-")));
	const target = randomUUID();
	const sender = randomUUID();
	const channels: Array<{ close(): Promise<void> }> = [];
	const manager = new AgentManager({
		root,
		agentDir: root,
		packageDir: root,
		createPrimary: async (options) => {
			const channel = await createPrimaryChannel(options);
			if (options.id === target) channels.push(channel);
			return channel;
		},
	});
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	await manager.registerPrimary(sender, { signal: new AbortController().signal, cwd: root, send() {} });
	const first = new AbortController();
	await manager.registerPrimary(target, { signal: first.signal, cwd: root, send() {} });
	assert.equal(manager.suspendPrimary(target, first), true);
	// The record still names the reloading session's channel, which no longer accepts connections.
	const record = readFileSync(primaryEndpointPath(root, target), "utf8");
	await channels[0]?.close();
	writeFileSync(primaryEndpointPath(root, target), record);
	const delivered: string[] = [];
	const registered = new Promise<void>((done) => {
		setTimeout(() => {
			void manager
				.registerPrimary(target, {
					signal: new AbortController().signal,
					cwd: root,
					send: (text) => delivered.push(text),
				})
				.then(done);
		}, 300);
	});
	const receipt = (await manager.control(
		"submit",
		{ sessionId: target, message: "sent while the old channel was gone", origin: "model" },
		{ id: sender, cwd: root },
	)) as { admitted?: boolean };
	await registered;
	assert.equal(receipt.admitted, true);
	assert.equal(delivered.length, 1);
});

test("a message that its primary took before the link closed and the session ended is reported unconfirmed", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-ack-lost-")));
	const target = randomUUID();
	const sender = randomUUID();
	const first = new AbortController();
	const taken: string[] = [];
	let markClosed!: () => void;
	const closed = new Promise<void>((done) => {
		markClosed = done;
	});
	const manager: AgentManager = new AgentManager({
		root,
		agentDir: root,
		packageDir: root,
		createPrimary: async (options) => {
			if (options.id !== target) return createPrimaryChannel(options);
			// The primary takes the message, then its session ends before the answer leaves.
			const channel = await createPrimaryChannel({
				...options,
				deliver: async (message) => {
					await options.deliver(message);
					void manager.closePrimary(target, first.signal);
					await closed;
					throw new Error("the ended session answered");
				},
			});
			const close = channel.close;
			channel.close = () => {
				const closing = close();
				markClosed();
				return closing;
			};
			return channel;
		},
	});
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	await manager.registerPrimary(sender, { signal: new AbortController().signal, cwd: root, send() {} });
	await manager.registerPrimary(target, {
		signal: first.signal,
		cwd: root,
		send: (_text, _details, sourceId) => taken.push(sourceId),
	});
	const outcome = await manager
		.control(
			"submit",
			{ sessionId: target, message: "taken before the end", origin: "model", requestId: "source-taken" },
			{ id: sender, cwd: root },
		)
		.then(
			() => "admitted",
			(error: Error) => error.message,
		);
	assert.deepEqual(taken, ["source-taken"]);
	assert.doesNotMatch(outcome, /not delivered/u);
	assert.match(outcome, /is unconfirmed: .* and then the session ended\. .*source ID source-taken/u);
});

test("a message whose request timed out is sent once more and confirmed by the same primary", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-ack-timeout-")));
	const target = randomUUID();
	const sender = randomUUID();
	const taken = new Set<string>();
	let calls = 0;
	let answerLate!: () => void;
	const late = new Promise<void>((done) => {
		answerLate = done;
	});
	const manager = new AgentManager({
		root,
		agentDir: root,
		packageDir: root,
		createPrimary: async (options) => {
			if (options.id !== target) return createPrimaryChannel(options);
			return createPrimaryChannel({
				...options,
				// The first request is taken and answered only after its deadline; the repeat of its source identity is
				// answered at once.
				deliver: async (message) => {
					await options.deliver(message);
					if (++calls === 1) await late;
				},
			});
		},
	});
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	await manager.registerPrimary(sender, { signal: new AbortController().signal, cwd: root, send() {} });
	await manager.registerPrimary(target, {
		signal: new AbortController().signal,
		cwd: root,
		// The receiving inbox admits one source identity once.
		send: (_text, _details, sourceId) => taken.add(sourceId),
	});
	const receipt = (await manager.control(
		"submit",
		{ sessionId: target, message: "slow to answer", origin: "model", requestId: "source-slow" },
		{ id: sender, cwd: root },
	)) as { admitted?: boolean; sourceId?: string };
	answerLate();
	assert.equal(calls, 2);
	assert.equal(receipt.admitted, true);
	assert.equal(receipt.sourceId, "source-slow");
	assert.deepEqual([...taken], ["source-slow"]);
});

test("a wall-clock step during the reload wait does not end the wait of a message", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "primary-reload-clock-")));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const sender = randomUUID();
	const target = randomUUID();
	await manager.registerPrimary(sender, { signal: new AbortController().signal, cwd: root, send() {} });
	const first = new AbortController();
	await manager.registerPrimary(target, { signal: first.signal, cwd: root, send() {} });
	assert.equal(manager.suspendPrimary(target, first), true);
	// The wall clock steps one hour forward while the message waits for the next registration.
	const wall = Date.now.bind(Date);
	let stepped = false;
	t.mock.method(Date, "now", () => wall() + (stepped ? 3_600_000 : 0));
	setTimeout(() => {
		stepped = true;
	}, 100);
	const delivered: string[] = [];
	const registered = new Promise<void>((done) => {
		setTimeout(() => {
			void manager
				.registerPrimary(target, {
					signal: new AbortController().signal,
					cwd: root,
					send: (text) => delivered.push(text),
				})
				.then(done);
		}, 400);
	});
	const receipt = (await manager.control(
		"submit",
		{ sessionId: target, message: "sent across a clock step", origin: "model" },
		{ id: sender, cwd: root },
	)) as { admitted?: boolean };
	await registered;
	assert.equal(receipt.admitted, true);
	assert.equal(delivered.length, 1);
});
