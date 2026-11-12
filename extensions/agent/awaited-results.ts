/** Input provenance of native admissions and the provider-retry notices that a requester already received. */
import { providerRetryRevision, sameRetryResult, olderProviderRetry } from "./await-retry-policy.ts";
export { referenceKey, providerRetryRevision, sameRetryResult, olderProviderRetry } from "./await-retry-policy.ts";
import type { ReportIntervention } from "./report-intervention.ts";
import { defineDoc, LiveDoc, InboxDoc, type ConversationId, type SubmissionId, type SubmissionRecord, type Tx } from "@earendil-works/pi-durable";
import { prepareCommunication } from "./communication-retention.ts";
import type { ResultReference } from "./result-schema.ts";
import type { ProducerRetry } from "./await-facts.ts";
import type { ProviderRetryNotice } from "./provider-block.ts";
import type { JsonValue } from "@earendil-works/chord/json";

export type InputProvenance = { conversationId: number; requestId: string; classification: "explicit" | "automatic" | "report"; sender?: string; submissionId?: number; automaticKind?: "checkIn" | "timer"; producerRequestId?: string; runId?: number; intervention?: ReportIntervention; communicationIntent?: import("./communication-retention.ts").RetainedCommunicationIntent };
type RetryVisibility = { conversationId: number; input: number; result: ResultReference; runId: number; attempt: number; nextRetryAt: number; revision: string };
/** `declarations` stays in the stored shape; nothing writes or reads it. */
export type AwaitState = { declarations: JsonValue[]; provenance: InputProvenance[]; retryVisibility?: RetryVisibility[]; communicationDiagnostic?: "invalid" | "unavailable" };
export const AwaitDoc = defineDoc<AwaitState>({ kind: "agent.awaited-results", version: 1, scope: "session", checkpointWhen: () => false, initial: () => ({ declarations: [], provenance: [] }) });
/** Collection watermark; pending native inputs do not impose an admission cap. */
export const AWAIT_PROVENANCE_LIMIT = 128;

function retryVisibilityAdditions(claims: RetryVisibility[], conversationId: ConversationId, inputs: readonly number[], retry: ProducerRetry): RetryVisibility[] {
	const revision = providerRetryRevision(retry);
	const additions: RetryVisibility[] = [];
	for (const input of inputs) for (const result of retry.results) {
		const prior = [...claims, ...additions].find((item) => item.conversationId === conversationId && item.input === input && sameRetryResult(item.result, result));
		if (prior !== undefined && (prior.revision === revision || olderProviderRetry(retry, prior))) continue;
		additions.push({ conversationId, input, result: { ...result }, runId: retry.runId, attempt: retry.attempt, nextRetryAt: retry.nextRetryAt, revision });
	}
	return additions;
}
async function pruneRetryVisibility(tx: Tx, claims: RetryVisibility[]): Promise<void> {
	const retained: RetryVisibility[] = [];
	for (const claim of claims) {
		const live = await tx.doc(LiveDoc, claim.conversationId as ConversationId);
		const inbox = await tx.doc(InboxDoc, claim.conversationId as ConversationId);
		if (live.run?.inputs.includes(claim.input as SubmissionId) || inbox.items.some((item) => item.id === claim.input)) retained.push(claim);
	}
	claims.splice(0, claims.length, ...retained);
}

/** Acknowledgments outlive tool rounds but remain scoped to the requester's original submissions. */
export async function claimProviderRetryVisibility(tx: Tx, conversationId: ConversationId, inputs: readonly number[], retry: ProducerRetry): Promise<boolean> {
	const state = await tx.doc(AwaitDoc);
	const claims = state.retryVisibility ?? [];
	const additions = retryVisibilityAdditions(claims, conversationId, inputs, retry);
	if (additions.length === 0) return false;
	if (claims.length + additions.length > 1024) await pruneRetryVisibility(tx, claims);
	for (const claim of additions) {
		const index = claims.findIndex((item) => item.conversationId === claim.conversationId && item.input === claim.input && sameRetryResult(item.result, claim.result));
		if (index < 0) { if (claims.length >= 1024) throw new Error("Provider retry visibility bound is full"); claims.push(claim); }
		else claims[index] = claim;
	}
	state.retryVisibility = claims;
	return true;
}

