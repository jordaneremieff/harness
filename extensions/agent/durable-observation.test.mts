import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, SystemEntry, UserEntry, type EntryRecord, type ConversationId, type LiveState, type SubmissionId } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DurableHost } from "./durable-host.ts";
import { InspectOutputSchema, structuredObservation } from "./observation-schema.ts";
import { ACTIVITY_DIGEST_BYTES, ACTIVITY_SCAN_BYTES, DurableObservation, entryRow, fragment, projectEntry, dashboardHealth, reduceActivityMetadata, SNAPSHOT_BYTE_LIMIT, SNAPSHOT_MAX_SOURCE_BYTES } from "./durable-observation.ts";
import { answerMessage, failingTool, fixtureRegistry, fixtureRuntime, fixtureStorageId, gateTool, hostOptions, redactedAnswerMessage, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "durable-observation-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function observationFor(storagePath: string, registry = fixtureRegistry()): Promise<DurableObservation> {
	return DurableObservation.open({ backupFrom: storagePath, storageId: fixtureStorageId, models: await fixtureRuntime("answer"), registry }, BACKGROUND_CONTEXT);
}

function defer(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("reads a cold snapshot with the live request surface and no writer", async (t) => {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	const submitted = await host.submit({ message: "first prompt", requestId: "obs-1" });
	const outcome = await host.wait(submitted.submissionId, BACKGROUND_CONTEXT);
	assert.equal(outcome.status, "done");

	const observation = await observationFor(storagePath);
	try {
		const list = (await observation.request("list")) as { items: readonly { identity: string; name?: string; busy: boolean }[]; next: null };
		assert.equal(list.items.length, 1);
		const listed = list.items[0];
		assert.ok(listed);
		assert.equal(listed.identity, fixtureStorageId);
		assert.equal(list.next, null, "the list continuation is null at the end");

		const status = (await observation.request("status", {})) as { conversations: readonly { identity: string; lastText: string | null }[] };
		assert.equal(status.conversations.length, 1);
		const statusRow = status.conversations[0];
		assert.ok(statusRow);
		assert.match(statusRow.lastText ?? "", /durable answer/u);

		const history = (await observation.request("inspect", { view: "history", limit: 100 })) as { entries: readonly { id: number; kind: string }[]; order: string };
		assert.equal(history.order, "newestFirst");
		const assistant = history.entries.find((entry) => entry.kind === "pi.assistant");
		assert.ok(assistant, "the history retains the answer");

		const exact = (await observation.request("inspect", { view: "exact", entryId: assistant.id })) as { entryId: number; text: string; truncated: boolean };
		assert.equal(exact.entryId, assistant.id);
		assert.match(exact.text, /durable answer/u);

		const result = (await observation.request("inspect", { view: "result", submissionId: submitted.submissionId })) as { submissionId: SubmissionId; status: string; answerEntryId: number | null; answer?: string };
		assert.equal(result.status, "done");
		assert.equal(result.answerEntryId, outcome.answerEntryId ?? null);
		assert.equal(result.answer, "durable answer");

		const dashboard = (await observation.request("dashboard")) as readonly { id: string; storageId: string; cwd: string; state: string; latestReply?: string; firstMessage?: string; modifiedAt: number; owner: string }[];
		assert.equal(dashboard.length, 1);
		const summary = dashboard[0];
		assert.ok(summary);
		assert.equal(summary.id, fixtureStorageId);
		assert.equal(summary.storageId, fixtureStorageId);
		assert.equal(summary.state, "done");
		assert.equal(summary.firstMessage, "first prompt");
		assert.equal(summary.latestReply, "durable answer");
		assert.equal(summary.owner, "unavailable");
		assert.ok(summary.modifiedAt > 0);
		assert.equal(typeof summary.cwd, "string");

		const snapshot = (await observation.request("snapshot")) as { entries: readonly { id: string; kind: string; model?: readonly unknown[] }[]; partial: boolean; revision: string };
		assert.ok(snapshot.entries.some((entry) => entry.kind === "pi.assistant" && (entry.model?.length ?? 0) > 0));
		assert.equal(snapshot.partial, false);
		assert.notEqual(snapshot.revision, "empty");

		await assert.rejects(observation.request("submit", { message: "no", requestId: "no" }), /does not support/u);
		await assert.rejects(observation.request("receipts", { ownerId: "x", wait: true }), /cannot wait/u);
	} finally {
		await observation.close();
	}
	// A live host can keep writing while the snapshot copy is made.
	const after = (await host.request("list")) as { items: readonly unknown[] };
	assert.equal(after.items.length, 1);
	await host.close();
});

it("does not create state when a snapshot opens an empty storage", async (t) => {
	const storagePath = join(fixtureRoot(t), "empty.sqlite");
	const storage = await openNodeSqliteStorage(storagePath);
	await storage.close(BACKGROUND_CONTEXT);

	const observation = await observationFor(storagePath);
	try {
		const list = (await observation.request("list")) as { items: readonly unknown[]; next: null };
		assert.equal(list.items.length, 0, "no root conversation is created by a read-only open");
		const status = (await observation.request("status", {})) as { conversations: readonly unknown[] };
		assert.equal(status.conversations.length, 0);
	} finally {
		await observation.close();
	}

	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const list = (await host.request("list")) as { items: readonly unknown[] };
		assert.equal(list.items.length, 1, "the live host creates the root when it opens");
	} finally {
		await host.close();
	}
});

