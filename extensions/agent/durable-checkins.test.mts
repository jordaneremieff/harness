import { deliveryState as readRetainedDelivery } from "./delivery-store.ts";
import { editDeliveryFixture, waitForDeliveryFixture } from "./delivery-store-fixture.mts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { recordDeliveryIntent, settleDeliveries, type DeliveryReport } from "./durable-controls.ts";
import {
	CheckInTask,
	CheckInDeadlineTask,
	CheckInParkedSignal,
	CheckInPauseDoc,
	checkInPauseKey,
	createCheckIn,
	resumePausedCheckIn,
} from "./durable-checkins.ts";
import { retainedReport, storeDeliveryRow } from "./delivery-store.ts";
import { startDurableDelivery } from "./durable-delivery.ts";
import { AgentCatalog } from "./catalog.ts";
import { parseHostMetadata } from "./host-protocol.ts";
import { createPrimaryChannel } from "./primary-channel.ts";
import { savedTranscript } from "./primary-transcript-fixture.mts";
import { randomUUID } from "node:crypto";
import {
	Harness,
	MemoryStorage,
	createRegistry,
	defineExtension,
	AssistantEntry,
	CompactionEntry,
	LiveDoc,
	UserEntry,
	type ConversationId,
	type SubmissionRecord,
	type Tx,
} from "@earendil-works/pi-durable";
import { testModel } from "./test-runtime.mts";
import { scheduleFixture } from "./durable-schedule-fixture.mts";
import { checkInMinutes } from "./check-in-options.ts";
import { AwaitDoc } from "./awaited-results.ts";
import { bindDispatch, confirmDispatch, recoverFailedDelegations } from "./delegated-recovery.ts";
import { OpenWorkDoc } from "./open-work.ts";

function settingsDirectory(t: { after(fn: () => void): void }): string {
	const directory = mkdtempSync(join(tmpdir(), "check-in-settings-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

it("arms no check-in by default and applies a configured interval only to model tool admissions", (t) => {
	const directory = settingsDirectory(t);
	assert.equal(checkInMinutes(undefined, "model", directory, {}), 0);
	assert.equal(checkInMinutes(undefined, "operator", directory, {}), 0);
	assert.equal(checkInMinutes(undefined, "model", directory, { PI_AGENT_CHECK_IN_MINUTES: "7" }), 7);
	assert.equal(checkInMinutes(0, "model", directory, {}), 0);
	assert.equal(checkInMinutes(undefined, "model", directory, { PI_AGENT_CHECK_IN_MINUTES: "0" }), 0);
	for (const value of [-1, Infinity, 35792]) assert.throws(() => checkInMinutes(value, "model", directory, {}));
});

for (const raw of ["", "  ", "bad", "-1", "Infinity", "35792"])
	it(`uses the safe default for invalid environment interval ${JSON.stringify(raw)}`, (t) => {
		const directory = settingsDirectory(t);
		const env = { PI_AGENT_CHECK_IN_MINUTES: raw };
		assert.equal(checkInMinutes(undefined, "model", directory, env), 0);
		assert.equal(checkInMinutes(0, "model", directory, env), 0, "a per-call override does not use the default");
		assert.equal(checkInMinutes(undefined, "operator", directory, env), 0);
	});

it("creates a host-owned check-in without a native agent contribution, and ends it at settlement", {
	timeout: 60000,
}, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: false, deferFirstAnswer: true });
	t.after(() => f.releaseAnswer());
	await f.host.request("submit", {
		sessionId: f.storageId,
		message: "held task",
		requestId: "check-held",
		ownerId: f.ownerId,
		origin: "model",
		checkInMinutes: 30,
	});
	await f.waitForFirstRequest();
	const checkTask = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
		(task) => task.record.kind === "agent.check-in",
	);
	assert.ok(checkTask);
	const conversation = await f.host.harness.conversation(1 as ConversationId, BACKGROUND_CONTEXT);
	assert.ok(conversation);
	const input = (await conversation.entries({}, 10, undefined, BACKGROUND_CONTEXT)).items.find(
		(entry) => entry.kind === "agent.input",
	);
	assert.ok(input);
	assert.deepEqual(input.data, { author: { role: "agent" }, class: "followUp", requestId: "check-held" });
	f.releaseAnswer();
	await f.waitForReceipt("check-held");
	await f.host.harness.waitForTask(checkTask.record.id, BACKGROUND_CONTEXT);
	await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(await f.host.refreshIdle(), true, "settlement releases the background deadline task");
	assert.equal((await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true))?.reports.length ?? 0, 0);
});

it("ends retained deadline work when recovery finds an already settled submission", { timeout: 5000 }, async (t) => {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "fixture.check-in", tasks: [CheckInTask, CheckInDeadlineTask] }));
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry, now: () => 1000 },
		BACKGROUND_CONTEXT,
	);
	t.after(() => harness.close(BACKGROUND_CONTEXT));
	const root = await harness.root(BACKGROUND_CONTEXT);
	const input = {
		conversationId: Number(root.id),
		requestId: "settled-before-recovery",
		ownerId: "recipient",
		senderIdentity: "storage",
		message: "finished",
		whenBusy: "followUp" as const,
		origin: "model" as const,
		admittedAt: 1000,
		intervalMs: 1800000,
	};
	const ids = await harness.commit(async (tx) => {
		const submission = await tx.createSubmission({
			conversationId: root.id,
			requestId: input.requestId,
			type: "input",
			status: "queued",
		});
		tx.settleSubmission(submission.id, { status: "unanswered", reason: "aborted" });
		const parent = await tx.createTask(CheckInTask, input, {
			ownership: { kind: "conversation" },
			conversationId: root.id,
			background: true,
		});
		const child = await tx.createTask(
			CheckInDeadlineTask,
			{ ...input, next: 1 },
			{ ownership: { kind: "task", taskId: parent }, conversationId: root.id },
		);
		return { parent, child };
	}, BACKGROUND_CONTEXT);
	harness.resume();
	await harness.waitForTask(ids.parent, withAbortSignal(AbortSignal.timeout(1000), BACKGROUND_CONTEXT));
	assert.equal((await harness.getTask(ids.child, BACKGROUND_CONTEXT))?.state.status, "terminal");
	assert.equal((await readRetainedDelivery(harness, BACKGROUND_CONTEXT, true))?.reports.length ?? 0, 0);
});

