import assert from "node:assert/strict";
import { it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readPrimaryEndpointDescriptor } from "./primary-channel.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { declareContinuityTools } from "./continuity-tools.ts";
import { AGENT_ENTRY_CHANNEL, type AgentEntryRequest } from "./entry-binding.ts";
import register from "./index.ts";

interface Declaration {
	name: string;
	act: "compaction" | "worker-resolution" | "work-completion";
	accepts?: (input: unknown) => boolean;
}

function declarations(events: ExtensionAPI["events"]): Declaration[] {
	const tools: Declaration[] = [];
	events.emit("harness:continuity-tools", { version: 1, declare: (tool: Declaration) => tools.push(tool) });
	return tools;
}

function predicates(events: ExtensionAPI["events"]): Map<string, (input: unknown) => boolean> {
	return new Map(declarations(events).flatMap((tool) => tool.accepts ? [[tool.name, tool.accepts] as const] : []));
}

function fixture() {
	const events = createEventBus();
	const tools: string[] = [];
	const pi = {
		events, on() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {},
		registerTool(tool: { name: string }) { tools.push(tool.name); },
	} as unknown as ExtensionAPI;
	return { pi, events, tools };
}

const DECLARED = ["agent_compact", "agent_abort", "agent_steer", "agent_send", "agent_work"];
/** An ordinary session declares no work, so its `agent_work` completes none. */
const ORDINARY_DECLARED = DECLARED.filter((name) => name !== "agent_work");

it("declares whole-tool compaction, the owned worker-resolution tools and work completion synchronously", () => {
	const { pi, events } = fixture();
	declareContinuityTools(pi, "native");
	assert.deepEqual(declarations(events).map(({ name, act }) => ({ name, act })), [
		{ name: "agent_compact", act: "compaction" },
		{ name: "agent_abort", act: "worker-resolution" },
		{ name: "agent_steer", act: "worker-resolution" },
		{ name: "agent_send", act: "worker-resolution" },
		{ name: "agent_work", act: "work-completion" },
	]);
	assert.equal(Object.hasOwn(declarations(events)[0], "accepts"), false);
	assert.notEqual(declarations(events)[1], declarations(events)[1], "each request gets fresh declarations");
});

it("ignores malformed protocol requests and unknown versions", () => {
	let calls = 0;
	const { pi, events } = fixture();
	declareContinuityTools(pi, "native");
	for (const input of [undefined, null, 1, "x", [], {}, { version: 2, declare: () => calls++ }, { version: "1", declare: () => calls++ }, { version: 1 }, { version: 1, declare: 1 }]) {
		assert.doesNotThrow(() => events.emit("harness:continuity-tools", input));
	}
	assert.equal(calls, 0);
});

const targetId = "10000000-0000-4000-8000-000000000001";
it("accepts canonical bounded abort, steer and active or passive report shapes", () => {
	const { pi, events } = fixture();
	declareContinuityTools(pi, "native");
	const accept = predicates(events);
	for (const input of [
		{ sessionId: targetId }, { sessionId: `${targetId}:2`, background: true },
		{ sessionId: targetId, release: true }, { sessionId: targetId, release: true, background: false },
		{ sessionId: targetId, timerId: 1 }, { sessionId: targetId, timerId: Number.MAX_SAFE_INTEGER, background: true, release: false },
	]) assert.equal(accept.get("agent_abort")?.(input), true, JSON.stringify(input));
	for (const input of [{ sessionId: targetId, message: "stop" }, { sessionId: targetId, message: "x".repeat(8000), replyTo: `${targetId}:3` }]) assert.equal(accept.get("agent_steer")?.(input), true);
	for (const passive of [undefined, false, true]) {
		const input = { sessionId: targetId, message: "x".repeat(8000), mode: "report", ...(passive === undefined ? {} : { passive }) };
		assert.equal(accept.get("agent_send")?.(input), true);
	}
});