it("reads absent storage as an empty conversation without creating source files", async (t) => {
	const storagePath = join(fixtureRoot(t), "absent.sqlite");
	const observation = await observationFor(storagePath);
	try {
		const snapshot = await observation.request("snapshot", { sessionId: fixtureStorageId });
		assert.deepEqual(snapshot, {
			entries: [], partial: false, revision: "empty", nextBefore: null,
			coverage: { complete: true, entries: 0, bytes: 0, hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: false },
		});
		assert.deepEqual(await observation.request("list"), { items: [], next: null });
		await assert.rejects(observation.request("snapshot", { sessionId: "other-storage" }), /does not belong/);
		await assert.rejects(observation.request("snapshot", { before: -1 }), /positive/);
		assert.equal(existsSync(storagePath), false);
		assert.equal(existsSync(`${storagePath}-wal`), false);
		assert.equal(existsSync(`${storagePath}-shm`), false);
	} finally { await observation.close(); }
});

it("bounds the snapshot source before copying", async (t) => {
	const storagePath = join(fixtureRoot(t), "bounded.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	await host.close();
	await assert.rejects(
		DurableObservation.open({ backupFrom: storagePath, storageId: fixtureStorageId, models: await fixtureRuntime("answer"), registry: fixtureRegistry(), maxSourceBytes: 1 }, BACKGROUND_CONTEXT),
		/above the 1 byte bound/u,
	);

	assert.ok(SNAPSHOT_MAX_SOURCE_BYTES >= 1024);
});

it("continues history, search, and exact reads from a cold snapshot", async (t) => {
	const storagePath = join(fixtureRoot(t), "continue.sqlite");
	const registry = fixtureRegistry();
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("first needle answer"), answerMessage("second needle answer")]), registry), BACKGROUND_CONTEXT);
	const first = await host.submit({ message: "needle one", requestId: "s-1" });
	const second = await host.submit({ message: "needle two", requestId: "s-2" });
	assert.equal((await host.wait(first.submissionId, BACKGROUND_CONTEXT)).status, "done");
	assert.equal((await host.wait(second.submissionId, BACKGROUND_CONTEXT)).status, "done");
	await host.close();

	const observation = await observationFor(storagePath, registry);
	try {
		const page = (await observation.request("inspect", { view: "history", limit: 1 })) as { entries: readonly { id: number }[]; nextCursor: unknown };
		assert.equal(page.entries.length, 1);
		assert.ok(page.nextCursor !== null, "a bounded history read returns a continuation");
		const firstEntry = page.entries[0];
		assert.ok(firstEntry);
		const continued = (await observation.request("inspect", { view: "history", limit: 20, cursor: page.nextCursor })) as { entries: readonly { id: number }[] };
		assert.ok(!continued.entries.some((entry) => entry.id === firstEntry.id), "the continuation does not repeat the first page");

		const search = (await observation.request("inspect", { view: "search", query: "needle", limit: 1 })) as { matches: readonly { entryId: number; excerpt: string }[]; nextCursor: unknown };
		assert.equal(search.matches.length, 1);
		const firstMatch = search.matches[0];
		assert.ok(firstMatch);
		assert.match(firstMatch.excerpt, /needle/u);
		assert.ok(search.nextCursor !== null, "a bounded search returns a continuation");
		const more = (await observation.request("inspect", { view: "search", query: "needle", limit: 5, cursor: search.nextCursor })) as { matches: readonly { entryId: number }[] };
		assert.ok(!more.matches.some((match) => match.entryId === firstMatch.entryId), "the search continuation does not repeat matches");

		const exact = (await observation.request("inspect", { view: "exact", entryId: firstMatch.entryId, offset: 0 })) as { text: string; nextOffset: number | null };
		if (exact.nextOffset !== null) {
			const tail = (await observation.request("inspect", { view: "exact", entryId: firstMatch.entryId, offset: exact.nextOffset })) as { offset: number; text: string };
			assert.equal(tail.offset, exact.nextOffset);
			assert.notEqual(tail.text, exact.text);
		}

		const activity = (await observation.request("inspect", { view: "activity", limit: 2 })) as { turns: readonly { entries: readonly { kind: string }[] }[] };
		assert.ok(activity.turns.length >= 1);
		assert.ok(activity.turns.some((turn) => turn.entries.some((entry) => entry.kind === "pi.user")));
		assert.ok(JSON.stringify(activity.turns[0]).includes("needle two"), "turns are newest first");
	} finally {
		await observation.close();
	}
});

