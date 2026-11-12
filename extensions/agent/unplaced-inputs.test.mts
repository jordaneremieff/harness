import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, LiveDoc, createRegistry, defineExtension, defineTask, type ConversationId, type LiveState, type Storage, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { deliveryState, migrateDeliveryStore } from "./delivery-store.ts";
import type { DeliveryReport } from "./durable-controls.ts";
import { waitForDeliveryFixture } from "./delivery-store-fixture.mts";
import { onStoredCommit } from "./commit-observation.ts";
import { OpenWorkDoc } from "./open-work.ts";
import { RequestContextDoc } from "./request-context.ts";
import { UNPLACED_NOTICE_MS, UnplacedInputsDoc, UnplacedWatchTask, currentStep, pruneUnplacedInputs, readUnplacedSummary, recordUnplacedInput, unplacedSummary, type InputClass, type UnplacedInput } from "./unplaced-inputs.ts";

const RECIPIENT = "store";
const EPOCH = 1_800_000_000_000;

/** A live task that only sleeps, so a live slot or a run can name a task with a recorded first start. */
const StepTask = defineTask<Record<string, never>, { phase: "hold" }, null>({
	name: "fixture.step",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: { hold: async (task, runtime, context) => { await runtime.sleepUntil(Number.MAX_SAFE_INTEGER, task.state.checkpoint, context); } },
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

interface Fixture {
	readonly harness: Harness;
	readonly id: ConversationId;
	readonly clock: { now: number };
}

/** The Harness clock is the test's value; the Harness arms no timer for a sleep and runs a due task at `resume()`. */
async function open(t: { after(fn: () => void | Promise<void>): void }, clock = { now: EPOCH }, storage: Storage = new MemoryStorage()): Promise<Fixture> {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "fixture.unplaced", tasks: [UnplacedWatchTask, StepTask] }));
	const harness = await Harness.open(storage, { models: createModels(), registry, now: () => clock.now, onWake: () => {} }, BACKGROUND_CONTEXT);
	t.after(() => harness.close(BACKGROUND_CONTEXT).catch(() => undefined));
	await migrateDeliveryStore(harness, BACKGROUND_CONTEXT);
	const root = await harness.root(BACKGROUND_CONTEXT);
	harness.resume();
	return { harness, id: root.id, clock };
}

function bounded() {
	return withAbortSignal(AbortSignal.timeout(20_000), BACKGROUND_CONTEXT);
}

/** Resolve when a live task of the kind sleeps. */
async function sleeping(f: Fixture, kind: string): Promise<void> {
	const graph = await f.harness.watchTaskGraph(BACKGROUND_CONTEXT);
	const ready = (value: typeof graph.value) => Object.values(value.tasks).some((node) => node.kind === kind && node.state.status === "sleeping");
	try {
		if (!ready(graph.value)) await new Promise<void>((resolve) => graph.start(async (call) => { if (call.kind === "value" && ready(call.value)) resolve(); }));
	} finally { await graph.stop(); }
}

async function queued(f: Fixture, requestId: string): Promise<number> {
	return f.harness.commit(async (tx) => (await tx.createSubmission({ conversationId: f.id, requestId, type: "input", status: "queued" })).id, BACKGROUND_CONTEXT);
}

async function admit(f: Fixture, requestId: string, inputClass: InputClass, sender: string): Promise<number> {
	const submissionId = await queued(f, requestId);
	const placement = await f.harness.commit((tx) => recordUnplacedInput(tx, f.id, { submissionId, class: inputClass, sender, admittedAt: f.clock.now, recipient: RECIPIENT }), BACKGROUND_CONTEXT);
	assert.equal(placement, "unplaced");
	// The watch commits its sleep before the test moves the clock.
	await sleeping(f, UnplacedWatchTask.definition.name);
	return submissionId;
}

async function settle(f: Fixture, submissionId: number): Promise<void> {
	await f.harness.commit((tx) => { tx.settleSubmission(submissionId as SubmissionId, { status: "unanswered", reason: "aborted" }); }, BACKGROUND_CONTEXT);
}

async function watchTask(f: Fixture): Promise<TaskId> {
	const watch = (await f.harness.snapshot(UnplacedInputsDoc, f.id, BACKGROUND_CONTEXT))?.watch;
	assert.ok(watch !== undefined, "a recorded row owns one watch task");
	return watch as TaskId;
}

