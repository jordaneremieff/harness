import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { listStashes } from "./store.ts";

const config = { enabled: true, checkpointPercent: 60, decisionPercent: 70 };

async function runtime(t: TestContext, options: { stash?: boolean; abortAtBoundary?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "stash-capacity-runtime-"));
	t.after(() => rm(root, { recursive: true, force: true }));
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
		if (options.stash) registerStash(pi);
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
		tools: options.stash ? ["stash_write"] : [],
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

test("capacity boundaries add one request per threshold across a long real session", { timeout: 20_000 }, async (t) => {
	const host = await runtime(t);
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
		host.setUsage(7_500);
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
	host.setUsage(7_500);
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
	assert.equal("id" in details, false);
	assert.ok(typeof details.path === "string");
	const path = details.path;
	assert.equal(dirname(path), checkpointDir);
	assert.match(await readFile(path, "utf8"), /The checked decision remains fixed/);
	assert.deepEqual(await listStashes(stashDir), []);
	await host.prompt([reply()]);
	assert.equal(host.faux.state.callCount, 4);
	assert.equal(host.requests().length, 1);
});
