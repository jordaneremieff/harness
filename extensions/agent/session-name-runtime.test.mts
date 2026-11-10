import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { eventLog } from "./host-fixture.mts";
import { machineConfig } from "./settings-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

function answer(): AssistantMessage {
	return {
		role: "assistant", api: testModel.api, provider: testModel.provider, model: testModel.id,
		content: [{ type: "text", text: "Fixture answer" }], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function nextSettlement(session: AgentSession): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			unsubscribe();
			resolve();
		});
	});
}

function completed() {
	const message = answer();
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: message });
	events.push({ type: "done", reason: "stop", message });
	events.end(message);
	return events;
}

async function namingFixture(t: TestContext, options: { retainedName?: string } = {}) {
	const root = realpathSync(mkdtempSync("/tmp/pi-name-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(sessionsRoot);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } }));
	const harnessFile = join(agentDir, "harness.json");
	writeFileSync(harnessFile, JSON.stringify(machineConfig({ presets: {} })));
	const saved = new Map(["PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_SESSIONS_DIR", "PI_HARNESS_FILE"].map((key) => [key, process.env[key]]));
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = sessionsRoot;
	process.env.PI_HARNESS_FILE = harnessFile;
	let session: AgentSession | undefined;
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, { close(): void }> }>)[Symbol.for("pi.extension.agent.owners")];
	t.after(async () => {
		try {
			try {
				await session?.abort();
			} finally {
				owners.managers.get(sessionsRoot)?.close();
				owners.managers.delete(sessionsRoot);
				session?.dispose();
			}
		} finally {
			for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
			rmSync(root, { recursive: true, force: true });
		}
	});
	let sessionManager = SessionManager.create(cwd, sessionsRoot);
	if (options.retainedName !== undefined) {
		sessionManager.appendSessionInfo(options.retainedName);
		sessionManager.appendMessage({ role: "user", content: "Earlier task", timestamp: Date.now() });
		const path = sessionManager.getSessionFile();
		assert.ok(path);
		sessionManager = SessionManager.open(path, sessionsRoot);
		assert.equal(sessionManager.getSessionName(), options.retainedName);
	}
	const runtime = await createTestRuntime();
	runtime.registerNativeProvider({
		id: testModel.provider, name: "Naming fixture", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: completed, streamSimple: completed,
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const changes = eventLog<string | undefined>();
	const started: Array<string | undefined> = [];
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../evo/index.ts", import.meta.url))],
		extensionFactories: [async (pi) => {
			await register(pi);
			pi.on("session_info_changed", (event) => { changes.push(event.name); });
			pi.on("before_agent_start", () => { started.push(pi.getSessionName()); });
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	session = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, sessionManager, model: testModel, resourceLoader: loader, tools: [] })).session;
	await session.bindExtensions({});
	const opened = session;
	const manager = sessionManager;
	return {
		get session() { return session ?? opened; },
		sessionManager: manager,
		changes,
		started,
		async prompt(text: string, options?: { source?: "interactive" | "rpc" | "extension" }) {
			await session?.prompt(text, options);
			await session?.waitForIdle();
		},
		/** Run a registered command and wait for the turn it starts. */
		async command(text: string) {
			const current = session ?? opened;
			const done = nextSettlement(current);
			await current.prompt(text);
			await done;
		},
	};
}

it("names an unnamed session from its first interactive input and says nothing after it", { timeout: 20000 }, async (t) => {
	const fixture = await namingFixture(t);
	assert.equal(fixture.sessionManager.getSessionName(), undefined);
	await fixture.prompt("Fix the parser bug");
	assert.equal(fixture.sessionManager.getSessionName(), "Fix the parser bug");
	await fixture.changes.waitForCount(1);
	assert.deepEqual([...fixture.changes], ["Fix the parser bug"]);
	assert.deepEqual(fixture.started, ["Fix the parser bug"], "the name exists before agent processing");
	await fixture.prompt("Rename it to something else");
	assert.equal(fixture.sessionManager.getSessionName(), "Fix the parser bug");
	assert.equal(fixture.changes.length, 1);
	assert.deepEqual(fixture.started, ["Fix the parser bug", "Fix the parser bug"]);
});

it("keeps a name set before input and a resumed session name", { timeout: 20000 }, async (t) => {
	const explicit = await namingFixture(t);
	explicit.session.setSessionName("Explicit name");
	await explicit.changes.waitForCount(1);
	await explicit.prompt("A new task");
	assert.equal(explicit.sessionManager.getSessionName(), "Explicit name");
	assert.equal(explicit.changes.length, 1);
	const resumed = await namingFixture(t, { retainedName: "Retained name" });
	await resumed.prompt("Another new task");
	assert.equal(resumed.sessionManager.getSessionName(), "Retained name");
	assert.equal(resumed.changes.length, 0);
});

it("keeps a later explicit name after automatic naming", { timeout: 20000 }, async (t) => {
	const fixture = await namingFixture(t);
	await fixture.prompt("First task text");
	await fixture.changes.waitForCount(1);
	fixture.session.setSessionName("Operator name");
	await fixture.changes.waitForCount(2);
	await fixture.prompt("Second task text");
	assert.equal(fixture.sessionManager.getSessionName(), "Operator name");
	assert.equal(fixture.changes.length, 2);
});

it("does not name from rpc or extension input", { timeout: 20000 }, async (t) => {
	const fixture = await namingFixture(t);
	await fixture.prompt("Generated input", { source: "rpc" });
	await fixture.prompt("Extension input", { source: "extension" });
	assert.equal(fixture.sessionManager.getSessionName(), undefined);
	assert.equal(fixture.changes.length, 0);
	await fixture.prompt("Real task input");
	assert.equal(fixture.sessionManager.getSessionName(), "Real task input");
});

it("names from slash-command arguments and not from a command alone", { timeout: 20000 }, async (t) => {
	const fixture = await namingFixture(t);
	await fixture.prompt("/x");
	assert.equal(fixture.sessionManager.getSessionName(), undefined);
	await fixture.prompt("/skill:demo repair the parser");
	assert.equal(fixture.sessionManager.getSessionName(), "repair the parser");
	assert.equal(fixture.changes.length, 1);
});

it("names an unnamed session from a registered command direction before its turn", { timeout: 30000 }, async (t) => {
	const fixture = await namingFixture(t);
	await fixture.command("/evo Repair the parser");
	assert.equal(fixture.sessionManager.getSessionName(), "Repair the parser");
	assert.deepEqual([...fixture.changes], ["Repair the parser"]);
	assert.deepEqual(fixture.started, ["Repair the parser"], "the name exists before agent processing");
});

it("uses substantive command content after a section heading", { timeout: 30000 }, async (t) => {
	const fixture = await namingFixture(t);
	await fixture.command(
		"/evo # Outcome\n\nRepair four confirmed defects in Pi session naming and Rex tab labels in https://github.com/example/harness. Implement, verify, commit.",
	);
	assert.equal(fixture.sessionManager.getSessionName(), "Repair four confirmed defects in Pi session");
	assert.equal(fixture.changes.length, 1);
});

it("keeps an explicit or resumed name at command admission", { timeout: 30000 }, async (t) => {
	const explicit = await namingFixture(t);
	explicit.session.setSessionName("Explicit name");
	await explicit.changes.waitForCount(1);
	await explicit.command("/evo Repair the parser");
	assert.equal(explicit.sessionManager.getSessionName(), "Explicit name");
	assert.equal(explicit.changes.length, 1);
	const resumed = await namingFixture(t, { retainedName: "Retained name" });
	await resumed.command("/evo Repair the parser");
	assert.equal(resumed.sessionManager.getSessionName(), "Retained name");
	assert.equal(resumed.changes.length, 0);
});

it("keeps the first automatic name across later commands", { timeout: 30000 }, async (t) => {
	const fixture = await namingFixture(t);
	await fixture.command("/evo Repair the parser");
	await fixture.command("/evo Update the release notes");
	assert.equal(fixture.sessionManager.getSessionName(), "Repair the parser");
	assert.equal(fixture.changes.length, 1);
});

it("keeps a later explicit name across command and interactive input", { timeout: 30000 }, async (t) => {
	const fixture = await namingFixture(t);
	await fixture.command("/evo Repair the parser");
	fixture.session.setSessionName("Operator choice");
	await fixture.changes.waitForCount(2);
	await fixture.command("/evo Update the release notes");
	await fixture.prompt("Another task");
	assert.equal(fixture.sessionManager.getSessionName(), "Operator choice");
	assert.equal(fixture.changes.length, 2);
});

it("leaves an unnamed session unnamed for a direction-free command", { timeout: 30000 }, async (t) => {
	const fixture = await namingFixture(t);
	await fixture.command("/evo");
	assert.equal(fixture.sessionManager.getSessionName(), undefined);
	assert.equal(fixture.changes.length, 0);
});
