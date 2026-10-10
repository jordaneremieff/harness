import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { LiveDoc, type ConversationId, type EntryId, type HarnessInspection, type SubmissionId, type TaskGraph } from "@earendil-works/pi-durable";
import { AgentMetaDoc } from "./durable-controls.ts";
import { AgentDeliveryDoc, DurableHost, sessionIsIdle, type ConfigurationResult, type DurableCommandHost, type DurableHostOptions } from "./durable-host.ts";
import { answerMessage, fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime, fixtureStorageId, gateTool, hostOptions, reasoningRuntime, redactedAnswerMessage, scriptedRuntime, slowEffectTool, toolCallMessage } from "./durable-host-fixture.mts";

const fixturePath = fileURLToPath(new URL("./durable-host-fixture.mts", import.meta.url));
/** Byte bound for captured child output; oldest bytes drop first. */
const CAPTURE_LIMIT = 64 * 1024;
const READY = Buffer.from("READY\n");

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "durable-host-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function appendBounded(buffer: Buffer, chunk: Buffer): Buffer {
	const next = Buffer.concat([buffer, chunk]);
	return next.length > CAPTURE_LIMIT ? next.subarray(next.length - CAPTURE_LIMIT) : next;
}

/**
 * Resolve with the captured output once the child prints its readiness line.
 * Both pipes stay attached after readiness so the child never blocks on a full
 * pipe; capture remains byte bounded.
 */
function readyFrom(child: ReturnType<typeof spawn>, timeoutMs = 20000): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout: Buffer = Buffer.alloc(0);
		let stderr: Buffer = Buffer.alloc(0);
		let settled = false;
		const detail = (message: string) => `${message}\nstdout=${stdout.toString("utf8")}\nstderr=${stderr.toString("utf8")}`;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(detail("fixture did not reach readiness")));
		}, timeoutMs);
		const onStdout = (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk);
			if (settled) return;
			if (!stdout.includes(READY)) return;
			settled = true;
			clearTimeout(timer);
			resolve(stdout.toString("utf8"));
		};
		const onStderr = (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk);
		};
		const onExit = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(detail(`fixture exited before readiness: ${String(code)}`)));
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		};
		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", onStderr);
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

/** A promise that settles once the child has already exited or does so next. */
function childDeath(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function defer(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const wait = (host: DurableHost, submissionId: SubmissionId) => host.wait(submissionId, BACKGROUND_CONTEXT);

it("clears a native retry after the next attempt settles the same exact input", { timeout: 15000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "retry.sqlite");
	let now = Date.now();
	const error = { ...answerMessage(), content: [], stopReason: "error" as const, errorMessage: "429 rate limit: too many requests" };
	const models = await scriptedRuntime([error, answerMessage("recovered")]);
	const options = { ...hostOptions(storagePath, models, fixtureRegistry()), now: () => now, settings: { retry: { enabled: true, maxRetries: 20, baseDelayMs: 300000, maxAgentDelayMs: 300000 } }, retryMaxAttempts: 21 };
	let host = await DurableHost.open(options, BACKGROUND_CONTEXT);
	try {
		let ready!: () => void; const retryReady = new Promise<void>((resolve) => { ready = resolve; });
		const stop = host.harness.subscribeCommits(() => { void host.harness.snapshot(LiveDoc, 1 as ConversationId, BACKGROUND_CONTEXT).then((live) => { if (live?.generation?.retry) ready(); }); });
		const submitted = await host.submit({ message: "task", requestId: "native-retry" });
		await retryReady; stop();
		const results = [{ sessionId: host.storageId, submissionId: submitted.submissionId, requestId: "native-retry" }];
		options.settings.retry.maxRetries = 8;
		const before = await host.request("await-state", { results }) as { execution?: { attempt: number; nextRetryAt: number; maxAttempts?: number } };
		assert.equal(before.execution?.attempt, 1); assert.equal(before.execution.maxAttempts, 9, "the ceiling uses current native settings, not the cached dashboard hint");
		now = before.execution.nextRetryAt + 1;
		await host.close(); host = await DurableHost.open(options, BACKGROUND_CONTEXT);
		assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
		assert.deepEqual(await host.request("await-state", { results }), {});
	} finally { await host.close(); }
});

it("recovers through explicit abort, idle configuration, and a new exact input without changing the old result", { timeout: 15000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "manual-recovery.sqlite");
	const error = { ...answerMessage(), content: [], stopReason: "error" as const, errorMessage: "429 rate limit: too many requests" };
	const host = await DurableHost.open({ ...hostOptions(storagePath, await scriptedRuntime([error, answerMessage("continued task")]), fixtureRegistry()), settings: { retry: { enabled: true, maxRetries: 20, baseDelayMs: 300000, maxAgentDelayMs: 300000 } } }, BACKGROUND_CONTEXT);
	try {
		let ready!: () => void; const retryReady = new Promise<void>((resolve) => { ready = resolve; });
		const stop = host.harness.subscribeCommits(() => { void host.harness.snapshot(LiveDoc, 1 as ConversationId, BACKGROUND_CONTEXT).then((live) => { if (live?.generation?.retry) ready(); }); });
		const original = await host.submit({ message: "ordinary task", requestId: "original-task" });
		await retryReady; stop();
		await assert.rejects(host.request("configure", { thinkingLevel: "high" }), /busy/u);
		await host.request("abort", {});
		assert.equal((await host.wait(original.submissionId, BACKGROUND_CONTEXT)).status, "unanswered");
		await host.request("configure", { model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "high" });
		const continued = await host.submit({ message: "Continue the original task with the retained brief.", requestId: "continued-task" });
		assert.notEqual(continued.submissionId, original.submissionId);
		assert.equal((await host.wait(continued.submissionId, BACKGROUND_CONTEXT)).status, "done");
		assert.equal((await host.wait(original.submissionId, BACKGROUND_CONTEXT)).status, "unanswered");
		assert.deepEqual(await host.request("await-state", { results: [{ sessionId: host.storageId, submissionId: continued.submissionId, requestId: "continued-task" }] }), {});
	} finally { await host.close(); }
});

