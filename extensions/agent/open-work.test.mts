import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, LiveDoc, MemoryStorage, type ConversationId, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { retainedReportRequest } from "./delivery-store.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { inputEntry } from "./input-entry.ts";
import {
	AgentWorkOutputSchema, CLOSED_WORK_LIMIT, OPEN_WORK_LIMIT, OpenWorkDoc, boundClosedItems, closeOpenWork, closeWork, completeOpenWork, completeWork, continueWork,
	declareOpenWork, dependencyState, executeAgentWork, finalReportLabel, finalReportRequestId, openWorkCheckInLines, openWorkItems, openWorkSectionText, openWorkStatus,
	parseAgentWorkInput, receiptWork, reportDelivery, requestHasOpenWork, stateNoteLabel, withoutVoidItems, type OpenWorkItem, type WorkRoute,
} from "./open-work.ts";
import { recordRequestContext, type RequestContext } from "./request-context.ts";
import { matchesSchema } from "./schema-check.ts";
import { testModel } from "./test-runtime.mts";

const STORAGE = "storage-a";
const dependency = (submissionId = 90, sessionId = "storage-b:4") => ({ sessionId, submissionId });
const workRoute = (requestId = "task-a", submissionId = 7): WorkRoute => ({ requestId, submissionId, requester: "requester-b", replyTo: "recipient-c", origin: "model" });
const declared = (requestId = "task-a", submissionId = 7): OpenWorkItem => ({ ...workRoute(requestId, submissionId), results: [dependency()], note: "wait for the survey", declaredAt: 1, updatedAt: 1 });
const declare = (items: readonly OpenWorkItem[], change: Partial<Parameters<typeof continueWork>[1]> = {}) =>
	continueWork(items, { requestId: "task-a", route: workRoute(), results: [dependency()], note: "wait for the survey", self: STORAGE, now: 5, ...change });

it("applies the action shapes at execution", () => {
	assert.equal(parseAgentWorkInput({ action: "continue", results: [dependency()], note: "n" }).action, "continue");
	assert.equal(parseAgentWorkInput({ action: "complete", request: "task-a", status: "done", message: "m" }).action, "complete");
	assert.deepEqual(parseAgentWorkInput({ action: "continue", results: [], note: "n" }), { action: "continue", results: [], note: "n" });
	assert.throws(() => parseAgentWorkInput({ action: "continue", results: [], note: "n", status: "done" }), /omit status and message/u);
	assert.throws(() => parseAgentWorkInput({ action: "continue", results: [dependency()] }), /requires results .* and note/u);
	assert.throws(() => parseAgentWorkInput({ action: "complete", request: "task-a", status: "done" }), /requires request, status/u);
	assert.throws(() => parseAgentWorkInput({ action: "wait" }), /continue or complete/u);
});

it("declares one item from the route of a placed input", () => {
	const outcome = declare([]);
	assert.ok(!("error" in outcome));
	assert.equal(outcome.change, "declared");
	assert.deepEqual(outcome.item, { ...workRoute(), results: [dependency()], note: "wait for the survey", declaredAt: 5, updatedAt: 5 });
	assert.match((declare([], { route: undefined }) as { error: string }).error, /not a placed input of this conversation with a retained route/u);
});

it("replaces dependencies and keeps the declared route", () => {
	const outcome = declare([declared()], { route: undefined, results: [dependency(91), dependency(92)], note: "second round", now: 9 });
	assert.ok(!("error" in outcome));
	assert.equal(outcome.change, "replaced");
	assert.deepEqual(outcome.items, [{ ...declared(), results: [dependency(91), dependency(92)], note: "second round", updatedAt: 9 }]);
});

it("keeps an item without a dependency open", () => {
	const first = declare([], { results: [] });
	assert.ok(!("error" in first));
	assert.deepEqual([first.change, first.item.results, first.item.close], ["declared", [], undefined]);
	const emptied = declare([declared()], { route: undefined, results: [], note: "own work remains", now: 9 });
	assert.ok(!("error" in emptied));
	assert.deepEqual([emptied.change, emptied.items.length, emptied.item.results, emptied.item.close], ["replaced", 1, [], undefined]);
	assert.match(closeWork(emptied.items, { reason: "stopped", conversationId: 3, now: 40 }).closed[0].close?.message ?? "", /^The conversation was stopped.*\nNo producer was stopped\.$/u);
});

it("refuses repeated, self and excess dependencies and a full document", () => {
	assert.match((declare([], { results: [dependency(), dependency()] }) as { error: string }).error, /named once/u);
	assert.match((declare([], { results: [{ sessionId: STORAGE, submissionId: 7 }] }) as { error: string }).error, /its own input/u);
	assert.match((declare([], { results: Array.from({ length: 17 }, (_, index) => dependency(100 + index)) }) as { error: string }).error, /at most 16/u);
	const full = Array.from({ length: OPEN_WORK_LIMIT }, (_, index) => declared(`task-${index}`, 100 + index));
	assert.match((declare(full) as { error: string }).error, /32 open work items/u);
	assert.ok(!("error" in declare(full, { requestId: "task-3", route: undefined })), "a repeat of a retained item is not a new declaration");
});

