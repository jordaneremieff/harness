import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, LiveDoc, MemoryStorage, type ConversationId, type EntryId, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { onStoredCommit } from "./commit-observation.ts";
import { deliveryPendingCount, retainedReportRequest, storeDeliveryRow } from "./delivery-store.ts";
import { acknowledgeReports } from "./durable-controls.ts";
import { readInspection, RESULT_PAGE_BYTES } from "./durable-observation.ts";
import { readableControlText } from "./control-result.ts";
import { InspectToolOutputSchema } from "./observation-schema.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { inputEntry } from "./input-entry.ts";
import {
	AgentWorkOutputSchema, CLOSED_WORK_LIMIT, OPEN_WORK_LIMIT, OpenWorkDoc, boundClosedItems, closeOpenWork, closeWork, completeOpenWork, completeWork, continueWork,
	declareOpenWork, dependencyState, executeAgentWork, finalReportLabel, finalReportRead, finalReportRequestId, finalReportToItself, openWorkCheckInLines, openWorkItems, openWorkStatus,
	DEPENDENCY_MARK_LIMIT, markedState, parseAgentWorkInput, parseDependencyMarks, receiptDependencyMarks, recordDependencyMarks, reportDelivery, reportDependencyMarks,
	requestHasOpenWork, requestWork, stateNoteLabel, withDependencyMarks, withoutVoidItems, type OpenWorkItem, type WorkRoute,
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
	assert.match((completeWork([], { requestId: "task-a", status: "done", message: "m", conversationId: 3, now: 1 }) as { error: string }).error, /no work was declared for this request/u);
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
	assert.deepEqual(await requestWork({ harness, context }, STORAGE, conversation.id, { requestId: "task-a", submissionId: ids.own }), { work: "open", label: stateNoteLabel("open") });

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
	const closedWork = await requestWork({ harness, context }, STORAGE, conversation.id, { requestId: "task-a", submissionId: ids.own });
	assert.deepEqual([closedWork?.work, closedWork?.label], ["closed", stateNoteLabel("closed", "done")]);
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

it("raises retained marks only, matches exact identities and bounds unnamed marks", () => {
	const note = { sessionId: "storage-b:4", submissionId: 90, requestId: "child-task", state: "state-note" as const };
	const arrived = { ...note, state: "arrived" as const };
	assert.deepEqual(withDependencyMarks([], [note, note], []), [note]);
	assert.deepEqual(withDependencyMarks([note], [arrived], []), [arrived]);
	assert.deepEqual(withDependencyMarks([arrived], [note], []), [arrived], "a state note never replaces an arrived result");
	assert.equal(markedState([note], dependency()), "state-note");
	assert.equal(markedState([note], { ...dependency(), requestId: "child-task" }), "state-note");
	assert.equal(markedState([arrived], { ...dependency(), requestId: "other-task" }), undefined);
	assert.equal(markedState([arrived], dependency(91)), undefined);
	assert.equal(markedState([arrived], dependency(90, "storage-b:5")), undefined);
	const many = Array.from({ length: DEPENDENCY_MARK_LIMIT + 3 }, (_, index) => ({ ...arrived, submissionId: 200 + index }));
	const bounded = withDependencyMarks([note], many, [declared()]);
	assert.equal(bounded.length, DEPENDENCY_MARK_LIMIT + 1);
	assert.deepEqual(bounded[0], note, "a mark that a retained item names stays");
	assert.equal(bounded[1].submissionId, 203, "the oldest unnamed marks leave first");
	assert.throws(() => parseDependencyMarks([{ ...note, state: "open" }]), /Invalid dependency marks/u);
	assert.deepEqual(parseDependencyMarks([{ ...note }]), [note]);
});

it("reads a dependency of another storage from the marks of admitted deliveries", async (t) => {
	const REMOTE = "storage-b";
	const { harness, conversation } = await fixture(t);
	const remote = await fixture(t);
	const own = await harness.commit((tx) => placed(tx, conversation.id, route()), context);
	const child = await remote.harness.commit((tx) => placed(tx, remote.conversation.id, { requestId: "child-task", requester: STORAGE, replyTo: STORAGE, origin: "model" }), context);
	const plain = await remote.harness.commit((tx) => placed(tx, remote.producer.id, { requestId: "plain-task", requester: STORAGE, replyTo: STORAGE, origin: "model" }), context);
	const results = [{ sessionId: REMOTE, submissionId: child, requestId: "child-task" }, { sessionId: `${REMOTE}:${remote.producer.id}`, submissionId: plain }];
	await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results, note: "wait for two remote results" }, 10), context);
	await harness.commit((tx) => answered(tx, conversation.id, own), context);
	const read = async () => (await harness.commit((tx) => openWorkStatus(tx, STORAGE, conversation.id), context))[0].dependencies.map((item) => [item.state, item.unavailable === undefined]);
	const deliver = (marks: unknown) => harness.commit((tx) => recordDependencyMarks(tx, conversation.id, parseDependencyMarks(marks)), context);
	assert.deepEqual(await read(), [["open", false], ["open", false]]);

	// The remote producer declares work and answers: its receipt is a labelled state note.
	await remote.harness.commit((tx) => declareOpenWork(tx, REMOTE, remote.conversation.id, { results: [], note: "own work remains" }, 11), context);
	await remote.harness.commit((tx) => answered(tx, remote.conversation.id, child), context);
	const stateNote = await receiptDependencyMarks({ harness: remote.harness, context }, REMOTE, [{ conversationId: remote.conversation.id, submissionId: child, requestId: "child-task", ownerId: STORAGE }]);
	assert.deepEqual(stateNote, [{ sessionId: REMOTE, submissionId: child, requestId: "child-task", state: "state-note" }]);
	await deliver(stateNote);
	assert.deepEqual(await read(), [["state-note", true], ["open", false]]);
	await deliver(stateNote);
	assert.deepEqual(await read(), [["state-note", true], ["open", false]], "a state note alone never reads as arrived");
	assert.deepEqual((await openWorkStatus({ harness, context }, STORAGE, conversation.id))[0].dependencies.map((item) => item.state), ["state-note", "open"]);
	assert.match((await harness.commit((tx) => openWorkCheckInLines(tx, STORAGE, conversation.id, "task-a"), context)).join("\n"), /submission \d+: state-note\./u);

	// A producer without declared work answers: its receipt is the result.
	await remote.harness.commit((tx) => answered(tx, remote.producer.id, plain), context);
	const ordinary = await receiptDependencyMarks({ harness: remote.harness, context }, REMOTE, [{ conversationId: remote.producer.id, submissionId: plain, requestId: "plain-task", ownerId: STORAGE }]);
	assert.deepEqual(ordinary.map((mark) => mark.state), ["arrived"]);
	await deliver(ordinary);
	assert.deepEqual(await read(), [["state-note", true], ["arrived", true]]);

	// Only the explicit final report of the first producer moves its dependency to arrived.
	const completed = await remote.harness.commit((tx) => completeOpenWork(tx, REMOTE, remote.conversation.id, { request: "child-task", status: "done", message: "child result" }, 12), context);
	assert.ok(!("error" in completed) && completed.report !== undefined);
	const report = completed.report;
	assert.deepEqual(await remote.harness.commit((tx) => reportDependencyMarks(tx, REMOTE, { requestId: "report:other", senderIdentity: REMOTE }), context), []);
	assert.deepEqual(await remote.harness.commit((tx) => reportDependencyMarks(tx, REMOTE, { requestId: report.requestId, senderIdentity: `${REMOTE}:${remote.producer.id}` }), context), [], "the sender must be the conversation that the report ID names");
	const final = await remote.harness.commit((tx) => reportDependencyMarks(tx, REMOTE, report), context);
	assert.deepEqual(final, [{ sessionId: REMOTE, submissionId: child, requestId: "child-task", state: "arrived" }]);
	await deliver(final);
	assert.deepEqual(await read(), [["arrived", true], ["arrived", true]]);
	await deliver(await receiptDependencyMarks({ harness: remote.harness, context }, REMOTE, [{ conversationId: remote.conversation.id, submissionId: child, requestId: "child-task", ownerId: STORAGE }]));
	assert.deepEqual(await read(), [["arrived", true], ["arrived", true]], "a late state-note receipt does not lower the state");
});

