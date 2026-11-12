/**
 * Public shapes of declared background work: the `agent_work` parameters and result, the item view of a
 * status read, and the dependency marks of a delivery. Schema-only: this module and its imports load no
 * Durable runtime, so an ordinary session can read these shapes.
 */
import { arr, bool, int, lit, obj, opt, str, union, type Schema, type Static } from "@earendil-works/pi-schema";
import { ResultReferenceSchema } from "./result-schema.ts";
import { matchesSchema } from "./schema-check.ts";

export const WORK_DEPENDENCY_LIMIT = 16;
export const WORK_NOTE_CHARS = 1200;
export const WORK_MESSAGE_CHARS = 100_000;
/** Marks of one delivery, and retained marks that no retained item names. */
export const DEPENDENCY_MARK_LIMIT = 64;

const StringEnum = <const T extends readonly string[]>(values: T, description?: string): Schema<T[number]> => ({ type: "string", enum: [...values], ...(description === undefined ? {} : { description }) });
const identityText = str({ minLength: 1, maxLength: 256 });
const requestText = str({ minLength: 1, maxLength: 1024 });
const submissionNumber = int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const timestamp = int({ minimum: 0 });

export const AGENT_WORK_DESCRIPTION = "Declare background work for a request, or complete it. Returns at once; it never waits. continue records the request, its reply route and the exact results the work depends on; then end the run with a short state note, which is not the final result. A repeated continue replaces the dependencies and the note. Empty results declare open work with no producer dependency: no event wakes it, so it stays open until you complete it. complete is the only act that finishes declared work: it closes the item and sends one final report (done or failed) to the request's reply recipient. Arrived results and settled inputs complete nothing. Read open items and dependency states with agent_status.";

/** One object root for every provider; the action-specific shapes apply at execution. */
export const AgentWorkParams = obj({
	action: StringEnum(["continue", "complete"]),
	request: opt(str({ minLength: 1, maxLength: 1024, description: "Request ID of the work. Required for complete. For continue: default the single routed input of the current run, else the single open item." })),
	results: opt(arr(ResultReferenceSchema, { maxItems: WORK_DEPENDENCY_LIMIT, description: "continue only, required: exact admitted results the work depends on. Empty declares open work with no producer dependency." })),
	note: opt(str({ minLength: 1, maxLength: WORK_NOTE_CHARS, description: "continue only, required: what remains and what the results are for." })),
	status: opt(StringEnum(["done", "failed"], "complete only.")),
	message: opt(str({ minLength: 1, maxLength: WORK_MESSAGE_CHARS, description: "complete only: the final result for the reply recipient." })),
});
const ContinueWorkParams = obj({ action: lit("continue"), request: opt(requestText), results: arr(ResultReferenceSchema, { maxItems: WORK_DEPENDENCY_LIMIT }), note: str({ minLength: 1, maxLength: WORK_NOTE_CHARS }) });
const CompleteWorkParams = obj({ action: lit("complete"), request: requestText, status: union([lit("done"), lit("failed")]), message: str({ minLength: 1, maxLength: WORK_MESSAGE_CHARS }) });
export type AgentWorkInput = Static<typeof ContinueWorkParams> | Static<typeof CompleteWorkParams>;

/** The closed union of the two actions; the registered schema cannot express it under one object root. */
export function parseAgentWorkInput(input: unknown): AgentWorkInput {
	if (!matchesSchema(AgentWorkParams, input)) throw new Error("agent_work requires action continue or complete and valid fields");
	if (input.action === "continue") {
		if (!matchesSchema(ContinueWorkParams, input)) throw new Error("continue requires results (which can be empty) and note, and takes request; omit status and message");
		return input;
	}
	if (!matchesSchema(CompleteWorkParams, input)) throw new Error("complete requires request, status (done or failed) and message; omit results and note");
	return input;
}

/**
 * Typed evidence of one result that a delivery admitted into the conversation: a labelled state note, or
 * a result (an ordinary answer or an explicit final report).
 */
export type DependencyMark = { sessionId: string; submissionId: number; requestId: string; state: "state-note" | "arrived" };

