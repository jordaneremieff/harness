import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { StoppedDoc } from "./conversation-stop.ts";
import { DurableHost } from "./durable-host.ts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { prepareScheduleSettings } from "./durable-schedule-fixture.mts";
import { createDurableServices } from "./durable-services.ts";
import { isThreadStorage } from "./identity.ts";
import { createPrimaryChannel } from "./primary-channel.ts";
import { withdrawStorageWork } from "./thread-storage-work.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const model = { provider: testModel.provider, modelId: testModel.id };
const NOTICE =
	"was admitted into this thread storage by an earlier host. A thread storage holds threads and runs no agent work: the host withdrew it, and it started no run.";

/** A model runtime that answers every request and counts it. */
async function countingRuntime() {
	const runtime = await createTestRuntime();
	let requests = 0;
	const stream = () => {
		requests += 1;
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "A model ran in a thread storage" }],
			api: testModel.api,
			provider: testModel.provider,
			model: testModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: message });
		events.push({ type: "done", reason: "stop", message });
		events.end(message);
		return events;
	};
	runtime.registerNativeProvider({
		id: testModel.provider,
		name: "Counting provider",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	return { runtime, requests: () => requests };
}

/** Closers run newest first, then the root goes: a host must close before its storage directory is removed. */
function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "thread-residue-")));
	const closers: Array<() => unknown> = [];
	t.after(async () => {
		for (const close of closers.reverse()) await close();
		rmSync(root, { recursive: true, force: true });
	});
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	prepareScheduleSettings(agentDir, true);
	const primary = randomUUID();
	const catalog = new AgentCatalog(root);
	const record = catalog.createThreadStorage({
		cwd,
		agentDir,
		packageDir: getPackageDir(),
		model,
		thinkingLevel: "off",
		trust: false,
		ownerId: primary,
	}).record;
	assert.equal(isThreadStorage(record, catalog.root), true);
	return { root, cwd, agentDir, primary, record, closers };
}

/**
 * Admit agent work into the thread storage through a host that does not know it is one, as a host without the
 * thread storage refusal served it, and stop that host before any of the work ran.
 */
async function admitWithoutRefusal(f: ReturnType<typeof fixture>, peer: string, deadline: number) {
	const { runtime } = await countingRuntime();
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: f.record.storageId,
		trusted: true,
		modelRuntime: runtime,
		onReport: () => undefined,
	});
	const host = await DurableHost.open({
		storagePath: f.record.storagePath,
		storageId: f.record.storageId,
		cwd: f.cwd,
		models: runtime,
		registry: services.registry,
		settings: services.settings,
		env: services.env,
		agent: { model },
		meta: { name: "Threads", owner: f.primary },
		resume: false,
	});
	try {
		await services.install(host.harness);
		const timer = (await host.request("timer-schedule", {
			sessionId: f.record.storageId,
			message: "RETAINED_SCHEDULED_INPUT",
			deliverAt: deadline,
			mode: "followUp",
			origin: "model",
			ownerId: peer,
			scheduleId: "retained-timer",
			requestId: "retained-timer-delivery",
		})) as { timerId: number };
		// The first input is placed and its run is created; the second waits in the queue behind that run.
		for (const [requestId, message] of [
			["retained-placed", "RETAINED_PLACED_INPUT"],
			["retained-queued", "RETAINED_QUEUED_INPUT"],
		])
			await host.request("submit", {
				sessionId: f.record.storageId,
				message,
				requestId,
				ownerId: peer,
				origin: "model",
			});
		return timer.timerId;
	} finally {
		await host.close();
		await services.close();
	}
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

type Runtime = Awaited<ReturnType<typeof createDurableRuntime>>;
const FIRST_REQUESTS: Record<string, (runtime: Runtime, f: ReturnType<typeof fixture>) => Promise<unknown>> = {
	// A host that the manager launches for recovery serves no request before its retained work is due.
	"a recovery launch": async () => undefined,
	"a thread mutation": (runtime, f) =>
		runtime.request(
			"collaboration-mutate",
			{
				sessionId: f.record.storageId,
				senderIdentity: f.primary,
				origin: "model",
				requestId: randomUUID(),
				action: "create",
				title: "Review",
				purpose: "Test",
				authority: "Task",
				source: "Test",
				restrictions: "Local",
				acceptance: "Verified",
			},
			randomUUID(),
		),
	"a plain attach": (runtime, f) => runtime.request("attach", { sessionId: f.record.storageId }, randomUUID()),
};

