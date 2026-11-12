import { str, num, int, bool, nul, lit, union, arr, opt, obj, nullable, map, unknown, type Static, type StaticObject, type Properties, type Schema } from "@earendil-works/pi-schema";
/**
 * Exact JSON schemas for the native Durable observation surface.
 *
 * These describe the current JSON that `DurableHost`/`DurableObservation` return
 * and that `AgentManager` aggregates for the primary tools. The primary tools
 * import these schemas for ordinary `outputSchema`/`structuredContent` and native
 * `structuredOutputSchema`/`structuredOutput` contracts. Neither path maps native
 * observations through an ordinary-session shape.
 *
 * Fixed-shape objects close their properties. Optional properties are absent in
 * the JSON round trip, never present with an undefined value. Open-ended
 * identifier strings (`provider`, `api`, `kind`) are strings because providers
 * and task authors choose them. Response JSON payloads use the recursive
 * `JsonValueSchema`. Tool cursor parameters use an open object declaration;
 * execution validates storage-page inputs separately.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { matchesSchema, schemaErrors } from "./schema-check.ts";
import { FleetStatusSchema, FleetSelectionProperties } from "./fleet-status.ts";
import { OrdinaryPrimaryObservationSchema } from "./primary-observation.ts";
import { EffortAwarenessSchema } from "./effort-schema.ts";
import { CreatedAgentsSchema } from "./agent-lineage.ts";
import { CommunicationViewSchema } from "./communication.ts";
import { AwaitFactSchema } from "./await-facts.ts";
import { STORAGE_STATUS_ID_PATTERN } from "./storage-status.ts";
import { ProviderBlockFactSchema } from "./provider-block-facts.ts";
import { ResultReferenceSchema } from "./result-schema.ts";

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

const storageStatusId = str({ pattern: STORAGE_STATUS_ID_PATTERN });
const storageStatusLimit = int({ minimum: 1, maximum: 50 });
export const StorageStatusPageInputSchema = obj({ view: lit("storage-page"), storageId: storageStatusId, cursor: opt(cursorSchema), limit: opt(storageStatusLimit) });
/** Object-root parameters survive provider conversion; execution validates selector combinations. */
export const StatusToolInputSchema = obj({
	sessionId: opt(str({ minLength: 1, description: "Select one conversation. Omit for the existing overview scope." })),
	detail: opt(bool({ description: "Request full selected status with true and an explicit sessionId. False is equivalent to omission on every view." })),
	view: opt<Schema<"fleet" | "storage-page">>({ type: "string", enum: ["fleet", "storage-page"], description: "Read sampled machine-local model evidence with fleet, without a sessionId. Optional exact model/provider filters select published evidence, not provider health. Use storage-page for one exact storageId." }),
	...FleetSelectionProperties,
	storageId: opt(storageStatusId), cursor: opt(map(unknown(), { description: "Opaque backend cursor. Pass the returned cursor object unchanged." })), limit: opt(storageStatusLimit),
});
export const StorageStatusCoverageSchema = obj({
	complete: boolean, returned: count, scanned: count,
	next: union([nul(), obj({ tool: lit("agent_status"), view: lit("storage-page"), storageId: storageStatusId, cursor: cursorSchema, limit: storageStatusLimit })]),
});

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
	/** Admitted inputs that are still queued, and the age in milliseconds of the oldest one. */
	unplaced: opt(count),
	oldest: opt(count),
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
export const AgentConversationSummaryProperties = {
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
};
export const AgentConversationSummarySchema = obj(AgentConversationSummaryProperties);

/** The overview row: the native row plus the catalog's intervention hint, which no native publication carries. */
export const ToolOverviewRowSchema = obj({
	...AgentConversationSummaryProperties,
	attention: opt(union([lit("provider-blocked"), lit("task-blocked"), lit("failed-turn")])),
});
export type ToolOverviewRow = Static<typeof ToolOverviewRowSchema>;

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

const statusOverviewCoverage = { complete: boolean, storagesVisited: count, skipped: count, omitted: count, omittedPrimaries: count, omittedFailures: count, bytes: count, byteLimitReached: boolean, nextCursor: nul(), reasons: arr(string) };
const overviewProperties = {
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
};
const singlePayload = { conversation: ConversationStatusSchema };
const pluralPayload = { conversations: arr(ConversationStatusSchema), coverage: StorageStatusCoverageSchema };
const liveEnvelope = { inventory: DurableInventorySchema, pid: id, storageId: string, deliveryError: opt(string) };
const coldEnvelope = { live: lit(false), storageId: string, deliveryError: opt(string) };

