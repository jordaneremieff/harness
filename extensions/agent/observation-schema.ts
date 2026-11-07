import { str, num, int, bool, nul, lit, union, arr, opt, obj, nullable, map, type Static, type Schema } from "@earendil-works/pi-schema";
/**
 * Exact JSON schemas for the native Durable observation surface.
 *
 * These describe the current JSON that `DurableHost`/`DurableObservation` return
 * and that `AgentManager` aggregates for the primary tools. The primary tools
 * import these schemas for ordinary `outputSchema`/`structuredContent` and native
 * `structuredOutputSchema`/`structuredOutput` contracts. Neither path maps native
 * observations through an ordinary-session shape.
 *
 * Every object schema closes its properties. Optional properties are absent in
 * the JSON round trip, never present with an undefined value. Open-ended
 * identifier strings (`provider`, `api`, `kind`) are strings because providers
 * and task authors choose them; arbitrary JSON payloads use the recursive
 * `JsonValueSchema`, which validates JSON exactly rather than accepting
 * anything.
 */
import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { matchesSchema, schemaErrors } from "./schema-check.ts";
import { FleetStatusSchema } from "./fleet-status.ts";
import { OrdinaryPrimaryObservationSchema } from "./primary-observation.ts";
import { EffortAwarenessSchema } from "./effort-schema.ts";
import { CreatedAgentsSchema } from "./agent-lineage.ts";
import { CommunicationViewSchema } from "./communication.ts";
import { AwaitFactSchema } from "./await-facts.ts";
import { ProviderBlockFactSchema } from "./provider-block-facts.ts";

const string = str();
const boolean = bool();
const number = num();
const count = int({ minimum: 0 });
const id = int({ minimum: 1 });
const nullableText = nullable(string);
const nullableCount = nullable(count);
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const thinkingLevel = union(thinkingLevels.map((level) => lit(level)));
const stopReasons = ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"] as const;
const textRoles = ["user", "assistant", "toolResult", "system"] as const;

/** Exact JSON value; no arbitrary unknown leaves. */
export const JsonValueSchema: Schema<JsonValue> = {
	$defs: { Json: { $id: "Json", anyOf: [nul(), boolean, number, string, arr({ $ref: "Json" }), map({ $ref: "Json" })] } },
	$ref: "Json",
};
const jsonObject = map(JsonValueSchema);
const cursorSchema = jsonObject;

const modelCost = obj({ input: number, output: number, cacheRead: number, cacheWrite: number, total: number, totalFromProvider: opt(boolean) });
export const UsageSchema = obj({
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	cacheWrite1h: opt(number),
	reasoning: opt(number),
	totalTokens: number,
	cost: modelCost,
});
export const UsageStateSchema = obj({ models: map(UsageSchema), tools: map(UsageSchema) });

const textContent = obj({ type: lit("text"), text: string, textSignature: opt(string) });
const imageContent = obj({ type: lit("image"), data: string, mimeType: string });
const thinkingContent = obj({ type: lit("thinking"), thinking: string, thinkingSignature: opt(string), redacted: opt(boolean) });
const toolCallContent = obj({ type: lit("toolCall"), id: string, name: string, arguments: jsonObject, argumentsError: opt(string), thoughtSignature: opt(string), namespace: opt(string) });
const userInputContent = union([string, arr(union([textContent, imageContent]))]);

const diagnosticError = obj({ name: opt(string), message: string, stack: opt(string), code: opt(union([string, number])) });
const assistantDiagnostic = obj({ type: string, timestamp: number, error: opt(diagnosticError), details: opt(jsonObject) });
const deferredHandle = obj({ provider: string, modelId: string, api: string, id: string, expiresAt: opt(number), pollAfterMs: opt(number), data: opt(JsonValueSchema) });
export const AssistantMessageSchema = obj({
	role: lit("assistant"),
	content: arr(union([textContent, thinkingContent, toolCallContent])),
	api: string,
	provider: string,
	model: string,
	responseModel: opt(string),
	responseId: opt(string),
	providerThinkingLevel: opt(string),
	thinkingLevel: opt(thinkingLevel),
	diagnostics: opt(arr(assistantDiagnostic)),
	usage: UsageSchema,
	stopReason: union(stopReasons.map((reason) => lit(reason))),
	deferred: opt(deferredHandle),
	errorMessage: opt(string),
	rawStopReason: opt(string),
	endTurn: opt(boolean),
	timestamp: number,
	durationMs: opt(count),
});

