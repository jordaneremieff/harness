import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { EFFORT_PURPOSE_ENTRY } from "./effort-purpose.ts";
import { AgentManager } from "./manager.ts";
import { primaryEndpointPath } from "./primary-channel.ts";
import { WORK_REFERENCE_EVENT, WORK_REFERENCES_ENTRY } from "./work-references.ts";
import { machineConfig } from "./settings-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

// Pi offline mode keeps loaded extensions from automatic network reads during these tests.
process.env.PI_OFFLINE = "1";

function completed() {
	const message: AssistantMessage = {
		role: "assistant",
		api: testModel.api,
		provider: testModel.provider,
		model: testModel.id,
		content: [{ type: "text", text: "Fixture answer" }],
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: message });
	events.push({ type: "done", reason: "stop", message });
	events.end(message);
	return events;
}

async function primaryFixture(t: TestContext) {
	const parent = realpathSync(tmpdir());
	// Keep short private TMPDIR parents; the canonical root must leave room for a UUID primary socket.
	const root = realpathSync(mkdtempSync(join(Buffer.byteLength(parent) <= 28 ? parent : realpathSync("/tmp"), "p-")));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(sessionsRoot);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } }),
	);
	const harnessFile = join(agentDir, "harness.json");
	writeFileSync(harnessFile, JSON.stringify(machineConfig({ presets: {} })));
	const saved = new Map(
		["PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_SESSIONS_DIR", "PI_HARNESS_FILE"].map((key) => [
			key,
			process.env[key],
		]),
	);
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = sessionsRoot;
	process.env.PI_HARNESS_FILE = harnessFile;
	let session: AgentSession | undefined;
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, { close(): void }> }>)[
		Symbol.for("pi.extension.agent.owners")
	];
	t.after(async () => {
		try {
			try {
				await session?.abort();
			} finally {
				await owners.managers.get(sessionsRoot)?.close();
				owners.managers.delete(sessionsRoot);
				session?.dispose();
			}
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
	const sessionManager = SessionManager.create(cwd, sessionsRoot);
	const runtime = await createTestRuntime();
	runtime.registerNativeProvider({
		id: testModel.provider,
		name: "Purpose fixture",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: completed,
		streamSimple: completed,
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const nameChanges: Array<string | undefined> = [];
	let emit: (channel: string, data: unknown) => void = () => {};
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			async (pi) => {
				await register(pi);
				emit = (channel, data) => pi.events.emit(channel, data);
				pi.on("session_info_changed", (event) => {
					nameChanges.push(event.name);
				});
			},
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.ok(
		Buffer.byteLength(join(sessionsRoot, ".primaries", `${sessionManager.getSessionId()}.sock`)) <= 100,
		"fixture primary socket must remain in its private root",
	);
	session = (
		await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			settingsManager,
			sessionManager,
			model: testModel,
			resourceLoader: loader,
			tools: [],
		})
	).session;
	await session.bindExtensions({});
	const opened = session;
	return {
		sessionManager,
		nameChanges,
		purposeEntries: () =>
			sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "custom" && entry.customType === EFFORT_PURPOSE_ENTRY ? [entry.data] : [])),
		workEntries: () =>
			sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === WORK_REFERENCES_ENTRY ? [entry.data] : [],
				),
		emit: (data: unknown) => emit(WORK_REFERENCE_EVENT, data),
		endpoint: () =>
			JSON.parse(readFileSync(primaryEndpointPath(sessionsRoot, sessionManager.getSessionId()), "utf8")) as {
				workRefs?: unknown;
				observedPurpose?: unknown;
			},
		async prompt(text: string, options?: { source?: "interactive" | "rpc" | "extension" }) {
			await opened.prompt(text, options);
			await opened.waitForIdle();
		},
		/** A run that a custom message starts; Pi emits no input event for it. */
		async kickoff(text: string) {
			await opened.sendCustomMessage(
				{ customType: "fixture.kickoff", content: text, display: true, details: undefined },
				{ triggerTurn: true },
			);
			await opened.waitForIdle();
		},
		navigate: (targetId: string) => opened.navigateTree(targetId),
	};
}

