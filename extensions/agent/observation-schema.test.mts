import { ProfiledListOutputSchema } from "./profile-discovery.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, UsageDoc, type ConversationId, type EntryId, type SubmissionId, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { AgentManager } from "./manager.ts";
import { ActivityOutputSchema, LiveStateSchema, AgentConversationSummarySchema, AssistantMessageSchema, ConversationStatusSchema, DurableEntryRowSchema, InspectOutputSchema, ListRowSchema, NativeListOutputSchema, StatusOutputSchema, StatusToolOutputSchema, nativeStructuredObservation, structuredObservation } from "./observation-schema.ts";
import { page as rosterPage } from "./dashboard-test-fixture.mts";
import { buildStatusOverview } from "./status-overview.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { boundCatalogView } from "./catalog-view.ts";
import { readConversationList, readConversationStatus, readDashboard, readInspection } from "./durable-observation.ts";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureRegistry, fixtureStorageId, hostOptions, scriptedRuntime } from "./durable-host-fixture.mts";

it("native observations separate model text from validated structured output without changing ordinary values", () => {
	const schema = Type.Object({ result: Type.String(), optional: Type.Optional(Type.String()) }, { additionalProperties: false });
	const input = { result: "retained observation", optional: undefined };
	const ordinary = structuredObservation(schema, input);
	const native = nativeStructuredObservation(schema, input, "Observation for the model");
	const accepted: ToolExecutionResult = native;
	assert.deepEqual(ordinary, { result: "retained observation" });
	assert.deepEqual(native, { output: [{ type: "text", text: "Observation for the model" }], structuredOutput: ordinary });
	assert.deepEqual(accepted.structuredOutput, ordinary);
	assert.notEqual(native.structuredOutput, input);
	assert.equal(Object.hasOwn(native.structuredOutput, "optional"), false);
	assert.deepEqual(input, { result: "retained observation", optional: undefined });
	assert.equal(nativeStructuredObservation(schema, input, "").output?.[0]?.type, "text");
});

it("native observations reject malformed values with the ordinary schema diagnostics", () => {
	const schema = Type.Object({ result: Type.String() }, { additionalProperties: false });
	for (const value of [{ result: 7 }, { result: "valid", unexpected: true }, undefined]) {
		assert.throws(() => nativeStructuredObservation(schema, value, "Invalid observation"), /Observation output does not match its schema:/u);
	}
	assert.throws(() => nativeStructuredObservation(schema, { result: 7 }, "Invalid observation"), /\/result/u);
});

it("activity parent metadata binds the operation response identity without invented issue times", () => {
	const nested = { toolCallId: "outer/child", name: "evidence", taskId: 2, parentToolCallId: "outer", parentTaskId: 1 };
	const activity = {
		view: "activity", format: "compact", sessionId: "storage", conversationId: 1, turns: [], nextCursor: null,
		metadata: { owner: "here", live: true, operation: 1, runningTools: [nested], pending: 0 },
		coverage: { scannedEntries: 0, scannedBytes: 0, complete: true, entryLimitReached: false, scanByteLimitReached: false, byteLimitReached: false, bytes: 0, omittedEntries: 0, metadataTruncated: false },
		detail: "Native nested evidence",
	};
	const checked = structuredObservation(ActivityOutputSchema, activity) as typeof activity;
	assert.deepEqual(checked.metadata.runningTools, [nested]);
	assert.equal(Object.hasOwn(checked.metadata.runningTools[0], "issuedAt"), false);
	for (const invalid of [{ taskId: 0 }, { parentTaskId: 0 }, { parentToolCallId: 7 }]) {
		assert.throws(() => structuredObservation(ActivityOutputSchema, { ...activity, metadata: { ...activity.metadata, runningTools: [{ ...nested, ...invalid }] } }), /does not match its schema/u);
	}
	const hash = (schema: unknown) => createHash("sha256").update(JSON.stringify(schema)).digest("hex");
	assert.equal(HOST_CONTRACT.operations.inspect.response, hash(InspectOutputSchema));
	const withoutParents = structuredClone(InspectOutputSchema);
	const member = withoutParents.anyOf.find((schema) => (schema as typeof ActivityOutputSchema).properties?.view?.const === "activity") as typeof ActivityOutputSchema | undefined;
	assert.ok(member);
	for (const field of ["taskId", "parentToolCallId", "parentTaskId"]) Reflect.deleteProperty(member.properties.metadata.properties.runningTools.items.properties, field);
	assert.notEqual(hash(withoutParents), HOST_CONTRACT.operations.inspect.response);
});

