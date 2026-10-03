import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, SubmissionId } from "@earendil-works/pi-durable";
import { AgentManager } from "./manager.ts";
import { AgentConversationSummarySchema, ConversationStatusSchema, DurableEntryRowSchema, InspectOutputSchema, ListOutputSchema, ListRowSchema, StatusOutputSchema, structuredObservation } from "./observation-schema.ts";
import { buildStatusOverview } from "./status-overview.ts";
import { boundCatalogView } from "./catalog-view.ts";
import { readConversationList, readConversationStatus, readDashboard, readInspection } from "./durable-observation.ts";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureRegistry, fixtureStorageId, hostOptions, scriptedRuntime } from "./durable-host-fixture.mts";

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "observation-schema-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function openRun(t: { after(fn: () => void): void }, message = "schema needle answer"): Promise<{ host: DurableHost; submissionId: SubmissionId; assistantId: EntryId }> {
	const storagePath = join(fixtureRoot(t), "run.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage(message)]), fixtureRegistry()), BACKGROUND_CONTEXT);
	t.after(() => host.close().catch(() => {}));
	const submitted = await host.submit({ message: "schema prompt", requestId: "schema-1" });
	const outcome = await host.wait(submitted.submissionId, BACKGROUND_CONTEXT);
	assert.equal(outcome.status, "done");
	assert.ok(outcome.answerEntryId);
	const entries = await host.root().entries({}, 20, undefined, BACKGROUND_CONTEXT);
	const assistant = entries.items.find((entry) => entry.kind === "pi.assistant");
	assert.ok(assistant);
	return { host, submissionId: submitted.submissionId, assistantId: assistant.id };
}

