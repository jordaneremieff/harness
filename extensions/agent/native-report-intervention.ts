/** Source validation for native report associations runs on the producer's commit line. */
import { LiveDoc, type ConversationId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import type { ResultReference } from "./result-schema.ts";
import type { ReportIntervention } from "./report-intervention.ts";
import { communicationIdentity } from "./communication.ts";
import { canonicalIdentity } from "./native-identity.ts";
import { RequestContextDoc, type RequestContext } from "./request-context.ts";
import { unsettledIntentReader } from "./delivery-store.ts";
import type { DeliveryIntent } from "./durable-controls.ts";

function interventionConversation(storageId: string, sender: string, recipient: string): ConversationId {
	if (!communicationIdentity(sender) || !communicationIdentity(recipient))
		throw new Error("Report intervention requires canonical sender and recipient identities");
	const conversationId =
		sender === storageId
			? 1
			: sender.startsWith(`${storageId}:`)
				? Number(sender.slice(storageId.length + 1))
				: Number.NaN;
	if (
		!Number.isSafeInteger(conversationId) ||
		conversationId < 1 ||
		canonicalIdentity(storageId, conversationId as ConversationId) !== sender
	)
		throw new Error("Report intervention sender is not in this storage");
	return conversationId as ConversationId;
}

async function recipientInput(
	tx: Tx,
	conversationId: ConversationId,
	sender: string,
	recipient: string,
	inputId: SubmissionId,
	routes: readonly RequestContext[],
	intentOf: (conversationId: number, requestId: string) => Promise<DeliveryIntent | undefined>,
): Promise<ResultReference | undefined> {
	const input = await tx.submission(inputId);
	if (input?.type !== "input" || input.conversationId !== conversationId || input.requestId === undefined)
		return undefined;
	const intent = await intentOf(conversationId, input.requestId);
	const route = routes.find((item) => item.requestId === input.requestId);
	const owner = intent?.ownerId ?? route?.replyTo;
	const origin = intent?.origin ?? route?.origin;
	if (owner !== recipient || origin !== "model") return undefined;
	return { sessionId: sender, submissionId: input.id, requestId: input.requestId };
}

export async function validateReportIntervention(
	tx: Tx,
	storageId: string,
	sender: string,
	recipient: string,
	intervention: ReportIntervention,
): Promise<void> {
	const conversationId = interventionConversation(storageId, sender, recipient);
	const live = await tx.doc(LiveDoc, conversationId);
	if (live.run?.taskId !== intervention.producerRunId)
		throw new Error("Report intervention does not identify the current producer run");
	const routes = await tx.doc(RequestContextDoc, conversationId);
	const associated: ResultReference[] = [];
	// The inputs of the live run have not settled, so the reader finds each retained intent and creates no row.
	const intentOf = await unsettledIntentReader(tx);
	for (const inputId of live.run.inputs) {
		const input = await recipientInput(tx, conversationId, sender, recipient, inputId, routes.requests, intentOf);
		if (input === undefined) continue;
		const supplied = intervention.producerResults.find((result) => result.submissionId === inputId);
		associated.push(input);
		if (supplied === undefined || supplied.sessionId !== sender || supplied.requestId !== input.requestId)
			throw new Error("Report intervention omits or disagrees with a recipient input");
	}
	if (associated.length === 0 || associated.length !== intervention.producerResults.length)
		throw new Error("Report intervention includes another run, recipient or input");
}
