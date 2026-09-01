import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "subagent-provider-agent-"));
const cwd = mkdtempSync(join(tmpdir(), "subagent-provider-cwd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

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

let parentSession: any = null;
try {
	const sub = await import("./index.ts");
	const { createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const selfPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		additionalExtensionPaths: [selfPath],
	});
	await resourceLoader.reload();
	const created = await createAgentSession({
		cwd,
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
	const result = (await dispatch.execute(
		"registered-provider",
		{ task: "return the registered provider result", tools: [] },
		undefined,
		undefined,
		{
			cwd,
			thinkingLevel: "off",
			model,
			modelRegistry: parentRegistry,
			sessionManager: { getSessionId: () => parentSessionId },
			ui: { setStatus: () => undefined },
		},
	)) as any;
	const id = result.details.workers[0].id as string;
	assert.ok(id, JSON.stringify(result));

	const deadline = Date.now() + 10_000;
	let record = sub.readWorker(id);
	while (Date.now() < deadline && record?.state === "running") {
		await new Promise((resolve) => setTimeout(resolve, 10));
		record = sub.readWorker(id);
	}
	assert.equal(record?.state, "done", JSON.stringify(record));
	const resultPath = sub.workerFiles(id).result;
	assert.equal(existsSync(resultPath), true);
	assert.equal(readFileSync(resultPath, "utf8"), "REGISTERED_PROVIDER_RESULT");

	sub.shutdownWorkerSession(parentSession);
	parentSession = null;
	if (record?.socketPath) {
		rmSync(dirname(record.socketPath), { recursive: true, force: true });
	}
	console.log("registered provider child: PASS");
} finally {
	try {
		parentSession?.dispose();
	} catch {}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}