it("closes an item once and returns the retained close afterwards", () => {
	const first = completeWork([declared()], { requestId: "task-a", status: "done", message: "all parts landed", conversationId: 3, now: 20 });
	assert.ok(!("error" in first));
	assert.equal(first.deduped, false);
	assert.deepEqual(first.item.close, { status: "done", at: 20, message: "all parts landed", reportRequestId: "work-final:3:task-a" });
	const second = completeWork(first.items, { requestId: "task-a", status: "failed", message: "other", conversationId: 3, now: 30 });
	assert.ok(!("error" in second));
	assert.equal(second.deduped, true);
	assert.deepEqual(second.item, first.item);
	assert.match((completeWork([], { requestId: "task-a", status: "done", message: "m", conversationId: 3, now: 1 }) as { error: string }).error, /no declared work/u);
	assert.match((declare(first.items) as { error: string }).error, /does not reopen/u);
});

it("closes open items for the host and keeps closed ones", () => {
	const done = completeWork([declared("task-a"), declared("task-b", 8)], { requestId: "task-a", status: "done", message: "m", conversationId: 3, now: 20 });
	assert.ok(!("error" in done));
	const all = closeWork(done.items, { reason: "stopped", conversationId: 3, now: 40 });
	assert.deepEqual(all.closed.map((item) => [item.requestId, item.close?.status, item.close?.reportRequestId]), [["task-b", "stopped", "work-final:3:task-b"]]);
	assert.match(all.closed[0].close?.message ?? "", /No producer was stopped/u);
	assert.equal(all.items.find((item) => item.requestId === "task-a")?.close?.status, "done");
	const named = closeWork([declared("task-a"), declared("task-b", 8)], { reason: "reset", conversationId: 3, now: 40, requestIds: ["task-a"] });
	assert.deepEqual(named.closed.map((item) => item.requestId), ["task-a"]);
	assert.equal(named.items.find((item) => item.requestId === "task-b")?.close, undefined);
});

it("removes an open item whose declaring run ended unanswered and bounds closed items", () => {
	const closed = { ...declared("task-c", 9), close: { status: "done" as const, at: 2, message: "m", reportRequestId: "work-final:3:task-c" } };
	assert.deepEqual(withoutVoidItems([declared("task-a", 7), declared("task-b", 8), closed], (item) => item.submissionId === 8 ? "done" : "unanswered").map((item) => item.requestId), ["task-b", "task-c"]);
	const many = Array.from({ length: CLOSED_WORK_LIMIT + 4 }, (_, index) => ({ ...declared(`done-${index}`, 200 + index), close: { status: "done" as const, at: index, message: "m", reportRequestId: `work-final:3:done-${index}` } }));
	const bounded = boundClosedItems([declared(), ...many]);
	assert.equal(bounded.length, CLOSED_WORK_LIMIT + 1);
	assert.equal(bounded[0].requestId, "task-a");
	assert.equal(bounded[1].requestId, "done-4");
});

it("derives dependency states, labels and report delivery states", () => {
	assert.equal(dependencyState({ input: "pending", work: "none" }), "open");
	assert.equal(dependencyState({ input: "settled", work: "open" }), "state-note");
	assert.equal(dependencyState({ input: "settled", work: "closed" }), "arrived");
	assert.equal(dependencyState({ input: "settled", work: "none" }), "arrived");
	assert.equal(stateNoteLabel("open"), "State note, not a final result: work continues in background");
	assert.match(stateNoteLabel("closed", "failed"), /^State note, not a final result: the final work result \(failed\)/u);
	assert.equal(finalReportLabel("done", "task-a"), "Final work result (done) for request task-a");
	assert.equal(finalReportRequestId(3, "task-a"), "work-final:3:task-a");
	assert.equal(reportDelivery(undefined), "absent");
	assert.equal(reportDelivery({ acknowledged: true }), "delivered");
	assert.equal(reportDelivery({ acknowledged: false, delivery: { state: "parked", reason: "r" } }), "parked");
	assert.equal(reportDelivery({ acknowledged: false, fallbackRecipients: ["primary"] }), "fallback");
	assert.equal(reportDelivery({ acknowledged: false }), "active");
});

