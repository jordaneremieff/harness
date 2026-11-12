/**
 * Placement of every native input class: an input admitted while the recipient
 * runs a tool round waits in the inbox, and the boundary after that round
 * places it before the next model request. One table drives the rows over a
 * real host with SQLite storage, a scripted provider and a clock that the test
 * moves.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { GenerationTask, LiveDoc, ROOT_CONVERSATION_ID, createRegistry, defineExtension, defineTool, hook, type ConversationId, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { onStoredCommit } from "./commit-observation.ts";
import { deliveryState } from "./delivery-store.ts";
import { CheckInDeadlineTask, CheckInTask } from "./durable-checkins.ts";
import { reconcileDeliveries, recordDeliveryIntent, settleDeliveries } from "./durable-controls.ts";
import { answerMessage, completed } from "./durable-host-fixture.mts";
import { DurableHost } from "./durable-host.ts";
import { AgentTimerDoc, TimerTask } from "./durable-timers.ts";
import { INPUT_CLASSES, type InputClass } from "./input-entry.ts";
import { requestContextHooks, requestContextSection } from "./request-context.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { UnplacedInputsDoc, UnplacedWatchTask, readUnplacedSummary } from "./unplaced-inputs.ts";

type Gate = { readonly started: Promise<void>; open(): void };
type Admitted = { readonly submissionId: SubmissionId; readonly placement?: string };
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Row = {
	readonly class: InputClass;
	/** True when the admission retains a request route, so the note names a reply recipient. */
	readonly routed: boolean;
	/** False for the native operator entry kind, which has no entry data. */
	readonly entryData: boolean;
	/** False when the sender receives no admission result: a timer fires inside its task. */
	readonly receipt: boolean;
	sender(f: Fixture): string;
	admit(f: Fixture, sessionId: string, conversationId: ConversationId, requestId: string, text: string): Promise<Admitted>;
};