it("keeps the check-in of an input whose failure leaves delegated work for its receipt to recover", {
	timeout: 10000,
}, async (t) => {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "fixture.check-in", tasks: [CheckInTask, CheckInDeadlineTask] }));
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry, now: () => 1000 },
		BACKGROUND_CONTEXT,
	);
	t.after(() => harness.close(BACKGROUND_CONTEXT));
	const root = await harness.root(BACKGROUND_CONTEXT);
	const input = {
		conversationId: Number(root.id),
		requestId: "failed-with-delegations",
		ownerId: "recipient",
		senderIdentity: "storage",
		message: "delegate and report",
		whenBusy: "followUp" as const,
		origin: "model" as const,
		admittedAt: 1000,
		intervalMs: 1800000,
	};
	const ids = await harness.commit(async (tx) => {
		const entry = await tx.appendEntry(root.id, {
			kind: "agent.input",
			model: [{ role: "user", content: "delegate and report", timestamp: 1000 }],
		});
		const submission = await tx.createSubmission({
			conversationId: root.id,
			requestId: input.requestId,
			type: "input",
			status: "placed",
			entry: entry.id,
		});
		// The run sent one child request, its admission is confirmed, and then a provider error ended the run.
		const parent = {
			requestId: input.requestId,
			requester: "recipient",
			replyTo: "recipient",
			origin: "model" as const,
			submissionId: submission.id,
			entry: entry.id,
			self: "storage",
		};
		await bindDispatch(tx, root.id, "dispatch", parent, "child-storage", "child-request");
		await confirmDispatch(tx, root.id, "dispatch", {
			sessionId: "child-storage",
			submissionId: 7,
			requestId: "child-request",
		});
		tx.settleSubmission(submission.id, {
			status: "unanswered",
			reason: "model_error",
			detail: "WebSocket closed 1012",
		});
		const checkIn = await tx.createTask(CheckInTask, input, {
			ownership: { kind: "conversation" },
			conversationId: root.id,
			background: true,
		});
		const deadline = await tx.createTask(
			CheckInDeadlineTask,
			{ ...input, next: 1 },
			{ ownership: { kind: "task", taskId: checkIn }, conversationId: root.id },
		);
		return { submission: submission.id, checkIn, deadline };
	}, BACKGROUND_CONTEXT);
	harness.resume();
	// The check-in decides when its input settles; the receipt pass of the delivery watcher runs after that. A
	// check-in that ends does so at once, and one that keeps its deadline stays in its wait.
	const ended = await harness
		.waitForTask(ids.checkIn, withAbortSignal(AbortSignal.timeout(300), BACKGROUND_CONTEXT))
		.then(
			() => true,
			() => false,
		);
	const recovered = await harness.commit(async (tx) => {
		const record = await tx.submission(ids.submission);
		assert.ok(record);
		return recoverFailedDelegations(tx, record, 1000);
	}, BACKGROUND_CONTEXT);
	assert.equal(recovered, true, "the receipt opens recovered work for the request");
	const work = await harness.snapshot(OpenWorkDoc, root.id, BACKGROUND_CONTEXT);
	assert.equal(work?.items[0]?.recovered, true);
	assert.equal(work?.items[0]?.requestId, input.requestId);
	assert.equal(ended, false, "the check-in ended before the receipt opened the recovered work");
	assert.notEqual((await harness.getTask(ids.checkIn, BACKGROUND_CONTEXT))?.state.status, "terminal");
	assert.equal((await harness.getTask(ids.deadline, BACKGROUND_CONTEXT))?.state.status, "sleeping");
});

it("cancels the owned sleeping deadline without cancelling the producer input", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: false, deferAnswers: true });
	t.after(() => f.releaseAnswer());
	await f.host.request("submit", {
		sessionId: f.storageId,
		message: "held producer",
		requestId: "cancel-check-in",
		ownerId: f.ownerId,
		origin: "model",
		checkInMinutes: 30,
	});
	await f.waitForFirstRequest();
	const graph = await f.host.harness.watchTaskGraph(BACKGROUND_CONTEXT);
	const deadline = (value: typeof graph.value) =>
		Object.values(value.tasks).find(
			(node) => node.kind === CheckInDeadlineTask.definition.name && node.state.status === "sleeping",
		);
	try {
		if (deadline(graph.value) === undefined)
			await new Promise<void>((resolve) =>
				graph.start(async (call) => {
					if (call.kind === "value" && deadline(call.value) !== undefined) resolve();
				}),
			);
		const child = deadline(graph.value);
		assert.ok(child?.owner);
		await f.host.harness.abortTask(child.owner, BACKGROUND_CONTEXT);
		// abortTask commits the mark and schedules the abort invocation; the deadline ends with it.
		await f.host.harness.waitForTask(child.id, BACKGROUND_CONTEXT);
		assert.equal((await f.host.harness.getTask(child.id, BACKGROUND_CONTEXT))?.state.status, "terminal");
		const watched = await f.host.harness.commit(
			(tx) => tx.submissionByRequest(1 as ConversationId, "cancel-check-in"),
			BACKGROUND_CONTEXT,
		);
		assert.equal(watched?.status, "placed");
		f.releaseAnswer();
		assert.equal((await f.waitForReceipt("cancel-check-in")).status, "done");
		assert.equal((await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true))?.reports.length ?? 0, 0);
	} finally {
		await graph.stop();
	}
});

