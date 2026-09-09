/**
 * Direct SDK regressions for the two activation races that source review alone
 * cannot settle:
 *
 * 1. Pre-streaming delivery. AgentSession sets its run-active flag inside
 *    `_runAgentPrompt`, so a leg that is still in prompt preflight (extension
 *    `input` handlers, template expansion, model validation) has a live leg and
 *    `isStreaming === false`. An event that arrives in that window must reach
 *    the run it is aimed at, not wait for the whole leg to finish. A blocking
 *    `input` handler holds that window open deterministically.
 *
 * 2. The idle bound behind a queued resume. An owner steer aimed at a paused
 *    worker whose abort has not landed queues a resume. The declared idle
 *    deadline must still release that worker; otherwise a wedged tool holds an
 *    AgentSession, its subscription, and a `running` record forever.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "subagent-activation-race-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const home = join(root, "home");
for (const path of [agentDir, cwd, home]) mkdirSync(path);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = home;
// A three-second window keeps the release deterministic and the fixture fast;
// the production default is unchanged.
process.env.PI_SUBAGENT_IDLE_MINUTES = "0.05";

const errors: unknown[] = [];
const captureError = (error: unknown) => errors.push(error);
process.on("unhandledRejection", captureError);
process.on("uncaughtException", captureError);
const watchdog = setTimeout(() => {
	console.error("Activation race fixture exceeded its runtime bound", errors);
	process.exit(1);
}, 40_000);

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const preflight = gate();
const preflightEntered = gate();
const holdForever = gate();
const calls = new Map<string, number>();
const contexts = new Map<string, any[][]>();
/** Worker record state observed at the moment a context carried the correction. */
let correctionObservedIdle: number | null | undefined;
let correctionCall = 0;
let owner: any;
let sub: typeof import("./index.ts");
let raceWorkerId = "";
let holdWorkerId = "";
let steerRequested = false;
let interruptRequested = false;
let holdRequested = false;

const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const tool = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const serialize = (messages: any[]) => JSON.stringify(messages);

async function until(check: () => boolean, description: string) {
	const end = Date.now() + 15_000;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(
		check(),
		`${description}; errors: ${JSON.stringify(errors)}; calls: ${JSON.stringify([...calls])}; workers: ${JSON.stringify(
			sub?.listWorkers().map(({ id, state, error, task, idleSince, interruptedAt }) => ({
				id,
				state,
				error,
				task,
				idleSince,
				interruptedAt,
			})),
		)}`,
	);
}

const model = {
	id: "race-model",
	name: "Race Model",
	api: "race-fixture-api",
	provider: "race-fixture",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};

const key = Symbol.for("subagent-test.activation-race");
const response = async (role: string, context: any) => {
	const count = (calls.get(role) ?? 0) + 1;
	calls.set(role, count);
	contexts.set(role, [...(contexts.get(role) ?? []), context.messages]);
	if (role === "owner") {
		if (count === 1) return tool("subagent", { task: "RACE_PREFLIGHT_TASK", purpose: "preflight race" });
		const serialized = serialize(context.messages);
		if (serialized.includes("START_HOLD_WORKER") && !holdRequested) {
			holdRequested = true;
			return tool("subagent", { task: "RACE_HOLD_TASK", purpose: "wedged abort" });
		}
		if (serialized.includes("PAUSE_HOLD_WORKER") && !interruptRequested) {
			interruptRequested = true;
			return tool("subagent_interrupt", { id: holdWorkerId });
		}
		if (serialized.includes("RESUME_HOLD_WORKER") && !steerRequested) {
			steerRequested = true;
			return tool("subagent_steer", { id: holdWorkerId, message: "continue please" });
		}
		return fauxAssistantMessage("OWNER_IDLE");
	}
	if (role === "race") {
		// The first turn holds the run open with a gated tool so the steer that
		// was sent during preflight has a live run to reach.
		if (count === 1) return tool("fixture_hold", { stage: "race" });
		if (serialize(context.messages).includes("PREFLIGHT_CORRECTION")) {
			correctionObservedIdle = sub.readWorker(raceWorkerId)?.idleSince;
			correctionCall = count;
			return tool("submit_result", { content: "RACE_RESULT" });
		}
		return fauxAssistantMessage("RACE_IDLE");
	}
	// The wedged worker never returns from its tool: its abort cannot land.
	if (count === 1) return tool("fixture_hold", { stage: "forever" });
	return fauxAssistantMessage("HOLD_IDLE");
};

(globalThis as any)[key] = {
	response,
	async hold(stage: string) {
		if (stage === "forever") {
			await holdForever.promise;
			return;
		}
		// Release the race worker's tool once the correction has been queued.
		await preflight.promise;
	},
	async input(text: string) {
		if (!text.includes("RACE_PREFLIGHT_TASK")) return;
		preflightEntered.resolve();
		await preflight.promise;
	},
};