/** One provider retry revision reaches the inputs of a requester's run once. */
export async function acknowledgeProviderRetry(tx: Tx, conversationId: ConversationId, notice: ProviderRetryNotice): Promise<{ acknowledged: boolean }> {
	const retry = notice.fact.execution;
	if (retry === undefined || notice.fact.unavailable !== undefined) return { acknowledged: true };
	const live = await tx.doc(LiveDoc, conversationId);
	const inputs = notice.requesterSubmissionId === undefined ? live.run?.inputs ?? [] : [notice.requesterSubmissionId];
	if (notice.requesterSubmissionId !== undefined && !live.run?.inputs.includes(notice.requesterSubmissionId as SubmissionId)) return { acknowledged: true };
	// Idle admission uses the source's stable native report request ID, not an invented input.
	if (inputs.length === 0) return { acknowledged: false };
	return { acknowledged: !await claimProviderRetryVisibility(tx, conversationId, inputs, retry) };
}
export async function forgetFailedAdmission(tx: Tx, conversationId: ConversationId, requestId: string): Promise<void> {
	if (await tx.submissionByRequest(conversationId, requestId) !== undefined) return;
	const state = await tx.doc(AwaitDoc);
	state.provenance = state.provenance.filter((item) => item.conversationId !== conversationId || item.requestId !== requestId);
}

async function prepareEvictedCommunication(tx: Tx, state: AwaitState, item: InputProvenance, submission: SubmissionRecord | undefined): Promise<(() => Promise<void>) | undefined> {
	const intent = item.communicationIntent;
	if (intent === undefined || intent.linkedEntryId !== undefined) return undefined;
	if (intent.storageId === undefined || submission === undefined) { state.communicationDiagnostic = "unavailable"; return undefined; }
	return prepareCommunication(tx, intent.storageId, item.conversationId as ConversationId, item.requestId, intent, submission);
}

async function pruneInputProvenance(tx: Tx, state: AwaitState): Promise<void> {
	const retained: InputProvenance[] = [];
	const materialize: (() => Promise<void>)[] = [];
	for (const item of state.provenance) {
		const submission = await tx.submissionByRequest(item.conversationId as ConversationId, item.requestId);
		const live = await tx.doc(LiveDoc, item.conversationId as ConversationId);
		// A row stays while its admission is in flight in the current run or its input waits in the inbox.
		if ((submission === undefined && item.runId !== undefined && item.runId === live.run?.taskId) || submission?.status === "queued") retained.push(item);
		else {
			const write = await prepareEvictedCommunication(tx, state, item, submission);
			if (write !== undefined) materialize.push(write);
		}
	}
	// All native table reads precede the first companion append.
	for (const write of materialize) await write();
	state.provenance.splice(0, state.provenance.length, ...retained);
}

/** Record the provenance before admission; a repeated request ID must carry the same provenance. */
export async function recordInputProvenance(tx: Tx, provenance: InputProvenance): Promise<void> {
	const state = await tx.doc(AwaitDoc);
	const prior = state.provenance.find((item) => item.conversationId === provenance.conversationId && item.requestId === provenance.requestId);
	if (prior !== undefined) {
		if (prior.classification !== provenance.classification || prior.sender !== provenance.sender || JSON.stringify(prior.intervention) !== JSON.stringify(provenance.intervention)) throw new Error("Input requestId already has different provenance");
		return;
	}
	if (state.provenance.length >= AWAIT_PROVENANCE_LIMIT) await pruneInputProvenance(tx, state);
	const live = await tx.doc(LiveDoc, provenance.conversationId as ConversationId);
	state.provenance.push({ ...provenance, ...(live.run === undefined ? {} : { runId: live.run.taskId }) });
}