function textOf(message: Message): string {
	if (message.role !== "user") return "";
	return typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

function toolCalls(...names: string[]): AssistantMessage {
	return { ...answerMessage(), content: names.map((name) => ({ type: "toolCall" as const, id: `gate-${name}`, name: "gate", arguments: { name } })), stopReason: "toolUse" };
}

/**
 * The scripted provider. A conversation whose first input starts with BUSY runs
 * gate `g1`, then gate `g2`, then answers; BUSY-PARALLEL runs gates `a` and `b`
 * in one round, then answers. Every other conversation answers at once.
 */
function respond(messages: readonly Message[]): AssistantMessage {
	const first = messages.map(textOf).find((text) => text !== "") ?? "";
	const steps = messages.filter((message) => message.role === "assistant").length;
	if (first.startsWith("BUSY-PARALLEL")) return steps === 0 ? toolCalls("a", "b") : answerMessage("FINAL");
	if (first.startsWith("BUSY")) return steps === 0 ? toolCalls("g1") : steps === 1 ? toolCalls("g2") : answerMessage("FINAL");
	return answerMessage("STATE: the work continues in the background");
}

async function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "input-placement-"));
	const storageId = randomUUID();
	let clock = Date.parse("2026-01-01T00:00:00Z");
	const requests: Message[][] = [];
	const models = await createTestRuntime();
	const stream = (_model: unknown, input: { messages: Message[] }) => {
		requests.push(input.messages);
		return completed(respond(input.messages));
	};
	models.registerNativeProvider({ id: testModel.provider, name: "Input placement fixture", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	const gates = new Map<string, Gate & { start(): void; readonly released: Promise<void> }>();
	const gate = (name: string) => {
		let found = gates.get(name);
		if (found === undefined) {
			let start!: () => void, open!: () => void;
			const started = new Promise<void>((resolve) => { start = resolve; });
			const released = new Promise<void>((resolve) => { open = resolve; });
			found = { started, released, start, open };
			gates.set(name, found);
		}
		return found;
	};
	const tool = defineTool({ name: "gate", description: "Wait until the test opens the named gate.", parameters: obj({}, { open: true }), execute: async (args, _api, ctx) => {
		const held = gate(String((args as { name?: unknown }).name));
		held.start();
		await new Promise<void>((resolve) => {
			void held.released.then(resolve);
			if (ctx.abortSignal?.aborted) resolve();
			else ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return {};
	} });
	const registry = createRegistry();
	let host!: DurableHost;
	registry.install(defineExtension({ name: "input-placement", tools: [tool], tasks: [TimerTask, CheckInTask, CheckInDeadlineTask, UnplacedWatchTask], sections: [requestContextSection(() => host.harness)], hooks: [hook(GenerationTask, requestContextHooks(() => host.harness))] }));
	// The native host's services pass the same fixed steering mode.
	host = await DurableHost.open({ storagePath: join(dir, "store.sqlite"), storageId, cwd: dir, models, registry, settings: { steeringMode: "all" }, agent: { model: { provider: testModel.provider, modelId: testModel.id } }, now: () => clock }, context);
	t.after(async () => {
		for (const held of gates.values()) held.open();
		await host.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const harness: Harness = host.harness;
	/** Resolve once `read` returns a value; each stored commit runs it again. */
	const until = async <T,>(read: () => Promise<T | undefined>): Promise<T> => {
		for (;;) {
			let wake!: () => void;
			const stored = new Promise<void>((resolve) => { wake = resolve; });
			const detach = onStoredCommit(harness, () => wake());
			try {
				const value = await read();
				if (value !== undefined) return value;
				await stored;
			} finally { detach(); }
		}
	};
	const status = async (id: SubmissionId) => (await (await harness.submission(id, context))?.status(context));
	return {
		host, harness, storageId, requests, until, status,
		gate: (name: string): Gate => gate(name),
		/** Identities of other sessions: a requester with a reply route and a peer that sends events. */
		requester: randomUUID(), peer: `${randomUUID()}:7`,
		advance(ms: number) { clock += ms; harness.resume(); },
		now: () => clock,
		async idleConversation(): Promise<{ sessionId: string; conversationId: ConversationId }> {
			const created = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: testModel.provider, modelId: testModel.id } } }, context);
			return { sessionId: host.identity(created.id), conversationId: created.id };
		},
		/** Requests of the conversation whose first input starts with `prefix`. */
		requestsOf(prefix: string): Message[][] {
			return requests.filter((messages) => (messages.map(textOf).find((text) => text !== "") ?? "").startsWith(prefix));
		},
		async unplaced(conversationId: ConversationId, requestId: string) {
			return (await harness.snapshot(UnplacedInputsDoc, conversationId, context))?.inputs.find((input) => input.requestId === requestId);
		},
		async taskSubmit(sessionId: string, requestId: string, text: string, origin: "operator" | "model", whenBusy: "steer" | "followUp", requester: string): Promise<Admitted> {
			return await host.request("task-submit", { sessionId, message: text, requestId, requester, origin, whenBusy }) as Admitted;
		},
		/** The submit request of an automatic delivery, with its communication envelope and provenance. */
		async deliver(sessionId: string, requestId: string, text: string, envelope: { kind: string; metadata: Record<string, unknown> }, provenance: Record<string, unknown>, whenBusy: "steer" | "followUp", sender: string): Promise<Admitted> {
			const communication = { format: "agent.communication/1", kind: envelope.kind, sender: { identity: sender }, body: { text, complete: true, redacted: false }, recordedAt: clock, metadata: envelope.metadata };
			return await host.request("submit", { sessionId, message: text, requestId, communication, provenance, whenBusy }) as Admitted;
		},
	};
}

/** The route note of one request in a model request, with the index of its message. */
function routeNote(messages: readonly Message[], requestId: string): { index: number; note: Record<string, unknown> } | undefined {
	for (let index = 0; index < messages.length; index++) {
		const text = textOf(messages[index]);
		if (!text.startsWith("<agent-request-route ")) continue;
		const note = JSON.parse(text.split("\n")[1]) as Record<string, unknown>;
		if (note.requestId === requestId) return { index, note };
	}
	return undefined;
}

const ROWS: readonly Row[] = [
	{ class: "operator", routed: true, entryData: false, receipt: true, sender: (f) => f.requester, admit: (f, sessionId, _id, requestId, text) => f.taskSubmit(sessionId, requestId, text, "operator", "followUp", f.requester) },
	{ class: "steer", routed: true, entryData: true, receipt: true, sender: (f) => f.requester, admit: (f, sessionId, _id, requestId, text) => f.taskSubmit(sessionId, requestId, text, "model", "steer", f.requester) },
	{ class: "followUp", routed: true, entryData: true, receipt: true, sender: (f) => f.requester, admit: (f, sessionId, _id, requestId, text) => f.taskSubmit(sessionId, requestId, text, "model", "followUp", f.requester) },
	{ class: "report", routed: false, entryData: true, receipt: true, sender: (f) => f.peer, admit: (f, sessionId, _id, requestId, text) => f.deliver(sessionId, requestId, text, { kind: "report", metadata: { sourceId: requestId, requestId } }, { classification: "report", sender: f.peer }, "followUp", f.peer) },
	{ class: "result", routed: false, entryData: true, receipt: true, sender: (f) => f.peer, admit: (f, sessionId, _id, requestId, text) => f.deliver(sessionId, requestId, text, { kind: "result", metadata: { status: "done", references: [{ submissionId: 9, requestId: "produced" }], omittedReferences: 0 } }, { classification: "automatic" }, "followUp", f.peer) },
	{ class: "check-in", routed: false, entryData: true, receipt: true, sender: (f) => f.peer, admit: (f, sessionId, _id, requestId, text) => f.deliver(sessionId, requestId, text, { kind: "check-in", metadata: { sourceId: requestId, producerRequestId: "produced", elapsedMs: 60_000, origin: "model" } }, { classification: "automatic", automaticKind: "checkIn", sender: f.peer, producerRequestId: "produced" }, "followUp", f.peer) },
	{
		class: "timer", routed: true, entryData: true, receipt: false, sender: (f) => f.requester,
		admit: async (f, sessionId, _id, requestId, text) => {
			await f.host.request("timer-schedule", { sessionId, message: text, deliverAt: f.now() + 60_000, mode: "followUp", origin: "model", ownerId: f.requester, scheduleId: `schedule-${requestId}`, requestId });
			f.advance(60_000);
			const submissionId = await f.until(async () => (await f.harness.snapshot(AgentTimerDoc, context))?.timers.find((timer) => timer.requestId === requestId && timer.status === "fired")?.submissionId ?? undefined);
			return { submissionId: submissionId as SubmissionId };
		},
	},
	{ class: "thread-notice", routed: false, entryData: true, receipt: true, sender: (f) => f.peer, admit: (f, sessionId, _id, requestId, text) => f.deliver(sessionId, requestId, text, { kind: "notice", metadata: { threadId: "thread-1", passive: false } }, { classification: "report", sender: f.peer }, "steer", f.peer) },
];

it("the table has one row for each input class", () => {
	assert.deepEqual(ROWS.map((row) => row.class), [...INPUT_CLASSES]);
});

/** Start the busy run of the root conversation and return once its first gated tool runs. */
async function startBusy(f: Fixture, first = "BUSY start"): Promise<SubmissionId> {
	const started = await f.taskSubmit(f.storageId, "busy-start", first, "model", "followUp", f.requester);
	return started.submissionId;
}

/** Entry kind and data of one placed input. */
async function placedEntry(f: Fixture, id: SubmissionId) {
	const record = await f.status(id);
	assert.ok(record?.entry !== undefined, "a placed input has its entry");
	const placed = record.entry;
	const entry = await f.harness.commit((tx) => tx.entry(placed), context);
	assert.ok(entry);
	return entry;
}

for (const row of ROWS) it(`${row.class}: an idle recipient starts a run; a busy recipient gets the input at the boundary after its tool round`, { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	const sender = row.sender(f);

	const idle = await f.idleConversation();
	const idleText = `IDLE ${row.class} input`;
	const woke = await row.admit(f, idle.sessionId, idle.conversationId, `${row.class}-idle`, idleText);
	assert.equal((await (await f.harness.submission(woke.submissionId, context))?.wait(context))?.status, "done", "the idle recipient ran the input");
	assert.equal(f.requestsOf(idleText).length, 1, "one model request answered the idle input");

	const requestId = `${row.class}-busy`, text = `PLACED ${row.class} input`;
	const start = await startBusy(f);
	await f.gate("g1").started;
	const admitted = await row.admit(f, f.storageId, ROOT_CONVERSATION_ID, requestId, text);
	if (row.receipt) assert.equal(admitted.placement, "unplaced", "the receipt says that the input waits");
	else assert.equal(admitted.placement, undefined);
	const waiting = await f.until(() => f.unplaced(ROOT_CONVERSATION_ID, requestId));
	assert.deepEqual({ class: waiting.class, sender: waiting.sender, submissionId: waiting.submissionId }, { class: row.class, sender, submissionId: admitted.submissionId });
	assert.equal((await f.status(admitted.submissionId))?.status, "queued");
	assert.equal(f.requestsOf("BUSY").length, 1, "nothing reaches the model while the tool runs");

	f.gate("g1").open();
	await f.gate("g2").started;
	assert.equal((await f.status(admitted.submissionId))?.status, "placed", "the boundary after the tool round placed the input");
	assert.equal((await f.status(start))?.status, "placed", "the run has not ended");
	assert.deepEqual(await readUnplacedSummary(f.harness, ROOT_CONVERSATION_ID, context), { unplaced: 0 });
	const busy = f.requestsOf("BUSY");
	assert.equal(busy.length, 2);
	const index = busy[1].findIndex((message) => textOf(message).includes(text));
	assert.ok(index > 0, "the next model request holds the placed input");
	const found = routeNote(busy[1], requestId);
	assert.ok(found, "the placed input has its note");
	assert.equal(found.index, index + 1, "the note follows its input");
	assert.deepEqual(found.note, row.routed
		? { requestId, requester: f.requester, replyTo: f.requester, origin: row.class === "operator" ? "operator" : "model", class: row.class, sender }
		: { requestId, class: row.class, sender });

	const entry = await placedEntry(f, admitted.submissionId);
	if (row.entryData) {
		assert.equal(entry.kind, "agent.input");
		const data = entry.data as { class?: unknown; sender?: unknown; requestId?: unknown };
		assert.deepEqual({ class: data.class, sender: data.sender, requestId: data.requestId }, { class: row.class, sender, requestId });
	} else {
		assert.equal(entry.kind, "pi.user");
		assert.equal(entry.data, undefined);
	}

	f.gate("g2").open();
	assert.equal((await (await f.harness.submission(admitted.submissionId, context))?.wait(context))?.status, "done");
	assert.equal(f.requestsOf("BUSY").length, 3, "one run served the start input and the placed input");
});

it("all classes queued in one tool round are placed at its boundary in admission order", { timeout: 120_000 }, async (t) => {
	const f = await fixture(t);
	await startBusy(f);
	await f.gate("g1").started;
	const admitted: { row: Row; requestId: string; text: string; submissionId: SubmissionId }[] = [];
	for (const row of ROWS) {
		const requestId = `${row.class}-together`, text = `TOGETHER ${row.class} input`;
		const result = await row.admit(f, f.storageId, ROOT_CONVERSATION_ID, requestId, text);
		await f.until(() => f.unplaced(ROOT_CONVERSATION_ID, requestId));
		admitted.push({ row, requestId, text, submissionId: result.submissionId });
	}
	assert.equal((await readUnplacedSummary(f.harness, ROOT_CONVERSATION_ID, context)).unplaced, ROWS.length);
	assert.equal(f.requestsOf("BUSY").length, 1);

	f.gate("g1").open();
	await f.gate("g2").started;
	for (const item of admitted) assert.equal((await f.status(item.submissionId))?.status, "placed", `${item.row.class} is placed`);
	assert.deepEqual(await readUnplacedSummary(f.harness, ROOT_CONVERSATION_ID, context), { unplaced: 0 }, "no input stays queued");
	const request = f.requestsOf("BUSY")[1];
	const positions = admitted.map((item) => request.findIndex((message) => textOf(message).includes(item.text)));
	assert.ok(positions.every((position) => position > 0), "the next model request holds every input");
	assert.deepEqual(positions, [...positions].sort((left, right) => left - right), "the inputs keep their admission order");
	const entries: number[] = [];
	for (const item of admitted) entries.push((await placedEntry(f, item.submissionId)).id);
	assert.deepEqual(entries, [...entries].sort((left, right) => left - right), "the entries keep their admission order");
	for (const item of admitted) assert.equal(routeNote(request, item.requestId)?.note.class, item.row.class);
	f.gate("g2").open();
	for (const item of admitted) assert.equal((await (await f.harness.submission(item.submissionId, context))?.wait(context))?.status, "done");
});

it("two gated tools of one round place nothing until both end", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	await startBusy(f, "BUSY-PARALLEL start");
	await f.gate("a").started;
	const admitted = await f.taskSubmit(f.storageId, "between-tools", "BETWEEN the two tools", "model", "steer", f.requester);
	assert.equal(admitted.placement, "unplaced");

	f.gate("a").open();
	await f.until(async () => {
		const slot = (await f.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.tools?.find((tool) => tool.callId === "gate-a");
		return slot !== undefined && slot.status !== "running" ? slot : undefined;
	});
	await f.gate("b").started;
	assert.equal((await f.status(admitted.submissionId))?.status, "queued", "the end of the first tool places nothing");
	assert.equal(f.requestsOf("BUSY-PARALLEL").length, 1);

	f.gate("b").open();
	assert.equal((await (await f.harness.submission(admitted.submissionId, context))?.wait(context))?.status, "done");
	const requests = f.requestsOf("BUSY-PARALLEL");
	assert.equal(requests.length, 2, "the round's boundary placed the input before the next model request");
	assert.ok(requests[1].some((message) => textOf(message).includes("BETWEEN the two tools")));
});

it("an admission that a replay completes records its queued input", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	await startBusy(f);
	await f.gate("g1").started;
	// An admission that stopped after its intent commit: the retained intent has no submission.
	const request = { requestId: "replayed", requester: f.requester, replyTo: f.requester, origin: "model" as const };
	await f.harness.commit((tx) => recordDeliveryIntent(tx, ROOT_CONVERSATION_ID, { requestId: request.requestId, ownerId: request.replyTo, message: "REPLAYED input", whenBusy: "followUp", origin: request.origin, requestContext: request }, f.now()), context);
	assert.equal(await f.unplaced(ROOT_CONVERSATION_ID, "replayed"), undefined);
	await reconcileDeliveries(f.harness, context, f.now);
	const waiting = await f.unplaced(ROOT_CONVERSATION_ID, "replayed");
	assert.deepEqual({ class: waiting?.class, sender: waiting?.sender, admittedAt: waiting?.admittedAt, noticed: waiting?.noticed }, { class: "followUp", sender: f.requester, admittedAt: f.now(), noticed: false });
	assert.deepEqual(await readUnplacedSummary(f.harness, ROOT_CONVERSATION_ID, context), { unplaced: 1, oldestAdmittedAt: f.now() });
	assert.equal((await f.harness.snapshot(UnplacedInputsDoc, ROOT_CONVERSATION_ID, context))?.recipient, f.storageId, "the record names the recipient by its external identity");
	assert.ok(waiting);
	const submissionId = waiting.submissionId as SubmissionId;
	assert.equal((await f.status(submissionId))?.status, "queued");

	f.gate("g1").open();
	await f.gate("g2").started;
	assert.equal((await f.status(submissionId))?.status, "placed");
	assert.deepEqual(await readUnplacedSummary(f.harness, ROOT_CONVERSATION_ID, context), { unplaced: 0 });
	assert.ok(f.requestsOf("BUSY")[1].some((message) => textOf(message).includes("REPLAYED input")));
	f.gate("g2").open();
	assert.equal((await (await f.harness.submission(submissionId, context))?.wait(context))?.status, "done");
});