it("live observations validate native nested slots and retained compaction failures", () => {
	const nested = { callId: "outer/child", name: "evidence", taskId: 2, parentCallId: "outer", parentTaskId: 1, arguments: { query: "source" }, status: "running" };
	const failure = { taskId: 3, reason: "manual", error: "Summary failed" };
	const value = { nestedTools: [nested], compactionFailure: failure };
	assert.deepEqual(structuredObservation(LiveStateSchema, value), value);
	structuredObservation(LiveStateSchema, { nestedTools: [{ ...nested, summary: { isError: true, durationMs: 2, error: "tool failed" } }] });
	assert.throws(() => structuredObservation(LiveStateSchema, { nestedTools: [{ ...nested, parentTaskId: 0 }] }), /parentTaskId/u);
	assert.throws(() => structuredObservation(LiveStateSchema, { compactionFailure: { ...failure, reason: "invalid" } }), /reason/u);
	const hash = (schema: unknown) => createHash("sha256").update(JSON.stringify(schema)).digest("hex");
	assert.equal(HOST_CONTRACT.operations.status.response, hash(StatusOutputSchema));
	const withoutNested = structuredClone(LiveStateSchema);
	Reflect.deleteProperty(withoutNested.properties, "nestedTools");
	Reflect.deleteProperty(withoutNested.properties, "compactionFailure");
	assert.notEqual(hash(withoutNested), hash(LiveStateSchema));
});

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

it("validates native response duration and optional task lifecycle timestamps", async (t) => {
	const message = { ...answerMessage("timed response"), durationMs: 7 };
	assert.equal((structuredObservation(AssistantMessageSchema, message) as { durationMs: number }).durationMs, 7);
	structuredObservation(AssistantMessageSchema, { ...message, durationMs: 0 });
	const { durationMs: _duration, ...untimed } = message;
	assert.equal(Object.hasOwn(structuredObservation(AssistantMessageSchema, untimed) as object, "durationMs"), false);
	assert.throws(() => structuredObservation(AssistantMessageSchema, { ...message, durationMs: -1 }), /durationMs/u);
	const { host } = await openRun(t);
	const status = await readConversationStatus(host.harness, fixtureStorageId, host.root().id, {}, BACKGROUND_CONTEXT);
	assert.ok(status);
	const task = { id: 9, kind: "fixture", status: "waiting", background: false, abortRequested: false };
	for (const timing of [{}, { startedAt: 0 }, { startedAt: 100, endedAt: 900_000 }]) {
		const projected = structuredObservation(ConversationStatusSchema, { ...status, tasks: [{ ...task, ...timing }] }) as { tasks: unknown[] };
		assert.deepEqual(projected.tasks, [{ ...task, ...timing }]);
	}
});

for (const withGeneration of [false, true]) it(`projects nested summary usage with generation message=${withGeneration}`, async (t) => {
	const { host } = await openRun(t);
	const usage = { ...answerMessage().usage, reasoning: 0, cacheWrite1h: 0, cost: { ...answerMessage().usage.cost, totalFromProvider: false } };
	const nested = { callId: "outer/child", name: "evidence", taskId: 2, parentCallId: "outer", parentTaskId: 1, arguments: {}, status: "done", summary: { isError: false, durationMs: 0, usage } };
	const raw = {
		nestedTools: [nested, { ...nested, callId: "outer/pending", taskId: 3, status: "pending", summary: undefined }, { ...nested, callId: "outer/unmetered", taskId: 4, summary: { isError: true, error: "Tool failed" } }],
		tools: [{ callId: "outer", name: "codemode", taskId: 1, status: "running", details: { usage } }],
		...(withGeneration ? { generation: { attempt: 1, message: { ...answerMessage(), usage } } } : {}),
	};
	await host.harness.commit(async (tx) => { Object.assign(await tx.doc(LiveDoc, host.root().id), JSON.parse(JSON.stringify(raw))); }, BACKGROUND_CONTEXT);
	const before = await host.harness.snapshot(LiveDoc, host.root().id, BACKGROUND_CONTEXT);
	const status = await host.request("status", { sessionId: fixtureStorageId }) as { conversation: { live: typeof raw } };
	structuredObservation(LiveStateSchema, status.conversation.live);
	structuredObservation(StatusOutputSchema, status);
	const { totalFromProvider: _metadata, ...cost } = usage.cost;
	assert.deepEqual(status.conversation.live.nestedTools[0].summary, { ...nested.summary, usage: { ...usage, cost } });
	assert.deepEqual(status.conversation.live.nestedTools.slice(1), JSON.parse(JSON.stringify(raw.nestedTools.slice(1))));
	assert.deepEqual(status.conversation.live.tools, raw.tools);
	assert.equal(Object.hasOwn(status.conversation.live, "generation"), withGeneration);
	if (withGeneration) assert.deepEqual(status.conversation.live.generation?.message.usage, { ...usage, cost });
	assert.deepEqual(await host.harness.snapshot(LiveDoc, host.root().id, BACKGROUND_CONTEXT), before);
});

