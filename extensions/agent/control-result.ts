import { AnswerContinuationSchema, ReceiptContinuationSchema } from "./observation-schema.ts";
import { ResultReferenceSchema } from "./result-schema.ts";
import { FinalReportReadSchema } from "./open-work-schema.ts";
import { ProviderBlockFactSchema, providerBlockText } from "./provider-block-facts.ts";
import { matchesSchema } from "./schema-check.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A continuation is executable data, not a prose description of a cursor. */
function inspectCall(value: unknown): string | undefined {
	if (!matchesSchema(AnswerContinuationSchema, value) && !matchesSchema(ReceiptContinuationSchema, value) && !matchesSchema(FinalReportReadSchema, value)) return undefined;
	const { tool: _tool, ...args } = value as Record<string, unknown>;
	return `agent_inspect(${JSON.stringify(args)})`;
}

/** Receipt references advance only through their typed cursor, never through an answer offset. */
export function receiptContinuationLine(value: unknown): string | undefined {
	if (!matchesSchema(ReceiptContinuationSchema, value)) return undefined;
	const call = inspectCall(value);
	return call === undefined ? undefined : `Receipt continuation: ${call}`;
}

/** Body pages and recipient-reference pages have independent selectors and progress. */
export function resultContinuationLines(value: unknown): string[] {
	const row = record(value);
	if (!row) return [];
	const answer = matchesSchema(AnswerContinuationSchema, row.answerContinuation) ? inspectCall(row.answerContinuation) : undefined;
	const receipt = receiptContinuationLine(record(row.receiptGroup)?.next);
	const finalReport = inspectCall(row.finalReportContinuation);
	return [...(answer ? [`Answer continuation: ${answer}`] : []), ...(receipt ? [receipt] : []), ...(finalReport ? [`Final report continuation: ${finalReport}`] : [])];
}

/** The answer of a request with declared work is its state note; the final report is a separate page. */
function workLines(value: Record<string, unknown>): string[] {
	const work = record(value.work);
	if (!work) return [];
	const report = record(work.finalReport);
	const read = report ? inspectCall(report.read) : undefined;
	return [
		`Declared work: ${work.state === "open" ? "open; no final report exists yet" : "closed"}.`,
		...(report ? [`Final report: ${JSON.stringify({ requestId: report.requestId, ownerId: report.ownerId, status: report.status, delivery: report.delivery })}`] : []),
		...(read ? [`Read the final report: ${read}`] : []),
	];
}

/**
 * The report text, then its identity. `inputStatus` is the status of the declaring input and `status` the close
 * status of the work: a report is readable for an input that is still placed or that ended unanswered.
 */
function readableFinalReport(value: Record<string, unknown>, page: Record<string, unknown>): string {
	const identity = {
		sessionId: value.sessionId, conversationId: value.conversationId, submissionId: value.submissionId, requestId: value.requestId, inputStatus: value.status,
		reportRequestId: page.requestId, ownerId: page.ownerId, status: page.status, length: page.length, offset: page.offset, nextOffset: page.nextOffset, truncated: page.truncated,
	};
	return [String(page.text), `Final report page: ${JSON.stringify(identity)}`, ...resultContinuationLines(value)].join("\n\n");
}

function readableResult(value: Record<string, unknown>): string {
	const identity = {
		sessionId: value.sessionId, conversationId: value.conversationId, submissionId: value.submissionId, requestId: value.requestId,
		operationId: value.operationId, entryId: value.entryId, status: value.status, answerEntryId: value.answerEntryId, reason: value.reason, recoveryOf: value.recoveryOf,
		offset: value.offset, nextOffset: value.nextOffset, truncated: value.truncated,
	};
	const finalReport = record(value.finalReport);
	if (finalReport) return readableFinalReport(value, finalReport);
	const work = record(value.work);
	const answer = typeof value.answer === "string" ? value.answer : "No answer body is available in this result.";
	const body = work && typeof work.label === "string" ? `${work.label}.\n\n${answer}` : answer;
	const receipt = record(value.receiptGroup);
	return [body, `Result: ${JSON.stringify(identity)}`, ...workLines(value),
		...(receipt ? [`Receipt references: ${JSON.stringify({ recipient: receipt.recipient, results: receipt.results, complete: receipt.complete })}`] : []),
		...resultContinuationLines(value),
		...(value.providerBlock === undefined ? [] : [matchesSchema(ProviderBlockFactSchema, value.providerBlock) ? providerBlockText(value.providerBlock) : "Provider block evidence is unavailable."]),
	].join("\n\n");
}

export const REPORT_RECEIPT_BYTE_LIMIT = 16 * 1024;
export const REPORT_RECEIPT_BOUNDARY = "Retention or acknowledgement does not establish model consumption or task acceptance.";
const REPORT_RECEIPT_KEYS = [
	"sourceId", "requestId", "ownerId", "senderIdentity", "createdAt", "acknowledged", "passive", "replyTo",
	"sessionId", "identity", "conversationId", "submissionId", "result", "deduped", "admitted", "queued", "boundary",
] as const;
/** Whether the input is in the recipient's context; an unplaced input enters it at the recipient's next tool boundary. */
const REPORT_PLACEMENTS: readonly unknown[] = ["placed", "unplaced", "withdrawn"];
/** The state of the retained row at its recipient; only an admitted row can be placed. */
const REPORT_DELIVERIES: readonly unknown[] = ["pending", "parked", "terminal", "admitted"];

function reportReceiptFields(source: Record<string, unknown>, retained: boolean): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of REPORT_RECEIPT_KEYS) if (Object.hasOwn(source, key)) result[key] = structuredClone(source[key]);
	if (REPORT_PLACEMENTS.includes(source.placement)) result.placement = source.placement;
	if (REPORT_DELIVERIES.includes(source.delivery)) result.delivery = source.delivery;
	if (retained) {
		result.boundary = REPORT_RECEIPT_BOUNDARY;
		// Without a stated delivery, an unacknowledged retained report is not delivered, so it cannot be in the recipient's context.
		if (source.acknowledged === false && result.delivery === undefined && result.placement !== "withdrawn") Object.assign(result, { placement: "unplaced", delivery: "pending" });
	}
	return result;
}

/** Only successful report sender replies pass through this projection; the recipient body stays intact. */
export function projectReportReceipt(value: unknown): unknown {
	const source = record(value);
	if (!source || source.error !== undefined || source.isError === true || source.outcome === "failed" || source.admitted === false) return value;
	const retained = typeof source.sourceId === "string" && typeof source.acknowledged === "boolean";
	const admitted = source.admitted === true || typeof source.submissionId === "number";
	if (!retained && !admitted) return value;
	if (source.result !== undefined && !matchesSchema(ResultReferenceSchema, source.result))
		return { format: "refused", reason: "Report receipt result reference is invalid; the retained delivery is unchanged.", byteLimit: REPORT_RECEIPT_BYTE_LIMIT };
	const result = reportReceiptFields(source, retained);
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > REPORT_RECEIPT_BYTE_LIMIT)
		return { format: "refused", reason: "Report receipt identity/state metadata exceeds the output byte limit; the retained delivery is unchanged.", byteLimit: REPORT_RECEIPT_BYTE_LIMIT };
	return result;
}

/** Public inspect adapters select readable result text without changing internal control rendering. */
export function readableControlText(value: unknown): string {
	const row = record(value);
	return row?.view === "result" ? readableResult(row) : controlText(value);
}

/** Render a host control result for the model without losing structure. */
export function controlText(value: unknown): string {
	if (value === undefined) return "Host control completed without a result.";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return "Host control returned a result that cannot be printed.";
	}
}
