import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, defineExtension, defineTask, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureRuntime, fixtureStorageId, hostOptions } from "./durable-host-fixture.mts";
import { inputEntry } from "./input-entry.ts";
import { declareOpenWork, openWorkStatus } from "./open-work.ts";
import { recordRequestContext } from "./request-context.ts";

/** A live task that owns a child conversation and ends only at an abort. */
const HoldTask = defineTask<Record<string, never>, { phase: "hold" }, null>({
	name: "fixture.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: { hold: async (task, runtime, context) => { await runtime.sleepUntil(Number.MAX_SAFE_INTEGER, task.state.checkpoint, context); } },
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** One placed routed input of the conversation, and its declared open work without a dependency. */
async function openItem(tx: Tx, conversationId: ConversationId, requestId: string, replyTo: string): Promise<void> {
	await recordRequestContext(tx, conversationId, { requestId, requester: replyTo, replyTo, origin: "model" });
	const entry = await tx.appendEntry(conversationId, { kind: "pi.user", ...inputEntry("model", replyTo), model: [{ role: "user", content: "Task", timestamp: 1 }] });
	const submission = await tx.createSubmission({ conversationId, requestId, type: "input", status: "placed", entry: entry.id });
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
	const host = await DurableHost.open(hostOptions(join(root, "run.sqlite"), await fixtureRuntime("answer"), registry), BACKGROUND_CONTEXT);
	t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
	const rootId = host.root().id;
	const owners = await host.harness.commit(async (tx) => ({
		background: await tx.createTask(HoldTask, {}, { ownership: { kind: "conversation" }, conversationId: rootId, background: true }),
		ordinary: await tx.createTask(HoldTask, {}, { ownership: { kind: "conversation" }, conversationId: rootId }),
	}), BACKGROUND_CONTEXT);
	const children = await host.harness.commit(async (tx) => ({
		background: (await tx.createConversation({ ownership: { kind: "task", taskId: owners.background } })).id,
		ordinary: (await tx.createConversation({ ownership: { kind: "task", taskId: owners.ordinary } })).id,
	}), BACKGROUND_CONTEXT);
	for (const [conversationId, requestId, replyTo] of [[rootId, "root-task", "requester-x"], [children.background, "background-task", fixtureStorageId], [children.ordinary, "ordinary-task", fixtureStorageId]] as const) {
		await host.harness.commit((tx) => openItem(tx, conversationId, requestId, replyTo), BACKGROUND_CONTEXT);
		const declared = await host.harness.commit((tx) => declareOpenWork(tx, fixtureStorageId, conversationId, { results: [], note: "owes a final result" }, 10), BACKGROUND_CONTEXT);
		assert.ok(!("error" in declared), JSON.stringify(declared));
	}
	const work = async (conversationId: ConversationId) => {
		const [item] = await host.harness.commit((tx) => openWorkStatus(tx, fixtureStorageId, conversationId), BACKGROUND_CONTEXT);
		assert.ok(item);
		return { state: item.state, ...(item.close === undefined ? {} : { status: item.close.status, delivery: item.close.delivery }) };
	};
	return { host, ...children, work };
}

it("closes the open work of each conversation that an abort stops, and keeps a report to a stopped recipient out of delivery", async (t) => {
	const ordinary = await family(t);
	await ordinary.host.request("abort", {});
	assert.deepEqual(await ordinary.work(ordinary.host.root().id), { state: "closed", status: "stopped", delivery: "active" }, "the target's requester outside the scope gets the report");
	assert.deepEqual(await ordinary.work(ordinary.ordinary), { state: "closed", status: "stopped", delivery: "terminal" }, "a stopped child reports to the stopped target without an input");
	assert.deepEqual(await ordinary.work(ordinary.background), { state: "open" }, "a child below a background task is outside an ordinary abort");

	const all = await family(t);
	await all.host.request("abort", { background: true });
	assert.deepEqual(await all.work(all.host.root().id), { state: "closed", status: "stopped", delivery: "active" });
	assert.deepEqual(await all.work(all.ordinary), { state: "closed", status: "stopped", delivery: "terminal" });
	assert.deepEqual(await all.work(all.background), { state: "closed", status: "stopped", delivery: "terminal" }, "an abort with background also stops the child below a background task");
});