it("projects provider usage metadata after an incomplete tool response and a rejected next request", async (t) => {
	const usage = { ...answerMessage().usage, reasoning: 0, cacheWrite1h: 0, cost: { ...answerMessage().usage.cost, totalFromProvider: false } };
	const incomplete = { ...answerMessage(), content: [{ type: "toolCall" as const, id: "", name: "", arguments: {} }], usage, stopReason: "length" as const };
	const failure = { ...answerMessage(), content: [], stopReason: "error" as const, errorMessage: "400 Bad Request: context.messages[0].content[0].id must be a non-empty string" };
	const host = await DurableHost.open(hostOptions(join(fixtureRoot(t), "provider-usage.sqlite"), await scriptedRuntime([incomplete, failure]), fixtureRegistry()), BACKGROUND_CONTEXT);
	t.after(() => host.close());
	const first = await host.submit({ message: "Incomplete response", requestId: "incomplete" });
	const firstOutcome = await host.wait(first.submissionId, BACKGROUND_CONTEXT);
	assert.equal(firstOutcome.status, "done");
	const second = await host.submit({ message: "Next request", requestId: "rejected" });
	assert.equal((await host.wait(second.submissionId, BACKGROUND_CONTEXT)).status, "unanswered");
	await host.harness.commit(async (tx) => { (await tx.doc(UsageDoc, host.root().id)).tools.fixture = usage; }, BACKGROUND_CONTEXT);
	const raw = await host.harness.snapshot(UsageDoc, host.root().id, BACKGROUND_CONTEXT);
	assert.ok(raw);
	const key = `${incomplete.provider}/${incomplete.model}`;
	assert.equal((raw.models[key].cost as typeof usage.cost).totalFromProvider, false);
	for (const withLiveMessage of [false, true]) {
		if (withLiveMessage) await host.harness.commit(async (tx) => { (await tx.doc(LiveDoc, host.root().id)).generation = JSON.parse(JSON.stringify({ attempt: 1, message: incomplete })); }, BACKGROUND_CONTEXT);
		const status = await host.request("status", { sessionId: fixtureStorageId }) as { conversation: { usage: typeof raw; live: { generation?: { message?: typeof incomplete } } } };
		structuredObservation(ConversationStatusSchema, status.conversation);
		structuredObservation(StatusOutputSchema, status);
		structuredObservation(StatusToolOutputSchema, status);
		assert.equal(Object.hasOwn(status.conversation.usage.models[key].cost, "totalFromProvider"), false);
		assert.equal(status.conversation.usage.models[key].reasoning, 0);
		assert.equal(status.conversation.usage.models[key].cacheWrite1h, 0);
		const { totalFromProvider: _metadata, ...cost } = raw.models[key].cost as typeof usage.cost;
		assert.deepEqual(status.conversation.usage.models[key], { ...raw.models[key], cost });
		const { totalFromProvider: _toolMetadata, ...toolCost } = usage.cost;
		assert.deepEqual(status.conversation.usage.tools.fixture, { ...usage, cost: toolCost });
		if (withLiveMessage) {
			assert.deepEqual(status.conversation.live.generation?.message?.content, incomplete.content);
			assert.equal(Object.hasOwn(status.conversation.live.generation?.message?.usage.cost ?? {}, "totalFromProvider"), false);
		}
	}
	const result = await host.request("inspect", { view: "result", submissionId: second.submissionId });
	structuredObservation(InspectOutputSchema, result);
	assert.deepEqual(await host.harness.snapshot(UsageDoc, host.root().id, BACKGROUND_CONTEXT), raw);
	assert.ok(firstOutcome.answerEntryId);
	const retained = await host.root().entries({ minEntryId: firstOutcome.answerEntryId, maxEntryId: firstOutcome.answerEntryId }, 1, undefined, BACKGROUND_CONTEXT);
	const retainedMessage = retained.items[0]?.model?.[0];
	assert.ok(retainedMessage);
	assert.equal((retainedMessage as typeof incomplete).usage.cost.totalFromProvider, false);
});

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
	const missing = await readInspection(harness, fixtureStorageId, conversation, { view: "result", operationId: "missing" }, BACKGROUND_CONTEXT);
	structuredObservation(InspectOutputSchema, missing);
	assert.equal((missing as { status: string }).status, "unavailable");
	assert.equal((missing as { operationId: string }).operationId, "missing");
	assert.equal(Object.hasOwn(missing as object, "submissionId"), false);
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
	assert.deepEqual(structuredObservation(NativeListOutputSchema, page), page);
	assert.equal(page.items.length, 1);
	const row = page.items[0];
	assert.ok(row);
	const merged = structuredObservation(ListRowSchema, { ...row, sessionId: row.identity, storageId: fixtureStorageId, cwd: "/work" });
	assert.equal(merged.sessionId, fixtureStorageId);
	for (const invalid of [{ items: [{ identity: row.identity }], next: null }, { items: [merged], next: null }, { items: page.items }, { items: page.items, next: "retired-cursor" }]) {
		assert.throws(() => structuredObservation(NativeListOutputSchema, invalid), /Observation output does not match its schema/u);
	}

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
	const listed = structuredObservation(ProfiledListOutputSchema, await manager.list({}));
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
	const unavailable = structuredObservation(ProfiledListOutputSchema, await failing.list({}));
	assert.deepEqual(unavailable.rows, []);
	assert.equal(unavailable.coverage.unavailable.length, 1);
	assert.match(unavailable.coverage.unavailable[0]?.reason ?? "", /unavailable/u);
});