/**
 * `agent_status` host response:
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
export const StatusOutputSchema = union([
	obj(overviewProperties),
	obj({ ...singlePayload, ...liveEnvelope }),
	obj({ ...singlePayload, ...coldEnvelope }),
	obj({ ...pluralPayload, ...liveEnvelope }),
	obj({ ...pluralPayload, ...coldEnvelope }),
	obj(singlePayload),
]);
export type StatusOutput = Static<typeof StatusOutputSchema>;

/**
 * Tool-only local observations extend status without changing the host response contract. The tool status
 * is a product of independent dimensions instead of one closed object per combination, so each large
 * component is described once:
 * - optional `awareness`, shared by every alternative;
 * - an overview, or a selected status;
 * - a selected status combines a single or plural payload with a live, cold or absent envelope.
 * Component objects are open so they can coexist; a `propertyNames` guard closes each complete alternative,
 * and properties declared `never` state the exclusions between components.
 */
type Intersection<S extends readonly Schema[]> = S extends readonly [infer Head extends Schema, ...infer Tail extends readonly Schema[]] ? Static<Head> & Intersection<Tail> : unknown;

/** An object whose listed properties are required unless `opt()`, and which tolerates other properties. */
function partial<const P extends Properties>(properties: P): Schema<StaticObject<P>> {
	const { additionalProperties: _closed, ...open } = obj(properties);
	return open as Schema<StaticObject<P>>;
}
function all<const S extends readonly Schema[]>(parts: S): Schema<Intersection<S>> {
	return { allOf: parts };
}
/** Rejects every property outside `keys`, closing the product of open components. */
function onlyKeys(keys: readonly string[]): Schema {
	return { propertyNames: { enum: keys } };
}
/** A property that must be absent. */
const absent = opt(false as unknown as Schema<never>);

const toolCoverageProperties = { ...statusOverviewCoverage, inventory: catalogPriorityCoverage, omittedPriorityRows: count, omittedPriorityRecords: count };
const toolOverviewProperties = { ...overviewProperties, sessions: arr(ToolOverviewRowSchema), coverage: obj(toolCoverageProperties) };
const awarenessProperties = { awareness: opt(EffortAwarenessSchema) };
const singleProperties = { ...singlePayload, conversations: absent, createdAgents: absent, coverage: absent };
const pluralProperties = { ...pluralPayload, storageId: string, conversation: absent, createdAgents: opt(CreatedAgentsSchema) };
const liveProperties = { ...liveEnvelope, live: absent };
const coldProperties = { ...coldEnvelope, inventory: absent, pid: absent };
const bareProperties = { inventory: absent, pid: absent, live: absent, storageId: absent, deliveryError: absent };