it("keeps a mark that arrived before the declaration", async (t) => {
	const { harness, conversation } = await fixture(t);
	await harness.commit((tx) => recordDependencyMarks(tx, conversation.id, [{ sessionId: "storage-b:4", submissionId: 90, requestId: "child-task", state: "arrived" }]), context);
	await harness.commit((tx) => placed(tx, conversation.id, route()), context);
	const first = await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results: [dependency(), dependency(91)], note: "one result is already here" }, 10), context);
	assert.ok(!("error" in first));
	assert.deepEqual(first.item.dependencies.map((item) => item.state), ["arrived", "open"]);
});

it("never leaves a final report to the declaring conversation itself pending", async (t) => {
	const { harness, conversation, producer } = await fixture(t);
	const self = (requestId: string, replyTo = STORAGE): RequestContext => ({ requestId, requester: "operator", replyTo, origin: "operator" });
	assert.equal(finalReportToItself(STORAGE, { requestId: `work-final:${conversation.id}:task-a`, ownerId: STORAGE }), true);
	assert.equal(finalReportToItself(STORAGE, { requestId: `work-final:${producer.id}:task-a`, ownerId: `${STORAGE}:${producer.id}` }), true);
	assert.equal(finalReportToItself(STORAGE, { requestId: `work-final:${producer.id}:task-a`, ownerId: STORAGE }), false);
	assert.equal(finalReportToItself(STORAGE, { requestId: `work-final:${conversation.id}:task-a`, ownerId: "storage-b" }), false);
	assert.equal(finalReportToItself(STORAGE, { requestId: "report:other", ownerId: STORAGE }), false);
	const pending = () => deliveryPendingCount(harness, context);
	const row = (requestId: string, owner = STORAGE) => harness.commit((tx) => retainedReportRequest(tx, owner, `work-final:${conversation.id}:${requestId}`), context);
	const declare = async (request: RequestContext) => {
		const id = await harness.commit((tx) => placed(tx, conversation.id, request), context);
		await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results: [], note: "own work remains" }, 10), context);
		await harness.commit((tx) => answered(tx, conversation.id, id), context);
	};

	await declare(self("task-a"));
	const done = await executeAgentWork({ action: "complete", request: "task-a", status: "done", message: "result for the operator" }, { harness, storageId: STORAGE, conversationId: conversation.id, now: 20 }, context);
	assert.ok(matchesSchema(AgentWorkOutputSchema, done.details));
	assert.deepEqual([done.details.item.close?.delivery, done.details.report?.acknowledged], ["retained", true]);
	assert.match(done.output?.[0]?.type === "text" ? done.output[0].text : "", /not sent to it as an input/u);
	assert.equal(await pending(), 0, "a completed item with a self reply recipient leaves no delivery");
	assert.equal((await row("task-a"))?.message, "Final work result (done) for request task-a\n\nresult for the operator");

	await declare(self("task-b"));
	assert.deepEqual((await harness.commit((tx) => closeOpenWork(tx, STORAGE, conversation.id, "stopped", 30), context)).map((item) => item.close?.delivery), ["retained"]);
	assert.equal(await pending(), 0, "an abort leaves no delivery that restarts the stopped conversation");
	assert.match((await row("task-b"))?.message ?? "", /^Final work result \(stopped\) for request task-b/u);

	await declare(self("task-c"));
	assert.deepEqual((await harness.commit((tx) => closeOpenWork(tx, STORAGE, conversation.id, "reset", 40), context)).map((item) => item.close?.delivery), ["retained"]);
	assert.equal(await pending(), 0, "a reset leaves no delivery for the new context");
	assert.equal((await row("task-c"))?.acknowledged, true);
	assert.deepEqual((await openWorkStatus({ harness, context }, STORAGE, conversation.id)).map((item) => item.close?.delivery), ["retained", "retained", "retained"]);

	// Another reply recipient keeps the ordinary pending delivery.
	await declare(self("task-d", "recipient-c"));
	assert.deepEqual((await harness.commit((tx) => closeOpenWork(tx, STORAGE, conversation.id, "stopped", 50), context)).map((item) => item.close?.delivery), ["active"]);
	assert.equal(await pending(), 1);
	assert.equal((await row("task-d", "recipient-c"))?.acknowledged, false);
});