const toolDiagnostic = obj({ severity: union([lit("info"), lit("warn"), lit("error")]), message: string, code: opt(string) });
const toolSlot = obj({
	callId: string,
	name: string,
	taskId: opt(id),
	unoffered: opt(lit(true)),
	status: union([lit("pending"), lit("running"), lit("done")]),
	output: opt(string),
	droppedBytes: opt(count),
	droppedLines: opt(count),
	details: opt(JsonValueSchema),
	diagnostics: opt(arr(toolDiagnostic)),
	entry: opt(id),
});
const nestedToolSlot = obj({
	callId: string,
	name: string,
	taskId: id,
	parentCallId: string,
	parentTaskId: id,
	arguments: jsonObject,
	status: union([lit("pending"), lit("running"), lit("done")]),
	output: opt(string),
	droppedBytes: opt(count),
	droppedLines: opt(count),
	details: opt(JsonValueSchema),
	diagnostics: opt(arr(toolDiagnostic)),
	summary: opt(obj({ isError: boolean, durationMs: opt(number), usage: opt(UsageSchema), error: opt(string) })),
});
const compactionTrigger = union([lit("manual"), lit("threshold"), lit("overflow")]);
const runFailureReasons = ["model_error", "no_model", "aborted", "reset", "faulted", "orphaned", "interrupted", "restart_limit", "nothing_to_answer", "turn_limit"] as const;
const compactionStatus = obj({
	taskId: id,
	trigger: compactionTrigger,
	blocking: boolean,
	attempt: count,
	retry: opt(obj({ at: number, error: string })),
});
export const LiveStateSchema = obj({
	run: opt(obj({ taskId: id, inputs: arr(id), turns: count, first: opt(id), afterRun: opt(obj({ tasks: opt(arr(id)) })) })),
	generation: opt(
		obj({
			attempt: count,
			message: opt(AssistantMessageSchema),
			retry: opt(obj({ at: number, error: string })),
			deferred: opt(obj({ pollAt: number })),
		}),
	),
	tools: opt(arr(toolSlot)),
	nestedTools: opt(arr(nestedToolSlot)),
	compactions: opt(arr(compactionStatus)),
	compactionFailure: opt(obj({ taskId: id, trigger: compactionTrigger, error: string })),
	runFailure: opt(obj({ taskId: id, inputs: arr(id), reason: union(runFailureReasons.map((reason) => lit(reason))), detail: opt(string), first: opt(id) })),
});

const inboxItem = union([
	obj({ id, mode: union([lit("steer"), lit("followUp")]), content: userInputContent, entry: opt(jsonObject) }),
	obj({ id, mode: lit("write"), entry: jsonObject }),
]);
export const InboxStateSchema = obj({ items: arr(inboxItem) });

/** One pending scheduled input as reported by status. */
const timerStatusRow = obj({
	id,
	target: string,
	deadline: number,
	mode: union([lit("followUp"), lit("steer")]),
	status: union([lit("pending"), lit("unsettled")]),
	overdue: boolean,
});

