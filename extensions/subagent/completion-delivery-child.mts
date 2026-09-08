import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "completion-delivery-"));
process.env.HOME = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const errors: unknown[] = [];
const capture = (error: unknown) => errors.push(error);
process.on("unhandledRejection", capture);
process.on("uncaughtException", capture);
const { fauxAssistantMessage: reply, fauxToolCall: call } = await import("@earendil-works/pi-ai");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
	"@earendil-works/pi-coding-agent"
);
const sub = await import("./index.ts");
const gates = new Map<string, ReturnType<typeof gate>>();
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function until(check: () => boolean, label: string) {
	const deadline = Date.now() + 10_000;
	while (!check() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
	assert.ok(check(), label);
}
const activeTools: string[] = [];
const abortedTools: string[] = [];
const providerInputs: string[] = [];
let scenario = "";
let target = "";
let calls = 0;
let workerCalls = 0;
let nextAction: { name: string; args: Record<string, unknown> } | null = null;
const fixture = {
	collected: false,
	async hold(name: string, signal: AbortSignal) {
		activeTools.push(name);
		const held = gate();
		gates.set(name, held);
		const abort = () => {
			abortedTools.push(name);
			held.resolve();
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		await held.promise;
		signal?.removeEventListener("abort", abort);
		activeTools.splice(activeTools.indexOf(name), 1);
		return { content: [{ type: "text", text: signal?.aborted ? "ABORTED" : "RELEASED" }] };
	},
	respond(context: { messages: unknown[] }) {
		const serialized = JSON.stringify(context.messages);
		if (!JSON.stringify(context.messages[0]).includes("OWNER_")) {
			workerCalls++;
			return reply(call("fixture_hold", { name: "worker" }), { stopReason: "toolUse" });
		}
		providerInputs.push(serialized);
		if (scenario === "lifecycle") {
			const action = nextAction;
			nextAction = null;
			return action ? reply(call(action.name, action.args), { stopReason: "toolUse" }) : reply("OWNER_CONTROL_DONE");
		}
		calls++;
		if (calls === 1 && scenario !== "idle") {
			const tools = [call("fixture_hold", { name: "owner" })];
			if (scenario === "collected") tools.push(call("subagent_collect", { id: target }));
			return reply(tools, { stopReason: "toolUse" });
		}
		if (scenario === "idle") return reply(calls === 1 ? "INITIAL_CONCLUSION" : "LATE_EVIDENCE_REVIEWED");
		return reply(serialized.includes("DECISIVE_EVIDENCE") ? "CONCLUSION_WITH_EVIDENCE" : "PREMATURE_CONCLUSION");
	},
};
(globalThis as any)[Symbol.for("completion-fixture")] = fixture;
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
 const fixture = globalThis[Symbol.for("completion-fixture")];
 pi.on("tool_result", (event) => { if (event.toolName === "subagent_collect") fixture.collected = true; });
 const faux = fauxProvider({ api: ${JSON.stringify(model.api)}, provider: ${JSON.stringify(model.provider)}, models: [${JSON.stringify(model)}] });
 faux.setResponses(Array.from({ length: 30 }, () => context => fixture.respond(context)));
 pi.registerProvider(faux.provider);
 pi.registerTool({ name: "fixture_hold", label: "Fixture hold", description: "Controlled cancellable tool", parameters: Type.Object({name: Type.String()}), execute: (_id, args, signal) => fixture.hold(args.name, signal) });
}
`,
);
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ packages: [fixturePath] }));
let owner: any;
try {
	for (const name of ["active", "collected", "idle", "lifecycle"]) {
		scenario = name;
		calls = 0;
		providerInputs.length = 0;
		fixture.collected = false;
		gates.clear();
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
				sessionManager: SessionManager.inMemory(),
				model: model as never,
				thinkingLevel: "off",
				tools: [
					"subagent",
					"subagent_collect",
					"subagent_kill",
					"subagent_interrupt",
					"subagent_steer",
					"fixture_hold",
				],
			})
		).session;
		await owner.bindExtensions({ onError: capture });
		if (name === "lifecycle") {
			nextAction = { name: "subagent", args: { task: "WAITING_WORKER", deadlineMinutes: 1 } };
			await owner.prompt("OWNER_START");
			await until(() => activeTools.includes("worker"), "worker tool starts");
			const worker = sub.listWorkers().find((record) => record.task === "WAITING_WORKER")!;
			assert.ok(worker);
			nextAction = { name: "subagent_interrupt", args: { id: worker.id } };
			await owner.prompt("OWNER_PAUSE");
			assert.ok(sub.readWorker(worker.id)?.interruptedAt);
			assert.equal(activeTools.includes("worker"), false);
			assert.equal(abortedTools.length, 1);
			nextAction = { name: "subagent_steer", args: { id: worker.id, message: "Resume the remaining question." } };
			await owner.prompt("OWNER_RESUME");
			await until(() => activeTools.includes("worker"), "resume starts the next tool");
			assert.equal(workerCalls, 2);
			nextAction = { name: "subagent_kill", args: { id: worker.id } };
			await owner.prompt("OWNER_DECISIVE_EVIDENCE: the question is settled; stop the superseded recheck.");
			await until(() => sub.readWorker(worker.id)?.state === "cancelled", "superseded worker settles as cancelled");
			assert.equal(activeTools.includes("worker"), false);
			assert.equal(abortedTools.length, 2);
			assert.equal(workerCalls, 2, "cancellation starts no further provider work");
			assert.equal(
				owner.messages.some(
					(m: any) => m.role === "custom" && m.customType === "subagent_result" && m.details?.id === worker.id,
				),
				false,
				"explicit cancellation has no late completion",
			);
			await owner.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			owner.dispose();
			owner = null;
			continue;
		}
		target = `bg-notice${name}`;
		const now = Date.now();
		const record = {
			id: target,
			state: "done",
			task: "decisive evidence",
			model: "test/model",
			bootstrapModel: "test/model",
			thinking: "off",
			tools: null,
			cwd: root,
			createdAt: now,
			startedAt: now,
			exitedAt: now,
			notificationCallReturnedAt: null,
			error: null,
			usage: null,
			resultBytes: 17,
			resultPreview: "DECISIVE_EVIDENCE",
			ownerPid: process.pid,
			ownerSession: owner.sessionManager.getSessionId(),
			sessionId: "evidence-session",
			sessionFile: null,
			resolvedTools: [],
			toolSources: {},
		};
		const files = sub.workerFiles(target);
		mkdirSync(dirname(files.result), { recursive: true });
		writeFileSync(join(dirname(files.result), "worker.json"), JSON.stringify(record));
		writeFileSync(files.result, "DECISIVE_EVIDENCE");
		const run = owner.prompt(`OWNER_${name}`);
		if (name === "idle") await run;
		else await until(() => gates.has("owner"), "owner tool is active");
		if (name === "collected") await until(() => fixture.collected, "collection completes");
		assert.equal(
			sub.notifyCompletion(sub.readWorker(target)!, {
				sendMessage: (message, options) => {
					void owner.sendCustomMessage(message, options).catch(capture);
				},
			}),
			true,
		);
		gates.get("owner")?.resolve();
		await run;
		await owner.waitForIdle();
		assert.equal(calls, 2, `${name}: no redundant provider turn after the conclusion`);
		assert.match(providerInputs[1]!, /DECISIVE_EVIDENCE/);
		const completionInContext = providerInputs[1]!.includes(`Subagent ${target}`);
		assert.equal(
			completionInContext,
			name !== "collected",
			`${name}: exact collection replaces notification in model input`,
		);
		assert.equal(
			owner.messages.filter((m: any) => m.role === "custom" && m.customType === "subagent_result").length,
			1,
			"Pi keeps one original notification in history",
		);
		assert.doesNotMatch(JSON.stringify(owner.messages), /PREMATURE_CONCLUSION/);
		assert.equal(sub.collectWorker(target).workers[0]?.result, "DECISIVE_EVIDENCE");
		await owner.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		owner.dispose();
		owner = null;
	}
	assert.deepEqual(errors, []);
	console.log(
		"completion delivery child: PASS (active, exact collection, idle delivery, preserved results, pause/resume, superseded-work cancellation)",
	);
} finally {
	if (owner) {
		await owner.abort();
		await owner.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		owner.dispose();
	}
	for (const held of gates.values()) held.resolve();
	process.off("unhandledRejection", capture);
	process.off("uncaughtException", capture);
	rmSync(root, { recursive: true, force: true });
}
