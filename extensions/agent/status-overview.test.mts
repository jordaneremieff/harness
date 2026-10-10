import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentConversationPage, AgentConversationSummary } from "./dashboard-types.ts";
import type { AwaitFact } from "./await-facts.ts";

const awaiting: AwaitFact = {
	runId: 1, heldInputs: [2], results: [{ result: { sessionId: "producer:3", submissionId: 4, requestId: "exact-request" }, status: "pending" }],
	queuedInputCount: 1, queueSnapshot: "committed InboxDoc", omitted: { heldInputs: 0, results: 0 },
	producers: [{ sessionId: "producer:3", observedAt: 1, source: "producer await-state", unavailable: "Source connection closed" }],
	omittedProducers: 0, likelyCycle: [], coverage: "one hop; remote graph incomplete",
};
import {
	AgentConversationSummarySchema,
	AssistantMessageSchema,
	ConversationStatusSchema,
	DurableInventorySchema,
	InboxStateSchema,
	LiveStateSchema,
	StatusOutputSchema,
	structuredObservation,
	UsageSchema,
	UsageStateSchema,
} from "./observation-schema.ts";
import { buildStatusOverview, STATUS_OVERVIEW_BYTE_LIMIT, STATUS_OVERVIEW_DISCOVERY } from "./status-overview.ts";

function summary(index: number, fields: Partial<AgentConversationSummary> = {}): AgentConversationSummary {
	return {
		id: `agent-${index}`,
		storageId: `agent-${index}`,
		cwd: "/work",
		modifiedAt: index,
		owner: "here",
		state: "idle",
		cost: 0,
		partial: false,
		...fields,
	};
}

function page(
	rows: readonly AgentConversationSummary[],
	complete = true,
	omitted = 0,
	nextCursor: string | null = null,
): AgentConversationPage {
	return {
		rows,
		coverage: { complete, storagesVisited: 1, skipped: 0, omitted, nextCursor },
		observedAt: "2026-10-03T00:00:00.000Z",
	};
}

const measure = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function check(result: ReturnType<typeof buildStatusOverview>): void {
	assert.equal(measure(result), result.coverage.bytes);
	assert.ok(result.coverage.bytes <= STATUS_OVERVIEW_BYTE_LIMIT);
	structuredObservation(StatusOutputSchema, result);
}

it("keeps a small overview complete with an exact strict output schema", () => {
	const result = buildStatusOverview(
		page([summary(1), summary(2)]),
		[{ sessionId: "primary-1", cwd: "/work" }],
		[{ storageId: "agent-9", error: "boom" }],
	);
	assert.equal(result.coverage.complete, true);
	assert.equal(result.coverage.byteLimitReached, false);
	assert.equal(result.discovery, STATUS_OVERVIEW_DISCOVERY);
	assert.ok(result.discovery.includes("Call agent_list without a cursor, then repeat its nextCursor to see more."));
	assert.equal(result.summary.sessions.observed, 2);
	assert.equal(result.summary.sessions.summarizedQuiet, 0);
	assert.deepEqual(result.coverage.reasons, []);
	check(result);
	assert.throws(() => structuredObservation(StatusOutputSchema, { ...result, unexpected: true }));
});

it("puts working and attention before quiet rows, then orders each group by recency and identity", () => {
	const rows = [
		summary(90),
		summary(3, { state: "failed", error: "failure" }),
		summary(2, { state: "working" }),
		summary(1, { state: "starting" }),
		summary(4, { owner: "unavailable" }),
		summary(2, { id: "agent-2-b", state: "working" }),
	];
	const result = buildStatusOverview(page(rows), [], []);
	assert.deepEqual(
		result.sessions.map((row) => row.id),
		["agent-2", "agent-2-b", "agent-1", "agent-4", "agent-3", "agent-90"],
	);
	assert.deepEqual(result.summary.sessions, { observed: 6, working: 3, attention: 2, quiet: 1, summarizedQuiet: 0 });
	assert.deepEqual(
		rows.map((row) => row.id),
		["agent-90", "agent-3", "agent-2", "agent-1", "agent-4", "agent-2-b"],
	);
	check(result);
});

