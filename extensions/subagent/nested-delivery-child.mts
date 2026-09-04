import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "subagent-nested-delivery-agent-"));
const cwd = mkdtempSync(join(tmpdir(), "subagent-nested-delivery-cwd-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Sessions discover user resources under $HOME. An empty home keeps this
// fixture's resource set deterministic on any machine.
process.env.HOME = mkdtempSync(join(tmpdir(), "subagent-nested-delivery-home-"));
const marker = join(agentDir, "provider-calls.log");
const providerPath = join(agentDir, "delivery-provider.mjs");
const model = {
	id: "delivery-model",
	name: "Delivery Model",
	api: "delivery-provider-api",
	provider: "delivery-provider",
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
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const model = ${JSON.stringify(model)};
export default function (pi) {
  const faux = fauxProvider({ api: model.api, provider: model.provider, models: [model] });
  let role;
  let calls = 0;
  const respond = (context) => {
    calls++;
    const serialized = JSON.stringify(context.messages);
    role ??= serialized.includes("OWNER_TASK") ? "owner" : "grandchild";
    appendFileSync(${JSON.stringify(marker)}, role + ":" + calls + "\\n");
    if (role === "grandchild") {
      return fauxAssistantMessage(fauxToolCall("submit_result", { content: "GRANDCHILD_RESULT" }), { stopReason: "toolUse" });
    }
    if (calls === 1) {
      return fauxAssistantMessage(fauxToolCall("subagent", { task: "GRANDCHILD_TASK", tools: [] }), { stopReason: "toolUse" });
    }
    if (calls === 2) return fauxAssistantMessage("OWNER_IDLE");
    if (calls === 3) {
      const id = serialized.match(/bg-[a-z0-9]+/)?.[0];
      if (!id) return fauxAssistantMessage("OWNER_MISSING_ID");
      return fauxAssistantMessage(fauxToolCall("subagent_collect", { id }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(serialized.includes("GRANDCHILD_RESULT") ? "OWNER_COLLECTED" : "OWNER_MISSING_RESULT");
  };
  faux.setResponses(Array.from({ length: 8 }, () => respond));
  pi.registerProvider(faux.provider);
}
`,
	"utf-8",
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [providerPath] }), "utf-8");

let ownerSession: any = null;
try {
	const sub = await import("./index.ts");
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const selfPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
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
		tools: ["subagent", "subagent_collect"],
	});
	ownerSession = created.session;
	sub.sharedWorkerState.workerSessionIds.add(ownerSession.sessionManager.getSessionId());
	await ownerSession.bindExtensions({});

	await ownerSession.prompt("OWNER_TASK", { expandPromptTemplates: false });
	const deadline = Date.now() + 8_000;
	let grandchild = sub.listWorkers().find((record) => record.task === "GRANDCHILD_TASK");
	const hasOwnerResult = () =>
		ownerSession.messages.some(
			(message: any) =>
				message.role === "assistant" &&
				message.content?.some((part: any) => part.type === "text" && part.text === "OWNER_COLLECTED"),
		);
	while (
		Date.now() < deadline &&
		(grandchild?.state !== "done" || !grandchild.notificationCallReturnedAt || !hasOwnerResult())
	) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		grandchild = sub.listWorkers().find((record) => record.task === "GRANDCHILD_TASK");
	}
	assert.equal(grandchild?.state, "done", JSON.stringify(grandchild));
	assert.ok(grandchild.notificationCallReturnedAt, "the live worker owner's synchronous send call must return");
	assert.equal(readFileSync(sub.workerFiles(grandchild.id).result, "utf-8"), "GRANDCHILD_RESULT");
	assert.equal(hasOwnerResult(), true, JSON.stringify(ownerSession.messages));
	assert.equal(
		ownerSession.messages.some(
			(message: any) =>
				message.role === "toolResult" &&
				message.toolName === "subagent_collect" &&
				JSON.stringify(message.content).includes("GRANDCHILD_RESULT"),
		),
		true,
		"the owning worker must collect the grandchild's exact submitted result",
	);
	assert.match(readFileSync(marker, "utf-8"), /owner:4/);

	const ownerSessionId = ownerSession.sessionManager.getSessionId();
	sub.shutdownWorkerSession(ownerSession);
	ownerSession = null;
	const cleanupDeadline = Date.now() + 5_000;
	while (Date.now() < cleanupDeadline && sub.sharedWorkerState.workerSurfaces.has(ownerSessionId)) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(sub.sharedWorkerState.workerSurfaces.has(ownerSessionId), false);
	if (grandchild.socketPath && existsSync(grandchild.socketPath)) {
		throw new Error("the owner socket remained after shutdown");
	}
	if (grandchild.socketPath) {
		rmSync(dirname(grandchild.socketPath), { recursive: true, force: true });
	}
	console.log("nested delivery child: PASS");
} finally {
	try {
		ownerSession?.dispose();
	} catch {}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}