/** Move the Harness clock and let the due task run. */
function advance(f: Fixture, to: number): void {
	f.clock.now = to;
	f.harness.resume();
}

/** The `noticed` marks of the rows, once a stored commit satisfies the condition. */
function rowsWhen(f: Fixture, ready: (rows: readonly UnplacedInput[]) => boolean): Promise<boolean[]> {
	return new Promise((resolve, reject) => {
		let done = false;
		const check = async (): Promise<void> => {
			const rows = (await f.harness.snapshot(UnplacedInputsDoc, f.id, BACKGROUND_CONTEXT))?.inputs ?? [];
			if (done || !ready(rows)) return;
			done = true;
			detach();
			resolve(rows.map((row) => row.noticed));
		};
		const detach = onStoredCommit(f.harness, () => { void check().catch(reject); });
		void check().catch(reject);
	});
}

async function notices(f: Fixture): Promise<DeliveryReport[]> {
	return (await deliveryState(f.harness, BACKGROUND_CONTEXT, true)).reports.filter((report) => report.sourceId.startsWith("unplaced:"));
}

function noticeFor(f: Fixture, ownerId: string): Promise<DeliveryReport> {
	return waitForDeliveryFixture(f.harness, bounded(), (state) => state.reports.find((report) => report.ownerId === ownerId && report.sourceId.startsWith("unplaced:")));
}

/** A sleeping task with a recorded first start. */
async function stepTask(f: Fixture): Promise<{ id: TaskId; startedAt: number }> {
	const id = await f.harness.commit((tx) => tx.createTask(StepTask, {}, { ownership: { kind: "conversation" }, conversationId: f.id, background: true }), BACKGROUND_CONTEXT);
	await sleeping(f, StepTask.definition.name);
	const startedAt = (await f.harness.getTask(id, BACKGROUND_CONTEXT))?.startedAt;
	assert.ok(startedAt !== undefined, "a task that ran has a first start");
	return { id, startedAt };
}

async function live(f: Fixture, change: (state: LiveState) => void): Promise<void> {
	await f.harness.commit(async (tx) => { change(await tx.doc(LiveDoc, f.id) as LiveState); }, BACKGROUND_CONTEXT);
}

/** A run that serves one placed input with a route to `replyTo`. */
async function routedRun(f: Fixture, taskId: TaskId, requestId: string, replyTo: string): Promise<void> {
	const submission = await f.harness.commit(async (tx) => {
		const entry = await tx.appendEntry(f.id, { kind: "agent.input", model: [{ role: "user", content: "routed", timestamp: f.clock.now }] });
		return (await tx.createSubmission({ conversationId: f.id, requestId, type: "input", status: "placed", entry: entry.id })).id;
	}, BACKGROUND_CONTEXT);
	await f.harness.commit(async (tx) => {
		(await tx.doc(RequestContextDoc, f.id)).requests.push({ requestId, requester: replyTo, replyTo, origin: "model" });
		(await tx.doc(LiveDoc, f.id) as LiveState).run = { taskId, inputs: [submission], turns: 0 };
	}, BACKGROUND_CONTEXT);
}