for (const origin of ["operator", "model"] as const)
	for (const spelling of ["root", "root-alias", "sibling"] as const) {
		it(`skips ${origin} check-ins owned by the working conversation through ${spelling}`, {
			timeout: 10000,
		}, async (t) => {
			const f = await scheduleFixture(t, { agentExtension: false, deferAnswers: true });
			t.after(() => f.releaseAnswer());
			const sibling = await f.host.harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: { provider: testModel.provider, modelId: testModel.id } } },
				BACKGROUND_CONTEXT,
			);
			const identity = spelling === "sibling" ? f.host.identity(sibling.id) : f.storageId;
			const ownerId = spelling === "root-alias" ? `${f.storageId}:1` : identity;
			await f.host.request("submit", {
				sessionId: identity,
				message: "self task",
				requestId: "self",
				ownerId,
				origin,
				checkInMinutes: 30,
			});
			const state = await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true);
			assert.equal(
				state?.intents.find((intent) => intent.requestId === "self")?.ownerId,
				ownerId,
				"self ownership still retains a delivery intent",
			);
			assert.equal(
				(await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.some((task) => task.record.kind === "agent.check-in"),
				false,
			);
			const otherOwner = spelling === "sibling" ? f.storageId : f.host.identity(sibling.id);
			await f.host.request("submit", {
				sessionId: identity,
				message: "other task",
				requestId: "other",
				ownerId: otherOwner,
				origin,
				checkInMinutes: 30,
				whenBusy: "followUp",
			});
			const tasks = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
				(task) => task.record.kind === "agent.check-in",
			);
			assert.equal(tasks.length, 1);
			const checkIn = tasks[0];
			assert.ok(checkIn);
			assert.equal((checkIn.record.input as { requestId: string }).requestId, "other");
		});
	}

it("zero and admissions without a tool interval create no check-in task", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true, deferFirstAnswer: true });
	t.after(() => f.releaseAnswer());
	await f.host.request("submit", {
		sessionId: f.storageId,
		message: "zero",
		requestId: "check-zero",
		ownerId: f.ownerId,
		origin: "model",
		checkInMinutes: 0,
	});
	await f.waitForFirstRequest();
	await f.host.request("submit", {
		sessionId: f.storageId,
		message: "operator",
		requestId: "check-operator",
		ownerId: f.ownerId,
		origin: "operator",
		whenBusy: "followUp",
	});
	await f.host.request("submit", {
		sessionId: f.storageId,
		message: "delivered report",
		requestId: "check-delivery",
		whenBusy: "followUp",
	});
	assert.equal(
		(await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.some((task) => task.record.kind === "agent.check-in"),
		false,
	);
	f.releaseAnswer();
	await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
});

async function waitForReport(
	f: Awaited<ReturnType<typeof scheduleFixture>>,
	sourceId: string,
): Promise<DeliveryReport> {
	return waitForDeliveryFixture(f.host.harness, BACKGROUND_CONTEXT, (state) =>
		state.reports.find((report) => report.sourceId === sourceId),
	);
}

it("fires at the exact deadline, repeats, and resumes without duplicate or missed-deadline bursts", {
	timeout: 60000,
}, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		await f.host.request("submit", {
			sessionId: f.storageId,
			message: "still unanswered",
			requestId: "check-repeat",
			ownerId: f.ownerId,
			origin: "model",
			checkInMinutes: 1,
		});
		assert.ok(
			(await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.some((row) => row.record.kind === "agent.check-in"),
			"an unanswered task owns its deadline before the clock fires",
		);
		const conversation = await f.conversation();
		const key = (k: number) => `check-in:${conversation.id}:check-repeat:${k}`;
		now = epoch + 60000;
		await f.reopen();
		const first = await waitForReport(f, key(1));
		assert.equal(first.checkIn?.elapsedMs, 60000);
		assert.match(first.message, /Latest reply excerpt \(not a result\)/u);
		assert.equal(
			Object.hasOwn(first.checkIn ?? {}, "digest"),
			false,
			"the row stores its digest only in report.message",
		);
		const firstCheckIn = first.checkIn;
		assert.ok(firstCheckIn);
		await f.host.request("acknowledge", { ownerId: f.ownerId, sourceIds: [first.sourceId] });
		await f.reopen();
		const replay = await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true);
		assert.equal(
			replay?.reports.filter((report) => report.sourceId === key(1)).length,
			1,
			"restart preserves one source identity per deadline",
		);
		now = epoch + 120000;
		await f.reopen();
		await waitForReport(f, key(2));
		now = epoch + 600000;
		await f.reopen();
		const resumed = await waitForReport(f, key(10));
		assert.equal(resumed.checkIn?.elapsedMs, 600000);
		const rows = (await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true))?.reports ?? [];
		assert.deepEqual(
			rows.map((row) => row.sourceId),
			[key(1), key(2), key(10)],
			"retained notice identities survive coalescing",
		);
		assert.deepEqual(
			rows.filter((row) => !row.acknowledged).map((row) => row.sourceId),
			[key(10)],
			"only the current notice remains pending",
		);
		const task = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
			(row) => row.record.kind === CheckInTask.definition.name,
		);
		assert.ok(task);
		const graph = await f.host.harness.watchTaskGraph(BACKGROUND_CONTEXT);
		const asleep = (value: typeof graph.value) =>
			Object.values(value.tasks).some(
				(node) =>
					node.kind === CheckInDeadlineTask.definition.name &&
					node.owner === task.record.id &&
					node.state.status === "sleeping",
			);
		try {
			if (!asleep(graph.value))
				await new Promise<void>((resolve) =>
					graph.start(async (call) => {
						if (call.kind === "value" && asleep(call.value)) resolve();
					}),
				);
		} finally {
			await graph.stop();
		}
		const deadline = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
			(row) => row.record.kind === CheckInDeadlineTask.definition.name && row.record.owner === task.record.id,
		);
		assert.ok(deadline);
		assert.equal(deadline.state.kind, "sleeping");
		assert.equal(
			(deadline.record.state as { checkpoint?: { next: number } }).checkpoint?.next,
			11,
			"the next deadline keeps the admission cadence",
		);
		await f.host.harness.commit(
			async (tx) =>
				editDeliveryFixture(tx, async (deliveryFixtureState) => {
					const state = deliveryFixtureState;
					state.reports.push({
						...first,
						sourceId: "other-owner-accepted",
						ownerId: "another-owner",
						acknowledged: true,
						checkIn: { ...firstCheckIn, fallbackBroadcast: true },
					});
				}),
			BACKGROUND_CONTEXT,
		);
		f.releaseAnswer();
		await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
		await f.host.harness.waitForTask(task.record.id, BACKGROUND_CONTEXT);
		await settleDeliveries(f.host.harness, BACKGROUND_CONTEXT);
		const settled = await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT);
		assert.deepEqual(settled.reports, [], "settlement leaves no pending notices for any owner");
		assert.ok(
			(await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true)).reports.every((row) => row.acknowledged),
			"retained notice identities remain acknowledged",
		);
		assert.equal(await f.host.refreshIdle(), true);
	} finally {
		f.releaseAnswer();
	}
});