it("a run that a worker result starts ends with a state note and sends its requester nothing", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	const worker = await f.idleConversation();
	// The requester's task ends with a state note: its receipt carries that note.
	const task = await f.taskSubmit(worker.sessionId, "delegated-task", "DELEGATE the work and continue later", "model", "followUp", f.requester);
	assert.equal((await (await f.harness.submission(task.submissionId, context))?.wait(context))?.status, "done");
	// A worker result reaches the idle conversation and starts a run that ends with another state note.
	const result = ROWS.find((row) => row.class === "result");
	assert.ok(result);
	const arrived = await result.admit(f, worker.sessionId, worker.conversationId, "worker-result", "RESULT of the delegated work");
	assert.equal((await (await f.harness.submission(arrived.submissionId, context))?.wait(context))?.status, "done");
	assert.equal(f.requestsOf("DELEGATE").length, 2, "the result started a second run");
	await settleDeliveries(f.harness, context);
	const state = await deliveryState(f.harness, context, true);
	const receipts = Object.values(state.receipts);
	assert.deepEqual(receipts.map((receipt) => ({ submissionId: receipt.submissionId, ownerId: receipt.ownerId, status: receipt.status })), [{ submissionId: task.submissionId, ownerId: f.requester, status: "done" }], "the requester holds the receipt of its own task only");
	assert.match(receipts[0].answer ?? "", /^STATE:/u);
	assert.deepEqual(state.reports, [], "the run that the result started sends no report");
});