it("includes receipts and reports in a cold snapshot and omits opaque provider fields", async (t) => {
	const storagePath = join(fixtureRoot(t), "delivery.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([redactedAnswerMessage("redacted answer"), answerMessage("owner answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	const submitted = await host.submit({ message: "deliver to owner", requestId: "deliver-1", ownerId: "owner-cold", origin: "operator" });
	assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
	const report = (await host.request("report", { ownerId: "owner-cold", senderIdentity: "agent-cold", requestId: "rep-cold", message: "cold report" })) as { sourceId: string };
	await host.close();

	const observation = await observationFor(storagePath);
	try {
		const deliveries = (await observation.request("receipts", { ownerId: "owner-cold" })) as {
			receipts: readonly { submissionId: SubmissionId; status: string; answer: string | null; answerEntryId: number | null; usage: unknown }[];
			reports: readonly { sourceId: string; message: string }[];
			pending: number;
		};
		assert.equal(deliveries.receipts.length, 1);
		const receipt = deliveries.receipts[0];
		const reportRow = deliveries.reports[0];
		assert.ok(receipt);
		assert.ok(reportRow);
		assert.equal(receipt.status, "done");
		assert.equal(receipt.answer, "redacted answer");
		assert.ok(receipt.answerEntryId !== null);
		assert.ok(receipt.usage !== null, "the receipt carries the conversation usage");
		assert.equal(reportRow.sourceId, report.sourceId);
		assert.equal(reportRow.message, "cold report");
		assert.equal(deliveries.pending, 0);

		const entries = (await observation.request("inspect", { view: "history", limit: 50 })) as { entries: readonly { id: number; kind: string; omissions?: { providerSignatures: number; redactedThinking: number } }[] };
		const assistant = entries.entries.find((entry) => entry.kind === "pi.assistant");
		assert.ok(assistant);
		const exact = (await observation.request("inspect", { view: "exact", entryId: assistant.id })) as { text: string; omissions?: { providerSignatures: number; redactedThinking: number } };
		assert.doesNotMatch(exact.text, /opaque-thinking-signature|opaque-text-signature|opaque-tool-signature/u);
		assert.match(exact.text, /\[omitted: provider signature\]/u);
		assert.equal(exact.omissions?.redactedThinking, 1);
	} finally {
		await observation.close();
	}
});

it("finds a retained result by operation ID in a cold snapshot", async (t) => {
	const storagePath = join(fixtureRoot(t), "operation.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	const submitted = await host.submit({ message: "operation prompt", requestId: "operation-1", ownerId: "owner-op", operationId: "op-cold-7", origin: "operator" });
	assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
	await host.close();
	const observation = await observationFor(storagePath);
	try {
		const result = (await observation.request("inspect", { view: "result", operationId: "op-cold-7" })) as { submissionId: SubmissionId; operationId?: string; answer?: string };
		assert.equal(result.submissionId, submitted.submissionId);
		assert.equal(result.answer, "durable answer");
		await assert.rejects(observation.request("inspect", { view: "result", operationId: "missing-op" }), /no retained result/u);
	} finally {
		await observation.close();
	}
});

it("reads a status target by external identity and a fork by its identity", async (t) => {
	const storagePath = join(fixtureRoot(t), "identity.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("first answer"), answerMessage("fork answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	const submitted = await host.submit({ message: "fork me", requestId: "identity-1" });
	await host.wait(submitted.submissionId, BACKGROUND_CONTEXT);
	const assistant = (await host.root().entries({}, 20, undefined, BACKGROUND_CONTEXT)).items.find((entry) => entry.kind === "pi.assistant");
	assert.ok(assistant);
	const fork = (await host.request("fork", { entryId: assistant.id })) as { conversationId: ConversationId; identity: string };
	await host.close();

	const observation = await observationFor(storagePath);
	try {
		const one = (await observation.request("status", { sessionId: fork.identity })) as { conversation: { identity: string; conversationId: number } };
		assert.equal(one.conversation.identity, fork.identity);
		assert.equal(one.conversation.conversationId, fork.conversationId);
		await assert.rejects(observation.request("status", { sessionId: `${fixtureStorageId}:999999` }), /does not exist/u);
		await assert.rejects(observation.request("status", { sessionId: "other-storage:2" }), /does not belong/u);
	} finally {
		await observation.close();
	}
});

it("reports live activity metadata, current tool, and turn duration", async (t) => {
	const storagePath = join(fixtureRoot(t), "live.sqlite");
	const started = defer();
	const release = defer();
	const registry = fixtureRegistry([gateTool(release.promise, started.resolve)]);
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([toolCallMessage("gate"), answerMessage("done")]), registry), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "live metadata", requestId: "live-1" });
		await started.promise;
		const activity = (await host.request("inspect", { view: "activity" })) as {
			metadata: {
				owner: string;
				live: boolean;
				operation: number | null;
				runningTools: readonly { toolCallId: string; name: string; issuedAt?: string; elapsedMs?: number; elapsedFrom?: string }[];
				pending: number | null;
				streamedText?: string;
			};
			coverage: { scannedBytes: number; byteLimitReached: boolean; complete: boolean };
		};
		assert.equal(activity.metadata.owner, "here");
		assert.equal(activity.metadata.live, true);
		assert.ok(activity.metadata.operation !== null, "the live run task is the operation");
		assert.equal(activity.metadata.pending, 0, "no queued input");
		const running = activity.metadata.runningTools.find((tool) => tool.name === "gate");
		assert.ok(running, "the running gate call is listed");
		if (running?.issuedAt !== undefined) {
			assert.equal(running.elapsedFrom, "tool-call-entry");
			assert.ok((running.elapsedMs ?? -1) >= 0);
		}
		assert.ok(activity.coverage.scannedBytes > 0);

		const dashboard = (await host.request("dashboard")) as readonly { currentTool?: { name: string; argument: string }; durationMs?: number; health?: unknown }[];
		const row = dashboard[0];
		assert.ok(row);
		assert.equal(row.currentTool?.name, "gate");
		assert.match(row.currentTool?.argument ?? "", /^\{\}$/u);
		assert.ok((row.durationMs ?? -1) >= 0, "a working turn has a wall-clock duration");
		assert.equal(row.health, undefined, "a healthy live host reports no recovery health");
		release.resolve();
		assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
	} finally {
		release.resolve();
		await host.close();
	}
});