it("recovery health accepts retained failures without timestamps and timed compaction retries", () => {
	const retained = { reason: "manual" as const, errorMessage: "Summary failed" };
	const row = { id: "storage", storageId: "storage", cwd: "/work", modifiedAt: 0, owner: "here" as const, state: "failed" as const, cost: 0, partial: false };
	const metadata = { owner: "here", live: true, operation: null, runningTools: [], pending: 0 };
	for (const failure of [retained, { ...retained, at: "2026-01-01T00:00:00.000Z" }]) {
		const summary = { ...row, health: { compactionFailure: failure } };
		assert.deepEqual(nativeStructuredObservation(AgentConversationSummarySchema, summary, "Recovery health").structuredOutput, summary);
		const activity = { ...metadata, compactionFailure: failure };
		assert.deepEqual(structuredObservation(ActivityOutputSchema.properties.metadata, activity), activity);
		const overview = { ...buildStatusOverview(rosterPage([row]), [], []), sessions: [summary] };
		structuredObservation(StatusToolOutputSchema, overview);
	}
	assert.throws(() => structuredObservation(AgentConversationSummarySchema, { ...row, health: { compactionFailure: { ...retained, at: 7 } } }), /\/health\/compactionFailure\/at/u);
	assert.throws(() => structuredObservation(ActivityOutputSchema.properties.metadata, { ...metadata, compactionFailure: { ...retained, at: 7 } }), /\/compactionFailure\/at/u);
	const hash = (schema: unknown) => createHash("sha256").update(JSON.stringify(schema)).digest("hex");
	assert.equal(HOST_CONTRACT.operations.dashboard.response, hash(AgentConversationSummarySchema));
	const requiredTimestamp = structuredClone(AgentConversationSummarySchema);
	const required: string[] | undefined = requiredTimestamp.properties.health.properties.compactionFailure.required;
	assert.ok(required);
	required.push("at");
	assert.notEqual(hash(requiredTimestamp), HOST_CONTRACT.operations.dashboard.response);
});

it("validates the starting roster row and no-target status overview", () => {
	const row = { id: "new-storage", storageId: "new-storage", cwd: "/work", firstMessage: "New task", model: { provider: "test", modelId: "model", thinkingLevel: "high" }, modifiedAt: 0, owner: "unknown" as const, state: "starting" as const, cost: 0, partial: false };
	structuredObservation(AgentConversationSummarySchema, row);
	const overview = buildStatusOverview(rosterPage([row]), [], []);
	structuredObservation(StatusToolOutputSchema, overview);
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
	structuredObservation(StatusOutputSchema, { conversation: status, live: false, storageId: fixtureStorageId });
	structuredObservation(StatusOutputSchema, { conversations: [status], live: false, storageId: fixtureStorageId });
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
			if (method === "status") return { conversation: status, live: false, storageId: fixtureStorageId };
			throw new Error("observation unavailable");
		},
	});
	t.after(() => manager.close());
	const record = manager.catalog.create({ cwd: "/work", agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: "test", modelId: "model" }, thinkingLevel: "off", ownerId: "owner-1" });
	const rows = await readDashboard(host.harness, fixtureStorageId, {}, { owner: "here", cwd: "/work" }, BACKGROUND_CONTEXT);
	manager.catalog.updateView(record.storageId, boundCatalogView({ updatedAt: new Date().toISOString(), rows: rows.map((row) => ({ ...row, storageId: record.storageId })), storageId: record.storageId }));
	const overview = structuredObservation(StatusToolOutputSchema, buildStatusOverview(await manager.dashboardPage(), [], [])) as { sessions: readonly { state: string }[]; coverage: { complete: boolean; bytes: number } };
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
	const unavailable = structuredObservation(StatusToolOutputSchema, buildStatusOverview(await failing.dashboardPage(), [], [])) as { sessions: readonly { state: string; owner: string; error?: string; partial: boolean }[] };
	const unavailableRow = unavailable.sessions.find((row) => row.state === "unavailable");
	assert.ok(unavailableRow);
	assert.equal(unavailableRow?.partial, true);
	assert.match(unavailableRow?.error ?? "", /unavailable/u);
});