const providerPath = join(agentDir, "race-fixture.mjs");
writeFileSync(
	providerPath,
	`
import { fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
const model = ${JSON.stringify(model)};
export default function(pi) {
  const fixture = globalThis[Symbol.for("subagent-test.activation-race")];
  pi.registerTool({ name: "fixture_hold", label: "Fixture Hold", description: "Hold the run open at an owned boundary.",
    parameters: Type.Object({stage: Type.String()}),
    async execute(_id, args) { await fixture.hold(args.stage); return {content: [{type: "text", text: "hold released"}], details: {}}; }
  });
  // A blocking input handler keeps prompt() inside preflight, where the session
  // has not set its run-active flag yet.
  pi.on("input", async (event) => { await fixture.input(event.text ?? ""); });
  const faux = fauxProvider({api: model.api, provider: model.provider, models: [model]});
  let role;
  const identify = messages => {
    const input = JSON.stringify(messages.find(message => message.role === "user"));
    return input.includes("OWNER_RACE_SCENARIO") ? "owner" : input.includes("RACE_PREFLIGHT_TASK") ? "race" : "hold";
  };
  const respond = context => {
    role ??= identify(context.messages);
    return fixture.response(role, context);
  };
  faux.setResponses(Array.from({length: 24}, () => respond));
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
		})
	).session;
	await owner.bindExtensions({ onError: captureError });
	const ownerId = owner.sessionManager.getSessionId();

	// ---------------------------------------------------------------- case 1
	const ownerTurn = owner.prompt("OWNER_RACE_SCENARIO");
	await preflightEntered.promise;
	await until(() => sub.listWorkers().some((record) => record.task === "RACE_PREFLIGHT_TASK"), "the worker is created");
	raceWorkerId = sub.listWorkers().find((record) => record.task === "RACE_PREFLIGHT_TASK")!.id;
	const raceRecord = sub.readWorker(raceWorkerId)!;
	assert.equal(raceRecord.state, "running");
	assert.equal(raceRecord.idleSince, null, "the worker is in its first leg, not idle");
	assert.equal(calls.get("race"), undefined, "no model call has happened yet: the leg is still in preflight");
	// The event is sent while the leg exists and the session is not streaming.
	const receipt = sub.sharedWorkerState.peerHub.send(ownerId, raceWorkerId, "PREFLIGHT_CORRECTION: use revision v2");
	assert.equal(receipt.status, "sent_unconfirmed");
	preflight.resolve();

	await until(() => sub.readWorker(raceWorkerId)?.state === "done", "the race worker submits after the correction");
	// Call 1 opened the gated tool; call 2 is the same leg's next model call,
	// which is exactly where a steer lands. A leg-end deferral would instead
	// settle the worker and deliver the correction in a later activation leg
	// (call 3).
	assert.equal(correctionCall, 2, "the correction reached the next model call of the SAME leg");
	assert.equal(correctionObservedIdle, null, "the worker was not idle when the correction arrived");
	assert.equal(sub.readWorker(raceWorkerId)?.usage?.turns !== undefined, true);
	await ownerTurn;

	// ---------------------------------------------------------------- case 2
	await owner.prompt("START_HOLD_WORKER");
	await until(() => sub.listWorkers().some((record) => record.task === "RACE_HOLD_TASK"), "the wedged worker starts");
	holdWorkerId = sub.listWorkers().find((record) => record.task === "RACE_HOLD_TASK")!.id;
	await until(() => calls.get("hold") === 1, "the wedged worker entered its tool");
	await owner.prompt("PAUSE_HOLD_WORKER");
	await until(() => Boolean(sub.readWorker(holdWorkerId)?.interruptedAt), "the owner pauses the wedged worker");
	// The tool never returns, so the abort cannot land and the run stays busy.
	await owner.prompt("RESUME_HOLD_WORKER");
	assert.equal(sub.readWorker(holdWorkerId)?.state, "running", "the resume is queued, not started");
	assert.ok(sub.readWorker(holdWorkerId)?.interruptedAt, "the worker is still paused while the resume waits");
	await until(
		() => sub.readWorker(holdWorkerId)?.state === "idle_expired",
		"the declared idle deadline still releases a paused worker holding a queued resume",
	);
	const expired = sub.readWorker(holdWorkerId)!;
	assert.match(expired.error ?? "", /released by the declared idle deadline/);
	assert.match(expired.error ?? "", /paused for 3 seconds/);
	assert.ok(expired.sessionFile, "the transcript is retained for collection or continuation");

	holdForever.resolve();
	await owner.waitForIdle();
	sub.shutdownWorkerSession(owner);
	await until(() => !sub.sharedWorkerState.reportSinks.has(ownerId), "owner shutdown releases its resources");
	owner = null;
	console.log("activation race child: PASS (preflight steer reaches its own leg; a queued resume stays bounded)");
} finally {
	preflight.resolve();
	holdForever.resolve();
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