it("validates every inspect view and the empty and missing cases against a real Harness", async (t) => {
	const { host, submissionId, assistantId } = await openRun(t);
	const conversation = host.root();
	const harness = host.harness;
	const views: Record<string, unknown> = {
		history: await readInspection(harness, fixtureStorageId, conversation, { view: "history", limit: 20 }, BACKGROUND_CONTEXT),
		branch: await readInspection(harness, fixtureStorageId, conversation, { view: "branch", fromId: assistantId }, BACKGROUND_CONTEXT),
		search: await readInspection(harness, fixtureStorageId, conversation, { view: "search", query: "needle" }, BACKGROUND_CONTEXT),
		exact: await readInspection(harness, fixtureStorageId, conversation, { view: "exact", entryId: assistantId }, BACKGROUND_CONTEXT),
		activity: await readInspection(harness, fixtureStorageId, conversation, { view: "activity" }, BACKGROUND_CONTEXT),
		result: await readInspection(harness, fixtureStorageId, conversation, { view: "result", submissionId }, BACKGROUND_CONTEXT),
		default: await readInspection(harness, fixtureStorageId, conversation, {}, BACKGROUND_CONTEXT),
	};
	for (const value of Object.values(views)) structuredObservation(InspectOutputSchema, value);
	assert.equal((views.history as { format: string }).format, "compact");
	assert.equal((views.activity as { format: string }).format, "compact");
	assert.equal((views.branch as { format?: string }).format, undefined);
	for (const entry of (views.history as { entries: { format: string }[] }).entries) assert.equal(entry.format, "compact");
	for (const turn of (views.activity as { turns: { entries: { format: string }[] }[] }).turns) for (const entry of turn.entries) assert.equal(entry.format, "compact");
	const history = views.history as { view: string; entries: readonly unknown[] };
	assert.equal(history.view, "history");
	assert.ok(history.entries.some((entry) => (entry as { kind: string }).kind === "pi.assistant"));
	for (const entry of history.entries) structuredObservation(DurableEntryRowSchema, entry);
	const search = views.search as { matches: readonly unknown[]; coverage: { complete: boolean } };
	assert.ok(search.matches.length >= 1);
	const result = views.result as { status: string; answerEntryId?: number };
	assert.equal(result.status, "done");
	assert.ok(result.answerEntryId);

	await assert.rejects(readInspection(harness, fixtureStorageId, conversation, { view: "exact", entryId: 999_999 as EntryId }, BACKGROUND_CONTEXT), /not visible/u);
	await assert.rejects(readInspection(harness, fixtureStorageId, conversation, { view: "result", operationId: "missing" }, BACKGROUND_CONTEXT), /no retained result/u);
	await assert.rejects(readInspection(harness, fixtureStorageId, conversation, { view: "search", query: "" }, BACKGROUND_CONTEXT), /requires query/u);
	assert.throws(() => structuredObservation(InspectOutputSchema, { view: "nope" }), /does not match its schema/u);

	const freshPath = join(fixtureRoot(t), "empty.sqlite");
	const fresh = await DurableHost.open(hostOptions(freshPath, await scriptedRuntime([]), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const emptyHistory = await readInspection(fresh.harness, fixtureStorageId, fresh.root(), { view: "history" }, BACKGROUND_CONTEXT);
		structuredObservation(InspectOutputSchema, emptyHistory);
		assert.deepEqual((emptyHistory as { entries: readonly unknown[]; nextCursor: null }).entries, []);
		assert.equal((emptyHistory as { format: string }).format, "compact");
		assert.equal((emptyHistory as { nextCursor: null }).nextCursor, null);
		const emptyActivity = await readInspection(fresh.harness, fixtureStorageId, fresh.root(), { view: "activity" }, BACKGROUND_CONTEXT);
		structuredObservation(InspectOutputSchema, emptyActivity);
		assert.equal((emptyActivity as { format: string }).format, "compact");
	} finally {
		await fresh.close();
	}
});

it("validates list rows and the manager list aggregation", async (t) => {
	const { host } = await openRun(t);
	const page = await readConversationList(host.harness, fixtureStorageId, {}, BACKGROUND_CONTEXT);
	assert.equal(page.items.length, 1);
	const row = page.items[0];
	assert.ok(row);
	const merged = structuredObservation(ListRowSchema, { ...row, sessionId: row.identity, storageId: fixtureStorageId, cwd: "/work" });
	assert.equal(merged.sessionId, fixtureStorageId);

	const root = fixtureRoot(t);
	const manager = new AgentManager({
		root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		observe: async (_metadata, method) => {
			if (method === "list") return { items: page.items, next: page.next ?? undefined };
			throw new Error("observation unavailable");
		},
	});
	t.after(() => manager.close());
	manager.catalog.create({ cwd: "/work", agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: "test", modelId: "model" }, thinkingLevel: "off", ownerId: "owner-1" });
	const listed = structuredObservation(ListOutputSchema, await manager.list({}));
	assert.equal(listed.rows.length, 1);
	assert.equal(listed.rows[0]?.sessionId, fixtureStorageId);
	assert.equal(listed.rows[0]?.conversationId, 1);
	assert.equal(listed.rows[0]?.firstMessage, "schema prompt");
	assert.equal(listed.nextCursor, null);
	assert.equal(listed.coverage.complete, true);
	assert.equal(listed.coverage.storagesVisited, 1);
	assert.deepEqual(listed.coverage.unavailable, []);

	const failing = new AgentManager({
		root: join(root, "failing"),
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		observe: async () => {
			throw new Error("storage is unavailable");
		},
	});
	t.after(() => failing.close());
	failing.catalog.create({ cwd: "/work", agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: "test", modelId: "model" }, thinkingLevel: "off", ownerId: "owner-1" });
	const unavailable = structuredObservation(ListOutputSchema, await failing.list({}));
	assert.deepEqual(unavailable.rows, []);
	assert.equal(unavailable.coverage.unavailable.length, 1);
	assert.match(unavailable.coverage.unavailable[0]?.reason ?? "", /unavailable/u);
});

it("validates the starting roster row and no-target status overview", () => {
	const row = { id: "new-storage", storageId: "new-storage", cwd: "/work", firstMessage: "New task", model: { provider: "test", modelId: "model", thinkingLevel: "high" }, modifiedAt: 0, owner: "unknown" as const, state: "starting" as const, cost: 0, partial: false };
	structuredObservation(AgentConversationSummarySchema, row);
	const overview = buildStatusOverview({ rows: [row], observedAt: new Date(0).toISOString(), coverage: { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null } }, [], []);
	structuredObservation(StatusOutputSchema, overview);
	assert.equal(overview.sessions[0]?.state, "starting");
	assert.equal(overview.sessions[0]?.firstMessage, "New task");
});

