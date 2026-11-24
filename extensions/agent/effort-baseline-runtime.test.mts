import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { type AssistantMessage, type Context, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { EFFORT_BASELINE_ENTRY, EFFORT_UPDATE_MESSAGE } from "./effort-baseline.ts";
import register from "./index.ts";
import { PRIMARY_ENDPOINT_VERSION, primaryEndpointPath } from "./primary-channel.ts";
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

/** One isolated agent directory, sessions root and working directory, with environment restored after. */
function isolated(t: TestContext) {
	const parent = realpathSync(tmpdir());
	// Short private parents keep the canonical root within the primary socket path bound.
	const root = realpathSync(mkdtempSync(join(Buffer.byteLength(parent) <= 28 ? parent : realpathSync("/tmp"), "b-")));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	for (const path of [cwd, agentDir, sessionsRoot]) mkdirSync(path);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } }),
	);
	const harnessFile = join(agentDir, "harness.json");
	writeFileSync(harnessFile, JSON.stringify(machineConfig({ presets: {} })));
	const keys = ["PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_SESSIONS_DIR", "PI_HARNESS_FILE"];
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = sessionsRoot;
	process.env.PI_HARNESS_FILE = harnessFile;
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, { close(): Promise<void> }> }>)[
		Symbol.for("pi.extension.agent.owners")
	];
	t.after(async () => {
		await owners?.managers.get(sessionsRoot)?.close();
		owners?.managers.delete(sessionsRoot);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	return { cwd, agentDir, sessionsRoot };
}

async function openSession(
	t: TestContext,
	paths: ReturnType<typeof isolated>,
	sessionManager: SessionManager,
	requests: Context[],
): Promise<AgentSession> {
	const { cwd, agentDir } = paths;
	const runtime = await createTestRuntime();
	const stream = (_model: unknown, context: Context) => {
		requests.push(structuredClone(context));
		return completed();
	};
	runtime.registerNativeProvider({
		id: testModel.provider,
		name: "Awareness fixture",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [register],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		settingsManager,
		sessionManager,
		model: testModel,
		resourceLoader: loader,
		tools: [],
	});
	await session.bindExtensions({});
	t.after(async () => {
		await session.abort();
		session.dispose();
	});
	return session;
}

/** A live peer session in the same working directory, as its endpoint record publishes it. */
function publishPeer(sessionsRoot: string, cwd: string, id: string, name: string): void {
	writeFileSync(
		primaryEndpointPath(sessionsRoot, id),
		JSON.stringify({
			id,
			version: PRIMARY_ENDPOINT_VERSION,
			serverId: randomUUID(),
			cwd,
			hostname: hostname(),
			pid: process.pid,
			socketPath: join(sessionsRoot, "missing.sock"),
			startedAt: new Date().toISOString(),
			name,
		}),
	);
}

type Messages = Context["messages"];
const sectionPatches = (messages: Messages) =>
	messages.filter(
		(message) =>
			message.role === "system" &&
			(message as { sections?: Record<string, unknown> }).sections?.["agent-efforts"] !== undefined,
	).length;
const updateTexts = (messages: Messages) =>
	messages.flatMap((message) =>
		message.role === "user" && Array.isArray(message.content)
			? message.content.flatMap((part) =>
					part.type === "text" && part.text.startsWith("<agent-efforts-update>") ? [part.text] : [],
				)
			: [],
	);

it("keeps the agent-efforts section between runs and sends a changed peer as one hidden update", {
	timeout: 30000,
}, async (t) => {
	const paths = isolated(t);
	const requests: Context[] = [];
	const sessionManager = SessionManager.create(paths.cwd, paths.sessionsRoot);
	const session = await openSession(t, paths, sessionManager, requests);
	const prompt = async (text: string) => {
		await session.prompt(text);
		await session.waitForIdle();
	};
	await prompt("First task");
	const baselines = () =>
		sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === EFFORT_BASELINE_ENTRY);
	assert.equal(baselines().length, 1);
	assert.equal(sectionPatches(requests[0].messages), 1);
	await prompt("Second task");
	assert.equal(sectionPatches(requests[1].messages), 1, "an unchanged run adds no section patch");
	assert.deepEqual(updateTexts(requests[1].messages), []);

	const peer = randomUUID();
	publishPeer(paths.sessionsRoot, paths.cwd, peer, "Peer ledger work");
	await prompt("Third task");
	assert.equal(sectionPatches(requests[2].messages), 1, "a peer that starts never patches the section");
	const [update] = updateTexts(requests[2].messages);
	assert.match(update ?? "", new RegExp(`Related effort: \\{"id":"${peer}"`, "u"));
	const hidden = sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === EFFORT_UPDATE_MESSAGE);
	assert.equal(hidden.length, 1);
	assert.equal((hidden[0] as { display?: boolean }).display, false, "the update is not shown in the transcript");
	assert.equal(baselines().length, 1);
	await prompt("Fourth task");
	assert.equal(updateTexts(requests[3].messages).length, 1, "the update stays in place and is not repeated");
	assert.ok(
		JSON.stringify(requests[3].messages).startsWith(JSON.stringify(requests[2].messages).slice(0, -1)),
		"each request extends the previous one",
	);

	unlinkSync(primaryEndpointPath(paths.sessionsRoot, peer));
	await prompt("Fifth task");
	const updates = updateTexts(requests[4].messages);
	assert.equal(updates.length, 2);
	assert.match(updates[1], new RegExp(`Related effort removed: \\{"id":"${peer}"\\}`, "u"));
	assert.equal(sectionPatches(requests[4].messages), 1);
});

it("restores the branch's section on resume so the prompt keeps its bytes", { timeout: 30000 }, async (t) => {
	const paths = isolated(t);
	const requests: Context[] = [];
	const first = SessionManager.create(paths.cwd, paths.sessionsRoot);
	const session = await openSession(t, paths, first, requests);
	await session.prompt("First task");
	await session.waitForIdle();
	const file = first.getSessionFile();
	assert.ok(file);
	await session.abort();
	session.dispose();
	publishPeer(paths.sessionsRoot, paths.cwd, randomUUID(), "Started while away");
	const resumed = await openSession(t, paths, SessionManager.open(file, paths.sessionsRoot), requests);
	await resumed.prompt("Resumed task");
	await resumed.waitForIdle();
	const last = requests.at(-1)?.messages ?? [];
	assert.equal(sectionPatches(last), 1, "the resumed run keeps the stored section");
	assert.equal(updateTexts(last).length, 1, "the peer that started meanwhile arrives as an update");
});

it("derives what the model saw from the branch after tree navigation", { timeout: 30000 }, async (t) => {
	const paths = isolated(t);
	const requests: Context[] = [];
	const sessionManager = SessionManager.create(paths.cwd, paths.sessionsRoot);
	const session = await openSession(t, paths, sessionManager, requests);
	await session.prompt("First task");
	await session.waitForIdle();
	const before = sessionManager.getLeafId();
	assert.ok(before);
	const peer = randomUUID();
	publishPeer(paths.sessionsRoot, paths.cwd, peer, "Peer ledger work");
	await session.prompt("Second task");
	await session.waitForIdle();
	assert.equal(updateTexts(requests[1].messages).length, 1);
	await session.navigateTree(before);
	await session.prompt("Other branch");
	await session.waitForIdle();
	const last = requests.at(-1)?.messages ?? [];
	const updates = updateTexts(last);
	assert.equal(updates.length, 1, "the branch that never saw the peer gets it as its own update");
	assert.match(updates[0], new RegExp(`Related effort: \\{"id":"${peer}"`, "u"));
	assert.equal(sectionPatches(last), 1);
});