it("replaces a pending check-in without its stored copy marker and prunes it at settlement", {
	timeout: 60000,
}, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		await f.host.request("submit", {
			sessionId: f.storageId,
			message: "still active",
			requestId: "fallback-repeat",
			ownerId: f.ownerId,
			origin: "model",
			checkInMinutes: 1,
		});
		const conversation = await f.conversation();
		now = epoch + 60000;
		await f.reopen();
		const first = await waitForReport(f, `check-in:${conversation.id}:fallback-repeat:1`);
		await f.host.harness.commit(
			async (tx) =>
				editDeliveryFixture(tx, async (deliveryFixtureState) => {
					const state = deliveryFixtureState;
					const index = state.reports.findIndex((row) => row.sourceId === first.sourceId);
					const report = state.reports[index];
					assert.ok(report.checkIn);
					state.reports[index] = { ...report, checkIn: { ...report.checkIn, fallbackBroadcast: true } };
				}),
			BACKGROUND_CONTEXT,
		);
		now = epoch + 120000;
		await f.reopen();
		const next = await waitForReport(f, `check-in:${conversation.id}:fallback-repeat:2`);
		assert.equal(next.acknowledged, false);
		assert.equal(next.checkIn?.fallbackBroadcast, undefined, "a stored copy marker is not carried forward");
		assert.equal((await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT))?.reports.length, 1);
		f.releaseAnswer();
		await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
		await settleDeliveries(f.host.harness, BACKGROUND_CONTEXT);
		assert.deepEqual((await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT))?.reports, []);
	} finally {
		f.releaseAnswer();
	}
});

async function digestFixture(
	t: { after(fn: () => void | Promise<void>): void },
	seed: (tx: Tx, conversationId: ConversationId) => Promise<void>,
) {
	const now = Date.now();
	const f = await scheduleFixture(t, { resume: false, now: () => now });
	const conversation = await f.conversation();
	await f.host.harness.commit(async (tx) => {
		await seed(tx, conversation.id);
		await createCheckIn(
			tx,
			{
				conversationId: Number(conversation.id),
				requestId: "watched",
				ownerId: f.ownerId,
				senderIdentity: f.storageId,
				message: "second task",
				whenBusy: "followUp",
				origin: "model",
				admittedAt: now - 15000,
			},
			0.25,
		);
	}, BACKGROUND_CONTEXT);
	f.host.harness.resume();
	return { f, report: await waitForReport(f, `check-in:${conversation.id}:watched:1`) };
}

function assistant(text: string, calls = 0) {
	return {
		role: "assistant" as const,
		content: [
			...(text === "" ? [] : [{ type: "text" as const, text }]),
			...Array.from({ length: calls }, (_, index) => ({
				type: "toolCall" as const,
				id: `call-${index}`,
				name: "read",
				arguments: {},
			})),
		],
		api: testModel.api,
		provider: testModel.provider,
		model: testModel.id,
		stopReason: "stop" as const,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

async function placeWatched(tx: Tx, conversationId: ConversationId, queued = false): Promise<SubmissionRecord> {
	if (queued) return tx.createSubmission({ conversationId, requestId: "watched", type: "input", status: "queued" });
	const entry = await tx.appendEntry(UserEntry, conversationId, {
		model: [{ role: "user", content: "second task", timestamp: Date.now() }],
	});
	return tx.createSubmission({
		conversationId,
		requestId: "watched",
		type: "input",
		status: "placed",
		entry: entry.id,
	});
}

it("puts direct producer retry details first in bounded check-in text", { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		const input = await placeWatched(tx, conversationId);
		const owner = await tx.createTask(
			CheckInTask,
			{
				conversationId,
				requestId: "holding",
				ownerId: "owner",
				senderIdentity: "producer",
				message: "held",
				whenBusy: "followUp",
				origin: "operator",
				admittedAt: Date.now(),
				intervalMs: 300000,
			},
			{ ownership: { kind: "conversation" }, conversationId, background: true },
		);
		const live = await tx.doc(LiveDoc, conversationId);
		live.run = { taskId: owner, inputs: [input.id], turns: 0 };
		live.generation = { attempt: 18, retry: { at: Date.now() + 300000, error: "429 Weekly/Monthly Limit Exhausted" } };
		live.tools = Array.from({ length: 4 }, (_, index) => ({
			callId: `call-${index}`,
			name: "read",
			status: "running",
			output: "x".repeat(1500),
		}));
	});
	assert.match(report.message.split("\n")[0], /pending.*provider retry.*attempt 18/u);
	assert.match(report.message, /next retry.*429 Weekly\/Monthly Limit Exhausted/u);
	assert.ok(report.message.length <= 2400);
});