it("retains every coordinator field on live rows with short Unicode-safe text excerpts", () => {
	const text = "😀".repeat(1000);
	const row = summary(1, {
		state: "working",
		name: "worker",
		awaiting,
		firstMessage: text,
		latestReply: text,
		model: { provider: "test", modelId: "model", thinkingLevel: "high" },
		toolCalls: 9,
		currentTool: { name: "read", argument: text },
		durationMs: 321,
		cost: 2,
		partial: true,
		ownerLabel: text,
		error: text,
		health: {
			lastError: text,
			compactionFailure: { reason: "manual", at: "now", errorMessage: text },
			autoRetry: { attempt: 1, maxAttempts: 3, delayMs: 4, errorMessage: text },
		},
	});
	assert.deepEqual(
		Object.keys(row).sort(),
		Object.keys(AgentConversationSummarySchema.properties).sort(),
		"the fixture populates every roster coordinator field",
	);
	const result = buildStatusOverview(page([row]), [], []);
	const live = result.sessions[0];
	const shortened = `${"😀".repeat(159)}…`;
	assert.deepEqual(
		live,
		{
			...row,
			firstMessage: shortened,
			latestReply: shortened,
			ownerLabel: shortened,
			error: shortened,
			currentTool: { name: "read", argument: shortened },
			health: {
				lastError: shortened,
				compactionFailure: { reason: "manual", at: "now", errorMessage: shortened },
				autoRetry: { attempt: 1, maxAttempts: 3, delayMs: 4, errorMessage: shortened },
			},
		},
		"only declared text excerpts change; all coordinator fields and nested values survive",
	);
	for (const key of [
		"id",
		"storageId",
		"name",
		"cwd",
		"modifiedAt",
		"owner",
		"state",
		"cost",
		"partial",
		"model",
		"toolCalls",
		"durationMs",
	] as const)
		assert.deepEqual(live[key], row[key]);
	for (const excerpt of [
		live.firstMessage,
		live.latestReply,
		live.ownerLabel,
		live.error,
		live.currentTool?.argument,
		live.health?.lastError,
		live.health?.compactionFailure?.errorMessage,
		live.health?.autoRetry?.errorMessage,
	]) {
		assert.ok(excerpt);
		assert.ok(Array.from(excerpt).length <= 160);
		assert.ok(excerpt.endsWith("…"));
		assert.ok(!excerpt.includes("\uFFFD"));
	}
	assert.equal(live.currentTool?.name, "read");
	assert.equal(live.health?.autoRetry?.delayMs, 4);
	assert.equal(row.latestReply, text);
	check(result);
});

it("summarizes rarely needed rows instead of silently dropping them", () => {
	const rows = Array.from({ length: 80 }, (_, index) => summary(index, { latestReply: "x".repeat(2000) }));
	const primaries = Array.from({ length: 30 }, (_, index) => ({
		sessionId: `primary-${index}`,
		cwd: "/work",
		name: "p".repeat(2000),
	}));
	const failures = Array.from({ length: 30 }, (_, index) => ({ storageId: `agent-${index}`, error: "f".repeat(2000) }));
	const result = buildStatusOverview(page(rows), primaries, failures);
	assert.equal(result.sessions.length, 5);
	assert.deepEqual(
		result.sessions.map((row) => row.modifiedAt),
		[79, 78, 77, 76, 75],
	);
	assert.equal(result.summary.sessions.quiet, 80);
	assert.equal(result.summary.sessions.summarizedQuiet + result.sessions.length, rows.length);
	assert.equal(result.summary.primaries.summarized + result.primaries.length, primaries.length);
	assert.equal(result.summary.failures.summarized + result.failures.length, failures.length);
	assert.equal(result.coverage.omitted, 0);
	assert.equal(result.coverage.complete, true);
	assert.ok(result.coverage.bytes < 8 * 1024);
	check(result);
});