it("refuses unknown, future, scheduling, spawn, follow-up and malformed argument forms", () => {
	const { pi, events } = fixture();
	declareContinuityTools(pi, "native");
	const accept = predicates(events);
	for (const name of ["agent_abort", "agent_steer", "agent_send"]) {
		const valid = name === "agent_abort" ? { sessionId: targetId } : name === "agent_steer" ? { sessionId: targetId, message: "x" } : { sessionId: targetId, message: "x", mode: "report" };
		for (const input of [undefined, null, true, 1, "x", [], {}, ...["", "@worker", "s", `${targetId}:1`, `${targetId}:02`, `${targetId}:9007199254740992`, "s".repeat(257), 1].map((sessionId) => ({ ...valid, sessionId })), Object.create({ ...valid })]) assert.equal(accept.get(name)?.(input), false, name);
		for (const field of ["unknown", ...(name === "agent_send" ? [] : ["passive"]), "deliverAt", "checkInMinutes", "prompt", "cwd", "model", "spawn"]) {
			assert.equal(accept.get(name)?.({ ...valid, [field]: true }), false, `${name}: ${field}`);
		}
		assert.equal(accept.get(name)?.({ ...valid, [Symbol("unknown")]: true }), false);
		assert.equal(accept.get(name)?.(Object.defineProperty({ ...valid }, "unknown", { value: true })), false);
		assert.equal(accept.get(name)?.(Object.defineProperty({ ...valid }, "sessionId", { enumerable: true, get() { throw new Error("getter must not run"); } })), false);
	}
});

it("accepts only the complete form of native agent_work with its required fields", () => {
	const { pi, events } = fixture();
	declareContinuityTools(pi, "native");
	const accept = predicates(events).get("agent_work");
	assert.ok(accept);
	const valid = { action: "complete", request: "spawn:owner:call/1", status: "done", message: "The result." };
	for (const input of [valid, { ...valid, status: "failed" }, { ...valid, request: "r".repeat(1024), message: "m".repeat(100_000) }]) assert.equal(accept(input), true);
	for (const patch of [
		{ action: "continue" }, { action: undefined }, { request: undefined }, { request: "" }, { request: "r".repeat(1025) }, { request: 1 },
		{ status: undefined }, { status: "stopped" }, { status: "reset" }, { message: undefined }, { message: "" }, { message: "m".repeat(100_001) },
		{ results: [] }, { note: "waiting" }, { prompt: "x" },
	]) assert.equal(accept({ ...valid, ...patch }), false, JSON.stringify(patch));
	for (const field of ["request", "status", "message"]) {
		const missing: Record<string, unknown> = { ...valid };
		delete missing[field];
		assert.equal(accept(missing), false, field);
	}
	assert.equal(accept({ action: "continue", results: [], note: "waiting" }), false);
	for (const input of [undefined, null, "complete", [], Object.create(valid)]) assert.equal(accept(input), false);
	assert.equal(accept(Object.defineProperty({ ...valid }, "message", { enumerable: true, get() { throw new Error("getter must not run"); } })), false);
});

it("declares no work-completion tool for an ordinary session", () => {
	const { pi, events } = fixture();
	declareContinuityTools(pi, "ordinary");
	assert.deepEqual(declarations(events).map((tool) => tool.name), ORDINARY_DECLARED);
	assert.deepEqual(declarations(events).filter((tool) => tool.act === "work-completion"), [], "the state note of an ordinary session is no declared work");
	assert.equal(predicates(events).get("agent_work"), undefined);
});

it("refuses invalid abort flags and combinations", () => {
	const { pi, events } = fixture();
	declareContinuityTools(pi, "native");
	const accept = predicates(events);
	for (const patch of [
		{ trust: true }, { background: 1 }, { release: "true" },
		{ timerId: 0 }, { timerId: 1.5 }, { timerId: Number.MAX_SAFE_INTEGER + 1 },
		{ timerId: Infinity }, { timerId: undefined },
		{ release: true, background: true }, { release: true, timerId: 1 }, { message: "x" },
	]) assert.equal(accept.get("agent_abort")?.({ sessionId: targetId, ...patch }), false, JSON.stringify(patch));
});

it("refuses invalid messages, modes and reply targets", () => {
	const { pi, events } = fixture();
	declareContinuityTools(pi, "native");
	const accept = predicates(events);
	for (const name of ["agent_steer", "agent_send"]) {
		const valid = { sessionId: targetId, message: "x", ...(name === "agent_send" ? { mode: "report" } : {}) };
		for (const message of [undefined, null, 1, "", "x".repeat(8001)]) assert.equal(accept.get(name)?.({ ...valid, message }), false);
		for (const mode of [undefined, "followUp", "steer", "spawn"]) assert.equal(accept.get(name)?.({ ...valid, mode }), false);
	}
	for (const replyTo of [undefined, null, 1, "", "x".repeat(257)]) assert.equal(accept.get("agent_steer")?.({ sessionId: targetId, message: "x", replyTo }), false);
	for (const replyTo of [undefined, targetId]) assert.equal(accept.get("agent_send")?.({ sessionId: targetId, message: "x", mode: "report", replyTo }), false);
	for (const passive of [undefined, null, 1, "true"]) assert.equal(accept.get("agent_send")?.({ sessionId: targetId, message: "x", mode: "report", passive }), false);
});

