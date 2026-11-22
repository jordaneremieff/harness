import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId, Tx } from "@earendil-works/pi-durable";
import { ContinuityDoc, recordContinuityFact } from "./continuity-native.ts";
import { OpenWorkDoc } from "./open-work.ts";
import { DurableHost } from "./durable-host.ts";
import {
	deferred,
	answerMessage,
	fixtureRegistry,
	fixtureStorageId,
	hostOptions,
	pending,
	scriptedRuntime,
} from "./durable-host-fixture.mts";
import {
	QUIET_INPUT_ENTRY_KIND,
	STOPPED_LIMIT,
	StoppedDoc,
	noteExplicitInput,
	isStopped,
	markStopped,
	quietWhileStopped,
	stopScope,
} from "./conversation-stop.ts";

/** A transaction stub that holds the stop document in memory. */
function memoryStore() {
	const state = { conversations: [] as Array<{ conversationId: number; stoppedAt: number }> };
	const tx = {
		doc: async (token: unknown) => {
			assert.equal(token, StoppedDoc);
			return state;
		},
		submission: async () => ({ status: "done" }),
		scanTasks: async (query: { conversationId: number; status?: string }, limit: number) => ({
			items: [
				...Array.from({ length: 64 }, (_, index) => ({ id: index + 100, state: { status: "terminal" } })),
				{ id: query.conversationId * 10, state: { status: "running" } },
			]
				.filter((task) => query.status === undefined || task.state.status === query.status)
				.slice(0, limit),
		}),
	} as unknown as Tx;
	return { state, store: { commit: async <T,>(change: (tx: Tx) => T | Promise<T>) => change(tx) } };
}

it("answers within its bound while a marked task ignores its abort, and names live tasks ahead of any number of ended tasks", async () => {
	const { state, store } = memoryStore();
	let aborted = false;
	const conversation = {
		id: 1 as ConversationId,
		abort: async () => {
			assert.deepEqual(
				state.conversations.map((mark) => mark.conversationId),
				[1, 2],
				"the scope is marked stopped before the abort",
			);
			aborted = true;
			return new Promise<void>(() => {});
		},
	};
	const reports: unknown[] = [];
	const started = performance.now();
	const outcome = await stopScope(store, conversation, [1, 2] as ConversationId[], true, BACKGROUND_CONTEXT, {
		now: 5,
		answerWithinMs: 30,
		openRequests: async () => [],
		report: (error) => reports.push(error),
	});
	assert.ok(aborted);
	assert.ok(performance.now() - started < 2000);
	assert.deepEqual(outcome, { settled: false, pendingTasks: [10, 20], work: new Map() });
	assert.deepEqual(reports, []);
});

it("answers settled when the scope becomes idle within the bound", async () => {
	const { store } = memoryStore();
	const outcome = await stopScope(
		store,
		{ id: 3 as ConversationId, abort: async () => {} },
		[3] as ConversationId[],
		false,
		BACKGROUND_CONTEXT,
		{ now: 1, answerWithinMs: 10_000, openRequests: async () => [], report: () => {} },
	);
	assert.deepEqual(outcome, { settled: true, work: new Map() });
});

it("keeps stop marks bounded and clears only the named conversation", async () => {
	const { state, store } = memoryStore();
	await store.commit((tx) =>
		markStopped(
			tx,
			Array.from({ length: STOPPED_LIMIT + 2 }, (_, index) => (index + 1) as ConversationId),
			7,
		),
	);
	assert.equal(state.conversations.length, STOPPED_LIMIT);
	assert.equal(await store.commit((tx) => isStopped(tx, 1 as ConversationId)), false, "the oldest mark left first");
	assert.equal(await store.commit((tx) => isStopped(tx, 5 as ConversationId)), true);
	await store.commit((tx) => noteExplicitInput(tx, 5 as ConversationId, 1 as SubmissionId));
	assert.equal(await store.commit((tx) => isStopped(tx, 5 as ConversationId)), false);
	assert.equal(await store.commit((tx) => isStopped(tx, 6 as ConversationId)), true);
});

it("keeps only automatic inputs that expect no answer quiet", () => {
	for (const inputClass of ["result", "report", "check-in", "thread-notice", "timer"] as const) {
		assert.equal(quietWhileStopped(inputClass, false), true, inputClass);
		assert.equal(quietWhileStopped(inputClass, true), false, `${inputClass} with a waiting sender runs`);
	}
	for (const inputClass of ["operator", "steer", "followUp"] as const)
		assert.equal(quietWhileStopped(inputClass, false), false, inputClass);
});