it("recognizes recovery failures and exhausted retries without treating stopped work as attention", () => {
	const result = buildStatusOverview(
		page([
			summary(9, { state: "stopped" }),
			summary(8, { state: "done" }),
			summary(1, { health: { compactionFailure: { reason: "overflow", at: "now" } } }),
			summary(2, { health: { lastError: "error" } }),
			summary(3, { health: { autoRetry: { attempt: 3, maxAttempts: 3, delayMs: 0, errorMessage: "retry" } } }),
			summary(4, { state: "interrupted" }),
		]),
		[],
		[],
	);
	assert.equal(result.summary.sessions.attention, 3);
	assert.equal(result.summary.sessions.quiet, 3);
	assert.deepEqual(
		result.sessions.map((row) => row.modifiedAt),
		[3, 2, 1, 9, 8, 4],
	);
	check(result);
});

it("keeps the stopped aborted unknown-owner reproduction quiet without dropping retained error text", () => {
	const aborted = summary(9, { state: "stopped", error: "aborted", owner: "unknown" });
	const stopped = summary(8, { state: "stopped", error: "stopped", owner: "unknown" });
	const result = buildStatusOverview(
		page([
			aborted,
			stopped,
			summary(1, { state: "working" }),
			summary(2, { state: "failed", error: "provider failed" }),
			summary(10, { state: "done" }),
		]),
		[],
		[],
	);
	assert.deepEqual(result.summary.sessions, { observed: 5, working: 1, attention: 1, quiet: 3, summarizedQuiet: 0 });
	assert.deepEqual(
		result.sessions.map((row) => row.id),
		["agent-1", "agent-2", "agent-10", "agent-9", "agent-8"],
	);
	assert.deepEqual(
		result.sessions.find((row) => row.id === aborted.id),
		aborted,
		"quiet classification preserves the retained evidence",
	);
	assert.deepEqual(
		result.sessions.find((row) => row.id === stopped.id),
		stopped,
	);
	check(result);
});

it("preserves every dashboard health and ownership attention reason on stopped rows", () => {
	const result = buildStatusOverview(
		page([
			summary(20, {
				state: "stopped",
				error: "aborted",
				health: {
					lastError: "Aborted",
					compactionFailure: { reason: "overflow", at: "now", errorMessage: "compaction failed" },
				},
			}),
			summary(19, {
				state: "stopped",
				error: "aborted",
				health: { autoRetry: { attempt: 3, maxAttempts: 3, delayMs: 0, errorMessage: "provider failed" } },
			}),
			summary(18, { state: "stopped", owner: "unavailable", error: "aborted", health: { lastError: "Aborted" } }),
			summary(17, { state: "stopped", error: "aborted", health: { lastError: "untyped blocked-task error" } }),
			summary(16, {
				state: "stopped",
				error: "aborted",
				health: { autoRetry: { attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "provider retry" } },
			}),
		]),
		[],
		[],
	);
	assert.deepEqual(result.summary.sessions, { observed: 5, working: 0, attention: 4, quiet: 1, summarizedQuiet: 0 });
	assert.deepEqual(
		result.sessions.map((row) => row.id),
		["agent-20", "agent-19", "agent-18", "agent-17", "agent-16"],
	);
	check(result);
});

it("keeps genuine health attention on working and starting rows while sorting healthy work first", () => {
	const result = buildStatusOverview(
		page([
			summary(1, { state: "working" }),
			summary(2, { state: "working", health: { lastError: "host failed" } }),
			summary(3, {
				state: "starting",
				health: { compactionFailure: { reason: "manual", at: "now", errorMessage: "compaction failed" } },
			}),
			summary(4, { state: "starting" }),
			summary(5, { state: "stopped", error: "aborted", owner: "unknown" }),
		]),
		[],
		[],
	);
	assert.deepEqual(result.summary.sessions, { observed: 5, working: 2, attention: 2, quiet: 1, summarizedQuiet: 0 });
	assert.deepEqual(
		result.sessions.map((row) => row.id),
		["agent-4", "agent-1", "agent-3", "agent-2", "agent-5"],
	);
	check(result);
});