it("runs a durable task and retains its answer, source IDs, and usage across reopen", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const first = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	const submitted = await first.submit({ message: "do the task", requestId: "run-stable" });
	const outcome = await wait(first, submitted.submissionId);
	if (outcome.status !== "done") assert.fail(`expected a completed run, received ${outcome.reason}`);
	assert.equal(outcome.answer, "durable answer");
	assert.equal(outcome.submissionId, submitted.submissionId);
	assert.ok(outcome.entryId !== undefined, "the placed input entry ID is retained");
	assert.ok(outcome.answerEntryId !== undefined, "the answer entry ID is retained");
	assert.ok(Object.keys(outcome.usage.models).some((key) => key.includes("agent-test")), "usage records the model bucket");
	await first.close();
	const second = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const retained = await wait(second, submitted.submissionId);
		if (retained.status !== "done") assert.fail(`expected the retained outcome, received ${retained.reason}`);
		assert.equal(retained.answer, "durable answer");
		assert.equal(retained.answerEntryId, outcome.answerEntryId);
	} finally {
		await second.close();
	}
});

it("dedupes one submission when the prompt is submitted twice under the same request ID", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const first = await host.submit({ message: "do the task", requestId: "run-dedupe" });
		const second = await host.submit({ message: "do the task", requestId: "run-dedupe" });
		assert.equal(first.submissionId, second.submissionId, "the same request ID reuses one submission");
		assert.equal(second.deduped, true);
		const outcome = await wait(host, first.submissionId);
		assert.equal(outcome.status, "done");
		const userEntries = (await host.transcript()).split("\n").filter((line) => line.startsWith("pi.user"));
		assert.equal(userEntries.length, 1, "the prompt is admitted once");
	} finally {
		await host.close();
	}
});

it("closes storage through a cleanup context after the caller context is cancelled", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const controller = new AbortController();
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
	controller.abort();
	await host.close();
});

it("bounds transcript output by an explicit byte cap", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		await wait(host, (await host.submit({ message: `do the task ${"x".repeat(200)}`, requestId: "run-bounded" })).submissionId);
		for (const maxBytes of [0, 1, 8, 64, 256]) {
			const text = await host.transcript(200, maxBytes);
			assert.ok(Buffer.byteLength(text) <= maxBytes, `${maxBytes}: stays within the byte cap`);
		}
		assert.match(await host.transcript(200, 64), /transcript truncated at 64 bytes/u);
	} finally {
		await host.close();
	}
});

it("holds the byte cap for Unicode transcript content", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		await wait(host, (await host.submit({ message: `café 世界 ${"🧭".repeat(200)}`, requestId: "run-unicode" })).submissionId);
		for (const maxBytes of [1, 8, 64, 256]) {
			const text = await host.transcript(200, maxBytes);
			assert.ok(Buffer.byteLength(text) <= maxBytes, `${maxBytes}: bounded`);
			assert.doesNotMatch(text, /\uFFFD/u, `${maxBytes}: no broken characters`);
		}
	} finally {
		await host.close();
	}
});

it("distinguishes a count-bound omission in the transcript notice", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		await wait(host, (await host.submit({ message: "do the task", requestId: "run-count" })).submissionId);
		const text = await host.transcript(1, 4096);
		assert.equal(text.split("\n").filter((line) => line.startsWith("pi.")).length, 1, "one entry kept");
		assert.match(text, /transcript limited to 1 entry/u);
	} finally {
		await host.close();
	}
});

it("rejects out-of-range transcript bounds", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		for (const [limit, maxBytes] of [[-1, 100], [1.5, 100], [Number.NaN, 100], [200, -1], [200, 1.5], [200, Number.NaN], [200, Number.POSITIVE_INFINITY]]) {
			await assert.rejects(host.transcript(limit, maxBytes), RangeError, `${String(limit)}/${String(maxBytes)}`);
		}
	} finally {
		await host.close();
	}
});