/** One conversation's observation status, as returned by every status variant. */
export const ConversationStatusSchema = obj({
	providerBlock: opt(ProviderBlockFactSchema),
	conversationId: id,
	identity: string,
	name: opt(string),
	owner: opt(string),
	firstMessage: opt(string),
	busy: boolean,
	cwd: opt(string),
	lastText: nullableText,
	lastTextRole: opt(union(textRoles.map((role) => lit(role)))),
	live: nullable(LiveStateSchema),
	inbox: nullable(InboxStateSchema),
	usage: opt(UsageStateSchema),
	agent: obj({
		model: opt(obj({ provider: string, modelId: string })),
		thinkingLevel,
		extensions: arr(string),
		tools: arr(string),
		cwd: opt(string),
		instructions: opt(string),
	}),
	tasks: arr(
		obj({
			id,
			kind: string,
			status: union([lit("running"), lit("pending"), lit("waiting"), lit("sleeping"), lit("completing"), lit("blocked")]),
			background: boolean,
			owner: opt(id),
			abortRequested: boolean,
			startedAt: opt(number),
			endedAt: opt(number),
		}),
	),
	submissions: arr(
		obj({
			id,
			type: union([lit("input"), lit("write"), lit("continue")]),
			status: union([lit("queued"), lit("placed"), lit("done"), lit("unanswered")]),
			requestId: opt(string),
			entryId: opt(id),
			answerEntryId: opt(id),
			reason: opt(string),
		}),
	),
	/** Bounded pending scheduled inputs, nearest deadline first. */
	timers: opt(arr(timerStatusRow)),
	awaiting: opt(AwaitFactSchema),
	forkSource: opt(obj({ conversationId: id, at: id })),
	ownerTaskId: opt(id),
});

const compactionFailure = obj({ trigger: compactionTrigger, errorMessage: opt(string), at: opt(string) });
const autoRetry = obj({ attempt: count, maxAttempts: count, delayMs: count, errorMessage: string });
const dashboardHealth = obj({ lastError: opt(string), compactionFailure: opt(compactionFailure), autoRetry: opt(autoRetry) });

/** One dashboard roster row, including host startup and unavailable storage. */
export const AgentConversationSummarySchema = obj({
	id: string,
	storageId: string,
	name: opt(string),
	firstMessage: opt(string),
	cwd: string,
	model: opt(obj({ provider: string, modelId: string, thinkingLevel: string })),
	modifiedAt: number,
	owner: union([lit("here"), lit("unavailable"), lit("unknown")]),
	ownerLabel: opt(string),
	state: union([lit("starting"), lit("working"), lit("idle"), lit("done"), lit("failed"), lit("stopped"), lit("interrupted"), lit("new"), lit("unavailable")]),
	cost: number,
	partial: boolean,
	latestReply: opt(string),
	error: opt(string),
	toolCalls: opt(count),
	currentTool: opt(obj({ name: string, argument: string })),
	durationMs: opt(number),
	health: opt(dashboardHealth),
	awaiting: opt(AwaitFactSchema),
});

/** What one session host installed, as reported by status. */
export const DurableInventorySchema = obj({
	contributions: arr(obj({
		name: string,
		source: string,
		commands: arr(obj({ name: string, description: string })),
		display: opt(obj({ version: lit(1), entry: string, export: lit("toolDisplay") })),
		panel: opt(obj({ version: lit(1), entry: string, export: lit("operatorPanel"), command: string })),
	})),
	ordinaryOnly: arr(string),
	/** Present only when at least one configured extension failed to load. */
	failed: opt(arr(obj({ path: string, error: string }))),
});

/** Models the host's configured runtime currently reports as available, from its last-known snapshot. */
export const ModelChoicesSchema = obj({
	models: arr(obj({ provider: string, modelId: string, name: opt(string), reasoning: boolean, contextWindow: opt(number) })),
	/** The runtime read this list came from; it performs no credential or network probe. */
	source: lit("available-snapshot"),
	/** The runtime's last availability error, when it reported one. */
	error: opt(string),
	observedAt: string,
});

/** One manager list row: the native summary plus its catalog and external identity. */
export const ListRowProperties = {
	conversationId: id,
	identity: string,
	name: opt(string),
	owner: opt(string),
	firstMessage: opt(string),
	busy: boolean,
	forkSource: opt(obj({ conversationId: id, at: id })),
	ownerTaskId: opt(id),
	sessionId: string,
	storageId: string,
	cwd: string,
};
export const ListRowSchema = obj(ListRowProperties);

const { sessionId: _sessionId, storageId: _storageId, cwd: _cwd, ...nativeListRowProperties } = ListRowProperties;
export const NativeListRowSchema = obj(nativeListRowProperties);

