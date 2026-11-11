import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CAPACITY_REQUEST, CAPACITY_STATE, capacityTurnEnd, readCapacityState } from "./capacity.ts";
import registerStash from "./index.ts";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { listStashes } from "./store.ts";

const config = { enabled: true, checkpointPercent: 60, decisionPercent: 70, stopPercent: 95 };

async function runtime(t: TestContext, options: { stash?: boolean; abortAtBoundary?: boolean; gate?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "stash-capacity-runtime-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const savedContext = ["PI_CODING_AGENT_DIR", "PI_HARNESS_FILE"].map((key) => [key, process.env[key]] as const);
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_HARNESS_FILE = join(root, "agent", "harness.json");
	t.after(() => {
		for (const [key, value] of savedContext) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const faux = fauxProvider({
		provider: "capacity-fixture",
		models: [{ id: "fixture", contextWindow: 10_000, maxTokens: 512 }],
		tokenSize: { min: 64, max: 64 },
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	let usageTokens = 100;
	let session: AgentSession;
	const errors: string[] = [];
	const executed: string[] = [];
	const fixture: ExtensionFactory = (pi) => {
		// The fixture controls reported provider usage through Pi's message replacement contract.
		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			return {
				message: {
					...event.message,
					usage: {
						input: usageTokens,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: usageTokens,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			};
		});
		if (options.abortAtBoundary) {
			pi.on("turn_end", () => {
				session.agent.abort();
			});
		}
		if (options.gate) {
			pi.events.on("harness:continuity-tools", (value) => {
				const request = value as { declare(tool: { name: string; act: string; accepts?: (input: unknown) => boolean }): void };
				request.declare({ name: "fake_compact", act: "compaction" });
				request.declare({ name: "fake_resolve", act: "worker-resolution", accepts: (input) => {
					const mode = (input as { mode?: string }).mode;
					if (mode === "throw") throw new Error("refused form");
					return mode === "report";
				} });
				void Promise.resolve().then(() => request.declare({ name: "fake_late", act: "compaction" }));
			});
			pi.on("tool_call", (event) => event.toolName === "other_blocked" ? { block: true, reason: "Another extension refused this call." } : undefined);
			for (const name of ["fixture_read", "fake_compact", "fake_resolve", "fake_late", "other_blocked"]) pi.registerTool({
				name, label: name, description: "Synthetic gate fixture", parameters: obj({ mode: opt(str()) }),
				execute: async () => { executed.push(name); return { content: [{ type: "text", text: "done" }], details: {} }; },
			});
		}
		if (options.stash || options.gate) registerStash(pi);
		else {
			pi.on("turn_end", (event) => ({
				entries: [
					...event.entries,
					{ type: "custom", customType: "fixture-before-capacity", data: event.messageEntryId },
				],
			}));
			pi.on("turn_end", (event, ctx) => capacityTurnEnd(event, ctx, config));
		}
	};
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Synthetic capacity test.",
		extensionFactories: [fixture],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	({ session } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(root),
		tools: options.gate ? ["stash_write", "stash_read", "fixture_read", "fake_compact", "fake_resolve", "fake_late", "other_blocked"] : options.stash ? ["stash_write"] : [],
	}));
	t.after(() => session.dispose());
	await session.bindExtensions({
		mode: "print",
		onError: (error) => {
			errors.push(error.error);
		},
	});
	return {
		root,
		session,
		faux,
		errors,
		executed,
		setUsage: (tokens: number) => {
			usageTokens = tokens;
		},
		state: () => readCapacityState({ sessionManager: session.sessionManager }),
		requests: () =>
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === CAPACITY_REQUEST),
		async prompt(responses: Parameters<typeof faux.setResponses>[0], text = "Continue the synthetic task.") {
			faux.setResponses(responses);
			await session.prompt(text, { expandPromptTemplates: false });
			assert.equal(faux.getPendingResponseCount(), 0);
			assert.deepEqual(errors, []);
		},
	};
}

const reply = () => fauxAssistantMessage("Synthetic response.");
const calls = (...names: string[]) => fauxAssistantMessage(names.map((name, index) => fauxToolCall(name, name === "stash_read" ? { id: "retained" } : {}, { id: `${name}-${index}` })), { stopReason: "toolUse" });

test("a decision round refuses intake and preserves a declared continuity call", { timeout: 20000 }, async (t) => {
	const host = await runtime(t, { gate: true });
	host.setUsage(9100);
	await host.prompt([calls("fixture_read", "fake_compact"), calls("fixture_read"), reply()]);
	const results = host.session.messages.filter((message) => message.role === "toolResult");
	assert.equal(results[0].isError, true);
	assert.match(JSON.stringify(results[0].content), /Stash decision round/);
	assert.deepEqual(host.executed, ["fake_compact", "fixture_read"]);
});

test("the stop gate preserves accepted continuity forms and refuses late declarations", { timeout: 20000 }, async (t) => {
	const host = await runtime(t, { gate: true });
	host.setUsage(9600);
	await host.prompt([
		calls("fixture_read", "stash_read", "fake_late", "fake_compact"),
		fauxAssistantMessage([
			fauxToolCall("fake_resolve", { mode: "report" }, { id: "accepted" }),
			fauxToolCall("fake_resolve", { mode: "followUp" }, { id: "refused" }),
			fauxToolCall("fake_resolve", { mode: "throw" }, { id: "throws" }),
			fauxToolCall("stash_write", { title: "Capacity", summary: "Retain the task.", checkpoint: true }, { id: "saved" }),
		], { stopReason: "toolUse" }),
		reply(),
	]);
	assert.deepEqual(host.executed, ["fake_compact", "fake_resolve"]);
	for (const id of ["fixture_read-0", "stash_read-1", "fake_late-2", "refused", "throws"]) {
		const message = host.session.messages.find((item) => item.role === "toolResult" && item.toolCallId === id);
		assert.ok(message?.role === "toolResult" && message.isError);
		assert.match(JSON.stringify(message.content), /Stash stop/);
	}
	const saved = host.session.messages.find((item) => item.role === "toolResult" && item.toolCallId === "saved");
	assert.ok(saved?.role === "toolResult" && !saved.isError);
});

test("release remains reachable at the stop threshold and compaction restores the gate", { timeout: 20000 }, async (t) => {
	const host = await runtime(t, { gate: true });
	host.setUsage(9600);
	await host.prompt([reply(), reply()]);
	await host.session.sendCustomMessage({ customType: "fixture-owner-input", content: "Keep the authorised direction reachable.", display: false });
	assert.match(JSON.stringify(host.session.messages), /Keep the authorised direction reachable/);
	const command = host.session.extensionRunner.getCommand("stash");
	assert.ok(command);
	await assert.rejects(command.handler("capacity release", host.session.extensionRunner.createCommandContext()), /released until the next compaction/);
	await host.prompt([calls("fixture_read"), reply()]);
	assert.deepEqual(host.executed, ["fixture_read"]);
	const firstKept = host.session.sessionManager.getLeafId();
	assert.ok(firstKept);
	host.session.sessionManager.appendCompaction("Retained task.", firstKept, 9600);
	await host.prompt([calls("fixture_read"), reply()]);
	assert.deepEqual(host.executed, ["fixture_read"]);
});

test("another extension's refusal resets the ordinary stop-round counter", { timeout: 20000 }, async (t) => {
	const host = await runtime(t, { gate: true });
	host.setUsage(9600);
	await host.prompt([calls("fixture_read"), calls("other_blocked"), calls("fixture_read"), calls("fixture_read"), reply()]);
	assert.equal(host.faux.state.callCount, 5);
	assert.deepEqual(host.executed, []);
});

test("an error above the stop threshold reports measured facts once per episode", { timeout: 20000 }, async (t) => {
	const host = await runtime(t, { gate: true });
	const notices: string[] = [];
	host.session.extensionRunner.setUIContext({ ...host.session.extensionRunner.getUIContext(), notify: (text) => { notices.push(text); } }, "tui");
	host.setUsage(9600);
	await host.prompt([reply(), reply()]);
	for (let attempt = 0; attempt < 2; attempt++) await host.prompt([fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "Synthetic provider failure" })]);
	const failures = notices.filter((text) => text.includes("this turn failed while context use was"));
	assert.equal(failures.length, 1);
	assert.match(failures[0], /Pi automatic compaction is disabled/);
	assert.match(failures[0], /Remedies: \/compact/);
});