it("reports the committed placement, keeps the first admission time, and counts only queued rows", async (t) => {
	const f = await open(t);
	const first = await admit(f, "first", "steer", "sender-a");
	f.clock.now = EPOCH + 1000;
	const second = await admit(f, "second", "followUp", "sender-b");
	const repeat = await f.harness.commit((tx) => recordUnplacedInput(tx, f.id, { submissionId: first, class: "steer", sender: "sender-a", admittedAt: EPOCH + 5000, recipient: RECIPIENT }), BACKGROUND_CONTEXT);
	assert.equal(repeat, "unplaced");
	const rows = (await f.harness.snapshot(UnplacedInputsDoc, f.id, BACKGROUND_CONTEXT))?.inputs ?? [];
	assert.deepEqual(rows, [
		{ requestId: "first", submissionId: first, class: "steer", sender: "sender-a", admittedAt: EPOCH, noticed: false },
		{ requestId: "second", submissionId: second, class: "followUp", sender: "sender-b", admittedAt: EPOCH + 1000, noticed: false },
	]);
	assert.deepEqual(await readUnplacedSummary(f.harness, f.id, BACKGROUND_CONTEXT), { unplaced: 2, oldestAdmittedAt: EPOCH });
	assert.deepEqual(await f.harness.commit((tx) => unplacedSummary(tx, f.id), BACKGROUND_CONTEXT), { unplaced: 2, oldestAdmittedAt: EPOCH });

	await settle(f, first);
	assert.deepEqual(await readUnplacedSummary(f.harness, f.id, BACKGROUND_CONTEXT), { unplaced: 1, oldestAdmittedAt: EPOCH + 1000 }, "a read counts only rows that are still queued");
	assert.equal((await f.harness.snapshot(UnplacedInputsDoc, f.id, BACKGROUND_CONTEXT))?.inputs.length, 2, "a read prunes nothing");
	const pruned = await f.harness.commit(async (tx) => (await pruneUnplacedInputs(tx, f.id)).map((row) => row.requestId), BACKGROUND_CONTEXT);
	assert.deepEqual(pruned, ["second"]);

	const placed = await f.harness.commit((tx) => recordUnplacedInput(tx, f.id, { submissionId: first, class: "steer", sender: "sender-a", admittedAt: f.clock.now, recipient: RECIPIENT }), BACKGROUND_CONTEXT);
	assert.equal(placed, "placed", "a settled submission is not unplaced");
	const absent = await f.harness.commit((tx) => recordUnplacedInput(tx, f.id, { submissionId: 999_999, class: "steer", sender: "sender-a", admittedAt: f.clock.now }), BACKGROUND_CONTEXT);
	assert.equal(absent, "placed", "an unknown submission records no row");
	await settle(f, second);
	assert.deepEqual(await readUnplacedSummary(f.harness, f.id, BACKGROUND_CONTEXT), { unplaced: 0 });
});

it("sends one notice at five minutes with the running tool and the first start of its task", async (t) => {
	const f = await open(t);
	const step = await stepTask(f);
	await live(f, (state) => { state.tools = [{ callId: "call-1", name: "bash", status: "running", taskId: step.id }]; });
	await admit(f, "stuck", "followUp", "sender-a");
	assert.equal(f.harness.wake().at, EPOCH + UNPLACED_NOTICE_MS, "the watch sleeps to the admission time plus the notice period");
	assert.deepEqual(await notices(f), [], "no notice precedes the notice period");

	// One millisecond early nothing is due; the notice below carries the time of the due clock value.
	advance(f, EPOCH + UNPLACED_NOTICE_MS - 1);
	advance(f, EPOCH + UNPLACED_NOTICE_MS);
	const notice = await noticeFor(f, "sender-a");
	assert.equal(notice.sourceId, `unplaced:${f.id}:stuck`);
	assert.equal(notice.senderIdentity, RECIPIENT);
	assert.equal(notice.createdAt, EPOCH + UNPLACED_NOTICE_MS);
	assert.equal(notice.passive, undefined);
	assert.match(notice.message, /did not place 1 admitted input from you for more than 5 minutes/u);
	assert.ok(notice.message.includes(`oldest admitted ${new Date(EPOCH).toISOString()}, request stuck`));
	assert.ok(notice.message.includes(`Current step: tool bash, first started at ${new Date(step.startedAt).toISOString()}.`), notice.message);
	assert.equal((await notices(f)).length, 1);
	assert.equal((await f.harness.snapshot(UnplacedInputsDoc, f.id, BACKGROUND_CONTEXT))?.inputs[0]?.noticed, true);
});

it("names the step from the live state: unknown start, compaction, provider retry, model step", async (t) => {
	const f = await open(t);
	const step = await stepTask(f);
	const first = `first started at ${new Date(step.startedAt).toISOString()}`;
	const read = () => f.harness.commit((tx) => currentStep(tx, f.id, 4), BACKGROUND_CONTEXT);
	assert.equal(await read(), "no run");
	await live(f, (state) => { state.tools = [{ callId: "call-1", name: "bash", status: "running" }, { callId: "call-2", name: "read", status: "done", taskId: step.id }]; });
	assert.equal(await read(), "tool bash, start unknown", "a slot without a task has no start; a finished slot is not the step");
	await live(f, (state) => { state.tools = [{ callId: "call-1", name: "bash", status: "running", taskId: 999_999 as TaskId }]; });
	assert.equal(await read(), "tool bash, start unknown", "a slot whose task record is absent has no start");
	await live(f, (state) => { delete state.tools; state.compactions = [{ taskId: step.id as never, trigger: "threshold" as never, blocking: true, attempt: 2, retry: { at: EPOCH + 9000, error: "busy" } }]; });
	assert.equal(await read(), `compaction, attempt 2, ${first}, next attempt at ${new Date(EPOCH + 9000).toISOString()}`);
	await live(f, (state) => { delete state.compactions; state.run = { taskId: step.id, inputs: [], turns: 0 }; state.generation = { attempt: 3, retry: { at: EPOCH + 7000, error: "overloaded" } }; });
	assert.equal(await read(), `provider retry, attempt 3 of 4, next attempt at ${new Date(EPOCH + 7000).toISOString()}; model step ${first}`);
	await live(f, (state) => { state.generation = { attempt: 1 }; });
	assert.equal(await read(), `model step, ${first}`);
	await live(f, (state) => { delete state.generation; });
	assert.equal(await read(), `between steps; run ${first}`);
});

