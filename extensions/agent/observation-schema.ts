/**
 * Exact TypeBox schemas for the native Durable observation surface.
 *
 * These describe the current JSON that `DurableHost`/`DurableObservation` return
 * and that `AgentManager` aggregates for the primary tools. The primary tools
 * and the native agent-control tools import these schemas for `outputSchema` and
 * `structuredContent`; no consumer maps the outputs through an ordinary-session
 * shape.
 *
 * Every object schema closes its properties. Optional properties are absent in
 * the JSON round trip, never present with an undefined value. Open-ended
 * identifier strings (`provider`, `api`, `kind`) are strings because providers
 * and task authors choose them; arbitrary JSON payloads use the recursive
 * `JsonValueSchema`, which validates JSON exactly rather than accepting
 * anything.
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const string = Type.String();
const boolean = Type.Boolean();
const number = Type.Number();
const count = Type.Integer({ minimum: 0 });
const id = Type.Integer({ minimum: 1 });
const literal = <V extends string | number | boolean>(value: V) => Type.Literal(value);
const union = <T extends readonly TSchema[]>(schemas: T) => Type.Union(schemas as unknown as [TSchema, ...TSchema[]]);
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const nullableText = nullable(string);
const nullableCount = nullable(count);
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const thinkingLevel = union(thinkingLevels.map((level) => literal(level)));
const stopReasons = ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"] as const;
const textRoles = ["user", "assistant", "toolResult", "system"] as const;

/** Exact JSON value; no arbitrary unknown leaves. */
export const JsonValueSchema: TSchema = Type.Cyclic(
	{ Json: union([Type.Null(), boolean, number, string, Type.Array(Type.Ref("Json")), Type.Record(string, Type.Ref("Json"))]) },
	"Json",
);
const jsonObject = Type.Record(string, JsonValueSchema);
const cursorSchema = jsonObject;

const modelCost = object({ input: number, output: number, cacheRead: number, cacheWrite: number, total: number });
export const UsageSchema = object({
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	cacheWrite1h: Type.Optional(number),
	reasoning: Type.Optional(number),
	totalTokens: number,
	cost: modelCost,
});
export const UsageStateSchema = object({ models: Type.Record(string, UsageSchema), tools: Type.Record(string, UsageSchema) });

const textContent = object({ type: literal("text"), text: string, textSignature: Type.Optional(string) });
const imageContent = object({ type: literal("image"), data: string, mimeType: string });
const thinkingContent = object({ type: literal("thinking"), thinking: string, thinkingSignature: Type.Optional(string), redacted: Type.Optional(boolean) });
const toolCallContent = object({ type: literal("toolCall"), id: string, name: string, arguments: jsonObject, thoughtSignature: Type.Optional(string), namespace: Type.Optional(string) });
const userInputContent = union([string, Type.Array(union([textContent, imageContent]))]);

const diagnosticError = object({ name: Type.Optional(string), message: string, stack: Type.Optional(string), code: Type.Optional(union([string, number])) });
const assistantDiagnostic = object({ type: string, timestamp: number, error: Type.Optional(diagnosticError), details: Type.Optional(jsonObject) });
const deferredHandle = object({ provider: string, modelId: string, api: string, id: string, expiresAt: Type.Optional(number), pollAfterMs: Type.Optional(number), data: Type.Optional(JsonValueSchema) });
export const AssistantMessageSchema = object({
	role: literal("assistant"),
	content: Type.Array(union([textContent, thinkingContent, toolCallContent])),
	api: string,
	provider: string,
	model: string,
	responseModel: Type.Optional(string),
	responseId: Type.Optional(string),
	providerThinkingLevel: Type.Optional(string),
	thinkingLevel: Type.Optional(thinkingLevel),
	diagnostics: Type.Optional(Type.Array(assistantDiagnostic)),
	usage: UsageSchema,
	stopReason: union(stopReasons.map((reason) => literal(reason))),
	deferred: Type.Optional(deferredHandle),
	errorMessage: Type.Optional(string),
	rawStopReason: Type.Optional(string),
	endTurn: Type.Optional(boolean),
	timestamp: number,
});