test("three fully refused stop rounds terminate without a fourth provider request", { timeout: 20000 }, async (t) => {
	const host = await runtime(t, { gate: true });
	host.setUsage(9600);
	await host.prompt([calls("fixture_read"), calls("fixture_read"), calls("fixture_read")]);
	assert.equal(host.faux.state.callCount, 3);
	assert.deepEqual(host.executed, []);
});

test("capacity boundaries add one request per threshold across a long real session", { timeout: 20_000 }, async (t) => {
	const host = await runtime(t);
	// Explicit thresholds keep the fixture independent of Pi's projected-context overhead estimate.
	const saved = ["PI_STASH_CHECKPOINT_PERCENT", "PI_STASH_DECISION_PERCENT"].map(
		(key) => [key, process.env[key]] as const,
	);
	t.after(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	process.env.PI_STASH_CHECKPOINT_PERCENT = "60";
	process.env.PI_STASH_DECISION_PERCENT = "70";
	for (let turn = 0; turn < 32; turn++) {
		host.setUsage(100 + turn * 100);
		await host.prompt([reply()], `Synthetic turn ${turn}: retain the current decision and proceed.`);
	}
	assert.equal(host.faux.state.callCount, 32);
	assert.equal(host.requests().length, 0);
	assert.equal(host.state().checkpointRequested, false);

	host.setUsage(6_100);
	await host.prompt([
		reply(),
		(context) => {
			assert.ok(
				context.messages.some(
					(message) => message.role === "user" && JSON.stringify(message.content).includes("checkpoint: true"),
				),
			);
			return reply();
		},
	]);
	assert.equal(host.faux.state.callCount, 34);
	assert.equal(host.requests().length, 1);
	assert.equal(host.state().checkpointRequested, true);
	assert.equal(host.state().decisionRequested, false);

	host.setUsage(7_100);
	await host.prompt([
		reply(),
		(context) => {
			assert.ok(
				context.messages.some(
					(message) => message.role === "user" && JSON.stringify(message.content).includes("continuity path"),
				),
			);
			return reply();
		},
	]);
	assert.equal(host.faux.state.callCount, 36);
	assert.equal(host.requests().length, 2);
	assert.equal(host.state().decisionRequested, true);

	for (let turn = 0; turn < 8; turn++) await host.prompt([reply()]);
	assert.equal(host.faux.state.callCount, 44);
	assert.equal(host.requests().length, 2);
	const entries = host.session.sessionManager.getEntries();
	assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === CAPACITY_STATE).length, 44);
	assert.equal(
		entries.filter((entry) => entry.type === "custom" && entry.customType === "fixture-before-capacity").length,
		44,
	);
	assert.equal(host.session.isStreaming, false);
});