const toolOverview = all([partial(toolOverviewProperties), onlyKeys([...Object.keys(toolOverviewProperties), "awareness"])]);
const toolSelected = all([
	union([partial(singleProperties), partial(pluralProperties)]),
	union([partial(liveProperties), partial(coldProperties), partial(bareProperties)]),
	onlyKeys(["awareness", "conversation", "conversations", "coverage", "createdAgents", "inventory", "pid", "live", "storageId", "deliveryError"]),
]);
const ToolStatusSchema = all([partial(awarenessProperties), union([toolOverview, toolSelected])]);
/** Exact references stay intact; only descriptive previews are shortened. */
export const CompactAwaitSchema = obj({
	runId: id,
	results: arr(obj({ result: ResultReferenceSchema, status: union([lit("pending"), lit("done"), lit("unanswered"), lit("unavailable")]) }), { maxItems: 4 }),
	omittedResults: count,
	queuedInputCount: count,
});
export const StatusDetailCallSchema = obj({ tool: lit("agent_status"), sessionId: string, detail: lit(true) });
export const CompactConversationSchema = obj({
	identity: string, conversationId: opt(id), busy: nullable(boolean),
	availability: union([lit("live"), lit("retained"), lit("unknown")]),
	name: opt(string), model: opt(obj({ provider: string, modelId: string })), thinkingLevel: opt(string),
	runId: opt(id), queue: obj({ inbox: nullableCount, submissions: nullableCount }), timers: nullableCount,
	unplaced: opt(count), oldest: opt(count),
	awaiting: opt(CompactAwaitSchema),
	providerBlock: opt(obj({ blockId: string, recovery: string })),
	runFailure: opt(obj({ reason: str({ maxLength: 128 }), detail: opt(str({ maxLength: 512 })), reasonTruncated: opt(lit(true)), detailTruncated: opt(lit(true)) })),
	context: lit("unknown"), omitted: arr(string), detail: StatusDetailCallSchema,
});
export const PresentationRefusalSchema = obj({ format: lit("refused"), cause: union([lit("byte-limit"), lit("source")]), reason: string, byteLimit: count });
export const ReportReceiptAssociationSchema = obj({ producerRunId: id, producerResults: arr(ResultReferenceSchema, { minItems: 1 }) });
export const RetainedReportReceiptSchema = obj({
	sourceId: string, requestId: string, ownerId: string, senderIdentity: string, createdAt: number, acknowledged: boolean,
	replyTo: nullableText, passive: opt(boolean), intervention: opt(ReportReceiptAssociationSchema), boundary: string,
	/** `pending`, `parked` or `terminal` until the recipient admits the row; an unadmitted row is unplaced. */
	delivery: opt(union([lit("pending"), lit("parked"), lit("terminal"), lit("admitted")])), placement: opt(union([lit("placed"), lit("unplaced")])),
});
const compactEnvelope = {
	format: lit("compact"), storageId: opt(string), live: opt(boolean), omitted: arr(string),
};
export const CompactSelectedStatusSchema = obj({
	...compactEnvelope, conversation: CompactConversationSchema,
	deliveryError: opt(str({ maxLength: 512 })), deliveryErrorTruncated: opt(lit(true)),
});
export const CompactStorageStatusSchema = obj({
	...compactEnvelope, storageId: string, conversations: arr(CompactConversationSchema), coverage: StorageStatusCoverageSchema,
});
export const StatusToolOutputSchema = union([ToolStatusSchema, FleetStatusSchema, OrdinaryPrimaryObservationSchema, CompactSelectedStatusSchema, CompactStorageStatusSchema, PresentationRefusalSchema]);

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

export const AnswerContinuationSchema = obj({
	tool: lit("agent_inspect"), view: lit("result"), sessionId: string, submissionId: id, requestId: opt(string), offset: count,
});
export const ReceiptContinuationSchema = obj({
	tool: lit("agent_inspect"), view: lit("result"), sessionId: string, submissionId: id, requestId: opt(string), receiptCursor: str({ minLength: 1, maxLength: 2048 }),
});
export const ReceiptGroupSchema = obj({
	recipient: string, results: arr(ResultReferenceSchema, { maxItems: 16 }), complete: boolean, next: nullable(ReceiptContinuationSchema),
});
export type AnswerContinuation = Static<typeof AnswerContinuationSchema>;
export type ReceiptContinuation = Static<typeof ReceiptContinuationSchema>;
export type ReceiptGroup = Static<typeof ReceiptGroupSchema>;

const retainedResultProperties = {
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
	offset: opt(count), nextOffset: opt(nullableCount), truncated: opt(boolean),
	answerContinuation: opt(AnswerContinuationSchema), receiptGroup: opt(ReceiptGroupSchema),
	usage: UsageStateSchema,
};
const RetainedResultOutputSchema = obj(retainedResultProperties);
const UnavailableResultOutputSchema = obj({
	view: lit("result"),
	sessionId: string,
	conversationId: id,
	status: lit("unavailable"),
	requestId: opt(string),
	submissionId: opt(id),
	operationId: opt(string),
	reason: string,
	usage: UsageStateSchema,
});
export const ResultOutputSchema = union([RetainedResultOutputSchema, UnavailableResultOutputSchema]);
/** Native host and public tools share the retained-result page contract. */
export const ResultToolOutputSchema = ResultOutputSchema;

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

/** The variant a failed observation was compared against, and its JSON Pointer mismatches. */
export interface ObservationDiagnostic {
	readonly variant: string;
	readonly errors: readonly string[];
}