it("names both causes when a repeated complete finds no retained item", async (t) => {
	const { harness, conversation } = await fixture(t);
	const host = (now: number) => ({ harness, storageId: STORAGE, conversationId: conversation.id, now });
	for (let index = 0; index <= CLOSED_WORK_LIMIT; index++) {
		const id = await harness.commit((tx) => placed(tx, conversation.id, route(`task-${index}`)), context);
		await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results: [], note: "own work remains" }, 10 + index), context);
		await harness.commit((tx) => answered(tx, conversation.id, id), context);
		assert.equal((await executeAgentWork({ action: "complete", request: `task-${index}`, status: "done", message: `result ${index}` }, host(100 + index), context)).isError, undefined);
	}
	const text = (result: Awaited<ReturnType<typeof executeAgentWork>>) => result.output?.[0]?.type === "text" ? result.output[0].text : "";
	const kept = await executeAgentWork({ action: "complete", request: "task-1", status: "done", message: "again" }, host(200), context);
	assert.equal(kept.details?.deduped, true);
	const dropped = await executeAgentWork({ action: "complete", request: "task-0", status: "done", message: "again" }, host(201), context);
	assert.equal(dropped.isError, true);
	assert.match(text(dropped), /no work was declared for this request/u);
	assert.match(text(dropped), new RegExp(`closed earlier than the last ${CLOSED_WORK_LIMIT} closed items that the conversation keeps`, "u"));
	assert.match(text(dropped), /changed nothing and sent no report/u);
	assert.equal((await harness.commit((tx) => retainedReportRequest(tx, "recipient-c", `work-final:${conversation.id}:task-0`), context))?.message, "Final work result (done) for request task-0\n\nresult 0", "the first report stays the only one");
	assert.match(text(dropped), new RegExp(`A final report of an earlier close stays readable: agent_inspect\\(\\{"view":"result","sessionId":"${STORAGE}","submissionId":\\d+,"finalReport":true,"offset":0\\}\\)$`, "u"));
	assert.equal(text(await executeAgentWork({ action: "complete", request: "never-declared", status: "done", message: "m" }, host(202), context)), text(dropped).replace("task-0", "never-declared").replace(/\. A final report of an earlier close .*$/su, ""), "a request without an input of this conversation names no read call");
});