it("states an unknown start in the notice when the running tool has no task", async (t) => {
	const f = await open(t);
	await live(f, (state) => { state.tools = [{ callId: "call-1", name: "bash", status: "running" }]; });
	await admit(f, "stuck", "steer", "sender-a");
	advance(f, EPOCH + UNPLACED_NOTICE_MS);
	const notice = await noticeFor(f, "sender-a");
	assert.ok(notice.message.includes("Current step: tool bash, start unknown."), notice.message);
});

it("sends no notice for an input that left the inbox before the notice period ended", async (t) => {
	const f = await open(t);
	const submissionId = await admit(f, "placed-in-time", "followUp", "sender-a");
	const watch = await watchTask(f);
	await settle(f, submissionId);
	advance(f, EPOCH + UNPLACED_NOTICE_MS);
	await f.harness.waitForTask(watch, bounded());
	assert.deepEqual(await notices(f), []);
	const state = await f.harness.snapshot(UnplacedInputsDoc, f.id, BACKGROUND_CONTEXT);
	assert.deepEqual(state?.inputs, []);
	assert.equal(state?.watch, undefined, "the ended watch leaves no task reference");
});

it("sends one notice for each explicit sender with several queued inputs, and none for a later input of that sender", async (t) => {
	const f = await open(t);
	await admit(f, "a-1", "followUp", "sender-a");
	f.clock.now = EPOCH + 1000;
	await admit(f, "a-2", "steer", "sender-a");
	await admit(f, "b-1", "report", "sender-b");
	f.clock.now = EPOCH + 2000;
	await admit(f, "a-3", "operator", "sender-a");
	const watch = await watchTask(f);

	advance(f, EPOCH + UNPLACED_NOTICE_MS);
	const first = await noticeFor(f, "sender-a");
	assert.equal(first.sourceId, `unplaced:${f.id}:a-1`);
	assert.match(first.message, /did not place 3 admitted inputs from you/u, "the one notice counts every queued input of the sender");
	assert.equal((await notices(f)).length, 1, "the other sender's input is not due yet");

	advance(f, EPOCH + 1000 + UNPLACED_NOTICE_MS);
	const second = await noticeFor(f, "sender-b");
	assert.equal(second.sourceId, `unplaced:${f.id}:b-1`);
	await f.harness.waitForTask(watch, bounded());
	assert.deepEqual((await notices(f)).map((report) => report.ownerId).sort(), ["sender-a", "sender-b"]);

	await admit(f, "a-4", "followUp", "sender-a");
	const later = await watchTask(f);
	assert.notEqual(later, watch, "a new row after the watch ended starts one new watch");
	advance(f, EPOCH + 2000 + 2 * UNPLACED_NOTICE_MS);
	await f.harness.waitForTask(later, bounded());
	assert.equal((await notices(f)).filter((report) => report.ownerId === "sender-a").length, 1, "the sender has one notice for this stuck recipient");
	assert.ok((await f.harness.snapshot(UnplacedInputsDoc, f.id, BACKGROUND_CONTEXT))?.inputs.every((row) => row.noticed));
});