it("classifies the cold owner through the caller's claim observation", async (t) => {
	const storagePath = join(fixtureRoot(t), "owner.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	await host.close();
	const models = await fixtureRuntime("answer");
	const readable = await DurableObservation.open({ backupFrom: storagePath, storageId: fixtureStorageId, models, registry: fixtureRegistry(), classifyOwner: () => ({ owner: "unknown" }) }, BACKGROUND_CONTEXT);
	try {
		const rows = (await readable.request("dashboard")) as readonly { owner: string; ownerLabel?: string }[];
		assert.equal(rows[0]?.owner, "unknown", "a readable, claimable storage is not unavailable");
	} finally {
		await readable.close();
	}
	const claimed = await DurableObservation.open({ backupFrom: storagePath, storageId: fixtureStorageId, models, registry: fixtureRegistry(), classifyOwner: () => ({ owner: "unavailable", label: "PID 42" }) }, BACKGROUND_CONTEXT);
	try {
		const rows = (await claimed.request("dashboard")) as readonly { owner: string; ownerLabel?: string }[];
		assert.equal(rows[0]?.owner, "unavailable");
		assert.equal(rows[0]?.ownerLabel, "PID 42");
	} finally {
		await claimed.close();
	}
});

it("bounds the activity scan by bytes and reports entry and byte flags", async (t) => {
	const storagePath = join(fixtureRoot(t), "bytes.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: `huge ${ "x".repeat(70_000) }`, requestId: "bytes-1" });
		assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
	} finally {
		await host.close();
	}
	const observation = await observationFor(storagePath);
	try {
		const activity = (await observation.request("inspect", { view: "activity" })) as { coverage: { scannedBytes: number; complete: boolean; entryLimitReached: boolean; scanByteLimitReached: boolean; byteLimitReached: boolean; bytes: number; omittedEntries: number } };
		assert.ok(activity.coverage.scannedBytes >= ACTIVITY_SCAN_BYTES, "the scan measured at least the byte bound");
		assert.equal(activity.coverage.scanByteLimitReached, true);
		assert.equal(activity.coverage.entryLimitReached, false);
		assert.ok(activity.coverage.bytes <= ACTIVITY_DIGEST_BYTES, "the digest stays inside its bound");
		assert.equal(typeof activity.coverage.omittedEntries, "number");
	} finally {
		await observation.close();
	}
});

it("derives dashboard health only from live recovery state", () => {
	const live = {
		generation: { attempt: 3, retry: { at: 2000, error: "provider down" } },
		compactions: [{ taskId: 1, reason: "threshold", blocking: true, attempt: 2, retry: { at: 3000, error: "summary failed" } }],
	} as unknown as LiveState;
	const health = dashboardHealth(live, [{ reason: "missing_task", error: "definition missing" }], 1000, 4);
	assert.deepEqual(health, {
		lastError: "definition missing",
		compactionFailure: { reason: "threshold", errorMessage: "summary failed", at: new Date(3000).toISOString() },
		autoRetry: { attempt: 3, maxAttempts: 4, delayMs: 1000, errorMessage: "provider down" },
	});
	assert.equal(dashboardHealth(undefined, [], 0, 4), undefined, "a cold snapshot has no health");
	assert.equal(dashboardHealth(live, [], 1000, undefined)?.autoRetry, undefined, "without a resolved retry ceiling there is no retry row");
});

it("bounds the serialized activity digest for many large UTF-8 turns", async (t) => {
	const storagePath = join(fixtureRoot(t), "digest.sqlite");
	const answers = Array.from({ length: 13 }, (_, index) => answerMessage(`answer ${index} ${"世界".repeat(400)}`));
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime(answers), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		for (let index = 0; index < answers.length; index++) {
			const submitted = await host.submit({ message: `user ${index} ${"世界".repeat(400)}`, requestId: `digest-${index}` });
			assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
		}
	} finally {
		await host.close();
	}
	const observation = await observationFor(storagePath);
	try {
		const activity = (await observation.request("inspect", { view: "activity", limit: 12 })) as { coverage: { bytes: number; byteLimitReached: boolean; omittedEntries: number; complete: boolean }; detail: string };
		const bytes = Buffer.byteLength(JSON.stringify(activity), "utf8");
		assert.ok(bytes <= ACTIVITY_DIGEST_BYTES, `digest is ${bytes} bytes`);
		assert.ok(bytes <= 8_000, "the compact coordinator digest stays within its byte ceiling");
		assert.equal(activity.coverage.bytes, bytes, "coverage.bytes is the exact fixed point");
		assert.equal(activity.coverage.byteLimitReached, true);
		assert.ok(activity.coverage.omittedEntries > 0);
		assert.equal(activity.coverage.complete, false, "a truncated digest does not claim completeness");
		assert.match(activity.detail, /nextCursor resumes older turns and unfinished scans only/u, "the detail states the pagination boundary");
	} finally {
		await observation.close();
	}
});

it("keeps an older failure row when the activity digest is truncated", async (t) => {
	const storagePath = join(fixtureRoot(t), "digest-failure.sqlite");
	const scripts = [toolCallMessage("failing-tool"), answerMessage("recovered"), ...Array.from({ length: 11 }, (_, index) => answerMessage(`answer ${index} ${"世界".repeat(400)}`))];
	const registry = fixtureRegistry([failingTool()]);
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime(scripts), registry), BACKGROUND_CONTEXT);
	try {
		const first = await host.submit({ message: "run the failing tool", requestId: "failure-1" });
		assert.equal((await host.wait(first.submissionId, BACKGROUND_CONTEXT)).status, "done");
		for (let index = 0; index < 11; index++) {
			const submitted = await host.submit({ message: `later ${index} ${"世界".repeat(400)}`, requestId: `failure-later-${index}` });
			assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
		}
	} finally {
		await host.close();
	}
	const observation = await observationFor(storagePath, registry);
	try {
		const activity = (await observation.request("inspect", { view: "activity", limit: 12 })) as { coverage: { byteLimitReached: boolean; omittedEntries: number; bytes: number } };
		const bytes = Buffer.byteLength(JSON.stringify(activity), "utf8");
		assert.ok(bytes <= ACTIVITY_DIGEST_BYTES, `digest is ${bytes} bytes`);
		assert.equal(activity.coverage.bytes, bytes);
		assert.equal(activity.coverage.byteLimitReached, true);
		assert.ok(activity.coverage.omittedEntries > 0);
		assert.ok(JSON.stringify(activity).includes("intentional failure"), "the older error tool result survives truncation");
	} finally {
		await observation.close();
	}
});