it("refuses an owned submission without an origin and names the restart", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		await assert.rejects(host.request("submit", { message: "from an older window", requestId: "old-window-1", ownerId: "owner-old" }), /calling Pi runs older agent code\. Restart that Pi window/);
		const receipts = (await host.request("receipts", { ownerId: "owner-old" })) as { receipts: readonly unknown[] };
		assert.equal(receipts.receipts.length, 0, "a refused admission leaves no delivery intent");
	} finally {
		await host.close();
	}
});

it("serves submit, receipts, and acknowledge through request dispatch", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const submitted = (await host.request("submit", { message: "report me", requestId: "receipt-1", ownerId: "owner-a", operationId: "op-9", origin: "operator" })) as { submissionId: SubmissionId; identity: string };
		assert.equal(submitted.identity, fixtureStorageId);
		const waiting = (await host.request("receipts", { ownerId: "owner-a", wait: true })) as { receipts: readonly { submissionId: SubmissionId; status: string; answerEntryId: number | null; operationId: string | null; identity: string }[]; reports: readonly unknown[]; pending: number };
		assert.equal(waiting.receipts.length, 1);
		const receipt = waiting.receipts[0];
		assert.ok(receipt);
		assert.equal(receipt.submissionId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.ok(receipt.answerEntryId !== null, "the receipt retains the answer entry ID");
		assert.equal(receipt.operationId, "op-9");
		const acknowledged = (await host.request("acknowledge", { ownerId: "owner-a", submissionIds: [submitted.submissionId] })) as { acknowledged: SubmissionId[] };
		assert.deepEqual(acknowledged.acknowledged, [submitted.submissionId]);
		const after = (await host.request("receipts", { ownerId: "owner-a" })) as { receipts: readonly unknown[] };
		assert.equal(after.receipts.length, 0, "acknowledged receipts stay out of the undelivered set");
	} finally {
		await host.close();
	}
});

it("reconciles an intent written before its submission and never overwrites an acknowledgement", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const first = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	// Simulate a crash after the intent commit and before submission admission.
	await first.harness.commit(async (tx) => {
		const state = await tx.doc(AgentDeliveryDoc);
		state.intents.push({ requestId: "recover-1", ownerId: "owner-r", conversationId: 1 as ConversationId, message: "recovered task", whenBusy: null, operationId: null, submissionId: null, origin: "operator" });
	}, BACKGROUND_CONTEXT);
	const submitted = await first.submit({ message: "recovered task", requestId: "recover-1", ownerId: "owner-r", origin: "operator" });
	await wait(first, submitted.submissionId);
	await first.request("acknowledge", { ownerId: "owner-r", submissionIds: [submitted.submissionId] });
	await first.close();

	const second = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const repeated = (await second.request("submit", { message: "recovered task", requestId: "recover-1", ownerId: "owner-r", origin: "operator" })) as { submissionId: SubmissionId; deduped: boolean };
		assert.equal(repeated.submissionId, submitted.submissionId, "Durable deduplication reuses the submission");
		assert.equal(repeated.deduped, true);
		const receipts = (await second.request("receipts", { ownerId: "owner-r" })) as { receipts: readonly unknown[] };
		assert.equal(receipts.receipts.length, 0, "a repeated submit does not reopen an acknowledged receipt");
	} finally {
		await second.close();
	}
});

it("admits a busy steer and settles both inputs on the run's answer", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const started = defer();
	const release = defer();
	const registry = fixtureRegistry([gateTool(release.promise, started.resolve)]);
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([toolCallMessage("gate"), answerMessage("steered answer")]), registry), BACKGROUND_CONTEXT);
	try {
		const first = await host.submit({ message: "start the run", requestId: "steer-1" });
		await started.promise;
		const second = await host.submit({ message: "change course", requestId: "steer-2", whenBusy: "steer" });
		release.resolve();
		const outcome = await wait(host, first.submissionId);
		if (outcome.status !== "done") assert.fail(`expected the steered run to finish, received ${outcome.reason}`);
		assert.equal(outcome.answer, "steered answer");
		const steered = await wait(host, second.submissionId);
		assert.equal(steered.status, "done", "the steer is part of the settled run");
		const users = (await host.transcript()).split("\n").filter((line) => line.startsWith("pi.user"));
		assert.equal(users.length, 2, "both inputs are on the transcript");
	} finally {
		release.resolve();
		await host.close();
	}
});

it("aborts a live run and reports the unanswered input", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const started = defer();
	const release = defer();
	const registry = fixtureRegistry([gateTool(release.promise, started.resolve)]);
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([toolCallMessage("gate"), answerMessage("never reached")]), registry), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "run forever", requestId: "abort-1" });
		await started.promise;
		const aborting = host.request("abort", {});
		release.resolve();
		await aborting;
		const outcome = await wait(host, submitted.submissionId);
		assert.equal(outcome.status, "unanswered");
	} finally {
		release.resolve();
		await host.close();
	}
});