it("matches dashboard attention semantics for terminal states and retained error text", () => {
	const rows = [
		summary(8, { state: "unavailable" }),
		summary(7, { state: "failed", error: "failure" }),
		summary(6, { state: "failed" }),
		summary(5, { state: "interrupted" }),
		summary(4, { state: "done", error: "retained error" }),
		summary(3, { state: "idle", error: "retained error" }),
		summary(2, { state: "stopped", error: "aborted", owner: "unknown" }),
	];
	const result = buildStatusOverview(page(rows), [], []);
	assert.deepEqual(result.summary.sessions, { observed: 7, working: 0, attention: 2, quiet: 5, summarizedQuiet: 0 });
	assert.deepEqual(
		result.sessions.map((row) => row.id),
		rows.map((row) => row.id),
	);
	check(result);
});

it("preserves source coverage and states exact incomplete boundaries even without a cursor", () => {
	const source = page([summary(1)], false, 4, "next-page");
	source.coverage.skipped = 2;
	const result = buildStatusOverview(source, [], []);
	assert.equal(result.coverage.nextCursor, null);
	assert.ok(!JSON.stringify(result).includes("next-page"));
	assert.equal(result.coverage.omitted, 4);
	assert.equal(result.coverage.skipped, 2);
	assert.equal(result.coverage.complete, false);
	assert.equal(result.coverage.byteLimitReached, false);
	assert.ok(result.coverage.reasons.some((reason) => reason.includes("2") && reason.includes("storage")));
	assert.ok(result.coverage.reasons.some((reason) => reason.includes("4") && reason.includes("source")));
	check(result);
	const noCursor = buildStatusOverview(page([], false), [], []);
	assert.equal(noCursor.coverage.complete, false);
	assert.ok(noCursor.coverage.reasons.some((reason) => reason.includes("no continuation")));
	check(noCursor);
});

it("never exposes opaque catalog cursors or presents them as agent_list continuations", () => {
	for (const complete of [false, true]) {
		for (const cursor of ["opaque-catalog-cursor-never-public", "opaque-catalog-cursor-".repeat(10000)]) {
			const source = page([], complete, 0, cursor);
			const result = buildStatusOverview(source, [], []);
			const reasons = result.coverage.reasons.join(" ");
			assert.equal(result.coverage.nextCursor, null);
			assert.ok(!JSON.stringify(result).includes(cursor));
			assert.equal(result.coverage.complete, false);
			assert.equal(result.coverage.byteLimitReached, false, "discarded source cursors consume no output byte budget");
			assert.match(reasons, /Source inventory is incomplete/u);
			assert.match(reasons, /agent_status has no continuation parameter/u);
			assert.match(reasons, /fresh agent_list/u);
			assert.doesNotMatch(reasons, /coverage\.nextCursor/u);
			assert.equal(result.summary.sessions.observed, source.rows.length);
			check(result);
			assert.throws(
				() =>
					structuredObservation(StatusOutputSchema, {
						...result,
						coverage: { ...result.coverage, nextCursor: cursor },
					}),
				"the strict status schema also rejects catalog cursors",
			);
		}
	}
});

it("does not claim complete coverage when source counters or cursor contradict complete", () => {
	for (const source of [
		page([], true, 1),
		page([], true, 0, "cursor"),
		{ ...page([]), coverage: { ...page([]).coverage, skipped: 1 } },
	]) {
		const result = buildStatusOverview(source, [], []);
		assert.equal(result.coverage.complete, false);
		assert.ok(result.coverage.reasons.length > 0);
		check(result);
	}
});

it("retains working rows ahead of quiet samples under byte pressure and accounts for every omitted live row", () => {
	const rows = [
		summary(10000),
		...Array.from({ length: 200 }, (_, index) => summary(index, { state: "working", cwd: `/${"p".repeat(400)}` })),
	];
	const result = buildStatusOverview(page(rows, true, 3, "source-cursor"), [], []);
	assert.equal(result.coverage.byteLimitReached, true);
	assert.equal(result.coverage.complete, false);
	assert.equal(result.summary.sessions.summarizedQuiet, 1);
	assert.ok(result.sessions.every((row) => row.state === "working"));
	assert.equal(result.sessions.length + result.coverage.omitted - 3, 200);
	assert.equal(result.coverage.nextCursor, null);
	assert.ok(!JSON.stringify(result).includes("source-cursor"));
	assert.ok(result.coverage.reasons.some((reason) => reason.includes("byte limit") && reason.includes("agent_list")));
	check(result);
});