it("reads the status through snapshots without a committed change", async (t) => {
	const { harness, conversation, producer } = await fixture(t);
	const id = await harness.commit((tx) => placed(tx, conversation.id, route()), context);
	await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results: [], note: "own work remains" }, 11), context);
	await harness.commit((tx) => answered(tx, conversation.id, id), context);
	await harness.commit((tx) => completeOpenWork(tx, STORAGE, conversation.id, { request: "task-a", status: "done", message: "result" }, 20), context);
	const changes: string[] = [];
	const stop = onStoredCommit(harness, (publication) => { changes.push(...publication.changes.map((change) => change.type)); });
	t.after(stop);
	const closed = await openWorkStatus({ harness, context }, STORAGE, conversation.id);
	assert.deepEqual(closed.map((item) => [item.state, item.close?.delivery]), [["closed", "active"]], "the snapshot reader reads the delivery state of the final report");
	assert.deepEqual(await openWorkStatus({ harness, context }, STORAGE, producer.id), [], "a conversation without the document has no item");
	assert.deepEqual(await openWorkItems({ harness, context }, producer.id), []);
	assert.equal(await requestHasOpenWork({ harness, context }, producer.id, "task-a"), false);
	assert.equal(await requestWork({ harness, context }, STORAGE, producer.id, { requestId: "task-a", submissionId: id }), undefined);
	assert.deepEqual(changes, [], "a snapshot read commits no change, also for a conversation without the document");
	assert.equal(await harness.snapshot(OpenWorkDoc, producer.id, context), undefined);
});