it("forks at one entry and rewinds a decision into a corrected fork", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("first answer"), answerMessage("corrected answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "first prompt", requestId: "fork-1" });
		await wait(host, submitted.submissionId);
		const entries = await host.root().entries({}, 20, undefined, BACKGROUND_CONTEXT);
		const assistant = entries.items.find((entry) => entry.kind === "pi.assistant");
		assert.ok(assistant, "the first answer is retained");
		const assistantId = assistant.id;

		const fork = (await host.request("fork", { entryId: assistantId })) as { conversationId: ConversationId; identity: string };
		assert.equal(fork.identity, `${fixtureStorageId}:${fork.conversationId}`);
		const forked = await host.conversation(fork.conversationId);
		assert.ok(forked);
		const forkedKinds = (await forked.entries({}, 20, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.kind);
		assert.ok(forkedKinds.includes("pi.assistant"), "the fork keeps entries through the fork point");

		const rewind = (await host.request("rewind", { entryId: assistantId, correction: "corrected prompt" })) as { conversationId: ConversationId; submissionId: SubmissionId; predecessorEntryId: EntryId };
		const corrected = await wait(host, rewind.submissionId);
		if (corrected.status !== "done") assert.fail(`expected the correction to finish, received ${corrected.reason}`);
		assert.equal(corrected.answer, "corrected answer");
		assert.equal(corrected.conversationId, rewind.conversationId);
		const source = await host.root().entries({ minEntryId: assistantId, maxEntryId: assistantId }, 1, undefined, BACKGROUND_CONTEXT);
		assert.equal(source.items.length, 1, "the source conversation keeps the rewound decision");
	} finally {
		await host.close();
	}
});

it("reports a fresh host idle before any mutation", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		assert.equal(host.isIdle(), true, "the open host establishes its idle cache before returning");
	} finally {
		await host.close();
	}
});

it("configures an idle conversation and refuses a busy one", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const started = defer();
	const release = defer();
	const registry = fixtureRegistry([gateTool(release.promise, started.resolve)]);
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([toolCallMessage("gate"), answerMessage("done")]), registry), BACKGROUND_CONTEXT);
	try {
		await host.request("configure", { thinkingLevel: "high", name: "renamed agent" });
		const status = (await host.request("status", {})) as { conversations: readonly { name?: string; agent: { thinkingLevel: string } }[] };
		const firstStatus = status.conversations[0];
		assert.ok(firstStatus);
		assert.equal(firstStatus.name, "renamed agent");
		assert.equal(firstStatus.agent.thinkingLevel, "high");

		const submitted = await host.submit({ message: "busy now", requestId: "config-busy" });
		await started.promise;
		await assert.rejects(host.request("configure", { name: "too soon" }), /busy/u);
		release.resolve();
		await wait(host, submitted.submissionId);
		await host.request("configure", { name: "after idle" });
	} finally {
		release.resolve();
		await host.close();
	}
});

it("returns the full configure outcome with the model-clamped reasoning level", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await reasoningRuntime(), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const first = (await host.request("configure", { model: { provider: fixtureProvider, modelId: "plain" }, thinkingLevel: "high", name: "clamped agent" })) as ConfigurationResult;
		assert.equal(first.sessionId, fixtureStorageId);
		assert.equal(first.outcome, "applied");
		assert.deepEqual(first.before, { name: "", model: `${fixtureProvider}/${fixtureModelId}`, thinkingLevel: "off" });
		assert.deepEqual(first.requested, { name: "clamped agent", model: `${fixtureProvider}/plain`, thinkingLevel: "high" });
		assert.deepEqual(first.after, { name: "clamped agent", model: `${fixtureProvider}/plain`, thinkingLevel: "off" });
		assert.deepEqual(first.reasoning, { requested: "high", effective: "off", clamped: true });
		assert.equal(first.hookErrors.count, 0);
		assert.equal(first.persistence.nativeWrites, "completed");
		assert.equal(first.persistence.fileExists, true);
		assert.equal(first.truncated, undefined);

		const minimal = (await host.request("configure", { model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "minimal" })) as ConfigurationResult;
		assert.deepEqual(minimal.reasoning, { requested: "minimal", effective: "low", clamped: true });
		assert.equal(minimal.after.thinkingLevel, "low");

		const named = (await host.request("configure", { name: "renamed again" })) as ConfigurationResult;
		assert.equal(named.outcome, "applied");
		assert.equal(named.reasoning, undefined);
		assert.equal(named.after.name, "renamed again");
		assert.equal(named.after.model, `${fixtureProvider}/${fixtureModelId}`);

		const missing = (await host.request("configure", { model: { provider: "absent", modelId: "model" }, thinkingLevel: "high" })) as ConfigurationResult;
		assert.equal(missing.outcome, "failed");
		assert.deepEqual(missing.after, missing.before);
		assert.equal(missing.persistence.nativeWrites, "not-attempted");
		assert.match(missing.error ?? "", /configured model catalog/u);
	} finally {
		await host.close();
	}
});

