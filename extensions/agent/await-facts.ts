/** Bounded semantic wait facts, separate from native task scheduling state. */
import { Type, type Static } from "typebox";
import { ResultReferenceSchema } from "./result-reference.ts";

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
	return [`Awaiting · run ${fact.runId} · held requests ${fact.heldInputs.join(", ")} · ${fact.queuedInputCount} queued inputs (${fact.queueSnapshot})`,
		...(fact.likelyCycle.length ? [`Likely mutual wait: ${fact.likelyCycle.join(", ")}; use steer or Release await.`] : []),
		...fact.results.map((item) => `${item.result.sessionId} · submission ${item.result.submissionId} · ${item.status}${item.reason === undefined ? "" : ` · ${item.reason}`}`),
		...fact.producers.map((item) => `${item.sessionId} · ${item.source} at ${item.observedAt} · ${item.unavailable ?? (item.awaiting === undefined ? "no own await observed" : `awaits ${item.awaiting.results.map((result) => `${result.result.sessionId}/${result.result.submissionId}`).join(", ")}`)}`),
		`Coverage: ${fact.coverage}; omitted ${fact.omitted.heldInputs} held requests, ${fact.omitted.results} results, ${fact.omittedProducers} producers.`];
}
