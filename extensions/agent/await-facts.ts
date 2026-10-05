/** Bounded semantic wait facts, separate from native task scheduling state. */
import { Type, type Static } from "typebox";
import { ResultReferenceSchema } from "./result-reference.ts";
import { safeFactText } from "./primary-observation.ts";

export const ProducerRetrySchema = Type.Object({
	state: Type.Literal("provider-retry"),
	runId: Type.Integer({ minimum: 1 }),
	results: Type.Array(ResultReferenceSchema, { minItems: 1, maxItems: 16 }),
	model: Type.Optional(Type.Object({ provider: Type.String({ maxLength: 256 }), modelId: Type.String({ maxLength: 256 }) }, { additionalProperties: false })),
	attempt: Type.Integer({ minimum: 1 }),
	maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
	nextRetryAt: Type.Integer({ minimum: 0, maximum: 8640000000000000 }),
	error: Type.String({ maxLength: 512 }),
	errorTruncated: Type.Boolean(),
}, { additionalProperties: false });
export type ProducerRetry = Static<typeof ProducerRetrySchema>;
export type ProducerState = { awaiting?: OwnAwaitFact; execution?: ProducerRetry };

/** Provider error text is a claim, not a scheduling guarantee or diagnosis. */
export function retryFactLines(retry: ProducerRetry): string[] {
	return retry.results.map((result) => `${result.sessionId} · submission ${result.submissionId}${result.requestId === undefined ? "" : ` · request ${safeFactText(result.requestId, 160).text}`} · pending · provider retry · ${retry.model === undefined ? "model unknown" : `${retry.model.provider}/${retry.model.modelId}`} · attempt ${retry.attempt}${retry.maxAttempts === undefined ? " (ceiling unknown)" : `/${retry.maxAttempts}`} · next retry ${new Date(retry.nextRetryAt).toISOString()} · provider error: ${safeFactText(retry.error).text}${retry.errorTruncated ? " [truncated]" : ""}`);
}

export const OwnAwaitFactSchema = Type.Object({
	runId: Type.Integer({ minimum: 1 }),
	heldInputs: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 16 }),
	results: Type.Array(Type.Object({ result: ResultReferenceSchema, status: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Literal("unanswered"), Type.Literal("unavailable")]), reason: Type.Optional(Type.String({ maxLength: 512 })), answerEntryId: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }), { maxItems: 16 }),
	queuedInputCount: Type.Integer({ minimum: 0 }),
	queueSnapshot: Type.Literal("committed InboxDoc"),
	omitted: Type.Object({ heldInputs: Type.Integer({ minimum: 0 }), results: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type OwnAwaitFact = Static<typeof OwnAwaitFactSchema>;
export const ProducerAwaitFactSchema = Type.Object({
	sessionId: Type.String({ minLength: 1, maxLength: 256 }),
	observedAt: Type.Integer({ minimum: 0 }),
	source: Type.Literal("producer await-state"),
	awaiting: Type.Optional(OwnAwaitFactSchema),
	execution: Type.Optional(ProducerRetrySchema),
	unavailable: Type.Optional(Type.String({ maxLength: 512 })),
}, { additionalProperties: false });
export type ProducerAwaitFact = Static<typeof ProducerAwaitFactSchema>;
export const AwaitFactSchema = Type.Object({
	...OwnAwaitFactSchema.properties,
	producers: Type.Array(ProducerAwaitFactSchema, { maxItems: 16 }),
	omittedProducers: Type.Integer({ minimum: 0 }),
	likelyCycle: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 16 }),
	coverage: Type.Literal("one hop; remote graph incomplete"),
}, { additionalProperties: false });
export type AwaitFact = Static<typeof AwaitFactSchema>;

/** Full retained identities and explicit coverage, not a scheduler-state label. */
export function awaitFactLines(fact: AwaitFact): string[] {
	return [
		...fact.producers.flatMap((producer) => producer.execution === undefined ? [] : retryFactLines(producer.execution).map((line) => `${line} · ${producer.source} at ${producer.observedAt}`)),
		`Awaiting · run ${fact.runId} · held requests ${fact.heldInputs.join(", ")} · ${fact.queuedInputCount} queued inputs (${fact.queueSnapshot})`,
		...(fact.likelyCycle.length ? [`Likely mutual wait: ${fact.likelyCycle.join(", ")}; use steer or Release await.`] : []),
		...fact.results.map((item) => `${item.result.sessionId} · submission ${item.result.submissionId} · ${item.status}${item.reason === undefined ? "" : ` · ${item.reason}`}`),
		...fact.producers.map((item) => `${item.sessionId} · ${item.source} at ${item.observedAt} · ${item.unavailable ?? (item.awaiting === undefined ? "no own await observed" : `awaits ${item.awaiting.results.map((result) => `${result.result.sessionId}/${result.result.submissionId}`).join(", ") || "(no references shown)"}${item.awaiting.omitted.results || item.awaiting.omitted.heldInputs ? `; omitted ${item.awaiting.omitted.results} results, ${item.awaiting.omitted.heldInputs} held requests` : ""}`)}`),
		`Coverage: ${fact.coverage}; omitted ${fact.omitted.heldInputs} held requests, ${fact.omitted.results} results, ${fact.omittedProducers} producers.`];
}