it("excludes the answered task from the watched task's reply and tool count", { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		const input = await tx.appendEntry(UserEntry, conversationId, {
			model: [{ role: "user", content: "first task", timestamp: Date.now() }],
		});
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("", 5)] });
		const answer = await tx.appendEntry(AssistantEntry, conversationId, {
			model: [assistant("First task final answer.")],
		});
		await tx.createSubmission({
			conversationId,
			requestId: "answered",
			type: "input",
			status: "done",
			entry: input.id,
			answer: answer.id,
		});
		await placeWatched(tx, conversationId);
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("", 1)] });
		const live = await tx.doc(LiveDoc, conversationId);
		live.tools = [
			{ callId: "call-0", name: "read", status: "running", output: "old line\nline one\nline two\nline three" },
		];
	});
	assert.match(report.message, /Latest reply excerpt \(not a result\): No reply text yet\./u);
	assert.match(report.message, /^Tool calls: 1 \(watched task\)\./u);
	assert.doesNotMatch(report.message, /First task final answer|at least|old line/u);
	assert.match(report.message, /Current tool: read; call issued 0s ago \(not exact runtime\)\./u);
	assert.match(report.message, /Last tool lines:\nline one\nline two\nline three/u);
});

it("does not give a queued watched input the active held input's dependency retry", { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		const entry = await tx.appendEntry(UserEntry, conversationId, {
			model: [{ role: "user", content: "active task", timestamp: Date.now() }],
		});
		const held = await tx.createSubmission({
			conversationId,
			requestId: "active-task",
			type: "input",
			status: "placed",
			entry: entry.id,
		});
		await placeWatched(tx, conversationId, true);
		const owner = await tx.createTask(
			CheckInTask,
			{
				conversationId,
				requestId: "holding",
				ownerId: "owner",
				senderIdentity: "producer",
				message: "held",
				whenBusy: "followUp",
				origin: "operator",
				admittedAt: Date.now(),
				intervalMs: 300000,
			},
			{ ownership: { kind: "conversation" }, conversationId, background: true },
		);
		const live = await tx.doc(LiveDoc, conversationId);
		live.run = { taskId: owner, inputs: [held.id], turns: 0 };
		const result = { sessionId: "producer:2", submissionId: 23, requestId: "active-worker" };
		(await tx.doc(AwaitDoc)).declarations.push({
			taskId: owner,
			callId: "await",
			conversationId,
			runId: owner,
			cohort: [owner],
			inputs: [held.id],
			results: [result],
			outcomes: [],
			decision: "awaiting",
			producers: [
				{
					sessionId: result.sessionId,
					observedAt: 1,
					source: "producer await-state",
					execution: {
						state: "provider-retry",
						runId: 20,
						results: [result],
						attempt: 18,
						maxAttempts: 21,
						nextRetryAt: Date.now() + 300000,
						error: "429 Weekly/Monthly Limit Exhausted",
						errorTruncated: false,
					},
				},
			],
		});
	});
	assert.doesNotMatch(report.message, /Awaiting|provider retry|Weekly\/Monthly|active-worker/u);
	assert.equal(
		report.message,
		"Tool calls: 0 (watched task).\nCurrent step: queued or between steps.\nLatest reply excerpt (not a result): No reply text yet.",
	);
});

it("does not report the active task's live state while the watched input is queued", { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Earlier answer.", 5)] });
		await placeWatched(tx, conversationId, true);
		const live = await tx.doc(LiveDoc, conversationId);
		live.generation = { attempt: 1, message: assistant("Earlier task partial.") };
		live.tools = [{ callId: "call-0", name: "read", status: "running", output: "Earlier task output." }];
	});
	assert.equal(
		report.message,
		"Tool calls: 0 (watched task).\nCurrent step: queued or between steps.\nLatest reply excerpt (not a result): No reply text yet.",
	);
});

it("uses only watched reply text and prefers its live partial", { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Earlier answer.")] });
		await placeWatched(tx, conversationId);
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Watched retained reply.")] });
		const live = await tx.doc(LiveDoc, conversationId);
		live.generation = { attempt: 1, message: assistant("Watched live reply.") };
	});
	assert.match(report.message, /Current step: model request\./u);
	assert.match(report.message, /Latest reply excerpt \(not a result\): Watched live reply\./u);
	assert.doesNotMatch(report.message, /Earlier answer|Watched retained reply/u);
});

it("uses the watched retained reply without treating a compaction summary as reply text", {
	timeout: 60000,
}, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Earlier answer.")] });
		await placeWatched(tx, conversationId);
		const reply = await tx.appendEntry(AssistantEntry, conversationId, {
			model: [assistant("Watched retained reply.")],
		});
		await tx.appendEntry(CompactionEntry, conversationId, {
			head: reply.id,
			data: { reason: "manual" },
			model: [{ role: "user", content: "Summary of earlier answer.", timestamp: Date.now() }],
		});
	});
	assert.match(report.message, /Latest reply excerpt \(not a result\): Watched retained reply\./u);
	assert.doesNotMatch(report.message, /Earlier answer|Summary/u);
});

it("retains watched running tools when the bounded page omits their call entry", { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		await placeWatched(tx, conversationId);
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("", 1)] });
		for (let index = 0; index < 65; index += 1)
			await tx.appendEntry(UserEntry, conversationId, {
				model: [{ role: "user", content: "passive note", timestamp: Date.now() }],
			});
		const live = await tx.doc(LiveDoc, conversationId);
		live.tools = [{ callId: "call-0", name: "read", status: "running", output: "Watched tool output." }];
	});
	assert.match(report.message, /^Tool calls: at least 0 \(bounded retained entries for watched task\)\./u);
	assert.match(report.message, /Current tool: read; call age unknown \(not exact runtime\)\./u);
	assert.match(report.message, /Last tool lines:\nWatched tool output\./u);
});