/** The host list page contains native summaries, before the manager adds catalog fields. */
export const NativeListOutputSchema = obj({
	items: arr(NativeListRowSchema),
	next: nullable(cursorSchema),
});

/** `agent_list` output: the manager's bounded catalog scan over native list rows. */
export const ListCoverageProperties = {
	complete: boolean,
	storagesVisited: count,
	unavailable: arr(obj({ storageId: string, reason: string })),
};
export const ListOutputProperties = {
	rows: arr(ListRowSchema),
	nextCursor: nullableText,
	coverage: obj(ListCoverageProperties),
	observedAt: string,
	authority: string,
};
export const ListOutputSchema = obj(ListOutputProperties);
export type ListOutput = Static<typeof ListOutputSchema>;

const catalogPriorityCoverage = obj({ candidates: count, inspected: count, unreadable: count, unknownClaims: count, returned: count, remaining: count, priorityRemaining: count,
	remainingRows: count, priorityRemainingRows: count, recordByteLimit: count, claimByteLimit: count, outputLimit: count });

/**
 * `agent_status` union:
 * - compact manager overview: priority rows, bounded samples, summary counts, and explicit coverage;
 * - live host status with inventory: `{conversation|conversations, inventory, pid, storageId}`;
 * - cold storage status: retained conversations with `live: false` and `storageId`;
 *   loaded inventory and process identity are unknown and absent;
 * - a bare `{conversation}` from the native attach path.
 * A host status carries `deliveryError` while a retained delivery cannot reach
 * its owner, with the reason and the restart that clears it.
 * A conversation status carries `timers`: its bounded pending scheduled inputs,
 * nearest deadline first, with `overdue` set when the deadline has passed.
 */
const statusOverviewCoverage = { complete: boolean, storagesVisited: count, skipped: count, omitted: count, omittedPrimaries: count, omittedFailures: count, bytes: count, byteLimitReached: boolean, nextCursor: nul(), reasons: arr(string) };
const statusProperties = [
	{
		sessions: arr(AgentConversationSummarySchema),
		primaries: arr(
			obj({
				sessionId: string,
				cwd: string,
				name: opt(string),
				model: opt(obj({ provider: string, modelId: string })),
				thinkingLevel: opt(thinkingLevel),
			}),
		),
		failures: arr(obj({ storageId: string, error: string })),
		summary: obj({
			sessions: obj({ observed: count, working: count, attention: count, quiet: count, summarizedQuiet: count }),
			primaries: obj({ observed: count, summarized: count }),
			failures: obj({ observed: count, summarized: count }),
		}),
		coverage: obj(statusOverviewCoverage),
		observedAt: string,
		discovery: string,
	},
	{ conversation: ConversationStatusSchema, inventory: DurableInventorySchema, pid: id, storageId: string, deliveryError: opt(string) },
	{ conversation: ConversationStatusSchema, live: lit(false), storageId: string, deliveryError: opt(string) },
	{ conversations: arr(ConversationStatusSchema), inventory: DurableInventorySchema, pid: id, storageId: string, deliveryError: opt(string) },
	{ conversations: arr(ConversationStatusSchema), live: lit(false), storageId: string, deliveryError: opt(string) },
	{ conversation: ConversationStatusSchema }
] as const;
export const StatusOutputSchema = union([
	obj(statusProperties[0]), obj(statusProperties[1]), obj(statusProperties[2]),
	obj(statusProperties[3]), obj(statusProperties[4]), obj(statusProperties[5]),
]);
export type StatusOutput = Static<typeof StatusOutputSchema>;

/** Tool-only local observations extend status without changing the host response contract. */
const awarenessProperties = { awareness: opt(EffortAwarenessSchema) };
const ToolStatusSchema = union([
	obj({ ...statusProperties[0], ...awarenessProperties, coverage: obj({ ...statusOverviewCoverage, inventory: catalogPriorityCoverage, omittedPriorityRows: count, omittedPriorityRecords: count }) }),
	obj({ ...statusProperties[1], ...awarenessProperties }),
	obj({ ...statusProperties[2], ...awarenessProperties }),
	obj({ ...statusProperties[3], ...awarenessProperties, createdAgents: opt(CreatedAgentsSchema) }),
	obj({ ...statusProperties[4], ...awarenessProperties, createdAgents: opt(CreatedAgentsSchema) }),
	obj({ ...statusProperties[5], ...awarenessProperties }),
]);
export const StatusToolOutputSchema = union([ToolStatusSchema, FleetStatusSchema, OrdinaryPrimaryObservationSchema]);

