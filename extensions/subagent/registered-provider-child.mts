import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The host fields a directly-executed tool reads from this sparse fixture context. */
type ToolContextFixture = Pick<ExtensionContext, "cwd" | "modelRegistry"> & {
	thinkingLevel?: ExtensionContext["thinkingLevel"];
	model: unknown;
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
	ui: Pick<ExtensionContext["ui"], "setStatus">;
};

const agentDir = mkdtempSync(join(tmpdir(), "subagent-provider-agent-"));
const parentCwd = mkdtempSync(join(tmpdir(), "subagent-provider-parent-"));
const workerCwd = mkdtempSync(join(tmpdir(), "subagent-provider-worker-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Sessions discover user resources under $HOME. An empty home keeps this
// fixture's resource set deterministic on any machine.
const testHome = mkdtempSync(join(tmpdir(), "subagent-provider-home-"));
process.env.HOME = testHome;

const providerPath = join(agentDir, "registered-provider.mjs");
const model = {
	id: "registered-model",
	name: "Registered Model",
	api: "registered-provider-api",
	provider: "registered-provider",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};
writeFileSync(
	providerPath,
	`import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const guard = Symbol.for("pi-subagent.test.registered-provider");
const model = ${JSON.stringify(model)};
export default function (pi) {
  if (globalThis[guard]) return;
  globalThis[guard] = true;
  const faux = fauxProvider({ api: model.api, provider: model.provider, models: [model] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", { content: "REGISTERED_PROVIDER_RESULT" }), { stopReason: "toolUse" }),
  ]);
  pi.registerProvider(model.provider, {
    api: model.api,
    apiKey: "not-used",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: faux.provider.streamSimple,
  });
}
`,
	"utf8",
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [providerPath] }), "utf8");

