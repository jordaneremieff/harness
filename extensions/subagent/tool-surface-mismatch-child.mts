import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "subagent-surface-agent-"));
const parentCwd = mkdtempSync(join(tmpdir(), "subagent-surface-parent-"));
const differentCwd = mkdtempSync(join(tmpdir(), "subagent-surface-child-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Sessions discover user resources under $HOME. An empty home keeps this
// fixture's resource set deterministic on any machine.
process.env.HOME = mkdtempSync(join(tmpdir(), "subagent-surface-home-"));

const model = {
	id: "surface-model",
	name: "Surface Model",
	api: "surface-provider-api",
	provider: "surface-provider",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};

const providerPath = join(agentDir, "surface-provider.mjs");
writeFileSync(
	providerPath,
	`import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const model = ${JSON.stringify(model)};
export default function (pi) {
  const faux = fauxProvider({ api: model.api, provider: model.provider, models: [model] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", { content: "SURFACE_OK" }), { stopReason: "toolUse" }),
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

const probePath = join(agentDir, "probe-extension.ts");
function probeSource(version: "old" | "new"): string {
	const old = version === "old";
	return `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "probe_tool",
    label: "Probe tool",
    description: ${JSON.stringify(old ? "old description" : "new description")},
    parameters: Type.Object({ value: Type.String({ maxLength: ${old ? 20 : 40} }) }),
    promptGuidelines: [${JSON.stringify(old ? "old guideline" : "new guideline")}],
    async execute() {
      return { content: [{ type: "text", text: "probe" }], details: {} };
    },
  });
}
`;
}
writeFileSync(probePath, probeSource("old"), "utf8");

const sub = await import("./index.ts");
const { createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } = await import(
	"@earendil-works/pi-coding-agent"
);

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function rejectedDispatch(dispatch: any, ctx: any, cwd: string, id: string): Promise<string> {
	try {
		await dispatch.execute(id, { task: "This dispatch must stop at tool preflight.", cwd }, undefined, undefined, ctx);
	} catch (error) {
		return errorText(error);
	}
	throw new Error("the changed registration unexpectedly passed preflight");
}

let parentSession: any = null;
let uncaught: unknown;
const captureUncaught = (error: unknown) => {
	uncaught = error;
};
process.once("unhandledRejection", captureUncaught);
process.once("uncaughtException", captureUncaught);

try {
	const selfPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
	const settingsManager = SettingsManager.create(parentCwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: parentCwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [selfPath, probePath],
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
		tools: ["subagent", "probe_tool"],
	});
	parentSession = created.session;
	const parentSessionId = parentSession.sessionManager.getSessionId();
	sub.sharedWorkerState.workerSessionIds.add(parentSessionId);
	await parentSession.bindExtensions({});

	const dispatch = parentSession.extensionRunner.getToolDefinition("subagent");
	assert.ok(dispatch);
	const ctx = {
		cwd: parentCwd,
		thinkingLevel: "off",
		model,
		modelRegistry: new ModelRegistry(parentSession.modelRuntime),
		sessionManager: { getSessionId: () => parentSessionId },
		ui: { setStatus: () => undefined },
	};

	writeFileSync(probePath, probeSource("new"), "utf8");
	const future = new Date(Date.now() + 60_000);
	utimesSync(probePath, future, future);

	const sameCwd = (await dispatch.execute(
		"same-cwd-before",
		{ task: "Submit the fixed result.", cwd: parentCwd },
		undefined,
		undefined,
		ctx,
	)) as any;
	const successfulId = sameCwd.details.workers[0].id as string;
	assert.ok(successfulId);

	const deadline = Date.now() + 10_000;
	let record = sub.readWorker(successfulId);
	while (Date.now() < deadline && record?.state === "running") {
		await new Promise((resolve) => setTimeout(resolve, 10));
		record = sub.readWorker(successfulId);
	}
	assert.equal(record?.state, "done", JSON.stringify(record));
	const resultPath = sub.workerFiles(successfulId).result;
	assert.equal(existsSync(resultPath), true);
	assert.equal(readFileSync(resultPath, "utf8"), "SURFACE_OK");

	const differentCwdError = await rejectedDispatch(dispatch, ctx, differentCwd, "different-cwd");
	const sameCwdAfterError = await rejectedDispatch(dispatch, ctx, parentCwd, "same-cwd-after");
	for (const message of [differentCwdError, sameCwdAfterError]) {
		assert.match(message, /Started 0 of 1 subagent worker\(s\)/);
		assert.match(message, /registration changed: probe_tool \(description, parameters, promptGuidelines\)/);
		assert.match(message, /Worker active tool names: subagent, probe_tool, submit_result/);
		assert.match(message, /Run \/reload after extension source changes, then retry/);
	}
	assert.equal(uncaught, undefined, errorText(uncaught));

	await parentSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	parentSession.dispose();
	parentSession = null;
	if (record?.socketPath) rmSync(dirname(record.socketPath), { recursive: true, force: true });
	console.log("tool surface mismatch child: PASS");
} finally {
	process.removeListener("unhandledRejection", captureUncaught);
	process.removeListener("uncaughtException", captureUncaught);
	try {
		parentSession?.dispose();
	} catch {}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(parentCwd, { recursive: true, force: true });
	rmSync(differentCwd, { recursive: true, force: true });
}
