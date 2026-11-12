import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { ResultReference } from "./result-schema.ts";
import { CONTINUITY_ENTRY, foldContinuity, pruneContinuity, validateContinuityDelivered, validateContinuityFact, validateContinuityState, validateContinuityWork, type ContinuityFact, type ContinuityState, type ContinuityWork } from "./continuity-facts.ts";
import { openWorkItems } from "./open-work.ts";

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

/**
 * Read the conversation's declared open work once for its current context head and retain what was
 * read, so every later request of that head, also after a host restart, states the same items. A
 * retained read of the head is returned unchanged. Undefined when `headId` is no longer the newest
 * head. The open-work read comes before the document write of this commit.
 */
export async function freezeContinuityWork(tx: Tx, conversationId: ConversationId, headId: number): Promise<ContinuityWork | undefined> {
	if ((await tx.latestHeadMarker(conversationId))?.id !== headId) return undefined;
	const state = await tx.doc(ContinuityDoc, conversationId);
	validateContinuityState(state);
	if (state.work?.headId === headId) return JSON.parse(JSON.stringify(state.work)) as ContinuityWork;
	const items = (await openWorkItems(tx, conversationId)).map((item) => ({
		requestId: item.requestId, replyTo: item.replyTo,
		results: item.results.map((result) => ({ sessionId: result.sessionId, submissionId: result.submissionId, ...(result.requestId === undefined ? {} : { requestId: result.requestId }) })),
	}));
	const work: ContinuityWork = { headId, items };
	validateContinuityWork(work);
	state.work = work;
	return JSON.parse(JSON.stringify(work)) as ContinuityWork;
}
