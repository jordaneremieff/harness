import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDeliveryDoc, recordDeliveryIntent, settleDeliveries, type DeliveryReport } from "./durable-controls.ts";
import { CheckInTask, createCheckIn } from "./durable-checkins.ts";
import { AssistantEntry, CompactionEntry, LiveDoc, UserEntry, type ConversationId, type SubmissionRecord, type Tx } from "@earendil-works/pi-durable";
import { testModel } from "./test-runtime.mts";
import { scheduleFixture } from "./durable-schedule-fixture.mts";
import { checkInMinutes } from "./durable-checkins.ts";

it("applies the env default only to model tool admissions and accepts zero", () => {
	const prior = process.env.PI_AGENT_CHECK_IN_MINUTES;
	try {
		delete process.env.PI_AGENT_CHECK_IN_MINUTES;
		assert.equal(checkInMinutes(undefined), 30);
		assert.equal(checkInMinutes(undefined, "operator"), 0);
		process.env.PI_AGENT_CHECK_IN_MINUTES = "7";
		assert.equal(checkInMinutes(undefined), 7);
		assert.equal(checkInMinutes(0), 0);
		process.env.PI_AGENT_CHECK_IN_MINUTES = "0";
		assert.equal(checkInMinutes(undefined), 0);
		assert.throws(() => checkInMinutes(-1));
		assert.throws(() => checkInMinutes(Infinity));
		assert.throws(() => checkInMinutes(35792));
	} finally { if (prior === undefined) delete process.env.PI_AGENT_CHECK_IN_MINUTES; else process.env.PI_AGENT_CHECK_IN_MINUTES = prior; }
});

for (const raw of ["", "  ", "bad", "-1", "Infinity", "35792"]) it(`rejects invalid environment interval ${JSON.stringify(raw)}`, () => {
	const prior = process.env.PI_AGENT_CHECK_IN_MINUTES;
	try {
		process.env.PI_AGENT_CHECK_IN_MINUTES = raw;
		assert.throws(() => checkInMinutes(undefined), /PI_AGENT_CHECK_IN_MINUTES.*0.*35791/u);
		assert.equal(checkInMinutes(0), 0, "a per-call override does not use the default");
		assert.equal(checkInMinutes(undefined, "operator"), 0);
	} finally { if (prior === undefined) delete process.env.PI_AGENT_CHECK_IN_MINUTES; else process.env.PI_AGENT_CHECK_IN_MINUTES = prior; }
});

it("creates a host-owned check-in without a native agent contribution, and ends it at settlement", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: false, deferFirstAnswer: true });
	t.after(() => f.releaseAnswer());
	await f.host.request("submit", { sessionId: f.storageId, message: "held task", requestId: "check-held", ownerId: f.ownerId, origin: "model", checkInMinutes: 30 });
	await f.waitForFirstRequest();
	const checkTask = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.find((task) => task.record.kind === "agent.check-in");
	assert.ok(checkTask);
	f.releaseAnswer();
	await f.waitForReceipt("check-held");
	await f.host.harness.waitForTask(checkTask.record.id, BACKGROUND_CONTEXT);
	await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(await f.host.refreshIdle(), true, "settlement releases the background deadline task");
	assert.equal((await f.host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT))?.reports.length ?? 0, 0);
});

it("zero and admissions without a tool interval create no check-in task", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true, deferFirstAnswer: true });
	t.after(() => f.releaseAnswer());
	await f.host.request("submit", { sessionId: f.storageId, message: "zero", requestId: "check-zero", ownerId: f.ownerId, origin: "model", checkInMinutes: 0 });
	await f.waitForFirstRequest();
	await f.host.request("submit", { sessionId: f.storageId, message: "operator", requestId: "check-operator", ownerId: f.ownerId, origin: "operator", whenBusy: "followUp" });
	await f.host.request("submit", { sessionId: f.storageId, message: "delivered report", requestId: "check-delivery", whenBusy: "followUp" });
	assert.equal((await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.some((task) => task.record.kind === "agent.check-in"), false);
	f.releaseAnswer();
	await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
});

async function waitForReport(f: Awaited<ReturnType<typeof scheduleFixture>>, sourceId: string): Promise<DeliveryReport> {
	const watch = await f.host.harness.watchDoc(AgentDeliveryDoc, BACKGROUND_CONTEXT);
	assert.ok(watch);
	try {
		const present = watch.value?.reports.find((report) => report.sourceId === sourceId);
		if (present) return present;
		return await new Promise<DeliveryReport>((resolve) => {
			watch.start(async (state) => {
				const report = state?.reports.find((row) => row.sourceId === sourceId);
				if (report) resolve(report);
			});
		});
	} finally { await watch.stop(); }
}

