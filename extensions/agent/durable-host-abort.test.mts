import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	InboxDoc,
	LiveDoc,
	defineExtension,
	defineTask,
	type ConversationId,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import { retainedReportRequest } from "./delivery-store.ts";
import { DurableHost, stopLiveConversation } from "./durable-host.ts";
import { deferred, fixtureRegistry, fixtureRuntime, fixtureStorageId, hostOptions } from "./durable-host-fixture.mts";
import { inputEntry } from "./input-entry.ts";
import { declareOpenWork, openWorkStatus } from "./open-work.ts";
import { recordRequestContext } from "./request-context.ts";

/** A live task that owns a child conversation and ends only at an abort. */
const HoldTask = defineTask<Record<string, never>, { phase: "hold" }, null>({
	name: "fixture.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, context) => {
			await runtime.sleepUntil(Number.MAX_SAFE_INTEGER, task.state.checkpoint, context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** One placed routed input of the conversation, and its declared open work without a dependency. */
async function openItem(tx: Tx, conversationId: ConversationId, requestId: string, replyTo: string): Promise<void> {
	await recordRequestContext(tx, conversationId, { requestId, requester: replyTo, replyTo, origin: "model" });
	const entry = await tx.appendEntry(conversationId, {
		kind: "pi.user",
		...inputEntry("model", replyTo),
		model: [{ role: "user", content: "Task", timestamp: 1 }],
	});
	const submission = await tx.createSubmission({
		conversationId,
		requestId,
		type: "input",
		status: "placed",
		entry: entry.id,
	});
	(await tx.doc(LiveDoc, conversationId)).run = { taskId: 999_999 as TaskId, inputs: [submission.id], turns: 0 };
}

interface Family {
	readonly host: DurableHost;
	/** Child below a background task of the root. */
	readonly background: ConversationId;
	/** Child below an ordinary task of the root. */
	readonly ordinary: ConversationId;
	work(conversationId: ConversationId): Promise<{ state: string; status?: string; delivery?: string }>;
}

async function family(t: { after(fn: () => void | Promise<void>): void }): Promise<Family> {
	const root = mkdtempSync(join(tmpdir(), "durable-host-abort-"));
	const registry = fixtureRegistry();
	registry.install(defineExtension({ name: "fixture.hold", tasks: [HoldTask] }));
	const host = await DurableHost.open(
		hostOptions(join(root, "run.sqlite"), await fixtureRuntime("answer"), registry),
		BACKGROUND_CONTEXT,
	);
	t.after(async () => {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	});
	const rootId = host.root().id;
	const owners = await host.harness.commit(
		async (tx) => ({
			background: await tx.createTask(
				HoldTask,
				{},
				{ ownership: { kind: "conversation" }, conversationId: rootId, background: true },
			),
			ordinary: await tx.createTask(HoldTask, {}, { ownership: { kind: "conversation" }, conversationId: rootId }),
		}),
		BACKGROUND_CONTEXT,
	);
	const children = await host.harness.commit(
		async (tx) => ({
			background: (await tx.createConversation({ ownership: { kind: "task", taskId: owners.background } })).id,
			ordinary: (await tx.createConversation({ ownership: { kind: "task", taskId: owners.ordinary } })).id,
		}),
		BACKGROUND_CONTEXT,
	);
	for (const [conversationId, requestId, replyTo] of [
		[rootId, "root-task", "requester-x"],
		[children.background, "background-task", fixtureStorageId],
		[children.ordinary, "ordinary-task", fixtureStorageId],
	] as const) {
		await host.harness.commit((tx) => openItem(tx, conversationId, requestId, replyTo), BACKGROUND_CONTEXT);
		const declared = await host.harness.commit(
			(tx) => declareOpenWork(tx, fixtureStorageId, conversationId, { results: [], note: "owes a final result" }, 10),
			BACKGROUND_CONTEXT,
		);
		assert.ok(!("error" in declared), JSON.stringify(declared));
	}
	const work = async (conversationId: ConversationId) => {
		const [item] = await host.harness.commit(
			(tx) => openWorkStatus(tx, fixtureStorageId, conversationId),
			BACKGROUND_CONTEXT,
		);
		assert.ok(item);
		return {
			state: item.state,
			...(item.close === undefined ? {} : { status: item.close.status, delivery: item.close.delivery }),
		};
	};
	return { host, ...children, work };
}

it("closes the open work of each conversation that an abort stops, and keeps a report to a stopped recipient out of delivery", async (t) => {
	const ordinary = await family(t);
	await ordinary.host.request("abort", {});
	assert.deepEqual(
		await ordinary.work(ordinary.host.root().id),
		{ state: "closed", status: "stopped", delivery: "active" },
		"the target's requester outside the scope gets the report",
	);
	assert.deepEqual(
		await ordinary.work(ordinary.ordinary),
		{ state: "closed", status: "stopped", delivery: "terminal" },
		"a stopped child reports to the stopped target without an input",
	);
	assert.deepEqual(
		await ordinary.work(ordinary.background),
		{ state: "open" },
		"a child below a background task is outside an ordinary abort",
	);

	const all = await family(t);
	await all.host.request("abort", { background: true });
	assert.deepEqual(await all.work(all.host.root().id), { state: "closed", status: "stopped", delivery: "active" });
	assert.deepEqual(await all.work(all.ordinary), { state: "closed", status: "stopped", delivery: "terminal" });
	assert.deepEqual(
		await all.work(all.background),
		{ state: "closed", status: "stopped", delivery: "terminal" },
		"an abort with background also stops the child below a background task",
	);
});

it("keeps the queue withdrawal and settled work closure if native task marking does not complete", async (t) => {
	const f = await family(t);
	const { host } = f;
	const root = host.root();
	const queued = await host.harness.commit(async (tx) => {
		const input = await tx.submissionByRequest(root.id, "root-task");
		assert.ok(input?.entry);
		tx.settleSubmission(input.id, { status: "done", answer: input.entry });
		const { id } = await tx.createSubmission({ conversationId: root.id, type: "input", status: "queued" });
		(await tx.doc(InboxDoc, root.id)).items.push({ id, mode: "followUp", content: "Queued work" });
		return id;
	}, BACKGROUND_CONTEXT);
	t.mock.method(root, "abort", async () => {
		throw new Error("native mark did not commit");
	});
	await assert.rejects(
		stopLiveConversation(host.harness, fixtureStorageId, root, false, Date.now, () => {}, BACKGROUND_CONTEXT),
		/native mark did not commit/u,
	);
	assert.deepEqual(await f.work(root.id), { state: "closed", status: "stopped", delivery: "active" });
	assert.deepEqual(await f.work(f.background), { state: "open" });
	const record = await host.harness.commit((tx) => tx.submission(queued), BACKGROUND_CONTEXT);
	assert.equal(record?.status, "unanswered");
	assert.equal(record?.reason, "aborted");
});

it("closes only requests open at the stop, not work declared by a later input", async (t) => {
	const { host } = await family(t);
	const root = host.root();
	const reached = deferred();
	const release = deferred();
	const nativeAbort = root.abort.bind(root);
	t.mock.method(root, "abort", async (...args: Parameters<typeof nativeAbort>) => {
		try {
			await nativeAbort(...args);
			reached.resolve();
		} catch (error) {
			reached.reject(error);
			throw error;
		}
		await release.promise;
	});
	t.mock.method(host, "conversation", async () => root);
	const abort = host.request("abort", {});
	await reached.promise;
	try {
		await host.harness.commit((tx) => openItem(tx, root.id, "late-task", "late-requester"), BACKGROUND_CONTEXT);
		const declared = await host.harness.commit(
			(tx) =>
				declareOpenWork(tx, fixtureStorageId, root.id, { request: "late-task", results: [], note: "late work" }, 11),
			BACKGROUND_CONTEXT,
		);
		assert.ok(!("error" in declared), JSON.stringify(declared));
	} finally {
		release.resolve();
	}
	await abort;
	const work = await host.harness.commit((tx) => openWorkStatus(tx, fixtureStorageId, root.id), BACKGROUND_CONTEXT);
	assert.equal(work.find((item) => item.requestId === "root-task")?.state, "closed");
	assert.equal(work.find((item) => item.requestId === "late-task")?.state, "open");
	assert.equal(
		await host.harness.commit(
			(tx) => retainedReportRequest(tx, "late-requester", `work-final:${root.id}:late-task`),
			BACKGROUND_CONTEXT,
		),
		undefined,
	);
});
