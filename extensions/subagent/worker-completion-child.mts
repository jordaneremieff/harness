import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "worker-completion-"));
process.env.HOME = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.HOME);
mkdirSync(process.env.PI_CODING_AGENT_DIR);
const errors: unknown[] = [];
const capture = (error: unknown) => errors.push(error);
process.on("unhandledRejection", capture);
process.on("uncaughtException", capture);
const { fauxAssistantMessage: reply, fauxToolCall: call } = await import("@earendil-works/pi-ai");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
	"@earendil-works/pi-coding-agent"
);
const sub = await import("./index.ts");
let scenario = "";
let ownerCalls = 0;
let workerCalls = 0;
let toolFinished = false;
let toolAborted = false;
let turns = 0;
let beforeSettle = 0;
let compactions = 0;
const fixture = {
	respond(context: TranscriptContext) {
		if (JSON.stringify(context.messages.find((message) => message.role === "user")).includes("OWNER")) {
			ownerCalls++;
			return ownerCalls === 1
				? reply(call("subagent", { task: `WORKER_${scenario}`, deadlineMinutes: 0 }), { stopReason: "toolUse" })
				: reply("OWNER_IDLE");
		}
		workerCalls++;
		if (scenario === "idle") return reply("WAIT_FOR_PEER");
		if (scenario === "error" || scenario === "aborted") {
			return reply("NOT_A_SUBMISSION", { stopReason: scenario, errorMessage: "fixture failure" });
		}
		if (scenario === "continuation" && workerCalls === 1) return reply("BEFORE_BOUNDARY");
		assert.equal(
			workerCalls,
			scenario === "continuation" ? 2 : 1,
			"submission must not start another provider request",
		);
		const tools = [call("submit_result", { content: "ACCEPTED_RESULT" })];
		if (scenario === "mixed" || scenario === "queued") tools.push(call("fixture_sibling", {}));
		if (scenario === "duplicate") tools.push(call("submit_result", { content: "REJECTED_RESULT" }));
		const message = reply(tools, { stopReason: "toolUse" });
		if (scenario === "compaction") {
			message.usage = { ...message.usage, input: 127000, output: 1, totalTokens: 127001 };
		}
		return message;
	},
	async sibling(signal: AbortSignal | undefined) {
		// Cross an asynchronous tool boundary after the synchronous submission claim.
		await new Promise<void>((resolve) => setImmediate(resolve));
		toolAborted = signal?.aborted ?? false;
		toolFinished = true;
		return { content: [{ type: "text", text: "SIBLING_RESULT" }] };
	},
	isWorker(id: string) {
		return sub.sharedWorkerState.workerSessionIds.has(id);
	},
	get scenario() {
		return scenario;
	},
	turn() {
		turns++;
	},
	beforeSettle() {
		beforeSettle++;
		return beforeSettle;
	},
	compact() {
		compactions++;
	},
};
const key = Symbol.for("subagent-test.worker-completion");
const host = globalThis as Record<symbol, typeof fixture | undefined>;
host[key] = fixture;
const model = {
	id: "completion-model",
	name: "Completion model",
	provider: "completion-provider",
	api: "completion-api",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16000,
};
const fixturePath = join(root, "fixture.mjs");
writeFileSync(
	fixturePath,
	`
import { fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
export default function(pi) {
 const fixture = globalThis[Symbol.for("subagent-test.worker-completion")];
 const faux = fauxProvider({ api: ${JSON.stringify(model.api)}, provider: ${JSON.stringify(model.provider)}, models: [${JSON.stringify(model)}] });
 faux.setResponses(Array.from({length: 12}, () => context => fixture.respond(context)));
 pi.registerProvider(faux.provider);
 pi.registerTool({ name: "fixture_sibling", label: "Sibling", description: "Asynchronous sibling", parameters: Type.Object({}),
  execute: async (_id, _args, signal) => {
   if (fixture.scenario === "queued") {
    pi.sendUserMessage("QUEUED_STEER", {deliverAs: "steer"});
    pi.sendUserMessage("QUEUED_FOLLOWUP", {deliverAs: "followUp"});
   }
   return fixture.sibling(signal);
  }
 });
 pi.on("turn_end", (event, ctx) => {
  if (!fixture.isWorker(ctx.sessionManager.getSessionId())) return;
  fixture.turn();
  if (fixture.scenario !== "queued") return;
  return {entries: [...event.entries, {type: "custom_message", customType: "fixture-boundary", content: "PERSISTED_BOUNDARY", display: false}], continue: true};
 });
 pi.on("agent_end", (_event, ctx) => {
  if (fixture.isWorker(ctx.sessionManager.getSessionId()) && fixture.scenario === "queued")
   pi.sendUserMessage("LATE_FOLLOWUP", {deliverAs: "followUp"});
 });
 pi.on("agent_before_settle", (event, ctx) => {
  if (!fixture.isWorker(ctx.sessionManager.getSessionId())) return;
  const count = fixture.beforeSettle();
  if (fixture.scenario === "queued" || (fixture.scenario === "continuation" && count === 1))
   return {entries: [...event.entries, {type: "custom_message", customType: "fixture-continue", content: "CONTINUE_ONCE", display: false}], continue: true};
 });
 pi.on("session_before_compact", (_event, ctx) => {
  if (fixture.isWorker(ctx.sessionManager.getSessionId())) fixture.compact();
 });
}
`,
);
writeFileSync(
	join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
	JSON.stringify({
		packages: [fixturePath],
		retry: { enabled: false },
		compaction: { enabled: true },
	}),
);
async function until(check: () => boolean, label: string) {
	const deadline = Date.now() + 8000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), `${label}; errors: ${JSON.stringify(errors)}`);
}
let owner: AgentSession | null = null;
try {
	for (const name of ["mixed", "duplicate", "queued", "compaction", "continuation", "idle", "error", "aborted"]) {
		scenario = name;
		ownerCalls = workerCalls = turns = beforeSettle = compactions = 0;
		toolFinished = toolAborted = false;
		const settingsManager = SettingsManager.create(root, process.env.PI_CODING_AGENT_DIR);
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: process.env.PI_CODING_AGENT_DIR,
			settingsManager,
			additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
		});
		await resourceLoader.reload();
		owner = (
			await createAgentSession({
				cwd: root,
				agentDir: process.env.PI_CODING_AGENT_DIR,
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(root),
				model: model as never,
				thinkingLevel: "off",
				tools: ["subagent", "fixture_sibling"],
			})
		).session;
		await owner.bindExtensions({ onError: capture });
		await owner.prompt("OWNER_DISPATCH");
		const worker = sub.listWorkers().find((record) => record.task === `WORKER_${name}`);
		assert.ok(worker);
		if (name === "idle") {
			await until(() => sub.readWorker(worker.id)?.idleSince != null, "ordinary stop remains live and idle");
			assert.equal(sub.readWorker(worker.id)?.state, "running");
			assert.equal(workerCalls, 1, "idle collaboration starts no unsolicited submit request");
		} else {
			await until(() => sub.readWorker(worker.id)?.state !== "running", `${name} settles`);
			const terminal = sub.readWorker(worker.id);
			assert.ok(terminal);
			if (name === "error" || name === "aborted") {
				assert.equal(terminal.state, "failed");
				assert.equal(workerCalls, 1, "errors and aborts start no submit request");
				assert.equal(sub.collectWorker(worker.id).workers[0]?.result, undefined);
			} else {
				assert.equal(terminal.state, "done");
				assert.equal(readFileSync(sub.workerFiles(worker.id).result, "utf8"), "ACCEPTED_RESULT");
				assert.equal(workerCalls, name === "continuation" ? 2 : 1);
				assert.equal(turns, workerCalls, "the installed turn boundary still runs");
				assert.equal(
					beforeSettle,
					name === "continuation" ? 1 : 0,
					"accepted submission suppresses outer continuation",
				);
				assert.equal(compactions, 0, "submission starts no compaction request");
				assert.ok(terminal.sessionFile);
				const retained = SessionManager.open(terminal.sessionFile).buildSessionContext().messages;
				const results = retained.filter((message) => message.role === "toolResult");
				assert.equal(results.length, name === "mixed" || name === "queued" || name === "duplicate" ? 2 : 1);
				if (name === "mixed" || name === "queued") {
					assert.equal(toolFinished, true, "the sibling executes after the result claim");
					assert.equal(toolAborted, false, "submission does not abort a sibling tool");
					assert.ok(
						results.some(
							(result) =>
								result.toolName === "fixture_sibling" &&
								!result.isError &&
								JSON.stringify(result.content).includes("SIBLING_RESULT"),
						),
					);
				}
				if (name === "duplicate") {
					assert.equal(results.filter((result) => result.isError).length, 1);
					assert.match(JSON.stringify(results), /first result remains authoritative/);
				}
				if (name === "queued") assert.match(JSON.stringify(retained), /PERSISTED_BOUNDARY/);
			}
		}
		await owner.waitForIdle();
		await owner.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		owner.dispose();
		owner = null;
	}
	assert.deepEqual(errors, []);
	console.log("worker completion child: PASS");
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