it("fires at the exact deadline, repeats, and resumes without duplicate or missed-deadline bursts", { timeout: 60000 }, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		await f.host.request("submit", { sessionId: f.storageId, message: "still unanswered", requestId: "check-repeat", ownerId: f.ownerId, origin: "model", checkInMinutes: 1 });
		assert.ok((await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.some((row) => row.record.kind === "agent.check-in"), "an unanswered task owns its deadline before the clock fires");
		const conversation = await f.conversation();
		const key = (k: number) => `check-in:${conversation.id}:check-repeat:${k}`;
		now = epoch + 60000;
		await f.reopen();
		const first = await waitForReport(f, key(1));
		assert.equal(first.checkIn?.elapsedMs, 60000);
		assert.match(first.message, /Latest reply excerpt \(not a result\)/u);
		assert.equal(Object.hasOwn(first.checkIn ?? {}, "digest"), false, "the row stores its digest only in report.message");
		const firstCheckIn = first.checkIn;
		assert.ok(firstCheckIn);
		await f.host.request("acknowledge", { ownerId: f.ownerId, sourceIds: [first.sourceId] });
		await f.reopen();
		const replay = await f.host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
		assert.equal(replay?.reports.filter((report) => report.sourceId === key(1)).length, 1, "restart preserves one source identity per deadline");
		now = epoch + 120000;
		await f.reopen();
		await waitForReport(f, key(2));
		now = epoch + 600000;
		await f.reopen();
		const resumed = await waitForReport(f, key(10));
		assert.equal(resumed.checkIn?.elapsedMs, 600000);
		const rows = (await f.host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT))?.reports ?? [];
		assert.deepEqual(rows.map((row) => row.sourceId), [key(1), key(10)], "newer pending notice replaces the older one; overdue boundaries collapse");
		const task = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.find((row) => row.record.kind === CheckInTask.definition.name);
		assert.ok(task);
		assert.equal((task.record.state as { checkpoint?: { next: number } }).checkpoint?.next, 11, "the next deadline keeps the admission cadence");
		await f.host.harness.commit(async (tx) => {
			const state = await tx.doc(AgentDeliveryDoc);
			state.reports.push({ ...first, sourceId: "other-owner-accepted", ownerId: "another-owner", acknowledged: true,
				checkIn: { ...firstCheckIn, fallbackBroadcast: true } });
		}, BACKGROUND_CONTEXT);
		f.releaseAnswer();
		await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
		await f.host.harness.waitForTask(task.record.id, BACKGROUND_CONTEXT);
		await settleDeliveries(f.host.harness, BACKGROUND_CONTEXT);
		const settled = await f.host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
		assert.deepEqual(settled?.reports ?? [], [], "settlement removes pending, acknowledged, and fallback rows for every owner");
		assert.equal(await f.host.refreshIdle(), true);
	} finally { f.releaseAnswer(); }
});

it("carries accepted fallback evidence into the next pending check-in and prunes it at settlement", { timeout: 60000 }, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		await f.host.request("submit", { sessionId: f.storageId, message: "still active", requestId: "fallback-repeat", ownerId: f.ownerId, origin: "model", checkInMinutes: 1 });
		const conversation = await f.conversation();
		now = epoch + 60000;
		await f.reopen();
		const first = await waitForReport(f, `check-in:${conversation.id}:fallback-repeat:1`);
		await f.host.harness.commit(async (tx) => {
			const state = await tx.doc(AgentDeliveryDoc);
			const index = state.reports.findIndex((row) => row.sourceId === first.sourceId);
			const report = state.reports[index];
			assert.ok(report.checkIn);
			state.reports[index] = { ...report, checkIn: { ...report.checkIn, fallbackBroadcast: true } };
		}, BACKGROUND_CONTEXT);
		now = epoch + 120000;
		await f.reopen();
		const next = await waitForReport(f, `check-in:${conversation.id}:fallback-repeat:2`);
		assert.equal(next.acknowledged, false);
		assert.equal(next.checkIn?.fallbackBroadcast, true);
		assert.equal((await f.host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT))?.reports.length, 1);
		f.releaseAnswer();
		await f.host.harness.waitForIdle(BACKGROUND_CONTEXT);
		await settleDeliveries(f.host.harness, BACKGROUND_CONTEXT);
		assert.deepEqual((await f.host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT))?.reports, []);
	} finally { f.releaseAnswer(); }
});