it("sends no notice to the producer of a result, a check-in or a timer, and a passive one to a thread notice poster", async (t) => {
	const f = await open(t);
	await admit(f, "result-1", "result", "producer-a");
	await admit(f, "check-in-1", "check-in", "producer-b");
	await admit(f, "timer-1", "timer", "producer-c");
	const watch = await watchTask(f);
	advance(f, EPOCH + UNPLACED_NOTICE_MS);
	await f.harness.waitForTask(watch, bounded());
	assert.deepEqual(await notices(f), []);
	assert.ok((await f.harness.snapshot(UnplacedInputsDoc, f.id, BACKGROUND_CONTEXT))?.inputs.every((row) => row.noticed), "an event row waits for no later notice");

	await admit(f, "thread-1", "thread-notice", "poster-a");
	await admit(f, "no-session", "operator", "");
	await admit(f, "self", "followUp", RECIPIENT);
	advance(f, EPOCH + 2 * UNPLACED_NOTICE_MS);
	const notice = await noticeFor(f, "poster-a");
	assert.equal(notice.passive, true);
	assert.deepEqual((await notices(f)).map((report) => report.ownerId), ["poster-a"], "an input without a sender session and the recipient's own input produce no row");
});

it("does not count a queued event of a sender as its notice", async (t) => {
	const f = await open(t);
	const step = await stepTask(f);
	await routedRun(f, step.id, "served", "producer-a");
	await admit(f, "result-1", "result", "producer-a");
	f.clock.now = EPOCH + 1000;
	await admit(f, "report-1", "report", "producer-a");
	f.clock.now = EPOCH + 2000;
	await admit(f, "other-1", "followUp", "sender-b");

	advance(f, EPOCH + UNPLACED_NOTICE_MS);
	assert.deepEqual(await rowsWhen(f, (rows) => rows[0]?.noticed === true), [true, false, false], "the due result is marked");
	assert.deepEqual(await notices(f), [], "the due result produces no notice");

	advance(f, EPOCH + 1000 + UNPLACED_NOTICE_MS);
	const notice = await noticeFor(f, "producer-a");
	assert.equal(notice.sourceId, `unplaced:${f.id}:report-1`, "the later explicit report produces the sender's one notice");
	assert.match(notice.message, /did not place 1 admitted input from you/u, "the count names explicit inputs only");
	assert.deepEqual((await notices(f)).map((report) => report.sourceId), [`unplaced:${f.id}:report-1`], "the sender is the requester and gets no second row");

	const requester = await open(t);
	const run = await stepTask(requester);
	await routedRun(requester, run.id, "served", "producer-a");
	await admit(requester, "result-1", "result", "producer-a");
	requester.clock.now = EPOCH + 1000;
	await admit(requester, "other-1", "steer", "sender-b");
	const watch = await watchTask(requester);
	advance(requester, EPOCH + 1000 + UNPLACED_NOTICE_MS);
	await requester.harness.waitForTask(watch, bounded());
	assert.deepEqual((await notices(requester)).map((report) => [report.ownerId, report.sourceId]).sort(), [
		["producer-a", `unplaced:${requester.id}:run:${run.id}`],
		["sender-b", `unplaced:${requester.id}:other-1`],
	], "a noticed event row does not exclude its sender from the requester notice");
});

it("sends one notice to each reply recipient of the current run's routed requests, and one only to a requester that is the sender", async (t) => {
	const f = await open(t);
	const step = await stepTask(f);
	await routedRun(f, step.id, "served", "requester-r");
	await admit(f, "stuck", "followUp", "sender-a");
	advance(f, EPOCH + UNPLACED_NOTICE_MS);
	const requester = await noticeFor(f, "requester-r");
	assert.equal(requester.sourceId, `unplaced:${f.id}:run:${step.id}`);
	assert.equal(requester.senderIdentity, RECIPIENT);
	assert.match(requester.message, /which serves your request, did not place 1 admitted input for more than 5 minutes/u);
	assert.ok(requester.message.includes(`Current step: between steps; run first started at ${new Date(step.startedAt).toISOString()}.`), requester.message);
	assert.deepEqual((await notices(f)).map((report) => report.ownerId).sort(), ["requester-r", "sender-a"]);

	const same = await open(t);
	const run = await stepTask(same);
	await routedRun(same, run.id, "served", "sender-a");
	await admit(same, "stuck", "steer", "sender-a");
	const watch = await watchTask(same);
	advance(same, EPOCH + UNPLACED_NOTICE_MS);
	await same.harness.waitForTask(watch, bounded());
	assert.deepEqual((await notices(same)).map((report) => report.sourceId), [`unplaced:${same.id}:stuck`], "a requester that is the sender gets the sender notice only");

	const event = await open(t);
	const served = await stepTask(event);
	await routedRun(event, served.id, "served", "requester-r");
	await admit(event, "result-1", "result", "producer-a");
	const eventWatch = await watchTask(event);
	advance(event, EPOCH + UNPLACED_NOTICE_MS);
	await event.harness.waitForTask(eventWatch, bounded());
	assert.deepEqual(await notices(event), [], "a queued event alone notifies nobody");
});

