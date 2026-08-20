import { strict as assert } from "node:assert";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "subagent-owner-shutdown-agent-"));
const cwd = mkdtempSync(join(tmpdir(), "subagent-owner-shutdown-cwd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const marker = join(agentDir, "provider-started");
const providerPath = join(agentDir, "owner-provider.mjs");
const model = {
	id: "owner-model",
	name: "Owner Model",
	api: "owner-provider-api",
	provider: "owner-provider",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};
writeFileSync(
	providerPath,
	`import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const model = ${JSON.stringify(model)};
export default function (pi) {
  const faux = fauxProvider({ api: model.api, provider: model.provider, models: [model] });
  faux.setResponses([
    (_context, options) => {
      appendFileSync(${JSON.stringify(marker)}, "started\\n");
      return new Promise((resolve) => {
        const finish = () => resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" }));
        if (options?.signal?.aborted) finish();
        else options?.signal?.addEventListener("abort", finish, { once: true });
      });
    },
  ]);
  pi.registerProvider(faux.provider);
}
`,
	"utf-8",
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ packages: [providerPath], defaultProjectTrust: "always" }),
	"utf-8",
);

let ownerSession: any = null;
try {
	const sub = await import("./index.ts");
	const {
		createAgentSession,
		DefaultResourceLoader,
		SessionManager,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");
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
	try {
		sub.sharedWorkerState.constructingWorkers++;
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
			model: model as never,
			thinkingLevel: "off",
			tools: ["subagent", "submit_result"],
		});
		ownerSession = created.session;
		await ownerSession.bindExtensions({});
	} finally {
		sub.sharedWorkerState.constructingWorkers--;
	}

	const tool = ownerSession.extensionRunner.getToolDefinition("subagent");
	assert.ok(tool, "the worker session must expose nested dispatch");
	const ownerSessionId = ownerSession.sessionManager.getSessionId();
	const ctx = {
		cwd,
		thinkingLevel: "off",
		model,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === model.provider && id === model.id ? model : null,
			getAvailable: () => [model],
			hasConfiguredAuth: () => true,
		},
		sessionManager: { getSessionId: () => ownerSessionId },
		ui: { setStatus: () => undefined },
	};
	const dispatched = (await tool.execute(
		"nested-owner",
		{ task: "hold until the owner closes", tools: [] },
		undefined,
		undefined,
		ctx,
	)) as any;
	const id = dispatched.details.workers[0].id as string;
	assert.ok(id, JSON.stringify(dispatched));

	const startedDeadline = Date.now() + 5_000;
	while (Date.now() < startedDeadline) {
		if (existsSync(marker) && sub.readWorker(id)?.state === "running") break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(existsSync(marker), true, "the nested provider must start");
	const before = sub.readWorker(id);
	assert.equal(before?.state, "running");
	assert.equal(before?.ownerSession, ownerSessionId);
	assert.equal(
		Boolean(before?.socketPath && existsSync(before.socketPath)),
		true,
	);

	sub.shutdownWorkerSession(ownerSession);
	ownerSession = null;
	const closedDeadline = Date.now() + 5_000;
	let after = sub.readWorker(id);
	while (
		Date.now() < closedDeadline &&
		(after?.state === "running" ||
			Boolean(after?.socketPath && existsSync(after.socketPath)))
	) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		after = sub.readWorker(id);
	}
	assert.equal(after?.state, "owner_lost", JSON.stringify(after));
	assert.equal(
		Boolean(after?.socketPath && existsSync(after.socketPath)),
		false,
	);
	assert.equal(
		readFileSync(marker, "utf-8").trim().split("\n").length,
		1,
		"owner shutdown must not start a completion turn in the closing session",
	);
	assert.equal(sub.sharedWorkerState.workerSurfaces.has(ownerSessionId), false);
	if (after?.socketPath) {
		rmSync(dirname(after.socketPath), { recursive: true, force: true });
	}
	console.log("owner shutdown child: PASS");
} finally {
	try {
		ownerSession?.dispose();
	} catch {}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}