it("bounds oversized coordinator identities without truncating them into wrong targets", () => {
	const oversized = summary(1, { state: "working", id: "x".repeat(100000) });
	const result = buildStatusOverview(page([oversized, summary(2, { state: "working" })]), [], []);
	assert.deepEqual(
		result.sessions.map((row) => row.id),
		["agent-2"],
	);
	assert.equal(result.coverage.omitted, 1);
	assert.equal(result.coverage.complete, false);
	check(result);
});

it("retains a large newest live row that fits ahead of smaller older rows", () => {
	const newest = summary(1000, { state: "working", cwd: `/${"p".repeat(8500)}` });
	const result = buildStatusOverview(
		page([newest, ...Array.from({ length: 100 }, (_, index) => summary(index, { state: "working" }))]),
		[],
		[],
	);
	assert.equal(result.sessions[0]?.id, newest.id);
	assert.equal(result.sessions[0]?.cwd, newest.cwd);
	assert.equal(result.coverage.byteLimitReached, true);
	assert.equal(result.sessions.length + result.coverage.omitted, 101);
	check(result);
});

it("accounts for byte-excluded primary and failure samples without corrupting identities", () => {
	const primaries = [{ sessionId: "primary", cwd: `/${"x".repeat(100000)}` }];
	const failures = [{ storageId: "x".repeat(100000), error: "failure" }];
	const result = buildStatusOverview(page([summary(1, { state: "working" })]), primaries, failures);
	assert.equal(result.sessions.length, 1);
	assert.equal(result.summary.primaries.summarized, 1);
	assert.equal(result.summary.failures.summarized, 1);
	assert.equal(result.coverage.omittedPrimaries, 1);
	assert.equal(result.coverage.omittedFailures, 1);
	assert.equal(result.coverage.complete, false);
	assert.ok(result.coverage.reasons.some((reason) => reason.includes("1 primary") && reason.includes("1 failure")));
	check(result);
});

