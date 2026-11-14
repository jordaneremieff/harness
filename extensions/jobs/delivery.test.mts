import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createJobActivity, recordId } from "./activity.ts";
import { completionJobId } from "./completion.ts";
import registerJobs from "./index.ts";

/**
 * Completion delivery against a real AgentSession: the record shown for a settled job must agree with the
 * session entries, whether Pi adds the completion, holds it, or loses it.
 */

const TIMEOUT = 60_000;
const model = {
	id: "deterministic",
	name: "Deterministic fixture",
	provider: "jobs-delivery-fixture",
	api: "openai-completions" as const,
	baseUrl: "http://invalid.invalid",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1024,
};
const WAIT_FOR_RELEASE = "while [ ! -f release ]; do sleep 0.01; done; exit 0";
const OUTCOME = "Background job succeeded · exit 0 · < 1 min";
const RUNNING = "Background job running · its completion starts the next turn";
const QUEUED = `${OUTCOME} · completion queued for the conversation`;
const SENT = `${OUTCOME} · completion sent, not in the conversation`;
const ADDED = `${OUTCOME} · completion in the conversation`;
const ABSENT = `${OUTCOME} · completion not in the conversation`;
const UNSENT = `${OUTCOME} · completion not sent`;

let root: string;
let previousAgentDir: string | undefined;
before(() => {
	root = mkdtempSync(join(tmpdir(), "jobs-delivery-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "agent"));
});
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** The message of each OSC 7501 record written for one job, in write order. */
function decode(writes: string[], jobId: string): string[] {
	const id = recordId(jobId);
	const messages: string[] = [];
	for (const text of writes) {
		const fields = new Map(
			(/^\x1b\]7501;(.*)\x1b\\$/su.exec(text)?.[1] ?? "").split(":").map((pair) => pair.split("=", 2) as [string, string]),
		);
		if (fields.get("id") !== id) continue;
		const msg = fields.get("msg");
		messages.push(msg === undefined ? `[${fields.get("state")}]` : Buffer.from(msg, "base64").toString("utf8"));
	}
	return messages;
}

/**
 * Before each run starts, `before_agent_start` waits while the gate is closed. The gate then lets preparation
 * continue, throws from the handler, or breaks preparation itself.
 */
type GateOutcome = "continue" | "throw" | "break";

async function harness(options: { failSend?: boolean } = {}) {
	const cwd = mkdtempSync(join(root, "cwd-"));
	const writes: string[] = [];
	const watchers = new Set<() => void>();
	const errors: Array<{ event: string; error: string }> = [];
	let pending: ToolCall | undefined;
	let replyGate: Promise<void> | undefined;
	let gate: { opened: Deferred; entered: Deferred; outcome: GateOutcome } | undefined;
	let sequence = 0;

	const activity = createJobActivity({
		write: (text) => {
			writes.push(text);
			for (const watch of watchers) watch();
		},
		isTTY: () => true,
		env: () => ({}),
	});
	const stream = () => {
		const events = createAssistantMessageEventStream();
		const call = pending;
		pending = undefined;
		const wait = call ? undefined : replyGate;
		if (!call) replyGate = undefined;
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: call ? [call] : [{ type: "text", text: "Done." }],
			stopReason: call ? "toolUse" : "stop",
			timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		void (async () => {
			await wait;
			events.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			events.end();
		})();
		return events;
	};
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: join(cwd, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(root, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => "Execute only the supplied deterministic fixture calls.",
		extensionFactories: [
			(pi) => {
				const api = options.failSend
					? new Proxy(pi, {
						get: (target, key, receiver) =>
							key === "sendMessage"
								? () => {
									throw new Error("send refused");
								}
								: Reflect.get(target, key, receiver),
					})
					: pi;
				registerJobs(api as ExtensionAPI, activity);
			},
			(pi) => {
				pi.registerProvider(model.provider, {
					api: model.api,
					baseUrl: model.baseUrl,
					apiKey: "synthetic-fixture-only",
					models: [model],
					streamSimple: stream,
				});
				pi.on("before_agent_start", async (event) => {
					const current = gate;
					if (!current) return;
					gate = undefined;
					current.entered.resolve();
					await current.opened.promise;
					if (current.outcome === "throw") throw new Error("gate refused");
					// An invalid tool selection makes Pi's run preparation throw after this handler returns.
					if (current.outcome === "break") (event.systemPromptOptions as { selectedTools?: unknown }).selectedTools = undefined;
				});
			},
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(root, "agent"),
		model,
		modelRuntime,
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		tools: ["bash", "jobs"],
	});
	await session.bindExtensions({
		mode: "tui",
		onError: (error) => {
			errors.push({ event: error.event, error: error.error });
			for (const watch of watchers) watch();
		},
	});

	return {
		session,
		writes,
		errors,
		/** Starts a background job through a model tool call and returns its id once the run settles. */
		async launch(command: string, gateReply = false): Promise<{ jobId: string; run: Promise<void>; replyOpen: Deferred }> {
			const id = `fixture-${++sequence}`;
			pending = { type: "toolCall", id, name: "bash", arguments: { command, background: true } };
			const replyOpen = deferred();
			if (gateReply) replyGate = replyOpen.promise;
			else replyOpen.resolve();
			const run = session.prompt(`Execute fixture step ${sequence}.`, { source: "rpc" });
			await this.until(() => session.messages.some((message) => message.role === "toolResult" && message.toolCallId === id));
			const result = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
			assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
			const jobId = (result.details as { job: { id: string } }).job.id;
			return { jobId, run, replyOpen };
		},
		closeGate(outcome: GateOutcome) {
			const current = { opened: deferred(), entered: deferred(), outcome };
			gate = current;
			return { entered: current.entered.promise, open: () => current.opened.resolve() };
		},
		release() {
			writeFileSync(join(cwd, "release"), "");
		},
		/** Resolves once the condition holds; record writes and session events re-check it. */
		until(condition: () => boolean): Promise<void> {
			if (condition()) return Promise.resolve();
			return new Promise((resolve) => {
				const unsubscribe = session.subscribe(() => watch());
				const watch = () => {
					if (!condition()) return;
					watchers.delete(watch);
					unsubscribe();
					resolve();
				};
				watchers.add(watch);
			});
		},
		records(jobId: string) {
			return decode(writes, jobId);
		},
		shown(jobId: string) {
			return decode(writes, jobId).at(-1);
		},
		/** Completion entries for this job on the current branch of the session. */
		retained(jobId: string) {
			return session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && completionJobId(entry) === jobId).length;
		},
		async dispose() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		},
	};
}
type Harness = Awaited<ReturnType<typeof harness>>;