it("records only the first interactive input as observed purpose and leaves the session unnamed", {
	timeout: 20000,
}, async (t) => {
	const fixture = await primaryFixture(t);
	await fixture.prompt("Real task input");
	await fixture.prompt("Later task input");
	await fixture.prompt("Extension input", { source: "extension" });
	assert.deepEqual(fixture.purposeEntries(), [{ source: "interactive", text: "Real task input" }]);
	assert.deepEqual(fixture.endpoint().observedPurpose, { source: "interactive-input", text: "Real task input" });
	assert.equal(fixture.sessionManager.getSessionName(), undefined, "input never names the session");
	assert.deepEqual(fixture.nameChanges, []);
});

it("records no observed purpose after a run that a custom message started", { timeout: 20000 }, async (t) => {
	const fixture = await primaryFixture(t);
	await fixture.kickoff("Start the review from the handover");
	await fixture.prompt("did you see that");
	assert.deepEqual(fixture.purposeEntries(), [], "the typed message follows the kickoff run's history");
	assert.equal(fixture.endpoint().observedPurpose, undefined);
});

it("keeps capture closed when a retained manager of an earlier release would leave it open", {
	timeout: 20000,
}, async (t) => {
	// An earlier release closed capture only for interactive input; a /reload can hand that manager to this entry.
	const current = AgentManager.prototype.recordPrimaryInput;
	t.mock.method(
		AgentManager.prototype,
		"recordPrimaryInput",
		function (this: AgentManager, ownerId: string, text: string, source: string) {
			return source === "interactive" ? current.call(this, ownerId, text, source) : false;
		},
	);
	const fixture = await primaryFixture(t);
	await fixture.prompt("Generated start of the work", { source: "extension" });
	await fixture.prompt("did you see that");
	assert.deepEqual(fixture.purposeEntries(), []);
	assert.equal(fixture.endpoint().observedPurpose, undefined);
});

for (const source of ["extension", "rpc"] as const)
	it(`records no observed purpose when the first input came from ${source === "rpc" ? "a client" : "an extension"}`, {
		timeout: 20000,
	}, async (t) => {
		// A handover pickup or a command's kickoff starts the session; the operator types a correction later.
		const fixture = await primaryFixture(t);
		await fixture.prompt("Generated start of the work", { source });
		await fixture.prompt("did you get my note");
		assert.deepEqual(fixture.purposeEntries(), [], "a later typed message is not the first request");
		assert.equal(fixture.endpoint().observedPurpose, undefined);
	});

it("retains and publishes the work items that producers report for this session only", {
	timeout: 20000,
}, async (t) => {
	const fixture = await primaryFixture(t);
	const sessionId = fixture.sessionManager.getSessionId();
	fixture.emit({ version: 1, sessionId, kind: "document", id: "md-a", title: "Design" });
	fixture.emit({ version: 1, sessionId: "another-session", kind: "document", id: "md-b" });
	fixture.emit({ version: 2, sessionId, kind: "document", id: "md-c" });
	fixture.emit({ version: 1, sessionId, kind: "handover", id: "plan" });
	fixture.emit({ version: 1, sessionId, kind: "document", id: "md-a" });
	const refs = [
		{ kind: "handover", id: "plan" },
		{ kind: "document", id: "md-a", title: "Design" },
	];
	assert.deepEqual(fixture.workEntries(), [{ refs: [{ kind: "document", id: "md-a", title: "Design" }] }, { refs }]);
	assert.deepEqual(fixture.endpoint().workRefs, refs);
	await fixture.prompt("Review the design");
	assert.deepEqual(fixture.endpoint().observedPurpose, { source: "interactive-input", text: "Review the design" });
});

it("replaces the published work items with the branch's own copy after tree navigation", {
	timeout: 20000,
}, async (t) => {
	const fixture = await primaryFixture(t);
	const sessionId = fixture.sessionManager.getSessionId();
	await fixture.prompt("Start the review");
	const before = fixture.sessionManager.getLeafId();
	assert.ok(before);
	fixture.emit({ version: 1, sessionId, kind: "document", id: "md-a", title: "Design" });
	await fixture.prompt("Continue on the design");
	assert.deepEqual(fixture.endpoint().workRefs, [{ kind: "document", id: "md-a", title: "Design" }]);
	await fixture.navigate(before);
	assert.equal(fixture.endpoint().workRefs, undefined, "the earlier branch used no item");
	fixture.emit({ version: 1, sessionId, kind: "handover", id: "plan" });
	assert.deepEqual(fixture.workEntries().at(-1), { refs: [{ kind: "handover", id: "plan" }] });
	assert.deepEqual(fixture.endpoint().workRefs, [{ kind: "handover", id: "plan" }]);
});
