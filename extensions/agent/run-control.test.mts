import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type ConversationId, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureRegistry, fixtureStorageId, gateTool, hostOptions, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import type { RunScope, RunStop } from "./run-control.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function inputEntry(tx: Tx, conversationId: ConversationId, requestId: string) {
	const record = await tx.submissionByRequest(conversationId, requestId);
	assert.ok(record?.entry);
	return record.entry;
}
async function fixture(t: { after(fn: () => Promise<void> | void): void }) {
	const root = mkdtempSync(join(tmpdir(), "agent-run-control-"));
	const started = deferred(), release = deferred();
	const host = await DurableHost.open(hostOptions(join(root, "session.sqlite"), await scriptedRuntime([toolCallMessage("gate"), answerMessage("next answer"), answerMessage("later answer")]), fixtureRegistry([gateTool(release.promise, started.resolve)])), BACKGROUND_CONTEXT);
	t.after(async () => { release.resolve(); await host.close(); rmSync(root, { recursive: true, force: true }); });
	const input = await host.submit({ message: "work", requestId: "original" });
	await started.promise;
	return { host, input, release };
}

test("selected native run stops its grouped inputs without withdrawing unrelated queued work", { timeout: 10000 }, async t => {
	const { host, input } = await fixture(t);
	const scope = await host.request("run-scope") as RunScope;
	assert.ok(scope.runId);
	const grouped = await host.harness.commit(async tx => {
		const live = await tx.doc(LiveDoc, host.root().id); assert.ok(live.run);
		const record = await tx.createSubmission({ conversationId: host.root().id, type: "input", status: "placed", entry: await inputEntry(tx, host.root().id, "original"), requestId: "grouped" });
		live.run.inputs.push(record.id);
		return record.id;
	}, BACKGROUND_CONTEXT);
	const queued = await host.submit({ message: "next work", requestId: "next", whenBusy: "followUp" });
	const actual = await host.request("run-scope") as RunScope;
	assert.deepEqual(actual.inputs.map(item => item.submissionId), [input.submissionId, grouped]);
	const stopped = await host.request("run-stop", { runId: scope.runId }) as RunStop;
	assert.equal(stopped.state, "stopped");
	assert.equal((await host.wait(input.submissionId)).status, "unanswered");
	assert.equal((await host.wait(grouped)).status, "unanswered");
	const pending = await host.harness.submission(queued.submissionId as SubmissionId, BACKGROUND_CONTEXT); assert.ok(pending);
	assert.equal((await pending.status(BACKGROUND_CONTEXT)).status, "queued");
	assert.equal((await host.request("run-stop", { runId: scope.runId }) as RunStop).state, "settled");
});

test("guarded reused run stays intact when an unrelated input shares it", async t => {
	const { host, input } = await fixture(t);
	const scope = await host.request("run-scope") as RunScope;
	const stopped = await host.request("run-stop", { runId: scope.runId, inputs: [{ sessionId: fixtureStorageId, submissionId: input.submissionId + 1 }] }) as RunStop;
	assert.equal(stopped.state, "protected");
	const live = await host.harness.snapshot(LiveDoc, host.root().id, BACKGROUND_CONTEXT);
	assert.equal(live?.run?.taskId, scope.taskId);
	assert.equal((await host.harness.getTask(scope.taskId as TaskId, BACKGROUND_CONTEXT))?.abortRequested, false);
});

test("exact cancellation withdraws only the selected queued submission and rejects wrong request identity", async t => {
	const { host, input } = await fixture(t);
	const first = await host.submit({ message: "one", requestId: "queue-one", whenBusy: "followUp" });
	const second = await host.submit({ message: "two", requestId: "queue-two", whenBusy: "followUp" });
	await assert.rejects(host.request("request-cancel", { result: { sessionId: fixtureStorageId, submissionId: first.submissionId, requestId: "wrong" } }));
	assert.equal((await host.request("request-cancel", { result: { sessionId: fixtureStorageId, submissionId: first.submissionId, requestId: "queue-one" } }) as { state: string }).state, "aborted");
	const pending = await host.harness.submission(second.submissionId as SubmissionId, BACKGROUND_CONTEXT); assert.ok(pending);
	assert.equal((await pending.status(BACKGROUND_CONTEXT)).status, "queued");
	assert.equal((await host.request("request-cancel", { result: { sessionId: fixtureStorageId, submissionId: input.submissionId } }) as { state: string }).state, "already_placed");
});

test("guarded stop refuses an unrelated input placed immediately before its native abort mark", async t => {
	const { host, input } = await fixture(t);
	const scope = await host.request("run-scope") as RunScope;
	const abort = host.harness.abortTask.bind(host.harness);
	host.harness.abortTask = async (id, context) => {
		await host.harness.commit(async tx => {
			const live = await tx.doc(LiveDoc, host.root().id); assert.ok(live.run);
			const record = await tx.createSubmission({ conversationId: host.root().id, type: "input", status: "placed", entry: await inputEntry(tx, host.root().id, "original"), requestId: "racing-input" });
			live.run.inputs.push(record.id);
		}, BACKGROUND_CONTEXT);
		return abort(id, context);
	};
	const stopped = await host.request("run-stop", { runId: scope.runId, inputs: [{ sessionId: fixtureStorageId, submissionId: input.submissionId }] }) as RunStop;
	host.harness.abortTask = abort;
	assert.equal(stopped.state, "protected");
	assert.equal((await host.harness.getTask(scope.taskId as TaskId, BACKGROUND_CONTEXT))?.abortRequested, false);
});

test("queued cancellation reports partial effects when native placement wins the abort race", async t => {
	const { host } = await fixture(t);
	const queued = await host.submit({ message: "race", requestId: "race", whenBusy: "followUp" });
	const abort = host.harness.abortSubmission.bind(host.harness);
	host.harness.abortSubmission = async (id, context, conversationId) => {
		await host.harness.commit(async tx => { tx.placeSubmission(id, await inputEntry(tx, host.root().id, "original")); }, BACKGROUND_CONTEXT);
		return abort(id, context, conversationId);
	};
	const result = await host.request("request-cancel", { result: { sessionId: fixtureStorageId, submissionId: queued.submissionId, requestId: "race" } }) as { state: string; effects: string };
	host.harness.abortSubmission = abort;
	assert.equal(result.state, "already_placed");
	assert.equal(result.effects, "partial-effects-possible");
});
