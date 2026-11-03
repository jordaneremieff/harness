/**
 * Host-level scheduled input tests over a real Harness and SQLite storage:
 * deadline firing, one-time admission, cancellation, schedule deduplication,
 * idle retirement, overdue recovery, and origin recording.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { StatusOutputSchema, structuredObservation } from "./observation-schema.ts";
import { scheduleFixture } from "./durable-schedule-fixture.mts";
import { scheduleTimer, TimerTask, TimerScheduleDoc, TIMER_LOOKUP_PAGE_LIMIT, TIMER_LOOKUP_PAGE_SIZE, TIMER_SETTLED_RECORD_LIMIT, timerStatusRows, type TimerInput, type ScheduleTimerResult, type TimerListRow } from "./durable-timers.ts";

interface TimerListPage {
	readonly timers: TimerListRow[];
}

interface ScheduleInput {
	readonly message: string;
	readonly deadline: number;
	readonly scheduleId: string;
	readonly requestId: string;
	readonly origin?: "operator" | "model";
	readonly mode?: "followUp" | "steer";
}

async function schedule(f: Awaited<ReturnType<typeof scheduleFixture>>, input: ScheduleInput): Promise<ScheduleTimerResult> {
	return (await f.host.request("timer-schedule", {
		sessionId: f.storageId,
		message: input.message,
		deliverAt: input.deadline,
		mode: input.mode ?? "followUp",
		origin: input.origin ?? "operator",
		ownerId: f.ownerId,
		scheduleId: input.scheduleId,
		requestId: input.requestId,
	})) as ScheduleTimerResult;
}

it("fires one scheduled input at its deadline and records the fired timer", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true });
	const deadline = Date.now() + 500;
	const scheduled = await schedule(f, { message: "TIMER_ONE", deadline, scheduleId: "timer-one", requestId: "timer-one-delivery" });
	assert.equal(scheduled.identity, f.storageId);
	assert.equal(scheduled.deadline, deadline);
	assert.equal(scheduled.deduped, false);
	const receipt = await f.waitForReceipt("timer-one-delivery");
	assert.equal(receipt.status, "done");
	assert.match(receipt.answer ?? "", /schedule fixture answer/u);
	assert.equal(await f.searchCount("TIMER_ONE"), 1, "the input is admitted once");
	const page = (await f.host.request("timer-list", { sessionId: f.storageId })) as TimerListPage;
	const row = page.timers.find((timer) => timer.timerId === scheduled.timerId);
	assert.ok(row, "the fired timer stays listed");
	assert.equal(row.status, "fired");
	assert.equal(row.live, false);
	assert.equal(row.deadline, deadline, "the fired record keeps its original deadline");
	assert.equal(row.submissionId, receipt.submissionId);
	await f.reopen();
	const repeated = await schedule(f, { message: "TIMER_ONE", deadline, scheduleId: "timer-one", requestId: "timer-one-delivery" });
	assert.equal(repeated.timerId, scheduled.timerId);
	assert.equal(repeated.disposition, "retained");
	assert.equal(repeated.status, "terminal");
	assert.equal(repeated.outcome?.status, "completed");
	assert.equal(await f.searchCount("TIMER_ONE"), 1);
	const cancelled = await f.host.request("timer-cancel", { timerId: scheduled.timerId }) as { status: string };
	assert.equal(cancelled.status, "fired");
	assert.ok(row.firedAt !== null && row.firedAt >= deadline, "the fire does not precede the deadline");
	assert.ok((row.overdueMs ?? -1) >= 0, "the fire records its lateness");
});

it("cancels a scheduled input before its deadline with no admission", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true });
	const deadline = Date.now() + 1500;
	const scheduled = await schedule(f, { message: "CANCELLED_TIMER", deadline, scheduleId: "timer-cancel", requestId: "timer-cancel-delivery" });
	const cancelled = (await f.host.request("timer-cancel", { sessionId: f.storageId, timerId: scheduled.timerId })) as { status: string };
	assert.equal(cancelled.status, "cancelled");
	const page = (await f.host.request("timer-list", { sessionId: f.storageId })) as TimerListPage;
	const row = page.timers.find((timer) => timer.timerId === scheduled.timerId);
	assert.equal(row?.status, "cancelled");
	for (const reopen of [false, true]) {
		if (reopen) await f.reopen();
		const repeated = await schedule(f, { message: "CANCELLED_TIMER", deadline, scheduleId: "timer-cancel", requestId: "timer-cancel-delivery" });
		assert.equal(repeated.timerId, scheduled.timerId);
		assert.equal(repeated.disposition, "retained");
		assert.equal(repeated.status, "terminal");
		assert.equal(repeated.outcome?.status, "aborted");
	}
	// A sentinel scheduled after the cancelled deadline proves the cancelled input never fired.
	const sentinelDeadline = deadline + 500;
	await schedule(f, { message: "SENTINEL_TIMER", deadline: sentinelDeadline, scheduleId: "timer-sentinel", requestId: "timer-sentinel-delivery" });
	const receipt = await f.waitForReceipt("timer-sentinel-delivery");
	assert.equal(receipt.status, "done");
	assert.equal(await f.searchCount("CANCELLED_TIMER"), 0, "the cancelled input never reached the conversation");
	assert.equal(await f.searchCount("SENTINEL_TIMER"), 1, "the later sentinel fired");
});

it("deduplicates a repeated schedule key into one pending timer", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true });
	const deadline = Date.now() + 30000;
	const first = await schedule(f, { message: "DEDUPE_TIMER", deadline, scheduleId: "timer-dedupe", requestId: "timer-dedupe-delivery" });
	const repeat = await schedule(f, { message: "DEDUPE_TIMER", deadline, scheduleId: "timer-dedupe", requestId: "timer-dedupe-delivery" });
	assert.equal(repeat.timerId, first.timerId);
	assert.equal(repeat.deduped, true);
	const page = (await f.host.request("timer-list", { sessionId: f.storageId })) as TimerListPage;
	assert.equal(page.timers.filter((timer) => timer.scheduleId === "timer-dedupe").length, 1);
	const cancelled = (await f.host.request("timer-cancel", { sessionId: f.storageId, timerId: first.timerId })) as { status: string };
	assert.equal(cancelled.status, "cancelled");
});

it("refuses background release and preserves a pending timer", { timeout: 10000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true });
	const scheduled = await schedule(f, { message: "PRESERVED_TIMER", deadline: Date.now() + 30000, scheduleId: "timer-preserved", requestId: "timer-preserved-delivery" });
	await assert.rejects(f.host.request("release", { sessionId: f.storageId, background: true }), /release cannot be combined with background; abort with background first, then release/u);
	let page = (await f.host.request("timer-list", { sessionId: f.storageId })) as TimerListPage;
	assert.equal(page.timers.find((timer) => timer.timerId === scheduled.timerId)?.status, "pending");
	await f.host.request("release", { sessionId: f.storageId });
	page = (await f.host.request("timer-list", { sessionId: f.storageId })) as TimerListPage;
	assert.equal(page.timers.find((timer) => timer.timerId === scheduled.timerId)?.status, "pending");
	await f.host.request("timer-cancel", { sessionId: f.storageId, timerId: scheduled.timerId });
});

it("keeps a pending timer as live work so the host cannot idle-retire", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true });
	const deadline = Date.now() + 30000;
	const scheduled = await schedule(f, { message: "IDLE_TIMER", deadline, scheduleId: "timer-idle", requestId: "timer-idle-delivery" });
	assert.equal(await f.host.refreshIdle(), false, "refreshIdle counts the pending timer");
	const cancelled = (await f.host.request("timer-cancel", { sessionId: f.storageId, timerId: scheduled.timerId })) as { status: string };
	assert.equal(cancelled.status, "cancelled");
	assert.equal(await f.host.refreshIdle(), true, "settled work leaves the host idle");
});

it("resumes an overdue timer on reopen with its original deadline", { timeout: 60000 }, async (t) => {
	let now = Date.now();
	const f = await scheduleFixture(t, { agentExtension: true, now: () => now, resume: false });
	const deadline = now + 600;
	const scheduled = await schedule(f, { message: "OVERDUE_TIMER", deadline, scheduleId: "timer-overdue", requestId: "timer-overdue-delivery" });
	assert.equal(await f.searchCount("OVERDUE_TIMER"), 0, "the paused scheduler admits no input before close");
	await f.close();
	now = deadline + 200;
	await f.reopen();
	f.host.harness.resume();
	const receipt = await f.waitForReceipt("timer-overdue-delivery");
	assert.equal(receipt.status, "done");
	const page = (await f.host.request("timer-list", { sessionId: f.storageId })) as TimerListPage;
	const row = page.timers.find((timer) => timer.timerId === scheduled.timerId);
	assert.ok(row, "the recovered timer keeps its record");
	assert.equal(row.status, "fired");
	assert.equal(row.deadline, deadline, "replay does not recompute the deadline");
	assert.equal(row.overdueMs, 200, "the reopened timer records the controlled overdue interval");
	assert.ok(row.firedAt !== null && row.firedAt > deadline);
	assert.equal(await f.searchCount("OVERDUE_TIMER"), 1, "the overdue input is admitted once");
});

it("reports pending scheduled inputs in a session status with a bounded projection", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true });
	const later = await schedule(f, { message: "STATUS_LATER", deadline: Date.now() + 30000, scheduleId: "status-later", requestId: "status-later-delivery" });
	const sooner = await schedule(f, { message: "STATUS_SOONER", deadline: Date.now() + 20000, scheduleId: "status-sooner", requestId: "status-sooner-delivery" });
	const response = (await f.host.request("status", { sessionId: f.storageId })) as { conversation?: { timers?: Array<{ id: number; target: string; deadline: number; mode: string; status: string; overdue: boolean }> } };
	const timers = response.conversation?.timers ?? [];
	assert.deepEqual(timers.map((row) => row.id), [sooner.timerId, later.timerId], "nearest deadline is first");
	for (const row of timers) {
		assert.equal(row.target, f.storageId);
		assert.equal(row.mode, "followUp");
		assert.equal(row.status, "pending");
		assert.equal(row.overdue, false);
	}
	// The status output passes the declared schema, timers included.
	const structured = structuredObservation(StatusOutputSchema, response) as { conversation?: { timers?: unknown[] } };
	assert.equal(structured.conversation?.timers?.length, 2, "the status schema accepts and keeps timer rows");
	assert.deepEqual(await timerStatusRows(f.host.harness, 99 as ConversationId, BACKGROUND_CONTEXT), [], "another conversation reports no timers");
	await f.host.request("timer-cancel", { sessionId: f.storageId, timerId: sooner.timerId });
	await f.host.request("timer-cancel", { sessionId: f.storageId, timerId: later.timerId });
	const after = (await f.host.request("status", { sessionId: f.storageId })) as { conversation?: { timers?: unknown[] } };
	assert.equal(after.conversation?.timers?.length, 0, "cancelled timers leave the pending list");
});

it("refuses a timer cancellation from another conversation", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true });
	const other = await f.host.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	const scheduled = await schedule(f, { message: "TARGET_CHECK", deadline: Date.now() + 30000, scheduleId: "target-check", requestId: "target-check-delivery" });
	await assert.rejects(
		f.host.request("timer-cancel", { sessionId: f.host.identity(other.id), timerId: scheduled.timerId }),
		/targets another conversation/u,
	);
	const cancelled = (await f.host.request("timer-cancel", { sessionId: f.storageId, timerId: scheduled.timerId })) as { status: string };
	assert.equal(cancelled.status, "cancelled", "the owning session still cancels its timer");
});

it("never reports a cancelled timer whose input was admitted", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true });
	for (let index = 0; index < 8; index += 1) {
		const requestId = `race-timer-delivery-${index}`;
		const scheduled = await schedule(f, { message: `RACE_TIMER_${index}`, deadline: Date.now() - 1, scheduleId: `race-timer-${index}`, requestId });
		const result = (await f.host.request("timer-cancel", { sessionId: f.storageId, timerId: scheduled.timerId })) as { status: string };
		const record = await f.host.harness.commit((tx) => tx.submissionByRequest(1 as ConversationId, requestId), BACKGROUND_CONTEXT);
		if (result.status === "cancelled") assert.equal(record, undefined, `cancelled timer ${index} admitted no input`);
		else assert.notEqual(record, undefined, `a fired timer ${index} keeps its admitted input`);
	}
});

it("records the admission origin that decides the answer notice wake", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true });
	const operatorDeadline = Date.now() + 400;
	await schedule(f, { message: "OPERATOR_ORIGIN", deadline: operatorDeadline, scheduleId: "timer-operator", requestId: "timer-operator-delivery", origin: "operator" });
	const operatorReceipt = await f.waitForReceipt("timer-operator-delivery");
	assert.equal(operatorReceipt.status, "done");
	assert.equal(operatorReceipt.origin, "operator", "an operator-scheduled answer stays a no-wake notice");
	const modelDeadline = Date.now() + 400;
	await schedule(f, { message: "MODEL_ORIGIN", deadline: modelDeadline, scheduleId: "timer-model", requestId: "timer-model-delivery", origin: "model" });
	const modelReceipt = await f.waitForReceipt("timer-model-delivery");
	assert.equal(modelReceipt.status, "done");
	assert.equal(modelReceipt.origin, "model", "a model-scheduled answer keeps the waking notice");
	const conversation = await f.host.harness.conversation(1 as ConversationId, BACKGROUND_CONTEXT);
	assert.ok(conversation);
	const entries = (await conversation.entries({}, 30, undefined, BACKGROUND_CONTEXT)).items;
	const operatorInput = entries.find((entry) => entry.id === operatorReceipt.entryId);
	const modelInput = entries.find((entry) => entry.id === modelReceipt.entryId);
	assert.equal(operatorInput?.kind, "pi.user");
	assert.equal(modelInput?.kind, "agent.input");
	assert.deepEqual(modelInput?.data, { author: { role: "agent", identity: f.ownerId } });
	const page = (await f.host.request("timer-list", { sessionId: f.storageId })) as TimerListPage;
	for (const requestId of ["timer-operator", "timer-model"]) {
		const row = page.timers.find((timer) => timer.scheduleId === requestId);
		assert.equal(row?.origin, requestId === "timer-operator" ? "operator" : "model");
	}
});

function timerInput(f: Awaited<ReturnType<typeof scheduleFixture>>, key: string): TimerInput {
	return { scheduleId: key, deadline: Date.now() + 60000, conversationId: 1, identity: f.storageId, message: key, mode: "followUp", origin: "operator", ownerId: f.ownerId, requestId: `${key}:delivery`, createdAt: Date.now() };
}

it("retains schedule identity after listing pruning and reopen", { timeout: 60000 }, async t => {
	const f = await scheduleFixture(t, { agentExtension: true });
	const input = { message: "PRUNED_TIMER", deadline: Date.now() - 1, scheduleId: "pruned-timer", requestId: "pruned-delivery" };
	const first = await schedule(f, input);
	await f.waitForReceipt(input.requestId);
	for (let index = 0; index <= TIMER_SETTLED_RECORD_LIMIT; index++) {
		const timer = await schedule(f, { message: "discard", deadline: Date.now() + 60000, scheduleId: `prune-${index}`, requestId: `prune-delivery-${index}` });
		await f.host.request("timer-cancel", { timerId: timer.timerId });
	}
	const page = await f.host.request("timer-list") as TimerListPage;
	assert.equal(page.timers.some(row => row.timerId === first.timerId), false);
	await f.reopen();
	const replay = await schedule(f, input);
	assert.equal(replay.timerId, first.timerId);
	assert.equal(replay.outcome?.status, "completed");
	assert.equal(await f.searchCount(input.message), 1);
	assert.equal((await f.host.request("timer-cancel", { timerId: first.timerId }) as { status: string }).status, "fired");
});

it("binds every semantic scheduling fact but not creation time or default check-ins", { timeout: 60000 }, async t => {
	const f = await scheduleFixture(t, { agentExtension: true, resume: false });
	const input = { ...timerInput(f, "bound-payload"), conversationId: 1 as ConversationId };
	const first = await scheduleTimer(f.host.harness, input, BACKGROUND_CONTEXT);
	assert.equal((await scheduleTimer(f.host.harness, { ...input, createdAt: input.createdAt + 1, checkInMinutes: 0 }, BACKGROUND_CONTEXT)).timerId, first.timerId);
	for (const change of [
		{ conversationId: 2 as ConversationId }, { identity: "other" }, { message: "changed" }, { deadline: input.deadline + 1 },
		{ mode: "steer" as const }, { origin: "model" as const }, { ownerId: "other-owner" }, { requestId: "other-request" }, { checkInMinutes: 1 },
		{ requestContext: { requestId: input.requestId, requester: "requester", replyTo: input.ownerId, origin: input.origin } },
	]) await assert.rejects(scheduleTimer(f.host.harness, { ...input, ...change }, BACKGROUND_CONTEXT), /Conflicting timer schedule key/u);
	assert.equal(await f.searchCount(input.message), 0);
});

for (const terminal of [false, true]) it(`adopts an unindexed native timer with terminal=${terminal} across storage and reopen`, { timeout: 60000 }, async t => {
	const f = await scheduleFixture(t, { agentExtension: true, resume: !terminal });
	const other = await f.host.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	const input = { ...timerInput(f, "unindexed"), conversationId: other.id, identity: f.host.identity(other.id) };
	const taskId = await f.host.harness.commit(tx => tx.createTask(TimerTask, input, { conversationId: other.id, ownership: { kind: "conversation" }, background: true }), BACKGROUND_CONTEXT);
	if (terminal) {
		f.host.harness.resume();
		await f.host.request("timer-cancel", { sessionId: input.identity, timerId: taskId });
	}
	await f.reopen();
	await assert.rejects(scheduleTimer(f.host.harness, { ...input, conversationId: 1 as ConversationId, identity: f.storageId }, BACKGROUND_CONTEXT), /Conflicting/u);
	assert.equal(await f.host.harness.snapshot(TimerScheduleDoc, input.scheduleId, BACKGROUND_CONTEXT), undefined);
	const replay = await scheduleTimer(f.host.harness, input, BACKGROUND_CONTEXT);
	assert.equal(replay.timerId, taskId);
	assert.equal(replay.disposition, "retained");
	if (terminal) assert.equal(replay.outcome?.status, "aborted");
	assert.equal((await f.host.harness.snapshot(TimerScheduleDoc, input.scheduleId, BACKGROUND_CONTEXT))?.timerId, taskId);
	await assert.rejects(scheduleTimer(f.host.harness, { ...input, conversationId: 1 as ConversationId, identity: f.storageId }, BACKGROUND_CONTEXT), /Conflicting/u);
	assert.equal(await f.searchCount(input.message), 0);
});

it("refuses ambiguous unindexed timer history", { timeout: 60000 }, async t => {
	const f = await scheduleFixture(t, { agentExtension: true, resume: false });
	const input = { ...timerInput(f, "ambiguous"), conversationId: 1 as ConversationId };
	await f.host.harness.commit(async tx => {
		for (let index = 0; index < 2; index++) await tx.createTask(TimerTask, input, { conversationId: input.conversationId, ownership: { kind: "conversation" }, background: true });
	}, BACKGROUND_CONTEXT);
	await assert.rejects(scheduleTimer(f.host.harness, input, BACKGROUND_CONTEXT), /Ambiguous timer schedule key/u);
	assert.equal(await f.searchCount(input.message), 0);
});

it("refuses incomplete history even when a matching timer appears before the bound", { timeout: 60000 }, async t => {
	const f = await scheduleFixture(t, { agentExtension: true, resume: false });
	const input = { ...timerInput(f, "incomplete"), conversationId: 1 as ConversationId };
	let first: TaskId | undefined;
	await f.host.harness.commit(async tx => {
		for (let index = 0; index <= TIMER_LOOKUP_PAGE_LIMIT * TIMER_LOOKUP_PAGE_SIZE; index++) {
			const id = await tx.createTask(TimerTask, { ...input, scheduleId: index === 0 ? input.scheduleId : `other-${index}` }, { conversationId: input.conversationId, ownership: { kind: "conversation" }, background: true });
			first ??= id;
		}
	}, BACKGROUND_CONTEXT);
	await assert.rejects(scheduleTimer(f.host.harness, input, BACKGROUND_CONTEXT), /Incomplete timer schedule lookup/u);
	assert.ok(first);
	assert.equal((await f.host.harness.snapshot(TimerScheduleDoc, input.scheduleId, BACKGROUND_CONTEXT)), undefined);
	assert.equal(await f.searchCount(input.message), 0);
});