/** Launches a job that waits for release, closes the gate, starts a run, and settles the job during preparation. */
async function settleDuringPreparation(h: Harness, outcome: GateOutcome) {
	const { jobId, run: launchRun } = await h.launch(WAIT_FOR_RELEASE);
	await launchRun;
	const gate = h.closeGate(outcome);
	const run = h.session.prompt("Continue.", { source: "rpc" });
	await gate.entered;
	assert.equal(h.session.isIdle, false, "Pi is busy while the run prepares");
	h.release();
	await h.until(() => h.shown(jobId) === QUEUED);
	return { jobId, run, open: gate.open };
}

describe("completion delivery state against a real AgentSession", () => {
	it("shows a completion queued during run preparation as in the conversation once the run delivers it", { timeout: TIMEOUT }, async () => {
		const h = await harness();
		try {
			const { jobId, run, open } = await settleDuringPreparation(h, "continue");
			assert.equal(h.retained(jobId), 0);
			open();
			await run;
			assert.equal(h.retained(jobId), 1);
			assert.deepEqual(h.records(jobId), ["Background job running", RUNNING, QUEUED, ADDED]);
			assert.deepEqual(h.errors, []);
		} finally {
			await h.dispose();
		}
	});

	it("does not claim addition when an abort ends the run before the queued completion arrives", { timeout: TIMEOUT }, async () => {
		const h = await harness();
		try {
			const { jobId, run, open } = await settleDuringPreparation(h, "continue");
			const aborted = h.session.abort();
			open();
			await run;
			await aborted;
			assert.equal(h.retained(jobId), 0);
			assert.equal(h.shown(jobId), ABSENT);
			assert.equal(h.session.agent.hasQueuedMessages(), true, "Pi still holds the completion after the abort");
			await h.session.prompt("Resume.", { source: "rpc" });
			assert.equal(h.retained(jobId), 1, "the next run delivers the held completion");
			assert.deepEqual(h.records(jobId), ["Background job running", RUNNING, QUEUED, ABSENT, ADDED]);
		} finally {
			await h.dispose();
		}
	});

	it("does not claim addition when Escape clears the queue that holds the completion", { timeout: TIMEOUT }, async () => {
		const h = await harness();
		try {
			const { jobId, run, open } = await settleDuringPreparation(h, "continue");
			h.session.clearQueue();
			const aborted = h.session.abort();
			open();
			await run;
			await aborted;
			assert.equal(h.session.agent.hasQueuedMessages(), false);
			await h.session.prompt("Resume.", { source: "rpc" });
			assert.equal(h.retained(jobId), 0, "the cleared completion never reaches the conversation");
			assert.deepEqual(h.records(jobId), ["Background job running", RUNNING, QUEUED, ABSENT]);
		} finally {
			await h.dispose();
		}
	});

	it("keeps the record and the entries in agreement when a before_agent_start handler throws", { timeout: TIMEOUT }, async () => {
		const h = await harness();
		try {
			const { jobId, run, open } = await settleDuringPreparation(h, "throw");
			open();
			await run;
			assert.equal(h.retained(jobId), 1, "Pi reports the handler error and continues the run");
			assert.deepEqual(h.records(jobId), ["Background job running", RUNNING, QUEUED, ADDED]);
			assert.deepEqual(h.errors.map((error) => error.event), ["before_agent_start"]);
		} finally {
			await h.dispose();
		}
	});

	it("keeps the record and the entries in agreement when run preparation fails", { timeout: TIMEOUT }, async () => {
		const h = await harness();
		try {
			const { jobId, run, open } = await settleDuringPreparation(h, "break");
			open();
			await assert.rejects(run, TypeError);
			assert.equal(h.session.isIdle, true);
			assert.equal(h.retained(jobId), 0);
			assert.equal(h.shown(jobId), QUEUED, "the completion stays in Pi's queue and no run settled");
			assert.equal(h.session.agent.hasQueuedMessages(), true);

			const idle = await h.launch(WAIT_FOR_RELEASE);
			await idle.run;
			assert.equal(h.retained(jobId), 1, "the next run delivers the held completion");
			assert.deepEqual(h.records(jobId), ["Background job running", RUNNING, QUEUED, ADDED]);
			const gate = h.closeGate("break");
			h.release();
			await gate.entered;
			gate.open();
			await h.until(() => h.errors.some((error) => error.event === "send_message"));
			assert.equal(h.session.isIdle, true);
			assert.equal(h.retained(idle.jobId), 0, "the completion that started the failed run is lost");
			assert.deepEqual(h.records(idle.jobId), ["Background job running", RUNNING, SENT]);
		} finally {
			await h.dispose();
		}
	});

	it("shows a completion queued during a streaming turn as in the conversation after the turn", { timeout: TIMEOUT }, async () => {
		const h = await harness();
		try {
			const { jobId, run, replyOpen } = await h.launch("exit 0", true);
			await h.until(() => h.shown(jobId) === QUEUED);
			assert.equal(h.retained(jobId), 0);
			replyOpen.resolve();
			await run;
			assert.equal(h.retained(jobId), 1);
			assert.deepEqual(h.records(jobId), ["Background job running", QUEUED, ADDED]);
		} finally {
			await h.dispose();
		}
	});

	it("shows a completion sent while idle as in the conversation once its run delivers it", { timeout: TIMEOUT }, async () => {
		const h = await harness();
		try {
			const { jobId, run } = await h.launch(WAIT_FOR_RELEASE);
			await run;
			h.release();
			await h.until(() => h.shown(jobId) === ADDED);
			await h.session.waitForIdle();
			assert.equal(h.retained(jobId), 1);
			assert.deepEqual(h.records(jobId), ["Background job running", RUNNING, SENT, ADDED]);
		} finally {
			await h.dispose();
		}
	});

	it("shows a completion that sendMessage refuses as not sent", { timeout: TIMEOUT }, async () => {
		const h = await harness({ failSend: true });
		try {
			const { jobId, run } = await h.launch(WAIT_FOR_RELEASE);
			await run;
			h.release();
			await h.until(() => h.shown(jobId) === UNSENT);
			await h.session.prompt("Continue.", { source: "rpc" });
			assert.equal(h.retained(jobId), 0);
			assert.deepEqual(h.records(jobId), ["Background job running", RUNNING, UNSENT]);
		} finally {
			await h.dispose();
		}
	});
});