async function digestFixture(t: { after(fn: () => void | Promise<void>): void }, seed: (tx: Tx, conversationId: ConversationId) => Promise<void>) {
	const now = Date.now();
	const f = await scheduleFixture(t, { resume: false, now: () => now });
	const conversation = await f.conversation();
	await f.host.harness.commit(async (tx) => {
		await seed(tx, conversation.id);
		await tx.doc(AgentDeliveryDoc);
		await createCheckIn(tx, { conversationId: Number(conversation.id), requestId: "watched", ownerId: f.ownerId,
			senderIdentity: f.storageId, message: "second task", whenBusy: "followUp", origin: "model", admittedAt: now - 15000 }, 0.25);
	}, BACKGROUND_CONTEXT);
	f.host.harness.resume();
	return { f, report: await waitForReport(f, `check-in:${conversation.id}:watched:1`) };
}

function assistant(text: string, calls = 0) {
	return { role: "assistant" as const, content: [
		...(text === "" ? [] : [{ type: "text" as const, text }]),
		...Array.from({ length: calls }, (_, index) => ({ type: "toolCall" as const, id: `call-${index}`, name: "read", arguments: {} })),
	], api: testModel.api, provider: testModel.provider, model: testModel.id, stopReason: "stop" as const,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}

async function placeWatched(tx: Tx, conversationId: ConversationId, queued = false): Promise<SubmissionRecord> {
	if (queued) return tx.createSubmission({ conversationId, requestId: "watched", type: "input", status: "queued" });
	const entry = await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: "second task", timestamp: Date.now() }] });
	return tx.createSubmission({ conversationId, requestId: "watched", type: "input", status: "placed", entry: entry.id });
}

it("excludes the answered task from the watched task's reply and tool count", { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		const input = await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: "first task", timestamp: Date.now() }] });
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("", 5)] });
		const answer = await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("First task final answer.")] });
		await tx.createSubmission({ conversationId, requestId: "answered", type: "input", status: "done", entry: input.id, answer: answer.id });
		await placeWatched(tx, conversationId);
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("", 1)] });
		const live = await tx.doc(LiveDoc, conversationId);
		live.tools = [{ callId: "call-0", name: "read", status: "running", output: "old line\nline one\nline two\nline three" }];
	});
	assert.match(report.message, /Latest reply excerpt \(not a result\): No reply text yet\./u);
	assert.match(report.message, /^Tool calls: 1 \(watched task\)\./u);
	assert.doesNotMatch(report.message, /First task final answer|at least|old line/u);
	assert.match(report.message, /Current tool: read; call issued 0s ago \(not exact runtime\)\./u);
	assert.match(report.message, /Last tool lines:\nline one\nline two\nline three/u);
});

it("does not report the active task's live state while the watched input is queued", { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Earlier answer.", 5)] });
		await placeWatched(tx, conversationId, true);
		const live = await tx.doc(LiveDoc, conversationId);
		live.generation = { attempt: 1, message: assistant("Earlier task partial.") };
		live.tools = [{ callId: "call-0", name: "read", status: "running", output: "Earlier task output." }];
	});
	assert.equal(report.message, "Tool calls: 0 (watched task).\nCurrent step: queued or between steps.\nLatest reply excerpt (not a result): No reply text yet.");
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

it("uses the watched retained reply without treating a compaction summary as reply text", { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Earlier answer.")] });
		await placeWatched(tx, conversationId);
		const reply = await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Watched retained reply.")] });
		await tx.appendEntry(CompactionEntry, conversationId, { head: reply.id, data: { reason: "manual" },
			model: [{ role: "user", content: "Summary of earlier answer.", timestamp: Date.now() }] });
	});
	assert.match(report.message, /Latest reply excerpt \(not a result\): Watched retained reply\./u);
	assert.doesNotMatch(report.message, /Earlier answer|Summary/u);
});

it("retains watched running tools when the bounded page omits their call entry", { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		await placeWatched(tx, conversationId);
		await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("", 1)] });
		for (let index = 0; index < 65; index += 1) await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: "passive note", timestamp: Date.now() }] });
		const live = await tx.doc(LiveDoc, conversationId);
		live.tools = [{ callId: "call-0", name: "read", status: "running", output: "Watched tool output." }];
	});
	assert.match(report.message, /^Tool calls: at least 0 \(bounded retained entries for watched task\)\./u);
	assert.match(report.message, /Current tool: read; call age unknown \(not exact runtime\)\./u);
	assert.match(report.message, /Last tool lines:\nWatched tool output\./u);
});