const toolDiagnostic = object({ severity: union([literal("info"), literal("warn"), literal("error")]), message: string, code: Type.Optional(string) });
const toolSlot = object({
	callId: string,
	name: string,
	taskId: Type.Optional(id),
	status: union([literal("pending"), literal("running"), literal("done")]),
	output: Type.Optional(string),
	droppedBytes: Type.Optional(count),
	droppedLines: Type.Optional(count),
	details: Type.Optional(JsonValueSchema),
	diagnostics: Type.Optional(Type.Array(toolDiagnostic)),
	entry: Type.Optional(id),
});
const compactionStatus = object({
	taskId: id,
	reason: union([literal("manual"), literal("threshold"), literal("overflow")]),
	blocking: boolean,
	attempt: count,
	retry: Type.Optional(object({ at: number, error: string })),
});
export const LiveStateSchema = object({
	run: Type.Optional(object({ taskId: id, inputs: Type.Array(id) })),
	generation: Type.Optional(
		object({
			attempt: count,
			message: Type.Optional(AssistantMessageSchema),
			retry: Type.Optional(object({ at: number, error: string })),
			deferred: Type.Optional(object({ pollAt: number })),
		}),
	),
	tools: Type.Optional(Type.Array(toolSlot)),
	compactions: Type.Optional(Type.Array(compactionStatus)),
});

const inboxItem = union([
	object({ id, mode: union([literal("steer"), literal("followUp")]), content: userInputContent }),
	object({ id, mode: literal("write"), entry: jsonObject }),
]);
export const InboxStateSchema = object({ items: Type.Array(inboxItem) });

/** One pending scheduled input as reported by status. */
const timerStatusRow = object({
	id,
	target: string,
	deadline: number,
	mode: union([literal("followUp"), literal("steer")]),
	status: union([literal("pending"), literal("unsettled")]),
	overdue: boolean,
});

/** One conversation's observation status, as returned by every status variant. */
export const ConversationStatusSchema = object({
	conversationId: id,
	identity: string,
	name: Type.Optional(string),
	owner: Type.Optional(string),
	firstMessage: Type.Optional(string),
	busy: boolean,
	cwd: Type.Optional(string),
	lastText: nullableText,
	lastTextRole: Type.Optional(union(textRoles.map((role) => literal(role)))),
	live: nullable(LiveStateSchema),
	inbox: nullable(InboxStateSchema),
	usage: Type.Optional(UsageStateSchema),
	agent: object({
		model: Type.Optional(object({ provider: string, modelId: string })),
		thinkingLevel,
		extensions: Type.Array(string),
		tools: Type.Array(string),
		cwd: Type.Optional(string),
		instructions: Type.Optional(string),
	}),
	tasks: Type.Array(
		object({
			id,
			kind: string,
			status: union([literal("running"), literal("ready"), literal("waiting"), literal("completing"), literal("blocked")]),
			background: boolean,
			owner: Type.Optional(id),
			abortRequested: boolean,
		}),
	),
	submissions: Type.Array(
		object({
			id,
			type: union([literal("input"), literal("write")]),
			status: union([literal("queued"), literal("placed"), literal("done"), literal("unanswered")]),
			requestId: Type.Optional(string),
			entryId: Type.Optional(id),
			answerEntryId: Type.Optional(id),
			reason: Type.Optional(string),
		}),
	),
	/** Bounded pending scheduled inputs, nearest deadline first. */
	timers: Type.Optional(Type.Array(timerStatusRow)),
	parent: Type.Optional(object({ conversationId: id, at: id })),
	ownerTaskId: Type.Optional(id),
});

const compactionFailure = object({ reason: union([literal("manual"), literal("threshold"), literal("overflow")]), errorMessage: Type.Optional(string), at: string });
const autoRetry = object({ attempt: count, maxAttempts: count, delayMs: count, errorMessage: string });
const dashboardHealth = object({ lastError: Type.Optional(string), compactionFailure: Type.Optional(compactionFailure), autoRetry: Type.Optional(autoRetry) });