it("aborts active work before compacting and does not resume it", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const started = defer();
	const release = defer();
	const registry = fixtureRegistry([gateTool(release.promise, started.resolve)]);
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([toolCallMessage("gate"), answerMessage("summary answer")]), registry), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "busy work", requestId: "compact-busy" });
		await started.promise;
		const compacted = (await host.request("compact", { instructions: "condense the work", wait: true })) as { status: string; entryId?: EntryId };
		assert.equal(compacted.status, "completed");
		const settled = await host.wait(submitted.submissionId);
		assert.notEqual(settled.status, "done", "the interrupted submission does not complete");
		const inspection = await host.inspect();
		assert.equal(inspection.tasks.length, 0, "nothing resumes after compaction");
		assert.equal(inspection.submissions.filter((item) => item.status === "queued" || item.status === "placed").length, 0);
	} finally {
		release.resolve();
		await host.close();
	}
});

it("returns observed compaction configuration and the retained summary text size", async (t) => {
	const runtime = await fixtureRuntime("answer");
	const options = hostOptions(join(fixtureRoot(t), "compact.sqlite"), runtime, fixtureRegistry());
	const host = await DurableHost.open({ ...options, settings: { ...options.settings, compaction: { keepRecentTokens: 0, reserveTokens: 128 } } }, BACKGROUND_CONTEXT);
	try {
		await host.request("configure", { name: "Other parser" });
		const submitted = await host.submit({ message: "Retain the original task", requestId: "context" });
		await host.wait(submitted.submissionId);
		const outcome = await host.request("compact", { wait: true }) as { status: string; summaryChars?: number; compaction: { identity: string; name: string; provider: string; modelId: string; thinkingLevel: string; before: { contextWindow: number; tokens?: number }; summaryChars?: number } };
		assert.equal(outcome.status, "completed");
		assert.equal(outcome.compaction.identity, host.storageId);
		assert.equal(outcome.compaction.name, "Other parser");
		assert.equal(outcome.compaction.provider, fixtureProvider);
		assert.equal(outcome.compaction.modelId, fixtureModelId);
		assert.equal(outcome.compaction.before.contextWindow, runtime.getModel(fixtureProvider, fixtureModelId)?.contextWindow);
		assert.equal(Object.hasOwn(outcome.compaction.before, "tokens"), false, "cumulative usage is not context size");
		assert.ok((outcome.summaryChars ?? 0) > 0);
		assert.equal(outcome.compaction.summaryChars, outcome.summaryChars);
		const marker = (await host.root().context(BACKGROUND_CONTEXT)).head?.model?.[0];
		assert.equal(marker?.role, "user");
		const retainedText = typeof marker?.content === "string" ? marker.content : marker?.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		assert.equal(outcome.summaryChars, retainedText?.length, "size measures the actual retained wrapped summary");
		await host.request("configure", { name: "Later name" });
		assert.equal(outcome.compaction.name, "Other parser", "the execution facts stay fixed");
	} finally { await host.close(); }
});

it("keeps compaction operational when optional name metadata is unreadable", async (t) => {
	const options = hostOptions(join(fixtureRoot(t), "metadata.sqlite"), await fixtureRuntime("answer"), fixtureRegistry());
	const host = await DurableHost.open({ ...options, settings: { ...options.settings, compaction: { keepRecentTokens: 0, reserveTokens: 128 } } }, BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "Retain the task", requestId: "source" });
		await host.wait(submitted.submissionId);
		const snapshot = host.harness.snapshot.bind(host.harness);
		t.mock.method(host.harness, "snapshot", async (...args: Parameters<typeof snapshot>) => {
			if ((args[0] as unknown) === AgentMetaDoc) throw new Error("name metadata read failed");
			return snapshot(...args);
		});
		const outcome = await host.request("compact", { wait: true }) as { status: string; compaction: { name?: string; metadataError?: string } };
		assert.equal(outcome.status, "completed");
		assert.equal(outcome.compaction.name, undefined);
		assert.equal(outcome.compaction.metadataError, "name metadata read failed");
	} finally { await host.close(); }
});

it("runs a contributed command with its host bindings", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const controller = new AbortController();
	const contributionHost = {
		durable: {},
		services: {},
		cwd: "/work",
		agentDir: "/agent",
		storageId: "contribution-storage",
		signal: controller.signal,
		inventory: { contributions: [], ordinaryOnly: [] },
	} as unknown as DurableCommandHost;
	let opened: DurableHost | undefined;
	const options: DurableHostOptions = {
		...hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()),
		contributionHost,
		commands: [
			{
				name: "echo",
				description: "Echo arguments",
				run: async (call) => {
					assert.equal(call.harness, opened?.harness, "the command call carries the open Harness");
					return `${call.args}:${call.host.storageId}:${call.conversation.id}:${call.invocationId}`;
				},
			},
		],
	};
	const host = await DurableHost.open(options, BACKGROUND_CONTEXT);
	opened = host;
	try {
		const result = (await host.request("command", { name: "echo", args: "hello", invocationId: "inv-1" })) as { name: string; text: string };
		assert.equal(result.name, "echo");
		assert.equal(result.text, `hello:contribution-storage:${String(host.root().id)}:inv-1`);
		await assert.rejects(host.request("command", { name: "echo", args: "hello" }), /invocationId/u);
		await assert.rejects(host.request("command", { name: "missing", invocationId: "inv-2" }), /not registered/u);
	} finally {
		await host.close();
	}
});