it("retains exhaustive coordinator fields in every selected-session status variant without compact projection", () => {
	const fullText = "coordinator detail ".repeat(1000);
	const usage = {
		input: 1,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		cacheWrite1h: 5,
		reasoning: 6,
		totalTokens: 21,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	};
	const message = {
		role: "assistant",
		content: [
			{ type: "text", text: fullText, textSignature: "text-signature" },
			{ type: "thinking", thinking: fullText, thinkingSignature: "thinking-signature", redacted: false },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "/work/file" },
				thoughtSignature: "tool-signature",
				namespace: "native",
			},
		],
		api: "test-api",
		provider: "test",
		model: "model",
		responseModel: "response-model",
		responseId: "response-1",
		providerThinkingLevel: "high",
		thinkingLevel: "high",
		diagnostics: [
			{
				type: "retry",
				timestamp: 1,
				error: { name: "Error", message: fullText, stack: fullText, code: "test" },
				details: { attempt: 1 },
			},
		],
		usage,
		stopReason: "toolUse",
		deferred: {
			provider: "test",
			modelId: "model",
			api: "test-api",
			id: "deferred-1",
			expiresAt: 100,
			pollAfterMs: 10,
			data: { retained: true },
		},
		errorMessage: fullText,
		rawStopReason: "tool-use",
		endTurn: false,
		timestamp: 2,
	};
	const conversation = {
		conversationId: 2,
		identity: "storage:2",
		name: "coordinator",
		owner: "owner:1",
		firstMessage: fullText,
		busy: true,
		cwd: "/work",
		lastText: fullText,
		lastTextRole: "assistant",
		live: {
			run: { taskId: 1, inputs: [2] },
			generation: { attempt: 3, message, retry: { at: 4, error: fullText }, deferred: { pollAt: 5 } },
			tools: [
				{
					callId: "call-1",
					name: "read",
					taskId: 6,
					status: "running",
					output: fullText,
					droppedBytes: 7,
					droppedLines: 8,
					details: { retained: fullText },
					diagnostics: [{ severity: "warn", message: fullText, code: "test" }],
					entry: 9,
				},
			],
			compactions: [
				{ taskId: 10, reason: "threshold", blocking: true, attempt: 2, retry: { at: 11, error: fullText } },
			],
		},
		inbox: {
			items: [
				{ id: 12, mode: "steer", content: fullText },
				{
					id: 13,
					mode: "followUp",
					content: [
						{ type: "text", text: fullText },
						{ type: "image", data: "image-data", mimeType: "image/png" },
					],
				},
				{ id: 14, mode: "write", entry: { retained: fullText } },
			],
		},
		usage: { models: { model: usage }, tools: { read: usage } },
		agent: {
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "high",
			extensions: ["native"],
			tools: ["read"],
			cwd: "/work",
			instructions: fullText,
		},
		tasks: [{ id: 15, kind: "tool", status: "running", background: false, owner: 16, abortRequested: true }],
		submissions: [
			{
				id: 17,
				type: "input",
				status: "placed",
				requestId: "request-1",
				entryId: 18,
				answerEntryId: 19,
				reason: fullText,
			},
		],
		timers: [{ id: 20, target: "storage:2", deadline: 21, mode: "followUp", status: "pending", overdue: false }],
		forkSource: { conversationId: 1, at: 22 },
		awaiting,
		ownerTaskId: 23,
		providerBlock: {
			blockId: "block-1", conversationId: 2, providerSessionId: "provider-session-2", epoch: 0,
			model: { provider: "test", modelId: "model" }, error: fullText.slice(0, 4096),
			errorRedacted: false, errorTruncated: true, source: "provider", timestamp: 2,
			originalResults: [{ sessionId: "storage:2", submissionId: 17, requestId: "request-1" }], omittedOriginalResults: 0,
		},
	};
	const inventory = {
		contributions: [
			{ name: "native", source: "/extension/native.ts", commands: [{ name: "command", description: fullText }] },
		],
		ordinaryOnly: ["ordinary"],
		failed: [{ path: "/extension/failed.ts", error: fullText }],
	};
	for (const [fixture, schema] of [
		[conversation, ConversationStatusSchema],
		[conversation.providerBlock, ConversationStatusSchema.properties.providerBlock],
		[conversation.live, LiveStateSchema],
		[conversation.inbox, InboxStateSchema],
		[conversation.usage, UsageStateSchema],
		[usage, UsageSchema],
		[message, AssistantMessageSchema],
		[inventory, DurableInventorySchema],
	] as const) {
		assert.deepEqual(
			Object.keys(fixture).sort(),
			Object.keys(schema.properties).sort(),
			"the fixture populates every declared coordinator field",
		);
		assert.deepEqual(structuredObservation(schema, fixture), fixture);
	}
	for (const host of [{ pid: 4242, inventory }, { live: false }]) {
		for (const selected of [{ conversation }, { conversations: [conversation] }]) {
			const input = { ...selected, ...host, storageId: "storage", deliveryError: fullText };
			assert.deepEqual(
				structuredObservation(StatusOutputSchema, input),
				input,
				"full selected-session fields stay intact",
			);
		}
	}
	assert.deepEqual(structuredObservation(StatusOutputSchema, { conversation }), { conversation });
});

it("ignores source cursor size and explains the fresh discovery route", () => {
	const result = buildStatusOverview(page([], false, 0, "c".repeat(100000)), [], []);
	assert.equal(result.coverage.nextCursor, null);
	assert.equal(result.coverage.complete, false);
	assert.equal(result.coverage.byteLimitReached, false);
	assert.ok(
		result.coverage.reasons.some(
			(reason) => reason.includes("no continuation parameter") && reason.includes("fresh agent_list"),
		),
	);
	check(result);
});
