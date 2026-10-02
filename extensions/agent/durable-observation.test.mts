import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DurableHost } from "./durable-host.ts";
import { DurableObservation, SNAPSHOT_MAX_SOURCE_BYTES } from "./durable-observation.ts";
import { answerMessage, fixtureRegistry, fixtureRuntime, fixtureStorageId, hostOptions, redactedAnswerMessage, scriptedRuntime } from "./durable-host-fixture.mts";

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "durable-observation-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function observationFor(storagePath: string, registry = fixtureRegistry()): Promise<DurableObservation> {
	return DurableObservation.open({ backupFrom: storagePath, storageId: fixtureStorageId, models: await fixtureRuntime("answer"), registry }, BACKGROUND_CONTEXT);
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

it("bounds the snapshot source before copying", async (t) => {
	const storagePath = join(fixtureRoot(t), "bounded.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), BACKGROUND_CONTEXT);
	await host.close();
	await assert.rejects(
		DurableObservation.open({ backupFrom: storagePath, storageId: fixtureStorageId, models: await fixtureRuntime("answer"), registry: fixtureRegistry(), maxSourceBytes: 1 }, BACKGROUND_CONTEXT),
		/above the 1 byte bound/u,
	);
	const missing = join(fixtureRoot(t), "missing.sqlite");
	await assert.rejects(
		DurableObservation.open({ backupFrom: missing, storageId: fixtureStorageId, models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, BACKGROUND_CONTEXT),
		/ENOENT/u,
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
	} finally {
		await observation.close();
	}
});

it("includes receipts and reports in a cold snapshot and omits opaque provider fields", async (t) => {
	const storagePath = join(fixtureRoot(t), "delivery.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([redactedAnswerMessage("redacted answer"), answerMessage("owner answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	const submitted = await host.submit({ message: "deliver to owner", requestId: "deliver-1", ownerId: "owner-cold" });
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
	const submitted = await host.submit({ message: "operation prompt", requestId: "operation-1", ownerId: "owner-op", operationId: "op-cold-7" });
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