const entrySource = union([lit("user"), lit("assistant"), lit("toolResult"), lit("summary"), lit("custom")]);
const messageRole = union([lit("system"), lit("user"), lit("assistant"), lit("toolResult")]);
const omissions = obj({ providerSignatures: count, imagePayloads: count, redactedThinking: count });

const entryRowFields = {
	id,
	kind: string,
	source: entrySource,
	role: opt(messageRole),
	text: string,
	truncated: boolean,
	omissions: opt(omissions),
};
const rawEntryRow = obj({
	...entryRowFields,
	preview: opt(obj({ text: string, truncated: boolean })),
	nextOffset: nullableCount,
});
/** Explicit compact semantics, including text-only entries. */
export const CompactEntryRowSchema = obj({
	...entryRowFields,
	communication: CommunicationViewSchema,
	format: lit("compact"),
	nextOffset: nul(),
	toolCalls: opt(arr(obj({ callId: opt(string), name: string, arguments: string, truncated: boolean }), { maxItems: 8 })),
	toolResults: opt(arr(obj({ callId: opt(string), name: string, text: string, isError: boolean, truncated: boolean, durationMs: opt(count) }), { maxItems: 8 })),
	omittedParts: opt(count),
});
export const DurableEntryRowSchema = union([CompactEntryRowSchema, rawEntryRow]);

const historyFields = {
	sessionId: string,
	conversationId: id,
	nextCursor: nullable(cursorSchema),
	order: lit("newestFirst"),
	detail: string,
};
/** Compact history has a page discriminator even when no entries exist; branch stays raw. */
export const HistoryOutputSchema = union([
	obj({ ...historyFields, view: lit("history"), format: lit("compact"), entries: arr(CompactEntryRowSchema) }),
	obj({ ...historyFields, view: lit("branch"), entries: arr(rawEntryRow) }),
]);

const searchMatch = obj({ entryId: id, kind: string, source: entrySource, matchOffset: count, excerpt: string, excerptText: string, truncated: boolean });
const searchCursor = obj({ cursor: nullable(cursorSchema), skip: count, scannedBytes: count });
export const SearchOutputSchema = obj({
	view: lit("search"),
	sessionId: string,
	conversationId: id,
	matches: arr(searchMatch),
	nextCursor: nullable(searchCursor),
	coverage: obj({ scannedEntries: count, scannedBytes: count, complete: boolean }),
	detail: string,
});

export const ExactOutputSchema = obj({
	view: lit("exact"),
	sessionId: string,
	conversationId: id,
	entryId: id,
	offset: count,
	text: string,
	nextOffset: nullableCount,
	truncated: boolean,
	omissions: opt(omissions),
});

const runningTool = obj({
	toolCallId: string,
	name: string,
	taskId: opt(id),
	parentToolCallId: opt(string),
	parentTaskId: opt(id),
	issuedAt: opt(string),
	elapsedMs: opt(count),
	elapsedFrom: opt(lit("tool-call-entry")),
});
export const ActivityOutputSchema = obj({
	view: lit("activity"),
	format: lit("compact"),
	sessionId: string,
	conversationId: id,
	turns: arr(obj({ entries: arr(CompactEntryRowSchema) })),
	nextCursor: nullable(cursorSchema),
	metadata: obj({
		owner: union([lit("here"), lit("unavailable"), lit("unknown")]),
		live: boolean,
		operation: nullable(id),
		runningTools: arr(runningTool),
		pending: nullableCount,
		streamedText: opt(string),
		lastError: opt(string),
		compactionFailure: opt(compactionFailure),
		autoRetry: opt(autoRetry),
	}),
	coverage: obj({
		scannedEntries: count,
		scannedBytes: count,
		complete: boolean,
		entryLimitReached: boolean,
		scanByteLimitReached: boolean,
		byteLimitReached: boolean,
		bytes: count,
		omittedEntries: count,
		metadataTruncated: boolean,
	}),
	detail: string,
});

