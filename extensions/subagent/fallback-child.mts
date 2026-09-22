import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TranscriptContext } from "@earendil-works/pi-ai";

const root = mkdtempSync(join(tmpdir(), "subagent-fallback-"));
process.env.HOME = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.HOME);
mkdirSync(process.env.PI_CODING_AGENT_DIR);
delete process.env.PI_SUBAGENT_FALLBACK_MODELS;
delete process.env.PI_SUBAGENT_FIXTURE_MISSING_KEY;
const errors: unknown[] = [];
const capture = (error: unknown) => errors.push(error);
process.on("unhandledRejection", capture);
process.on("uncaughtException", capture);
const { fauxAssistantMessage: reply, fauxToolCall: call } = await import("@earendil-works/pi-ai");
const { createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } = await import(
	"@earendil-works/pi-coding-agent"
);
const sub = await import("./index.ts");
const models = ["primary", "second", "third"].map((provider) => ({
	id: "test",
	name: provider,
	provider,
	api: `${provider}-fixture`,
	baseUrl: "http://localhost:0",
	reasoning: provider === "second",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8000,
}));
let scenario = "";
let calls: string[] = [];
let sideEffects = 0;
let owner: AgentSession | undefined;
let currentId = "";
let ownerId = "";
const key = Symbol.for("subagent-test.model-fallback");
function primaryResponse() {
	if (scenario === "side-effects" && sideEffects === 0)
		return reply(call("fixture_effect", {}), { stopReason: "toolUse" });
	const text =
		scenario === "ordinary" ? "400 invalid request" : scenario === "auth" ? "401 unauthorized" : "insufficient_quota";
	return reply("", { stopReason: scenario === "aborted" ? "aborted" : "error", errorMessage: text });
}
const fixture = {
	removeAuth(sessionId: string) {
		return scenario === "worker-no-auth" && sessionId !== ownerId;
	},
	respond(provider: string, context: TranscriptContext) {
		if (context.messages.some((m) => /finished: (?:done|failed)/.test(JSON.stringify(m)))) return reply("OWNER_IDLE");
		calls.push(provider);
		if (scenario === "submit")
			return reply(call("submit_result", { content: "FIRST_RESULT" }), { stopReason: "toolUse" });
		if (provider === "primary") return primaryResponse();
		if (scenario === "exhaust") return reply("", { stopReason: "error", errorMessage: "429 Too many requests" });
		if (scenario === "side-effects") {
			assert.equal(sideEffects, 1);
			assert.ok(context.messages.some((m) => m.role === "toolResult" && m.toolName === "fixture_effect"));
		}
		assert.ok(
			context.messages.some((m) => JSON.stringify(m).includes("Model fallback: requested")) ||
				["offline", "configured", "batch", "worker-no-auth"].includes(scenario),
		);
		return reply(call("submit_result", { content: "FALLBACK_RESULT" }), { stopReason: "toolUse" });
	},
	effect() {
		sideEffects++;
	},
	async settled(sessionId: string) {
		if (!sub.sharedWorkerState.workerSessionIds.has(sessionId)) return;
		if (scenario === "cancel") await sub.cancelWorker(currentId, ownerId);
		if (scenario === "pause") await sub.interruptWorker(currentId, ownerId);
	},
};
const host = globalThis as Record<symbol, typeof fixture | undefined>;
host[key] = fixture;
const fixturePath = join(root, "provider.mjs");
writeFileSync(
	fixturePath,
	`
import { fauxProvider, createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
export default function(pi) {
 const fixture = globalThis[Symbol.for("subagent-test.model-fallback")];
 for (const model of ${JSON.stringify(models)}) {
  const faux = fauxProvider({api: model.api, provider: model.provider, models: [model]});
  faux.setResponses(Array.from({length: 30}, () => context => fixture.respond(model.provider, context)));
  const config = { api: model.api, apiKey: "fixture-not-used", baseUrl: model.baseUrl, models: [model], streamSimple(...args) {
   const output = createAssistantMessageEventStream();
   void (async () => {
    for await (const event of faux.provider.streamSimple(...args)) {
     if (model.provider === "primary" && event.type === "error") event.error.usage = {...event.error.usage, cost: {...event.error.usage.cost, input: 0.25, total: 0.25}};
     output.push(event);
    }
    output.end();
   })();
   return output;
  }};
  pi.registerProvider(model.provider, config);
  if (model.provider === "primary") pi.on("session_start", (_event, ctx) => {
   if (fixture.removeAuth(ctx.sessionManager.getSessionId())) pi.registerProvider(model.provider, {...config, apiKey: "$PI_SUBAGENT_FIXTURE_MISSING_KEY"});
  });
 }
 pi.registerTool({name: "fixture_effect", label: "Effect", description: "Count one effect", parameters: Type.Object({}), execute: async () => {fixture.effect(); return {content: [{type: "text", text: "EFFECT_DONE"}]};}});
 pi.on("agent_settled", (_event, ctx) => fixture.settled(ctx.sessionManager.getSessionId()));
}
`,
);
writeFileSync(
	join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
	JSON.stringify({ packages: [fixturePath], retry: { enabled: false }, compaction: { enabled: false } }),
);
async function until(check: () => boolean, label: string) {
	const end = Date.now() + 8000;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), `${label}; ${JSON.stringify(errors)}`);
}
try {
	const settingsManager = SettingsManager.create(root, process.env.PI_CODING_AGENT_DIR);
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		settingsManager,
		additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
	});
	await resourceLoader.reload();
	owner = (
		await createAgentSession({
			cwd: root,
			agentDir: process.env.PI_CODING_AGENT_DIR,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(root),
			model: models[0] as never,
			thinkingLevel: "off",
			tools: ["subagent", "fixture_effect"],
		})
	).session;
	await owner.bindExtensions({ onError: capture });
	ownerId = owner.sessionManager.getSessionId();
	sub.recordWorkerSurface(ownerId, owner.getActiveToolNames(), owner.getAllTools());
	const registry = new ModelRegistry(owner.modelRuntime);
	const auth = registry.hasConfiguredAuth.bind(registry);
	registry.hasConfiguredAuth = (model) =>
		scenario === "offline-all"
			? false
			: ["offline", "configured", "batch"].includes(scenario) && model.provider === "primary"
				? false
				: auth(model);
	const ctx = {
		cwd: root,
		model: models[0],
		modelRegistry: registry,
		thinkingLevel: "off",
		sessionManager: { getSessionId: () => ownerId },
		ui: { setStatus() {} },
	} as unknown as ExtensionContext;
	for (const name of [
		"quota",
		"auth",
		"exhaust",
		"ordinary",
		"aborted",
		"side-effects",
		"submit",
		"offline",
		"offline-all",
		"configured",
		"worker-no-auth",
		"inherited",
		"budget",
		"cancel",
		"pause",
	]) {
		scenario = name;
		calls = [];
		sideEffects = 0;
		ctx.thinkingLevel = name === "inherited" ? "high" : "off";
		if (name === "configured") process.env.PI_SUBAGENT_FALLBACK_MODELS = JSON.stringify({ review: ["second/test"] });
		const task = {
			task: `WORKER_${name}`,
			model: name === "offline-all" ? "test" : "primary/test",
			fallbackModels: name === "configured" ? undefined : ["second/test", "third/test"],
			taskClass: name === "configured" ? "review" : undefined,
			deadlineMinutes: 0,
			budgetUsd: name === "budget" ? 0.1 : undefined,
		};
		const outcome = await sub.dispatchWorker(task, { cwd: root }, ctx);
		delete process.env.PI_SUBAGENT_FALLBACK_MODELS;
		currentId = outcome.id;
		if (name === "offline-all") {
			assert.equal(outcome.state, "failed");
			assert.equal(outcome.record, null);
			assert.match(outcome.error ?? "", /exhausted/);
			assert.deepEqual(calls, []);
			continue;
		}
		assert.equal(outcome.state, "running", outcome.error);
		assert.ok(outcome.record?.modelFallback);
		if (["pause", "budget"].includes(name)) {
			await until(() => Boolean(sub.readWorker(outcome.id)?.interruptedAt), "paused");
			assert.deepEqual(calls, ["primary"]);
			await sub.cancelWorker(outcome.id, ownerId);
		} else {
			await until(() => sub.readWorker(outcome.id)?.state !== "running", `${name} terminal`);
		}
		const terminal = sub.readWorker(outcome.id);
		assert.ok(terminal?.modelFallback);
		if (["ordinary", "aborted", "cancel", "pause", "budget", "submit"].includes(name)) {
			assert.deepEqual(calls, ["primary"], name);
			assert.equal(terminal.modelFallback.events.length, 0);
		} else if (name === "exhaust") {
			assert.deepEqual(calls, ["primary", "second", "third"]);
			assert.equal(terminal.state, "failed");
			assert.equal(terminal.modelFallback.exhausted, true);
			assert.match(terminal.error ?? "", /exhausted/);
		} else {
			assert.equal(terminal.state, "done", `${name}: ${terminal.error}; calls ${calls.join(",")}`);
			assert.equal(terminal.model, "second/test");
			assert.equal(terminal.modelFallback.requested, "primary/test");
			assert.equal(terminal.modelFallback.events.length, 1);
			assert.equal(terminal.modelFallback.index, 1);
			assert.match(readFileSync(sub.workerFiles(outcome.id).result, "utf8"), /FALLBACK_RESULT/);
			assert.match(sub.collectWorker(outcome.id).text, /requested primary\/test; actual second\/test/);
			assert.match(sub.inspectWorker(outcome.id).text, /requested primary\/test; actual second\/test/);
			let notification: unknown;
			sub.notifyCompletion(
				{ ...terminal, notificationCallReturnedAt: null },
				{
					sendMessage(message) {
						notification = message;
					},
				},
			);
			assert.match(JSON.stringify(notification), /modelFallback/);
			assert.equal(terminal.deadlineMinutes, null);
			if (name === "side-effects") assert.equal(sideEffects, 1);
			if (name === "worker-no-auth") assert.deepEqual(calls, ["second"]);
			if (name === "quota") assert.equal(terminal.usage?.cost, 0.25);
			if (name === "inherited") {
				assert.equal(terminal.thinkingRequested, "high");
				assert.equal(terminal.thinking, "high");
				assert.ok(terminal.sessionFile);
				const sourceBytes = readFileSync(terminal.sessionFile, "utf8");
				scenario = "continuation";
				const continued = await sub.continueWorker(terminal.id, "Continue the preserved task", ctx);
				assert.equal(continued.state, "running", continued.error);
				await until(() => sub.readWorker(continued.id)?.state === "done", "fallback continuation completes");
				assert.equal(sub.readWorker(continued.id)?.modelFallback?.thinkingExplicit, false);
				assert.equal(sub.readWorker(continued.id)?.thinking, "high");
				assert.equal(readFileSync(terminal.sessionFile, "utf8"), sourceBytes);
			}
		}
		await owner.waitForIdle();
	}
	for (const task of [
		{ task: "invalid tools", tools: ["missing"], fallbackModels: ["second/test"] },
		{ task: "unknown model", model: "missing/test", fallbackModels: ["second/test"] },
		{ task: "unknown fallback", fallbackModels: ["missing/test"] },
		{ task: "unsupported thinking", thinking: "high" as const, fallbackModels: ["second/test"] },
	]) {
		scenario = "invalid";
		calls = [];
		const outcome = await sub.dispatchWorker(task, { cwd: root }, ctx);
		assert.equal(outcome.state, "failed");
		assert.deepEqual(calls, []);
	}
	scenario = "batch";
	calls = [];
	const dispatch = owner.extensionRunner.getToolDefinition("subagent");
	assert.ok(dispatch);
	const batch = await dispatch.execute(
		"batch",
		{
			tasks: [
				{ task: "WORKER_BATCH_A", fallbackModels: ["second/test"] },
				{ task: "WORKER_BATCH_B", model: "second/test", fallbackModels: [] },
			],
			model: "primary/test",
			fallbackModels: ["third/test"],
			deadlineMinutes: 0,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.match(JSON.stringify(batch), /requested primary\/test; actual second\/test/);
	const batchWorkers = sub.listWorkers().filter((record) => record.task.startsWith("WORKER_BATCH_"));
	assert.equal(batchWorkers.length, 2);
	await until(() => batchWorkers.every((record) => sub.readWorker(record.id)?.state === "done"), "batch completes");
	assert.deepEqual(calls, ["second", "second"]);
	assert.deepEqual(errors, []);
	console.log("model fallback child: PASS");
} finally {
	if (owner) {
		await owner.abort();
		await owner.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		owner.dispose();
	}
	delete host[key];
	process.off("unhandledRejection", capture);
	process.off("uncaughtException", capture);
	rmSync(root, { recursive: true, force: true });
}