async function openHost(t: { after(fn: () => void | Promise<void>): void }, answers = 3) {
	const root = mkdtempSync(join(tmpdir(), "conversation-stop-"));
	const models = await scriptedRuntime(Array.from({ length: answers }, () => answerMessage()));
	const host = await DurableHost.open(
		hostOptions(join(root, "run.sqlite"), models, fixtureRegistry()),
		BACKGROUND_CONTEXT,
	);
	t.after(async () => {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { host, models };
}

/** Live non-background tasks of the root conversation, read without a write. */
async function liveRun(host: DurableHost): Promise<boolean> {
	const inspection = await host.harness.inspect(BACKGROUND_CONTEXT);
	return inspection.tasks.some(
		(task) =>
			task.record.conversationId === host.root().id &&
			!task.record.background &&
			task.record.state.status !== "terminal",
	);
}

async function waitIdle(host: DurableHost): Promise<void> {
	await host.root().waitForIdle(BACKGROUND_CONTEXT);
}

it("answers an abort at once while the running request's provider ignores the abort signal", async (t) => {
	const { host, models } = await openHost(t);
	let requested!: () => void;
	const started = new Promise<void>((resolve) => {
		requested = resolve;
	});
	models.streamSimple = () => {
		requested();
		return pending(answerMessage("in flight"));
	};
	await host.request("submit", { message: "Work.", requestId: "work-1", origin: "operator" });
	await started;
	const began = performance.now();
	const outcome = (await host.request("abort", {})) as { settled: boolean };
	assert.ok(performance.now() - began < 5000, "the abort does not wait for the provider");
	assert.equal(outcome.settled, true);
	assert.equal(await liveRun(host), false);
});

it("keeps automatic inputs to a stopped conversation as context until an explicit input ends the stop", async (t) => {
	const { host } = await openHost(t);
	await host.request("abort", {});
	const quiet = (await host.request("submit", {
		message: "A child's result.",
		requestId: "result-1",
		provenance: { classification: "automatic" },
	})) as { quiet?: boolean };
	assert.equal(quiet.quiet, true);
	assert.equal(await liveRun(host), false, "the result started no run");
	const entries = await host.harness.commit(
		(tx) => tx.scanEntries({ conversationId: host.root().id }, 50),
		BACKGROUND_CONTEXT,
	);
	const kept = entries.items.find((entry) => entry.kind === QUIET_INPUT_ENTRY_KIND);
	assert.ok(kept, "the result stays in the transcript as context");
	assert.deepEqual((kept.data as { reason: string }).reason, "stopped");

	await host.request("submit", { message: "Continue.", requestId: "explicit-1", origin: "operator" });
	await waitIdle(host);
	const after = (await host.request("submit", {
		message: "Another result.",
		requestId: "result-2",
		provenance: { classification: "automatic" },
	})) as { quiet?: boolean };
	assert.equal(after.quiet, undefined, "the explicit input ended the stop");
	await waitIdle(host);
});

it("keeps a delivery of state notes as context on a conversation that is not stopped", async (t) => {
	const { host } = await openHost(t);
	const reference = { sessionId: `${fixtureStorageId}:7`, submissionId: 3, requestId: "child-request" };
	const quiet = (await host.request("submit", {
		message: "A state note.",
		requestId: "state-note-1",
		provenance: { classification: "automatic" },
		deliveredResults: [reference],
		dependencyMarks: [{ ...reference, state: "state-note" }],
		stateNotesOnly: true,
	})) as { quiet?: boolean };
	assert.equal(quiet.quiet, true);
	assert.equal(await liveRun(host), false);
	const result = (await host.request("submit", {
		message: "A result.",
		requestId: "result-3",
		provenance: { classification: "automatic" },
		deliveredResults: [{ ...reference, submissionId: 4 }],
		dependencyMarks: [{ ...reference, submissionId: 4, state: "arrived" }],
	})) as { quiet?: boolean };
	assert.equal(result.quiet, undefined, "an arrived result starts a run");
	await waitIdle(host);
});

it("replays a quiet body and commits its delivered facts after the first acknowledgement fails", async (t) => {
	const { host } = await openHost(t);
	await host.request("abort", {});
	const ref = { sessionId: `${fixtureStorageId}:7`, submissionId: 3, requestId: "outgoing" };
	await host.harness.commit(
		(tx) =>
			recordContinuityFact(tx, host.root().id, {
				...ref,
				replyTo: fixtureStorageId,
				phase: "admitted",
			}),
		BACKGROUND_CONTEXT,
	);
	const delivery = {
		message: "Result already delivered as context.",
		requestId: "receipt-replay",
		provenance: { classification: "automatic" },
		deliveredResults: [ref],
		dependencyMarks: [{ ...ref, state: "arrived" }],
	};
	// Refuse the first facts commit after the body commit, as when the caller loses its connection.
	const commit = host.harness.commit.bind(host.harness) as typeof host.harness.commit;
	let refuse = true;
	t.mock.method(
		host.harness,
		"commit",
		async (change: Parameters<typeof commit>[0], context: Parameters<typeof commit>[1]) =>
			commit(async (tx) => {
				const apply = await change(tx);
				const state = await tx.doc(ContinuityDoc, host.root().id);
				if (refuse && state.events.some((event) => event.phase === "delivered")) {
					refuse = false;
					throw new Error("lost acknowledgement");
				}
				return apply;
			}, context),
	);
	await assert.rejects(host.request("submit", delivery), /lost acknowledgement/u);
	const original = await commit((tx) => tx.submissionByRequest(host.root().id, delivery.requestId), BACKGROUND_CONTEXT);
	assert.equal(original?.type, "write");
	assert.equal((await host.harness.snapshot(OpenWorkDoc, host.root().id, BACKGROUND_CONTEXT))?.arrivals, undefined);
	const replay = (await host.request("submit", delivery)) as { submissionId: number; quiet: boolean; deduped: boolean };
	assert.equal(replay.submissionId, original.id);
	assert.equal(replay.quiet, true);
	assert.equal(replay.deduped, true);
	assert.ok(
		(await host.harness.snapshot(ContinuityDoc, host.root().id, BACKGROUND_CONTEXT))?.events.some(
			(event) => event.phase === "delivered",
		),
	);
	assert.deepEqual(
		(await host.harness.snapshot(OpenWorkDoc, host.root().id, BACKGROUND_CONTEXT))?.arrivals,
		delivery.dependencyMarks,
	);
	assert.equal(await liveRun(host), false);
});

it("keeps the stop if an in-flight abort withdraws the explicit input", async (t) => {
	const { host, models } = await openHost(t);
	const started = deferred();
	models.streamSimple = () => {
		started.resolve();
		return pending(answerMessage("in flight"));
	};
	await host.request("submit", { message: "Before the stop", requestId: "before", origin: "operator" });
	await started.promise;
	const conversation = host.root();
	// Expose the boundary between Agent's stop mark and the native abort commit.
	await host.harness.commit((tx) => markStopped(tx, [conversation.id], 1), BACKGROUND_CONTEXT);
	const explicit = await host.request("submit", { message: "In the gap", requestId: "gap", origin: "operator" });
	assert.equal((explicit as { placement: string }).placement, "unplaced");
	const automatic = { message: "Result", provenance: { classification: "automatic" } };
	const during = (await host.request("submit", { ...automatic, requestId: "during" })) as { quiet?: boolean };
	assert.equal(during.quiet, undefined, "the explicit input temporarily permits wakes");
	await conversation.abort(BACKGROUND_CONTEXT);
	assert.deepEqual(
		await host.harness.commit(async (tx) => {
			const record = await tx.submissionByRequest(conversation.id, "gap");
			return [record?.status, record?.reason];
		}, BACKGROUND_CONTEXT),
		["unanswered", "aborted"],
	);
	const later = (await host.request("submit", { ...automatic, requestId: "later" })) as { quiet?: boolean };
	assert.equal(later.quiet, true, "the withdrawn input does not end the stop");
});

it("allows an automatic result while an explicit input runs after the stop", async (t) => {
	const { host, models } = await openHost(t);
	await host.request("abort", {});
	const started = deferred();
	models.streamSimple = () => {
		started.resolve();
		return pending(answerMessage("in flight"));
	};
	await host.request("submit", { message: "Continue", requestId: "resume", origin: "operator" });
	await started.promise;
	const result = (await host.request("submit", {
		message: "Result while running",
		requestId: "while-running",
		provenance: { classification: "automatic" },
	})) as { quiet?: boolean; placement: string };
	assert.equal(result.quiet, undefined);
	assert.equal(result.placement, "unplaced");
	await host.root().abort(BACKGROUND_CONTEXT);
});

it("starts a run for an unanswered receipt even when its dependency mark is a state note", async (t) => {
	const { host } = await openHost(t);
	const ref = { sessionId: `${fixtureStorageId}:7`, submissionId: 3, requestId: "closed-work" };
	const result = (await host.request("submit", {
		message: "The input ended without an answer. Its declared work closed.",
		requestId: "closed-work-receipt",
		provenance: { classification: "automatic" },
		deliveredResults: [ref],
		dependencyMarks: [{ ...ref, state: "state-note" }],
	})) as { quiet?: boolean; submissionId: SubmissionId };
	assert.equal(result.quiet, undefined);
	assert.equal((await host.wait(result.submissionId, BACKGROUND_CONTEXT)).status, "done");
});