for (const entries of [63, 64, 65])
	it(`labels the tool count according to actual scan coverage with ${entries} watched entries`, {
		timeout: 60000,
	}, async (t) => {
		const { report } = await digestFixture(t, async (tx, conversationId) => {
			for (let index = 0; index < 70; index += 1)
				await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Earlier answer.", 5)] });
			await placeWatched(tx, conversationId);
			for (let index = 1; index < entries; index += 1)
				await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Watched retained reply.", 1)] });
		});
		if (entries <= 64)
			assert.match(report.message, new RegExp(`^Tool calls: ${entries - 1} \\(watched task\\)\\.`, "u"));
		else assert.match(report.message, /^Tool calls: at least 64 \(bounded retained entries for watched task\)\./u);
		assert.doesNotMatch(report.message, /Earlier answer/u);
	});

it("arms and deduplicates the deadline task in the durable intent commit", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true });
	try {
		const params = {
			sessionId: f.storageId,
			message: "intent",
			requestId: "check-intent",
			ownerId: f.ownerId,
			origin: "model",
			checkInMinutes: 30,
		};
		await f.host.request("submit", params);
		await f.host.request("submit", params);
		const tasks = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
			(row) => row.record.kind === "agent.check-in",
		);
		assert.equal(tasks.length, 1);
		assert.ok(tasks[0]);
		assert.equal((tasks[0].record.input as { senderIdentity?: string }).senderIdentity, f.storageId);
	} finally {
		f.releaseAnswer();
	}
});

it("recovers an armed intent after host loss before input admission", { timeout: 60000 }, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: false, deferAnswers: true, resume: false, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		const conversation = await f.conversation();
		await f.host.harness.commit(
			(tx) =>
				recordDeliveryIntent(tx, conversation.id, {
					message: "recover the intent",
					requestId: "check-gap",
					ownerId: f.ownerId,
					origin: "model",
					senderIdentity: f.storageId,
					checkInMinutes: 1,
				}),
			BACKGROUND_CONTEXT,
		);
		assert.equal(
			await f.host.harness.commit((tx) => tx.submissionByRequest(conversation.id, "check-gap"), BACKGROUND_CONTEXT),
			undefined,
		);
		now = epoch + 60000;
		await f.reopen();
		f.host.harness.resume();
		const report = await waitForReport(f, `check-in:${conversation.id}:check-gap:1`);
		assert.equal(report.checkIn?.elapsedMs, 60000);
		assert.equal(
			await f.searchCount("recover the intent"),
			1,
			"the task and reconciliation share one admission identity",
		);
		const tasks = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
			(row) => row.record.kind === "agent.check-in",
		);
		assert.equal(tasks.length, 1);
		assert.ok(tasks[0]);
		f.releaseAnswer();
		await f.host.harness.waitForTask(tasks[0].record.id, BACKGROUND_CONTEXT);
		await f.waitForReceipt("check-gap");
		assert.equal(await f.host.refreshIdle(), true);
	} finally {
		f.releaseAnswer();
	}
});

it("uses the injected Harness clock for admission and deadline", { timeout: 60000 }, async (t) => {
	let now = Date.now() - 1_000_000;
	const admittedAt = now;
	const f = await scheduleFixture(t, { agentExtension: false, deferAnswers: true, now: () => now });
	try {
		await f.host.request("submit", {
			sessionId: f.storageId,
			message: "clock task",
			requestId: "clock",
			ownerId: f.ownerId,
			origin: "model",
			checkInMinutes: 1,
		});
		const task = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
			(row) => row.record.kind === "agent.check-in",
		);
		assert.ok(task);
		assert.equal((task.record.input as { admittedAt: number }).admittedAt, admittedAt);
		now += 60000;
		await f.reopen();
		const conversation = await f.conversation();
		const row = await waitForReport(f, `check-in:${conversation.id}:clock:1`);
		assert.equal(row.checkIn?.elapsedMs, 60000);
		f.releaseAnswer();
		await f.host.harness.waitForTask(task.record.id, BACKGROUND_CONTEXT);
	} finally {
		f.releaseAnswer();
	}
});

it("explicit operator check-ins retain operator origin and no default is needed", { timeout: 60000 }, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		const conversation = await f.conversation();
		await f.host.request("submit", {
			sessionId: f.storageId,
			requestId: "operator-explicit",
			ownerId: f.ownerId,
			message: "operator task",
			whenBusy: "followUp",
			origin: "operator",
			checkInMinutes: 1,
		});
		now += 60000;
		await f.reopen();
		const row = await waitForReport(f, `check-in:${conversation.id}:operator-explicit:1`);
		assert.equal(row.checkIn?.origin, "operator");
		assert.equal(row.checkIn?.conversationId, Number(conversation.id));
	} finally {
		f.releaseAnswer();
	}
});

type ScheduleFixture = Awaited<ReturnType<typeof scheduleFixture>>;

/** Check-in tasks of the storage: the watch and its deadline. */
async function checkInTasks(f: ScheduleFixture) {
	return (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
		(row) => row.record.kind === CheckInTask.definition.name || row.record.kind === CheckInDeadlineTask.definition.name,
	);
}

/** Resolve once no check-in task remains; fail after a bounded wait. */
async function checkInsEnded(f: ScheduleFixture): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if ((await checkInTasks(f)).length === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(
		`check-in tasks did not end: ${JSON.stringify((await checkInTasks(f)).map((row) => [row.record.kind, row.record.state, row.state]))}`,
	);
}

async function parkReport(f: ScheduleFixture, sourceId: string): Promise<void> {
	await f.host.harness.commit(
		async (tx) =>
			editDeliveryFixture(tx, async (state) => {
				const index = state.reports.findIndex((row) => row.sourceId === sourceId);
				assert.ok(index >= 0);
				state.reports[index] = {
					...state.reports[index],
					delivery: { state: "parked", reason: "the owner has no live endpoint" },
				};
			}),
		BACKGROUND_CONTEXT,
	);
}

async function signalDeadline(f: ScheduleFixture, sourceId: string): Promise<string> {
	const graph = await f.host.harness.inspect(BACKGROUND_CONTEXT);
	const deadline = graph.tasks.find((row) => row.record.kind === CheckInDeadlineTask.definition.name);
	assert.ok(deadline);
	return f.host.harness.signal(deadline.record.id, CheckInParkedSignal, sourceId, {}, BACKGROUND_CONTEXT);
}