export const DependencyMarksSchema = arr(obj({
	sessionId: str({ minLength: 1, maxLength: 256 }),
	submissionId: submissionNumber,
	requestId: requestText,
	state: union([lit("state-note"), lit("arrived")]),
}), { maxItems: DEPENDENCY_MARK_LIMIT });

/** Marks from a delivery request; a malformed value refuses the request. */
export function parseDependencyMarks(value: unknown): DependencyMark[] {
	if (!matchesSchema(DependencyMarksSchema, value)) throw new TypeError("Invalid dependency marks");
	return value.map(({ sessionId, submissionId, requestId, state }) => ({ sessionId, submissionId, requestId, state }));
}

export const OpenWorkDependencySchema = obj({
	sessionId: str({ minLength: 1, maxLength: 256 }),
	submissionId: submissionNumber,
	requestId: opt(requestText),
	state: union([lit("open"), lit("state-note"), lit("arrived")]),
	/** Present when no committed fact of the producer and no admitted delivery supplied the state. */
	unavailable: opt(str()),
	inspect: obj({ tool: lit("agent_inspect"), view: lit("result"), sessionId: str({ minLength: 1, maxLength: 256 }), submissionId: submissionNumber }),
});
export type OpenWorkDependencyView = Static<typeof OpenWorkDependencySchema>;

/**
 * Exact call that reads the retained final report of a request in pages: the result view of the request's
 * input with `finalReport: true`. `offset` counts UTF-16 code units of the retained report text.
 */
export const FinalReportReadSchema = obj({
	tool: lit("agent_inspect"),
	view: lit("result"),
	sessionId: identityText,
	submissionId: submissionNumber,
	finalReport: lit(true),
	offset: int({ minimum: 0 }),
});
export type FinalReportRead = Static<typeof FinalReportReadSchema>;

/** `retained`: the reply recipient is the declaring conversation, so the report is kept for reading and never admitted as an input. */
const ReportDeliverySchema = union([lit("active"), lit("parked"), lit("fallback"), lit("terminal"), lit("delivered"), lit("absent"), lit("retained")]);
export type FinalReportDelivery = Static<typeof ReportDeliverySchema>;
const CloseStatusSchema = union([lit("done"), lit("failed"), lit("stopped"), lit("reset")]);

/** Identity of one final report: its report request ID, its reply recipient, and the call that reads it. */
export const FinalReportFactSchema = obj({
	requestId: str({ minLength: 1 }),
	ownerId: identityText,
	status: opt(CloseStatusSchema),
	delivery: ReportDeliverySchema,
	read: FinalReportReadSchema,
});

export const OpenWorkViewSchema = obj({
	requestId: requestText,
	submissionId: submissionNumber,
	requester: identityText,
	replyTo: identityText,
	origin: union([lit("operator"), lit("model")]),
	note: str(),
	/** `work`, kept apart from the native input status. */
	state: union([lit("open"), lit("closed")]),
	declaredAt: timestamp,
	updatedAt: timestamp,
	close: opt(obj({
		status: union([lit("done"), lit("failed"), lit("stopped"), lit("reset")]),
		message: str(),
		at: timestamp,
		reportRequestId: str({ minLength: 1 }),
		/** Delivery state of the final report row. */
		delivery: opt(ReportDeliverySchema),
		/** Reads the complete retained final report in pages. */
		read: FinalReportReadSchema,
	})),
	dependencies: arr(OpenWorkDependencySchema, { maxItems: WORK_DEPENDENCY_LIMIT }),
});
export type OpenWorkView = Static<typeof OpenWorkViewSchema>;

const FinalReportSchema = obj({ sourceId: str(), requestId: str(), ownerId: str(), acknowledged: bool(), createdAt: timestamp });
export const AgentWorkOutputSchema = obj({
	action: union([lit("continue"), lit("complete")]),
	item: OpenWorkViewSchema,
	requestId: opt(requestText),
	status: opt(union([lit("done"), lit("failed"), lit("stopped"), lit("reset")])),
	/** True when the item was already closed and this call returned the retained close. */
	deduped: opt(bool()),
	report: opt(FinalReportSchema),
});
export type OpenWorkDetails = Static<typeof AgentWorkOutputSchema>;