for (const [trigger, first] of Object.entries(FIRST_REQUESTS))
	it(`a thread storage host that starts for ${trigger} withdraws the agent work an earlier host admitted`, {
		timeout: 60000,
	}, async (t) => {
		const f = fixture(t);
		const peer = randomUUID();
		const deadline = Date.now() + 2500;
		const timerId = await admitWithoutRefusal(f, peer, deadline);
		// The session that sent the inputs is live, so it receives their outcome.
		const outcomes: string[] = [];
		const channel = await createPrimaryChannel({
			id: peer,
			cwd: f.cwd,
			sessionsRoot: f.root,
			deliver: (message) => {
				outcomes.push(JSON.stringify(message));
			},
			promptTrust: async () => undefined,
		});
		f.closers.push(() => channel.close());
		const current = await countingRuntime();
		const runtime = await createDurableRuntime(hostMetadata(f.record), { modelRuntime: current.runtime });
		f.closers.push(() => runtime.close());
		await first(runtime, f);
		const sessionId = f.record.storageId;
		const timer = async () =>
			(
				(await runtime.request("timer-list", { sessionId }, randomUUID())) as {
					timers: Array<{ timerId: number; status: string }>;
				}
			).timers.find((row) => row.timerId === timerId);
		assert.equal(
			await until(async () => (await timer())?.status === "cancelled", 15000),
			true,
			"the scheduled input ends as cancelled",
		);
		const why = `aborted: ${sessionId} is a thread storage of ${f.primary}; it holds threads and runs no agent work, so this input started no run.`;
		assert.equal(
			await until(async () => outcomes.filter((outcome) => outcome.includes(why)).length === 2, 15000),
			true,
			`the sender reads why each input got no answer: ${outcomes.join("\n")}`,
		);
		await until(async () => Date.now() > deadline + 500, 10000);
		assert.equal(current.requests(), 0, "no model request runs in a thread storage");
		const history = JSON.stringify(await runtime.request("inspect", { sessionId, view: "history" }, randomUUID()));
		for (const kept of ["RETAINED_SCHEDULED_INPUT", "RETAINED_QUEUED_INPUT", "RETAINED_PLACED_INPUT"])
			assert.ok(history.includes(kept), `the transcript keeps ${kept}`);
		assert.ok(history.includes(`This timer ${NOTICE}`), "the scheduled input states why it started no run");
		assert.ok(history.includes(`This followUp ${NOTICE}`), "the queued input states why it started no run");
		await assert.rejects(
			runtime.request("submit", { sessionId, message: "new work", ownerId: peer }, randomUUID()),
			/is a thread storage of/u,
		);
	});

/** A host of the thread storage on the current code, with direct access to its harness. */
async function openThreadHost(f: ReturnType<typeof fixture>, runtime: Awaited<ReturnType<typeof createTestRuntime>>) {
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: f.record.storageId,
		trusted: true,
		modelRuntime: runtime,
		onReport: () => undefined,
	});
	f.closers.push(() => services.close());
	const host = await DurableHost.open({
		storagePath: f.record.storagePath,
		storageId: f.record.storageId,
		cwd: f.cwd,
		models: runtime,
		registry: services.registry,
		settings: services.settings,
		env: services.env,
		agent: { model },
		meta: { name: "Threads", owner: f.primary },
		threadStorageOwner: f.primary,
		resume: false,
	});
	f.closers.push(() => host.close());
	await services.install(host.harness);
	await host.resume();
	return host;
}