it("pauses at a parked notice without another notice, and re-arms one future deadline when the owner accepts it", {
	timeout: 60000,
}, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		const submitted = (await f.host.request("submit", {
			sessionId: f.storageId,
			message: "long work",
			requestId: "paused-watch",
			ownerId: f.ownerId,
			origin: "model",
			checkInMinutes: 1,
		})) as { submissionId: number };
		const conversation = await f.conversation();
		const key = (k: number) => `check-in:${conversation.id}:paused-watch:${k}`;
		now = epoch + 60000;
		await f.reopen();
		const first = await waitForReport(f, key(1));
		await parkReport(f, first.sourceId);
		assert.equal(await signalDeadline(f, first.sourceId), "delivered");
		await checkInsEnded(f);
		const input = await f.host.harness.submission(submitted.submissionId as never, BACKGROUND_CONTEXT);
		assert.notEqual((await input?.status(BACKGROUND_CONTEXT))?.status, "done", "the watched input keeps running");

		now = epoch + 600000;
		await f.reopen();
		const waiting = (await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true))?.reports ?? [];
		assert.deepEqual(
			waiting.map((row) => row.sourceId),
			[key(1)],
			"one notice stays outstanding for the owner",
		);
		assert.deepEqual(await checkInTasks(f), [], "a paused watch keeps no task");

		// The owner accepts the outstanding notice: one deadline re-arms at the next future interval.
		await f.host.harness.commit(async (tx) => {
			const current = await retainedReport(tx, f.ownerId, first.sourceId);
			assert.ok(current?.checkIn);
			await storeDeliveryRow(tx, "report", { ...current, acknowledged: true });
			await resumePausedCheckIn(tx, f.ownerId, current.checkIn, now);
		}, BACKGROUND_CONTEXT);
		const rearmed = (await checkInTasks(f)).filter((row) => row.record.kind === CheckInTask.definition.name);
		assert.equal(rearmed.length, 1, "one watch re-arms");
		assert.equal((rearmed[0].record.input as { next?: number }).next, 11, "at the next future interval");
		now = epoch + 660000;
		await f.reopen();
		await waitForReport(f, key(11));
		const after = (await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true))?.reports ?? [];
		assert.deepEqual(
			after.map((row) => row.sourceId),
			[key(1), key(11)],
			"the re-armed watch writes no notice for the missed intervals",
		);
		assert.equal(
			(await f.host.harness.inspect(BACKGROUND_CONTEXT)).submissions.filter((row) => row.requestId === "paused-watch")
				.length,
			1,
			"the input is not submitted again",
		);
		f.releaseAnswer();
		await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
		await checkInsEnded(f);
	} finally {
		f.releaseAnswer();
	}
});

/** Submit a watched request with a one-minute check-in and pause its watch at the first notice. */
async function pausedWatch(f: ScheduleFixture, epoch: number, setNow: (value: number) => void, requestId: string) {
	await f.host.request("submit", {
		sessionId: f.storageId,
		message: "long work",
		requestId,
		ownerId: f.ownerId,
		origin: "model",
		checkInMinutes: 1,
	});
	const watch = (await checkInTasks(f)).find((row) => row.record.kind === CheckInTask.definition.name);
	assert.ok(watch);
	const conversation = await f.conversation();
	const key = (k: number) => `check-in:${conversation.id}:${requestId}:${k}`;
	setNow(epoch + 60000);
	await f.reopen();
	const first = await waitForReport(f, key(1));
	await parkReport(f, first.sourceId);
	assert.equal(await signalDeadline(f, first.sourceId), "delivered");
	await checkInsEnded(f);
	return {
		conversation,
		key,
		first,
		input: watch.record.input as Parameters<typeof CheckInTask.definition.initial>[0],
	};
}

async function pauseState(f: ScheduleFixture, conversationId: number, requestId: string) {
	return f.host.harness.snapshot(
		CheckInPauseDoc,
		checkInPauseKey(f.ownerId, conversationId, requestId),
		BACKGROUND_CONTEXT,
	);
}

it("lets a re-armed watch supersede the paused watch task that a restart resumes later", {
	timeout: 60000,
}, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		const paused = await pausedWatch(f, epoch, (value) => (now = value), "superseded-watch");
		now = epoch + 600000;
		await f.reopen();
		await f.host.request("acknowledge", { ownerId: f.ownerId, sourceIds: [paused.first.sourceId] });
		// The paused watch task resumes after the re-arm, as a crash between the pause and its end leaves it: a live
		// check-in task of the same request, with the original schedule and no deadline of its own.
		const stale = await f.host.harness.commit(
			(tx) =>
				tx.createTask(CheckInTask, paused.input, {
					ownership: { kind: "conversation" },
					conversationId: paused.conversation.id,
					background: true,
				}),
			BACKGROUND_CONTEXT,
		);
		// The stale task either ends or creates a second deadline; observe whichever comes first.
		let deadlines = 0;
		let staleLive = true;
		for (let attempt = 0; attempt < 500 && staleLive && deadlines < 2; attempt++) {
			const tasks = await checkInTasks(f);
			staleLive = tasks.some((row) => row.record.id === stale);
			deadlines = tasks.filter((row) => row.record.kind === CheckInDeadlineTask.definition.name).length;
			if (staleLive && deadlines < 2) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(deadlines < 2, true, "only the re-armed watch holds a deadline");
		assert.equal(staleLive, false, "the superseded watch task ends");
		now = epoch + 660000;
		await f.reopen();
		await waitForReport(f, paused.key(11));
		const reports = (await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true))?.reports ?? [];
		assert.deepEqual(
			reports.map((row) => row.sourceId),
			[paused.key(1), paused.key(11)],
			"the superseded watch writes no notice on the old schedule",
		);
		f.releaseAnswer();
		await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
		await checkInsEnded(f);
		assert.equal(await pauseState(f, paused.conversation.id, "superseded-watch"), undefined);
	} finally {
		f.releaseAnswer();
	}
});