it("pages activity without overlapping retained turns", async (t) => {
	const storagePath = join(fixtureRoot(t), "turns.sqlite");
	const answers = Array.from({ length: 4 }, (_, index) => answerMessage(`answer ${index}`));
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime(answers), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		for (let index = 0; index < 4; index++) {
			const submitted = await host.submit({ message: `turn ${index}`, requestId: `turns-${index}` });
			assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
		}
	} finally {
		await host.close();
	}
	const observation = await observationFor(storagePath);
	try {
		const first = (await observation.request("inspect", { view: "activity", limit: 2 })) as { turns: readonly { entries: readonly { id: number }[] }[]; nextCursor: unknown; detail: string };
		assert.equal(first.turns.length, 2, "the limit keeps two turns");
		assert.ok(first.nextCursor !== null, "older turns return a continuation");
		assert.ok(JSON.stringify(first.turns[0]).includes("turn 3"), "turns are newest first");
		const firstIds = new Set(first.turns.flatMap((turn) => turn.entries.map((entry) => entry.id)));
		const second = (await observation.request("inspect", { view: "activity", limit: 2, cursor: first.nextCursor })) as { turns: readonly { entries: readonly { id: number }[] }[] };
		assert.ok(second.turns.length > 0, "the continuation returns older turns");
		const secondIds = second.turns.flatMap((turn) => turn.entries.map((entry) => entry.id));
		assert.ok(secondIds.every((id) => !firstIds.has(id)), "the continuation does not repeat retained entries");
		assert.ok(JSON.stringify(second.turns[0]).includes("turn 1"), "the continuation starts at the next older turn");
	} finally {
		await observation.close();
	}
});

it("reduces oversized activity metadata while keeping the error fields", () => {
	const big = "世".repeat(9000);
	const metadata = {
		owner: "here" as const,
		live: true,
		operation: 1,
		runningTools: Array.from({ length: 40 }, (_, index) => ({ toolCallId: `call-${index}`, name: "n".repeat(300), issuedAt: "2026-10-02T00:00:00.000Z", elapsedMs: 1, elapsedFrom: "tool-call-entry" as const })),
		pending: 0,
		streamedText: big,
		lastError: big,
		compactionFailure: { reason: "manual" as const, errorMessage: big, at: "2026-10-02T00:00:00.000Z" },
		autoRetry: { attempt: 1, maxAttempts: 4, delayMs: 1000, errorMessage: big },
	};
	const limit = 4096;
	const reduced = reduceActivityMetadata(metadata, (candidate) => Buffer.byteLength(JSON.stringify(candidate), "utf8") <= limit);
	assert.equal(reduced.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(reduced.metadata), "utf8") <= limit);
	assert.equal(reduced.metadata.streamedText, undefined, "streaming text drops before errors");
	assert.equal(reduced.metadata.runningTools.length, 0, "tool rows drop before errors");
	assert.ok(reduced.metadata.lastError !== undefined && reduced.metadata.lastError.length < big.length);
	assert.ok((reduced.metadata.compactionFailure?.errorMessage?.length ?? big.length) < big.length);
	assert.ok((reduced.metadata.autoRetry?.errorMessage?.length ?? big.length) < big.length);
	const small = { owner: "here" as const, live: true, operation: null, runningTools: [], pending: null };
	assert.equal(reduceActivityMetadata(small, () => true).truncated, false, "fitting metadata is untouched");
	const streamOnly = { ...small, streamedText: big };
	const streamReduced = reduceActivityMetadata(streamOnly, (candidate) => Buffer.byteLength(JSON.stringify(candidate), "utf8") <= limit);
	assert.equal(streamReduced.truncated, true, "a stream-only overflow reports truncation");
	assert.ok((streamReduced.metadata.streamedText?.length ?? 0) < big.length, "the stream is shortened before anything is dropped");
});

it("bounds the activity digest when live metadata alone is oversized and no rows exist", async (t) => {
	const storagePath = join(fixtureRoot(t), "metadata.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const big = "世".repeat(9000);
		await host.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, 1 as ConversationId);
			(live as { generation?: unknown }).generation = {
				attempt: 1,
				message: {
					role: "assistant",
					content: [{ type: "text", text: big }],
					api: "test",
					provider: "test",
					model: "model",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "pending",
					timestamp: Date.now(),
				},
			};
			(live as { compactions?: unknown }).compactions = [{ taskId: 1, reason: "manual", blocking: true, attempt: 1, retry: { at: Date.now() + 1000, error: big } }];
			(live as { tools?: unknown }).tools = Array.from({ length: 40 }, (_, index) => ({ callId: `call-${index}`, name: "n".repeat(300), status: "running" }));
			(live as { run?: unknown }).run = { taskId: 1, inputs: [] };
		}, BACKGROUND_CONTEXT);
		const activity = (await host.request("inspect", { view: "activity" })) as {
			coverage: { bytes: number; metadataTruncated: boolean; byteLimitReached: boolean; omittedEntries: number; complete: boolean };
			metadata: { runningTools: readonly unknown[]; streamedText?: string; compactionFailure?: { errorMessage?: string } };
		};
		const bytes = Buffer.byteLength(JSON.stringify(activity), "utf8");
		assert.ok(bytes <= ACTIVITY_DIGEST_BYTES, `digest is ${bytes} bytes`);
		assert.equal(activity.coverage.bytes, bytes);
		assert.equal(activity.coverage.metadataTruncated, true);
		assert.equal(activity.coverage.byteLimitReached, true, "metadata truncation reports the byte limit");
		assert.equal(activity.coverage.complete, false, "metadata truncation never claims completeness");
		assert.equal(activity.coverage.omittedEntries, 0, "no rows were dropped");
		assert.ok(activity.metadata.compactionFailure !== undefined, "the error field survives metadata reduction");
		assert.ok((activity.metadata.compactionFailure?.errorMessage?.length ?? Infinity) <= 1024);
		assert.ok(activity.metadata.runningTools.length <= 16);
	} finally {
		await host.close();
	}
});