const route = (requestId = "task-a"): RequestContext => ({ requestId, requester: "requester-b", replyTo: "recipient-c", origin: "model" });
async function fixture(t: TestContext) {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const agent = { model: { provider: testModel.provider, modelId: testModel.id } };
	const conversation = await harness.root(context, { agent });
	const producer = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
	return { harness, conversation, producer };
}
async function placed(tx: Tx, conversationId: ConversationId, request: RequestContext): Promise<SubmissionId> {
	await recordRequestContext(tx, conversationId, request);
	const entry = await tx.appendEntry(conversationId, { kind: "pi.user", ...inputEntry(request.origin, request.requester), model: [{ role: "user", content: "Task", timestamp: 1 }] });
	const id = (await tx.createSubmission({ conversationId, requestId: request.requestId, type: "input", status: "placed", entry: entry.id })).id;
	(await tx.doc(LiveDoc, conversationId)).run = { taskId: 123 as TaskId, inputs: [id], turns: 0 };
	return id;
}
async function answered(tx: Tx, conversationId: ConversationId, id: SubmissionId): Promise<void> {
	const answer = await tx.appendEntry(conversationId, { kind: "pi.assistant", model: [] });
	tx.settleSubmission(id, { status: "done", answer: answer.id });
	delete (await tx.doc(LiveDoc, conversationId)).run;
}

it("keeps the request route, reads dependency states and completes with one final report", async (t) => {
	const { harness, conversation, producer } = await fixture(t);
	const producerIdentity = `${STORAGE}:${producer.id}`;
	const ids = {
		own: await harness.commit((tx) => placed(tx, conversation.id, route()), context),
		child: await harness.commit((tx) => placed(tx, producer.id, { requestId: "child-task", requester: STORAGE, replyTo: STORAGE, origin: "model" }), context),
	};
	const results = [{ sessionId: producerIdentity, submissionId: ids.child, requestId: "child-task" }, { sessionId: "storage-z:2", submissionId: 5 }];
	const first = await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results, note: "wait for the child" }, 10), context);
	assert.ok(!("error" in first));
	assert.equal(first.change, "declared");
	assert.deepEqual([first.item.requestId, first.item.submissionId, first.item.requester, first.item.replyTo, first.item.origin, first.item.state], ["task-a", ids.own, "requester-b", "recipient-c", "model", "open"]);
	assert.deepEqual(first.item.dependencies.map((item) => item.state), ["open", "open"]);
	assert.match(first.item.dependencies[1].unavailable ?? "", /another storage/u);
	assert.deepEqual(first.item.dependencies[0].inspect, { tool: "agent_inspect", view: "result", sessionId: producerIdentity, submissionId: ids.child });
	assert.match((await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results: [{ sessionId: producerIdentity, submissionId: ids.own }], note: "n" }, 11), context) as { error: string }).error, /not an admitted input of that conversation/u);

	await harness.commit((tx) => answered(tx, conversation.id, ids.own), context);
	assert.equal(await harness.commit((tx) => requestHasOpenWork(tx, conversation.id, "task-a"), context), true);
	assert.deepEqual(await harness.commit((tx) => receiptWork(tx, conversation.id, "task-a"), context), { work: "open", label: stateNoteLabel("open") });
	assert.match(await openWorkSectionText(harness, conversation.id, context) ?? "", /"replyTo":"recipient-c"/u);

	// The producer declares its own work and answers: its settled input is a state note.
	await harness.commit((tx) => declareOpenWork(tx, STORAGE, producer.id, { results: [{ sessionId: "storage-z:2", submissionId: 6 }], note: "deeper" }, 12), context);
	await harness.commit((tx) => answered(tx, producer.id, ids.child), context);
	const states = async () => (await harness.commit((tx) => openWorkStatus(tx, STORAGE, conversation.id), context))[0].dependencies.map((item) => item.state);
	assert.deepEqual(await states(), ["state-note", "open"]);
	assert.deepEqual((await openWorkStatus({ harness, context }, STORAGE, conversation.id))[0].dependencies.map((item) => item.state), ["state-note", "open"]);
	assert.match((await harness.commit((tx) => openWorkCheckInLines(tx, STORAGE, conversation.id, "task-a"), context)).join("\n"), /state-note/u);
	await harness.commit((tx) => completeOpenWork(tx, STORAGE, producer.id, { request: "child-task", status: "done", message: "child result" }, 13), context);
	assert.deepEqual(await states(), ["arrived", "open"]);

	const done = await executeAgentWork({ action: "complete", request: "task-a", status: "done", message: "all parts landed" }, { harness, storageId: STORAGE, conversationId: conversation.id, now: 20 }, context);
	assert.equal(done.isError, undefined);
	assert.ok(matchesSchema(AgentWorkOutputSchema, done.details));
	assert.deepEqual([done.details.deduped, done.details.status, done.details.item.state, done.details.item.close?.delivery, done.details.report?.ownerId, done.details.report?.requestId], [false, "done", "closed", "active", "recipient-c", `work-final:${conversation.id}:task-a`]);
	const row = await harness.commit((tx) => retainedReportRequest(tx, "recipient-c", `work-final:${conversation.id}:task-a`), context);
	assert.equal(row?.message, "Final work result (done) for request task-a\n\nall parts landed");
	assert.equal(row?.senderIdentity, STORAGE);
	const again = await executeAgentWork({ action: "complete", request: "task-a", status: "failed", message: "other" }, { harness, storageId: STORAGE, conversationId: conversation.id, now: 30 }, context);
	assert.deepEqual([again.details?.deduped, again.details?.status, again.details?.report?.createdAt], [true, "done", done.details.report?.createdAt]);
	assert.equal((await harness.commit((tx) => retainedReportRequest(tx, "recipient-c", `work-final:${conversation.id}:task-a`), context))?.message, row?.message);
	assert.deepEqual(await harness.commit((tx) => openWorkItems(tx, conversation.id), context), []);
	assert.deepEqual(await harness.commit((tx) => receiptWork(tx, conversation.id, "task-a"), context), { work: "closed", label: stateNoteLabel("closed", "done") });
	assert.equal(await openWorkSectionText(harness, conversation.id, context), undefined);
});