type ResultFields = {
	answer?: string;
	reason: string;
	work?: { state: string; answer: string; label: string; finalReport?: { status?: string; delivery: string; read: unknown } };
	finalReport: { requestId: string; ownerId: string; status?: string; length: number; text: string };
	finalReportContinuation?: Record<string, unknown>;
};

async function answeredWith(tx: Tx, conversationId: ConversationId, id: SubmissionId, text: string): Promise<EntryId> {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const answer = await tx.appendEntry(conversationId, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "test", model: "test", timestamp: 2, stopReason: "stop", usage }] });
	tx.settleSubmission(id, { status: "done", answer: answer.id });
	delete (await tx.doc(LiveDoc, conversationId)).run;
	return answer.id;
}

it("reads the exact final report in pages after acknowledgement and after the closed item left the document", async (t) => {
	const { harness, conversation } = await fixture(t);
	const self = STORAGE;
	const host = (now: number) => ({ harness, storageId: STORAGE, conversationId: conversation.id, now });
	const inspect = async (params: Record<string, unknown>) => await readInspection(harness, STORAGE, conversation, { view: "result", ...params }, context) as ResultFields;
	const id = await harness.commit((tx) => placed(tx, conversation.id, route()), context);
	await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results: [], note: "own work remains" }, 10), context);
	const stateNote = "State note: the survey continues in background.";
	const answerEntryId = await harness.commit((tx) => answeredWith(tx, conversation.id, id, stateNote), context);
	const record = await harness.commit((tx) => tx.submission(id), context);
	await harness.commit((tx) => storeDeliveryRow(tx, "receipt", { submissionId: id, requestId: "task-a", ownerId: "recipient-c", conversationId: conversation.id, operationId: null, origin: "model", status: "done", entryId: record?.type === "input" && "entry" in record ? record.entry ?? null : null, answerEntryId, answer: stateNote, reason: null, acknowledged: false }, true), context);

	const open = await inspect({ submissionId: id });
	assert.deepEqual([open.answer, open.work?.state, open.work?.answer, open.work?.label, open.work?.finalReport], [stateNote, "open", "state-note", stateNoteLabel("open"), undefined]);
	assert.match((await inspect({ submissionId: id, finalReport: true })).reason, /open; its final report does not exist yet/u);

	// A long report with a surrogate pair across the first page boundary.
	const message = `${"a".repeat(4095 - finalReportLabel("done", "task-a").length - 2)}😀${"b".repeat(9000)}`;
	const done = await executeAgentWork({ action: "complete", request: "task-a", status: "done", message }, host(20), context);
	assert.ok(matchesSchema(AgentWorkOutputSchema, done.details));
	const read = finalReportRead(self, id);
	assert.deepEqual(done.details.item.close?.read, read, "the completion names the read call");
	assert.deepEqual((await openWorkStatus({ harness, context }, STORAGE, conversation.id))[0].close?.read, read, "the status names the read call");
	const exact = `${finalReportLabel("done", "task-a")}\n\n${message}`;
	const readAll = async (): Promise<string> => {
		let text = "";
		let call: Record<string, unknown> | undefined = { ...read };
		while (call !== undefined) {
			const { tool: _tool, view: _view, sessionId: _session, ...params } = call;
			const page = await inspect(params);
			assert.ok(matchesSchema(InspectToolOutputSchema, page), "the page matches the public output schema");
			assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= RESULT_PAGE_BYTES);
			assert.equal(page.answer, undefined, "a final report page carries no answer");
			assert.deepEqual([page.finalReport.requestId, page.finalReport.ownerId, page.finalReport.status, page.finalReport.length], [`work-final:${conversation.id}:task-a`, "recipient-c", "done", exact.length]);
			text += page.finalReport.text;
			call = page.finalReportContinuation;
		}
		return text;
	};
	assert.equal(await readAll(), exact, "the pages join to the retained report exactly");

	const answer = await inspect({ submissionId: id });
	assert.deepEqual([answer.answer, answer.work?.state, answer.work?.answer, answer.work?.finalReport?.read], [stateNote, "closed", "state-note", read], "the original answer keeps its state-note label");
	assert.match(readableControlText(answer), /^State note, not a final result: the final work result \(done\) is a separate report\.\n\nState note: the survey/u);
	assert.match(readableControlText(answer), /Read the final report: agent_inspect\(\{"view":"result","sessionId":"storage-a","submissionId":\d+,"finalReport":true,"offset":0\}\)/u);

	await acknowledgeReports(harness, "recipient-c", ["report:work-final:1:task-a"], context);
	assert.equal((await harness.commit((tx) => retainedReportRequest(tx, "recipient-c", `work-final:${conversation.id}:task-a`), context))?.acknowledged, true);
	assert.equal(await readAll(), exact, "acknowledgement keeps the report readable");

	const laterIds: SubmissionId[] = [];
	for (let index = 0; index <= CLOSED_WORK_LIMIT; index++) {
		const later = await harness.commit((tx) => placed(tx, conversation.id, route(`later-${index}`)), context);
		laterIds.push(later);
		await harness.commit((tx) => declareOpenWork(tx, STORAGE, conversation.id, { results: [], note: "own work remains" }, 30 + index), context);
		await harness.commit((tx) => answered(tx, conversation.id, later), context);
		assert.equal((await executeAgentWork({ action: "complete", request: `later-${index}`, status: "failed", message: `later ${index}` }, host(100 + index), context)).isError, undefined);
	}
	assert.equal((await harness.snapshot(OpenWorkDoc, conversation.id, context))?.items.some((item) => item.requestId === "task-a"), false, "the closed item left the work document");
	assert.equal(await readAll(), exact, "the report stays readable after the closed item left");
	const evicted = await inspect({ submissionId: id });
	assert.deepEqual([evicted.answer, evicted.work?.state, evicted.work?.label, evicted.work?.finalReport?.status, evicted.work?.finalReport?.delivery], [stateNote, "closed", stateNoteLabel("closed", "done"), "done", "delivered"]);
	const work = await requestWork({ harness, context }, STORAGE, conversation.id, { requestId: "task-a", submissionId: id, ownerId: "recipient-c" });
	assert.deepEqual([work?.work, work?.label], ["closed", stateNoteLabel("closed", "done")], "the state note keeps its label after the closed item left");
	assert.deepEqual(await receiptDependencyMarks({ harness, context }, STORAGE, [{ conversationId: conversation.id, submissionId: id, requestId: "task-a", ownerId: "recipient-c" }]), [{ sessionId: STORAGE, submissionId: id, requestId: "task-a", state: "state-note" }], "a late receipt of the evicted request still marks a state note, not an arrived result");
	assert.equal((await harness.commit((tx) => retainedReportRequest(tx, "recipient-c", `work-final:${conversation.id}:later-0`), context))?.acknowledged, false);
	assert.equal((await harness.snapshot(OpenWorkDoc, conversation.id, context))?.items.some((item) => item.requestId === "later-0"), false);
	assert.deepEqual((await receiptDependencyMarks({ harness, context }, STORAGE, [{ conversationId: conversation.id, submissionId: laterIds[0], requestId: "later-0", ownerId: "recipient-c" }])).map((mark) => mark.state), ["state-note"], "an evicted request whose final report is still pending marks a state note");
	assert.equal(await requestWork({ harness, context }, STORAGE, conversation.id, { requestId: "never-declared", submissionId: id, ownerId: "recipient-c" }), undefined);
	await assert.rejects(inspect({ submissionId: id, finalReport: true, receiptCursor: "x" }), /finalReport and receiptCursor select different pages/u);
	await assert.rejects(readInspection(harness, STORAGE, conversation, { view: "history", finalReport: true }, context), /finalReport selects only the result view/u);
});