it("omits provider signatures, image payloads, and redacted thinking from inspection text", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([redactedAnswerMessage("redacted kept")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		await wait(host, (await host.submit({ message: "show me", requestId: "redact-1" })).submissionId);
		const entries = await host.root().entries({}, 20, undefined, BACKGROUND_CONTEXT);
		const assistant = entries.items.find((entry) => entry.kind === "pi.assistant");
		assert.ok(assistant);
		const exact = (await host.request("inspect", { view: "exact", entryId: assistant.id })) as { text: string; omissions?: { providerSignatures: number; imagePayloads: number; redactedThinking: number } };
		assert.doesNotMatch(exact.text, /opaque-thinking-signature|opaque-redacted-payload|opaque-text-signature|opaque-tool-signature/u);
		assert.match(exact.text, /\[omitted: provider signature\]/u);
		assert.match(exact.text, /\[omitted: redacted thinking\]/u);
		assert.ok((exact.omissions?.providerSignatures ?? 0) >= 3, "every opaque signature is counted");
		assert.equal(exact.omissions?.redactedThinking, 1);
	} finally {
		await host.close();
	}
});

it("retains an outbound report and acknowledges it by source ID", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	const started = Date.now();
	try {
		const report = (await host.request("report", { ownerId: "owner-z", senderIdentity: "agent-x", requestId: "rep-1", message: "progress note", replyTo: "op-1" })) as { sourceId: string; requestId: string; acknowledged: boolean; createdAt: number };
		assert.equal(report.sourceId, "report:rep-1");
		assert.equal(report.acknowledged, false);
		assert.ok(report.createdAt >= started);
		const again = (await host.request("report", { ownerId: "owner-z", senderIdentity: "agent-x", requestId: "rep-1", message: "progress note" })) as { sourceId: string };
		assert.equal(again.sourceId, report.sourceId, "a repeated request ID returns the retained report");
		const waiting = (await host.request("receipts", { ownerId: "owner-z", wait: true })) as { receipts: readonly unknown[]; reports: readonly { sourceId: string; senderIdentity: string; message: string; replyTo: string | null }[] };
		assert.equal(waiting.reports.length, 1);
		const received = waiting.reports[0];
		assert.ok(received);
		assert.equal(received.senderIdentity, "agent-x");
		assert.equal(received.message, "progress note");
		assert.equal(received.replyTo, "op-1");
		const acknowledged = (await host.request("acknowledge", { ownerId: "owner-z", sourceIds: ["report:rep-1"] })) as { acknowledgedReports: string[] };
		assert.deepEqual(acknowledged.acknowledgedReports, ["report:rep-1"]);
		const after = (await host.request("receipts", { ownerId: "owner-z" })) as { reports: readonly unknown[] };
		assert.equal(after.reports.length, 0, "acknowledged reports stay out of the undelivered set");
	} finally {
		await host.close();
	}
	const reopened = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const retained = (await reopened.request("receipts", { ownerId: "owner-z" })) as { reports: readonly unknown[] };
		assert.equal(retained.reports.length, 0, "the acknowledgement survives reopen");
	} finally {
		await reopened.close();
	}
});

it("classifies idle work without excluding waiting tasks", () => {
	const node = (id: number, conversationId: number, state: Record<string, unknown>, conversations: number[] = []): Record<string, unknown> => ({
		id,
		kind: "test.task",
		conversationId,
		background: false,
		abortRequested: false,
		state,
		conversations,
	});
	const graph = (...nodes: Record<string, unknown>[]) => ({ tasks: Object.fromEntries(nodes.map((task, index) => [String(index + 1), task])) }) as unknown as TaskGraph;
	const inspection = (submissions: number) => ({ scheduling: "running", tasks: [], submissions: Array.from({ length: submissions }, (_, index) => ({ id: index + 1 })) }) as unknown as HarnessInspection;
	assert.equal(sessionIsIdle(graph(), inspection(0)), true, "an empty session is idle");
	assert.equal(sessionIsIdle(graph(node(1, 1, { status: "running", phase: "work" })), inspection(0)), false, "a running task is work");
	assert.equal(sessionIsIdle(graph(node(1, 1, { status: "pending", phase: "work" })), inspection(0)), false, "a pending task is work");
	assert.equal(sessionIsIdle(graph(node(1, 1, { status: "completing", outcome: "completed" })), inspection(0)), false, "a completing task is work");
	assert.equal(sessionIsIdle(graph(node(1, 1, { status: "waiting", phase: "wait", on: [2], policy: "allSettled" })), inspection(0)), false, "a task waiting on work is work");
	assert.equal(sessionIsIdle(graph(node(1, 1, { status: "waiting", phase: "hold", on: [], policy: "allSettled" }, [7])), inspection(0)), false, "a task waiting with no dependencies may await an external effect and counts");
	assert.equal(sessionIsIdle(graph(node(1, 1, { status: "waiting", phase: "hold", on: [], policy: "allSettled" }, [7]), node(2, 7, { status: "running", phase: "work" })), inspection(0)), false, "owned live work counts");
	assert.equal(sessionIsIdle(graph(node(1, 1, { status: "waiting", phase: "hold", on: [], policy: "allSettled" }, [7])), inspection(1)), false, "an unsettled submission is work");
});

