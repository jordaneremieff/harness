/** Pure retry identity rules shared by ordinary and native waits. */
import { createHash } from "node:crypto";
import type { ResultReference } from "./result-schema.ts";
import type { ProducerRetry } from "./await-facts.ts";
export function referenceKey(reference: ResultReference): string { return `${reference.sessionId}/${reference.submissionId}`; }
export function providerRetryRevision(retry: ProducerRetry): string {
	return createHash("sha256").update(JSON.stringify([retry.runId, retry.attempt, retry.nextRetryAt, retry.error])).digest("hex");
}
export function sameRetryResult(left: ResultReference, right: ResultReference): boolean {
	return referenceKey(left) === referenceKey(right) && (left.requestId === undefined || right.requestId === undefined || left.requestId === right.requestId);
}
export function olderProviderRetry(incoming: Pick<ProducerRetry, "runId" | "attempt" | "nextRetryAt">, prior: Pick<ProducerRetry, "runId" | "attempt" | "nextRetryAt">): boolean {
	return incoming.runId < prior.runId || (incoming.runId === prior.runId && (incoming.attempt < prior.attempt || (incoming.attempt === prior.attempt && incoming.nextRetryAt < prior.nextRetryAt)));
}
