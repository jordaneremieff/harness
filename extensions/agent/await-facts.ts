import { str, int, bool, lit, union, arr, opt, obj, type Static } from "@earendil-works/pi-schema";
/** Bounded provider-retry facts of a producer run, separate from native task scheduling state. */
import { AgentDoc, LiveDoc, type ConversationId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { ResultReferenceSchema, type ResultReference } from "./result-schema.ts";
import { safeFactText } from "./primary-observation.ts";

export const ProducerRetrySchema = obj({
	state: lit("provider-retry"),
	runId: int({ minimum: 1 }),
	results: arr(ResultReferenceSchema, { minItems: 1, maxItems: 16 }),
	model: opt(obj({ provider: str({ maxLength: 256 }), modelId: str({ maxLength: 256 }) })),
	attempt: int({ minimum: 1 }),
	maxAttempts: opt(int({ minimum: 1 })),
	nextRetryAt: int({ minimum: 0, maximum: 8640000000000000 }),
	error: str({ maxLength: 512 }),
	errorTruncated: bool(),
});
export type ProducerRetry = Static<typeof ProducerRetrySchema>;

async function retryInputMatches(tx: Tx, conversationId: ConversationId, result: ResultReference): Promise<boolean> {
	if (result.requestId === undefined) return true;
	const input = await tx.submissionByRequest(conversationId, result.requestId);
	return input?.id === result.submissionId && input.status === "placed";
}

/** Retry belongs only to placed inputs of the current native run. */
export async function producerRetryFact(tx: Tx, conversationId: ConversationId, results: readonly ResultReference[], maxAttempts?: number): Promise<ProducerRetry | undefined> {
	const live = await tx.doc(LiveDoc, conversationId);
	if (live.run === undefined || live.generation?.retry === undefined) return undefined;
	const task = await tx.task(live.run.taskId);
	if (task === undefined || task.abortRequested || task.state.status === "terminal") return undefined;
	const correlated: ResultReference[] = [];
	for (const result of results.slice(0, 16)) {
		if (!live.run.inputs.includes(result.submissionId as SubmissionId)) continue;
		if (!await retryInputMatches(tx, conversationId, result)) continue;
		correlated.push(result);
	}
	if (correlated.length === 0) return undefined;
	const agent = await tx.doc(AgentDoc, conversationId);
	const error = safeFactText(live.generation.retry.error);
	return { state: "provider-retry", runId: live.run.taskId, results: correlated,
		...(agent.model === undefined ? {} : { model: { provider: safeFactText(agent.model.provider, 256).text, modelId: safeFactText(agent.model.modelId, 256).text } }),
		attempt: live.generation.attempt, ...(maxAttempts === undefined ? {} : { maxAttempts }),
		nextRetryAt: live.generation.retry.at, error: error.text, errorTruncated: error.truncated };
}

/** Provider error text is a claim, not a scheduling guarantee or diagnosis. */
export function retryFactLines(retry: ProducerRetry): string[] {
	return retry.results.map((result) => `${result.sessionId} · submission ${result.submissionId}${result.requestId === undefined ? "" : ` · request ${safeFactText(result.requestId, 160).text}`} · pending · provider retry · ${retry.model === undefined ? "model unknown" : `${retry.model.provider}/${retry.model.modelId}`} · attempt ${retry.attempt}${retry.maxAttempts === undefined ? " (ceiling unknown)" : `/${retry.maxAttempts}`} · next retry ${new Date(retry.nextRetryAt).toISOString()} · provider error: ${safeFactText(retry.error).text}${retry.errorTruncated ? " [truncated]" : ""}`);
}

/** Retained notices can carry this member; nothing writes it. */
const RetainedAwaitingSchema = obj({
	runId: int({ minimum: 1 }),
	heldInputs: arr(int({ minimum: 1 }), { maxItems: 16 }),
	results: arr(obj({ result: ResultReferenceSchema, status: union([lit("pending"), lit("done"), lit("unanswered"), lit("unavailable")]), reason: opt(str({ maxLength: 512 })), answerEntryId: opt(int({ minimum: 1 })) }), { maxItems: 16 }),
	queuedInputCount: int({ minimum: 0 }),
	queueSnapshot: lit("committed InboxDoc"),
	omitted: obj({ heldInputs: int({ minimum: 0 }), results: int({ minimum: 0 }) }),
});
/** One producer observation in a provider retry notice; the stored shape and its source label stay as retained rows have them. */
export const ProducerAwaitFactSchema = obj({
	sessionId: str({ minLength: 1, maxLength: 256 }),
	observedAt: int({ minimum: 0 }),
	source: lit("producer await-state"),
	awaiting: opt(RetainedAwaitingSchema),
	execution: opt(ProducerRetrySchema),
	unavailable: opt(str({ maxLength: 512 })),
});
export type ProducerAwaitFact = Static<typeof ProducerAwaitFactSchema>;
