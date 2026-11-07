import { str, int, bool, lit, union, arr, opt, obj, type Static } from "@earendil-works/pi-schema";
/** Bounded semantic wait facts, separate from native task scheduling state. */
import { ResultReferenceSchema } from "./result-schema.ts";
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
export type ProducerState = { awaiting?: OwnAwaitFact; execution?: ProducerRetry };

/** Provider error text is a claim, not a scheduling guarantee or diagnosis. */
export function retryFactLines(retry: ProducerRetry): string[] {
	return retry.results.map((result) => `${result.sessionId} · submission ${result.submissionId}${result.requestId === undefined ? "" : ` · request ${safeFactText(result.requestId, 160).text}`} · pending · provider retry · ${retry.model === undefined ? "model unknown" : `${retry.model.provider}/${retry.model.modelId}`} · attempt ${retry.attempt}${retry.maxAttempts === undefined ? " (ceiling unknown)" : `/${retry.maxAttempts}`} · next retry ${new Date(retry.nextRetryAt).toISOString()} · provider error: ${safeFactText(retry.error).text}${retry.errorTruncated ? " [truncated]" : ""}`);
}

const ownAwaitProperties = {
	runId: int({ minimum: 1 }),
	heldInputs: arr(int({ minimum: 1 }), { maxItems: 16 }),
	results: arr(obj({ result: ResultReferenceSchema, status: union([lit("pending"), lit("done"), lit("unanswered"), lit("unavailable")]), reason: opt(str({ maxLength: 512 })), answerEntryId: opt(int({ minimum: 1 })) }), { maxItems: 16 }),
	queuedInputCount: int({ minimum: 0 }),
	queueSnapshot: lit("committed InboxDoc"),
	omitted: obj({ heldInputs: int({ minimum: 0 }), results: int({ minimum: 0 }) }),
};
export const OwnAwaitFactSchema = obj(ownAwaitProperties);
export type OwnAwaitFact = Static<typeof OwnAwaitFactSchema>;
export const ProducerAwaitFactSchema = obj({
	sessionId: str({ minLength: 1, maxLength: 256 }),
	observedAt: int({ minimum: 0 }),
	source: lit("producer await-state"),
	awaiting: opt(OwnAwaitFactSchema),
	execution: opt(ProducerRetrySchema),
	unavailable: opt(str({ maxLength: 512 })),
});
export type ProducerAwaitFact = Static<typeof ProducerAwaitFactSchema>;
export const AwaitFactSchema = obj({
	...ownAwaitProperties,
	producers: arr(ProducerAwaitFactSchema, { maxItems: 16 }),
	omittedProducers: int({ minimum: 0 }),
	likelyCycle: arr(str({ maxLength: 256 }), { maxItems: 16 }),
	coverage: lit("one hop; remote graph incomplete"),
});
export type AwaitFact = Static<typeof AwaitFactSchema>;

/** Full retained identities and explicit coverage, not a scheduler-state label. */
export function awaitFactLines(fact: AwaitFact): string[] {
	return [
		...fact.producers.flatMap((producer) => producer.execution === undefined ? [] : retryFactLines(producer.execution).map((line) => `${line} · ${producer.source} at ${producer.observedAt}`)),
		`Awaiting · run ${fact.runId} · held requests ${fact.heldInputs.join(", ")} · ${fact.queuedInputCount} queued inputs (${fact.queueSnapshot})`,
		...(fact.likelyCycle.length ? [`Likely mutual wait: ${fact.likelyCycle.join(", ")}; use steer or Release await.`] : []),
		...fact.results.map((item) => `${item.result.sessionId} · submission ${item.result.submissionId} · ${item.status}${item.reason === undefined ? "" : ` · ${item.reason}`}`),
		...fact.producers.map((item) => `${item.sessionId} · ${item.source} at ${item.observedAt} · ${item.awaiting === undefined ? item.unavailable ?? "no own await observed" : `awaits ${item.awaiting.results.map((result) => `${result.result.sessionId}/${result.result.submissionId}`).join(", ") || "(no references shown)"}${item.awaiting.omitted.results || item.awaiting.omitted.heldInputs ? `; omitted ${item.awaiting.omitted.results} results, ${item.awaiting.omitted.heldInputs} held requests` : ""}${item.unavailable === undefined ? "" : `; ${item.unavailable}`}`}`),
		`Coverage: ${fact.coverage}; omitted ${fact.omitted.heldInputs} held requests, ${fact.omitted.results} results, ${fact.omittedProducers} producers.`];
}