/** One dashboard roster row, including an unavailable row with `state: "unavailable"`. */
export const AgentConversationSummarySchema = object({
	id: string,
	storageId: string,
	name: Type.Optional(string),
	firstMessage: Type.Optional(string),
	cwd: string,
	model: Type.Optional(object({ provider: string, modelId: string, thinkingLevel: string })),
	modifiedAt: number,
	owner: union([literal("here"), literal("unavailable"), literal("unknown")]),
	ownerLabel: Type.Optional(string),
	state: union([literal("working"), literal("idle"), literal("done"), literal("failed"), literal("stopped"), literal("interrupted"), literal("new"), literal("unavailable")]),
	cost: number,
	partial: boolean,
	latestReply: Type.Optional(string),
	error: Type.Optional(string),
	toolCalls: Type.Optional(count),
	currentTool: Type.Optional(object({ name: string, argument: string })),
	durationMs: Type.Optional(number),
	health: Type.Optional(dashboardHealth),
});

/** What one session host installed, as reported by status. */
export const DurableInventorySchema = object({
	contributions: Type.Array(object({ name: string, source: string, commands: Type.Array(object({ name: string, description: string })) })),
	ordinaryOnly: Type.Array(string),
});

/** One manager list row: the native summary plus its catalog and external identity. */
export const ListRowSchema = object({
	conversationId: id,
	identity: string,
	name: Type.Optional(string),
	owner: Type.Optional(string),
	firstMessage: Type.Optional(string),
	busy: boolean,
	parent: Type.Optional(object({ conversationId: id, at: id })),
	ownerTaskId: Type.Optional(id),
	sessionId: string,
	storageId: string,
	cwd: string,
});

/** `agent_list` output: the manager's bounded catalog scan over native list rows. */
export const ListOutputSchema = object({
	rows: Type.Array(ListRowSchema),
	nextCursor: nullableText,
	coverage: object({
		complete: boolean,
		storagesVisited: count,
		unavailable: Type.Array(object({ storageId: string, reason: string })),
	}),
	observedAt: string,
	authority: string,
});
export type ListOutput = Static<typeof ListOutputSchema>;

/**
 * `agent_status` union:
 * - manager overview without a target: `{sessions, failures, observedAt}`;
 * - live host status with inventory: `{conversation|conversations, inventory, pid, storageId}`;
 * - cold primary status: the same without `pid` and with `live: false`;
 * - a bare `{conversation}` from the native attach path.
 * A conversation status carries `timers`: its bounded pending scheduled inputs,
 * nearest deadline first, with `overdue` set when the deadline has passed.
 */
export const StatusOutputSchema = union([
	object({
		sessions: Type.Array(AgentConversationSummarySchema),
		primaries: Type.Array(
			object({
				sessionId: string,
				cwd: string,
				name: Type.Optional(string),
				model: Type.Optional(object({ provider: string, modelId: string })),
				thinkingLevel: Type.Optional(thinkingLevel),
			}),
		),
		failures: Type.Array(object({ storageId: string, error: string })),
		coverage: object({ complete: boolean, storagesVisited: count, skipped: count, omitted: count, omittedPrimaries: count, omittedFailures: count, bytes: count, byteLimitReached: boolean, nextCursor: nullableText }),
		observedAt: string,
		discovery: string,
	}),
	object({ conversation: ConversationStatusSchema, inventory: DurableInventorySchema, pid: id, storageId: string }),
	object({ conversation: ConversationStatusSchema, inventory: DurableInventorySchema, live: literal(false), storageId: string }),
	object({ conversations: Type.Array(ConversationStatusSchema), inventory: DurableInventorySchema, pid: id, storageId: string }),
	object({ conversations: Type.Array(ConversationStatusSchema), inventory: DurableInventorySchema, live: literal(false), storageId: string }),
	object({ conversation: ConversationStatusSchema }),
]);
export type StatusOutput = Static<typeof StatusOutputSchema>;

const entrySource = union([literal("user"), literal("assistant"), literal("toolResult"), literal("summary"), literal("custom")]);
const messageRole = union([literal("system"), literal("user"), literal("assistant"), literal("toolResult")]);
const omissions = object({ providerSignatures: count, imagePayloads: count, redactedThinking: count });

