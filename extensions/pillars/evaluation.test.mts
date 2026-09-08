import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { TranscriptEvent } from "vitest-evals";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piSdkAdapter, runDeterministicChecks } from "../../evals/subjects/pi-sdk.mts";
import suite from "./commands.eval.mts";
import evaluationExtension, { evaluationSource } from "./evaluation.ts";

const suitePath = fileURLToPath(new URL("./commands.eval.mts", import.meta.url));
const hostRoot = process.env.PI_PILLARS_TEST_HOST_ROOT;
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(
	hostRoot ? pathToFileURL(join(hostRoot, "dist/index.js")).href : "@earendil-works/pi-coding-agent"
);
const ai: typeof import("@earendil-works/pi-ai") = await import(
	hostRoot
		? pathToFileURL(join(hostRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href
		: "@earendil-works/pi-ai"
);

test("the maintained suite validates and keeps semantic judgment with the operator", () => {
	piSdkAdapter.validate!({
		suitePath,
		subjectKind: suite.subject.kind,
		subjectConfig: suite.subject.config,
		cases: suite.cases,
	});
	for (const variant of suite.subject.variants)
		assert.ok(
			piSdkAdapter.resolve({
				suitePath,
				subjectKind: suite.subject.kind,
				subjectConfig: suite.subject.config,
				variant,
			}),
		);
	assert.equal(suite.adjudication.policy, "human-required");
	assert.equal(suite.cases.length, new Set(suite.cases.map(({ id }) => id)).size);
	for (const action of ["check", "derive", "review"]) {
		assert.ok(suite.cases.some(({ input }) => input.prompt === `/pillars ${action}` && input.seed.length > 0));
		assert.ok(suite.cases.some(({ input }) => input.prompt.startsWith(`/pillars ${action} `)));
		assert.ok(suite.cases.some(({ input }) => input.prompt === `/pillars ${action}` && input.seed.length === 0));
	}
	for (const item of suite.cases) {
		assert.ok(item.input.fixture.gold.length > 40);
		assert.deepEqual(
			item.checks.slice(0, 2).map(({ config }) => config),
			[
				{ name: "write", present: false },
				{ name: "edit", present: false },
			],
		);
		assert.ok(!item.checks.some(({ type }) => type === "contains-exact"));
	}
});

test("source and mutation floors reject missing evidence and attempted writes, not alternative prose", () => {
	const item = suite.cases.find(({ id }) => id === "derive-existing")!;
	const call: TranscriptEvent = {
		type: "tool_call",
		id: "source",
		name: "pillars",
		arguments: { resource: "governance" },
	};
	const result: TranscriptEvent = {
		type: "tool_result",
		toolCallId: "source",
		name: "pillars",
		content: '{"resource":"governance","offset":0}',
	};
	const check = (events: TranscriptEvent[]) =>
		runDeterministicChecks("An alternative well-supported answer.", item.checks, events, item.id);
	assert.ok(check([call, result]).every(({ passed }) => passed));
	assert.ok(check([call]).some(({ passed }) => !passed));
	assert.ok(check([call, { ...result, content: '{"resource":"inventory","offset":0}' }]).some(({ passed }) => !passed));
	for (const name of ["write", "edit"]) {
		assert.equal(
			check([call, result, { type: "tool_call", id: name, name, arguments: {} }]).find(
				({ checkId }) => checkId === `no-${name}`,
			)?.passed,
			false,
		);
	}
	for (const empty of suite.cases.filter(({ input }) => input.seed.length === 0)) {
		assert.ok(
			runDeterministicChecks("What subject do you want to examine?", empty.checks, [], empty.id).every(
				({ passed }) => passed,
			),
		);
	}
});

test("source approval covers the command implementation and live doctrine", async () => {
	const source = await evaluationSource();
	assert.equal(source.digest, suite.subject.variants[0].config.extensionFlags["pillars-eval-source"]);
	for (const suffix of [
		"/commands.ts",
		"/index.ts",
		"/evaluation.ts",
		"/pillars/GOVERNANCE.md",
		"/pillars/README.md",
	]) {
		assert.ok(
			source.paths.some((path) => path.endsWith(suffix)),
			suffix,
		);
	}
	const before = process.env.PI_PILLARS_COLLECT;
	let approved = "0".repeat(64);
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const shutdown: Array<() => Promise<void>> = [];
	try {
		await evaluationExtension({
			registerFlag() {},
			getFlag: () => approved,
			registerTool() {},
			registerEntryRenderer() {},
			registerCommand(_name, definition) {
				command = definition;
			},
			on(name, handler) {
				if (name === "session_shutdown") shutdown.push(handler as unknown as () => Promise<void>);
			},
		} as Partial<ExtensionAPI> as ExtensionAPI);
		assert.ok(command);
		await assert.rejects(
			command.handler("check", {} as Parameters<typeof command.handler>[1]),
			/differs from the approved plan/,
		);
		approved = source.digest;
		await assert.rejects(
			command.handler('export "/forbidden.json"', {} as Parameters<typeof command.handler>[1]),
			/only check, derive, and review/,
		);
	} finally {
		for (const close of shutdown) await close();
	}
	assert.equal(process.env.PI_PILLARS_COLLECT, before);
});

test("an adapter failure before shutdown ownership restores the environment and removes its store", async () => {
	const keys = ["PI_PILLARS_CORPUS", "PI_PILLARS_COLLECT", "PI_PILLARS_DIR"] as const;
	const previous = keys.map((key) => [key, process.env[key]] as const);
	const shutdown: Array<() => Promise<void>> = [];
	// The wrapper registers its own tool_call and session_shutdown handlers only
	// after the inner extension finished; the first session_shutdown registration
	// belongs to the inner extension.
	let armed = false;
	let store: string | undefined;
	try {
		await assert.rejects(
			evaluationExtension({
				registerFlag() {},
				getFlag: () => "0".repeat(64),
				registerTool() {},
				registerEntryRenderer() {},
				registerCommand() {},
				on(name, handler) {
					if (name === "tool_call") armed = true;
					if (name === "session_shutdown") {
						if (!armed) {
							shutdown.push(handler as unknown as () => Promise<void>);
							return;
						}
						store = process.env.PI_PILLARS_DIR;
						throw new Error("shutdown registration refused");
					}
				},
			} as Partial<ExtensionAPI> as ExtensionAPI),
			/shutdown registration refused/,
		);
	} finally {
		for (const close of shutdown) await close();
	}
	assert.ok(store);
	for (const [key, value] of previous) assert.equal(process.env[key], value);
	if (store) await assert.rejects(access(store));
});

test("the evaluation wrapper awaits real command output and confines filesystem effects", {
	timeout: 30000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pillars-evaluation-test-"));
	const keys = ["PI_PILLARS_COLLECT", "PI_PILLARS_DIR", "PI_PILLARS_CORPUS"] as const;
	const previous = keys.map((key) => [key, process.env[key]] as const);
	let runtime: InstanceType<typeof sdk.AgentSessionRuntime> | undefined;
	let store: string | undefined;
	try {
		const faux = ai.fauxProvider({
			provider: "pillars-evaluation-test",
			models: [{ id: "reader", reasoning: true, contextWindow: 100000 }],
			tokensPerSecond: 0,
		});
		const modelRuntime = await sdk.ModelRuntime.create({
			credentials: new ai.InMemoryCredentialStore(),
			modelsStore: new ai.InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const config = suite.subject.variants[0].config;
		runtime = await sdk.createAgentSessionRuntime(
			async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
				const services = await sdk.createAgentSessionServices({
					cwd,
					agentDir,
					modelRuntime,
					extensionFlagValues: new Map(Object.entries(config.extensionFlags)),
					settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
					resourceLoaderOptions: {
						noExtensions: true,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						additionalExtensionPaths: [fileURLToPath(new URL("./evaluation.ts", import.meta.url))],
					},
				});
				assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
				return {
					...(await sdk.createAgentSessionFromServices({
						services,
						sessionManager,
						sessionStartEvent,
						model: faux.getModel(),
						tools: config.tools,
					})),
					services,
					diagnostics: services.diagnostics,
				};
			},
			{ cwd: root, agentDir: join(root, "agent"), sessionManager: sdk.SessionManager.inMemory(root) },
		);
		const errors: string[] = [];
		await runtime.session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
		assert.equal(process.env.PI_PILLARS_COLLECT, "0");
		store = process.env.PI_PILLARS_DIR;
		assert.ok(store);
		for (const action of ["check", "derive", "review"]) {
			faux.setResponses([
				ai.fauxAssistantMessage(ai.fauxToolCall("pillars", { resource: "governance" }, { id: `source-${action}` })),
				ai.fauxAssistantMessage(`${action} completed after source delivery.`),
			]);
			await runtime.session.prompt(`/pillars ${action}`, { expandPromptTemplates: true, source: "rpc" });
			assert.equal(runtime.session.isIdle, true);
			assert.ok(JSON.stringify(runtime.session.messages.at(-1)).includes(`${action} completed after source delivery.`));
		}
		const target = join(root, "unauthorized.md");
		faux.setResponses([
			ai.fauxAssistantMessage(
				ai.fauxToolCall("write", { path: target, content: "forbidden" }, { id: "blocked-write" }),
			),
			ai.fauxAssistantMessage("The attempted mutation was blocked."),
		]);
		await runtime.session.prompt("/pillars derive");
		await assert.rejects(access(target));
		const blocked = runtime.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "blocked-write",
		);
		assert.ok(blocked?.role === "toolResult" && blocked.isError);
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		faux.setResponses([
			async () => {
				entered();
				await held;
				return ai.fauxAssistantMessage("Synthetic aborted response.");
			},
		]);
		const pending = runtime.session.prompt("/pillars check");
		await started;
		const aborted = runtime.session.abort();
		release();
		await aborted;
		await pending;
		assert.equal(runtime.session.isIdle, true);
		assert.deepEqual(await readdir(store), []);
		assert.deepEqual(errors, []);
	} finally {
		try {
			await runtime?.dispose();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
	for (const [key, value] of previous) assert.equal(process.env[key], value);
	if (store) await assert.rejects(access(store));
});