it("cancels an abandoned receipts wait and reports shutdown separately", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const controller = new AbortController();
		const abandoned = host.request("receipts", { ownerId: "ghost", wait: true }, controller.signal);
		controller.abort(new Error("client gone"));
		await assert.rejects(abandoned, /client gone/u);
		const closing = host.request("receipts", { ownerId: "ghost-2", wait: true });
		const shutdown = host.close();
		await assert.rejects(closing, /durable host is closed/u);
		await shutdown;
	} finally {
		await host.close().catch(() => {});
	}
});

it("returns the retained fork and rewind for a repeated request key", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("first answer"), answerMessage("corrected answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "first prompt", requestId: "fork-key-1" });
		await wait(host, submitted.submissionId);
		const entries = await host.root().entries({}, 20, undefined, BACKGROUND_CONTEXT);
		const assistant = entries.items.find((entry) => entry.kind === "pi.assistant");
		assert.ok(assistant);

		const firstFork = (await host.request("fork", { entryId: assistant.id, requestId: "fork:store:task" })) as { conversationId: ConversationId; deduped: boolean };
		const secondFork = (await host.request("fork", { entryId: assistant.id, requestId: "fork:store:task" })) as { conversationId: ConversationId; deduped: boolean };
		assert.equal(secondFork.conversationId, firstFork.conversationId, "the repeated fork key returns the retained fork");
		assert.equal(firstFork.deduped, false);
		assert.equal(secondFork.deduped, true);
		const afterFork = (await host.request("list")) as { items: readonly unknown[] };
		assert.equal(afterFork.items.length, 2, "one fork was created");

		const firstRewind = (await host.request("rewind", { entryId: assistant.id, correction: "corrected prompt", requestId: "rewind:store:task" })) as { conversationId: ConversationId; submissionId: SubmissionId; deduped: boolean };
		const corrected = await wait(host, firstRewind.submissionId);
		if (corrected.status !== "done") assert.fail(`expected the correction to finish, received ${corrected.reason}`);
		const secondRewind = (await host.request("rewind", { entryId: assistant.id, correction: "corrected prompt", requestId: "rewind:store:task" })) as { conversationId: ConversationId; submissionId: SubmissionId; deduped: boolean };
		assert.equal(secondRewind.conversationId, firstRewind.conversationId, "the repeated rewind key returns the retained fork");
		assert.equal(secondRewind.submissionId, firstRewind.submissionId, "the repeated rewind reuses the retained admission");
		assert.equal(secondRewind.deduped, true);
		const afterRewind = (await host.request("list")) as { items: readonly unknown[] };
		assert.equal(afterRewind.items.length, 3, "no duplicate rewind fork was created");
	} finally {
		await host.close();
	}
});

it("creates one fork for concurrent requests with the same key", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("concurrent answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "concurrent prompt", requestId: "concurrent-1" });
		await wait(host, submitted.submissionId);
		const entries = await host.root().entries({}, 20, undefined, BACKGROUND_CONTEXT);
		const assistant = entries.items.find((entry) => entry.kind === "pi.assistant");
		assert.ok(assistant);
		const [first, second] = (await Promise.all([
			host.request("fork", { entryId: assistant.id, requestId: "fork:store:concurrent" }),
			host.request("fork", { entryId: assistant.id, requestId: "fork:store:concurrent" }),
		])) as [{ conversationId: ConversationId; deduped: boolean }, { conversationId: ConversationId; deduped: boolean }];
		assert.equal(first.conversationId, second.conversationId, "both requests return the same fork");
		assert.equal([first.deduped, second.deduped].filter(Boolean).length, 1, "exactly one request created the fork");
		const list = (await host.request("list")) as { items: readonly unknown[] };
		assert.equal(list.items.length, 2, "only one fork exists");
	} finally {
		await host.close();
	}
});

