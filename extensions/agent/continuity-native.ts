import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { ResultReference } from "./result-schema.ts";
import { CONTINUITY_ENTRY, foldContinuity, pruneContinuity, validateContinuityDelivered, validateContinuityFact, validateContinuityState, type ContinuityFact, type ContinuityState } from "./continuity-facts.ts";

export const ContinuityDoc = defineDoc<ContinuityState>({
	kind: CONTINUITY_ENTRY, version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ events: [] }), checkpointWhen: () => false,
});

const key = (fact: ContinuityFact): string => JSON.stringify([fact.sessionId, fact.requestId]);

/** Call in the admission/placement transaction, not in a provider request hook. */
export async function recordContinuityFact(tx: Tx, conversationId: ConversationId, fact: ContinuityFact): Promise<void> {
	validateContinuityFact(fact);
	const headId = (await tx.latestHeadMarker(conversationId))?.id ?? 0;
	const state = await tx.doc(ContinuityDoc, conversationId);
	validateContinuityState(state);
	const retained = pruneContinuity(state.events, headId);
	const prior = retained.filter((event) => key(event) === key(fact));
	foldContinuity([...prior, fact]);
	if (!prior.some((event) => event.phase === fact.phase && event.replyTo === fact.replyTo && event.submissionId === fact.submissionId && event.timerId === fact.timerId))
		retained.push({ ...fact, afterHead: headId });
	state.events = retained;
}

/** Complete every matching tuple even when the body admission was a deduplicated replay. */
export async function recordContinuityDelivered(tx: Tx, conversationId: ConversationId, references: readonly ResultReference[]): Promise<void> {
	validateContinuityDelivered(references);
	const state = await tx.doc(ContinuityDoc, conversationId);
	validateContinuityState(state);
	const prior = new Map(foldContinuity(state.events).map((fact) => [key(fact), fact]));
	for (const reference of references) {
		const fact = prior.get(JSON.stringify([reference.sessionId, reference.requestId]));
		if (fact === undefined) continue;
		await recordContinuityFact(tx, conversationId, { phase: "delivered", sessionId: reference.sessionId, requestId: reference.requestId, replyTo: fact.replyTo, submissionId: reference.submissionId });
	}
}
