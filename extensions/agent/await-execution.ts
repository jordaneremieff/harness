/** An invocation-owned native wait keeps its original run open without provider work. */
import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { InboxDoc, type ToolExecutionApi, type TaskId, type DocumentWatch } from "@earendil-works/pi-durable";
import { AwaitDoc, boundedAwaitAnswer, declareAwait, commitAwaitOutcome, localProducer, referenceKey, type AwaitDeclaration, type AwaitOutcome, type AwaitInput, type AwaitDelivery } from "./awaited-results.ts";
import type { ResultReference } from "./result-reference.ts";
import type { ProducerAwaitFact } from "./await-facts.ts";
import { safeFactText } from "./primary-observation.ts";
import { recordProducerAwait, queuedAwaitInputCount } from "./await-observation.ts";
import type { AgentControlDispatch } from "./durable-agents.ts";

export type AwaitReply = { decision: AwaitDeclaration["decision"]; results: AwaitOutcome[]; unresolved: ResultReference[]; originalInputs: number[]; queuedInputCount: number; queueSnapshot: { source: "committed InboxDoc"; conversationId: number; runId: number }; releaseReason?: string };
function declaration(value: { declarations: AwaitDeclaration[] } | null | undefined, taskId: TaskId): AwaitDeclaration | undefined { return value?.declarations.find((item) => item.taskId === taskId); }
function observedReference(reference: ResultReference, row: Record<string, unknown>): ResultReference {
	const requestId = typeof row.requestId === "string" ? row.requestId : reference.requestId;
	return { ...reference, ...(requestId === undefined ? {} : { requestId }) };
}
function outcomeOf(reference: ResultReference, value: unknown): AwaitOutcome {
	if (value === null || typeof value !== "object") throw new Error("The result source returned no native outcome");
	const row = value as Record<string, unknown>;
	if (row.submissionId !== reference.submissionId || (reference.requestId !== undefined && row.requestId !== reference.requestId)) throw new Error("Observed result identifiers disagree with the reference");
	if (row.status !== "done" && row.status !== "unanswered") throw new Error("The result source returned no terminal native input");
	const answer = typeof row.answer === "string" ? row.answer : undefined;
	return { result: observedReference(reference, row), status: row.status, ...(answer === undefined ? {} : boundedAwaitAnswer(reference, answer, typeof row.answerEntryId === "number" ? row.answerEntryId : undefined)), ...(typeof row.answerEntryId === "number" ? { answerEntryId: row.answerEntryId } : {}), ...(typeof row.entryId === "number" ? { entryId: row.entryId } : {}), ...(typeof row.reason === "string" ? { reason: row.reason } : {}) };
}
async function observeNativeResult(dispatch: AgentControlDispatch, storageId: string, owner: string, reference: ResultReference, context: Context): Promise<{ outcome: AwaitOutcome; delivery?: AwaitDelivery }> {
	if (localProducer(storageId, reference) !== undefined) {
		const outcome = outcomeOf(reference, await dispatch("await-native", { sessionId: reference.sessionId, result: reference }, context));
		const reporter = /^agent-deliver:([1-9][0-9]*)$/u.exec(outcome.result.requestId ?? "");
		return { outcome, ...(reporter === null ? {} : { delivery: { requestId: `agent-report:${reporter[1]}`, results: [outcome.result], complete: true } }) };
	}
	const response = await dispatch("receipts", { sessionId: reference.sessionId, ownerId: owner, wait: true, result: reference }, context) as { outcome?: unknown; delivery?: AwaitDelivery };
	if (response.outcome === undefined) throw new Error("The foreign result is not routed to this recipient; exact third-party observation is required");
	return { outcome: outcomeOf(reference, response.outcome), ...(response.delivery === undefined ? {} : { delivery: response.delivery }) };
}
async function observeOutcome(api: ToolExecutionApi, storageId: string, dispatch: AgentControlDispatch, reference: ResultReference, context: Context): Promise<void> {
	let outcome: AwaitOutcome; let delivery: AwaitDelivery | undefined;
	try { ({ outcome, delivery } = await observeNativeResult(dispatch, storageId, `${storageId}${api.conversationId === 1 ? "" : `:${api.conversationId}`}`, reference, context)); }
	catch (error) {
		if (context.abortSignal?.aborted) return;
		outcome = { result: reference, status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
	await api.commit((tx) => commitAwaitOutcome(tx, api.taskId, outcome, delivery), context);
}

async function withdrawNamedCheckIns(api: ToolExecutionApi, context: Context): Promise<void> {
	const requestIds = await api.commit(async (tx) => {
		const state = await tx.doc(AwaitDoc);
		const current = declaration(state, api.taskId);
		const inbox = await tx.doc(InboxDoc, api.conversationId);
		if (current === undefined) return [];
		return state.provenance.filter((item) => item.conversationId === api.conversationId && item.classification === "automatic" && item.automaticKind === "checkIn" && inbox.items.some((queued) => queued.id === item.submissionId) && current.results.some((result) => result.sessionId === item.sender && (result.requestId === undefined || result.requestId === item.producerRequestId))).map((item) => item.requestId);
	}, context);
	const recipient = await api.conversation(api.conversationId, context);
	if (recipient === undefined) throw new Error("The awaiting conversation is missing");
	for (const requestId of requestIds) {
		const input = await recipient.submit({ type: "input", content: "", requestId, whenBusy: "followUp" }, context);
		await input.abort(context);
	}
}

async function withdrawCoveredDeliveries(api: ToolExecutionApi, current: AwaitDeclaration, context: Context): Promise<void> {
	const returned = new Set(current.outcomes.filter((outcome) => outcome.status !== "unavailable").map((outcome) => referenceKey(outcome.result)));
	const candidates = (current.deliveries ?? []).filter((delivery) => delivery.complete && delivery.results.length > 0 && delivery.results.every((result) => returned.has(referenceKey(result))));
	const queued = await api.commit(async (tx) => {
		const ids: string[] = [];
		for (const delivery of candidates) if ((await tx.submissionByRequest(api.conversationId, delivery.requestId))?.status === "queued") ids.push(delivery.requestId);
		return ids;
	}, context);
	if (queued.length === 0) return;
	const recipient = await api.conversation(api.conversationId, context);
	if (recipient === undefined) throw new Error("The awaiting conversation is missing");
	for (const requestId of queued) {
		const input = await recipient.submit({ type: "input", content: "", requestId, whenBusy: "followUp" }, context);
		await input.abort(context);
	}
}

export async function executeAwait(args: AwaitInput, api: ToolExecutionApi, context: Context, storageId: string, dispatch: AgentControlDispatch): Promise<AwaitReply> {
	await api.commit((tx) => declareAwait(tx, storageId, { conversationId: api.conversationId, taskId: api.taskId, callId: api.callId }, args.results), context);
	const owned = withCancel(context);
	let watch: DocumentWatch<import("./awaited-results.ts").AwaitState> | undefined;
	const jobs: Promise<void>[] = [];
	const producerJobs: Promise<unknown>[] = [];
	try {
	await withdrawNamedCheckIns(api, context);
	watch = await api.watchDoc(AwaitDoc, owned.context);
	if (watch === undefined) throw new Error("The native await declaration was not committed");
	let resolve!: (value: AwaitDeclaration) => void;
	let reject!: (error: Error) => void;
	const decided = new Promise<AwaitDeclaration>((yes, no) => { resolve = yes; reject = no; });
	const check = (value: { declarations: AwaitDeclaration[] } | null | undefined): void => {
		const current = declaration(value, api.taskId);
		if (current === undefined) { reject(new Error("The native await owner is no longer active")); return; }
		if (current.decision !== "awaiting") resolve(current);
	};
	watch.start(async (value) => { check(value); });
	const closed = watch.closed.then((end) => { throw new Error(`Native await observation ended: ${end.reason}`); });
	void closed.catch(() => {});
	const initial = await api.snapshot(AwaitDoc, context);
	check(initial);
	if (declaration(initial, api.taskId)?.decision === "awaiting") {
		for (const sessionId of new Set(args.results.map((reference) => reference.sessionId))) producerJobs.push(dispatch("observe-producer-await", { sessionId, results: args.results.filter((result) => result.sessionId === sessionId), publish: (fact: ProducerAwaitFact) => api.commit((tx) => recordProducerAwait(tx, api.taskId, fact), owned.context) }, owned.context).catch(async (error) => {
			if (!owned.context.abortSignal?.aborted) await api.commit((tx) => recordProducerAwait(tx, api.taskId, { sessionId, source: "producer await-state", observedAt: Date.now(), unavailable: safeFactText(error instanceof Error ? error.message : String(error)).text }), owned.context);
		}));
		jobs.push(...args.results.map((reference) => observeOutcome(api, storageId, dispatch, reference, owned.context)));
		for (const job of [...jobs, ...producerJobs]) void job.catch((error) => reject(error instanceof Error ? error : new Error(String(error))));
	}
		await Promise.race([decided, closed]);
		owned.cancel();
		await Promise.allSettled(jobs);
		const completed = declaration(await api.snapshot(AwaitDoc, context), api.taskId);
		if (completed === undefined) throw new Error("The original await round ended");
		await withdrawCoveredDeliveries(api, completed, context);
		const snapshot = await api.commit(async (tx) => {
			const current = declaration(await tx.doc(AwaitDoc), api.taskId);
			if (current === undefined) throw new Error("The original await round ended");
			const queue = await queuedAwaitInputCount(tx, api.conversationId, current.results);
			return { current: JSON.parse(JSON.stringify(current)) as AwaitDeclaration, queue };
		}, context);
		const { current, queue } = snapshot;
		return { decision: current.decision, results: current.outcomes.map((item) => ({ ...item })), unresolved: current.results.filter((reference) => !current.outcomes.some((outcome) => referenceKey(outcome.result) === referenceKey(reference))), originalInputs: [...current.inputs], queuedInputCount: queue, queueSnapshot: { source: "committed InboxDoc", conversationId: api.conversationId, runId: current.runId }, ...(current.releaseReason === undefined ? {} : { releaseReason: current.releaseReason }) };
	} finally {
		owned.cancel();
		await watch?.stop();
		await Promise.allSettled([...jobs, ...producerJobs]);
	}
}