it("bounds stream-only oversized metadata with no rows and flags the byte limit", async (t) => {
	const storagePath = join(fixtureRoot(t), "metadata-stream.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const big = "世".repeat(9000);
		await host.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, 1 as ConversationId);
			(live as { generation?: unknown }).generation = {
				attempt: 1,
				message: {
					role: "assistant",
					content: [{ type: "text", text: big }],
					api: "test",
					provider: "test",
					model: "model",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "pending",
					timestamp: Date.now(),
				},
			};
		}, BACKGROUND_CONTEXT);
		const activity = (await host.request("inspect", { view: "activity" })) as {
			coverage: { bytes: number; metadataTruncated: boolean; byteLimitReached: boolean; omittedEntries: number; complete: boolean };
			metadata: { streamedText?: string };
		};
		const bytes = Buffer.byteLength(JSON.stringify(activity), "utf8");
		assert.ok(bytes <= ACTIVITY_DIGEST_BYTES, `digest is ${bytes} bytes`);
		assert.equal(activity.coverage.bytes, bytes);
		assert.equal(activity.coverage.metadataTruncated, true, "the stream-only overflow is reported");
		assert.equal(activity.coverage.byteLimitReached, true, "stream omission sets the byte flag without rows");
		assert.equal(activity.coverage.complete, false);
		assert.equal(activity.coverage.omittedEntries, 0);
		assert.ok((activity.metadata.streamedText?.length ?? 0) < big.length, "streamed text is shortened");
	} finally {
		await host.close();
	}
});

interface SnapshotPageShape {
	entries: readonly { id: string; kind: string; model?: readonly unknown[] }[];
	partial: boolean;
	revision: string;
	nextBefore: number | null;
	coverage: { complete: boolean; entries: number; bytes: number; hiddenExcluded: number; entryLimitReached: boolean; byteLimitReached: boolean };
}

it("keeps the first user entry when a hidden system entry exceeds the transcript byte bound", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "hidden.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("first answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "first prompt", requestId: "hidden-1" });
		assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
		// A real prompt patch carries its payload inside the system message; one
		// larger than the transcript byte bound used to end the newest-first scan.
		const huge = "x".repeat(SNAPSHOT_BYTE_LIMIT + 4096);
		await host.harness.commit(
			(tx) => tx.appendEntry(SystemEntry, 1 as ConversationId, { model: [{ role: "system", content: "", sections: { huge }, timestamp: Date.now() } as unknown as Message] }),
			BACKGROUND_CONTEXT,
		);
		const snapshot = (await host.request("snapshot")) as SnapshotPageShape;
		assert.ok(snapshot.entries.some((entry) => entry.kind === "pi.user"), "the first user input survives");
		assert.ok(snapshot.entries.some((entry) => entry.kind === "pi.assistant"), "the answer survives");
		assert.ok(!snapshot.entries.some((entry) => entry.kind === "pi.system"), "hidden kinds stay out of the transcript payload");
		assert.equal(snapshot.partial, false, "hidden exclusion alone never marks the page partial");
		assert.ok(snapshot.coverage.hiddenExcluded >= 1, "the scan reports the hidden record it skipped");
		assert.ok(snapshot.coverage.bytes < SNAPSHOT_BYTE_LIMIT, "the visible payload stays inside the byte bound");
	} finally {
		await host.close();
	}
});

it("continues the transcript backwards from the page anchor to the first input", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "pages.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("a0"), answerMessage("a1"), answerMessage("a2"), answerMessage("a3")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		for (let index = 0; index < 4; index++) {
			const submitted = await host.submit({ message: `prompt ${index}`, requestId: `pages-${index}` });
			assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
		}
		const first = (await host.request("snapshot", { limit: 3 })) as SnapshotPageShape;
		assert.equal(first.entries.length, 3);
		assert.equal(first.coverage.entryLimitReached, true, "the entry bound stopped the page");
		assert.ok(first.nextBefore !== null, "a bounded page carries its earlier anchor");
		const second = (await host.request("snapshot", { limit: 3, before: first.nextBefore })) as SnapshotPageShape;
		assert.ok(second.entries.length > 0);
		const firstIds = new Set(first.entries.map((entry) => entry.id));
		assert.ok(second.entries.every((entry) => !firstIds.has(entry.id)), "pages do not overlap");
		assert.ok(Number(second.entries[second.entries.length - 1]?.id) < Number(first.entries[0]?.id), "the second page is strictly older");
		let collected = [...second.entries];
		let before = second.nextBefore;
		let guard = 0;
		while (before !== null && guard++ < 10) {
			const page = (await host.request("snapshot", { limit: 3, before })) as SnapshotPageShape;
			collected = [...page.entries, ...collected];
			before = page.nextBefore;
		}
		assert.equal(before, null, "the oldest page carries no anchor");
		assert.ok(collected.some((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model ?? []).includes("prompt 0")), "paging reaches the first input");
		assert.ok([...first.entries, ...collected].some((entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model ?? []).includes("a3")), "the newest page joins the older pages");
	} finally {
		await host.close();
	}
});

