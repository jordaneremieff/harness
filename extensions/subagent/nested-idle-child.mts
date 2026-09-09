/** A managed nested worker ends its ordinary turn, stays live and idle, and
 * resumes in the same session when its child's completion arrives as a native
 * custom message. No wait tool, no polling, no keepalive instruction. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "subagent-nested-idle-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const home = join(root, "home");
for (const path of [agentDir, cwd, home]) mkdirSync(path);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = home;
const errors: unknown[] = [];
const captureError = (error: unknown) => errors.push(error);
process.on("unhandledRejection", captureError);
process.on("uncaughtException", captureError);
const watchdog = setTimeout(() => {
	console.error("Nested idle fixture exceeded its runtime bound", errors);
	process.exit(1);
}, 25_000);
const key = Symbol.for("subagent-test.nested-idle");
const model = {
	id: "nested-model",
	name: "Nested Model",
	api: "nested-fixture-api",
	provider: "nested-fixture",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};
const providerPath = join(agentDir, "nested-fixture.mjs");
let releaseChild = () => {};
const childGate = new Promise<void>((resolve) => {
	releaseChild = resolve;
});
const calls = new Map<string, number>();
const prompts = new Map<string, string>();
const requests = new Map<string, any[]>();
let owner: any;
let sub: typeof import("./index.ts");
let childId = "";
const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const tool = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const lastResult = (context: any, name: string) =>
	context.messages.filter((message: any) => message.role === "toolResult" && message.toolName === name).at(-1);
async function until(check: () => boolean, description: string) {
	const end = Date.now() + 10_000;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), `${description}; errors: ${JSON.stringify(errors)}; calls: ${JSON.stringify([...calls])}`);
}
(globalThis as any)[key] = async (role: string, context: any) => {
	const count = (calls.get(role) ?? 0) + 1;
	calls.set(role, count);
	prompts.set(role, context.systemPrompt);
	requests.set(role, context.messages);
	if (role === "root") {
		if (count === 1) return tool("subagent", { task: "NESTED_PARENT_TASK" });
		return fauxAssistantMessage("ROOT_IDLE");
	}
	if (role === "child") {
		await childGate;
		return tool("submit_result", { content: "NESTED_CHILD_RESULT" });
	}
	if (count === 1) return tool("subagent", { task: "NESTED_CHILD_TASK", tools: [] });
	if (count === 2) {
		const dispatched = lastResult(context, "subagent").details.workers;
		childId = dispatched[0].id;
		assert.ok(childId);
		// End the ordinary turn instead of waiting. The worker stays live and
		// idle; the child's completion starts the next turn in this same session.
		return fauxAssistantMessage("PARENT_IDLE");
	}
	if (count === 3) {
		assert.ok(
			JSON.stringify(context.messages).includes("NESTED_CHILD_RESULT"),
			"the child completion reaches the parent's next turn without a wait",
		);
		return tool("subagent_collect", { id: childId });
	}
	if (count === 4) {
		assert.equal(lastResult(context, "subagent_collect").details.collectedId, childId);
		return tool("submit_result", { content: "NESTED_PARENT_RESULT" });
	}
	throw new Error(`Unexpected parent request ${count}`);
};
writeFileSync(
	providerPath,
	`import { fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const model = ${JSON.stringify(model)};
export default function(pi) {
  const respond = globalThis[Symbol.for("subagent-test.nested-idle")];
  const faux = fauxProvider({api: model.api, provider: model.provider, models: [model]});
  let role;
  const next = context => {
    const input = JSON.stringify(context.messages.find(message => message.role === "user"));
    role ??= input.includes("NESTED_ROOT_TASK") ? "root" : input.includes("NESTED_PARENT_TASK") ? "parent" : "child";
    return respond(role, context);
  };
  faux.setResponses(Array.from({length: 8}, () => next));
  pi.registerProvider(faux.provider);
}
`,
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [providerPath] }));
try {
	sub = await import("./index.ts");
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
	});
	await resourceLoader.reload();
	owner = (
		await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.create(cwd),
			model: model as never,
			thinkingLevel: "off",
			tools: ["subagent", "subagent_collect"],
		})
	).session;
	await owner.bindExtensions({ onError: captureError });
	await owner.prompt("NESTED_ROOT_TASK");
	const parent = sub.listWorkers().find((record) => record.task === "NESTED_PARENT_TASK")!;
	assert.ok(parent, "the parent is a managed worker, not a manually marked SDK session");
	await until(() => sub.readWorker(parent.id)?.idleSince != null, "the parent ends its turn and stays idle");
	assert.equal(sub.readWorker(parent.id)?.state, "running");
	assert.equal(sub.readWorker(childId)?.state, "running");
	assert.equal(sub.readWorker(childId)?.ownerSession, parent.sessionId);
	releaseChild();
	await until(() => sub.readWorker(childId)?.state === "done", "child submits while the parent is idle");
	await until(() => sub.readWorker(parent.id)?.state === "done", "parent resumes on the completion, collects and submits");
	assert.equal(readFileSync(sub.workerFiles(childId).result, "utf8"), "NESTED_CHILD_RESULT");
	assert.equal(readFileSync(sub.workerFiles(parent.id).result, "utf8"), "NESTED_PARENT_RESULT");
	assert.equal(calls.get("parent"), 4, "the idle worker makes exactly its scripted turns, no polling");
	assert.equal(calls.get("child"), 1);
	assert.match(prompts.get("parent") ?? "", /ending an assistant turn does not end your run/);
	assert.match(prompts.get("parent") ?? "", /Your session stays live and idle/);
	assert.match(prompts.get("parent") ?? "", /Do not call tools just to stay active/);
	assert.match(prompts.get("parent") ?? "", /arrive as custom messages/);
	assert.doesNotMatch(prompts.get("parent") ?? "", /subagent_wait/);
	assert.doesNotMatch(prompts.get("parent") ?? "", /peer wait/);
	assert.ok(
		requests
			.get("parent")
			?.some((message: any) => message.role === "toolResult" && message.toolName === "subagent_collect"),
	);
	await owner.waitForIdle();
	const ownerId = owner.sessionManager.getSessionId();
	sub.shutdownWorkerSession(owner);
	await until(() => !sub.sharedWorkerState.reportSinks.has(ownerId), "root releases its resources");
	owner = null;
	assert.deepEqual(errors, []);
	console.log("nested idle child: PASS");
} finally {
	releaseChild();
	try {
		if (owner) {
			await owner.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			owner.dispose();
		}
	} finally {
		delete (globalThis as any)[key];
		clearTimeout(watchdog);
		rmSync(root, { recursive: true, force: true });
		process.off("unhandledRejection", captureError);
		process.off("uncaughtException", captureError);
	}
}