it("sends no second notice after the storage is opened again", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "unplaced-inputs-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "store.sqlite");
	const clock = { now: EPOCH };
	const first = await open(t, clock, await openNodeSqliteStorage(path));
	await admit(first, "stuck", "followUp", "sender-a");
	advance(first, EPOCH + UNPLACED_NOTICE_MS);
	await noticeFor(first, "sender-a");
	await first.harness.close(BACKGROUND_CONTEXT);

	clock.now = EPOCH + 2 * UNPLACED_NOTICE_MS;
	const second = await open(t, clock, await openNodeSqliteStorage(path));
	assert.deepEqual(await readUnplacedSummary(second.harness, second.id, BACKGROUND_CONTEXT), { unplaced: 1, oldestAdmittedAt: EPOCH }, "the queued row survives the reopen");
	await admit(second, "again", "followUp", "sender-a");
	const watch = await watchTask(second);
	advance(second, EPOCH + 3 * UNPLACED_NOTICE_MS);
	await second.harness.waitForTask(watch, bounded());
	assert.deepEqual((await notices(second)).map((report) => report.sourceId), [`unplaced:${second.id}:stuck`]);
});

it("notifies the reply recipient of open declared work when the current run serves no routed request", async (t) => {
	const f = await open(t);
	const step = await stepTask(f);
	// A run that a result started: it has no routed input, and the conversation holds one open work item.
	await f.harness.commit(async (tx) => {
		const entry = await tx.appendEntry(f.id, { kind: "agent.input", model: [{ role: "user", content: "earlier request", timestamp: f.clock.now }] });
		const answer = await tx.appendEntry(f.id, { kind: "pi.assistant", model: [] });
		const declared = await tx.createSubmission({ conversationId: f.id, requestId: "declared", type: "input", status: "done", entry: entry.id, answer: answer.id });
		const result = await tx.appendEntry(f.id, { kind: "agent.input", model: [{ role: "user", content: "a result", timestamp: f.clock.now }] });
		const started = await tx.createSubmission({ conversationId: f.id, requestId: "result-delivery", type: "input", status: "placed", entry: result.id });
		(await tx.doc(OpenWorkDoc, f.id)).items.push({ requestId: "declared", submissionId: declared.id, requester: "requester-w", replyTo: "requester-w", origin: "model", results: [], note: "own work remains", declaredAt: f.clock.now, updatedAt: f.clock.now });
		(await tx.doc(LiveDoc, f.id) as LiveState).run = { taskId: step.id, inputs: [started.id], turns: 0 };
	}, BACKGROUND_CONTEXT);
	await admit(f, "stuck", "followUp", "sender-a");
	advance(f, EPOCH + UNPLACED_NOTICE_MS);
	const notice = await noticeFor(f, "requester-w");
	assert.equal(notice.sourceId, `unplaced:${f.id}:run:${step.id}`);
	assert.equal(notice.passive, undefined);
	assert.match(notice.message, /which holds open declared work for your request, did not place 1 admitted input/u);
	assert.deepEqual((await notices(f)).map((report) => report.ownerId).sort(), ["requester-w", "sender-a"]);

	const closed = await open(t);
	const run = await stepTask(closed);
	await closed.harness.commit(async (tx) => {
		(await tx.doc(OpenWorkDoc, closed.id)).items.push({ requestId: "declared", submissionId: 424_242, requester: "requester-w", replyTo: "requester-w", origin: "model", results: [], note: "done", declaredAt: EPOCH, updatedAt: EPOCH, close: { status: "done", at: EPOCH, message: "done", reportRequestId: `work-final:${closed.id}:declared` } });
		(await tx.doc(LiveDoc, closed.id) as LiveState).run = { taskId: run.id, inputs: [], turns: 0 };
	}, BACKGROUND_CONTEXT);
	await admit(closed, "stuck", "followUp", "sender-a");
	const watch = await watchTask(closed);
	advance(closed, EPOCH + UNPLACED_NOTICE_MS);
	await closed.harness.waitForTask(watch, bounded());
	assert.deepEqual((await notices(closed)).map((report) => report.ownerId), ["sender-a"], "the reply recipient of closed work is not a requester");
});