it("validates every status variant, including unavailable rows", async (t) => {
	const { host } = await openRun(t);
	const status = await readConversationStatus(host.harness, fixtureStorageId, 1 as ConversationId, {}, BACKGROUND_CONTEXT);
	assert.ok(status);
	structuredObservation(ConversationStatusSchema, status);
	assert.equal(status.lastTextRole, "assistant", "the retained answer carries its author role");
	const userTail = { ...status, lastText: "operator tail", lastTextRole: "user" };
	structuredObservation(ConversationStatusSchema, userTail);
	const { lastTextRole: _role, ...withoutRole } = status;
	structuredObservation(ConversationStatusSchema, withoutRole);
	assert.ok(status.live === null || typeof status.live === "object");
	const inventory = { contributions: [], ordinaryOnly: [] as string[] };
	structuredObservation(StatusOutputSchema, { conversation: status, inventory, pid: 4242, storageId: fixtureStorageId });
	const malformed = { conversation: { ...status, tasks: [{ id: 1, kind: "fixture", status: "invalid-state", background: false, abortRequested: false }] }, inventory, pid: 4242, storageId: fixtureStorageId };
	assert.throws(() => structuredObservation(StatusOutputSchema, malformed), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /\/conversation\/tasks\/0\/status/u);
		assert.doesNotMatch(error.message, /required properties sessions/u);
		return true;
	});
	structuredObservation(StatusOutputSchema, { conversation: status, inventory, live: false, storageId: fixtureStorageId });
	structuredObservation(StatusOutputSchema, { conversations: [status], inventory, pid: 4242, storageId: fixtureStorageId });
	// The failure member appears only when an extension failed; both shapes are valid.
	structuredObservation(StatusOutputSchema, { conversation: status, inventory: { ...inventory, failed: [{ path: "/ext/broken.ts", error: "boom" }] }, pid: 4242, storageId: fixtureStorageId });
	const noTarget = (await host.request("status", {})) as { conversations: readonly unknown[] };
	structuredObservation(StatusOutputSchema, { ...noTarget, inventory, pid: 4242, storageId: fixtureStorageId });

	const root = fixtureRoot(t);
	const manager = new AgentManager({
		root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		observe: async (_metadata, method) => {
			if (method === "dashboard") return await readDashboard(host.harness, fixtureStorageId, {}, { owner: "here", cwd: "/work" }, BACKGROUND_CONTEXT);
			if (method === "status") return { conversation: status, inventory, live: false, storageId: fixtureStorageId };
			throw new Error("observation unavailable");
		},
	});
	t.after(() => manager.close());
	const record = manager.catalog.create({ cwd: "/work", agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: "test", modelId: "model" }, thinkingLevel: "off", ownerId: "owner-1" });
	const rows = await readDashboard(host.harness, fixtureStorageId, {}, { owner: "here", cwd: "/work" }, BACKGROUND_CONTEXT);
	manager.catalog.updateView(record.storageId, boundCatalogView({ updatedAt: new Date().toISOString(), rows: rows.map((row) => ({ ...row, storageId: record.storageId })), storageId: record.storageId }));
	const overview = structuredObservation(StatusOutputSchema, buildStatusOverview(await manager.dashboardPage(), [], [])) as { sessions: readonly { state: string }[]; coverage: { complete: boolean; bytes: number } };
	assert.equal(overview.sessions[0]?.state, "done");
	assert.ok(overview.coverage.bytes > 0);
	const session = structuredObservation(StatusOutputSchema, await manager.status(`${record.storageId}:1`)) as { conversation?: unknown };
	assert.ok(session.conversation !== undefined);

	const failing = new AgentManager({
		root: join(root, "failing"),
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		observe: async () => {
			throw new Error("storage is unavailable");
		},
	});
	t.after(() => failing.close());
	failing.catalog.create({ cwd: "/work", agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: "test", modelId: "model" }, thinkingLevel: "off", ownerId: "owner-1" });
	const unavailable = structuredObservation(StatusOutputSchema, buildStatusOverview(await failing.dashboardPage(), [], [])) as { sessions: readonly { state: string; owner: string; error?: string; partial: boolean }[] };
	const unavailableRow = unavailable.sessions.find((row) => row.state === "unavailable");
	assert.ok(unavailableRow);
	assert.equal(unavailableRow?.partial, true);
	assert.match(unavailableRow?.error ?? "", /unavailable/u);
});