for (const stopReason of ["error", "aborted"] as const) {
	test(`capacity records ${stopReason} turns without a continuation`, { timeout: 10_000 }, async (t) => {
		const host = await runtime(t);
		host.setUsage(9_500);
		await host.prompt([fauxAssistantMessage("Synthetic failure.", { stopReason, errorMessage: "Fixture failure" })]);
		assert.equal(host.faux.state.callCount, 1);
		assert.equal(host.requests().length, 0);
		assert.equal(host.state().checkpointRequested, false);
		assert.equal(host.state().decisionRequested, false);
		assert.ok(host.state().turnEntryId);
	});
}

test("abort during a completed boundary prevents the capacity request", { timeout: 10_000 }, async (t) => {
	const host = await runtime(t, { abortAtBoundary: true });
	host.setUsage(9_500);
	await host.prompt([reply()]);
	assert.equal(host.faux.state.callCount, 1);
	assert.equal(host.requests().length, 0);
	assert.equal(host.state().checkpointRequested, false);
	assert.equal(host.state().decisionRequested, false);
});

test("a capacity continuation executes stash_write and saves a private checkpoint", { timeout: 15_000 }, async (t) => {
	const envKeys = [
		"PI_STASH_DIR",
		"PI_STASH_CHECKPOINT_DIR",
		"PI_STASH_CAPACITY",
		"PI_STASH_CHECKPOINT_PERCENT",
		"PI_STASH_DECISION_PERCENT",
		"PI_STASH_INTAKE_TOKEN_BUDGET",
	] as const;
	const saved = envKeys.map((key) => [key, process.env[key]] as const);
	t.after(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	process.env.PI_STASH_CAPACITY = "1";
	process.env.PI_STASH_CHECKPOINT_PERCENT = "60";
	process.env.PI_STASH_DECISION_PERCENT = "70";
	delete process.env.PI_STASH_INTAKE_TOKEN_BUDGET;
	const host = await runtime(t, { stash: true });
	const stashDir = join(host.root, "stashes");
	const checkpointDir = join(host.root, "checkpoints");
	process.env.PI_STASH_DIR = stashDir;
	process.env.PI_STASH_CHECKPOINT_DIR = checkpointDir;
	host.setUsage(6_100);
	await host.prompt([
		reply(),
		fauxAssistantMessage(
			fauxToolCall(
				"stash_write",
				{
					title: "Synthetic checkpoint",
					summary: "The checked decision remains fixed. Continue with the bounded next step.",
					checkpoint: true,
				},
				{ id: "checkpoint-call" },
			),
			{ stopReason: "toolUse" },
		),
		reply(),
	]);
	assert.equal(host.faux.state.callCount, 3);
	assert.equal(host.requests().length, 1);
	const result = host.session.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === "checkpoint-call",
	);
	assert.ok(result && result.role === "toolResult");
	assert.equal(result.isError, false);
	const details = result.details;
	assert.ok(details && typeof details === "object" && "checkpoint" in details && "path" in details);
	assert.equal(details.checkpoint, true);
	assert.ok(typeof details.path === "string");
	const path = details.path;
	assert.equal("id" in details && details.id, `checkpoint:${basename(path, ".md")}`);
	assert.equal(dirname(path), checkpointDir);
	assert.match(await readFile(path, "utf8"), /The checked decision remains fixed/);
	assert.deepEqual(await listStashes(stashDir), []);
	await host.prompt([reply()]);
	assert.equal(host.faux.state.callCount, 4);
	assert.equal(host.requests().length, 1);
});