const RetainedResultOutputSchema = obj({
	providerBlock: opt(ProviderBlockFactSchema),
	recoveryOf: opt(string),
	view: lit("result"),
	sessionId: string,
	conversationId: id,
	submissionId: id,
	status: union([lit("queued"), lit("placed"), lit("done"), lit("unanswered")]),
	requestId: opt(string),
	operationId: opt(string),
	entryId: opt(id),
	answerEntryId: opt(id),
	reason: opt(string),
	answer: opt(string),
	usage: UsageStateSchema,
});

export const ResultOutputSchema = union([RetainedResultOutputSchema, obj({
	view: lit("result"),
	sessionId: string,
	conversationId: id,
	status: lit("unavailable"),
	requestId: opt(string),
	submissionId: opt(id),
	operationId: opt(string),
	reason: string,
	usage: UsageStateSchema,
})]);

/** `agent_inspect` output: one shape per view, selected by the `view` property. */
export const InspectOutputSchema = union([HistoryOutputSchema, SearchOutputSchema, ExactOutputSchema, ActivityOutputSchema, ResultOutputSchema]);
export type InspectOutput = Static<typeof InspectOutputSchema>;
/** Tool routing also accepts ordinary retained evidence; the native host contract stays separate. */
export const InspectToolOutputSchema = union([InspectOutputSchema, OrdinaryPrimaryObservationSchema]);

/** The schema for one observation method, shared by ordinary and native tool declarations. */
export function observationSchema(method: "list" | "status" | "inspect"): Schema {
	switch (method) {
		case "list":
			return ListOutputSchema;
		case "status":
			return StatusOutputSchema;
		case "inspect":
			return InspectOutputSchema;
	}
}

/** Select the structurally relevant union member for an actionable error path. */
type DiagnosticBranch = Schema & { anyOf?: Schema[]; properties?: Record<string, Schema>; required?: string[] };

function diagnosticSchema(schema: object, value: unknown): object {
	const branch = schema as DiagnosticBranch;
	if (!Array.isArray(branch.anyOf) || value === null || typeof value !== "object" || Array.isArray(value)) return schema;
	const record = value as Record<string, unknown>;
	const candidates = (branch.anyOf as DiagnosticBranch[]).filter((candidate) => candidate.properties);
	candidates.sort((left, right) => diagnosticScore(right, record) - diagnosticScore(left, record));
	return candidates[0] ?? schema;
}

function diagnosticScore(schema: DiagnosticBranch, record: Record<string, unknown>): number {
	let score = 0;
	for (const key of schema.required ?? []) score += Object.hasOwn(record, key) ? 2 : -2;
	for (const [key, property] of Object.entries(schema.properties as Record<string, Schema>)) {
		if (!Object.hasOwn(record, key)) continue;
		score += Object.hasOwn(property, "const") ? record[key] === (property as Schema & { const?: unknown }).const ? 100 : -100 : 1;
	}
	return score;
}

/** JSON-round-trip and validate an observation, with schema paths on mismatch. */
export function structuredObservation<T extends object>(schema: T, value: unknown): Static<T> {
	const parsed: unknown = JSON.parse(JSON.stringify(value ?? null));
	if (!matchesSchema(schema, parsed)) {
		const detail = schemaErrors(diagnosticSchema(schema, parsed), parsed, 5);
		throw new Error(`Observation output does not match its schema: ${detail.join("; ")}`);
	}
	return parsed as Static<T>;
}

/** Keep model text and validated program output on the native result's separate channels. */
export function nativeStructuredObservation<T extends object>(schema: T, value: unknown, text: string): ToolExecutionResult & { readonly structuredOutput: Static<T> } {
	return {
		output: [{ type: "text", text }],
		structuredOutput: structuredObservation(schema, value) as Static<T> & JsonValue,
	};
}
