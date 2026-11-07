import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import { canonicalIdentity } from "./native-identity.ts";
import type { ResultReference } from "./result-schema.ts";

function producerIdentity(sessionId: string): { canonical: string; conversationId?: number } {
	if (!sessionId || sessionId.length > 256 || /[\s@]/u.test(sessionId)) throw new Error("Result identity must be canonical");
	const separator = sessionId.lastIndexOf(":");
	if (separator < 0) return { canonical: sessionId, conversationId: ROOT_CONVERSATION_ID };
	const conversationId = Number(sessionId.slice(separator + 1));
	if (separator === 0 || !Number.isSafeInteger(conversationId) || conversationId <= 0) throw new Error("Invalid result conversation identity");
	return { canonical: canonicalIdentity(sessionId.slice(0, separator), conversationId as ConversationId), conversationId };
}

function admissionRow(admission: unknown): Record<string, unknown> {
	if (admission === null || typeof admission !== "object" || Array.isArray(admission)) throw new Error("Dispatch returned no native admission");
	const row = admission as Record<string, unknown>;
	if (!Number.isSafeInteger(row.submissionId) || (row.submissionId as number) <= 0) throw new Error("Dispatch returned no admitted submissionId");
	return row;
}

function checkProducer(row: Record<string, unknown>, selected: string, canonical: string, conversationId?: number): void {
	for (const key of ["identity", "sessionId"]) {
		if (row[key] !== undefined && row[key] !== selected && row[key] !== canonical) throw new Error("Admission identity disagrees with result identity");
	}
	if (conversationId !== undefined && row.conversationId !== undefined && row.conversationId !== conversationId) throw new Error("Admission conversationId disagrees with result identity");
}

function requestIdentity(row: Record<string, unknown>, requestId?: string): string | undefined {
	if (row.requestId !== undefined && (typeof row.requestId !== "string" || !row.requestId || row.requestId.length > 1024)) throw new Error("Admission returned an invalid requestId");
	if (requestId !== undefined && row.requestId !== undefined && row.requestId !== requestId) throw new Error("Admission requestId disagrees with dispatch requestId");
	const known = requestId ?? row.requestId ?? (row.result as Partial<ResultReference> | undefined)?.requestId;
	if (known !== undefined && (typeof known !== "string" || !known || known.length > 1024)) throw new Error("Invalid dispatch requestId");
	return known as string | undefined;
}

function checkReference(row: Record<string, unknown>, canonical: string, requestId?: string): void {
	if (row.result === undefined) return;
	const reference = row.result as Partial<ResultReference> | null;
	if (!reference || reference.sessionId !== canonical || reference.submissionId !== row.submissionId || (requestId !== undefined && reference.requestId !== requestId)) throw new Error("Returned result identifiers disagree with admission");
}

export function admittedResult(sessionId: string, admission: unknown, requestId?: string): ResultReference {
	const { canonical, conversationId } = producerIdentity(sessionId);
	const row = admissionRow(admission);
	checkProducer(row, sessionId, canonical, conversationId);
	const known = requestIdentity(row, requestId);
	checkReference(row, canonical, known);
	return { sessionId: canonical, submissionId: row.submissionId as number, ...(known === undefined ? {} : { requestId: known }) };
}

function placeFacts(params: Readonly<Record<string, unknown>>, row: Record<string, unknown>): Record<string, unknown> {
	const reference = row.result as ResultReference | undefined;
	if (!reference || typeof row.sessionId !== "string" || row.sessionId !== reference.sessionId || typeof params.requestId !== "string")
		throw new Error("Place admission requires an exact result, canonical target and stable request identity");
	admittedResult(row.sessionId, row, params.requestId);
	return row;
}

/** Validate the native admission or the deliberately non-answer-bearing primary receipt. */
export function dispatchFacts(method: string, params: Readonly<Record<string, unknown>>, value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Dispatch returned no admission");
	const row = value as Record<string, unknown>;
	if (method === "place") return placeFacts(params, row);
	if (method !== "submit" && method !== "task-submit") return row;
	if (method === "submit" && row.admitted === true && typeof row.sourceId === "string" && row.submissionId === undefined) {
		if (row.result !== undefined) throw new Error("A primary message is not a native result");
		return row;
	}
	const reference = row.result as ResultReference | undefined;
	if (reference === undefined) throw new Error("The answer-bearing admission has no result reference");
	const selected = typeof params.sessionId === "string" && !params.sessionId.startsWith("@") ? params.sessionId : reference.sessionId;
	admittedResult(selected, row, typeof params.requestId === "string" ? params.requestId : undefined);
	return row;
}