it("selects the single routed input of the run and returns schema-valid details", async (t) => {
	const { harness, conversation } = await fixture(t);
	await harness.commit((tx) => placed(tx, conversation.id, route()), context);
	const host = { harness, storageId: STORAGE, conversationId: conversation.id, now: 10 };
	const first = await executeAgentWork({ action: "continue", results: [dependency()], note: "wait" }, host, context);
	assert.ok(matchesSchema(AgentWorkOutputSchema, first.details));
	assert.deepEqual([first.details.action, first.details.item.requestId, first.details.item.state], ["continue", "task-a", "open"]);
	const emptied = await executeAgentWork({ action: "continue", results: [], note: "own work remains" }, host, context);
	assert.ok(matchesSchema(AgentWorkOutputSchema, emptied.details));
	assert.deepEqual([emptied.details.item.state, emptied.details.item.dependencies, emptied.details.item.note], ["open", [], "own work remains"]);
	assert.equal((await harness.snapshot(OpenWorkDoc, conversation.id, context))?.items.length, 1);
	assert.match((await harness.commit((tx) => openWorkCheckInLines(tx, STORAGE, conversation.id, "task-a"), context)).join("\n"), /No producer dependency/u);
	assert.match(await openWorkSectionText(harness, conversation.id, context) ?? "", /has no producer dependency/u);
	assert.equal((await executeAgentWork({ action: "complete", request: "task-b", status: "done", message: "m" }, host, context)).isError, true);
	assert.equal((await executeAgentWork({ action: "complete", request: "task-a", status: "done", message: "m" }, host, context)).details?.item.state, "closed");
});

it("removes the item of an unanswered declaring run and closes later items with a host report", async (t) => {
	const { harness, conversation } = await fixture(t);
	const id = await harness.commit((tx) => placed(tx, conversation.id, route()), context);
	await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results: [dependency()], note: "wait" }, 10), context);
	await harness.commit(async (tx) => {
		tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
		delete (await tx.doc(LiveDoc, conversation.id)).run;
	}, context);
	assert.equal(await harness.commit((tx) => requestHasOpenWork(tx, conversation.id, "task-a"), context), false);
	assert.deepEqual(await harness.commit((tx) => closeOpenWork(tx, STORAGE, conversation.id, "stopped", 20), context), []);
	assert.deepEqual((await harness.snapshot(OpenWorkDoc, conversation.id, context))?.items, []);
	assert.equal(await harness.commit((tx) => retainedReportRequest(tx, "recipient-c", `work-final:${conversation.id}:task-a`), context), undefined);

	const later = await harness.commit((tx) => placed(tx, conversation.id, route("task-b")), context);
	await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results: [dependency()], note: "wait" }, 30), context);
	await harness.commit((tx) => answered(tx, conversation.id, later), context);
	const closed = await harness.commit((tx) => closeOpenWork(tx, STORAGE, conversation.id, "reset", 40), context);
	assert.deepEqual(closed.map((item) => [item.requestId, item.state, item.close?.status]), [["task-b", "closed", "reset"]]);
	const row = await harness.commit((tx) => retainedReportRequest(tx, "recipient-c", `work-final:${conversation.id}:task-b`), context);
	assert.match(row?.message ?? "", /^Final work result \(reset\) for request task-b\n\nThe context of the conversation was reset/u);
	const repeated = await harness.commit((tx) => completeOpenWork(tx, STORAGE, conversation.id, { request: "task-b", status: "done", message: "late" }, 50), context);
	assert.ok(!("error" in repeated));
	assert.deepEqual([repeated.deduped, repeated.item.close?.status], [true, "reset"]);
});