it("carries the author role of the retained tail text", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "roles.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("tail answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "tail question", requestId: "roles-1" });
		assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
		const answered = (await host.request("status")) as { conversations: readonly { lastText: string | null; lastTextRole?: string }[] };
		const answerRow = answered.conversations[0];
		assert.ok(answerRow);
		assert.match(answerRow.lastText ?? "", /tail answer/u);
		assert.equal(answerRow.lastTextRole, "assistant", "the answer is labeled as the assistant's");
		await host.harness.commit((tx) => tx.appendEntry(UserEntry, 1 as ConversationId, { model: [{ role: "user", content: "operator tail", timestamp: Date.now() }] }), BACKGROUND_CONTEXT);
		const asked = (await host.request("status")) as { conversations: readonly { lastText: string | null; lastTextRole?: string }[] };
		const userRow = asked.conversations[0];
		assert.ok(userRow);
		assert.equal(userRow.lastText, "operator tail");
		assert.equal(userRow.lastTextRole, "user", "the operator input is labeled as the user's");
	} finally {
		await host.close();
	}
});

it("keeps exhausted text and argument markers within the shared excerpt budget", () => {
	const entry = { id: 1, kind: "pi.assistant", model: [{ ...answerMessage(""), content: [
		{ type: "text", text: "answer ".repeat(300) },
		...Array.from({ length: 8 }, (_, index) => ({ type: "toolCall", id: String(index), name: `tool-${index}`, arguments: { payload: "x".repeat(2000) } })),
	] }] } as unknown as EntryRecord;
	for (const units of [80, 1200]) {
		const row = entryRow(entry, units);
		const used = row.text.length + (row.toolCalls ?? []).reduce((total, call) => total + call.arguments.length, 0) + (row.toolResults ?? []).reduce((total, result) => total + result.text.length, 0);
		assert.ok(used <= units, `${used} excerpt units exceed ${units}`);
		assert.equal(row.truncated, true);
		assert.ok(row.toolCalls?.some((call) => call.truncated));
	}
});

it("keeps both ends of a readable fragment on Unicode boundaries", () => {
	const cut = fragment("A😀B", 2, 4);
	assert.equal(cut.start, 1);
	assert.equal(cut.text, "😀B");
	assert.equal(cut.nextOffset, null);
});

it("projects readable compact entries with named tools and bounded arguments", () => {
	const entry = {
		id: 1,
		kind: "pi.assistant",
		model: [
			{
				...answerMessage("review done"),
				content: [
					{ type: "text", text: "review done" },
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { path: "file.ts", payload: "x".repeat(2000) },
						partialJson: "duplicate arguments",
					},
				],
			},
		],
	} as unknown as EntryRecord;
	const row = entryRow(entry);
	assert.equal(row.text, "review done");
	assert.equal(row.toolCalls?.[0]?.name, "read");
	assert.match(row.toolCalls?.[0]?.arguments ?? "", /file.ts/u);
	assert.match(row.toolCalls?.[0]?.arguments ?? "", /\[truncated\]/u);
	assert.equal(row.truncated, true);
	assert.equal(row.nextOffset, null);
	assert.doesNotMatch(JSON.stringify(row), /partialJson|totalTokens|duplicate arguments/u);
	assert.match(projectEntry(entry).text, /partialJson|duplicate arguments/u);
});

it("bounds compact text and tool parts with visible markers and intact Unicode", () => {
	const entry = {
		id: 2,
		kind: "pi.tool-result",
		model: [
			{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "😀".repeat(3000) }] },
		],
	} as unknown as EntryRecord;
	const row = entryRow(entry, 80);
	assert.equal(row.toolResults?.[0]?.name, "bash");
	assert.equal(row.toolResults?.[0]?.isError, true);
	assert.equal(row.toolResults?.[0]?.truncated, true);
	assert.match(row.toolResults?.[0]?.text ?? "", /\[truncated\]/u);
	assert.ok((row.toolResults?.[0]?.text.length ?? 0) <= 80);
	assert.doesNotMatch(JSON.stringify(row), /\\ud83d"/u);
	const many = {
		id: 3,
		kind: "pi.assistant",
		model: [
			{
				...answerMessage(""),
				content: Array.from({ length: 30 }, (_, i) => ({
					type: "toolCall",
					id: String(i),
					name: `tool-${i}`,
					arguments: {},
				})),
			},
		],
	} as unknown as EntryRecord;
	const bounded = entryRow(many);
	assert.equal(bounded.toolCalls?.length, 8);
	assert.equal(bounded.omittedParts, 22);
	assert.equal(bounded.truncated, true);
});