type DiagnosticResolver = (value: Record<string, unknown>, limit: number) => ObservationDiagnostic;
const diagnosticResolvers = new WeakMap<object, DiagnosticResolver>();

function has(value: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(value, key);
}

/**
 * Flat closed candidates for the tool status, built from the same property definitions as the product
 * schema and only after a mismatch, so a valid observation never pays for them.
 */
const statusCandidates = new Map<string, Schema>();
function statusCandidate(name: string, properties: () => Properties): Schema {
	let candidate = statusCandidates.get(name);
	if (candidate === undefined) {
		candidate = obj({ ...properties(), ...awarenessProperties }) as Schema;
		statusCandidates.set(name, candidate);
	}
	return candidate;
}

const OVERVIEW_KEYS = ["sessions", "summary", "primaries", "coverage"] as const;

function statusEnvelope(value: Record<string, unknown>, plural: boolean): "live" | "cold" | "bare" {
	if (has(value, "inventory") || has(value, "pid")) return "live";
	return plural || has(value, "live") || has(value, "storageId") ? "cold" : "bare";
}

function selectedStatusDiagnostic(value: Record<string, unknown>, limit: number): ObservationDiagnostic {
	const plural = has(value, "conversations");
	if (!plural && !has(value, "conversation")) {
		return { variant: "unrecognized", errors: ["/ expected sessions (overview), conversation or conversations (selected status), view \"fleet\", or kind \"ordinary-primary\""] };
	}
	const conflicts: string[] = [];
	if (plural && has(value, "conversation")) conflicts.push("/conversations cannot be combined with /conversation");
	if (statusEnvelope(value, plural) === "live" && has(value, "live")) conflicts.push("/live cannot be combined with /inventory or /pid");
	const envelope = statusEnvelope(value, plural);
	const variant = `${plural ? "plural" : "single"}-${envelope}`;
	const payload = plural ? { ...pluralPayload, createdAgents: opt(CreatedAgentsSchema) } : singlePayload;
	const envelopeProperties = envelope === "live" ? liveEnvelope : envelope === "bare" ? {} : coldEnvelope;
	const candidate = statusCandidate(variant, () => ({ ...payload, ...envelopeProperties }));
	return { variant, errors: [...conflicts, ...schemaErrors(candidate, value, limit)].slice(0, limit) };
}

function statusToolDiagnostic(value: Record<string, unknown>, limit: number): ObservationDiagnostic {
	if (value.format === "refused") return { variant: "refused", errors: schemaErrors(PresentationRefusalSchema, value, limit) };
	if (value.format === "compact") return { variant: "compact", errors: schemaErrors(has(value, "conversations") ? CompactStorageStatusSchema : CompactSelectedStatusSchema, value, limit) };
	if (value.kind === "ordinary-primary") return { variant: "ordinary-primary", errors: schemaErrors(OrdinaryPrimaryObservationSchema, value, limit) };
	if (value.view === "fleet") return { variant: "fleet", errors: schemaErrors(FleetStatusSchema, value, limit) };
	if (OVERVIEW_KEYS.some((key) => has(value, key))) {
		return { variant: "overview", errors: schemaErrors(statusCandidate("overview", () => toolOverviewProperties), value, limit) };
	}
	return selectedStatusDiagnostic(value, limit);
}
diagnosticResolvers.set(StatusToolOutputSchema, statusToolDiagnostic);

/**
 * Explain a failed observation. Schemas with a registered resolver choose the one variant their
 * discriminators select and report conflicting shapes directly; any other schema reports its own
 * validator errors, narrowed to the structurally closest union member.
 */
export function observationDiagnostic(schema: object, value: unknown, limit = 5): ObservationDiagnostic {
	const resolver = diagnosticResolvers.get(schema);
	if (resolver !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)) return resolver(value as Record<string, unknown>, limit);
	return { variant: "schema", errors: schemaErrors(diagnosticSchema(schema, value), value, limit) };
}

/** JSON-round-trip and validate an observation, with schema paths on mismatch. */
export function structuredObservation<T extends object>(schema: T, value: unknown): Static<T> {
	const parsed: unknown = JSON.parse(JSON.stringify(value ?? null));
	if (!matchesSchema(schema, parsed)) {
		const { errors } = observationDiagnostic(schema, parsed, 5);
		throw new Error(`Observation output does not match its schema: ${errors.join("; ")}`);
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