/** One bounded redacted entry row shared by the history, branch, and activity views. */
export const DurableEntryRowSchema = object({
	id,
	kind: string,
	source: entrySource,
	role: Type.Optional(messageRole),
	preview: Type.Optional(object({ text: string, truncated: boolean })),
	text: string,
	truncated: boolean,
	nextOffset: nullableCount,
	omissions: Type.Optional(omissions),
});

export const HistoryOutputSchema = object({
	view: union([literal("history"), literal("branch")]),
	sessionId: string,
	conversationId: id,
	entries: Type.Array(DurableEntryRowSchema),
	nextCursor: nullable(cursorSchema),
	order: literal("newestFirst"),
	detail: string,
});

const searchMatch = object({ entryId: id, kind: string, source: entrySource, matchOffset: count, excerpt: string, excerptText: string, truncated: boolean });
const searchCursor = object({ cursor: nullable(cursorSchema), skip: count, scannedBytes: count });
export const SearchOutputSchema = object({
	view: literal("search"),
	sessionId: string,
	conversationId: id,
	matches: Type.Array(searchMatch),
	nextCursor: nullable(searchCursor),
	coverage: object({ scannedEntries: count, scannedBytes: count, complete: boolean }),
	detail: string,
});

export const ExactOutputSchema = object({
	view: literal("exact"),
	sessionId: string,
	conversationId: id,
	entryId: id,
	offset: count,
	text: string,
	nextOffset: nullableCount,
	truncated: boolean,
	omissions: Type.Optional(omissions),
});

const runningTool = object({
	toolCallId: string,
	name: string,
	issuedAt: Type.Optional(string),
	elapsedMs: Type.Optional(count),
	elapsedFrom: Type.Optional(literal("tool-call-entry")),
});
export const ActivityOutputSchema = object({
	view: literal("activity"),
	sessionId: string,
	conversationId: id,
	turns: Type.Array(object({ entries: Type.Array(DurableEntryRowSchema) })),
	nextCursor: nullable(cursorSchema),
	metadata: object({
		owner: union([literal("here"), literal("unavailable"), literal("unknown")]),
		live: boolean,
		operation: nullable(id),
		runningTools: Type.Array(runningTool),
		pending: nullableCount,
		streamedText: Type.Optional(string),
		lastError: Type.Optional(string),
		compactionFailure: Type.Optional(compactionFailure),
		autoRetry: Type.Optional(autoRetry),
	}),
	coverage: object({
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

export const ResultOutputSchema = object({
	view: literal("result"),
	sessionId: string,
	conversationId: id,
	submissionId: id,
	status: union([literal("queued"), literal("placed"), literal("done"), literal("unanswered")]),
	requestId: Type.Optional(string),
	operationId: Type.Optional(string),
	entryId: Type.Optional(id),
	answerEntryId: Type.Optional(id),
	reason: Type.Optional(string),
	answer: Type.Optional(string),
	usage: UsageStateSchema,
});

/** `agent_inspect` output: one shape per view, selected by the `view` property. */
export const InspectOutputSchema = union([HistoryOutputSchema, SearchOutputSchema, ExactOutputSchema, ActivityOutputSchema, ResultOutputSchema]);
export type InspectOutput = Static<typeof InspectOutputSchema>;

/** The schema for one observation method, for `outputSchema` registration. */
export function observationSchema(method: "list" | "status" | "inspect"): TSchema {
	switch (method) {
		case "list":
			return ListOutputSchema;
		case "status":
			return StatusOutputSchema;
		case "inspect":
			return InspectOutputSchema;
	}
}

/**
 * JSON-round-trip one observation value for `structuredContent` and prove it
 * against its schema. A mismatch throws with the failing paths instead of
 * shipping a shape the declared schema rejects.
 */
export function structuredObservation<T extends TSchema>(schema: T, value: unknown): Static<T> {
	const parsed: unknown = JSON.parse(JSON.stringify(value ?? null));
	const errors = [...Value.Errors(schema, parsed)];
	if (errors.length > 0) {
		const detail = errors.slice(0, 5).map((error) => `${error.instancePath === "" ? "/" : error.instancePath} ${error.message}`).join("; ");
		throw new Error(`Observation output does not match its schema: ${detail}`);
	}
	return parsed as Static<T>;
}