const targetModel = {
	...model,
	id: "target-model",
	name: "Target Model",
	api: "target-provider-api",
	provider: "target-provider",
	reasoning: true,
};
const targetPrompt = join(agentDir, "target-worker-prompt.txt");
const targetProviderPath = join(workerCwd, "target-provider.mjs");
writeFileSync(
	targetProviderPath,
	`import { existsSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const model = ${JSON.stringify(targetModel)};
export default function (pi) {
  const faux = fauxProvider({ api: model.api, provider: model.provider, models: [model] });
  faux.setResponses([
    (context) => {
      const path = ${JSON.stringify(targetPrompt)};
      if (!existsSync(path)) writeFileSync(path, getCurrentSystemPrompt(context.messages), "utf8");
      return fauxAssistantMessage(fauxToolCall("submit_result", { content: "TARGET_PROVIDER_RESULT" }), { stopReason: "toolUse" });
    },
  ]);
  pi.registerProvider(model.provider, {
    api: model.api,
    apiKey: "not-used",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: faux.provider.streamSimple,
  });
  pi.on("session_start", async (_event, ctx) => {
    const selected = ctx.modelRegistry.find(model.provider, model.id);
    if (!selected || !(await pi.setModel(selected))) throw new Error("target model selection failed");
    pi.setThinkingLevel("high");
  });
}
`,
	"utf8",
);
mkdirSync(join(workerCwd, ".pi"), { recursive: true });
writeFileSync(join(workerCwd, ".pi", "settings.json"), JSON.stringify({ packages: [targetProviderPath] }), "utf8");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
let parentSession: AgentSession | null = null;
try {
	const sub = await import("./index.ts");
	const {
		createAgentSession,
		DefaultResourceLoader,
		ModelRegistry,
		ProjectTrustStore,
		SessionManager,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");
	new ProjectTrustStore(agentDir).set(workerCwd, true);
	const selfPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
	const settingsManager = SettingsManager.create(parentCwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: parentCwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [selfPath],
	});
	await resourceLoader.reload();
	const created = await createAgentSession({
		cwd: parentCwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		model: model as never,
		thinkingLevel: "off",
		tools: ["subagent"],
	});
	parentSession = created.session;
	const parentSessionId = parentSession.sessionManager.getSessionId();
	sub.sharedWorkerState.workerSessionIds.add(parentSessionId);
	await parentSession.bindExtensions({});

	const parentRegistry = new ModelRegistry(parentSession.modelRuntime);
	assert.ok(
		parentRegistry.getRegisteredProviderConfig(model.provider),
		"the parent must hold the config-form provider registration",
	);

	const dispatch = parentSession.extensionRunner.getToolDefinition("subagent");
	assert.ok(dispatch);
	// The extension reads only these context fields when its tool runs directly here.
	const toolContext = {
		cwd: parentCwd,
		thinkingLevel: "off",
		model,
		modelRegistry: parentRegistry,
		sessionManager: { getSessionId: () => parentSessionId },
		ui: { setStatus: () => undefined },
	} satisfies ToolContextFixture as unknown as ExtensionContext;
	const runDispatched = async (toolCallId: string, params: Record<string, unknown>) => {
		const result = await dispatch.execute(toolCallId, params, undefined, undefined, toolContext);
		const dispatchDetails = result.details;
		assert.ok(isRecord(dispatchDetails), "the dispatch result carries details");
		const workers = dispatchDetails.workers;
		assert.ok(isUnknownArray(workers), "the dispatch lists workers");
		const firstWorker = workers[0];
		assert.ok(isRecord(firstWorker), "the first worker is listed");
		const workerIdValue = firstWorker.id;
		assert.ok(isString(workerIdValue), JSON.stringify(result));
		const workerId = workerIdValue;
		const deadline = Date.now() + 10_000;
		let workerRecord = sub.readWorker(workerId);
		while (Date.now() < deadline && workerRecord?.state === "running") {
			await new Promise((resolve) => setTimeout(resolve, 10));
			workerRecord = sub.readWorker(workerId);
		}
		assert.equal(workerRecord?.state, "done", JSON.stringify(workerRecord));
		return { id: workerId, record: workerRecord };
	};

	// Keep the provider-transfer proof: the config-form provider itself performs
	// a worker turn before the target-only model case runs.
	const bootstrap = await runDispatched("registered-provider", {
		task: "return the registered provider result",
		tools: [],
	});
	assert.equal(bootstrap.record?.bootstrapModel, `${model.provider}/${model.id}`);
	assert.equal(bootstrap.record?.model, `${model.provider}/${model.id}`);
	assert.equal(readFileSync(sub.workerFiles(bootstrap.id).result, "utf8"), "REGISTERED_PROVIDER_RESULT");

	const target = await runDispatched("target-provider", {
		task: "return the target provider result",
		tools: [],
		cwd: workerCwd,
	});
	const id = target.id;
	const record = target.record;
	assert.equal(record?.bootstrapModel, `${model.provider}/${model.id}`);
	assert.equal(record?.model, `${targetModel.provider}/${targetModel.id}`);
	assert.equal(record?.thinking, "high");
	assert.equal(readFileSync(sub.workerFiles(id).result, "utf8"), "TARGET_PROVIDER_RESULT");
	assert.doesNotMatch(readFileSync(targetPrompt, "utf8"), /model id \(authoritative/);

	const continuation = parentSession.extensionRunner.getToolDefinition("subagent_continue");
	assert.ok(continuation);
	const continued = await continuation.execute(
		"registered-provider-continuation",
		{ id, message: "continue through the target model" },
		undefined,
		undefined,
		toolContext,
	);
	const continuedDetails = continued.details;
	assert.ok(isRecord(continuedDetails), "the continuation result carries details");
	const continuedWorker = continuedDetails.worker;
	assert.ok(isRecord(continuedWorker), "the continuation names its worker");
	const continuedIdValue = continuedWorker.id;
	assert.ok(isString(continuedIdValue), JSON.stringify(continued));
	const continuedId = continuedIdValue;
	const continuedDeadline = Date.now() + 10_000;
	let continuedRecord = sub.readWorker(continuedId);
	while (Date.now() < continuedDeadline && continuedRecord?.state === "running") {
		await new Promise((resolve) => setTimeout(resolve, 10));
		continuedRecord = sub.readWorker(continuedId);
	}
	assert.equal(continuedRecord?.state, "done", JSON.stringify(continuedRecord));
	assert.equal(continuedRecord?.bootstrapModel, `${model.provider}/${model.id}`);
	assert.equal(continuedRecord?.model, `${targetModel.provider}/${targetModel.id}`);
	assert.equal(continuedRecord?.thinking, "high");
	assert.equal(readFileSync(sub.workerFiles(continuedId).result, "utf8"), "TARGET_PROVIDER_RESULT");

	sub.shutdownWorkerSession(parentSession);
	parentSession = null;
	console.log("registered provider child: PASS");
} finally {
	try {
		parentSession?.dispose();
	} catch {}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(parentCwd, { recursive: true, force: true });
	rmSync(workerCwd, { recursive: true, force: true });
	rmSync(testHome, { recursive: true, force: true });
}