it("treats unnamed rewinds as distinct invocations", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("first answer"), answerMessage("correction one"), answerMessage("correction two")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "first prompt", requestId: "rewind-nokey-1" });
		await wait(host, submitted.submissionId);
		const entries = await host.root().entries({}, 20, undefined, BACKGROUND_CONTEXT);
		const assistant = entries.items.find((entry) => entry.kind === "pi.assistant");
		assert.ok(assistant);
		const first = (await host.request("rewind", { entryId: assistant.id, correction: "correction one" })) as { conversationId: ConversationId; submissionId: SubmissionId; deduped: boolean };
		const firstOutcome = await wait(host, first.submissionId);
		assert.equal(firstOutcome.status, "done");
		const second = (await host.request("rewind", { entryId: assistant.id, correction: "correction two" })) as { conversationId: ConversationId; submissionId: SubmissionId; deduped: boolean };
		const secondOutcome = await wait(host, second.submissionId);
		assert.equal(secondOutcome.status, "done");
		if (secondOutcome.status === "done") assert.equal(secondOutcome.answer, "correction two");
		assert.notEqual(first.conversationId, second.conversationId, "each unnamed rewind creates its own fork");
		assert.equal(first.deduped, false);
		assert.equal(second.deduped, false);
		const list = (await host.request("list")) as { items: readonly unknown[] };
		assert.equal(list.items.length, 3, "the root and two distinct forks exist");
	} finally {
		await host.close();
	}
});

it("reports a freshly opened host as idle without waiting for a commit", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		assert.equal(host.isIdle(), true, "open establishes the idle cache before any commit");
		assert.equal(await host.refreshIdle(), true);
	} finally {
		await host.close();
	}
	const busyPath = join(fixtureRoot(t), "busy.sqlite");
	const started = defer();
	const release = defer();
	const busy = await DurableHost.open(hostOptions(busyPath, await scriptedRuntime([toolCallMessage("gate"), answerMessage("done")]), fixtureRegistry([gateTool(release.promise, started.resolve)])), BACKGROUND_CONTEXT);
	try {
		const submitted = await busy.submit({ message: "busy", requestId: "idle-fresh-1" });
		await started.promise;
		assert.equal(busy.isIdle(), false, "a live run is not idle");
		assert.equal(await busy.refreshIdle(), false);
		release.resolve();
		await busy.wait(submitted.submissionId, BACKGROUND_CONTEXT);
		assert.equal(await busy.refreshIdle(), true, "the settled run returns the host to idle");
	} finally {
		release.resolve();
		await busy.close();
	}
});

/** Run one child to a durable checkpoint, kill it, then resume in this process. */
async function crashAndResume(mode: "request" | "effect"): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "durable-host-crash-"));
	const storagePath = join(root, "run.sqlite");
	const effectPath = join(root, "effect.txt");
	const rerunPath = join(root, "rerun.txt");
	const runId = `crash-${mode}`;
	const child = spawn(process.execPath, [fixturePath, storagePath, mode, effectPath, rerunPath, "do the task", runId], { stdio: ["ignore", "pipe", "pipe"] });
	let host: DurableHost | undefined;
	try {
		const output = await readyFrom(child);
		const childSubmission = output.match(/SUBMISSION (\d+)/)?.[1];
		assert.ok(childSubmission, "the fixture reports its admitted submission ID");
		const death = childDeath(child);
		child.kill("SIGKILL");
		await death;
		const tools = mode === "effect" ? [slowEffectTool(effectPath, rerunPath, false)] : [];
		host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry(tools)), BACKGROUND_CONTEXT);
		const admitted = await host.submit({ message: "do the task", requestId: runId, ownerId: "fixture-owner", origin: "operator" });
		assert.equal(String(admitted.submissionId), childSubmission, "the restart reuses the retained submission");
		assert.equal(admitted.deduped, true, "the child's intent resolves through the retained submission");
		const outcome = await wait(host, admitted.submissionId);
		if (outcome.status !== "done") assert.fail(`expected a completed run, received ${outcome.reason}`);
		assert.equal(outcome.answer, "durable answer");
		const receipts = (await host.request("receipts", { ownerId: "fixture-owner", wait: true })) as { receipts: readonly { status: string; answerEntryId: number | null }[] };
		const receipt = receipts.receipts[0];
		assert.ok(receipt);
		assert.equal(receipt.status, "done", "the owner receipt survives the kill");
		assert.equal(receipt.answerEntryId, outcome.answerEntryId);
		const transcript = await host.transcript();
		assert.equal(transcript.split("\n").filter((line) => line.startsWith("pi.user")).length, 1, "the prompt is admitted once");
		if (mode === "effect") {
			assert.equal(readFileSync(effectPath, "utf8").trim().split("\n").length, 1, "the unsafe effect ran exactly once");
			assert.equal(existsSync(rerunPath), false, "the interrupted tool did not rerun");
			assert.match(transcript, /interrupted/iu);
		}
	} finally {
		if (host) await host.close().catch(() => {});
		if (child.exitCode === null && child.signalCode === null) {
			const death = childDeath(child);
			child.kill("SIGKILL");
			await death;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

it("resumes a request-phase crash from the committed checkpoint", { timeout: 30000 }, async () => {
	await crashAndResume("request");
});

it("marks an interrupted unsafe tool without rerunning its effect", { timeout: 30000 }, async () => {
	await crashAndResume("effect");
});
