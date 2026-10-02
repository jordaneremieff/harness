/**
 * Host-level reset tests over a real Harness and SQLite storage: boundary
 * placement, retained history, retained timers, request deduplication, and no
 * model turn from the reset itself.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, EntryRecord, Harness, SubmissionRecord } from "@earendil-works/pi-durable";
import type { ResetResult } from "./durable-reset.ts";
import { scheduleFixture } from "./durable-schedule-fixture.mts";

/** Event-based wait for a reset write to leave the queued state; the caller sees the placed record. */
async function waitForPlacedReset(harness: Harness, conversationId: ConversationId, requestId: string): Promise<Extract<SubmissionRecord, { readonly type: "write" }>> {
	for (;;) {
		let wake: () => void = () => {};
		const woke = new Promise<void>((resolve) => {
			wake = resolve;
		});
		const unsubscribe = harness.subscribeCommits(() => {
			queueMicrotask(wake);
		});
		try {
			const record = await harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), BACKGROUND_CONTEXT);
			if (record !== undefined && record.type === "write" && record.status !== "queued") return record;
			await woke;
		} finally {
			unsubscribe();
		}
	}
}

function messageText(messages: readonly Message[] | undefined): string {
	if (messages === undefined) return "";
	return messages
		.flatMap((message) => {
			const content = (message as { readonly content?: unknown }).content;
			if (typeof content === "string") return [content];
			if (!Array.isArray(content)) return [];
			return content.flatMap((part) => (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
		})
		.join("\n");
}

function contextText(messages: readonly Message[]): string {
	return messageText(messages);
}

function entryText(entry: EntryRecord): string {
	return messageText(entry.model);
}

async function resetCount(conversation: Awaited<ReturnType<Awaited<ReturnType<typeof scheduleFixture>>["conversation"]>>): Promise<number> {
	const page = await conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT);
	return page.items.filter((entry) => entry.kind === "pi.reset").length;
}

it("places an idle reset immediately and keeps old history inspectable", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t);
	const conversation = await f.conversation();
	await (await conversation.submit({ type: "input", content: "REMEMBER_OLD_FACT" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	assert.ok(contextText((await conversation.context(BACKGROUND_CONTEXT)).messages).includes("REMEMBER_OLD_FACT"));
	const requestsBefore = f.modelRequestCount();
	const result = (await f.host.request("reset", { sessionId: f.storageId, handoff: "NEW_CONTEXT_HANDOFF", requestId: "reset-idle" })) as ResetResult;
	assert.equal(result.status, "placed");
	assert.ok(result.entryId !== null, "the committed reset names its entry");
	assert.equal(f.modelRequestCount(), requestsBefore, "a reset starts no model turn");
	const after = await conversation.context(BACKGROUND_CONTEXT);
	assert.ok(contextText(after.messages).includes("NEW_CONTEXT_HANDOFF"), "the next context starts with the handoff");
	assert.ok(!contextText(after.messages).includes("REMEMBER_OLD_FACT"), "the old context is not active");
	const page = await conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT);
	assert.ok(page.items.some((entry) => entry.kind === "pi.user" && entryText(entry).includes("REMEMBER_OLD_FACT")), "old history stays inspectable");
	assert.equal(page.items.filter((entry) => entry.kind === "pi.reset").length, 1);
});

it("queues a busy reset until the next boundary and then places it", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { deferFirstAnswer: true });
	const conversation = await f.conversation();
	const run = await conversation.submit({ type: "input", content: "BLOCKING_TASK" }, BACKGROUND_CONTEXT);
	await f.waitForFirstRequest();
	const result = (await f.host.request("reset", { sessionId: f.storageId, handoff: "AFTER_HANDOFF", requestId: "reset-busy" })) as ResetResult;
	assert.equal(result.status, "queued", "a busy conversation queues the reset");
	const queued = await f.host.harness.commit((tx) => tx.submissionByRequest(conversation.id, "reset-busy"), BACKGROUND_CONTEXT);
	assert.ok(queued?.type === "write" && queued.status === "queued");
	f.releaseAnswer();
	await run.wait(BACKGROUND_CONTEXT);
	const placed = await waitForPlacedReset(f.host.harness, conversation.id, "reset-busy");
	assert.equal(placed.status, "done");
	assert.ok(placed.entry !== undefined);
	const after = await conversation.context(BACKGROUND_CONTEXT);
	assert.ok(contextText(after.messages).includes("AFTER_HANDOFF"));
	assert.ok(!contextText(after.messages).includes("BLOCKING_TASK"), "the old run leaves the active context");
});

it("deduplicates a repeated reset request into one retained write", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t);
	const conversation = await f.conversation();
	await (await conversation.submit({ type: "input", content: "RESET_DEDUPE_SOURCE" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	const first = (await f.host.request("reset", { sessionId: f.storageId, handoff: "DEDUPE_HANDOFF", requestId: "reset-dedupe" })) as ResetResult;
	const repeat = (await f.host.request("reset", { sessionId: f.storageId, handoff: "DEDUPE_HANDOFF", requestId: "reset-dedupe" })) as ResetResult;
	assert.equal(repeat.submissionId, first.submissionId);
	assert.equal(repeat.deduped, true, "the retained request is reported as deduplicated");
	assert.equal(await resetCount(conversation), 1, "one reset entry is committed");
});

it("keeps a pending timer across a reset", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t, { agentExtension: true });
	const conversation = await f.conversation();
	const scheduled = (await f.host.request("timer-schedule", {
		sessionId: f.storageId,
		message: "RESET_KEEPS_TIMER",
		deliverAt: Date.now() + 30000,
		mode: "followUp",
		origin: "operator",
		ownerId: f.ownerId,
		scheduleId: "reset-timer",
		requestId: "reset-timer-delivery",
	})) as { timerId: number };
	await (await conversation.submit({ type: "input", content: "RESET_TIMER_SOURCE" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	const result = (await f.host.request("reset", { sessionId: f.storageId, handoff: "TIMER_RESET_HANDOFF", requestId: "reset-timer-source" })) as ResetResult;
	assert.equal(result.status, "placed");
	const page = (await f.host.request("timer-list", { sessionId: f.storageId })) as { timers: Array<{ timerId: number; status: string; live: boolean }> };
	const row = page.timers.find((timer) => timer.timerId === scheduled.timerId);
	assert.equal(row?.status, "pending", "a reset does not cancel background timers");
	assert.equal(row?.live, true);
	const cancelled = (await f.host.request("timer-cancel", { sessionId: f.storageId, timerId: scheduled.timerId })) as { status: string };
	assert.equal(cancelled.status, "cancelled");
});

it("retains no submission for an unknown reset request", { timeout: 60000 }, async (t) => {
	const f = await scheduleFixture(t);
	const conversation = await f.conversation();
	const missing = await f.host.harness.commit((tx) => tx.submissionByRequest(conversation.id, "reset-missing"), BACKGROUND_CONTEXT);
	assert.equal(missing, undefined);
});
