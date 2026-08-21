import { strict as assert } from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "subagent-cwd-agent-"));
const parentCwd = mkdtempSync(join(tmpdir(), "subagent-parent-cwd-"));
const workerCwd = mkdtempSync(join(tmpdir(), "subagent-worker-cwd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const projectMarker = join(agentDir, "project-extension-ran");
const projectExtension = join(workerCwd, "project-extension.mjs");
writeFileSync(
	projectExtension,
	`import { appendFileSync } from "node:fs";
export default function (pi) {
  appendFileSync(${JSON.stringify(projectMarker)}, "factory\\n");
  pi.on("session_start", () => appendFileSync(${JSON.stringify(projectMarker)}, "start\\n"));
}
`,
	"utf8",
);
mkdirSync(join(workerCwd, ".pi"), { recursive: true });
writeFileSync(
	join(workerCwd, ".pi", "settings.json"),
	JSON.stringify({ packages: [projectExtension] }),
	"utf8",
);

const providerPath = join(agentDir, "cwd-provider.mjs");
const model = {
	id: "cwd-model",
	name: "Cwd Model",
	api: "cwd-provider-api",
	provider: "cwd-provider",
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
const guard = Symbol.for("pi-subagent.test.native-provider");
const model = ${JSON.stringify(model)};
export default function (pi) {
  if (globalThis[guard]) return;
  globalThis[guard] = true;
  const faux = fauxProvider({ api: model.api, provider: model.provider, models: [model] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", { content: "CWD_RESULT" }), { stopReason: "toolUse" }),
  ]);
  pi.registerProvider(faux.provider);
}
`,
	"utf8",
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({
		packages: [providerPath],
		defaultProjectTrust: "always",
	}),
	"utf8",
);

let parentSession: any = null;
try {
	const sub = await import("./index.ts");
	const {
		createAgentSession,
		DefaultResourceLoader,
		ModelRegistry,
		SessionManager,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");
	const selfPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
	const settingsManager = SettingsManager.create(parentCwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: parentCwd,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
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

	const dispatch = parentSession.extensionRunner.getToolDefinition("subagent");
	assert.ok(dispatch);
	const parentRegistry = new ModelRegistry(parentSession.modelRuntime);
	assert.ok(
		parentRegistry.getRegisteredNativeProvider(model.provider),
		"the parent must hold the native-form provider registration",
	);
	const result = (await dispatch.execute(
		"project-settings",
		{ task: "work in the selected directory", cwd: workerCwd, tools: [] },
		undefined,
		undefined,
		{
			cwd: parentCwd,
			thinkingLevel: "off",
			model,
			modelRegistry: parentRegistry,
			sessionManager: { getSessionId: () => parentSessionId },
			ui: { setStatus: () => undefined },
		},
	)) as any;
	const id = result.details.workers[0].id as string;
	assert.ok(id, JSON.stringify(result));

	const deadline = Date.now() + 5_000;
	let record = sub.readWorker(id);
	while (Date.now() < deadline && record?.state === "running") {
		await new Promise((resolve) => setTimeout(resolve, 10));
		record = sub.readWorker(id);
	}
	assert.equal(record?.state, "done", JSON.stringify(record));
	assert.equal(
		existsSync(projectMarker),
		false,
		"a task-selected cwd must not load its project extension",
	);

	sub.shutdownWorkerSession(parentSession);
	parentSession = null;
	if (record?.socketPath) {
		rmSync(dirname(record.socketPath), { recursive: true, force: true });
	}
	console.log("project settings child: PASS");
} finally {
	try {
		parentSession?.dispose();
	} catch {}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(parentCwd, { recursive: true, force: true });
	rmSync(workerCwd, { recursive: true, force: true });
}