for (const entries of [63, 64, 65]) it(`labels the tool count according to actual scan coverage with ${entries} watched entries`, { timeout: 60000 }, async (t) => {
	const { report } = await digestFixture(t, async (tx, conversationId) => {
		for (let index = 0; index < 70; index += 1) await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Earlier answer.", 5)] });
		await placeWatched(tx, conversationId);
		for (let index = 1; index < entries; index += 1) await tx.appendEntry(AssistantEntry, conversationId, { model: [assistant("Watched retained reply.", 1)] });
	});
	if (entries <= 64) assert.match(report.message, new RegExp(`^Tool calls: ${entries - 1} \\(watched task\\)\\.`, "u"));
	else assert.match(report.message, /^Tool calls: at least 64 \(bounded retained entries for watched task\)\./u);
	assert.doesNotMatch(report.message, /Earlier answer/u);
});

it("arms and deduplicates the deadline task in the durable intent commit", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true });
	try {
		const params = { sessionId: f.storageId, message: "intent", requestId: "check-intent", ownerId: f.ownerId, origin: "model", checkInMinutes: 30 };
		await f.host.request("submit", params);
		await f.host.request("submit", params);
		const tasks = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter((row) => row.record.kind === "agent.check-in");
		assert.equal(tasks.length, 1);
		assert.ok(tasks[0]);
		assert.equal((tasks[0].record.input as { senderIdentity?: string }).senderIdentity, f.storageId);
	} finally { f.releaseAnswer(); }
});

it("recovers an armed intent after host loss before input admission", { timeout: 60000 }, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: false, deferAnswers: true, resume: false, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		const conversation = await f.conversation();
		await f.host.harness.commit((tx) => recordDeliveryIntent(tx, conversation.id, { message: "recover the intent", requestId: "check-gap", ownerId: f.ownerId, origin: "model", senderIdentity: f.storageId, checkInMinutes: 1 }), BACKGROUND_CONTEXT);
		assert.equal(await f.host.harness.commit((tx) => tx.submissionByRequest(conversation.id, "check-gap"), BACKGROUND_CONTEXT), undefined);
		now = epoch + 60000;
		await f.reopen();
		f.host.harness.resume();
		const report = await waitForReport(f, `check-in:${conversation.id}:check-gap:1`);
		assert.equal(report.checkIn?.elapsedMs, 60000);
		assert.equal(await f.searchCount("recover the intent"), 1, "the task and reconciliation share one admission identity");
		const tasks = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter((row) => row.record.kind === "agent.check-in");
		assert.equal(tasks.length, 1);
		assert.ok(tasks[0]);
		f.releaseAnswer();
		await f.host.harness.waitForTask(tasks[0].record.id, BACKGROUND_CONTEXT);
		await f.waitForReceipt("check-gap");
		assert.equal(await f.host.refreshIdle(), true);
	} finally { f.releaseAnswer(); }
});

it("uses the injected Harness clock for admission and deadline", { timeout: 60000 }, async (t) => {
	let now = Date.now() - 1_000_000;
	const admittedAt = now;
	const f = await scheduleFixture(t, { agentExtension: false, deferAnswers: true, now: () => now });
	try {
		await f.host.request("submit", { sessionId: f.storageId, message: "clock task", requestId: "clock", ownerId: f.ownerId, origin: "model", checkInMinutes: 1 });
		const task = (await f.host.harness.inspect(BACKGROUND_CONTEXT)).tasks.find((row) => row.record.kind === "agent.check-in");
		assert.ok(task);
		assert.equal((task.record.input as { admittedAt: number }).admittedAt, admittedAt);
		now += 60000;
		await f.reopen();
		const conversation = await f.conversation();
		const row = await waitForReport(f, `check-in:${conversation.id}:clock:1`);
		assert.equal(row.checkIn?.elapsedMs, 60000);
		f.releaseAnswer();
		await f.host.harness.waitForTask(task.record.id, BACKGROUND_CONTEXT);
	} finally { f.releaseAnswer(); }
});

it("explicit operator check-ins retain operator origin and no default is needed", { timeout: 60000 }, async (t) => {
	const epoch = Date.now();
	let now = epoch;
	const f = await scheduleFixture(t, { agentExtension: true, deferAnswers: true, now: () => now });
	t.mock.method(Date, "now", () => epoch);
	try {
		const conversation = await f.conversation();
		await f.host.request("submit", { sessionId: f.storageId, requestId: "operator-explicit", ownerId: f.ownerId, message: "operator task", whenBusy: "followUp", origin: "operator", checkInMinutes: 1 });
		now += 60000;
		await f.reopen();
		const row = await waitForReport(f, `check-in:${conversation.id}:operator-explicit:1`);
		assert.equal(row.checkIn?.origin, "operator");
		assert.equal(row.checkIn?.conversationId, Number(conversation.id));
	} finally { f.releaseAnswer(); }
});
