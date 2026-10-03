/** Host-authored request routes, retained independently of the active transcript. */
import type { Context } from "@earendil-works/chord";
import { defineDoc, LiveDoc, section, type ConversationId, type Harness, type PromptSection, type SubmissionId, type Tx, type UserInput } from "@earendil-works/pi-durable";

export type RequestContext = {
	readonly requestId: string;
	readonly requester: string;
	readonly replyTo: string;
	readonly origin: "operator" | "model";
};
export type ActiveRequestContext = RequestContext & { readonly status: "admitting" | "queued" | "placed" };

/** Only unfinished requests remain here; native submission state owns settlement. */
export const RequestContextDoc = defineDoc<{ requests: RequestContext[] }>({
	kind: "agent.request-context",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ requests: [] }),
});

/** Admission refuses at this bound rather than silently dropping a live route. */
export const REQUEST_CONTEXT_LIMIT = 128;
export const REQUEST_CONTEXT_PROJECTION_LIMIT = 8;

function validateRequest(request: RequestContext): void {
	for (const key of ["requestId", "requester", "replyTo", "origin"] as const) {
		const value = request[key];
		if (typeof value !== "string" || value.trim() === "" || value.length > (key === "requestId" ? 1024 : 256) || /[\u0000-\u001f\u007f]/u.test(value))
			throw new Error(`Invalid request context ${key}`);
	}
	if (request.origin !== "model" && request.origin !== "operator") throw new Error("Invalid request context origin");
}

async function activeRequests(tx: Tx, conversationId: ConversationId): Promise<Array<{ route: ActiveRequestContext; submissionId?: SubmissionId }>> {
	const state = await tx.doc(RequestContextDoc, conversationId);
	const active: Array<{ route: ActiveRequestContext; submissionId?: SubmissionId }> = [];
	const retained: RequestContext[] = [];
	for (const request of state.requests) {
		const submission = await tx.submissionByRequest(conversationId, request.requestId);
		if (submission !== undefined && (submission.type !== "input" || submission.status === "done" || submission.status === "unanswered")) continue;
		retained.push(request);
		active.push({ route: { ...request, status: submission?.status ?? "admitting" }, ...(submission === undefined ? {} : { submissionId: submission.id }) });
	}
	if (retained.length !== state.requests.length) state.requests.splice(0, state.requests.length, ...retained);
	return active;
}

/** Call before native admission, in the same commit as the delivery intent or Reporter checkpoint. */
export async function recordRequestContext(tx: Tx, conversationId: ConversationId, request: RequestContext): Promise<void> {
	validateRequest(request);
	const state = await tx.doc(RequestContextDoc, conversationId);
	const prior = state.requests.find((candidate) => candidate.requestId === request.requestId);
	if (prior !== undefined && (prior.requester !== request.requester || prior.replyTo !== request.replyTo || prior.origin !== request.origin))
		throw new Error("The request ID already identifies a different request route");
	await activeRequests(tx, conversationId);
	if (prior !== undefined || await tx.submissionByRequest(conversationId, request.requestId) !== undefined) return;
	if (state.requests.length >= REQUEST_CONTEXT_LIMIT) throw new Error(`The conversation already has ${REQUEST_CONTEXT_LIMIT} unfinished request routes`);
	state.requests.push({ requestId: request.requestId, requester: request.requester, replyTo: request.replyTo, origin: request.origin });
}

/** Cleanup is driven by native terminal submissions, including reset and abort, never elapsed time. */
export async function cleanupRequestContexts(tx: Tx, conversationId: ConversationId): Promise<void> {
	await activeRequests(tx, conversationId);
}

/** Profile reads expose pending admissions and queued inputs without calling them the current run. */
export async function readRequestContexts(harness: Harness, conversationId: ConversationId, context: Context): Promise<ActiveRequestContext[]> {
	return harness.commit(async (tx) => (await activeRequests(tx, conversationId)).map(({ route }) => route), context);
}

/** Prepend host routing evidence without changing the task's image parts. */
export function requestEnvelope(message: string, request: RequestContext): string;
export function requestEnvelope(message: UserInput, request: RequestContext): UserInput;
export function requestEnvelope(message: UserInput, request: RequestContext): UserInput {
	validateRequest(request);
	const prefix = `Host request context: ${JSON.stringify(request)}\nThe final answer routes automatically to replyTo for this request. For an interim report, use agent_send with that recipient and mode: "report". The requester is not necessarily this agent's creator.\n\nTask content:\n`;
	return typeof message === "string" ? `${prefix}${message}` : [{ type: "text", text: prefix }, ...message];
}

export type RequestContextProjection = { readonly requests: ActiveRequestContext[]; readonly omitted: number; readonly unknown: number };

/** Match native run inputs, not arrival order. Request lookup covers the admission-to-link window. */
export async function projectRequestContexts(tx: Tx, conversationId: ConversationId): Promise<RequestContextProjection> {
	const live = await tx.doc(LiveDoc, conversationId);
	const active = await activeRequests(tx, conversationId);
	const bySubmission = new Map(active.filter((item) => item.submissionId !== undefined).map((item) => [item.submissionId, item.route]));
	const requests: ActiveRequestContext[] = [];
	let omitted = 0;
	let unknown = 0;
	for (const id of live.run?.inputs ?? []) {
		const route = bySubmission.get(id);
		if (route === undefined) unknown += 1;
		else if (requests.length >= REQUEST_CONTEXT_PROJECTION_LIMIT) omitted += 1;
		else requests.push(route);
	}
	return { requests, omitted, unknown };
}

/** Native section rendering runs outside Session commits, so the read joins its mutation line safely. */
export function requestContextSection(source: Harness | (() => Harness)): PromptSection {
	return section("agent-request-context", async (input, context) => {
		try {
			const harness = typeof source === "function" ? source() : source;
			const projection = await harness.commit((tx) => projectRequestContexts(tx, input.conversationId), context);
			if (projection.requests.length === 0 && projection.unknown === 0) return undefined;
			return [
				"Current native run request routes. Final answers route automatically; interim reports use the explicit replyTo and mode: report. Creating-owner provenance does not select a reply recipient.",
				...projection.requests.map((request) => JSON.stringify(request)),
				...(projection.omitted === 0 ? [] : [`${projection.omitted} further routes omitted. Read agent_profile for all unfinished routes.`]),
				...(projection.unknown === 0 ? [] : [`${projection.unknown} native inputs have no retained requester evidence. Do not infer their requester from another route.`]),
			].join("\n");
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			// Native render failures retain the previously shown section. Replace it to avoid stale routes.
			return "Current request routes are unavailable. Do not infer a requester from an earlier request or creating-owner provenance. Read agent_profile before an explicit report.";
		}
	});
}