it("keeps full retained entry evidence across exact pages after compact history and activity", async (t) => {
	const storagePath = join(fixtureRoot(t), "full-evidence.sqlite");
	const answer = answerMessage("full evidence 😀 ".repeat(3000));
	const host = await DurableHost.open(
		hostOptions(storagePath, await scriptedRuntime([answer]), fixtureRegistry()),
		BACKGROUND_CONTEXT,
	);
	const submitted = await host.submit({ message: "inspect the worker", requestId: "full-evidence" });
	await host.wait(submitted.submissionId, BACKGROUND_CONTEXT);
	const retained = (await host.root().entries({}, 20, undefined, BACKGROUND_CONTEXT)).items.find(
		(e) => e.kind === "pi.assistant",
	);
	assert.ok(retained);
	const expected = projectEntry(retained).text;
	await host.close();
	const observation = await observationFor(storagePath);
	try {
		const history = (await observation.request("inspect", { view: "history" })) as {
			entries: ReturnType<typeof entryRow>[];
		};
		structuredObservation(InspectOutputSchema, history);
		const compact = history.entries.find((e) => e.id === retained.id);
		assert.ok(compact);
		assert.equal(compact.truncated, true);
		assert.match(compact.text, /\[truncated\]/u);
		assert.ok(JSON.stringify(compact).length < 2000);
		const activity = (await observation.request("inspect", { view: "activity" })) as {
			turns: { entries: ReturnType<typeof entryRow>[] }[];
		};
		structuredObservation(InspectOutputSchema, activity);
		assert.deepEqual(
			activity.turns.flatMap((t) => t.entries).find((e) => e.id === retained.id),
			compact,
		);
		const emojiOffset = expected.indexOf("😀");
		assert.ok(emojiOffset >= 0);
		const normalized = await observation.request("inspect", { view: "exact", entryId: retained.id, offset: emojiOffset + 1 }) as { offset: number; text: string };
		structuredObservation(InspectOutputSchema, normalized);
		assert.equal(normalized.offset, emojiOffset);
		assert.ok(normalized.text.startsWith("😀"));
		let text = "",
			offset = 0,
			pages = 0;
		for (;;) {
			const page = (await observation.request("inspect", { view: "exact", entryId: retained.id, offset })) as {
				text: string;
				nextOffset: number | null;
			};
			structuredObservation(InspectOutputSchema, page);
			text += page.text;
			pages++;
			if (page.nextOffset === null) break;
			assert.ok(page.nextOffset > offset);
			offset = page.nextOffset;
			assert.ok(pages < 20);
		}
		assert.ok(pages > 1);
		assert.equal(text, expected);
		assert.deepEqual(JSON.parse(text).model, retained.model);
	} finally {
		await observation.close();
	}
});

it("continues compact history without losing an entry at each page boundary", async (t) => {
	const storagePath = join(fixtureRoot(t), "history-pages.sqlite");
	const host = await DurableHost.open(
		hostOptions(
			storagePath,
			await scriptedRuntime([answerMessage("one"), answerMessage("two"), answerMessage("three")]),
			fixtureRegistry(),
		),
		BACKGROUND_CONTEXT,
	);
	for (const n of [1, 2, 3]) {
		const s = await host.submit({ message: `prompt ${n}`, requestId: `page-${n}` });
		await host.wait(s.submissionId, BACKGROUND_CONTEXT);
	}
	const expected = (await host.root().entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.map((e) => e.id);
	await host.close();
	const obs = await observationFor(storagePath);
	try {
		const seen: number[] = [];
		let cursor: unknown;
		for (let n = 0; n < 100; n++) {
			const page = (await obs.request("inspect", {
				view: "history",
				limit: 1,
				...(cursor === undefined ? {} : { cursor }),
			})) as { entries: { id: number }[]; nextCursor: unknown };
			seen.push(...page.entries.map((e) => e.id));
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		}
		assert.deepEqual(seen, expected);
	} finally {
		await obs.close();
	}
});

it("prioritizes failure rows within the digest bound and exposes excluded failures through history", async (t) => {
 const storagePath=join(fixtureRoot(t),"failure-priority.sqlite");
 const tool={...failingTool(),execute:async()=>{throw new Error(`large intentional failure ${"x".repeat(4000)}`);}};
 const scripts=Array.from({length:8},()=>[toolCallMessage("failing-tool"),answerMessage("recovered")]).flat();
 const host=await DurableHost.open(hostOptions(storagePath,await scriptedRuntime(scripts),fixtureRegistry([tool])),BACKGROUND_CONTEXT);
 for(let n=0;n<8;n++){const s=await host.submit({message:"task",requestId:String(n)});await host.wait(s.submissionId,BACKGROUND_CONTEXT);}
 const failures=(await host.root().entries({},100,undefined,BACKGROUND_CONTEXT)).items.filter(e=>e.kind==="pi.tool-result"&&e.model?.[0]?.role==="toolResult"&&e.model[0].isError);
 await host.close();
 const obs=await observationFor(storagePath);
 try {
  const activity=await obs.request("inspect",{view:"activity",limit:12}) as {turns:{entries:{id:number}[]}[];detail:string;coverage:{omittedEntries:number;byteLimitReached:boolean}};
  const kept=new Set(activity.turns.flatMap(t=>t.entries.map(e=>e.id)));
  const excluded=failures.filter(e=>!kept.has(e.id));
  assert.ok(excluded.length>0);assert.equal(activity.coverage.byteLimitReached,true);assert.ok(activity.coverage.omittedEntries>=excluded.length);
  assert.match(activity.detail,/Failure rows take priority within the digest bound/u);assert.doesNotMatch(activity.detail,/Failure rows survive/u);
  const history=await obs.request("inspect",{view:"history",limit:50}) as {entries:{id:number}[]};
  for(const failure of excluded){assert.ok(history.entries.some(e=>e.id===failure.id));const exact=await obs.request("inspect",{view:"exact",entryId:failure.id}) as {text:string};assert.match(exact.text,/large intentional failure/u);}
 } finally {await obs.close();}
});