it("declares only after successful ordinary registration", { timeout: 20000 }, async () => {
	const { pi, events, tools } = fixture();
	await register(pi);
	assert.deepEqual(declarations(events).map((tool) => tool.name), ORDINARY_DECLARED);
	for (const tool of declarations(events)) assert.ok(tools.includes(tool.name));
	const failed = fixture();
	failed.pi.registerTool = () => { throw new Error("registration failed"); };
	await assert.rejects(register(failed.pi), /registration failed/);
	assert.deepEqual(declarations(failed.events), []);
});

it("advertises only registered tools through the public ordinary resource loader", { timeout: 20000 }, async (t) => {
	const parent = realpathSync(tmpdir());
	// Keep short private TMPDIR parents; the canonical root must leave room for a UUID primary socket.
	const root = realpathSync(mkdtempSync(join(Buffer.byteLength(parent) <= 28 ? parent : realpathSync("/tmp"), "c-")));
	const cwd = join(root, "w");
	const agentDir = join(root, "a");
	const sessionsRoot = join(root, "s");
	for (const path of [cwd, agentDir, sessionsRoot]) mkdirSync(path);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", retry: { enabled: false } }));
	writeFileSync(join(agentDir, "harness.json"), "{}");
	const saved = new Map(["PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_SESSIONS_DIR", "PI_HARNESS_FILE"].map((key) => [key, process.env[key]]));
	Object.assign(process.env, { PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_SESSIONS_DIR: sessionsRoot, PI_HARNESS_FILE: join(agentDir, "harness.json") });
	let session: AgentSession | undefined;
	t.after(async () => {
		try {
			await session?.abort();
			const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, { close(): void | Promise<void> }> }>)[Symbol.for("pi.extension.agent.owners")];
			await owners.managers.get(sessionsRoot)?.close();
			owners.managers.delete(sessionsRoot);
			session?.dispose();
		} finally {
			for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
			rmSync(root, { recursive: true, force: true });
			assert.equal(existsSync(root), false);
		}
	});
	let events: ExtensionAPI["events"] | undefined;
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
		extensionFactories: [(pi) => { events = pi.events; }],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	assert.ok(events);
	const declared = declarations(events);
	assert.deepEqual(declared.map((tool) => tool.name), ORDINARY_DECLARED);
	const sessionManager = SessionManager.create(cwd, sessionsRoot);
	const socketDirectory = join(sessionsRoot, ".primaries");
	assert.ok(Buffer.byteLength(join(socketDirectory, `${sessionManager.getSessionId()}.sock`)) <= 100, "reject shared socket fallback before bind");
	session = (await createAgentSession({ cwd, agentDir, modelRuntime: await createTestRuntime(), model: testModel, settingsManager, sessionManager, resourceLoader })).session;
	await session.bindExtensions({});
	for (const declaration of declared) assert.ok(session.getAllTools().some((tool) => tool.name === declaration.name), declaration.name);
	const endpoint = readPrimaryEndpointDescriptor(sessionsRoot, sessionManager.getSessionId());
	assert.equal(endpoint.state, "live");
	assert.equal(endpoint.info?.socketPath.startsWith(`${socketDirectory}/`), true);
	t.diagnostic(`Private ordinary socket: ${endpoint.info?.socketPath}`);
});

it("declares only after successful native registration, not rejection or failure", { timeout: 20000 }, async () => {
	for (const outcome of ["success", "rejected", "failed"] as const) {
		const { pi, events } = fixture();
		let registered = false;
		events.on(AGENT_ENTRY_CHANNEL, (data) => {
			const request = data as AgentEntryRequest;
			request.result = outcome === "rejected" ? { kind: "rejected", reason: "unselected" } : {
				kind: "native", register: async () => {
					assert.deepEqual(declarations(events), []);
					await Promise.resolve();
					if (outcome === "failed") throw new Error("native failed");
					registered = true;
				},
			};
		});
		if (outcome === "success") {
			await register(pi);
			assert.equal(registered, true);
			assert.equal(declarations(events).length, 5);
			assert.equal(predicates(events).get("agent_work")?.({ action: "complete" }), false, "the native form");
		} else {
			await assert.rejects(register(pi), outcome === "rejected" ? /unselected/ : /native failed/);
			assert.equal(registered, false);
			assert.deepEqual(declarations(events), []);
		}
	}
});