it("a thread storage that only served threads starts again without a stop mark or a withdrawn entry", {
	timeout: 60000,
}, async (t) => {
	const f = fixture(t);
	const member = randomUUID();
	const serving = await createDurableRuntime(hostMetadata(f.record), {
		modelRuntime: (await countingRuntime()).runtime,
	});
	try {
		const created = (await FIRST_REQUESTS["a thread mutation"](serving, f)) as { threadId: string };
		await serving.request(
			"collaboration-mutate",
			{
				sessionId: f.record.storageId,
				senderIdentity: f.primary,
				origin: "model",
				requestId: randomUUID(),
				action: "post",
				threadId: created.threadId,
				kind: "contribution",
				message: "A notice for a member that is not live",
				notify: [member],
			},
			randomUUID(),
		);
	} finally {
		await serving.close();
	}
	const host = await openThreadHost(f, (await countingRuntime()).runtime);
	const root = host.root();
	assert.equal((await host.harness.snapshot(StoppedDoc, root.id, BACKGROUND_CONTEXT))?.stoppedAt ?? null, null);
	const kinds = (await root.context(BACKGROUND_CONTEXT)).entries.map((entry) => entry.kind);
	assert.equal(kinds.includes("agent.quiet-input"), false, kinds.join(", "));
});

it("a thread storage that retained agent work carries the stop mark of that withdrawal", {
	timeout: 60000,
}, async (t) => {
	const f = fixture(t);
	await admitWithoutRefusal(f, randomUUID(), Date.now() + 60_000);
	const host = await openThreadHost(f, (await countingRuntime()).runtime);
	const mark = await host.harness.snapshot(StoppedDoc, host.root().id, BACKGROUND_CONTEXT);
	assert.equal(typeof mark?.stoppedAt, "number");
});

it("keeps each withdrawn input once when a later start finds the withdrawal unfinished", {
	timeout: 60000,
}, async (t) => {
	const f = fixture(t);
	await admitWithoutRefusal(f, randomUUID(), Date.now() + 60_000);
	const runtime = (await countingRuntime()).runtime;
	const services = await createDurableServices({
		cwd: f.cwd,
		agentDir: f.agentDir,
		storageId: f.record.storageId,
		trusted: true,
		modelRuntime: runtime,
		onReport: () => undefined,
	});
	f.closers.push(() => services.close());
	// A paused host: the marked tasks cannot end between the two withdrawals.
	const host = await DurableHost.open({
		storagePath: f.record.storagePath,
		storageId: f.record.storageId,
		cwd: f.cwd,
		models: runtime,
		registry: services.registry,
		settings: services.settings,
		env: services.env,
		agent: { model },
		meta: { name: "Threads", owner: f.primary },
		resume: false,
	});
	f.closers.push(() => host.close());
	await services.install(host.harness);
	const withdraw = () =>
		host.harness.commit(
			(tx) => withdrawStorageWork(tx, { now: Date.now(), captureWork: async () => [] }),
			BACKGROUND_CONTEXT,
		);
	const first = await withdraw();
	assert.ok(first !== undefined && first.tasks.length >= 2, "the scheduled input and the created run are marked");
	assert.equal(await withdraw(), undefined);
	const kept = (await host.root().context(BACKGROUND_CONTEXT)).entries.filter(
		(entry) => entry.kind === "agent.quiet-input",
	);
	assert.equal(kept.length, 2, "one entry for the scheduled input and one for the queued input");
});

it("a run that starts in a thread storage ends before any model request", { timeout: 60000 }, async (t) => {
	const f = fixture(t);
	const current = await countingRuntime();
	const host = await openThreadHost(f, current.runtime);
	// An admission that passes the host's refusal, as a task of the storage itself makes it.
	const submission = await host.root().submit({ type: "input", content: "work past the refusal" }, BACKGROUND_CONTEXT);
	let settled: { status: string; reason?: string } | undefined;
	await until(async () => {
		settled = await submission.status(BACKGROUND_CONTEXT);
		return settled?.status === "unanswered" || settled?.status === "done";
	}, 15000);
	assert.deepEqual([settled?.status, settled?.reason], ["unanswered", "no_model"]);
	assert.equal(current.requests(), 0);
});