it("re-arms a paused watch through the acknowledge request in the acknowledging commit", {
	timeout: 60000,
}, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		const paused = await pausedWatch(f, epoch, (value) => (now = value), "acknowledged-watch");
		now = epoch + 600000;
		await f.reopen();
		const result = (await f.host.request("acknowledge", {
			ownerId: f.ownerId,
			sourceIds: [paused.first.sourceId],
		})) as { acknowledgedReports: string[] };
		assert.deepEqual(result.acknowledgedReports, [paused.first.sourceId]);
		const rearmed = (await checkInTasks(f)).filter((row) => row.record.kind === CheckInTask.definition.name);
		assert.equal(rearmed.length, 1, "one watch re-arms");
		assert.equal((rearmed[0].record.input as { next?: number }).next, 11, "at the next future interval");
		assert.deepEqual((await pauseState(f, paused.conversation.id, "acknowledged-watch"))?.watch, null);
		f.releaseAnswer();
		await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
		await checkInsEnded(f);
	} finally {
		f.releaseAnswer();
	}
});

it("clears the pause of a watched request when settlement retires its parked notice", {
	timeout: 60000,
}, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		const paused = await pausedWatch(f, epoch, (value) => (now = value), "settled-watch");
		assert.notEqual((await pauseState(f, paused.conversation.id, "settled-watch"))?.watch ?? null, null);
		f.releaseAnswer();
		await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
		await settleDeliveries(f.host.harness, BACKGROUND_CONTEXT);
		const report = (await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true))?.reports.find(
			(row) => row.sourceId === paused.first.sourceId,
		);
		assert.equal(report?.acknowledged ?? true, true, "settlement retires the notice");
		assert.equal(await pauseState(f, paused.conversation.id, "settled-watch"), undefined, "and its pause");
		assert.deepEqual(await checkInTasks(f), []);
	} finally {
		f.releaseAnswer();
	}
});

it("pauses at its next deadline when the notice parked without a signal", { timeout: 60000 }, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		await f.host.request("submit", {
			sessionId: f.storageId,
			message: "long work",
			requestId: "unsignalled",
			ownerId: f.ownerId,
			origin: "model",
			checkInMinutes: 1,
		});
		const conversation = await f.conversation();
		now = epoch + 60000;
		await f.reopen();
		const first = await waitForReport(f, `check-in:${conversation.id}:unsignalled:1`);
		await parkReport(f, first.sourceId);
		now = epoch + 120000;
		await f.reopen();
		await checkInsEnded(f);
		const rows = (await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true))?.reports ?? [];
		assert.deepEqual(
			rows.map((row) => [row.sourceId, row.acknowledged]),
			[[first.sourceId, false]],
		);
		// A settled request clears the paused watch when its notice resolves; nothing re-arms.
		f.releaseAnswer();
		await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
		await f.host.harness.commit(async (tx) => {
			const current = await retainedReport(tx, f.ownerId, first.sourceId);
			assert.ok(current?.checkIn);
			await resumePausedCheckIn(tx, f.ownerId, current.checkIn, now);
		}, BACKGROUND_CONTEXT);
		assert.deepEqual(await checkInTasks(f), []);
	} finally {
		f.releaseAnswer();
	}
});

it("pauses through the delivery watcher for an absent owner, so the host holds no check-in task", {
	timeout: 60000,
}, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	const root = mkdtempSync(join(tmpdir(), "check-in-pause-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const owner = randomUUID();
	try {
		await f.host.request("submit", {
			sessionId: f.storageId,
			message: "long work",
			requestId: "absent-owner",
			ownerId: owner,
			origin: "model",
			checkInMinutes: 1,
		});
		const conversation = await f.conversation();
		now = epoch + 60000;
		await f.reopen();
		await waitForReport(f, `check-in:${conversation.id}:absent-owner:1`);
		const watcher = startDurableDelivery({
			host: f.host,
			metadata: parseHostMetadata({
				storageId: f.storageId,
				cwd: root,
				agentDir: join(root, "agent"),
				packageDir: join(root, "package"),
				storagePath: join(root, "unused.sqlite"),
				model: { provider: testModel.provider, modelId: testModel.id },
				thinkingLevel: "off",
			}),
			catalog: new AgentCatalog(join(root, "catalog")),
			sessionsRoot: join(root, "sessions"),
			signal: new AbortController().signal,
		});
		t.after(() => watcher.close());
		await checkInsEnded(f);
		const [notice] = (await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true))?.reports ?? [];
		assert.equal(notice?.delivery?.state, "parked");
		assert.equal(notice?.acknowledged, false);

		// The owner returns: its acceptance of the outstanding notice re-arms one watch in the same commit.
		const received: unknown[] = [];
		const channel = await createPrimaryChannel({
			id: owner,
			sessionFile: savedTranscript(root, owner),
			cwd: root,
			sessionsRoot: join(root, "sessions"),
			deliver: (message) => {
				received.push(message);
			},
			promptTrust: async () => undefined,
		});
		t.after(() => channel.close());
		for (let attempt = 0; attempt < 500; attempt++) {
			if ((await checkInTasks(f)).some((row) => row.record.kind === CheckInTask.definition.name)) break;
			if (!watcher.busy) watcher.refresh();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(received.length, 1, "the owner receives the outstanding notice once");
		const rows = (await readRetainedDelivery(f.host.harness, BACKGROUND_CONTEXT, true))?.reports ?? [];
		assert.equal(rows[0]?.acknowledged, true);
		const watches = (await checkInTasks(f)).filter((row) => row.record.kind === CheckInTask.definition.name);
		assert.equal(watches.length, 1, "acceptance re-arms one watch");
		assert.equal((watches[0].record.input as { next?: number }).next, 2);
	} finally {
		f.releaseAnswer();
	}
});
